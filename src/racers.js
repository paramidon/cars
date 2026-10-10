import { Car, HIT_Z, HIT_R, CAR_INERTIA, sameTeam } from './car.js';
import { ST } from './pedestrians.js';
import { CarTag } from './tag.js';
import { ZONE, roadPointNear } from './zone.js';
import { clamp, lerp, rand } from './utils.js';

/**
 * Соперники. Характер — не роль, а две шкалы от 0 до 1:
 * aggr — тяга к охоте на машины: 0 — чистый гонщик (стреляет, только если кто-то прямо по курсу, сворачивает
 *   за машиной редко и ненадолго), 1 — охотник (замечает машины издалека, гоняется за ними долго);
 * gore — тяга к пешеходам: около 0 — давит только тех, кто попался прямо на дороге, 1 — мясник: хочет выиграть,
 *   первым набив RACE.goreWin пешеходов, рыщет по тротуарам и стреляет по толпе.
 * speed — доля от максималки игрока, corner — скорость в повороте 90°, м/с; lane — полоса (вправо +).
 */
export const RIVALS = [
  { name: 'МОЛНИЯ', color: '#1f5fe0', number: 7, aggr: 0.1, gore: 0.1, speed: 0.9, corner: 12, lane: 2.2 },
  { name: 'РАКЕТА', color: '#8e2fd0', number: 21, aggr: 0.3, gore: 0.15, speed: 0.87, corner: 11.5, lane: -2.2 },
  { name: 'МЯСНИК', color: '#1f9e45', number: 13, aggr: 0.25, gore: 1, speed: 0.88, corner: 11, lane: 0 },
  { name: 'БУЛЬДОЗЕР', color: '#e8b10c', number: 66, aggr: 0.8, gore: 0.2, speed: 0.85, corner: 10.5, lane: 0 },
  { name: 'ШУСТРИК', color: '#8fd11f', number: 3, aggr: 0.2, gore: 0.1, speed: 0.92, corner: 12.5, lane: 2.2 },
  { name: 'ГРОБОВЩИК', color: '#e8e8e8', number: 99, aggr: 0.7, gore: 0.3, speed: 0.86, corner: 10.5, lane: -2.2 },
  { name: 'КОСТОЛОМ', color: '#7a4a22', number: 44, aggr: 0.45, gore: 0.7, speed: 0.87, corner: 11, lane: 0 },
];
/** Остальные боты королевской битвы — те же характеры, но свои имена, цвета и номера. */
const EXTRA = [
  ['ГАДЮКА', '#0f8f8a', 8], ['КАБАН', '#a33a1a', 12], ['ТОПОР', '#5a6270', 17], ['ВДОВА', '#2a2a2a', 31],
  ['ШАКАЛ', '#c97b2a', 45], ['ТАРАН', '#3b4fb8', 50], ['КЛЫК', '#b8c41a', 57], ['ПИЛА', '#d1508a', 62],
  ['ЧЕРЕП', '#c8b89a', 77], ['ГРОМ', '#4a8fd1', 81], ['МОЛОТ', '#6b2fa0', 88], ['СКАЛЬПЕЛЬ', '#2fbf8a', 93],
];
RIVALS.push(...EXTRA.map(([name, color, number], i) => ({ ...RIVALS[i % RIVALS.length], name, color, number })));
/** Больше машин в гонке не бывает (мест на стартовой решётке — столько же). */
export const MAX_CARS = 8;
/** В королевской битве все разбросаны по городу — машин может быть больше. */
export const MAX_CARS_ROYALE = 20;
/** Предел машин для типа игры ('race' / 'royale'). */
export const maxCars = (game) => (game === 'royale' ? MAX_CARS_ROYALE : MAX_CARS);

/** Бот в битве: не лезет туда, где стена окажется через столько с; снаружи (или почти) — бросает всё и бежит внутрь. */
const ZONE_SAFE = { ahead: 5, margin: 6, flee: 3 };

/** В королевской битве гонщиков нет: они становятся «выживальщиками» — держатся середины зоны и огрызаются. */
const SURVIVOR_AGGR = 0.5;

/** Роль для подписей и выбора жертвы — по преобладающей черте характера. */
export function roleOf(def) {
  if (def.gore >= 0.6) return 'butcher';
  if (def.aggr >= 0.6) return 'hunter';
  return 'racer';
}

