// Сервер сетевой игры Cars & Guts: раздаёт собранную игру (dist/), держит лобби и комнаты
// и пересылает сообщения между игроками одной комнаты. Сам игру не считает: мир и соперников-ботов
// считает хост (создатель комнаты), каждый игрок — свою машину; сервер только решает спорное — кто первый.
//
//   node server/server.js [порт]     (по умолчанию 8080, или переменная PORT)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const MAX_PLAYERS = 4; // людей в комнате; соперники-боты (0–7, по настройке) добавляются к ним — всего машин не больше 8
const AWAY_MS = 90000; // столько ждём выпавшего из комнаты игрока, прежде чем выкинуть
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const DIST_BUILD = (() => {
  try {
    return JSON.parse(readFileSync(join(DIST, 'build.json'), 'utf8'));
  } catch {
    return null;
  }
})();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ------------------------------------------------------------------ раздача игры
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
    res.end(JSON.stringify({ name: 'cars-and-guts', server: PKG.version, game: DIST_BUILD, rooms: rooms.size, players: clients.size }));
    return;
  }
  if (!existsSync(DIST)) {
    res.writeHead(503, { 'content-type': TYPES['.html'] });
    res.end('<h1>Игра не собрана</h1><p>Сначала выполните <code>npm run build</code>.</p>');
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!path) path = 'index.html';
  const file = join(DIST, path);
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

// ------------------------------------------------------------------ лобби и комнаты
// id → { id, ws, token, name, version, room, team, car, seat, away, awayTimer }; у выпавшего ws = null, away = true
const clients = new Map();
// id → { id, name, version, hostId, players: Set<id>, settings, state, result, finished, slots, rows, stats, broken }
// rows — последний снимок каждой машины, stats — очки игроков, broken — номера сломанной уличной мелочи:
// чтобы вернувшийся продолжил с того же места
const rooms = new Map();
const MODES = ['classic', 'crew'];
const GAMES = ['race', 'royale'];

/** Настройки комнаты от клиента — в допустимые рамки. */
function cleanSettings(s = {}, old = { game: 'race', bots: 4, mode: 'classic', teams: false }) {
  return {
    game: GAMES.includes(s.game) ? s.game : old.game || 'race',
    bots: Number.isInteger(s.bots) ? Math.max(0, Math.min(7, s.bots)) : old.bots,
    mode: MODES.includes(s.mode) ? s.mode : old.mode,
    teams: typeof s.teams === 'boolean' ? s.teams : old.teams,
  };
}

/**
 * Привести места игроков в порядок: в классике каждый за рулём своей машины; в «экипаже» можно сесть в пушку
 * своей машины (за рулём бот) или подсесть на свободное место к другому. Подсевший — в команде хозяина машины.
 */
function fixSeats(room) {
  const ps = [...room.players].map((id) => clients.get(id));
  const crew = room.settings.mode === 'crew';
  for (const p of ps) {
    if (!crew || !p.car) {
      p.car = p.id;
      if (!crew) p.seat = 'driver';
    }
    if (p.seat !== 'gunner') p.seat = 'driver';
    if (!room.settings.teams) p.team = 0;
    else if (p.team !== 1 && p.team !== 2) p.team = 1;
  }
  for (const p of ps) {
    if (p.car === p.id) continue;
    const o = clients.get(p.car);
    const taken = (seat) => ps.some((q) => q !== p && q.car === p.car && q.seat === seat);
    if (!o || !room.players.has(o.id) || o.car !== o.id || taken(p.seat)) {
      p.car = p.id;
      p.seat = 'driver';
    } else if (room.settings.teams) p.team = o.team;
  }
}
let nextId = 1;

