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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const MAX_PLAYERS = 4; // людей в комнате; соперники-боты добавляются к ним
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
const clients = new Map(); // id → { id, ws, name, version, room }
const rooms = new Map(); // id → { id, name, version, hostId, players: Set<id>, state, result, finished }
let nextId = 1;

const send = (c, msg) => {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
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
    players: [...room.players].map((id) => ({ id, name: clients.get(id).name })),
  };
}

function roomList() {
  return [...rooms.values()].map((r) => {
    const i = roomInfo(r);
    return { id: i.id, name: i.name, version: i.version, state: i.state, max: i.max, count: i.players.length, host: clients.get(r.hostId)?.name };
  });
}

/** Список комнат — всем, кто сейчас в лобби (не в комнате). */
function pushRooms() {
  const list = roomList();
  for (const c of clients.values()) if (!c.room && c.version) send(c, { t: 'rooms', list });
}

function leave(c, why = 'left') {
  const room = c.room && rooms.get(c.room);
  c.room = null;
  if (!room) return;
  room.players.delete(c.id);
  if (room.hostId === c.id || room.players.size === 0) {
    // хост ушёл — мир (соперники, результаты) считал он, комнату закрываем
    for (const id of room.players) {
      const o = clients.get(id);
      o.room = null;
      send(o, { t: 'closed', why: why === 'left' ? 'Хост вышел из комнаты' : 'Хост отключился' });
    }
    rooms.delete(room.id);
    log(`комната «${room.name}» закрыта`);
  } else {
    toRoom(room, { t: 'left', id: c.id, name: c.name });
    toRoom(room, { t: 'room', room: roomInfo(room) });
  }
  pushRooms();
}

function onMessage(c, msg) {
  const room = c.room && rooms.get(c.room);
  switch (msg.t) {
    case 's': // снимок машин — самое частое, сразу пересылаем
    case 'e': // событие (выстрел, удар, взрыв машины)
      if (room && room.state === 'race') toRoom(room, { ...msg, from: c.id }, c.id);
      return;
    case 'hello': {
      c.name = String(msg.name || 'Игрок').slice(0, 16);
      c.version = String(msg.version || '?').slice(0, 40);
      send(c, { t: 'welcome', id: c.id, server: PKG.version, game: DIST_BUILD });
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
      const r = { id: String(nextId++), name: String(msg.name || `Комната ${c.name}`).slice(0, 24), version: c.version, hostId: c.id, players: new Set([c.id]), state: 'lobby', result: null, finished: [] };
      rooms.set(r.id, r);
      c.room = r.id;
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
      toRoom(r, { t: 'room', room: roomInfo(r) });
      pushRooms();
      log(`${c.name} вошёл в «${r.name}»`);
      return;
    }
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
      toRoom(room, { t: 'start', slots: msg.slots, room: roomInfo(room) });
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
  const c = { id: String(nextId++), ws, name: 'Игрок', version: null, room: null, alive: true };
  clients.set(c.id, c);
  ws.on('pong', () => (c.alive = true));
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    onMessage(c, msg);
  });
  ws.on('close', () => {
    leave(c, 'lost');
    clients.delete(c.id);
    if (c.version) log(`${c.name} отключился`);
  });
});

// пинг — чтобы туннели и роутеры не рвали тихое соединение и чтобы замечать пропавших
setInterval(() => {
  for (const c of clients.values()) {
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