/** Стартовая решётка: [вбок, вперёд] от точки старта города; места каждый заезд раздаются случайно. */
export const GRID = [
  [0, 0],
  [0, 7.5],
  [-7, 7.5],
  [-7, 0],
  [0, -7.5],
  [-7, -7.5],
  [0, -15],
  [-7, -15],
];

/** Точка и курс места на решётке. */
export function gridPoint(city, [side, ahead]) {
  const sp = city.spawn;
  const fx = Math.sin(sp.yaw), fz = Math.cos(sp.yaw);
  const rx = -Math.cos(sp.yaw), rz = Math.sin(sp.yaw); // вправо
  return { x: sp.x + fx * ahead + rx * side, z: sp.z + fz * ahead + rz * side, yaw: sp.yaw };
}

const HUNT_DELAY = 10; // с после старта все ещё едут по трассе — без свалки на старте
/** Охота на машины: пары [при aggr = 0, при aggr = 1], между ними — линейно. */
const HUNT = {
  range: [30, 170], // дальше цель не замечают, м
  cone: [0.5, Math.PI], // цель должна быть в таком секторе перед носом, рад (охотник видит и сзади)
  chance: [0.05, 1], // вероятность ввязаться, когда цель подходит (проверка раз в 1.5 с)
  patience: [2.5, 12], // сколько с гоняться, ни разу не попав, — потом бросить (каждое попадание обнуляет)
  mutual: 1.7, // если жертва охотится на тебя же, терпение тает быстрее — чтобы не кружить в вальсе
  cooldown: [25, 8], // сколько с после этого ехать по трассе, не отвлекаясь на машины
  fireRange: [35, 80],
  fireCone: [0.05, 0.09], // насколько точно нос должен смотреть на цель, рад
  firePause: [[3.5, 6.5], [0.4, 1]], // пауза между выстрелами, когда не охотится, с
};
// кого выбирают охотнее: расстояние до цели умножается на вес (меньше — желаннее)
const PREY_WEIGHT = { player: 0.6, butcher: 1, hunter: 1, racer: 1.2 };
/** Охота на пешеходов: пары [при gore = 0, при gore = 1]. */
const GORE = {
  range: [12, 70], // м
  cone: [0.3, 1.9], // рад
  give: [1.5, 7], // через сколько с бросить, если не догнал
  fireRange: [0, 50], // стрельба по толпе (у мясника), м
  firePause: [2, 4], // пауза между выстрелами по толпе, с
  clearance: 8, // по толпе не стреляет, если рядом с ней машина, м
  skip: 6, // s: a pedestrian the bot gave up on (couldn't reach in time) isn't picked again for this long
};
const FIRE_MIN = 8; // в упор не стреляют
// охотник не толкает жертву, а таранит раз за разом: после удара сдаёт назад и разгоняется снова
const RAM = { back: [1.0, 1.5], charge: 1.5 }; // сколько с сдавать назад; сколько с после этого не отъезжать
// no way out (wedged between a tree and a building, circling a pedestrian it can't reach…): a bot that hasn't got more
// than `near` m away from one spot in `time` s respawns. Each back-up resets the stuck timer above, so a bot in a trap
// could back up and drive into it again for ever. Ramming a target within `ram` m doesn't count
const STUCK = { near: 8, time: 8, ram: 15 };
const at = (pair, k) => lerp(pair[0], pair[1], k);
// пара диапазонов [[от, до] при 0, [от, до] при 1] → диапазон при k
const at2 = (pairs, k) => [at([pairs[0][0], pairs[1][0]], k), at([pairs[0][1], pairs[1][1]], k)];
const losFilter = (c) => c.kind === 'building' || c.kind === 'wall' || c.kind === 'statue' || c.kind === 'pump';
const shotFilter = (c) => c.kind !== 'breakable' && c.h >= 1.2;

/** Удар машины о машину: лоб крепкий, бок и зад — слабые места. */
export const CAR_HIT = {
  // урон линейно растёт со встречной скоростью, а выше knee — втрое медленнее, чтобы с одного удара не разбить.
  // Лбом в бок: 20 км/ч — −3, 40 — −20, 60 — −36, 80 — −48, 100 — −55, 130 — −68, 160 — −81
  threshold: 4.5, // м/с встречной скорости, ниже — без урона
  scale: 2.4,
  knee: 45, // выше этого урон растёт медленнее
  over: 0.35, // во сколько раз медленнее
  // front — только лоб в лоб; если таранишь лбом в бок или зад, лоб с кенгурятником не страдает вовсе
  zone: { front: 0.3, side: 1.25, rear: 1.0 },
  restitution: 0.3,
};

