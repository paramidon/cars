import * as THREE from 'three';
import { rand, pick, wrapAngle, dampAngle } from './utils.js';
import { pushOutCircle, rayCircle } from './physics/collision.js';
import { CAR_HALF_W, CAR_HALF_L } from './car.js';

const SHIRTS = ['#c0392b', '#2980b9', '#27ae60', '#f1c40f', '#8e44ad', '#e67e22', '#ecf0f1', '#34495e', '#16a085', '#d35400', '#7f8c8d', '#e84393', '#2c3e50', '#ff7675'];
const PANTS = ['#2c3e50', '#34495e', '#1e272e', '#57606f', '#6d4c41', '#3d3d3d', '#1f3a93', '#4b6584', '#a4b0be'];
const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#f5cba7'];
const HAIR = ['#2b1b0e', '#4a3121', '#8b5a2b', '#d8b26e', '#1a1a1a', '#b0b0b0', '#7b3f00'];

export const ST = { FREE: 0, WALK: 1, WAIT: 2, PANIC: 3, COWER: 4, FLYING: 5, DEAD: 6, DOWN: 7, GETUP: 8 };
const GRAV = 22;
// скорости машины, м/с: ниже KNOCK — просто отталкивает, ниже KILL — сбивает с ног, выше GIB — в клочья
export const KNOCK_SPEED = 2.5;
export const KILL_SPEED = 11; // ≈ 40 км/ч
const GIB_SPEED = 24;
const GETUP_TIME = 0.7;

const _root = new THREE.Matrix4();
const _ry = new THREE.Matrix4();
const _loc = new THREE.Matrix4();
const _out = new THREE.Matrix4();
const _e = new THREE.Euler();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _c = new THREE.Color();
const _q = new THREE.Quaternion();
const _ax = new THREE.Vector3();

/** Локальная матрица части тела: T(pivot)·Rz·Rx·T(offset), собранная вручную без аллокаций. */
function local(px, py, pz, rx, rz, ox, oy, oz) {
  const cx = Math.cos(rx), sx = Math.sin(rx), cz = Math.cos(rz), sz = Math.sin(rz);
  _loc.set(
    cz, -sz * cx, sz * sx, px + cz * ox - sz * cx * oy + sz * sx * oz,
    sz, cz * cx, -cz * sx, py + sz * ox + cz * cx * oy - cz * sx * oz,
    0, sx, cx, pz + sx * oy + cx * oz,
    0, 0, 0, 1,
  );
  return _loc;
}

