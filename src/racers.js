import { Car, sameTeam } from './car.js';
import { ST } from './pedestrians.js';
import { CarTag } from './tag.js';
import { ZONE, spotNear, freeSpotNear } from './zone.js';
import { VEH } from './physics/vehicle.js';
import { RACE } from './race.js';
import { PATH, projectOn, pointOn, joinPaths, polyline } from './nav/path.js';
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
// no way out (wedged between a tree and a building, a wreck against its side…): a bot that hasn't got more than `near`
// m away from one spot in `time` s is put on a free spot nearby (freeSpotNear), never at a gate. Ramming a target
// within `ram` m doesn't count
const STUCK = { near: 8, time: 20, ram: 15 };
/** Getting out of a trap by itself (NAV_PLAN session 1). */
const ESCAPE = {
  stuck: 1.4, // s pushing on at under 1.5 m/s before it backs up
  room: 1, // m free behind the tail to start by backing up (else forward)
  stop: 0.4, // m — a leg ends when the room that way is down to this (plus 0.25 s of the speed: room to stop)…
  leg: [0.4, 3], // s — … or after leg[1] s (but not before leg[0])…
  held: [1, 0.3], // … or when it has moved less than held[1] m in held[0] s…
  turned: 0.45, // rad — … or once the nose points this close to the way out: then it drives on
  side: 0.5, // m free beside the nose and the tail, the ways they'd swing, to turn the wheel during a leg — or less
  straight: 2, // than this free ahead (behind): no room to go straight first, it turns anyway
  legs: 6, // legs of a many-point turn at most
  look: 8, // m the casts look
  flip: 3, // stuck at the same spot this many times on one side: the other side
  probe: [7, 2.5], // m — a side is picked only if the floor this far along the obstacle and this far out is free
  trap: 10, // s its paths keep off the spot it got stuck at (PATH.trap, PATH.trapCost)
  again: 6, // m — stuck again this close to the last trap: try its other side
};
/** Driving a path (NAV_PLAN session 3). */
const DRIVE = {
  look: [7, 0.5], // m — the point steered at is look[0] + look[1] × speed (m/s) ahead along the path
  stray: 7, // m off the path: a new one
  replan: 0.4, // s at least between two searches of one bot
  moving: [3, 0.15], // a moving goal (a car, a pedestrian) that has moved moving[0] + moving[1] × its distance from where the path ends: a new path
  direct: 45, // m — a goal (not a gate) this close with a straight drivable strip to it: straight at it, no path
  recheck: 0.15, // s between looks at that strip (and at the line to the point steered at on a path)
  partial: 30, // m — a path that stops short of its goal (PATH.max) is searched again this far from its end
  decel: 15, // m/s² — braking before a corner of the path…
  margin: 5, // m — … to be down to the corner's speed this far before it
  ahead: 100, // m of path looked at for corners
  narrow: [1.5, 5, 0.35], // a corner with room (NavGrid.roomAt) narrow[1] m or more: its full speed; less — down to narrow[2] of it at narrow[0]
  sharp: [0.6, 1, 18, 10], // rad off the nose → m/s: steering sharp[0] rad off, at most sharp[2] m/s; sharp[1] and more — sharp[3]
};
/** Not driving into cars and wrecks, which the grid doesn't know (NAV_PLAN session 3). */
const AVOID = {
  look: [6, 1.1], // m ahead: look[0] + look[1] × speed (m/s)
  width: 3, // m — a car whose centre is this close to the line I'd drive, and `front` m or more ahead (not beside me), is in the way…
  front: 2,
  closing: 2, // m/s — … unless it's moving and I close in on it slower than this (it drives ahead of me); wrecks always
  turns: [0.25, 0.5, 0.8], // rad off the way to the goal tried, each side (the side taken last time first, for `keep` s)
  keep: 1,
  free: 10, // m of drivable floor the turned way needs
  behind: 1.2, // rad — steering for a point this far off the nose or more: it has to turn first, nothing to avoid yet
  crawl: 4, // m/s — no way past: down to the blocker's speed, but not below this (it nudges a wreck or a stuck car
  // aside, or gets stuck against it and turns out of it, rather than waiting behind it for good)
};
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

  /**
   * Battle royale: where to drive — a spot near the zone's middle (a new one once there), or, by the wall or outside,
   * the middle itself. { x, y, z }
   */
  _roam() {
    const car = this.car, z = this.zone;
    if (this._unsafe(car.x, car.z, ZONE_SAFE.flee)) {
      this.wp = null;
      return { x: z.cx, y: car.y, z: z.cz };
    }
    const wp = this.wp;
    if (!wp || Math.hypot(wp.x - car.x, wp.z - car.z) < 10 || Math.hypot(wp.x - z.cx, wp.z - z.cz) > z.radius * 0.75) {
      this.wp = spotNear(this.city.nav, z.cx, z.cz, Math.max(12, z.radius * 0.6));
    }
    return this.wp;
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
    this.esc = null; // getting out of a trap: { back, t, ox, oz, legs, x, z } — a leg (back or forward) of a turn to the way out, from (x, z)
    this.traps = []; // where it got stuck lately: { x, z, t } — its paths keep off them for t more s
    this.lastTrap = null; // the last one: { x, z, sx, sz, tries } — stuck there again: the same side, then the other
    this.path = null; // the path it drives (nav/path.js polyline + { kind, gx, gz, gate }), or null
    this.pathK = 0; // the leg of it the car is on…
    this.pathS = 0; // … and how far along it
    this.onPath = false; // steering along the path this frame (else straight at the goal)
    this.want = null; // the goal of the next search: { kind, x, y, z, gate }
    this.replan = false; // a new path wanted whatever the goal (after an escape)
    this.replanT = 0; // s before it may search again
    this.gi = 0; // the gate it drives to
    this.lookT = 0; // _pursue: s before it looks at the line to its look-ahead point again…
    this.lookK = 0; // … which of its three distances fits…
    this.inLane = false; // … and whether its lane does
    this.direct = false; // the goal is close and the way to it open: straight at it (looked at every DRIVE.recheck s)
    this.directT = 0;
    this.directKind = null;
    this.avSide = 0; // the side it went round a car on last (AVOID.keep s)
    this.avSideT = 0;
    this.teleports = 0;
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

  /** A building, a wall, a statue or a pump between the car and (x, z) hides it (seeing, not driving). */
  _sees(x, z) {
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
      if (sc >= bs || !this._sees(p.x, p.z)) continue;
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
    const car = this.car, inp = this.inp, def = this.def;
    this.cars = ctx.cars;
    inp.fire = false;
    inp.handbrake = false;
    if (!ctx.running || car.wrecked) {
      // гонка не идёт — тормозим до остановки (тормоз на месте включил бы задний ход)
      inp.throttle = 0;
      inp.brake = car.vF > 0.5 ? 1 : 0;
      inp.steer = 0;
      return inp;
    }

    const v = car.speed;
    const finished = this.tr.finished;
    let tx, tz, maxV;
    this.dt = dt;
    this.replanT -= dt;
    this.avSideT -= dt;
    for (const t of this.traps) t.t -= dt;
    if (this.traps.length && this.traps.some((t) => t.t <= 0)) this.traps = this.traps.filter((t) => t.t > 0);

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

    // where to: straight at the goal if it's close and the way is open, else along a path (_go)
    let p;
    if (this.mode === 'hunt') {
      // the target car, aimed at with a lead when going straight at it
      const T = this.target;
      const d = Math.hypot(T.x - car.x, T.z - car.z) || 1;
      const lead = Math.min(1.2, d / ctx.shellSpeed);
      p = this._go('hunt', T.x, T.y, T.z, v, true, null, T.x + T.vx * lead, T.z + T.vz * lead);
      maxV = TOP_SPEED * def.speed;
    } else if (this.mode === 'gore') {
      const q = this.prey;
      p = this._go('gore', q.x, q.y ?? car.y, q.z, v, true);
      maxV = TOP_SPEED * def.speed;
    } else if (this.zone) {
      // королевская битва: трассы нет — катаемся внутри зоны
      const q = this._roam();
      p = this._go('zone', q.x, q.y ?? car.y, q.z, v, false);
      maxV = TOP_SPEED * def.speed * (flee ? 1 : 0.8);
    } else {
      // гонка по трассе; гонщики «на резинке»: отставший прибавляет, убежавший сбрасывает
      if (this.role === 'racer') {
        const gap = ctx.playerProgress - ctx.myProgress;
        const boostT = gap > 1.5 ? 1.06 : gap < -1.5 ? 0.88 : 1;
        this.boost += (boostT - this.boost) * Math.min(1, dt * 0.5);
      } else this.boost = 0.92;
      maxV = TOP_SPEED * def.speed * this.boost * (finished ? 0.55 : 1);
      const g = this._raceGoal();
      p = this._go('race', g.x, g.y, g.z, v, false, g.gate);
    }
    tx = p.x;
    tz = p.z;

    // speed: slow down before the path's corners in time
    let target = this.onPath ? this._pathSpeed(maxV) : maxV;
    // cars and wrecks in the way (the grid doesn't know them): round them, or slow down behind
    const av = this.esc || this.backT > 0 ? null : this._avoidCars(tx, tz, v);
    if (av) {
      tx = av.x;
      tz = av.z;
      if (av.slow != null) {
        target = Math.min(target, av.slow);
        if (v < AVOID.crawl + 1) this.replan = true; // held up: a way round (a car standing still costs extra, PATH.still)
      }
    }

    // руль: угол до цели
    const { ang } = this._bearing(tx, tz);
    let steer = clamp(ang * 2.2, -1, 1);
    // facing away from where it steers: slow (DRIVE.sharp: 18 m/s at 0.6 rad off, down to 10 at 1 rad and more)
    const off = Math.abs(ang);
    if (off > DRIVE.sharp[0]) target = Math.min(target, lerp(DRIVE.sharp[2], DRIVE.sharp[3], clamp((off - DRIVE.sharp[0]) / (DRIVE.sharp[1] - DRIVE.sharp[0]), 0, 1)));
    let throttle = v < target - 0.5 ? 1 : 0;
    let brake = v > target + 1.5 ? 1 : 0;

    // stuck: turn out of it (_startEscape: back while there is room behind, forward when that runs out…), then a new
    // path that keeps off that spot for a while; no way out in STUCK.time s — a free spot nearby (respawn)
    if (v < 1.5 && throttle > 0 && !this.esc) this.stuckT += dt;
    else this.stuckT = Math.max(0, this.stuckT - dt * 2);
    if (this.stuckT > ESCAPE.stuck && !this.esc) {
      this._startEscape(tx, tz);
      if (this.mode === 'gore') this.preyT += 2; // упёрлись в стену за пешеходом — скоро бросим
    }
    const e = this.esc;
    if (e) {
      // a leg of a many-point turn: back (the wheel turned the other way swings the nose the same way) or forward,
      // until the nose points the way out, the room that way runs out or time is up; blocked — the other way
      e.t += dt;
      const o = this._bearing(car.x + e.ox, car.z + e.oz).ang; // the way out, from the nose
      throttle = e.back ? 0 : 1;
      brake = e.back ? 1 : 0;
      const room = this._roomAlong(e.back ? -1 : 1);
      // no room for the ends to swing (cars or a wall along its sides) but room that way: straight out first
      const straight = room > ESCAPE.straight && !this._canSwing(Math.sign(o) || 1);
      steer = straight ? 0 : (e.back ? -1 : 1) * clamp(o * 3, -1, 1);
      if (e.t > ESCAPE.leg[0]) {
        // blocked that way: by the cast, or it just doesn't move (held by something the cast doesn't see)
        const held = e.t > ESCAPE.held[0] && Math.hypot(car.x - e.x, car.z - e.z) < ESCAPE.held[1];
        if (Math.abs(o) < ESCAPE.turned || e.t > ESCAPE.leg[1]) this._endEscape();
        else if (held || room < ESCAPE.stop + v * 0.25) {
          if (++e.legs > ESCAPE.legs) this._endEscape();
          else Object.assign(e, { back: !e.back, t: 0, x: car.x, z: car.z });
        }
      }
    }
    this.reverseT = this.esc?.back ? ESCAPE.leg[1] - this.esc.t : 0; // backing up (tests count these)
    const a = this.stuckAt;
    if (!a || Math.hypot(car.x - a.x, car.z - a.z) > STUCK.near) this.stuckAt = { x: car.x, z: car.z, t: 0 };
    else if (!finished && !(this.mode === 'hunt' && Math.hypot(this.target.x - car.x, this.target.z - car.z) < STUCK.ram)) a.t += dt;
    if (this.stuckAt.t > STUCK.time) this.respawn();
    // протаранил жертву — сдать назад, держа её в прицеле (задним ходом руль наоборот), и ударить снова
    this.chargeT -= dt;
    if (this.backT > 0 && !this.esc) {
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
    if (car.reload <= 0 && !this.esc) {
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

  /**
   * Free room, m (up to ESCAPE.look), for one end of the car's lower body (end 1 — the nose's 1.2 m, −1 — the tail's)
   * moving along the unit (dx, dz), lengthwise or sideways: raised over curbs; just that end, as the whole body would
   * stop at once on whatever its other end is wedged against; and a little narrower across the way it moves, as a box
   * touching a wall it slides along would stop at once too.
   */
  _room(end, dx, dz, sideways = false) {
    const car = this.car, L = VEH.lower, hz = sideways ? 0.45 : 0.6, hx = L.half[0] - (sideways ? 0.05 : 0.2);
    const s = Math.sin(car.yaw), c = Math.cos(car.yaw), off = (L.half[2] - 0.2 - hz) * end;
    return car.rb.phys.castBox(car.x + s * off, car.y + L.at[1] + 0.12, car.z + c * off, car.yaw, hx, L.half[1] - 0.1, hz + (sideways ? 0 : 0.2),
      dx, dz, ESCAPE.look, car.rb.body);
  }

  /** Free room ahead of the nose (way 1) or behind the tail (−1), m. */
  _roomAlong(way) {
    const car = this.car;
    return this._room(way, Math.sin(car.yaw) * way, Math.cos(car.yaw) * way);
  }

  /** Room for the nose to swing to the right (side 1) or the left (−1) — and so the tail the other way. */
  _canSwing(side) {
    const car = this.car, rx = -Math.cos(car.yaw) * side, rz = Math.sin(car.yaw) * side;
    return this._room(1, rx, rz, true) > ESCAPE.side && this._room(-1, -rx, -rz, true) > ESCAPE.side;
  }

  /**
   * Stuck pushing on towards (tx, tz): find what it hit (the walls it touches, cars against it; nothing — straight
   * ahead), pick the side to get past it (towards the target and not into a building; stuck at the same spot again
   * and again — the other side every ESCAPE.flip tries) and turn towards there: back first if there's room behind.
   * The spot is a trap for ESCAPE.trap s: the new path keeps off it.
   */
  _startEscape(tx, tz) {
    const car = this.car;
    const s = Math.sin(car.yaw), c = Math.cos(car.yaw);
    const w = car.rb.wallNormal();
    let nx = w ? w.x : 0, nz = w ? w.z : 0;
    for (const o of this.cars ?? []) {
      if (o === car) continue;
      const dx = car.x - o.x, dz = car.z - o.z, d = Math.hypot(dx, dz);
      if (d > 0.1 && d < 5.5) {
        nx += (dx / d) * (5.5 - d) / 2;
        nz += (dz / d) * (5.5 - d) / 2;
      }
    }
    let l = Math.hypot(nx, nz);
    if (l < 1e-3) [nx, nz, l] = [-s, -c, 1];
    nx /= l;
    nz /= l;
    // the trap: on the obstacle's side of the car
    const px = car.x - nx * 2, pz = car.z - nz * 2;
    const last = this.lastTrap;
    const old = last && Math.hypot(last.x - px, last.z - pz) < ESCAPE.again ? last : null;
    const tries = old ? old.tries + 1 : 0;
    let best = null, bs = -Infinity;
    for (const k of [1, -1]) {
      const sx = -nz * k, sz = nx * k; // along the obstacle, one way or the other
      const ax = px + sx * ESCAPE.probe[0] + nx * ESCAPE.probe[1], az = pz + sz * ESCAPE.probe[0] + nz * ESCAPE.probe[1];
      let sc = sx * (tx - car.x) + sz * (tz - car.z);
      if (!this.city.nav.isFree(ax, car.y, az)) sc -= 1000;
      // the side tried last time: kept for a few tries, then the other one
      if (old && old.sx * sx + old.sz * sz > 0) sc += tries % ESCAPE.flip ? 2000 : -2000;
      if (sc > bs) {
        bs = sc;
        best = { sx, sz };
      }
    }
    this.lastTrap = { x: px, z: pz, sx: best.sx, sz: best.sz, tries };
    // ramming a target close by is not a trap
    if (!(this.mode === 'hunt' && Math.hypot(this.target.x - car.x, this.target.z - car.z) < STUCK.ram)) {
      const near = this.traps.find((t) => Math.hypot(t.x - px, t.z - pz) < ESCAPE.again);
      if (near) near.t = ESCAPE.trap;
      else this.traps.push({ x: px, z: pz, t: ESCAPE.trap });
      this.replan = true;
    }
    // the way out: along the obstacle and away from it
    let ox = best.sx + nx * 0.8, oz = best.sz + nz * 0.8;
    l = Math.hypot(ox, oz);
    ox /= l;
    oz /= l;
    const o = this._bearing(car.x + ox, car.z + oz).ang;
    const back = Math.abs(o) > ESCAPE.turned && this._roomAlong(-1) >= ESCAPE.room;
    this.esc = { back, t: 0, ox, oz, legs: 0, x: car.x, z: car.z };
  }

  _endEscape() {
    this.esc = null;
    this.stuckT = 0.6; // still stuck — the next try comes sooner
    this.replan = true; // from where it got to, keeping off the trap
  }

  // ------------------------------------------------------------------ paths (NAV_PLAN session 3)

  /**
   * Where to steer for the goal (gx, gy, gz) of this kind ('race', 'hunt', 'gore', 'zone'): a point along the path to
   * it, asking for a new path when there's none, the goal has moved (moving: by DRIVE.moving, else by 1 m), the gate
   * changed or the car has left it (searched in Game's frame budget: meanwhile the old path or a straight line). A goal
   * that isn't a gate, within DRIVE.direct with a straight drivable strip to it: straight at (dx, dz) — the target car
   * with a lead, the pedestrian. { x, z }
   */
  _go(kind, gx, gy, gz, v, moving, gate = null, dx = gx, dz = gz) {
    const car = this.car, paths = this.city.paths;
    this.onPath = false;
    // (looked at every DRIVE.recheck s: a long line costs a hundred floor lookups)
    this.directT -= this.dt;
    if (this.directT <= 0 || this.directKind !== kind) {
      this.directT = DRIVE.recheck;
      this.directKind = kind;
      this.direct = kind !== 'race' && Math.hypot(dx - car.x, dz - car.z) < DRIVE.direct && paths.lineFree(car.x, car.y, car.z, dx, dz, PATH.narrow, 1.5);
    }
    if (this.direct) return { x: dx, z: dz };
    let P = this.path;
    // a gate passed: the path already goes on to the next one — keep driving it, with the leg after that added
    if (P && kind === 'race' && gate != null && P.gate === (gate + this.race.cps.length - 1) % this.race.cps.length && !this.replan) {
      const k = Math.min(this.pathK + 1, P.x.length - 1);
      const rest = polyline([car.x, ...P.x.slice(k)], [car.y, ...P.y.slice(k)], [car.z, ...P.z.slice(k)]);
      const g = this.race.cps[gate];
      P = this.path = Object.assign(joinPaths(rest, this._gateLeg(paths, gate)), { kind, gx: g.x, gz: g.z, gate });
      this.pathK = 0;
      this.lookT = 0;
    }
    let need = this.replan || !P || P.kind !== kind || P.gate !== gate;
    if (!need) {
      const tol = moving ? DRIVE.moving[0] + DRIVE.moving[1] * Math.hypot(gx - car.x, gz - car.z) : 1;
      need = Math.hypot(P.gx - gx, P.gz - gz) > tol;
    }
    const q = P ? this._pursue(v, kind === 'race') : null;
    if (!q || (P.partial && P.length - this.pathS < DRIVE.partial)) need = true;
    if (need && this.replanT <= 0) {
      this.want = { kind, x: gx, y: gy, z: gz, gate };
      paths.ask(this);
    }
    if (!q) return { x: dx, z: dz };
    this.onPath = true;
    return q;
  }

  /** The search (NavPaths.run calls it): a path from the car to `want`, then on to the next gate in a race. */
  _plan(paths) {
    const w = this.want, car = this.car;
    this.replanT = DRIVE.replan;
    this.replan = false;
    if (!w || car.wrecked) return;
    const a = paths.floorAt(car.x, car.y, car.z, 6, car.yaw);
    const b = paths.floorAt(w.x, w.y, w.z, 10);
    // the same fixed goal (a gate, a waypoint) as the path it drives: keep to that way unless another is clearly better
    // (not for a car or a pedestrian: the old way leads to where they were)
    const old = this.path, same = old?.cells && old.kind === w.kind && (w.kind === 'race' || w.kind === 'zone') && Math.hypot(old.gx - w.x, old.gz - w.z) < 1;
    const cells = paths.find(a, b, {
      traps: this.traps.length ? this.traps : null, gore: this.def.gore, car: { x: car.x, z: car.z, yaw: car.yaw, v: car.vF }, prefer: same ? old.cells : null,
    });
    if (!cells) {
      this.path = null;
      return;
    }
    let P = paths.smooth(cells, car.x, car.y, car.z);
    // past the gate the way goes on to the next one: the corner after the gate is braked for in time
    if (w.gate != null) P = joinPaths(P, this._gateLeg(paths, w.gate));
    // (a search that stopped short leads towards the goal: searched again near its end)
    this.path = Object.assign(P, { kind: w.kind, gx: w.x, gz: w.z, gate: w.gate, partial: paths.capped, cells });
    this.pathK = 0;
    this.pathS = 0;
    this.lookT = 0;
  }

  /** The way from gate gi to the next one (found once per map, without wrecks). */
  _gateLeg(paths, gi) {
    const cps = this.race.cps, A = cps[gi], B = cps[(gi + 1) % cps.length];
    const key = `${A.x},${A.z}>${B.x},${B.z}`;
    let leg = paths.cache.get(key);
    if (!leg) {
      const cells = paths.find(paths.floorAt(A.x, 0, A.z, 10), paths.floorAt(B.x, 0, B.z, 10), { wrecks: false });
      leg = cells ? paths.smooth(cells) : polyline([A.x], [0], [A.z]);
      paths.cache.set(key, leg);
    }
    return leg;
  }

  /** The gate to drive to: the next one; after the finish, round the course again. { x, y, z, gate } */
  _raceGoal() {
    const cps = this.race.cps, car = this.car;
    if (!this.tr.finished) this.gi = this.tr.next;
    else if (Math.hypot(cps[this.gi].x - car.x, cps[this.gi].z - car.z) < RACE.radius) this.gi = (this.gi + 1) % cps.length;
    const cp = cps[this.gi];
    return { x: cp.x, y: 0, z: cp.z, gate: this.gi };
  }

  /**
   * The point to steer at on the path: DRIVE.look ahead of the car's place on it, nearer if the straight line to it
   * isn't drivable (it would cut a corner through a wall), shifted by the bot's lane in a race where there's room.
   * null — the car is off the path by more than DRIVE.stray.
   */
  _pursue(v, lane) {
    const P = this.path, car = this.car, paths = this.city.paths;
    const pr = projectOn(P, car.x, car.z, this.pathK);
    if (pr.d > DRIVE.stray) return null;
    this.pathK = pr.k;
    this.pathS = pr.s;
    const look = DRIVE.look[0] + DRIVE.look[1] * v, vs = P.s[Math.min(pr.k + 1, P.s.length - 1)] - pr.s;
    const L = lane ? this.def.lane : 0;
    // which look-ahead (and whether the lane fits) is looked at every DRIVE.recheck s, kept in between
    this.lookT -= this.dt;
    if (this.lookT > 0) {
      const q = pointOn(P, pr.s + (this.lookK === 2 ? Math.min(look * 0.6, Math.max(2, vs)) : look * (this.lookK ? 0.6 : 1)));
      return this.inLane && L ? { x: q.x - q.dz * L, z: q.z + q.dx * L } : q;
    }
    this.lookT = DRIVE.recheck;
    let q = null;
    for (this.lookK = 0; this.lookK < 3; this.lookK++) {
      q = pointOn(P, pr.s + (this.lookK === 2 ? Math.min(look * 0.6, Math.max(2, vs)) : look * (this.lookK ? 0.6 : 1)));
      if (paths.lineFree(car.x, car.y, car.z, q.x, q.z, PATH.narrow, 1.5)) break;
    }
    this.lookK = Math.min(this.lookK, 2);
    this.inLane = false;
    if (L) {
      const lx = q.x - q.dz * L, lz = q.z + q.dx * L;
      if (paths.lineFree(car.x, car.y, car.z, lx, lz, PATH.narrow, 1.5)) {
        this.inLane = true;
        return { x: lx, z: lz };
      }
    }
    return q;
  }

  /**
   * The top speed (≤ maxV) that brakes in time for every corner of the path within DRIVE.ahead; slower where the corner
   * is narrow (DRIVE.narrow: less room to swing wide).
   */
  _pathSpeed(maxV) {
    const P = this.path, corner = this.def.corner, nav = this.city.nav, N = DRIVE.narrow;
    let target = maxV;
    for (const cn of P.corners) {
      const dist = cn.s - this.pathS;
      if (dist < -3) continue;
      if (dist > DRIVE.ahead) break;
      // def.corner is the speed for 90°; the radius a turn of the same chord allows grows as 1 / sin(angle / 2)
      if (cn.room == null) {
        const i = nav.cellAt(P.x[cn.k], P.y[cn.k] + 0.5, P.z[cn.k]);
        cn.room = i >= 0 ? nav.roomAt(i) : N[1];
      }
      const vc = corner * Math.sqrt(Math.SQRT1_2 / Math.sin(Math.min(cn.angle, Math.PI) / 2)) * clamp((cn.room - N[0]) / (N[1] - N[0]), N[2], 1);
      target = Math.min(target, Math.sqrt(vc * vc + 2 * DRIVE.decel * Math.max(0, dist - DRIVE.margin)));
    }
    return target;
  }

  /**
   * A car or a wreck in the way to (tx, tz) (within AVOID.look, not a car I'm hunting, not one driving ahead of me as
   * fast): the nearest heading off that way, AVOID.turns each side, that is clear of cars and has AVOID.free m of
   * drivable floor → { x, z } a point that way; none — { x: tx, z: tz, slow } (slow down to the blocker's speed, but
   * not below AVOID.crawl).
   * null — nothing in the way.
   */
  _avoidCars(tx, tz, v) {
    const car = this.car, look = AVOID.look[0] + AVOID.look[1] * v;
    if (Math.abs(this._bearing(tx, tz).ang) > AVOID.behind) return null;
    const near = (this._near ??= []);
    near.length = 0;
    for (const o of this.cars ?? []) {
      if (o === car || (this.mode === 'hunt' && o === this.target)) continue;
      const dx = o.x - car.x, dz = o.z - car.z;
      if (dx * dx + dz * dz < (look + 3) ** 2 && Math.abs(o.y - car.y) < 3) near.push(o);
    }
    if (!near.length) return null;
    const blocker = (h) => {
      const hx = Math.sin(h), hz = Math.cos(h);
      for (const o of near) {
        const ox = o.x - car.x, oz = o.z - car.z, along = ox * hx + oz * hz;
        if (along < AVOID.front || along > look || Math.abs(ox * hz - oz * hx) > AVOID.width) continue;
        if (!o.wrecked && v - (o.vx * hx + o.vz * hz) < AVOID.closing) continue;
        return o;
      }
      return null;
    };
    const a0 = Math.atan2(tx - car.x, tz - car.z);
    const o = blocker(a0);
    if (!o) return null;
    // a heading a0 − side × turn: side 1 — to the right; first away from the blocker (or the side taken just before)
    const right = (o.x - car.x) * -Math.cos(a0) + (o.z - car.z) * Math.sin(a0) > 0;
    const first = this.avSideT > 0 ? this.avSide : right ? -1 : 1;
    for (const turn of AVOID.turns) {
      for (const side of [first, -first]) {
        const h = a0 - side * turn;
        if (blocker(h)) continue;
        const hx = Math.sin(h), hz = Math.cos(h);
        if (!this.city.paths.lineFree(car.x, car.y, car.z, car.x + hx * AVOID.free, car.z + hz * AVOID.free, PATH.narrow, 1.5)) continue;
        this.avSide = side;
        this.avSideT = AVOID.keep;
        return { x: car.x + hx * 12, z: car.z + hz * 12 };
      }
    }
    return { x: tx, z: tz, slow: Math.max(AVOID.crawl, o.vx * Math.sin(a0) + o.vz * Math.cos(a0)) };
  }

  /** (x, z) is in human car h's view: ahead of it (or close), not far, not behind a building. */
  _inView(h, x, z) {
    const dx = x - h.x, dz = z - h.z, d = Math.hypot(dx, dz);
    if (d > 90) return false;
    if (d > 15 && (dx * Math.sin(h.yaw) + dz * Math.cos(h.yaw)) / d < 0.5) return false;
    return !this.city.world.raycast(h.x, h.z, dx / d, dz / d, d, losFilter);
  }

  /**
   * No way out (STUCK): put the car on the nearest free nav floor (freeSpotNear) — out of the humans'
   * view if it can, inside the zone in a battle, not past the next gate in a race — 2 m above the floor, heading along
   * the floor's way, the way it was going. Never at a gate.
   */
  respawn() {
    const car = this.car, z = this.zone, race = this.race, cars = this.cars ?? [];
    const humans = cars.filter((c) => c.human && c !== car && !c.wrecked);
    const racing = !z && race.enabled && !this.tr.finished;
    // along the course to the next gate, m: a spot past it (or about to be) would miss it, one far back loses the place
    const gateS = racing ? race.cps[this.autopilot ? race.next : this.tr.next].s : 0, L = race.length;
    const toGate = (px, pz) => (((gateS - race.project(px, pz).s) % L) + L) % L;
    const mine = racing ? toGate(car.x, car.z) : 0;
    const cost = (px, pz) => {
      let k = 0;
      if (z && z.unsafe(px, pz, ZONE_SAFE.ahead, ZONE_SAFE.margin)) k += 200;
      for (const h of humans) if (this._inView(h, px, pz)) k += 25;
      if (racing) {
        const g = toGate(px, pz);
        if (g < 6 || g > mine + 60) return Infinity;
        k += race.project(px, pz).dist * 0.5; // on the course rather than a side street
      }
      return k;
    };
    const dir = (px, pz) => {
      if (racing) {
        const pr = race.project(px, pz);
        return { x: pr.dx, z: pr.dz };
      }
      if (z) return { x: z.cx - px, z: z.cz - pz };
      return { x: Math.sin(car.yaw), z: Math.cos(car.yaw) };
    };
    const nav = this.city.nav;
    const sp = freeSpotNear(nav, car.x, car.y, car.z, { cars, self: car, cost, dir }) ?? spotNear(nav, car.x, car.z, 80);
    car.teleport(sp);
    this.teleports++;
    this.stuckT = 0;
    this.reverseT = 0;
    this.stuckAt = null;
    this.esc = null;
    this.traps = [];
    this.lastTrap = null;
    this.path = null;
    this.mode = 'race';
    this.target = null;
    this.prey = null;
  }
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