const TOP_SPEED = 35; // ≈ максималка игрока, м/с

/**
 * Соперник: машина + ИИ-водитель + табличка над крышей.
 * car — готовая машина: тогда это автопилот чужой машины (игрок сидит в пушке), без таблички и не «соперник».
 */
export class Rival {
  constructor(scene, city, fx, audio, debris, quality, race, def, index, car = null) {
    this.def = def;
    this.baseDef = def;
    this.zone = null; // королевская битва: зона (вместо трассы катаемся внутри неё)
    this.index = index;
    this.race = race;
    this.city = city;
    this.inp = { throttle: 0, brake: 0, steer: 0, handbrake: false, fire: false };
    if (car) {
      this.car = car;
      this.autopilot = true;
      this.tag = null;
      this._clear();
      return;
    }
    this.car = new Car(scene, city, fx, audio, debris, quality, {
      color: def.color, wing: true, isPlayer: false, number: def.number, name: def.name, wallDamage: 0.5,
    });
    this.car.role = roleOf(def);
    this.car.ai = this;
    this.tag = new CarTag(scene, this.car, def.name, def.color);
    this.reset();
  }

  get role() {
    return roleOf(this.def);
  }

  /** Королевская битва (zone) или гонка (null): гонщик в битве — выживальщик, задиристее. */
  setZone(zone) {
    this.zone = zone;
    const base = this.baseDef;
    this.def = zone && roleOf(base) === 'racer' ? { ...base, aggr: Math.max(base.aggr, SURVIVOR_AGGR) } : base;
    this.wp = null;
  }

  /** Точка там, где скоро будет зона смерти (ahead — на сколько с вперёд смотреть). */
  _unsafe(x, z, ahead = ZONE_SAFE.ahead) {
    return !!this.zone && this.zone.unsafe(x, z, ahead, ZONE_SAFE.margin);
  }

  /** Королевская битва: кататься по улицам внутри зоны, ближе к её середине; новая точка — когда доехал. */
  _roam() {
    const car = this.car, z = this.zone;
    if (this._unsafe(car.x, car.z, ZONE_SAFE.flee)) {
      // у стены или уже снаружи — прямиком к центру (за домами — по улицам)
      const c = { x: z.cx, z: z.cz };
      this.wp = null;
      return this._clearLine(c.x, c.z) ? c : this._navPoint(c);
    }
    const wp = this.wp;
    if (!wp || Math.hypot(wp.x - car.x, wp.z - car.z) < 10 || Math.hypot(wp.x - z.cx, wp.z - z.cz) > z.radius * 0.75) {
      this.wp = roadPointNear(this.city, z.cx, z.cz, Math.max(12, z.radius * 0.6));
    }
    return this._clearLine(this.wp.x, this.wp.z) ? this.wp : this._navPoint(this.wp);
  }

  get name() {
    return this.def.name;
  }

  get color() {
    return this.def.color;
  }

  /** Место старта: клетка решётки или готовая точка { x, z, yaw } (королевская битва). */
  startPoint() {
    return Array.isArray(this.slot) ? gridPoint(this.city, this.slot) : this.slot;
  }

  /** slot — место на решётке (GRID). */
  reset(slot = GRID[(this.index + 1) % GRID.length]) {
    this.slot = slot;
    this.car.reset(this.startPoint());
    this._clear();
  }

  /** Сбросить ИИ (машину не трогает). */
  _clear() {
    this.tr = this.race.newTracker();
    this.stuckT = 0;
    this.reverseT = 0;
    this.stuckAt = null; // where the bot has been for stuckAt.t s (STUCK)
    this.backT = 0; // отъезд назад для нового тарана
    this.chargeT = 0; // пока > 0, новый отъезд не начинаем — даём разогнаться
    this.boost = 1;
    this.mode = 'race'; // race — по трассе, hunt — за машиной, gore — за пешеходом
    this.target = null;
    this.retarget = 0;
    this.patience = 0;
    this.calmT = 0; // пока > 0, на машины не отвлекается
    this.targetHp = 0;
    this.prey = null;
    this.preyT = 0;
    this.scanT = 0;
    this.skipPrey = null; // a pedestrian just given up on: not picked again for GORE.skip s
    this.skipT = 0;
    this.fireCD = rand(...at2(HUNT.firePause, this.def.aggr));
    this.goreCD = rand(...GORE.firePause);
    this.out = false; // разбит — выбыл
    this.tag?.draw();
  }