/** Ошмётки: куски тел, кувыркающиеся и оставляющие кровавый след. */
class Gibs {
  constructor(scene, max, shadows) {
    this.max = max;
    const mat = new THREE.MeshLambertMaterial();
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadows;
    for (let i = 0; i < max; i++) {
      this.mesh.setMatrixAt(i, _zero);
      this.mesh.setColorAt(i, _c.setRGB(1, 1, 1));
    }
    scene.add(this.mesh);
    this.items = Array.from({ length: max }, () => ({
      active: false, rest: false,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), size: new THREE.Vector3(),
      t: 0, trail: 0,
    }));
    this.cursor = 0;
  }

  spawn(x, y, z, vx, vy, vz, sx, sy, sz, color) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.max;
    const it = this.items[i];
    it.active = true;
    it.rest = false;
    it.t = 0;
    it.trail = 0;
    it.pos.set(x, y, z);
    it.vel.set(vx, vy, vz);
    it.q.setFromEuler(_e.set(rand(0, 6), rand(0, 6), rand(0, 6)));
    it.w.set(rand(-14, 14), rand(-14, 14), rand(-14, 14));
    it.size.set(sx, sy, sz);
    this.mesh.setColorAt(i, _c.set(color));
    this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    for (let i = 0; i < this.max; i++) {
      this.items[i].active = false;
      this.mesh.setMatrixAt(i, _zero);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt, ground, world, fx) {
    let dirty = false;
    for (let i = 0; i < this.max; i++) {
      const it = this.items[i];
      if (!it.active) continue;
      it.t += dt;
      if (it.rest) {
        if (it.t > 30) {
          it.pos.y -= dt * 0.2;
          if (it.t > 33) {
            it.active = false;
            this.mesh.setMatrixAt(i, _zero);
            dirty = true;
            continue;
          }
        } else continue;
      } else {
        it.vel.y -= GRAV * dt;
        it.pos.addScaledVector(it.vel, dt);
        const w = it.w.length();
        if (w > 1e-3) {
          _q.setFromAxisAngle(_ax.copy(it.w).divideScalar(w), w * dt);
          it.q.premultiply(_q);
        }
        const sp = it.vel.lengthSq();
        if (sp > 9) {
          it.trail -= dt;
          if (it.trail <= 0) {
            it.trail = 0.035;
            fx.gibTrail(it.pos.x, it.pos.y, it.pos.z);
          }
        }
        const push = pushOutCircle(world, it.pos.x, it.pos.z, 0.15);
        if (push.hit) {
          it.pos.x = push.x;
          it.pos.z = push.z;
          const vn = it.vel.x * push.nx + it.vel.z * push.nz;
          if (vn < 0) {
            it.vel.x -= 1.4 * vn * push.nx;
            it.vel.z -= 1.4 * vn * push.nz;
            if (vn < -5) fx.wallSplat(it.pos.x - push.nx * 0.2, it.pos.y, it.pos.z - push.nz * 0.2, push.nx, push.nz, rand(0.6, 1.2));
          }
        }
        const floor = ground(it.pos.x, it.pos.z) + Math.min(it.size.x, it.size.y, it.size.z) * 0.5;
        if (it.pos.y < floor) {
          it.pos.y = floor;
          if (it.vel.y < -3) {
            it.vel.y *= -0.3;
            it.vel.x *= 0.55;
            it.vel.z *= 0.55;
            it.w.multiplyScalar(0.5);
            fx.bloodSplat(it.pos.x, it.pos.z, rand(0.4, 1.0));
          } else {
            it.vel.y = 0;
            const f = Math.exp(-6 * dt);
            it.vel.x *= f;
            it.vel.z *= f;
            it.w.multiplyScalar(f);
            if (it.vel.x * it.vel.x + it.vel.z * it.vel.z < 0.05) {
              it.rest = true;
              it.t = 0;
            }
          }
        }
      }
      _out.compose(it.pos, it.q, it.size);
      this.mesh.setMatrixAt(i, _out);
      dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Толпа пешеходов: каждая часть тела — один InstancedMesh на всех. */
export class Pedestrians {
  constructor(scene, city, fx, audio, quality) {
    this.city = city;
    this.world = city.world;
    this.nodes = city.nodes;
    this.fx = fx;
    this.audio = audio;
    this.target = quality.pedCount;
    this.pool = this.target + 40;
    this.maxCorpses = 35;
    this.onKill = null; // (ped, cause, speed)
    this.onEvent = null; // (type, ped)
    this.time = 0;
    this.spawnTimer = 0;

    const mat = new THREE.MeshLambertMaterial();
    const mk = (geo, count) => {
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = quality.shadows;
      for (let i = 0; i < count; i++) {
        m.setMatrixAt(i, _zero);
        m.setColorAt(i, _c.setRGB(1, 1, 1));
      }
      scene.add(m);
      return m;
    };
    this.mHead = mk(new THREE.BoxGeometry(0.3, 0.32, 0.3), this.pool);
    this.mHair = mk(new THREE.BoxGeometry(0.33, 0.1, 0.33), this.pool);
    this.mTorso = mk(new THREE.BoxGeometry(0.5, 0.62, 0.28), this.pool);
    this.mArm = mk(new THREE.BoxGeometry(0.14, 0.6, 0.14), this.pool * 2);
    this.mLeg = mk(new THREE.BoxGeometry(0.19, 0.85, 0.21), this.pool * 2);
    this.meshes = [this.mHead, this.mHair, this.mTorso, this.mArm, this.mLeg];
    this.gibs = new Gibs(scene, quality.low ? 140 : 240, quality.shadows);

    this.peds = [];
    for (let i = 0; i < this.pool; i++) this.peds.push({ i, state: ST.FREE });
  }

  // ------------------------------------------------------------------ жизненный цикл
  reset(car) {
    for (const p of this.peds) this._free(p);
    this.gibs.clear();
    for (let k = 0; k < this.target; k++) this._spawn(car, true);
  }

  _free(p) {
    p.state = ST.FREE;
    const i = p.i;
    this.mHead.setMatrixAt(i, _zero);
    this.mHair.setMatrixAt(i, _zero);
    this.mTorso.setMatrixAt(i, _zero);
    this.mArm.setMatrixAt(i * 2, _zero);
    this.mArm.setMatrixAt(i * 2 + 1, _zero);
    this.mLeg.setMatrixAt(i * 2, _zero);
    this.mLeg.setMatrixAt(i * 2 + 1, _zero);
  }

  _spawn(car, initial = false) {
    const p = this.peds.find((x) => x.state === ST.FREE);
    if (!p) return;
    let n = 0;
    for (let tries = 0; tries < 16; tries++) {
      n = Math.floor(Math.random() * this.nodes.length);
      const d = Math.hypot(this.nodes[n].x - car.x, this.nodes[n].z - car.z);
      if (d > (initial ? 25 : 45) && d < 170) break;
    }
    const node = this.nodes[n];
    p.x = node.x + rand(-1, 1);
    p.z = node.z + rand(-1, 1);
    p.from = n;
    p.to = pick(node.links);
    p.lane = rand(-0.9, 0.9);
    this._setTarget(p);
    p.state = ST.WALK;
    p.walkSpeed = rand(1.1, 1.8);
    p.speed = p.walkSpeed;
    p.phase = rand(0, 6.28);
    p.yaw = Math.atan2(p.tx - p.x, p.tz - p.z);
    p.health = 100;
    p.cy = this.city.groundHeight(p.x, p.z) + 1;
    p.vx = p.vy = p.vz = 0;
    p.tumX = p.tumZ = 0;
    p.wX = p.wZ = 0;
    p.timer = 0;
    p.stuckT = 0;
    p.lastX = p.x;
    p.lastZ = p.z;
    p.hitCD = 0;
    p.runCD = 0;
    p.reeval = 0;
    p.react = 0;
    p.airT = 0;
    p.deadT = 0;
    p.bounces = 0;
    p.shots = 0;
    p.cause = null;
    p.slide = 0;
    p.still = false;
    p.knocked = false;
    p.bonus = 0;
    const i = p.i;
    const shirt = pick(SHIRTS), skin = pick(SKIN);
    const sleeves = Math.random() < 0.5 ? shirt : skin;
    this.mHead.setColorAt(i, _c.set(skin));
    this.mHair.setColorAt(i, _c.set(pick(HAIR)));
    this.mTorso.setColorAt(i, _c.set(shirt));
    this.mArm.setColorAt(i * 2, _c.set(sleeves));
    this.mArm.setColorAt(i * 2 + 1, _c.set(sleeves));
    const pants = pick(PANTS);
    this.mLeg.setColorAt(i * 2, _c.set(pants));
    this.mLeg.setColorAt(i * 2 + 1, _c.set(pants));
    for (const m of this.meshes) m.instanceColor.needsUpdate = true;
    p.colors = { shirt, skin, pants };
  }

  _setTarget(p) {
    const a = this.nodes[p.from], b = this.nodes[p.to];
    const dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    p.tx = b.x + (-dz / l) * p.lane;
    p.tz = b.z + (dx / l) * p.lane;
  }

  _nearestNode(x, z) {
    let best = 0, bd = Infinity;
    for (let k = 0; k < this.nodes.length; k++) {
      const n = this.nodes[k];
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  }

  /** Стоит на ногах (ходит, ждёт, паникует, замер). */
  isAlive(p) {
    return p.state >= ST.WALK && p.state <= ST.COWER;
  }

  /** Жив вообще: стоит, сбит с ног, поднимается или летит после лёгкого удара. */
  isLiving(p) {
    return this.isAlive(p) || p.state === ST.DOWN || p.state === ST.GETUP || (p.state === ST.FLYING && p.knocked);
  }

  isLying(p) {
    return p.state === ST.DEAD || p.state === ST.DOWN || p.state === ST.GETUP;
  }

  // ------------------------------------------------------------------ паника
  _panic(p, sx, sz, svx, svz, allowCower) {
    const dx = p.x - sx, dz = p.z - sz;
    const d = Math.hypot(dx, dz) || 1;
    const sp = Math.hypot(svx, svz);
    let dirx, dirz;
    if (sp > 2) {
      // уворачиваться вбок от линии движения машины (иногда — не в ту сторону)
      const px = -svz / sp, pz = svx / sp;
      let side = dx * px + dz * pz >= 0 ? 1 : -1;
      if (Math.random() < 0.25) side = -side;
      dirx = px * side * 0.85 + (dx / d) * 0.5;
      dirz = pz * side * 0.85 + (dz / d) * 0.5;
    } else {
      dirx = dx / d;
      dirz = dz / d;
    }
    const l = Math.hypot(dirx, dirz) || 1;
    p.pdx = dirx / l;
    p.pdz = dirz / l;
    if (p.state === ST.PANIC || p.state === ST.COWER) {
      p.timer = Math.max(p.timer, 2);
      return;
    }
    if (allowCower && Math.random() < 0.3) {
      p.state = ST.COWER;
      p.timer = rand(0.5, 1.4);
    } else {
      p.state = ST.PANIC;
      p.timer = rand(2.5, 5);
      p.react = allowCower ? rand(0.15, 0.55) : rand(0, 0.2); // замер от испуга
    }
    p.speed = rand(3.2, 4.8);
    if (Math.random() < 0.3) this.audio.scream();
  }

  /** Всполошить всех живых в радиусе (выстрелы, удары, убийства). */
  alert(x, z, r) {
    const r2 = r * r;
    for (const p of this.peds) {
      if (p.state !== ST.WALK && p.state !== ST.WAIT) continue;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 < r2) this._panic(p, x, z, 0, 0, false);
    }
  }

  _calmDown(p) {
    p.from = this._nearestNode(p.x, p.z);
    p.to = pick(this.nodes[p.from].links);
    this._setTarget(p);
    const n = this.nodes[p.from];
    // сначала дойти до ближайшего узла
    p.tx = n.x;
    p.tz = n.z;
    p.to = p.from;
    p.state = ST.WALK;
    p.speed = p.walkSpeed;
  }

  // ------------------------------------------------------------------ удары
  _hitByCar(p, car, lx) {
    const s = car.speed;
    const ax = car.axes();
    const side = lx >= 0 ? 1 : -1;
    const g = this.city.groundHeight(p.x, p.z);
    p.cause = 'car';
    if (s < KILL_SPEED) {
      this._knock(p, car, side);
      return;
    }
    p.knocked = false;
    if (s > GIB_SPEED) {
      this._gib(p, car.vx, car.vz);
      if (this.onKill) this.onKill(p, 'gib', s);
      this.alert(p.x, p.z, 25);
      return;
    }
    const k = rand(0.95, 1.2);
    p.vx = car.vx * k + ax.rx * side * s * rand(0.1, 0.3);
    p.vz = car.vz * k + ax.rz * side * s * rand(0.1, 0.3);
    p.vy = rand(2.5, 4.5) + s * rand(0.2, 0.35);
    p.wX = rand(6, 13) * (Math.random() < 0.5 ? -1 : 1) * (0.5 + s / 25);
    p.wZ = rand(-7, 7);
    p.cy = Math.max(p.cy, g + 1.1);
    p.state = ST.FLYING;
    p.airT = 0;
    p.bounces = 0;
    p.hitCD = 0.35;
    p.flail = rand(0, 10);
    p.health = 0;
    this.fx.bloodBurst(p.x, p.cy, p.z, car.vx / s, car.vz / s, s * 0.6, Math.floor(18 + s));
    this.fx.bloodSplat(p.x, p.z, rand(1, 2));
    this.fx.bloodSpot(p.x, p.z, 1.3);
    this.audio.splat(s / 18);
    if (Math.random() < 0.6) this.audio.scream();
    car.vx *= 0.97;
    car.vz *= 0.97;
    this.alert(p.x, p.z, 22);
    if (this.onKill) this.onKill(p, 'car', s);
  }

  /** Лёгкий удар: человек отлетает в сторону и падает, но остаётся жив. */
  _knock(p, car, side) {
    const s = car.speed;
    const ax = car.axes();
    const g = this.city.groundHeight(p.x, p.z);
    const push = rand(1.5, 3.5);
    p.knocked = true;
    p.vx = car.vx * rand(0.5, 0.85) + ax.rx * side * push;
    p.vz = car.vz * rand(0.5, 0.85) + ax.rz * side * push;
    p.vy = rand(1.5, 3) + s * 0.1;
    p.wX = rand(3, 6) * (Math.random() < 0.5 ? -1 : 1);
    p.wZ = rand(-3, 3);
    p.cy = Math.max(p.cy, g + 1.0);
    p.state = ST.FLYING;
    p.airT = 0;
    p.bounces = 2;
    p.hitCD = 0.5;
    p.flail = rand(0, 10);
    p.health = Math.min(p.health, 60);
    this.fx.bloodBurst(p.x, p.cy, p.z, car.vx / (s || 1), car.vz / (s || 1), s * 0.3, 6);
    this.audio.crunch();
    if (Math.random() < 0.7) this.audio.scream();
    car.vx *= 0.985;
    car.vz *= 0.985;
    this.alert(p.x, p.z, 15);
    if (this.onEvent) this.onEvent('knock', p);
  }

  /** Поза лёжа после приземления. */
  _lieDown(p) {
    p.tumX = wrapAngle(p.tumX);
    p.tumZ = wrapAngle(p.tumZ);
    p.lieX = p.tumX >= 0 ? Math.PI / 2 : -Math.PI / 2;
    p.lieZ = rand(-0.3, 0.3);
    p.armA = rand(-0.6, 0.6);
    p.armB = rand(-0.6, 0.6);
    p.spread = rand(0.9, 1.6);
    p.slide = 1;
    p.slideAcc = 0;
    p.still = false;
  }

  /** Живой лежачий (или поднимающийся) становится трупом. */
  _finish(p, cause, speed) {
    p.health = 0;
    p.cause = cause;
    if (p.state === ST.FLYING) {
      p.knocked = false; // приземлится уже мёртвым
    } else {
      p.state = ST.DEAD;
      p.deadT = 0;
      p.still = false;
      this.fx.bloodPool(p.x, p.z, rand(2.2, 3.2), 1.8);
    }
    if (this.onKill) this.onKill(p, cause, speed);
  }

  /** Наезд на сбитого с ног: раздавлен. */
  _crush(p, car) {
    p.runCD = 0.5;
    const s = car.speed;
    if (s > GIB_SPEED) {
      p.cause = 'car';
      this._gib(p, car.vx, car.vz);
      if (this.onKill) this.onKill(p, 'gib', s);
      return;
    }
    const g = this.city.groundHeight(p.x, p.z);
    const dirx = car.vx / (s || 1), dirz = car.vz / (s || 1);
    this.fx.bloodBurst(p.x, g + 0.3, p.z, dirx, dirz, Math.max(4, s * 0.4), 26);
    this.fx.bloodSpot(p.x, p.z, 1.3);
    car.pitchVel += 1.5;
    car.hopVel = Math.max(car.hopVel, 1.3);
    this.audio.crunch();
    this.audio.splat(0.6);
    p.vx += car.vx * 0.2;
    p.vz += car.vz * 0.2;
    this.alert(p.x, p.z, 20);
    this._finish(p, 'crush', s);
  }

  _gib(p, vx, vz) {
    const g = this.city.groundHeight(p.x, p.z);
    const y = this.isLying(p) ? g + 0.3 : Math.max(p.cy, g + 0.9);
    const s = Math.hypot(vx, vz) || 1;
    const { shirt, skin, pants } = p.colors;
    const pieces = [
      [0.3, 0.32, 0.3, skin],
      [0.5, 0.31, 0.28, shirt],
      [0.5, 0.31, 0.28, shirt],
      [0.14, 0.6, 0.14, skin],
      [0.14, 0.6, 0.14, shirt],
      [0.19, 0.85, 0.21, pants],
      [0.19, 0.85, 0.21, pants],
    ];
    for (let k = 0; k < 9; k++) {
      const sz = rand(0.1, 0.22);
      pieces.push([sz, sz * rand(0.6, 1.2), sz, pick(['#7a0a0a', '#a01818', '#c94f4f', '#5e0505'])]);
    }
    for (const [sx, sy, sz, color] of pieces) {
      this.gibs.spawn(
        p.x + rand(-0.3, 0.3), y + rand(-0.3, 0.5), p.z + rand(-0.3, 0.3),
        vx * rand(0.5, 1.05) + rand(-5, 5), rand(3, 10), vz * rand(0.5, 1.05) + rand(-5, 5),
        sx, sy, sz, color,
      );
    }
    this.fx.bloodBurst(p.x, y, p.z, vx / s, vz / s, Math.min(25, s * 0.7), 55);
    this.fx.bloodPool(p.x, p.z, rand(3.5, 5), 1.5);
    this.fx.bloodSpot(p.x, p.z, 1.6);
    this.audio.splat(1.3);
    this._free(p);
  }

  _runOver(p, car) {
    p.runCD = 0.5;
    const s = car.speed;
    if (s > 22) {
      this._gib(p, car.vx, car.vz);
      if (this.onEvent) this.onEvent('mince', p);
      return;
    }
    const g = this.city.groundHeight(p.x, p.z);
    this.fx.bloodBurst(p.x, g + 0.3, p.z, car.vx / s, car.vz / s, s * 0.3, 10);
    this.fx.bloodSplat(p.x, p.z, rand(1, 1.8));
    car.pitchVel += 1.2;
    car.hopVel = Math.max(car.hopVel, 1.1);
    this.audio.crunch();
    p.vx += car.vx * 0.3;
    p.vz += car.vz * 0.3;
    p.slide = 1;
    p.still = false;
  }

  /** Пули: ближайший пешеход на луче. */
  raycast(ox, oz, dx, dz, maxT) {
    let best = null, bt = maxT;
    for (const p of this.peds) {
      if (p.state === ST.FREE) continue;
      const r = this.isLying(p) ? 0.7 : 0.45;
      const t = rayCircle(ox, oz, dx, dz, p.x, p.z, r);
      if (t >= 0 && t < bt) {
        bt = t;
        best = p;
      }
    }
    return best ? { ped: best, t: bt } : null;
  }

  bulletHit(p, dx, dz, hx, hz) {
    const g = this.city.groundHeight(p.x, p.z);
    const y = this.isLying(p) ? g + 0.25 : p.state === ST.FLYING ? p.cy : g + rand(1.0, 1.6);
    this.fx.bloodSpray(hx, y, hz, dx, dz, 8);
    if (Math.random() < 0.5) this.fx.bloodSplat(p.x + dx * rand(0.5, 2), p.z + dz * rand(0.5, 2), rand(0.5, 1.1));
    if (this.isAlive(p)) {
      p.health -= 34;
      if (p.health <= 0) {
        p.cause = 'gun';
        p.yaw = Math.atan2(-dx, -dz);
        p.state = ST.FLYING;
        p.vx = dx * rand(2, 4);
        p.vz = dz * rand(2, 4);
        p.vy = rand(1.5, 3);
        p.cy = g + 1.0;
        p.tumX = 0;
        p.tumZ = 0;
        p.wX = -rand(3, 5);
        p.wZ = rand(-1, 1);
        p.airT = 0;
        p.bounces = 2;
        p.flail = rand(0, 10);
        this.audio.splat(0.45);
        if (Math.random() < 0.5) this.audio.scream();
        if (this.onKill) this.onKill(p, 'gun', 0);
      } else {
        p.x += dx * 0.15;
        p.z += dz * 0.15;
        this._panic(p, p.x - dx * 5, p.z - dz * 5, 0, 0, false);
      }
    } else if (p.state === ST.DOWN || p.state === ST.GETUP || (p.state === ST.FLYING && p.knocked)) {
      // сбитого с ног можно добить
      p.health -= 34;
      if (p.state === ST.FLYING) {
        p.vx += dx * 2;
        p.vz += dz * 2;
      } else {
        p.vx += dx * 0.5;
        p.vz += dz * 0.5;
        p.still = false;
      }
      if (p.health <= 0) {
        this.audio.splat(0.45);
        this._finish(p, 'gun', 0);
      }
    } else if (p.state === ST.FLYING) {
      p.vx += dx * 2;
      p.vz += dz * 2;
      p.vy += 1;
    } else if (p.state === ST.DEAD) {
      p.vx += dx * 0.8;
      p.vz += dz * 0.8;
      p.slide = 1;
      p.still = false;
      if (++p.shots > 14) {
        this._gib(p, dx * 6, dz * 6);
        if (this.onEvent) this.onEvent('mince', p);
      }
    }
  }

  /** Взрыв машины: ближних рвёт, дальних раскидывает. */
  explosion(x, z, radius) {
    for (const p of this.peds) {
      if (p.state === ST.FREE) continue;
      const dx = p.x - x, dz = p.z - z;
      const d = Math.hypot(dx, dz);
      if (d > radius) continue;
      const nx = dx / (d || 1), nz = dz / (d || 1);
      const wasAlive = this.isLiving(p);
      p.knocked = false;
      if (d < radius * 0.4) {
        p.cause = 'explosion';
        this._gib(p, nx * 15, nz * 15);
        if (wasAlive && this.onKill) this.onKill(p, 'explosion', 0);
        continue;
      }
      const f = (radius - d) * 2.2;
      p.vx = nx * f;
      p.vz = nz * f;
      p.vy = 5 + (radius - d);
      p.wX = rand(-10, 10);
      p.wZ = rand(-8, 8);
      p.cy = Math.max(p.cy, this.city.groundHeight(p.x, p.z) + 1);
      p.state = ST.FLYING;
      p.airT = 0;
      p.bounces = 0;
      p.flail = rand(0, 10);
      if (wasAlive) {
        p.cause = 'explosion';
        if (this.onKill) this.onKill(p, 'explosion', 0);
      }
    }
  }

  // ------------------------------------------------------------------ кадр
  update(dt, car) {
    this.time += dt;
    const world = this.world;
    const ground = this.city.groundHeight;
    const cx = car.x, cz = car.z, cvx = car.vx, cvz = car.vz;
    const cs = car.speed;
    const ax = car.axes();
    const lim = this.city.outer - 1;
    let alive = 0, living = 0, corpses = 0, oldest = null;

    for (const p of this.peds) {
      if (p.state === ST.FREE) continue;
      p.hitCD -= dt;
      p.runCD -= dt;

      switch (p.state) {
        case ST.WALK: {
          const dx = p.tx - p.x, dz = p.tz - p.z;
          const d = Math.hypot(dx, dz);
          if (d < 0.4) {
            const prev = p.from;
            p.from = p.to;
            const links = this.nodes[p.from].links;
            let next = pick(links);
            if (links.length > 1) while (next === prev) next = pick(links);
            p.to = next;
            this._setTarget(p);
            if (Math.random() < 0.07) {
              p.state = ST.WAIT;
              p.timer = rand(1, 4);
            }
          } else {
            p.x += (dx / d) * p.speed * dt;
            p.z += (dz / d) * p.speed * dt;
            p.yaw = dampAngle(p.yaw, Math.atan2(dx, dz), 8, dt);
          }
          p.phase += dt * p.speed * 4.2;
          p.stuckT += dt;
          if (p.stuckT > 3) {
            if (Math.hypot(p.x - p.lastX, p.z - p.lastZ) < 1) {
              const t = p.to;
              p.to = p.from;
              p.from = t;
              this._setTarget(p);
            }
            p.stuckT = 0;
            p.lastX = p.x;
            p.lastZ = p.z;
          }
          break;
        }
        case ST.WAIT:
          p.timer -= dt;
          if (p.timer <= 0) p.state = ST.WALK;
          break;
        case ST.COWER:
          p.timer -= dt;
          if (p.timer <= 0) {
            p.state = ST.PANIC;
            p.timer = rand(2.5, 4.5);
          }
          break;
        case ST.PANIC: {
          if (p.react > 0) {
            p.react -= dt;
            break;
          }
          p.timer -= dt;
          p.reeval -= dt;
          if (p.reeval <= 0) {
            p.reeval = 0.5;
            if (cs > 6 && (p.x - cx) ** 2 + (p.z - cz) ** 2 < 16 * 16) this._panic(p, cx, cz, cvx, cvz, false);
          }
          const wob = (Math.random() - 0.5) * dt * 2;
          const c = Math.cos(wob), s = Math.sin(wob);
          const ndx = p.pdx * c - p.pdz * s, ndz = p.pdx * s + p.pdz * c;
          p.pdx = ndx;
          p.pdz = ndz;
          p.x += p.pdx * p.speed * dt;
          p.z += p.pdz * p.speed * dt;
          p.yaw = dampAngle(p.yaw, Math.atan2(p.pdx, p.pdz), 12, dt);
          p.phase += dt * p.speed * 3.2;
          if (p.x < -lim || p.x > lim) p.pdx = -Math.sign(p.x) * Math.abs(p.pdx);
          if (p.z < -lim || p.z > lim) p.pdz = -Math.sign(p.z) * Math.abs(p.pdz);
          if (p.timer <= 0) this._calmDown(p);
          break;
        }
        case ST.FLYING: {
          if (p.knocked) living++;
          p.airT += dt;
          p.vy -= GRAV * dt;
          const f = Math.exp(-0.35 * dt);
          p.vx *= f;
          p.vz *= f;
          p.x += p.vx * dt;
          p.cy += p.vy * dt;
          p.z += p.vz * dt;
          p.tumX += p.wX * dt;
          p.tumZ += p.wZ * dt;
          const push = pushOutCircle(world, p.x, p.z, 0.35);
          if (push.hit && p.cy < 12) {
            p.x = push.x;
            p.z = push.z;
            const vn = p.vx * push.nx + p.vz * push.nz;
            if (vn < 0) {
              p.vx -= 1.5 * vn * push.nx;
              p.vz -= 1.5 * vn * push.nz;
              if (-vn > 6) {
                this.fx.wallSplat(p.x - push.nx * 0.36, p.cy, p.z - push.nz * 0.36, push.nx, push.nz, rand(1.6, 2.6) * Math.min(1.5, -vn / 10));
                this.fx.bloodBurst(p.x, p.cy, p.z, push.nx, push.nz, 3, 14);
                this.audio.splat(Math.min(1, -vn / 20));
                if (this.onEvent && p.cause === 'car') this.onEvent('wall', p);
              }
            }
          }
          const g = ground(p.x, p.z);
          const floor = g + 0.18;
          if (p.cy < floor && p.vy < 0) {
            const impact = -p.vy;
            p.cy = floor;
            if (impact > 7 && p.bounces < 2) {
              p.vy = impact * 0.3;
              p.vx *= 0.6;
              p.vz *= 0.6;
              p.wX *= 0.6;
              p.bounces++;
              this.fx.bloodBurst(p.x, g + 0.2, p.z, 0, 0, 3, 10);
              this.fx.bloodSplat(p.x, p.z, rand(1.2, 2));
              this.audio.splat(0.4);
            } else if (p.knocked) {
              p.knocked = false;
              p.state = ST.DOWN;
              p.downT = rand(2.2, 3.8);
              p.runCD = 0.15;
              this._lieDown(p);
              this.fx.bloodSplat(p.x, p.z, rand(0.5, 0.9));
            } else {
              p.state = ST.DEAD;
              p.deadT = 0;
              this._lieDown(p);
              this.fx.bloodPool(p.x, p.z, rand(2.2, 3.4), 2.5);
              if (this.onEvent && p.cause === 'car' && p.airT > 1.3) this.onEvent('air', p);
            }
          }
          break;
        }
        case ST.DOWN: {
          living++;
          const k = Math.min(1, dt * 12);
          p.tumX += (p.lieX - p.tumX) * k;
          p.tumZ += (p.lieZ - p.tumZ) * k;
          this._slide(p, dt, false);
          p.cy = ground(p.x, p.z) + 0.16;
          p.downT -= dt;
          if (p.downT <= 0) {
            p.state = ST.GETUP;
            p.getT = 0;
            p.fromX = p.tumX;
            p.fromZ = p.tumZ;
          }
          break;
        }
        case ST.GETUP: {
          living++;
          this._slide(p, dt, false);
          p.getT += dt;
          const f = Math.min(1, p.getT / GETUP_TIME);
          const e = f * f * (3 - 2 * f);
          p.tumX = p.fromX * (1 - e);
          p.tumZ = p.fromZ * (1 - e);
          p.cy = ground(p.x, p.z) + 0.16 + 0.84 * e;
          if (f >= 1) {
            // встал — и бежать подальше от машины
            p.tumX = p.tumZ = 0;
            p.state = ST.PANIC;
            p.react = 0;
            p.timer = rand(3, 5);
            p.speed = rand(3.5, 5);
            const dx = p.x - cx, dz = p.z - cz;
            const d = Math.hypot(dx, dz) || 1;
            p.pdx = dx / d;
            p.pdz = dz / d;
          }
          break;
        }
        case ST.DEAD: {
          p.deadT += dt;
          const k = Math.min(1, dt * 12);
          p.tumX += (p.lieX - p.tumX) * k;
          p.tumZ += (p.lieZ - p.tumZ) * k;
          const sp = this._slide(p, dt, true);
          p.cy = ground(p.x, p.z) + 0.16;
          if (p.deadT > 45) {
            p.cy -= (p.deadT - 45) * 0.25;
            if (p.deadT > 49) {
              this._free(p);
              continue;
            }
          }
          p.still = p.deadT > 0.6 && sp <= 0.05 && p.deadT < 45;
          corpses++;
          if (!oldest || p.deadT > oldest.deadT) oldest = p;
          break;
        }
      }

      // толкаемся о стены
      if (p.state >= ST.WALK && p.state <= ST.COWER) {
        alive++;
        const push = pushOutCircle(world, p.x, p.z, 0.3);
        if (push.hit) {
          p.x = push.x;
          p.z = push.z;
          if (p.state === ST.PANIC) {
            // бежать вдоль стены
            const tx = -push.nz, tz = push.nx;
            const sgn = p.pdx * tx + p.pdz * tz >= 0 ? 1 : -1;
            p.pdx = tx * sgn;
            p.pdz = tz * sgn;
          }
        }
        p.cy = ground(p.x, p.z) + 1;

        // замечаем машину
        if ((p.state === ST.WALK || p.state === ST.WAIT) && cs > 7) {
          const dx = p.x - cx, dz = p.z - cz;
          const d2 = dx * dx + dz * dz;
          if (d2 < 16 * 16) {
            const d = Math.sqrt(d2) || 1;
            const dot = (dx * cvx + dz * cvz) / (d * cs);
            if ((dot > 0.4 || d < 6) && Math.random() < dt * 3) this._panic(p, cx, cz, cvx, cvz, true);
          }
        }
      }

      // контакт с машиной
      const dx = p.x - cx, dz = p.z - cz;
      if (dx * dx + dz * dz < 10) {
        const lz = dx * ax.fx + dz * ax.fz;
        const lx = dx * ax.rx + dz * ax.rz;
        if (Math.abs(lx) < CAR_HALF_W + 0.3 && Math.abs(lz) < CAR_HALF_L + 0.3) {
          if (this.isAlive(p)) {
            if (cs > KNOCK_SPEED) {
              this._hitByCar(p, car, lx);
              if (p.state === ST.FREE) continue;
            } else {
              const tgt = (lx >= 0 ? 1 : -1) * (CAR_HALF_W + 0.32);
              p.x += ax.rx * (tgt - lx);
              p.z += ax.rz * (tgt - lx);
              if (p.state !== ST.PANIC) this._panic(p, cx, cz, 0, 0, false);
            }
          } else if ((p.state === ST.DOWN || p.state === ST.GETUP) && p.runCD <= 0 && cs > 1.2) {
            this._crush(p, car);
            if (p.state === ST.FREE) continue;
          } else if (p.state === ST.FLYING && p.knocked && p.hitCD <= 0 && cs > KNOCK_SPEED && p.cy < 2.6) {
            this._hitByCar(p, car, lx);
            if (p.state === ST.FREE) continue;
          } else if (p.state === ST.FLYING && !p.knocked && p.hitCD <= 0 && cs > 6 && p.cy < 2.6) {
            p.hitCD = 0.35;
            p.vx = car.vx * rand(1, 1.2);
            p.vz = car.vz * rand(1, 1.2);
            p.vy = Math.max(p.vy, 3 + cs * 0.2);
            this.fx.bloodBurst(p.x, p.cy, p.z, car.vx / cs, car.vz / cs, cs * 0.5, 12);
            this.audio.splat(0.6);
            if (this.onEvent) this.onEvent('juggle', p);
          } else if (p.state === ST.DEAD && p.runCD <= 0 && cs > 3) {
            this._runOver(p, car);
            if (p.state === ST.FREE) continue;
          }
        }
      }

      this._compose(p);
    }

    // лишние трупы убираем
    if (corpses > this.maxCorpses && oldest) this._free(oldest);

    // пополнение толпы
    this.spawnTimer -= dt;
    if (alive + living < this.target && this.spawnTimer <= 0) {
      this.spawnTimer = 0.15;
      this._spawn(car);
    }

    this.gibs.update(dt, ground, world, this.fx);
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
  }

  /** Скольжение лежащего тела по земле после удара; возвращает скорость. */
  _slide(p, dt, smear) {
    const sp = Math.hypot(p.vx, p.vz);
    if (sp <= 0.05) {
      p.vx = p.vz = 0;
      return 0;
    }
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    const f = Math.exp(-5 * dt);
    p.vx *= f;
    p.vz *= f;
    if (smear) {
      p.slideAcc += sp * dt;
      if (p.slideAcc > 0.5) {
        p.slideAcc = 0;
        this.fx.bloodSplat(p.x, p.z, rand(0.7, 1.3));
      }
    }
    const push = pushOutCircle(this.world, p.x, p.z, 0.4);
    if (push.hit) {
      p.x = push.x;
      p.z = push.z;
    }
    return sp;
  }

  _compose(p) {
    if (p.still) return;
    const i = p.i;
    let legL = 0, legR = 0, armL = 0, armR = 0, spreadA = 0.08, spreadL = 0, lean = 0, bob = 0;
    switch (p.state) {
      case ST.WALK: {
        const s = Math.sin(p.phase);
        legL = s * 0.55;
        legR = -s * 0.55;
        armL = -s * 0.45;
        armR = s * 0.45;
        bob = Math.abs(Math.cos(p.phase)) * 0.04;
        break;
      }
      case ST.WAIT:
        armL = Math.sin(this.time * 1.5 + i) * 0.05;
        armR = -armL;
        break;
      case ST.PANIC: {
        if (p.react > 0) {
          armL = armR = -2.7;
          spreadA = 0.5;
          lean = -0.12;
          break;
        }
        const s = Math.sin(p.phase);
        legL = s * 0.95;
        legR = -s * 0.95;
        armL = -2.6 + Math.sin(p.phase * 2) * 0.45;
        armR = -2.6 - Math.sin(p.phase * 2) * 0.45;
        spreadA = 0.35;
        lean = 0.22;
        bob = Math.abs(Math.cos(p.phase)) * 0.08;
        break;
      }
      case ST.COWER:
        armL = armR = -2.9;
        spreadA = 0.25;
        lean = Math.sin(this.time * 40 + i) * 0.04 - 0.1;
        bob = -0.1;
        break;
      case ST.FLYING: {
        const f = this.time * 15 + p.flail;
        armL = Math.sin(f) * 2.2;
        armR = Math.sin(f * 1.13 + 1) * 2.2;
        legL = Math.sin(f * 0.9) * 1.1;
        legR = Math.sin(f * 1.07 + 2) * 1.1;
        spreadA = 0.9;
        spreadL = 0.3;
        break;
      }
      case ST.DEAD:
        armL = p.armA;
        armR = p.armB;
        spreadA = p.spread;
        spreadL = 0.22;
        legL = 0.08;
        legR = -0.08;
        break;
      case ST.DOWN: {
        // корчится
        const w = this.time * 5 + i;
        armL = p.armA + Math.sin(w) * 0.5;
        armR = p.armB - Math.sin(w * 1.3) * 0.5;
        spreadA = p.spread * 0.8;
        spreadL = 0.15;
        legL = 0.3 + Math.sin(w * 0.8) * 0.35;
        legR = 0.3 - Math.sin(w * 0.8) * 0.35;
        break;
      }
      case ST.GETUP: {
        const k = 1 - Math.min(1, p.getT / GETUP_TIME);
        armL = p.armA * k;
        armR = p.armB * k;
        spreadA = 0.08 + p.spread * k;
        legL = 0.6 * k;
        legR = 0.6 * k;
        break;
      }
    }
    const isStanding = p.state <= ST.COWER;
    _e.set(isStanding ? lean : p.tumX, 0, isStanding ? 0 : p.tumZ);
    _root.makeRotationFromEuler(_e);
    _ry.makeRotationY(p.yaw);
    _root.premultiply(_ry);
    const e = _root.elements;
    const cy = p.cy + bob;
    _root.setPosition(p.x - e[4], cy - e[5], p.z - e[6]);

    _out.multiplyMatrices(_root, local(0, 1.16, 0, 0, 0, 0, 0, 0));
    this.mTorso.setMatrixAt(i, _out);
    _out.multiplyMatrices(_root, local(0, 1.66, 0, 0, 0, 0, 0, 0));
    this.mHead.setMatrixAt(i, _out);
    _out.multiplyMatrices(_root, local(0, 1.86, 0, 0, 0, 0, 0, 0));
    this.mHair.setMatrixAt(i, _out);
    _out.multiplyMatrices(_root, local(0.34, 1.42, 0, armL, spreadA, 0, -0.28, 0));
    this.mArm.setMatrixAt(i * 2, _out);
    _out.multiplyMatrices(_root, local(-0.34, 1.42, 0, armR, -spreadA, 0, -0.28, 0));
    this.mArm.setMatrixAt(i * 2 + 1, _out);
    _out.multiplyMatrices(_root, local(0.12, 0.85, 0, legL, spreadL, 0, -0.42, 0));
    this.mLeg.setMatrixAt(i * 2, _out);
    _out.multiplyMatrices(_root, local(-0.12, 0.85, 0, legR, -spreadL, 0, -0.42, 0));
    this.mLeg.setMatrixAt(i * 2 + 1, _out);
  }
}
