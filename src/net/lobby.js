import { NetClient, GAME_VERSION, defaultServer, wsUrl } from './client.js';
import { makeSlots, crewsOf, TEAMS } from './netplay.js';

const $ = (id) => document.getElementById(id);
const KEY = 'cars-and-guts:net';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const MODE_NAME = { classic: 'классика', crew: 'экипажи' };
const parse = (key, v) => (key === 'bots' || key === 'team' ? Number(v) : key === 'teams' ? v === 'true' : v);

/** Подсветить в переключателях .seg выбранные значения; enabled = false — только показать. */
function showSegs(root, values, enabled = true) {
  for (const seg of root.querySelectorAll('.seg')) {
    for (const b of seg.querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.v === String(values[seg.dataset.key]));
      b.disabled = !enabled;
    }
  }
}

/** Клики по переключателям внутри root → onPick(ключ, значение). */
function bindSegs(root, onPick) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('.seg button[data-v]');
    if (!b || b.disabled) return;
    e.preventDefault();
    const key = b.closest('.seg').dataset.key;
    onPick(key, parse(key, b.dataset.v));
  });
}

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
    this.createSettings = { mode: 'classic', bots: 2, teams: false, ...saved.settings };
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
    click('btn-room-create', () => this.client.send({ t: 'create', name: `Комната ${$('net-name').value.trim() || 'Игрока'}`, settings: this.createSettings }));
    bindSegs($('create-setup'), (key, v) => {
      this.createSettings[key] = v;
      this._save($('net-name').value.trim(), $('net-server').value.trim());
      this._render();
    });
    bindSegs($('room-setup'), (key, v) => {
      if (this.room && this.room.host === this.client.id) this.client.send({ t: 'settings', settings: { ...this.room.settings, [key]: v } });
    });
    bindSegs($('room-team'), (key, v) => this.client.send({ t: 'me', team: v }));
    $('room-seat').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-car]');
      if (!b || b.disabled) return;
      e.preventDefault();
      this.client.send({ t: 'me', car: b.dataset.car, seat: b.dataset.seat });
    });
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
      localStorage.setItem(KEY, JSON.stringify({ name, server, settings: this.createSettings }));
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
    const bots = Array.from({ length: r.settings.bots }, (_, i) => `r${i}`);
    const ids = [...crewsOf(r).map((c) => c.id), ...bots];
    this.client.send({ t: 'start', slots: makeSlots(ids) });
  }

  /** Комната до старта: настройки (меняет хост), игроки, моя команда и место. */
  _renderRoom() {
    const r = this.room, me = this.client.id, host = r.host === me;
    const st = r.settings;
    const byId = new Map(r.players.map((p) => [p.id, p]));
    $('room-name').textContent = r.name;
    showSegs($('room-setup'), st, host);
    const seatText = (p) => {
      if (st.mode !== 'crew') return 'за рулём';
      if (p.car === p.id) return p.seat === 'gunner' ? 'в пушке (рулит бот)' : 'за рулём';
      return `${p.seat === 'gunner' ? 'в пушке' : 'за рулём'} у ${esc(byId.get(p.car)?.name || '?')}`;
    };
    $('room-players').innerHTML = r.players
      .map((p) => {
        const team = st.teams ? `<i class="team-dot" style="background:${TEAMS[p.team]?.color}"></i>` : '';
        const who = [p.id === r.host ? 'хост' : '', p.id === me ? 'ты' : ''].filter(Boolean).join(', ');
        return `<div>${team}<b>${esc(p.name)}</b><span>${seatText(p)}${who ? ` · ${who}` : ''}</span></div>`;
      })
      .join('') + `<p class="fine">${r.players.length} из ${r.max} · ботов ${st.bots} · версия ${esc(r.version)}</p>`;

    // моя команда (подсевший к другому — в команде хозяина машины)
    const mine = byId.get(me);
    $('room-team').classList.toggle('hidden', !st.teams);
    showSegs($('room-team'), { team: mine?.team }, mine?.car === me);
    // моё место (только в «экипаже»)
    $('room-seat-row').classList.toggle('hidden', st.mode !== 'crew');
    if (st.mode === 'crew' && mine) {
      const opts = [
        { car: me, seat: 'driver', text: 'ЗА РУЛЁМ СВОЕЙ' },
        { car: me, seat: 'gunner', text: 'В ПУШКЕ СВОЕЙ' },
      ];
      for (const o of r.players) {
        if (o.id === me || o.car !== o.id) continue;
        const seat = o.seat === 'driver' ? 'gunner' : 'driver';
        const taken = r.players.some((q) => q.id !== me && q.id !== o.id && q.car === o.id && q.seat === seat);
        if (!taken) opts.push({ car: o.id, seat, text: `${seat === 'gunner' ? 'В ПУШКЕ' : 'ЗА РУЛЁМ'} У ${o.name}` });
      }
      $('room-seat').innerHTML = opts
        .map((o) => `<button data-car="${esc(o.car)}" data-seat="${o.seat}" class="${mine.car === o.car && mine.seat === o.seat ? 'on' : ''}">${esc(o.text)}</button>`)
        .join('');
    }
    $('btn-room-start').classList.toggle('hidden', !host);
    $('room-wait').classList.toggle('hidden', host);
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
      this._renderRoom();
      return;
    }
    showSegs($('create-setup'), this.createSettings);

    const list = $('room-list');
    if (!this.rooms.length) {
      list.innerHTML = '<p class="fine">Комнат пока нет — создай свою, друг зайдёт в неё.</p>';
      return;
    }
    list.innerHTML = this.rooms
      .map((r) => {
        const other = r.version !== GAME_VERSION;
        const why = other ? `другая версия: ${esc(r.version)}` : r.state !== 'lobby' ? 'идёт заезд' : r.count >= r.max ? 'полная' : '';
        const st = r.settings || {};
        const about = `${MODE_NAME[st.mode] || ''} · ботов ${st.bots ?? '?'}${st.teams ? ' · команды' : ''}`;
        return `<button class="room-item" data-room="${esc(r.id)}" ${why ? 'disabled' : ''}>
          <span>${esc(r.name)}<small>хост ${esc(r.host || '?')} · ${about}</small></span><b>${r.count}/${r.max}</b>${why ? `<em>${why}</em>` : ''}</button>`;
      })
      .join('');
    for (const b of list.querySelectorAll('button[data-room]')) {
      b.addEventListener('click', () => this.client.send({ t: 'join', room: b.dataset.room }));
    }
  }
}
