import * as THREE from 'three';
import { rand, wrapAngle, clamp } from './utils.js';
import { ST } from './pedestrians.js';
import { HIT_Z, HIT_R } from './car.js';
import { rayCircle } from './physics/collision.js';

const RANGE = 85;
const RATE = 14; // выстрелов в секунду
const TURN_SPEED = 7; // рад/с
const AUTO_CONE = 0.75; // ±43° от носа машины
const AUTO_RANGE = 55;

const bulletFilter = (c) => c.kind !== 'breakable' && c.h >= 1.5;
const CAR_BULLET_DAMAGE = 0.7; // урон одной пули по машине соперника

/** Пулемёт на крыше: наведение, стрельба, трассеры. */
export class MachineGun {
  constructor(scene, car, city, peds, fx, audio) {
    this.scene = scene;
    this.car = car;
    this.city = city;
    this.peds = peds;
    this.fx = fx;
    this.audio = audio;
    this.cooldown = 0;
    this.spin = 0;
    this.flashT = 0;
    this.target = null;
    this.retarget = 0;
    this.rivals = []; // машины соперников — тоже мишени
    this.onCarHit = null; // (car, damage)
    this.onShot = null;

    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0, 0.5);
    this.tracers = [];
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.tracers.push({ mesh: m, t: 0 });
    }
    this.tracerIdx = 0;
  }

  /** Мировая позиция дульного среза и пивота турели. */
  _muzzle(out) {
    const car = this.car;
    const s = Math.sin(car.yaw), c = Math.cos(car.yaw);
    // пивот турели (0, 1.66, -0.35) в системе машины
    const px = car.x + -0.35 * s, pz = car.z + -0.35 * c;
    const wy = car.yaw + car.turretYaw;
    out.px = px;
    out.pz = pz;
    out.x = px + Math.sin(wy) * 1.45;
    out.z = pz + Math.cos(wy) * 1.45;
    out.y = car.y + car.hop + 1.66 + 0.32;
    out.yaw = wy;
    return out;
  }

  _autoTarget() {
    const car = this.car;
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    let best = null, bestScore = Infinity;
    for (const p of this.peds.peds) {
      if (!this.peds.isAlive(p)) continue;
      const dx = p.x - car.x, dz = p.z - car.z;
      const d = Math.hypot(dx, dz);
      if (d > AUTO_RANGE || d < 1.5) continue;
      const ang = Math.acos(clamp((dx * fx + dz * fz) / d, -1, 1));
      if (ang > AUTO_CONE) continue;
      const score = ang * 25 + d;
      if (score < bestScore) {
        // прямая видимость
        const hit = this.city.world.raycast(car.x, car.z, dx / d, dz / d, d, bulletFilter);
        if (hit) continue;
        bestScore = score;
        best = p;
      }
    }
    for (const r of this.rivals) {
      if (r.wrecked) continue;
      const dx = r.x - car.x, dz = r.z - car.z;
      const d = Math.hypot(dx, dz);
      if (d > AUTO_RANGE || d < 3) continue;
      const ang = Math.acos(clamp((dx * fx + dz * fz) / d, -1, 1));
      if (ang > AUTO_CONE) continue;
      const score = ang * 25 + d + 4; // пешеходы чуть в приоритете
      if (score < bestScore && !this.city.world.raycast(car.x, car.z, dx / d, dz / d, d, bulletFilter)) {
        bestScore = score;
        best = r;
      }
    }
    return best;
  }

  _targetAlive(t) {
    return t.isCar ? !t.wrecked : this.peds.isAlive(t);
  }

  /** Ближайшее попадание пули в машину соперника. */
  _rayCars(ox, oz, dx, dz, maxT) {
    let best = null, bt = maxT;
    for (const r of this.rivals) {
      const s = Math.sin(r.yaw), c = Math.cos(r.yaw);
      for (const o of HIT_Z) {
        const t = rayCircle(ox, oz, dx, dz, r.x + s * o, r.z + c * o, HIT_R * 0.95);
        if (t >= 0 && t < bt) {
          bt = t;
          best = r;
        }
      }
    }
    return best ? { car: best, t: bt } : null;
  }

  /**
   * aim: { mode: 'mouse', x, z } — навестись на точку; иначе автонаведение в конусе перед машиной.
   */
  update(dt, firing, aim) {
    const car = this.car;
    const M = this._muzzle(MZ);

    // куда смотреть
    let desired = car.yaw;
    if (car.wrecked) {
      desired = car.yaw + car.turretYaw;
    } else if (aim && aim.mode === 'mouse') {
      desired = Math.atan2(aim.x - M.px, aim.z - M.pz);
      this.target = null;
    } else {
      this.retarget -= dt;
      if (this.retarget <= 0) {
        this.retarget = 0.12;
        this.target = this._autoTarget();
      }
      if (this.target && this._targetAlive(this.target)) {
        // упреждение по скорости
        const t = this.target;
        let lx = t.x, lz = t.z;
        if (t.isCar) {
          const d = Math.hypot(t.x - M.x, t.z - M.z);
          lx += (t.vx - car.vx) * (d / 300);
          lz += (t.vz - car.vz) * (d / 300);
        } else if (t.state === ST.PANIC || t.state === ST.WALK) {
          const d = Math.hypot(t.x - M.x, t.z - M.z);
          const lead = d / 300;
          lx += Math.sin(t.yaw) * t.speed * lead;
          lz += Math.cos(t.yaw) * t.speed * lead;
        }
        desired = Math.atan2(lx - M.px, lz - M.pz);
      } else this.target = null;
    }
    const rel = wrapAngle(desired - car.yaw);
    const diff = wrapAngle(rel - car.turretYaw);
    car.turretYaw = wrapAngle(car.turretYaw + clamp(diff, -TURN_SPEED * dt, TURN_SPEED * dt));

    // стрельба
    this.cooldown -= dt;
    const shooting = firing && !car.wrecked;
    this.spin += ((shooting ? 40 : 0) - this.spin) * Math.min(1, dt * (shooting ? 6 : 2));
    car.barrels.rotation.z += this.spin * dt;
    if (shooting && this.cooldown <= 0) {
      this.cooldown += 1 / RATE;
      if (this.cooldown < 0) this.cooldown = 0;
      this._fire(this._muzzle(MZ));
    }
    if (!shooting && this.cooldown < 0) this.cooldown = 0;

    // вспышка
    this.flashT -= dt;
    car.flash.visible = this.flashT > 0;
    if (car.muzzleLight) car.muzzleLight.intensity = this.flashT > 0 ? 40 : 0;

    for (const tr of this.tracers) {
      if (tr.t <= 0) continue;
      tr.t -= dt;
      tr.mesh.material.opacity = Math.max(0, tr.t / 0.07);
      if (tr.t <= 0) tr.mesh.visible = false;
    }
  }

  _fire(M) {
    const car = this.car;
    const a = M.yaw + rand(-0.025, 0.025);
    const dx = Math.sin(a), dz = Math.cos(a);
    const wallHit = this.city.world.raycast(M.x, M.z, dx, dz, RANGE, bulletFilter);
    const maxT = wallHit ? wallHit.t : RANGE;
    const carHit = this._rayCars(M.x, M.z, dx, dz, maxT);
    const pedHit = this.peds.raycast(M.x, M.z, dx, dz, carHit ? carHit.t : maxT);
    let t = maxT, hy = M.y - maxT * 0.012;
    if (carHit && !pedHit) {
      t = carHit.t;
      const hx = M.x + dx * t, hz = M.z + dz * t;
      const r = carHit.car;
      hy = r.y + 0.9;
      this.fx.sparks(hx, hy, hz, -dx, -dz, 6);
      if (Math.random() < 0.35) this.audio.impact();
      if (!r.wrecked) {
        r.lastAttacker = car;
        r.lastAttackAt = performance.now();
        r.applyDamage(CAR_BULLET_DAMAGE, hx, hz, dx, dz);
        if (this.onCarHit) this.onCarHit(r, CAR_BULLET_DAMAGE);
      }
    } else if (pedHit) {
      t = pedHit.t;
      const hx = M.x + dx * t, hz = M.z + dz * t;
      const p = pedHit.ped;
      hy = this.peds.isLying(p) ? car.y + 0.3 : car.y + 1.3;
      this.peds.bulletHit(p, dx, dz, hx, hz);
    } else if (wallHit) {
      const hx = M.x + dx * t, hz = M.z + dz * t;
      hy = Math.max(0.4, M.y - t * 0.012);
      this.fx.sparks(hx, hy, hz, wallHit.nx, wallHit.nz, 5);
      this.fx.dust(hx, hy, hz, 2);
      if (Math.random() < 0.5) {
        this.fx.blood.add(hx + wallHit.nx * 0.03, hy, hz + wallHit.nz * 0.03, wallHit.nx, 0, wallHit.nz, 0.28, 0.28, Math.random() * 6, 0.12, 0.12, 0.12, 0.9);
      }
      if (Math.random() < 0.3) this.audio.impact();
    }
    const hx = M.x + dx * t, hz = M.z + dz * t;
    this.peds.alert(hx, hz, 14);
    this.peds.alert(M.x, M.z, 20);

    // трассер
    const tr = this.tracers[this.tracerIdx];
    this.tracerIdx = (this.tracerIdx + 1) % this.tracers.length;
    const m = tr.mesh;
    m.position.set(M.x, M.y, M.z);
    m.lookAt(hx, hy, hz);
    const len = Math.hypot(hx - M.x, hy - M.y, hz - M.z);
    m.scale.set(0.06, 0.06, len);
    m.visible = true;
    tr.t = 0.07;
    m.material.opacity = 1;

    // вспышка, гильза, дымок
    this.flashT = 0.04;
    const f = car.flash;
    f.rotation.z = Math.random() * Math.PI;
    const sc = rand(0.7, 1.2);
    f.scale.set(sc, sc, sc * 1.4);
    const rx = Math.cos(M.yaw), rz = -Math.sin(M.yaw);
    this.fx.casing(M.px + rx * 0.3, M.y - 0.05, M.pz + rz * 0.3, rx * rand(2, 3.5) + car.vx, rand(2, 4), rz * rand(2, 3.5) + car.vz);
    if (Math.random() < 0.4) this.fx.muzzleSmoke(M.x, M.y, M.z);
    this.audio.shot();
    if (this.onShot) this.onShot();
  }
}

const MZ = { x: 0, y: 0, z: 0, px: 0, pz: 0, yaw: 0 };
