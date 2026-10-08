import { Car } from '../car.js';
import { CarTag } from '../tag.js';
import { GRID, MAX_CARS } from '../racers.js';
import { spawnPoints, zoneCenter } from '../zone.js';
import { BotGunner } from '../gunner.js';
import { dampAngle } from '../utils.js';

/**
 * Сетевой заезд. Машину считает её «хозяин» — человек за рулём, а если за рулём бот — человек в пушке; ботов-соперников
 * считает хост. Чужие машины — «призраки» (car.remote): их положение приходит снимками 20 раз в секунду и сглаживается.
 * Урон от тарана считает таранящий (у него своя машина точная) и шлёт владельцу жертвы; снаряды рассылаются событиями
 * и летят у всех, урон от них владелец машины считает у себя. Стрелок в чужой машине крутит башню у себя и шлёт
 * её поворот хозяину. Уличную мелочь ломает тот, чья машина или снаряд в неё попали, и рассылает номера сломанного
 * (сервер их запоминает для вернувшихся). Пешеходы у каждого свои. Кто первый финишировал / разбил всех / набил
 * пешеходов — решает сервер.
 */
const SNAP_HZ = 20;
const EXTRAP_MAX = 0.25; // дольше снимок вперёд не угадываем, с
const SNAP_DIST = 8; // разошлись сильнее — переставить сразу, м
/** Цвета машин людей по порядку входа в комнату. */
export const NET_COLORS = ['#d4161c', '#13a3c8', '#f08a12', '#e14fa8'];
/** Цвета и имена команд. */
export const TEAMS = { 1: { name: 'КРАСНЫЕ', color: '#e5262b' }, 2: { name: 'СИНИЕ', color: '#2f7cf0' } };

const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;

/** Раздать места на решётке: машинам людей и ботам вперемешку. Возвращает { id: номер места в GRID }. */
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

/**
 * Экипажи комнаты: машину заводит игрок, у которого car === id; к нему может подсесть другой (car = его id).
 * Возвращает [{ id, driver, gunner, owner, team, names, color }]: driver/gunner — id игрока или 'bot'
 * (gunner null — в классике пушки у экипажа нет); owner — чей компьютер считает машину.
 */
export function crewsOf(room) {
  const crew = room.settings?.mode === 'crew';
  const teams = !!room.settings?.teams;
  const ps = room.players;
  return ps
    .filter((o) => o.car === o.id)
    .map((o) => {
      const riders = ps.filter((p) => p.car === o.id);
      const driver = riders.find((p) => p.seat === 'driver')?.id ?? 'bot';
      const gunner = crew ? riders.find((p) => p.seat === 'gunner')?.id ?? 'bot' : null;
      return {
        id: o.id,
        driver,
        gunner,
        owner: driver !== 'bot' ? driver : gunner,
        team: teams ? `t${o.team}` : `c${o.id}`, // без команд «команда» — свой экипаж: напарники не бьют друг друга
        names: riders.map((p) => p.name).join(' + '),
        color: teams ? TEAMS[o.team]?.color || NET_COLORS[0] : NET_COLORS[ps.indexOf(o) % NET_COLORS.length],
      };
    });
}

/** Сколько ботов будет в заезде: по настройке, но всего машин — не больше MAX_CARS. */
export function botCount(room) {
  return Math.max(0, Math.min(room.settings?.bots ?? 4, MAX_CARS - crewsOf(room).length));
}

/**
 * Хост начинает заезд: места машинам (в гонке — клетки решётки, в битве — точки вразброс) и центр зоны.
 * Возвращает сообщение start для сервера.
 */
export function makeStart(room, city) {
  const ids = [...crewsOf(room).map((c) => c.id), ...Array.from({ length: botCount(room) }, (_, i) => `r${i}`)];
  if (room.settings?.game !== 'royale') return { t: 'start', slots: makeSlots(ids) };
  const pts = spawnPoints(city, ids.length);
  const r2p = (p) => ({ x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10, yaw: Math.round(p.yaw * 1000) / 1000 });
  return { t: 'start', slots: Object.fromEntries(ids.map((id, i) => [id, r2p(pts[i])])), zone: zoneCenter(city) };
}