  updateTag(player) {
    this.tag?.update(player);
  }

  /** Угол от носа до точки (вправо +) и расстояние. */
  _bearing(x, z) {
    const car = this.car;
    const s = Math.sin(car.yaw), c = Math.cos(car.yaw);
    const dx = x - car.x, dz = z - car.z;
    return { ang: Math.atan2(dx * -c + dz * s, dx * s + dz * c), d: Math.hypot(dx, dz) };
  }

  _clearLine(x, z) {
    const car = this.car;
    const d = Math.hypot(x - car.x, z - car.z) || 1;
    return !this.city.world.raycast(car.x, car.z, (x - car.x) / d, (z - car.z) / d, d, losFilter);
  }

  /** Жертва-машина: ближайшая с учётом предпочтений; current — держим, пока она не сильно хуже новой. */
  _pickTarget(cars, current) {
    const car = this.car, a = this.def.aggr;
    const range = at(HUNT.range, a), cone = at(HUNT.cone, a);
    const score = (c) => {
      const { ang, d } = this._bearing(c.x, c.z);
      if (d > (c === current ? range * 1.3 : range)) return Infinity;
      if (c !== current && Math.abs(ang) > cone) return Infinity;
      // в битве каждый сам за себя — людей не выделяем
      if (this.zone) return d;
      return d * (c.human ? PREY_WEIGHT.player : PREY_WEIGHT[c.role] || 1);
    };
    let best = null, bs = Infinity;
    for (const c of cars) {
      if (c === car || c.wrecked || sameTeam(c, car)) continue;
      if (this._unsafe(c.x, c.z)) continue; // за зону смерти не гонимся
      const sc = score(c);
      if (sc < bs) {
        bs = sc;
        best = c;
      }
    }
    if (current && !current.wrecked && best && current !== best && score(current) < bs * 1.35) return current;
    return best;
  }

  /** Решить, гоняться ли за машиной: начать, продолжить или бросить. */
  _huntDecision(dt, ctx) {
    const car = this.car, a = this.def.aggr;
    this.calmT -= dt;
    if (a <= 0 || ctx.raceTime < (this.zone ? ZONE.hunt : HUNT_DELAY) || this.tr.finished) return this._dropHunt(0);
    this.retarget -= dt;
    if (this.mode === 'hunt') {
      const T = this.target;
      // попал по жертве — терпение снова полное
      if (T.health < this.targetHp - 0.5 && T.lastAttacker === car) this.patience = at(HUNT.patience, a);
      this.targetHp = T.health;
      const mutual = T.ai && T.ai.target === car;
      this.patience -= dt * (mutual ? HUNT.mutual : 1);
      if (T.wrecked || this.patience <= 0) return this._dropHunt(at(HUNT.cooldown, a));
      // жертва удрала за зону — за ней не лезем
      if (this._unsafe(T.x, T.z)) return this._dropHunt(3);
      if (this.retarget <= 0) {
        this.retarget = 1.5;
        const next = this._pickTarget(ctx.cars, T);
        if (!next) return this._dropHunt(at(HUNT.cooldown, a) * 0.5);
        if (next !== T) this._startHunt(next);
      }
      return;
    }
    if (this.calmT > 0 || this.retarget > 0) return;
    this.retarget = 1.5;
    const next = this._pickTarget(ctx.cars, null);
    if (next && Math.random() < at(HUNT.chance, a)) this._startHunt(next);
  }

  _startHunt(T) {
    this.mode = 'hunt';
    this.target = T;
    this.targetHp = T.health;
    this.patience = at(HUNT.patience, this.def.aggr);
    this.prey = null;
  }

  _dropHunt(calm) {
    if (this.mode === 'hunt') {
      this.mode = 'race';
      this.calmT = calm;
    }
    this.target = null;
  }

