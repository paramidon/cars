import { Car } from '../car.js';
import { CarTag } from '../tag.js';
import { GRID } from '../racers.js';
import { dampAngle } from '../utils.js';

/**
 * Сетевой заезд. Каждый считает свою машину сам, хост ещё и соперников-ботов; чужие машины — «призраки»
 * (car.remote): их положение приходит снимками 20 раз в секунду и сглаживается. Урон от тарана считает таранящий
 * (у него своя машина точная) и шлёт владельцу жертвы; снаряды рассылаются событиями и летят у всех, а урон
 * от них владелец машины считает у себя.
 * Пешеходы у каждого свои. Кто первый финишировал / разбил всех / набил пешеходов — решает сервер.
 */
const SNAP_HZ = 20;
const EXTRAP_MAX = 0.25; // дольше снимок вперёд не угадываем, с
const SNAP_DIST = 8; // разошлись сильнее — переставить сразу, м
/** Цвета людей по порядку входа в комнату. */
export const NET_COLORS = ['#d4161c', '#13a3c8', '#f08a12', '#e14fa8'];

const r2 = (v) => Math.round(v * 100) / 100;

/** Раздать места на решётке: людям и ботам вперемешку. Возвращает { id: номер места в GRID }. */
export function makeSlots(ids) {
  const idx = ids.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const slots = {};
  ids.forEach((id, i) => (slots[id] = idx[i] % GRID.length));
  return slots;
}

export class Netplay {
  constructor(game, client, room) {
    this.game = game;
    this.client = client;
    this.room = room;
    this.myId = client.id;
    this.isHost = room.host === this.myId;
    this.myName = room.players.find((p) => p.id === this.myId)?.name || 'Я';
    this.result = null;
    this.claimed = new Set();
    this.sentWreck = new Set();
    this.state = new Map(); // id → последний снимок призрака
    this.sendAcc = 0;
    this.byId = new Map();

    // машины: своя, люди-призраки, боты (у хоста свои, у остальных — призраки)
    const g = game;
    const myIndex = room.players.findIndex((p) => p.id === this.myId);
    g.car.netId = this.myId;
    g.car.setColor(NET_COLORS[myIndex % NET_COLORS.length]);
    this.byId.set(this.myId, g.car);
    g.rivals.forEach((r, i) => {
      r.car.netId = `r${i}`;
      r.car.remote = !this.isHost;
      this.byId.set(r.car.netId, r.car);
    });
    g.remotes = [];
    room.players.forEach((p, i) => {
      if (p.id === this.myId) return;
      let rc = g.netPool.get(p.id);
      if (!rc) {
        const car = new Car(g.scene, g.city, g.fx, g.audio, g.debris, g.quality, { color: NET_COLORS[i % NET_COLORS.length], isPlayer: false, name: p.name });
        rc = { car, tag: new CarTag(g.scene, car, p.name, NET_COLORS[i % NET_COLORS.length]) };
        g.netPool.set(p.id, rc);
      }
      const car = rc.car;
      car.root.visible = true;
      car.netId = p.id;
      car.name = p.name;
      car.remote = true;
      car.human = true;
      car.listener = g.car; // звуки чужой машины тише с расстоянием
      car.netRace = { lap: 1, next: 0, passed: 0, finished: false, place: 0, time: 0 };
      car.onWrecked = () => g._carWrecked(car);
      g.remotes.push(rc);
      this.byId.set(p.id, car);
    });
    g.setCars([g.car, ...g.remotes.map((r) => r.car), ...g.rivals.map((r) => r.car)]);

    this.off = [
      client.on('s', (m) => this._snapshot(m)),
      client.on('e', (m) => this._event(m)),
      client.on('place', (m) => this._place(m)),
      client.on('result', (m) => this._result(m)),
      client.on('left', (m) => this._left(m)),
    ];
  }

  /** Отключить и убрать призраков людей. */
  dispose() {
    for (const off of this.off) off();
    const g = this.game;
    for (const rc of g.remotes) {
      rc.car.root.visible = false;
      rc.tag.sprite.visible = false;
      rc.car.x = rc.car.z = 1e5; // убрать подальше от столкновений и пешеходов
    }
    g.remotes = [];
    for (const r of g.rivals) {
      r.car.remote = false;
      r.car.netId = undefined;
    }
    g.car.netId = undefined;
  }

  car(id) {
    return this.byId.get(id) || null;
  }

  ownedCars() {
    const g = this.game;
    return this.isHost ? [g.car, ...g.rivals.map((r) => r.car)] : [g.car];
  }

