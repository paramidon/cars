import * as THREE from 'three';
import { sameTeam } from './car.js';
import { clamp, rand, wrapAngle } from './utils.js';

/** Пулемёт — второе оружие человека (у ботов только пушка). Крутить здесь. */
export const MG = {
  rate: 14, // выстрелов в секунду
  range: 85, // м
  spread: 0.025, // разброс, рад
  carDamage: 0.7, // урон машине одной пулей (≈10 в секунду — как у пушки, но без взрыва и толчка)
  pedShots: 3, // столько пуль валят стоящего пешехода насмерть
  downShots: 2, // а сбитого с ног (лежит, поднимается) — столько
  heatTime: 4, // с непрерывной стрельбы до перегрева
  coolTime: 2.5, // с от полного нагрева до холодного; перегретый не стреляет, пока не остынет совсем
  autoCone: 0.436, // классика: башня сама доворачивает на цель в этом секторе перед носом, рад (±25°)
  autoRange: 55, // м
  turn: 7, // скорость доворота башни, рад/с
};

const bulletFilter = (c) => c.kind !== 'breakable' && c.h >= 1.5;
const _m = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0 };

/** Пули всех пулемётов: трассеры, попадания, нагрев. Пули мгновенные (луч), летит только трассер. */
export class MachineGuns {
  constructor(scene, city, fx, audio) {
    this.world = city.world;
    this.fx = fx;
    this.audio = audio;
    this.peds = null;
    this.phys = null; // Rapier (?phys=rapier): bullets fly in 3D against its static colliders
    this.listener = null;
    this.onCarHit = null; // (victim, shooter, dmg, x, z, dx, dz) — моя пуля попала в машину
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0, 0.5);
    this.tracers = Array.from({ length: 32 }, () => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      return { mesh: m, t: 0 };
    });
    this.next = 0;
  }

  clear() {
    for (const tr of this.tracers) {
      tr.t = 0;
      tr.mesh.visible = false;
    }
  }

  /**
   * Классика: башня сама доворачивает на ближайшую цель перед носом (пешеход или чужая машина),
   * без цели — смотрит вперёд. aim = false — просто вернуть башню вперёд (выбрана пушка).
   */
  autoAim(car, cars, dt, aim = true) {
    let want = 0;
    if (aim && !car.wrecked) {
      car.mgRetarget = (car.mgRetarget || 0) - dt;
      if (car.mgRetarget <= 0) {
        car.mgRetarget = 0.12;
        car.mgTarget = this._pick(car, cars);
      }
      const t = car.mgTarget;
      if (t && (t.isCar ? !t.wrecked : this.peds.isAlive(t))) want = wrapAngle(Math.atan2(t.x - car.x, t.z - car.z) - car.yaw);
      else car.mgTarget = null;
    }
    const d = wrapAngle(want - car.turretYaw);
    car.turretYaw = wrapAngle(car.turretYaw + clamp(d, -MG.turn * dt, MG.turn * dt));
  }

  _pick(car, cars) {
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    let best = null, bs = Infinity;
    const consider = (o, d, dx, dz, extra) => {
      if (d > MG.autoRange || d < 2) return;
      const ang = Math.acos(clamp((dx * fx + dz * fz) / d, -1, 1));
      if (ang > MG.autoCone) return;
      const score = ang * 25 + d + extra;
      if (score < bs && !this.world.raycast(car.x, car.z, dx / d, dz / d, d, bulletFilter)) {
        bs = score;
        best = o;
      }
    };
    for (const p of this.peds.peds) {
      if (!this.peds.isAlive(p)) continue;
      const dx = p.x - car.x, dz = p.z - car.z;
      consider(p, Math.hypot(dx, dz), dx, dz, 0);
    }
    for (const c of cars) {
      if (c === car || c.wrecked || sameTeam(c, car)) continue;
      const dx = c.x - car.x, dz = c.z - car.z;
      const t = { isCar: true, car: c, get x() { return c.x; }, get z() { return c.z; }, get wrecked() { return c.wrecked; } };
      consider(t, Math.hypot(dx, dz), dx, dz, 4); // пешеходы чуть в приоритете
    }
    return best;
  }

  /**
   * Кадр пулемёта машины: firing — жмут на курок. local = true — пули считаю я (урон машинам и пешеходам),
   * false — только трассеры и звук (стреляет кто-то другой по сети). Возвращает, стреляет ли сейчас.
   */
  update(car, dt, firing, cars, local = true) {
    const cool = dt / MG.coolTime;
    car.mgCD = Math.max(0, (car.mgCD || 0) - dt);
    const shooting = firing && !car.wrecked && !car.mgLock;
    if (shooting) {
      car.mgHeat = Math.min(1, (car.mgHeat || 0) + dt / MG.heatTime);
      if (car.mgHeat >= 1 && local) car.mgLock = true;
      while (car.mgCD <= 0) {
        car.mgCD += 1 / MG.rate;
        this._fire(car, cars, local);
      }
    } else {
      car.mgHeat = Math.max(0, (car.mgHeat || 0) - cool);
      if (car.mgHeat === 0) car.mgLock = false;
    }
    return shooting;
  }

  _fire(car, cars, local) {
    const m = Object.assign(_m, car.muzzle());
    const a = Math.atan2(m.dx, m.dz) + rand(-MG.spread, MG.spread);
    // (dx, dz) — the heading, unit; the bullet flies along (dx·fh, dy, dz·fh), fh = cos of its slope
    const dx = Math.sin(a), dz = Math.cos(a), dy = m.dy, fh = Math.sqrt(1 - dy * dy);
    let t, wall; // t — distance along the bullet's flight (3D), wall — { nx, nz } of a wall it hit
    if (this.phys) {
      wall = this.phys.castStatic(m.x, m.y, m.z, dx * fh, dy, dz * fh, MG.range);
      t = wall ? wall.t : MG.range;
    } else {
      wall = this.world.raycast(m.x, m.z, dx, dz, MG.range, bulletFilter);
      t = wall ? wall.t : MG.range;
    }
    let hitCar = null;
    for (const c of cars) {
      if (c === car || c.wrecked || sameTeam(c, car)) continue; // своих пули не трогают
      const ct = c.rayHit(m.x, m.y, m.z, dx * fh, dy, dz * fh, t);
      if (ct >= 0 && ct < t) {
        t = ct;
        hitCar = c;
      }
    }
    const ph = this.peds.raycast(m.x, m.z, dx, dz, t * fh);
    if (ph) {
      t = ph.t / fh;
      hitCar = null;
    }
    const hx = m.x + dx * fh * t, hz = m.z + dz * fh * t;
    let hy = this.phys ? m.y + dy * t : m.y - t * 0.012;
    if (hitCar) {
      if (!this.phys) hy = hitCar.y + 0.9;
      this.fx.sparks(hx, hy, hz, -dx, -dz, 5);
      if (Math.random() < 0.35) this.audio.impact();
      if (local && this.onCarHit) this.onCarHit(hitCar, car, MG.carDamage, hx, hz, dx, dz);
    } else if (ph) {
      const g = this.phys ? this.peds.city.groundHeight(ph.ped.x, ph.ped.z) : car.y;
      hy = this.peds.isLying(ph.ped) ? g + 0.3 : g + 1.3;
      if (local) this.peds.shoot(ph.ped, dx, dz, car);
      else this.fx.bloodBurst(ph.ped.x, hy, ph.ped.z, dx, dz, 3, 4);
    } else if (wall) {
      if (!this.phys) hy = Math.max(0.4, hy);
      this.fx.sparks(hx, hy, hz, wall.nx, wall.nz, 4);
      this.fx.dust(hx, hy, hz, 2);
      if (Math.random() < 0.3) this.audio.impact();
    }
    if (local) {
      this.peds.alert(hx, hz, 14);
      this.peds.alert(m.x, m.z, 20);
    }

    // трассер, вспышка, гильза
    const tr = this.tracers[this.next];
    this.next = (this.next + 1) % this.tracers.length;
    tr.mesh.position.set(m.x, m.y, m.z);
    tr.mesh.lookAt(hx, hy, hz);
    tr.mesh.scale.set(0.06, 0.06, Math.hypot(hx - m.x, hy - m.y, hz - m.z));
    tr.mesh.material.opacity = 1;
    tr.mesh.visible = true;
    tr.t = 0.07;
    car.kick(0.35);
    const rx = Math.cos(a), rz = -Math.sin(a);
    this.fx.casing(m.x - dx * 1.8 + rx * 0.3, m.y - 0.1, m.z - dz * 1.8 + rz * 0.3, rx * rand(2, 3.5) + car.vx, rand(2, 4), rz * rand(2, 3.5) + car.vz);
    if (Math.random() < 0.3) this.fx.muzzleSmoke(m.x, m.y, m.z);
    this.audio.shot(car.vol());
  }

  /** Трассеры гаснут. */
  tick(dt) {
    for (const tr of this.tracers) {
      if (tr.t <= 0) continue;
      tr.t -= dt;
      tr.mesh.material.opacity = Math.max(0, tr.t / 0.07);
      if (tr.t <= 0) tr.mesh.visible = false;
    }
  }
}