  /** Пешеход, за которым стоит свернуть: впереди, на виду, лежачих — охотнее (их раздавить проще). */
  _pickPrey(peds) {
    const g = this.def.gore;
    const range = at(GORE.range, g), cone = at(GORE.cone, g);
    let best = null, bs = Infinity;
    for (const p of peds.peds) {
      if (p.state === ST.FREE || p.state === ST.DEAD || p.state === ST.FLYING) continue;
      if (this._unsafe(p.x, p.z)) continue; // за пешеходом в зону смерти не едем
      if (p === this.skipPrey && this.skipT > 0) continue;
      const { ang, d } = this._bearing(p.x, p.z);
      if (d > range || Math.abs(ang) > cone) continue;
      const lying = p.state === ST.DOWN || p.state === ST.GETUP;
      const sc = d * (lying ? 0.6 : 1) * (1 + Math.abs(ang));
      if (sc >= bs || !this._clearLine(p.x, p.z)) continue;
      bs = sc;
      best = p;
    }
    return best;
  }

  _goreDecision(dt, peds) {
    const g = this.def.gore;
    if (!peds || g <= 0) return;
    this.skipT -= dt;
    if (this.mode === 'gore') {
      const p = this.prey;
      this.preyT += dt;
      const gone = !peds.isLiving(p) || this._unsafe(p.x, p.z);
      const late = this.preyT > at(GORE.give, g);
      if (gone || late || Math.hypot(p.x - this.preyX, p.z - this.preyZ) > 15) {
        // couldn't get it in time (circling it, or it's behind a wall): leave it alone for a while
        if (late && !gone) {
          this.skipPrey = p;
          this.skipT = GORE.skip;
        }
        this.mode = 'race';
        this.prey = null;
        this.scanT = 0.3;
      } else {
        this.preyX = p.x;
        this.preyZ = p.z;
      }
      return;
    }
    if (this.mode !== 'race') return;
    this.scanT -= dt;
    if (this.scanT > 0) return;
    this.scanT = 0.4;
    // мясник сворачивает всегда, гонщик — изредка и только за тем, кто почти на пути
    if (Math.random() > Math.min(1, g * 2)) return;
    const p = this._pickPrey(peds);
    if (!p) return;
    this.mode = 'gore';
    this.prey = p;
    this.preyT = 0;
    this.preyX = p.x;
    this.preyZ = p.z;
  }

  /** Цель за домами: ехать по улицам к перекрёстку, который ближе к цели. */
  _navPoint(T) {
    const car = this.car, R = this.city.roads, N = R.length - 1;
    const cell = R[1] - R[0];
    const fx = (car.x - R[0]) / cell, fz = (car.z - R[0]) / cell;
    const ix = Math.max(0, Math.min(N, Math.round(fx))), iz = Math.max(0, Math.min(N, Math.round(fz)));
    const onV = Math.abs(car.x - R[ix]) < 8, onH = Math.abs(car.z - R[iz]) < 8;
    const cl = (i) => Math.max(0, Math.min(N, i));
    let cands;
    if (onV && onH) cands = [[ix + 1, iz], [ix - 1, iz], [ix, iz + 1], [ix, iz - 1]]; // на перекрёстке
    else if (onV) cands = [[ix, Math.floor(fz)], [ix, Math.ceil(fz)]]; // на улице вдоль Z
    else if (onH) cands = [[Math.floor(fx), iz], [Math.ceil(fx), iz]]; // на улице вдоль X
    else cands = [[ix, iz]];
    let best = null, bs = Infinity;
    for (const [i, j] of cands) {
      const nx = R[cl(i)], nz = R[cl(j)];
      if (Math.hypot(nx - car.x, nz - car.z) < 6) continue;
      const sc = Math.hypot(nx - T.x, nz - T.z);
      if (sc < bs) {
        bs = sc;
        best = { x: nx, z: nz };
      }
    }
    return best || { x: R[ix], z: R[iz] };
  }

  /** Стоит ли стрелять по машине: кто-то почти точно по курсу, в досягаемости и не за стеной. */
  _shouldFire(cars, shellSpeed) {
    const car = this.car, a = this.def.aggr;
    const s = Math.sin(car.yaw), c = Math.cos(car.yaw);
    const range = at(HUNT.fireRange, a), cone = at(HUNT.fireCone, a);
    for (const t of cars) {
      if (t === car || t.wrecked || sameTeam(t, car)) continue;
      const d = Math.hypot(t.x - car.x, t.z - car.z);
      if (d > range || d < FIRE_MIN) continue;
      const lead = d / shellSpeed;
      const dx = t.x + t.vx * lead - car.x, dz = t.z + t.vz * lead - car.z;
      const fwd = dx * s + dz * c;
      if (fwd <= 0) continue;
      const ang = Math.abs(Math.atan2(dx * -c + dz * s, fwd));
      if (ang > cone + 1.2 / d) continue;
      if (!car.shotReaches(t.x, t.y, t.z, 1.7)) continue; // tilted: the barrel points into the ground or over it
      if (!this.city.world.raycast(car.x, car.z, dx / Math.hypot(dx, dz), dz / Math.hypot(dx, dz), d, shotFilter)) return true;
    }
    return false;
  }