export class Netplay {
  constructor(game, client, room) {
    this.game = game;
    this.client = client;
    this.room = room;
    this.myId = client.id;
    this.isHost = room.host === this.myId;
    this.result = null;
    this.claimed = new Set();
    this.sentWreck = new Set();
    this.state = new Map(); // id → последний снимок призрака
    this.stats = new Map(); // id игрока → { score, kills, team } — для общих очков команды
    this.sendAcc = 0;
    this.byId = new Map();
    this.crews = crewsOf(room);
    this.broken = []; // сломанная здесь уличная мелочь, ещё не разосланная: [номер, vx, vz]
    game.breakables.onBreak = (it, vx, vz) => this.broken.push([it.id, r1(vx), r1(vz)]);

    const g = game;
    const me = this.myId;
    const crewMode = room.settings?.mode === 'crew';
    const seatOf = (who) => (who === me ? 'me' : who);
    g.remotes = [];
    let myCar = null, mySeat = 'driver';
    const cars = [];
    for (const cr of this.crews) {
      let car;
      if (cr.id === me) car = g.mainCar;
      else {
        let rc = g.netPool.get(cr.id);
        if (!rc) {
          car = new Car(g.scene, g.city, g.fx, g.audio, g.debris, g.quality, { color: cr.color, isPlayer: false, name: cr.names });
          rc = { car, tag: new CarTag(g.scene, car, cr.names, cr.color) };
          g.netPool.set(cr.id, rc);
          g._bindCar(car);
        }
        car = rc.car;
        rc.tag.name = cr.names;
        rc.tag.color = cr.color;
        rc.tag.hp = -1; // перерисовать с новым именем
        g.remotes.push(rc);
      }
      car.netId = cr.id;
      car.name = cr.names;
      car.remote = cr.owner !== me;
      car.human = true;
      car.team = cr.team;
      car.crew = { driver: seatOf(cr.driver), gunner: cr.gunner == null ? null : seatOf(cr.gunner) };
      car.netRace = { lap: 1, next: 0, passed: 0, finished: false, place: 0, time: 0 };
      car.setColor(cr.color);
      this.byId.set(cr.id, car);
      cars.push(car);
      if (cr.driver === me || cr.gunner === me) {
        myCar = car;
        mySeat = cr.driver === me ? 'driver' : 'gunner';
        this.myCrew = cr;
      }
    }
    this.myTeam = this.myCrew?.team ?? null;
    this.myName = this.myCrew?.names || 'Я';

    const rivals = g.allRivals.slice(0, botCount(room));
    rivals.forEach((r, i) => {
      r.car.netId = `r${i}`;
      r.car.remote = !this.isHost;
      r.car.team = null;
      r.car.crew = { driver: 'bot', gunner: crewMode ? 'bot' : null };
      this.byId.set(r.car.netId, r.car);
    });
    g.applyLineup({ car: myCar, seat: mySeat, mode: crewMode ? 'crew' : 'classic', game: room.settings?.game || 'race', rivals, others: cars.filter((c) => c !== myCar) });

    this.off = [
      client.on('s', (m) => this._snapshot(m)),
      client.on('e', (m) => this._event(m)),
      client.on('place', (m) => this._place(m)),
      client.on('result', (m) => this._result(m)),
      client.on('left', (m) => this._left(m)),
      client.on('away', (m) => this._away(m, true)),
      client.on('back', (m) => this._away(m, false)),
    ];
  }

  /** Отключить и убрать призраков людей. */
  dispose() {
    for (const off of this.off) off();
    const g = this.game;
    g.breakables.onBreak = null;
    for (const rc of g.remotes) {
      rc.car.root.visible = false;
      rc.tag.sprite.visible = false;
      rc.car.x = rc.car.z = 1e5; // убрать подальше от столкновений и пешеходов
    }
    g.remotes = [];
    for (const r of g.allRivals) {
      r.car.remote = false;
      r.car.netId = undefined;
    }
    g.mainCar.netId = undefined;
  }

  car(id) {
    return this.byId.get(id) || null;
  }

