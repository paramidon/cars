import { version } from '../../package.json';

/** Версия сборки: номер из package.json + отпечаток исходников (scripts/build-id.mjs). */
// eslint-disable-next-line no-undef
export const BUILD_VERSION = `${version}+${typeof __BUILD__ === 'string' ? __BUILD__ : 'dev'}`;
/** Версия игры для сетевой комнаты. */
export const GAME_VERSION = BUILD_VERSION;
const PING_MS = 2000; // how often to measure the round trip to the server
const PINGS = 5; // … over how many of the last ones

/**
 * Соединение с сервером игры (server/server.js) по WebSocket.
 * Сообщения — JSON с полем t; on(t, fn) подписывает на тип, '*' — на все.
 */
export class NetClient {
  constructor() {
    this.ws = null;
    this.id = null;
    this.handlers = new Map();
    this.onClose = null;
    // round trip to the server, s: the smallest of the last few pings (a snapshot of another player's car is that much
    // older than it looks — see Netplay._snapshot)
    this.rtt = 0;
    this.pings = [];
    this.pingTimer = null;
    this.on('pong', (m) => {
      this.pings.push((performance.now() - m.at) / 1000);
      if (this.pings.length > PINGS) this.pings.shift();
      this.rtt = Math.min(...this.pings);
    });
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && this.id != null;
  }

  /**
   * Подключиться и представиться; промис — с ответом welcome.
   * token — выданный сервером раньше: если связь оборвалась посреди игры, сервер вернёт на прежнее место (welcome.rejoin).
   */
  connect(url, name, token = null) {
    this.close();
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(new Error(`Неверный адрес: ${url}`));
        return;
      }
      this.ws = ws;
      let opened = false;
      const timer = setTimeout(() => {
        if (!opened) {
          ws.close();
          reject(new Error('Сервер не отвечает'));
        }
      }, 6000);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name, version: GAME_VERSION, token }));
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.t === 'welcome' && !opened) {
          opened = true;
          clearTimeout(timer);
          this.id = msg.id;
          this.token = msg.token;
          this.pings = [];
          clearInterval(this.pingTimer);
          const ping = () => this.send({ t: 'ping', at: performance.now() });
          this.pingTimer = setInterval(ping, PING_MS);
          ping();
          resolve(msg);
        }
        this._dispatch(msg);
      };
      ws.onclose = () => {
        clearTimeout(timer);
        const was = this.ws === ws;
        if (was) {
          this.ws = null;
          this.id = null;
          clearInterval(this.pingTimer);
        }
        if (!opened) reject(new Error('Не удалось подключиться'));
        else if (was && this.onClose) this.onClose();
      };
    });
  }

  close() {
    clearInterval(this.pingTimer);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      this.id = null;
      ws.close();
    }
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  on(t, fn) {
    if (!this.handlers.has(t)) this.handlers.set(t, new Set());
    this.handlers.get(t).add(fn);
    return () => this.handlers.get(t).delete(fn);
  }

  _dispatch(msg) {
    for (const fn of this.handlers.get(msg.t) || []) fn(msg);
    for (const fn of this.handlers.get('*') || []) fn(msg);
  }
}

/** Адрес сервера по умолчанию: если игру отдал наш сервер — он же, иначе — локальный. */
export async function defaultServer() {
  try {
    const r = await fetch('./api/info', { cache: 'no-store' });
    if (r.ok && (await r.json()).name === 'cars-and-guts') {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return { url: `${proto}//${location.host}/ws`, sameOrigin: true };
    }
  } catch {
    // игру открыли не с нашего сервера (dev-сервер vite, файл) — адрес вводится руками
  }
  return { url: null, sameOrigin: false };
}

/** Привести то, что ввёл человек (localhost:8080, https://….trycloudflare.com), к адресу WebSocket. */
export function wsUrl(input) {
  let s = input.trim();
  if (!s) return null;
  if (/^https?:\/\//.test(s)) s = s.replace(/^http/, 'ws');
  else if (!/^wss?:\/\//.test(s)) s = (/trycloudflare|ngrok/.test(s) ? 'wss://' : 'ws://') + s;
  const u = new URL(s);
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
  return u.toString();
}