  /** Мясник стреляет по пешеходам: кто-то стоит по курсу, стена не мешает и рядом с ним нет машин. */
  _shouldFireAtPeds(peds, cars) {
    const car = this.car;
    const range = at(GORE.fireRange, this.def.gore);
    if (range < FIRE_MIN + 4) return false;
    const s = Math.sin(car.yaw), c = Math.cos(car.yaw);
    const hit = peds.raycast(car.x, car.z, s, c, range, true);
    if (!hit || hit.t < FIRE_MIN + 4) return false;
    const hx = car.x + s * hit.t, hz = car.z + c * hit.t;
    if (!car.shotReaches(hx, this.city.groundHeight(hx, hz), hz)) return false;
    for (const o of cars) {
      if (o !== car && !o.wrecked && Math.hypot(o.x - hx, o.z - hz) < GORE.clearance) return false;
    }
    return !this.city.world.raycast(car.x, car.z, s, c, hit.t, shotFilter);
  }

  /**
   * ИИ: решить, как рулить и стрелять в этом кадре.
   * ctx: { cars, peds, running, raceTime, playerProgress, myProgress, shellSpeed }
   */
  think(dt, ctx) {
    const car = this.car, inp = this.inp, race = this.race, def = this.def;
    inp.fire = false;
    inp.handbrake = false;
    if (!ctx.running || car.wrecked) {
      // гонка не идёт — тормозим до остановки (тормоз на месте включил бы задний ход)
      inp.throttle = 0;
      inp.brake = car.vF > 0.5 ? 1 : 0;
      inp.steer = 0;
      return inp;
    }

    const pr = race.project(car.x, car.z);
    const v = car.speed;
    const finished = this.tr.finished;
    let tx, tz, maxV;

    // битва: у стены или снаружи — не до охоты, сначала спастись
    const flee = this._unsafe(car.x, car.z, ZONE_SAFE.flee);
    if (flee) {
      this._dropHunt(2);
      if (this.mode === 'gore') this.mode = 'race';
      this.prey = null;
    } else {
      this._huntDecision(dt, ctx);
      if (this.mode !== 'hunt') this._goreDecision(dt, finished ? null : ctx.peds);
    }

    if (this.mode === 'hunt') {
      // погоня: напрямую с упреждением, а если цель за домами — по улицам
      const T = this.target;
      const d = Math.hypot(T.x - car.x, T.z - car.z) || 1;
      const lead = Math.min(1.2, d / ctx.shellSpeed);
      const lx = T.x + T.vx * lead, lz = T.z + T.vz * lead;
      if (this._clearLine(lx, lz)) {
        tx = lx;
        tz = lz;
      } else {
        const n = this._navPoint(T);
        tx = n.x;
        tz = n.z;
      }
      maxV = TOP_SPEED * def.speed;
    } else if (this.mode === 'gore') {
      // за пешеходом: прямо на него, если за углом — бросаем (выбор заново)
      const p = this.prey;
      tx = p.x;
      tz = p.z;
      maxV = TOP_SPEED * def.speed;
      if (!this._clearLine(tx, tz)) this.preyT += dt * 3;
    } else if (this.zone) {
      // королевская битва: трассы нет — катаемся внутри зоны
      const p = this._roam();
      tx = p.x;
      tz = p.z;
      maxV = TOP_SPEED * def.speed * (flee ? 1 : 0.8);
    } else {
      // гонка по трассе; гонщики «на резинке»: отставший прибавляет, убежавший сбрасывает
      if (this.role === 'racer') {
        const gap = ctx.playerProgress - ctx.myProgress;
        const boostT = gap > 1.5 ? 1.06 : gap < -1.5 ? 0.88 : 1;
        this.boost += (boostT - this.boost) * Math.min(1, dt * 0.5);
      } else this.boost = 0.92;
      maxV = TOP_SPEED * def.speed * this.boost * (finished ? 0.55 : 1);
      const p = race.pointAt(pr.s + 9 + v * 0.55, def.lane);
      tx = p.x;
      tz = p.z;
    }

    // руль: угол до цели
    const { ang } = this._bearing(tx, tz);
    let steer = clamp(ang * 2.2, -1, 1);

    // скорость: перед поворотами трассы тормозим заранее; в крутом развороте — медленно
    let target = maxV;
    if (this.mode === 'race' && !this.zone) {
      for (const cn of race.cornersAhead(pr.s, 2)) {
        if (cn.angle < 0.3) continue;
        const vc = def.corner * (1.5 - 0.5 * Math.min(1, cn.angle / (Math.PI / 2)));
        target = Math.min(target, Math.sqrt(vc * vc + 2 * 15 * Math.max(0, cn.dist - 5)));
      }
    }
    if (Math.abs(ang) > 0.6) target = Math.min(target, 10);
    let throttle = v < target - 0.5 ? 1 : 0;
    let brake = v > target + 1.5 ? 1 : 0;

    // застрял — сдать назад, крутя руль в обратную сторону; совсем застрял — на чекпоинт
    if (v < 1.5 && throttle > 0) this.stuckT += dt;
    else this.stuckT = Math.max(0, this.stuckT - dt * 2);
    if (this.stuckT > 1.4 && this.reverseT <= 0) {
      this.reverseT = rand(0.9, 1.4);
      if (this.mode === 'gore') this.preyT += 2; // упёрлись в стену за пешеходом — скоро бросим
    }
    if (this.reverseT > 0) {
      this.reverseT -= dt;
      throttle = 0;
      brake = 1;
      steer = -Math.sign(ang || 1);
      if (this.reverseT <= 0) this.stuckT = 0.6;
    }
    const a = this.stuckAt;
    if (!a || Math.hypot(car.x - a.x, car.z - a.z) > STUCK.near) this.stuckAt = { x: car.x, z: car.z, t: 0 };
    else if (!finished && !(this.mode === 'hunt' && Math.hypot(this.target.x - car.x, this.target.z - car.z) < STUCK.ram)) a.t += dt;
    if (this.stuckT > 5 || this.stuckAt.t > STUCK.time) this.respawn();
    // протаранил жертву — сдать назад, держа её в прицеле (задним ходом руль наоборот), и ударить снова
    this.chargeT -= dt;
    if (this.backT > 0) {
      this.backT -= dt;
      throttle = 0;
      brake = 1;
      steer = -clamp(ang * 2.2, -1, 1);
      if (this.mode !== 'hunt') this.backT = 0;
    }

    inp.throttle = throttle;
    inp.brake = brake;
    inp.steer = steer;
    // пушка бьёт только по курсу — стреляем, когда кто-то прямо перед носом
    this.fireCD -= dt;
    this.goreCD -= dt;
    if (car.reload <= 0 && this.reverseT <= 0) {
      if ((this.mode === 'hunt' || this.fireCD <= 0) && this._shouldFire(ctx.cars, ctx.shellSpeed)) {
        inp.fire = true;
        if (this.mode !== 'hunt') this.fireCD = rand(...at2(HUNT.firePause, def.aggr));
      } else if (this.goreCD <= 0 && ctx.peds && this._shouldFireAtPeds(ctx.peds, ctx.cars)) {
        inp.fire = true;
        this.goreCD = rand(...GORE.firePause);
      }
    }
    return inp;
  }