  /** Сумма очков или сбитых у напарников (без меня). */
  teamStat(key) {
    let sum = 0;
    for (const [id, st] of this.stats) if (id !== this.myId && st.team === this.myTeam) sum += st[key];
    return sum;
  }

  /** Каждый кадр до физики: сгладить призраков; разослать свои машины. */
  update(dt) {
    const g = this.game;
    const now = performance.now() / 1000;
    const k = 1 - Math.exp(-12 * dt);
    for (const [id, s] of this.state) {
      const car = this.byId.get(id);
      if (!car || !car.remote || car.wrecked) continue;
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
      // башню той машины, где стреляю я, кручу сам
      if (!(car === g.car && g.seat === 'gunner')) car.turretYaw = dampAngle(car.turretYaw, s.turret, 20, dt);
    }

    // свои разбитые — всем (с тем, кто разбил: ему награда)
    const owned = g.cars.filter((c) => !c.remote);
    for (const car of owned) {
      if (!car.wrecked || this.sentWreck.has(car.netId)) continue;
      this.sentWreck.add(car.netId);
      const by = car.lastAttacker && performance.now() - car.lastAttackAt < 4000 ? car.lastAttacker.netId : null;
      this.client.send({ t: 'e', k: 'wreck', id: car.netId, by });
    }

    // сломанное — сразу, не дожидаясь снимка: пусть у всех падает почти одновременно
    if (this.broken.length) {
      this.client.send({ t: 'e', k: 'prop', l: this.broken });
      this.broken = [];
    }

    this.sendAcc += dt;
    if (this.sendAcc < 1 / SNAP_HZ) return;
    this.sendAcc = 0;
    const rows = [];
    for (const car of owned) {
      const mine = car === g.car;
      const t = mine ? g.race : car.ai.tr;
      const finished = mine ? g.race.place > 0 : t.finished;
      const flags = (car.wrecked ? 1 : 0) | (car.braking ? 2 : 0) | (car.handbrake ? 4 : 0) | (finished ? 8 : 0);
      rows.push([car.netId, r2(car.x), r2(car.z), r2(car.yaw), r2(car.vx), r2(car.vz), r2(car.angVel), r2(car.steer), r2(car.health), flags,
        t.lap, t.next, t.passed, car.kills, r2(car.accel || 0), r2(car.turretYaw), mine ? Math.round(g.race.timeLeft * 10) / 10 : 0]);
    }
    const msg = { t: 's', c: rows, p: [g.score, g.kills, this.myTeam] };
    // сижу в пушке чужой машины — её хозяину нужен поворот башни
    if (g.seat === 'gunner' && g.car.remote) msg.g = [g.car.netId, r2(g.car.turretYaw)];
    this.client.send(msg);
  }

  _snapshot(m) {
    const g = this.game;
    const now = performance.now() / 1000;
    if (m.p) this.stats.set(m.from, { score: m.p[0], kills: m.p[1], team: m.p[2] });
    if (m.g) {
      const car = this.byId.get(m.g[0]);
      if (car && !car.remote && car.crew?.gunner === m.from) car.turretYaw = m.g[1];
    }
    for (const row of m.c) {
      const [id, x, z, yaw, vx, vz, angVel, steer, health, flags, lap, next, passed, kills, accel, turret, timeLeft] = row;
      const car = this.byId.get(id);
      if (!car || !car.remote) continue;
      this.state.set(id, { x, z, yaw, vx, vz, angVel, steer, flags, accel, turret, at: now });
      if (!car.wrecked) {
        if (car === g.car && health < car.health - 0.5) g._myDamage(car.health - health); // моя машина (я в пушке) получила удар
        car.health = health;
      }
      car.kills = kills;
      if (car === g.car) {
        // я в пушке чужой машины: таймер и круги — как у водителя (но не раньше своего отсчёта)
        if (g.race.started) g.race.restore({ lap, next, passed, timeLeft });
      } else {
        const t = car.ai ? car.ai.tr : car.netRace;
        t.lap = lap;
        t.next = next;
        t.passed = passed;
        t.finished = !!(flags & 8);
      }
      if ((flags & 1) && !car.wrecked) car.explode(); // на случай, если событие о взрыве потерялось
    }
  }

