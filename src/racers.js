import * as THREE from 'three';
import { Car, HIT_Z, HIT_R, CAR_INERTIA } from './car.js';
import { clamp, rand } from './utils.js';

/**
 * Соперники. role: 'racer' — гонщик, хочет прийти первым и стреляет, только если кто-то прямо по курсу;
 * 'hunter' — охотник, гоняется за ближайшей машиной (игроком или другим ботом), таранит и стреляет.
 * speed — доля от максималки игрока, corner — скорость в повороте 90°, м/с; lane — полоса (вправо +).
 */
export const RIVALS = [
  { name: 'МОЛНИЯ', color: '#1f5fe0', number: 7, role: 'racer', speed: 0.9, corner: 12, lane: 2.2 },
  { name: 'РАКЕТА', color: '#8e2fd0', number: 21, role: 'racer', speed: 0.87, corner: 11.5, lane: -2.2 },
  { name: 'МЯСНИК', color: '#1f9e45', number: 13, role: 'hunter', speed: 0.9, corner: 11, lane: 0 },
  { name: 'БУЛЬДОЗЕР', color: '#e8b10c', number: 66, role: 'hunter', speed: 0.85, corner: 10.5, lane: 0 },
];

/** Стартовая решётка: [вбок, вперёд] от точки старта игрока, по направлению движения. */
const GRID = [
  [0, 7.5], // первый ряд, прямо перед игроком
  [-7, 7.5], // первый ряд, соседняя полоса
  [-7, 0], // рядом с игроком
  [0, -7.5], // позади игрока
];

const HUNT_DELAY = 10; // с после старта охотники ещё едут по трассе — без свалки на старте
const HUNT_RANGE = 170; // дальше охотник цель не видит
// кого охотник выбирает охотнее: расстояние до цели умножается на вес (меньше — желаннее)
const PREY_WEIGHT = { player: 0.6, hunter: 0.8, racer: 1.7 };
const FIRE_RANGE = { racer: 45, hunter: 80 };
const FIRE_MIN = 8; // в упор не стреляют
const RACER_FIRE_PAUSE = [2.5, 5]; // гонщик между выстрелами отвлекается на дорогу, с
const FIRE_CONE = { racer: 0.05, hunter: 0.09 }; // насколько точно нос должен смотреть на цель, рад
const losFilter = (c) => c.kind === 'building' || c.kind === 'wall' || c.kind === 'statue' || c.kind === 'pump';
const shotFilter = (c) => c.kind !== 'breakable' && c.h >= 1.2;

/** Удар машины о машину: лоб крепкий, бок и зад — слабые места. */
export const CAR_HIT = {
  threshold: 4.5, // м/с встречной скорости, ниже — без урона
  scale: 2.4,
  zone: { front: 0.3, side: 1.25, rear: 1.0 },
  restitution: 0.3,
};

const TOP_SPEED = 35; // ≈ максималка игрока, м/с

function tagTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Соперник: машина + ИИ-водитель + табличка над крышей. */
export class Rival {
  constructor(scene, city, fx, audio, debris, quality, race, def, index) {
    this.def = def;
    this.index = index;
    this.race = race;
    this.city = city;
    this.car = new Car(scene, city, fx, audio, debris, quality, {
      color: def.color, wing: true, isPlayer: false, number: def.number, name: def.name, wallDamage: 0.5,
    });
    this.car.role = def.role;
    this.inp = { throttle: 0, brake: 0, steer: 0, handbrake: false, fire: false };
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tagTexture(), transparent: true, depthWrite: false }));
    this.tag.scale.set(4.4, 1.1, 1);
    this.tag.renderOrder = 6;
    scene.add(this.tag);
    this._tagHp = -1;
    this.reset();
  }

  get role() {
    return this.def.role;
  }

  get name() {
    return this.def.name;
  }

  get color() {
    return this.def.color;
  }

  startPoint() {
    const sp = this.city.spawn;
    const [side, ahead] = GRID[this.index % GRID.length];
    const fx = Math.sin(sp.yaw), fz = Math.cos(sp.yaw);
    const rx = -Math.cos(sp.yaw), rz = Math.sin(sp.yaw); // вправо
    return { x: sp.x + fx * ahead + rx * side, z: sp.z + fz * ahead + rz * side, yaw: sp.yaw };
  }

  reset() {
    this.car.reset(this.startPoint());
    this.tr = this.race.newTracker();
    this.stuckT = 0;
    this.reverseT = 0;
    this.boost = 1;
    this.target = null;
    this.retarget = 0;
    this.fireCD = rand(...RACER_FIRE_PAUSE);
    this.out = false; // разбит — выбыл
    this._drawTag();
  }

  _drawTag() {
    const tex = this.tag.material.map;
    const g = tex.image.getContext('2d');
    const hp = Math.max(0, Math.round(this.car.health));
    g.clearRect(0, 0, 256, 64);
    g.font = 'bold 26px "Russo One", "Arial Black", sans-serif';
    g.textAlign = 'center';
    g.lineWidth = 5;
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.fillStyle = this.car.wrecked ? '#9a9a9a' : this.def.color;
    const label = this.car.wrecked ? `${this.def.name} — СХОД` : this.def.name;
    g.strokeText(label, 128, 28);
    g.fillStyle = this.car.wrecked ? '#cccccc' : '#ffffff';
    g.fillText(label, 128, 28);
    if (!this.car.wrecked) {
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(48, 40, 160, 14);
      g.fillStyle = hp > 60 ? '#5fd35f' : hp > 30 ? '#f5b82e' : '#ff3b30';
      g.fillRect(50, 42, 156 * (hp / 100), 10);
    }
    tex.needsUpdate = true;
    this._tagHp = hp;
  }

  updateTag(player) {
    const c = this.car;
    this.tag.position.set(c.x, c.y + 3.1 + c.hop, c.z);
    const d = Math.hypot(c.x - player.x, c.z - player.z);
    this.tag.visible = d < 110;
    if (Math.round(c.health) !== this._tagHp || (c.wrecked && this._tagHp !== 0)) this._drawTag();
  }

  /** Цель охотника: ближайшая с учётом предпочтений; текущую держим, пока она не сильно хуже новой. */
  _pickTarget(cars) {
    const car = this.car;
    const score = (c) => {
      const d = Math.hypot(c.x - car.x, c.z - car.z);
      if (d > HUNT_RANGE) return Infinity;
      return d * (c.isPlayer ? PREY_WEIGHT.player : PREY_WEIGHT[c.role] || 1);
    };
    let best = null, bs = Infinity;
    for (const c of cars) {
      if (c === car || c.wrecked) continue;
      const sc = score(c);
      if (sc < bs) {
        bs = sc;
        best = c;
      }
    }
    const cur = this.target;
    if (cur && !cur.wrecked && best && cur !== best && score(cur) < bs * 1.35) return cur;
    return best;
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

  /** Стоит ли стрелять: кто-то почти точно по курсу, в досягаемости и не за стеной. */
  _shouldFire(cars, shellSpeed) {
    const car = this.car, role = this.def.role;
    const s = Math.sin(car.yaw), c = Math.cos(car.yaw);
    for (const t of cars) {
      if (t === car || t.wrecked) continue;
      const d = Math.hypot(t.x - car.x, t.z - car.z);
      if (d > FIRE_RANGE[role] || d < FIRE_MIN) continue;
      const lead = d / shellSpeed;
      const dx = t.x + t.vx * lead - car.x, dz = t.z + t.vz * lead - car.z;
      const fwd = dx * s + dz * c;
      if (fwd <= 0) continue;
      const ang = Math.abs(Math.atan2(dx * -c + dz * s, fwd));
      if (ang > FIRE_CONE[role] + 1.2 / d) continue;
      if (!this.race.city.world.raycast(car.x, car.z, dx / Math.hypot(dx, dz), dz / Math.hypot(dx, dz), d, shotFilter)) return true;
    }
    return false;
  }

  /**
   * ИИ: решить, как рулить и стрелять в этом кадре.
   * ctx: { cars, running, raceTime, playerProgress, myProgress, shellSpeed }
   */
  think(dt, ctx) {
    const car = this.car, inp = this.inp, race = this.race, def = this.def;
    inp.fire = false;
    inp.handbrake = false;
    if (!ctx.running || car.wrecked) {
      inp.throttle = 0;
      inp.brake = 0;
      inp.steer = 0;
      return inp;
    }

    const pr = race.project(car.x, car.z);
    const v = car.speed;
    const finished = this.tr.finished;
    let tx, tz, maxV;
    let chasing = false;

    // охотник выбирает цель
    if (def.role === 'hunter' && ctx.raceTime > HUNT_DELAY) {
      this.retarget -= dt;
      if (this.retarget <= 0 || !this.target || this.target.wrecked) {
        this.retarget = 1.5;
        this.target = this._pickTarget(ctx.cars);
      }
    } else this.target = null;

    if (this.target) {
      // погоня: напрямую с упреждением, а если цель за домами — по улицам
      const T = this.target;
      const d = Math.hypot(T.x - car.x, T.z - car.z) || 1;
      const lead = Math.min(1.2, d / ctx.shellSpeed);
      const lx = T.x + T.vx * lead, lz = T.z + T.vz * lead;
      const ld = Math.hypot(lx - car.x, lz - car.z) || 1;
      const blocked = this.city.world.raycast(car.x, car.z, (lx - car.x) / ld, (lz - car.z) / ld, ld, losFilter);
      if (!blocked) {
        tx = lx;
        tz = lz;
      } else {
        const n = this._navPoint(T);
        tx = n.x;
        tz = n.z;
      }
      maxV = TOP_SPEED * def.speed;
      chasing = true;
    } else {
      // гонка по трассе; гонщики «на резинке»: отставший прибавляет, убежавший сбрасывает
      if (def.role === 'racer') {
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
    const s = Math.sin(car.yaw), c = Math.cos(car.yaw);
    const dx = tx - car.x, dz = tz - car.z;
    const fwd = dx * s + dz * c, right = dx * -c + dz * s;
    const ang = Math.atan2(right, fwd);
    let steer = clamp(ang * 2.2, -1, 1);

    // скорость: перед поворотами трассы тормозим заранее; в крутом развороте — медленно
    let target = maxV;
    if (!chasing) {
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
    if (this.stuckT > 1.4 && this.reverseT <= 0) this.reverseT = rand(0.9, 1.4);
    if (this.reverseT > 0) {
      this.reverseT -= dt;
      throttle = 0;
      brake = 1;
      steer = -Math.sign(ang || 1);
      if (this.reverseT <= 0) this.stuckT = 0.6;
    }
    if (this.stuckT > 5) this.respawn();

    inp.throttle = throttle;
    inp.brake = brake;
    inp.steer = steer;
    // пушка бьёт только по курсу — стреляем, когда кто-то прямо перед носом
    this.fireCD -= dt;
    const canFire = def.role === 'hunter' ? this.target != null : this.fireCD <= 0;
    if (canFire && car.reload <= 0 && this.reverseT <= 0) {
      inp.fire = this._shouldFire(ctx.cars, ctx.shellSpeed);
      if (inp.fire && def.role === 'racer') this.fireCD = rand(...RACER_FIRE_PAUSE);
    }
    return inp;
  }

  respawn() {
    const car = this.car;
    const sp = this.race.respawnPoint(this.tr.lastCp, this.startPoint());
    car.x = sp.x;
    car.z = sp.z;
    car.yaw = sp.yaw;
    car.vx = car.vz = car.angVel = 0;
    this.stuckT = 0;
    this.reverseT = 0;
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

function collidePair(A, B, onHit) {
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
  // развести поровну
  A.x += nx * depth * 0.5;
  A.z += nz * depth * 0.5;
  B.x -= nx * depth * 0.5;
  B.z -= nz * depth * 0.5;

  const rAx = px - A.x, rAz = pz - A.z, rBx = px - B.x, rBz = pz - B.z;
  const vAx = A.vx + A.angVel * rAz, vAz = A.vz - A.angVel * rAx;
  const vBx = B.vx + B.angVel * rBz, vBz = B.vz - B.angVel * rBx;
  const vn = (vAx - vBx) * nx + (vAz - vBz) * nz;
  if (vn >= 0) return;
  const I = CAR_INERTIA;
  const rnA = rAz * nx - rAx * nz, rnB = rBz * nx - rBx * nz;
  const j = (-(1 + CAR_HIT.restitution) * vn) / (2 + (rnA * rnA) / I + (rnB * rnB) / I);
  A.vx += j * nx;
  A.vz += j * nz;
  A.angVel += (rnA * j) / I;
  B.vx -= j * nx;
  B.vz -= j * nz;
  B.angVel -= (rnB * j) / I;
  // трение металла о металл
  const tx = -nz, tz = nx;
  const vt = (vAx - vBx) * tx + (vAz - vBz) * tz;
  const rtA = rAz * tx - rAx * tz, rtB = rBz * tx - rBx * tz;
  let jt = -vt / (2 + (rtA * rtA) / I + (rtB * rtB) / I);
  jt = clamp(jt, -0.4 * j, 0.4 * j);
  A.vx += jt * tx;
  A.vz += jt * tz;
  A.angVel += (rtA * jt) / I;
  B.vx -= jt * tx;
  B.vz -= jt * tz;
  B.angVel -= (rtB * jt) / I;
  if (onHit) onHit(A, B, -vn, px, pz, nx, nz);
}

/** Урон машине от удара другой машиной: зависит от того, чем ударили и куда. */
export function carHitDamage(car, impact, px, pz) {
  if (impact <= CAR_HIT.threshold) return 0;
  const zone = car.zoneAt(px, pz);
  let k = CAR_HIT.zone[zone];
  if (zone === 'front' && !car.frontArmored) k *= 1.8; // без кенгурятника лоб мягче
  return (impact - CAR_HIT.threshold) * CAR_HIT.scale * k;
}