  /** Машина упёрлась в другую (зовётся из столкновений): если это жертва — отъехать для нового тарана. */
  onCarContact(other) {
    if (this.mode !== 'hunt' || other !== this.target || this.backT > 0 || this.chargeT > 0) return;
    this.backT = rand(...RAM.back);
    this.chargeT = this.backT + RAM.charge;
  }

  respawn() {
    const car = this.car;
    const z = this.zone;
    car.teleport(z ? roadPointNear(this.city, z.cx, z.cz, Math.max(12, z.radius * 0.6)) : this.race.respawnPoint(this.tr.lastCp, this.startPoint()));
    this.stuckT = 0;
    this.reverseT = 0;
    this.stuckAt = null;
    this.mode = 'race';
    this.target = null;
    this.prey = null;
  }
}

// ---------------------------------------------------------------- столкновения машин
const _c = { nx: 0, nz: 0, depth: 0, px: 0, pz: 0 };

/** Все пары машин; onHit(a, b, impact, px, pz, nx, nz) — n смотрит от b к a. */
export function collideCars(cars, onHit) {
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) collidePair(cars[i], cars[j], onHit);
  }
}

/** Чужие машины по сети (remote) не двигаем: их сдвинет и толкнёт их владелец, у себя — тем же ударом. */
function collidePair(A, B, onHit) {
  if (A.remote && B.remote) return;
  const ddx = B.x - A.x, ddz = B.z - A.z;
  if (ddx * ddx + ddz * ddz > 36) return;
  const sa = Math.sin(A.yaw), ca = Math.cos(A.yaw), sb = Math.sin(B.yaw), cb = Math.cos(B.yaw);
  let best = -1;
  for (const oa of HIT_Z) {
    const ax = A.x + sa * oa, az = A.z + ca * oa;
    for (const ob of HIT_Z) {
      const bx = B.x + sb * ob, bz = B.z + cb * ob;
      const dx = ax - bx, dz = az - bz;
      const d = Math.hypot(dx, dz);
      const depth = 2 * HIT_R - d;
      if (depth <= best) continue;
      best = depth;
      _c.nx = d > 1e-6 ? dx / d : 1;
      _c.nz = d > 1e-6 ? dz / d : 0;
      _c.depth = depth;
      _c.px = (ax + bx) / 2;
      _c.pz = (az + bz) / 2;
    }
  }
  if (best <= 0) return;
  const { nx, nz, depth, px, pz } = _c;
  // развести поровну (если одна чужая — своя отходит целиком)
  const wa = A.remote ? 0 : B.remote ? 1 : 0.5, wb = 1 - wa;
  A.x += nx * depth * wa;
  A.z += nz * depth * wa;
  B.x -= nx * depth * wb;
  B.z -= nz * depth * wb;

  const rAx = px - A.x, rAz = pz - A.z, rBx = px - B.x, rBz = pz - B.z;
  const vAx = A.vx + A.angVel * rAz, vAz = A.vz - A.angVel * rAx;
  const vBx = B.vx + B.angVel * rBz, vBz = B.vz - B.angVel * rBx;
  const vn = (vAx - vBx) * nx + (vAz - vBz) * nz;
  if (vn >= 0) return;
  const I = CAR_INERTIA;
  const rnA = rAz * nx - rAx * nz, rnB = rBz * nx - rBx * nz;
  const j = (-(1 + CAR_HIT.restitution) * vn) / (2 + (rnA * rnA) / I + (rnB * rnB) / I);
  const ka = A.remote ? 0 : 1, kb = B.remote ? 0 : 1;
  A.vx += j * nx * ka;
  A.vz += j * nz * ka;
  A.angVel += ((rnA * j) / I) * ka;
  B.vx -= j * nx * kb;
  B.vz -= j * nz * kb;
  B.angVel -= ((rnB * j) / I) * kb;
  // трение металла о металл
  const tx = -nz, tz = nx;
  const vt = (vAx - vBx) * tx + (vAz - vBz) * tz;
  const rtA = rAz * tx - rAx * tz, rtB = rBz * tx - rBx * tz;
  let jt = -vt / (2 + (rtA * rtA) / I + (rtB * rtB) / I);
  jt = clamp(jt, -0.4 * j, 0.4 * j);
  A.vx += jt * tx * ka;
  A.vz += jt * tz * ka;
  A.angVel += ((rtA * jt) / I) * ka;
  B.vx -= jt * tx * kb;
  B.vz -= jt * tz * kb;
  B.angVel -= ((rtB * jt) / I) * kb;
  if (onHit) onHit(A, B, -vn, px, pz, nx, nz);
}

/**
 * Урон машине от удара другой машиной (other): зависит от того, чем ударили и куда.
 * Таран лбом с кенгурятником в бок или зад — для тарана лоб и нужен, ему ничего; лоб в лоб — обоим немного.
 */
export function carHitDamage(car, other, impact, px, pz) {
  if (impact <= CAR_HIT.threshold) return 0;
  const zone = car.zoneAt(px, pz);
  if (zone === 'front' && car.frontArmored && other.zoneAt(px, pz) !== 'front') return 0;
  let k = CAR_HIT.zone[zone];
  if (zone === 'front' && !car.frontArmored) k *= 1.8; // без кенгурятника лоб мягче
  const dmg = (impact - CAR_HIT.threshold) * CAR_HIT.scale * k;
  return dmg > CAR_HIT.knee ? CAR_HIT.knee + (dmg - CAR_HIT.knee) * CAR_HIT.over : dmg;
}