  _event(m) {
    if (m.k === 'prop') return this._props(m.l);
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

  /** Другой игрок сломал уличную мелочь: ломаем то же, громкость — по расстоянию до меня. */
  _props(list) {
    const g = this.game;
    for (const [id, vx, vz] of list || []) {
      const it = g.breakables.items[id];
      if (!it) continue;
      const k = Math.max(0, 1 - Math.hypot(it.x - g.car.x, it.z - g.car.z) / 90);
      g.breakables.breakNet(id, vx, vz, k * k);
    }
  }

  /** Связь вернулась (или вернулся после перезагрузки): убрать всё, что сломали без меня. */
  syncProps(ids) {
    if (ids) this.game.breakables.removeIds(ids);
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

  /** Игрок выпал (away = true) или вернулся: пока его нет, в пушке моей машины стреляет бот. */
  _away(m, away) {
    const g = this.game;
    for (const car of g.cars) {
      if (car.remote || car.crew?.gunner !== m.id) continue;
      car.botGunner = away ? new BotGunner(car, g.city.world, 0.4) : null;
    }
    g.hud.popup(away ? `${m.name}: СВЯЗЬ ПОТЕРЯНА, ЖДЁМ…` : `${m.name} ВЕРНУЛСЯ`, away ? 'warn' : 'info');
  }

  /**
   * Вернулся в идущий заезд (после обрыва и перезагрузки страницы): без отсчёта, свои машины — с последнего
   * снимка, который запомнил сервер (место, корпус, круг, время), чужие — как обычные снимки.
   */
  resume({ rows, stats, result, elapsed, props }) {
    const g = this.game;
    g.countdown = 0;
    g.race.start();
    g.race.clock = Math.max(0, elapsed ?? 30); // часы заезда — по серверу (по ним и зона сжимается)
    if (stats) {
      g.score = stats[0];
      g.kills = stats[1];
    }
    const now = performance.now() / 1000;
    for (const row of rows) {
      const [id, x, z, yaw, vx, vz, angVel, , health, flags, lap, next, passed, kills, , turret, timeLeft] = row;
      const car = this.byId.get(id);
      if (!car) continue;
      if (car.remote) {
        this._snapshot({ c: [row] });
        const st = this.state.get(id);
        if (st) st.at = now;
        car.x = x;
        car.z = z;
        car.yaw = yaw;
        continue;
      }
      Object.assign(car, { x, z, yaw, vx, vz, angVel, kills, turretYaw: turret });
      car.health = health;
      if (car === g.car) g.race.restore({ lap, next, passed, timeLeft });
      else if (car.ai) Object.assign(car.ai.tr, { lap, next, passed, finished: !!(flags & 8) });
      if ((flags & 1) && !car.wrecked) car.explode();
    }
    this.syncProps(props);
    g.aimYaw = g.car.yaw + g.car.turretYaw;
    g.cam.snap(g.car);
    if (result) this._result(result);
  }

  _left(m) {
    const g = this.game;
    this.stats.delete(m.id);
    for (const car of g.cars) {
      if (!car.crew || car.remote) continue;
      // напарник из моей пушки ушёл — стрелять будет бот
      if (car.crew.gunner === m.id) {
        car.crew.gunner = 'bot';
        car.botGunner = new BotGunner(car, g.city.world, 0.4);
      }
    }
    const car = this.byId.get(m.id);
    if (car && car !== g.car && !car.wrecked) {
      car.lastAttacker = null;
      car.explode();
    }
    g.hud.popup(`${m.name} ВЫШЕЛ`, 'info');
  }

  /** Своя машина (или бот у хоста, или машина, где я стрелок) выстрелила — пусть снаряд полетит у всех. */
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
    this.client.send({ t: 'claim', kind, car: car.netId, name: car.name });
  }

  /** Хост: новый заезд в той же комнате. */
  restart() {
    if (!this.isHost) return;
    this.client.send(makeStart(this.room, this.game.city));
  }

  /** Хост: вернуть комнату в лобби. */
  toLobby() {
    if (this.isHost) this.client.send({ t: 'lobby' });
  }

  leave() {
    this.client.send({ t: 'leave' });
  }
}
