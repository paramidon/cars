import { NetClient, GAME_VERSION, defaultServer, wsUrl } from './client.js';
import { makeSlots } from './netplay.js';

const $ = (id) => document.getElementById(id);
const KEY = 'cars-and-guts:net';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Экран «По сети»: подключение к серверу, список комнат, комната до старта. */
export class Lobby {
  constructor(game) {
    this.game = game;
    this.client = new NetClient();
    this.room = null;
    this.rooms = [];
    this.visible = false;
    this.sameOrigin = false;

    const saved = this._load();
    $('net-name').value = saved.name || '';
    $('net-server').value = saved.server || 'localhost:8080';
    $('lobby-version').textContent = `Версия игры: ${GAME_VERSION}`;
    defaultServer().then(({ url, sameOrigin }) => {
      this.sameOrigin = sameOrigin;
      if (sameOrigin) this.sameUrl = url;
      $('net-server-row').classList.toggle('hidden', sameOrigin);
    });

    const click = (id, fn) => $(id).addEventListener('click', (e) => {
      e.preventDefault();
      fn();
    });
    click('btn-net-connect', () => this.connect());
    click('btn-room-create', () => this.client.send({ t: 'create', name: `Комната ${$('net-name').value.trim() || 'Игрока'}` }));
    click('btn-room-start', () => this._start());
    click('btn-room-leave', () => this.leaveRoom());
    click('btn-lobby-back', () => this.close());
    for (const id of ['net-name', 'net-server']) {
      $(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.connect();
      });
    }

    const c = this.client;
    c.on('rooms', (m) => {
      this.rooms = m.list;
      if (!this.room) this._render();
    });
    c.on('room', (m) => {
      this.room = m.room;
      // хост вернул комнату в лобби посреди заезда
      if (this.game.net && m.room.state === 'lobby') {
        this.game.endNet();
        this.open();
      }
      this._render();
    });
    c.on('start', (m) => {
      this.room = m.room;
      this._hide();
      this.game.startNet(c, m.room, m.slots);
    });
    c.on('closed', (m) => {
      this.room = null;
      this._toLobby(m.why);
    });
    c.on('error', (m) => this._status(m.msg, true));
    c.onClose = () => {
      this.room = null;
      this._toLobby('Связь с сервером потеряна');
    };
  }

  _load() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch {
      return {};
    }
  }

  _save(name, server) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ name, server }));
    } catch {
      // не страшно
    }
  }

  open() {
    this.visible = true;
    $('menu').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    this._render();
  }

  _hide() {
    this.visible = false;
    $('lobby').classList.add('hidden');
  }

  /** Назад в главное меню: выйти из комнаты и отключиться. */
  close() {
    if (this.room) this.client.send({ t: 'leave' });
    this.room = null;
    this.client.close();
    if (this.game.net) this.game.endNet();
    this._hide();
    $('menu').classList.remove('hidden');
    this._status('');
  }

  /** Из сетевого заезда — обратно в лобби (с сообщением, почему). */
  _toLobby(why) {
    if (this.game.net) this.game.endNet();
    this.open();
    if (why) this._status(why, true);
  }

  /** Выйти из комнаты (из меню паузы, экрана итогов или лобби). */
  leaveRoom() {
    this.client.send({ t: 'leave' });
    this.room = null;
    this._toLobby('');
  }

  async connect() {
    const name = $('net-name').value.trim() || 'Игрок';
    $('net-name').value = name;
    let url;
    try {
      url = this.sameOrigin ? this.sameUrl : wsUrl($('net-server').value);
    } catch {
      url = null;
    }
    if (!url) {
      this._status('Укажи адрес сервера, например localhost:8080', true);
      return;
    }
    this._save(name, $('net-server').value.trim());
    this._status('Подключаюсь…');
    $('btn-net-connect').disabled = true;
    try {
      const w = await this.client.connect(url, name);
      const gameVer = w.game?.version;
      this._status(gameVer && gameVer !== GAME_VERSION ? `Подключено. Внимание: сервер раздаёт игру версии ${gameVer}, у тебя ${GAME_VERSION}` : 'Подключено', !!(gameVer && gameVer !== GAME_VERSION));
    } catch (e) {
      this._status(`${e.message}. Сервер запущен? (npm run serve)`, true);
    }
    $('btn-net-connect').disabled = false;
    this._render();
  }

  _start() {
    const r = this.room;
    if (!r || r.host !== this.client.id) return;
    const ids = [...r.players.map((p) => p.id), ...this.game.rivals.map((_, i) => `r${i}`)];
    this.client.send({ t: 'start', slots: makeSlots(ids) });
  }

  _status(text, bad = false) {
    const el = $('lobby-status');
    el.textContent = text;
    el.classList.toggle('bad', bad);
  }

  _render() {
    if (!this.visible) return;
    const connected = this.client.connected;
    $('lobby-connect').classList.toggle('hidden', connected);
    $('lobby-rooms').classList.toggle('hidden', !connected || !!this.room);
    $('lobby-room').classList.toggle('hidden', !connected || !this.room);
    if (!connected) return;

    if (this.room) {
      const r = this.room, me = this.client.id, host = r.host === me;
      $('room-name').textContent = r.name;
      $('room-players').innerHTML = r.players
        .map((p) => `<div><b>${esc(p.name)}</b><span>${p.id === r.host ? 'хост' : ''}${p.id === me ? (p.id === r.host ? ', ты' : 'ты') : ''}</span></div>`)
        .join('') + `<p class="fine">${r.players.length} из ${r.max} · плюс 4 соперника-бота · версия ${esc(r.version)}</p>`;
      $('btn-room-start').classList.toggle('hidden', !host);
      $('room-wait').classList.toggle('hidden', host);
      return;
    }

    const list = $('room-list');
    if (!this.rooms.length) {
      list.innerHTML = '<p class="fine">Комнат пока нет — создай свою, друг зайдёт в неё.</p>';
      return;
    }
    list.innerHTML = this.rooms
      .map((r) => {
        const other = r.version !== GAME_VERSION;
        const why = other ? `другая версия: ${esc(r.version)}` : r.state !== 'lobby' ? 'идёт заезд' : r.count >= r.max ? 'полная' : '';
        return `<button class="room-item" data-room="${esc(r.id)}" ${why ? 'disabled' : ''}>
          <span>${esc(r.name)}<small>хост ${esc(r.host || '?')}</small></span><b>${r.count}/${r.max}</b>${why ? `<em>${why}</em>` : ''}</button>`;
      })
      .join('');
    for (const b of list.querySelectorAll('button[data-room]')) {
      b.addEventListener('click', () => this.client.send({ t: 'join', room: b.dataset.room }));
    }
  }
}