const send = (c, msg) => {
  if (c.ws && c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
};
const toRoom = (room, msg, except = null) => {
  for (const id of room.players) if (id !== except) send(clients.get(id), msg);
};

function roomInfo(room) {
  return {
    id: room.id,
    name: room.name,
    version: room.version,
    host: room.hostId,
    state: room.state,
    max: MAX_PLAYERS,
    settings: room.settings,
    players: [...room.players].map((id) => {
      const c = clients.get(id);
      return { id, name: c.name, team: c.team, car: c.car, seat: c.seat, away: !!c.away };
    }),
  };
}

function roomList() {
  return [...rooms.values()].map((r) => {
    const i = roomInfo(r);
    return { id: i.id, name: i.name, version: i.version, state: i.state, max: i.max, count: i.players.length, host: clients.get(r.hostId)?.name, settings: r.settings };
  });
}

/** Список комнат — всем, кто сейчас в лобби (не в комнате). */
function pushRooms() {
  const list = roomList();
  for (const c of clients.values()) if (!c.room && c.version) send(c, { t: 'rooms', list });
}

/** Связь с игроком в комнате оборвалась: держим место AWAY_MS, вдруг вернётся. */
function goAway(c) {
  const room = c.room && rooms.get(c.room);
  c.ws = null;
  if (!room) {
    clients.delete(c.id);
    return;
  }
  c.away = true;
  toRoom(room, { t: 'away', id: c.id, name: c.name });
  toRoom(room, { t: 'room', room: roomInfo(room) });
  log(`${c.name} выпал из «${room.name}» — ждём ${AWAY_MS / 1000} с`);
  c.awayTimer = setTimeout(() => {
    leave(c, 'lost');
    clients.delete(c.id);
    log(`${c.name} так и не вернулся`);
  }, AWAY_MS);
}

/** Выпавший вернулся по своему токену: та же запись, тот же id, то же место. */
function comeBack(old, ws) {
  clearTimeout(old.awayTimer);
  old.ws = ws;
  old.away = false;
  old.alive = true;
  const room = old.room && rooms.get(old.room);
  if (room) {
    toRoom(room, { t: 'back', id: old.id, name: old.name }, old.id);
    toRoom(room, { t: 'room', room: roomInfo(room) }, old.id);
  }
  log(`${old.name} вернулся${room ? ` в «${room.name}»` : ''}`);
  return room;
}

function leave(c, why = 'left') {
  const room = c.room && rooms.get(c.room);
  c.room = null;
  if (!room) return;
  room.players.delete(c.id);
  if (room.hostId === c.id || ![...room.players].some((id) => !clients.get(id).away)) {
    // хост ушёл — мир (соперники, результаты) считал он, комнату закрываем
    for (const id of room.players) {
      const o = clients.get(id);
      o.room = null;
      send(o, { t: 'closed', why: why === 'left' ? 'Хост вышел из комнаты' : 'Хост отключился и не вернулся' });
      if (o.away) {
        clearTimeout(o.awayTimer);
        clients.delete(o.id);
      }
    }
    rooms.delete(room.id);
    log(`комната «${room.name}» закрыта`);
  } else {
    fixSeats(room);
    toRoom(room, { t: 'left', id: c.id, name: c.name });
    toRoom(room, { t: 'room', room: roomInfo(room) });
  }
  pushRooms();
}

function onMessage(c, msg) {
  const room = c.room && rooms.get(c.room);
  switch (msg.t) {
    case 's': // снимок машин — самое частое, сразу пересылаем (и запоминаем — для вернувшихся)
      if (!room || room.state !== 'race') return;
      for (const row of msg.c || []) room.rows.set(row[0], row);
      if (msg.p) room.stats.set(c.id, msg.p);
      toRoom(room, { ...msg, from: c.id }, c.id);
      return;
    case 'ped': // снимок толпы пешеходов — её считает хост
      if (room && room.state === 'race' && room.hostId === c.id) toRoom(room, { ...msg, from: c.id }, c.id);
      return;
    case 'e': // событие (выстрел, удар, взрыв машины, сломанная уличная мелочь, удар по пешеходу)
      if (!room || room.state !== 'race') return;
      // номера сломанной мелочи запоминаем — вернувшемуся посреди заезда
      if (msg.k === 'prop' && Array.isArray(msg.l)) for (const row of msg.l) if (Number.isInteger(row?.[0]) && row[0] >= 0 && row[0] < 100000) room.broken.add(row[0]);
      toRoom(room, { ...msg, from: c.id }, c.id);
      return;
    case 'hello': {
      c.name = String(msg.name || 'Игрок').slice(0, 16);
      c.version = String(msg.version || '?').slice(0, 40);
      send(c, { t: 'welcome', id: c.id, token: c.token, server: PKG.version, game: DIST_BUILD });
      send(c, { t: 'rooms', list: roomList() });
      log(`${c.name} подключился (версия ${c.version})`);
      return;
    }
    case 'rooms':
      send(c, { t: 'rooms', list: roomList() });
      return;
    case 'create': {
      if (!c.version) return;
      leave(c);
      const r = { id: String(nextId++), name: String(msg.name || `Комната ${c.name}`).slice(0, 24), version: c.version, hostId: c.id, players: new Set([c.id]), settings: cleanSettings(msg.settings), state: 'lobby', result: null, finished: [] };
      rooms.set(r.id, r);
      c.room = r.id;
      c.car = c.id;
      c.seat = msg.seat === 'gunner' ? 'gunner' : 'driver';
      c.team = 1;
      fixSeats(r);
      send(c, { t: 'room', room: roomInfo(r) });
      pushRooms();
      log(`${c.name} создал комнату «${r.name}»`);
      return;
    }
    case 'join': {
      const r = rooms.get(String(msg.room));
      if (!r) return send(c, { t: 'error', msg: 'Комната уже закрыта' });
      if (r.version !== c.version) {
        return send(c, { t: 'error', code: 'version', msg: `Разные версии игры: в комнате ${r.version}, у тебя ${c.version}. Обновитесь до одной версии.` });
      }
      if (r.state !== 'lobby') return send(c, { t: 'error', msg: 'Заезд уже идёт — дождись конца' });
      if (r.players.size >= MAX_PLAYERS) return send(c, { t: 'error', msg: 'Комната заполнена' });
      leave(c);
      r.players.add(c.id);
      c.room = r.id;
      c.car = c.id;
      c.seat = 'driver';
      // в командах — в ту, где меньше людей
      const count = (t) => [...r.players].filter((id) => clients.get(id).team === t).length;
      c.team = count(2) < count(1) ? 2 : 1;
      fixSeats(r);
      toRoom(r, { t: 'room', room: roomInfo(r) });
      pushRooms();
      log(`${c.name} вошёл в «${r.name}»`);
      return;
    }
    case 'settings': // хост меняет настройки комнаты (до старта)
      if (!room || room.hostId !== c.id || room.state !== 'lobby') return;
      room.settings = cleanSettings(msg.settings, room.settings);
      fixSeats(room);
      toRoom(room, { t: 'room', room: roomInfo(room) });
      pushRooms();
      return;
    case 'me': // игрок выбирает команду и место
      if (!room || room.state !== 'lobby') return;
      if (msg.team === 1 || msg.team === 2) c.team = msg.team;
      if (typeof msg.car === 'string') c.car = msg.car;
      if (msg.seat === 'driver' || msg.seat === 'gunner') c.seat = msg.seat;
      // если на мою машину кто-то подсел, а я ушёл к другому — подсевшего вернёт fixSeats
      fixSeats(room);
      toRoom(room, { t: 'room', room: roomInfo(room) });
      return;
    case 'leave':
      leave(c);
      send(c, { t: 'rooms', list: roomList() });
      return;
    case 'start': {
      // хост раздал места на старте; сервер только пересылает всем и запоминает, что заезд пошёл
      if (!room || room.hostId !== c.id) return;
      room.state = 'race';
      room.result = null;
      room.finished = [];
      room.slots = msg.slots;
      room.zone = msg.zone || null;
      room.startedAt = Date.now();
      room.rows = new Map();
      room.stats = new Map();
      room.broken = new Set();
      toRoom(room, { t: 'start', slots: msg.slots, zone: room.zone, room: roomInfo(room) });
      pushRooms();
      log(`«${room.name}»: старт (${room.players.size} чел.)`);
      return;
    }
    case 'lobby': // хост вернул комнату в лобби — можно снова заходить
      if (!room || room.hostId !== c.id) return;
      room.state = 'lobby';
      toRoom(room, { t: 'room', room: roomInfo(room) });
      pushRooms();
      return;
    case 'claim': {
      // заявка на финиш/победу: кто первый прислал — тот и первый
      if (!room || room.state !== 'race') return;
      if (msg.kind === 'finish') {
        if (room.finished.includes(msg.car)) return;
        room.finished.push(msg.car);
        toRoom(room, { t: 'place', car: msg.car, place: room.finished.length });
      }
      if (!room.result) {
        room.result = { kind: msg.kind, car: msg.car, name: msg.name, owner: c.id };
        toRoom(room, { t: 'result', ...room.result });
        log(`«${room.name}»: победа ${msg.name} (${msg.kind})`);
      }
      return;
    }
  }
}

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  let c = { id: String(nextId++), token: randomUUID(), ws, name: 'Игрок', version: null, room: null, alive: true };
  clients.set(c.id, c);
  ws.on('pong', () => (c.alive = true));
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    // вернулся выпавший: продолжаем его старую запись (тот же id и место в комнате)
    if (msg.t === 'hello' && msg.token) {
      const old = [...clients.values()].find((o) => o.away && o.token === msg.token && o.version === String(msg.version));
      if (old) {
        clients.delete(c.id);
        c = old;
        const room = comeBack(old, ws);
        const rejoin = room && {
          room: roomInfo(room),
          slots: room.slots,
          zone: room.zone,
          elapsed: room.startedAt ? (Date.now() - room.startedAt) / 1000 - 3 : 0, // минус отсчёт перед стартом
          rows: room.state === 'race' ? [...room.rows.values()] : [],
          stats: room.stats?.get(old.id) || null,
          props: room.state === 'race' && room.broken ? [...room.broken] : [],
          result: room.result,
        };
        send(c, { t: 'welcome', id: c.id, token: c.token, server: PKG.version, game: DIST_BUILD, rejoin });
        return;
      }
    }
    onMessage(c, msg);
  });
  ws.on('close', () => {
    if (c.ws !== ws) return; // эту запись уже подхватило новое соединение
    if (c.room) {
      goAway(c);
      return;
    }
    clients.delete(c.id);
    if (c.version) log(`${c.name} отключился`);
  });
});

// пинг — чтобы туннели и роутеры не рвали тихое соединение и чтобы замечать пропавших
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.ws) continue;
    if (!c.alive) {
      c.ws.terminate();
      continue;
    }
    c.alive = false;
    c.ws.ping();
  }
}, 15000);

function log(s) {
  console.log(`[${new Date().toLocaleTimeString('ru-RU')}] ${s}`);
}

server.listen(PORT, () => {
  console.log(`Cars & Guts: сервер на порту ${PORT}${DIST_BUILD ? `, игра версии ${DIST_BUILD.version}` : ' (игра не собрана — npm run build)'}`);
  console.log(`  у тебя:            http://localhost:${PORT}`);
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  в сети / VPN:      http://${a.address}:${PORT}`);
  }
  console.log('  через интернет:    cloudflared tunnel --url http://localhost:' + PORT + '  (выдаст адрес https://….trycloudflare.com)');
});
