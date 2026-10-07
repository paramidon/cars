import * as THREE from 'three';
import { Car, HIT_Z, HIT_R, CAR_INERTIA } from './car.js';
import { clamp, rand } from './utils.js';

/** Соперники: имя, цвет, номер и характер. */
// speed — доля от максималки игрока, corner — скорость в повороте 90°, м/с; aggression — как часто таранит
export const RIVALS = [
  { name: 'МОЛНИЯ', color: '#1f5fe0', number: 7, speed: 0.9, corner: 12, aggression: 0.2, lane: -2.2 },
  { name: 'МЯСНИК', color: '#1f9e45', number: 13, speed: 0.86, corner: 11, aggression: 0.5, lane: 2.2 },
  { name: 'БУЛЬДОЗЕР', color: '#e8b10c', number: 66, speed: 0.82, corner: 10.5, aggression: 0.95, lane: 0 },
];

/** Стартовая решётка: [вбок, вперёд] от точки старта игрока, по направлению движения. */
const GRID = [
  [0, 7.5], // МОЛНИЯ — первый ряд, прямо перед игроком
  [-7, 0], // МЯСНИК — рядом с игроком, соседняя полоса
  [-7, 7.5], // БУЛЬДОЗЕР — первый ряд, соседняя полоса
];

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
      color: def.color, turret: false, isPlayer: false, number: def.number, name: def.name, wallDamage: 0.5,
    });
    this.inp = { throttle: 0, brake: 0, steer: 0, handbrake: false, fire: false };
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tagTexture(), transparent: true, depthWrite: false }));
    this.tag.scale.set(4.4, 1.1, 1);
    this.tag.renderOrder = 6;
    scene.add(this.tag);
    this._tagHp = -1;
    this.reset();
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
    this.ramT = 0;
    this.ramCD = rand(3, 6);
    this.boost = 1;
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

  /** ИИ: решить, как рулить в этом кадре. */
  think(dt, player, running, playerProgress, myProgress) {
    const car = this.car, inp = this.inp, race = this.race, def = this.def;
    inp.fire = false;
    inp.handbrake = false;
    if (!running || car.wrecked) {
      inp.throttle = 0;
      inp.brake = 0;
      inp.steer = 0;
      return inp;
    }

    const pr = race.project(car.x, car.z);
    const v = car.speed;
    const finished = this.tr.finished;

    // догонялки: отставший прибавляет, убежавший далеко чуть сбрасывает
    const gap = playerProgress - myProgress;
    const boostT = gap > 1.5 ? 1.06 : gap < -1.5 ? 0.88 : 1;
    this.boost += (boostT - this.boost) * Math.min(1, dt * 0.5);
    let maxV = TOP_SPEED * def.speed * this.boost * (finished ? 0.55 : 1);

    // точка на трассе впереди (своя полоса)
    const look = 9 + v * 0.55;
    const p = race.pointAt(pr.s + look, def.lane);
    let tx = p.x, tz = p.z;

    // таран: если игрок рядом впереди — иногда идём в него
    this.ramT -= dt;
    this.ramCD -= dt;
    if (!finished && player && !player.wrecked) {
      const dx = player.x - car.x, dz = player.z - car.z;
      const d = Math.hypot(dx, dz);
      if (this.ramT <= 0 && this.ramCD <= 0 && d > 3 && d < 24 && pr.dist < 12) {
        const ang = Math.abs(Math.atan2(dx * -Math.cos(car.yaw) + dz * Math.sin(car.yaw), dx * Math.sin(car.yaw) + dz * Math.cos(car.yaw)));
        if (ang < 0.7 && Math.random() < def.aggression * dt * 1.5) this.ramT = rand(1.2, 2.2);
      }
      if (this.ramT > 0) {
        tx = player.x + player.vx * 0.3;
        tz = player.z + player.vz * 0.3;
        maxV = TOP_SPEED * def.speed * 1.05;
        if (this.ramT - dt <= 0 || d > 30) {
          this.ramT = 0;
          this.ramCD = rand(4, 9) / Math.max(0.2, def.aggression);
        }
      }
    }

    // руль: угол до цели
    const s = Math.sin(car.yaw), c = Math.cos(car.yaw);
    const dx = tx - car.x, dz = tz - car.z;
    const fwd = dx * s + dz * c, right = dx * -c + dz * s;
    const ang = Math.atan2(right, fwd);
    let steer = clamp(ang * 2.2, -1, 1);

    // скорость: тормозим заранее перед поворотами
    let target = maxV;
    if (this.ramT <= 0) {
      for (const cn of race.cornersAhead(pr.s, 2)) {
        if (cn.angle < 0.3) continue;
        const vc = def.corner * (1.5 - 0.5 * Math.min(1, cn.angle / (Math.PI / 2)));
        target = Math.min(target, Math.sqrt(vc * vc + 2 * 15 * Math.max(0, cn.dist - 5)));
      }
      if (Math.abs(ang) > 0.6) target = Math.min(target, 10);
    }
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