  /** Каждый кадр до физики: сгладить призраков; разослать свои машины. */
  update(dt) {
    const now = performance.now() / 1000;
    const k = 1 - Math.exp(-12 * dt);
    for (const [id, s] of this.state) {
      const car = this.byId.get(id);
      if (!car || car.wrecked) continue;
      const age = Math.min(EXTRAP_MAX, now - s.at);
      const px = s.x + s.vx * age, pz = s.z + s.vz * age;
      if (Math.hypot(px - car.x, pz - car.z) > SNAP_DIST) {
        car.x = px;
        car.z = pz;
        car.yaw = s.yaw;
      } else {
        car.x += (px - car.x) * k;
        car.z += (pz - car.z) * k;
        car.yaw = dampAngle(car.yaw, s.yaw + s.angVel * age, 14, dt);
      }
      car.vx = s.vx;
      car.vz = s.vz;
      car.angVel = s.angVel;
      car.steer = s.steer;
      const sn = Math.sin(car.yaw), cs = Math.cos(car.yaw);
      car.vF = car.vx * sn + car.vz * cs;
      car.vR = -car.vx * cs + car.vz * sn;
      car.accel = s.accel;
      car.braking = !!(s.flags & 2);
      car.handbrake = !!(s.flags & 4);
    }

    const g = this.game;
    // свои разбитые — всем (с тем, кто разбил: ему награда)
    for (const car of this.ownedCars()) {
      if (!car.wrecked || this.sentWreck.has(car.netId)) continue;
      this.sentWreck.add(car.netId);
      const by = car.lastAttacker && performance.now() - car.lastAttackAt < 4000 ? car.lastAttacker.netId : null;
      this.client.send({ t: 'e', k: 'wreck', id: car.netId, by });
    }

    this.sendAcc += dt;
    if (this.sendAcc < 1 / SNAP_HZ) return;
    this.sendAcc = 0;
    const rows = [];
    for (const car of this.ownedCars()) {
      const t = car === g.car ? g.race : car.ai.tr;
      const finished = car === g.car ? g.race.place > 0 : t.finished;
      const flags = (car.wrecked ? 1 : 0) | (car.braking ? 2 : 0) | (car.handbrake ? 4 : 0) | (finished ? 8 : 0);
      rows.push([car.netId, r2(car.x), r2(car.z), r2(car.yaw), r2(car.vx), r2(car.vz), r2(car.angVel), r2(car.steer), r2(car.health), flags,
        t.lap, t.next, t.passed, car.kills, r2(car.accel || 0)]);
    }
    this.client.send({ t: 's', c: rows });
  }

  _snapshot(m) {
    const now = performance.now() / 1000;
    for (const row of m.c) {
      const [id, x, z, yaw, vx, vz, angVel, steer, health, flags, lap, next, passed, kills, accel] = row;
      const car = this.byId.get(id);
      if (!car || !car.remote) continue;
      this.state.set(id, { x, z, yaw, vx, vz, angVel, steer, flags, accel, at: now });
      if (!car.wrecked) car.health = health;
      car.kills = kills;
      const t = car.ai ? car.ai.tr : car.netRace;
      t.lap = lap;
      t.next = next;
      t.passed = passed;
      t.finished = !!(flags & 8);
      if ((flags & 1) && !car.wrecked) car.explode(); // на случай, если событие о взрыве потерялось
    }
  }

  _event(m) {
    const car = this.byId.get(m.id);
    if (!car) return;
    if (m.k === 'fire') {
      this.game.artillery.fire(car, m);
    } else if (m.k === 'hit' && !car.remote && !car.wrecked) {
      // нашу машину протаранили у себя — урон считал таранящий
      car.lastAttacker = this.byId.get(m.by) || null;
      car.lastAttackAt = performance.now();
      car.applyDamage(m.dmg, m.px, m.pz, m.nx, m.nz);
    } else if (m.k === 'wreck' && !car.wrecked) {
      car.lastAttacker = m.by ? this.byId.get(m.by) || null : null;
      car.lastAttackAt = performance.now();
      car.health = 0;
      car.explode();
    }
  }

  _place(m) {
    const g = this.game;
    const car = this.byId.get(m.car);
    if (!car) return;
    if (car === g.car) {
      g.race.place = m.place;
      if (m.place > 1) g.hud.popup(`ФИНИШ: ${m.place} МЕСТО`, 'gold big');
    } else (car.ai ? car.ai.tr : car.netRace).place = m.place;
  }

  _result(m) {
    this.result = m;
    this.game._result(m.kind, this.byId.get(m.car), m.name);
  }

  _left(m) {
    const car = this.byId.get(m.id);
    if (car && !car.wrecked) {
      car.lastAttacker = null;
      car.explode();
    }
    this.game.hud.popup(`${m.name} ВЫШЕЛ`, 'info');
  }

  /** Своя машина (или бот у хоста) выстрелила — пусть снаряд полетит у всех. */
  sendFire(car, shot) {
    this.client.send({ t: 'e', k: 'fire', id: car.netId, x: r2(shot.x), y: r2(shot.y), z: r2(shot.z), dx: shot.dx, dz: shot.dz, v: r2(shot.v) });
  }

  /** Наша машина протаранила чужую: урон — её владельцу. */
  sendHit(victim, by, dmg, px, pz, nx, nz) {
    this.client.send({ t: 'e', k: 'hit', id: victim.netId, by: by.netId, dmg: r2(dmg), px: r2(px), pz: r2(pz), nx: r2(nx), nz: r2(nz) });
  }

  /** Заявка на победу (или на место на финише); первую заявку сервер объявит всем. */
  claim(kind, car) {
    const key = `${kind}:${car.netId}`;
    if (this.claimed.has(key)) return;
    this.claimed.add(key);
    this.client.send({ t: 'claim', kind, car: car.netId, name: car === this.game.car ? this.myName : car.name });
  }

  /** Хост: новый заезд в той же комнате. */
  restart() {
    if (!this.isHost) return;
    this.client.send({ t: 'start', slots: makeSlots([...this.room.players.map((p) => p.id), ...this.game.rivals.map((r) => r.car.netId)]) });
  }

  /** Хост: вернуть комнату в лобби. */
  toLobby() {
    if (this.isHost) this.client.send({ t: 'lobby' });
  }

  leave() {
    this.client.send({ t: 'leave' });
  }
}
