import * as THREE from 'three';
import { HIT_Z, HIT_R, sameTeam } from './car.js';
import { rayCircle } from './physics/collision.js';
import { rand } from './utils.js';

/** Пушка: одна на каждой машине, бьёт только по курсу. Крутить здесь. */
export const CANNON = {
  reload: 1.2, // с между выстрелами у игрока
  botReload: 1.8, // у ботов — дольше
  botSpread: 0.035, // разброс выстрела бота, рад (≈1.5 м на 40 м)
  speed: 95, // м/с снаряда (плюс скорость машины)
  range: 120, // м, дальше снаряд гаснет
  direct: 16, // урон машине прямым попаданием (≈5 попаданий на машину)
  splash: 9, // урон взрывом в эпицентре, к краю убывает
  radius: 4.2, // радиус взрыва, м
  push: 7, // толчок машин взрывом, м/с
  recoil: 1.6, // отдача стреляющей машине, м/с
  carHitR: HIT_R + 0.4, // попасть в машину чуть проще, чем в неё врезаться
};

const shellFilter = (c) => c.kind !== 'breakable' && c.h >= 1.2;
// «убийца» пешеходов от чужого выстрела по сети: у стрелявшего свои пешеходы и свой счёт
const REMOTE_SHOT = { remote: true };

/** Снаряды всех машин. */
export class Artillery {
  constructor(scene, city, fx, audio) {
    this.scene = scene;
    this.world = city.world;
    this.fx = fx;
    this.audio = audio;
    this.cars = [];
    this.peds = null;
    this.breakables = null;
    this.listener = null;
    this.onBlast = null; // (x, z, shooter)
    this.onCarHit = null; // (car, shooter, damage, direct)
    this.shells = [];
    const geo = new THREE.SphereGeometry(0.2, 10, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffe08a });
    this.pool = Array.from({ length: 24 }, () => {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      scene.add(m);
      return m;
    });
  }

  clear() {
    for (const s of this.shells) s.mesh.visible = false;
    this.shells.length = 0;
  }

  /**
   * Выстрел машины прямо по курсу. Возвращает выстрел { x, y, z, dx, dz, v } или null, если пушка не заряжена.
   * shot — готовый выстрел чужой машины по сети: летит отсюда, без перезарядки и отдачи.
   */
  fire(car, shot = null) {
    if (car.wrecked || (!shot && car.reload > 0)) return null;
    let m = shot;
    if (!m) {
      car.reload = car.isPlayer ? CANNON.reload : CANNON.botReload;
      m = car.muzzle();
      if (!car.isPlayer) {
        // бот целится хуже человека
        const a = Math.atan2(m.dx, m.dz) + rand(-CANNON.botSpread, CANNON.botSpread);
        m.dx = Math.sin(a);
        m.dz = Math.cos(a);
      }
      m.v = CANNON.speed + Math.max(0, car.vx * m.dx + car.vz * m.dz);
    }
    const mesh = this.pool.find((x) => !x.visible) || this.shells.shift()?.mesh;
    mesh.visible = true;
    mesh.position.set(m.x, m.y, m.z);
    this.shells.push({ x: m.x, y: m.y, z: m.z, dx: m.dx, dz: m.dz, v: m.v, dist: 0, owner: car, mesh, trail: 0, local: !shot });
    if (!car.remote) {
      car.vx -= m.dx * CANNON.recoil;
      car.vz -= m.dz * CANNON.recoil;
    }
    car.kick();
    for (let i = 0; i < 6; i++) this.fx.muzzleSmoke(m.x + m.dx * rand(0, 1), m.y, m.z + m.dz * rand(0, 1));
    this.fx.sparks(m.x, m.y, m.z, m.dx, m.dz, 6);
    this.audio.cannon(car.vol());
    return m;
  }

  update(dt) {
    for (const car of this.cars) car.reload = Math.max(0, car.reload - dt);
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      const step = s.v * dt;
      let t = step, hitCar = null, hitPed = null, hitWall = false;
      const w = this.world.raycast(s.x, s.z, s.dx, s.dz, step, shellFilter);
      if (w) {
        t = w.t;
        hitWall = true;
      }
      for (const car of this.cars) {
        if (car === s.owner || sameTeam(car, s.owner)) continue; // своих снаряд пролетает насквозь
        const sn = Math.sin(car.yaw), cs = Math.cos(car.yaw);
        for (const o of HIT_Z) {
          const ct = rayCircle(s.x, s.z, s.dx, s.dz, car.x + sn * o, car.z + cs * o, CANNON.carHitR);
          if (ct >= 0 && ct < t) {
            t = ct;
            hitCar = car;
            hitWall = false;
          }
        }
      }
      if (this.peds) {
        const ph = this.peds.raycast(s.x, s.z, s.dx, s.dz, t, true);
        if (ph) {
          t = ph.t;
          hitPed = ph.ped;
          hitCar = null;
          hitWall = false;
        }
      }
      if (hitWall || hitCar || hitPed || s.dist + step >= CANNON.range) {
        const x = s.x + s.dx * t, z = s.z + s.dz * t;
        if (hitWall || hitCar || hitPed) this.blast(x, s.y, z, s.owner, hitCar, s.local);
        else {
          this.fx.smoke(x, s.y, z, 0.6, 0.6);
          this.fx.smoke(x, s.y, z, 0.6, 0.6);
        }
        s.mesh.visible = false;
        this.shells.splice(i, 1);
        continue;
      }
      s.x += s.dx * step;
      s.z += s.dz * step;
      s.dist += step;
      s.mesh.position.set(s.x, s.y, s.z);
      // дымный огненный след
      s.trail -= dt;
      if (s.trail <= 0) {
        s.trail = 0.012;
        this.fx.fire(s.x - s.dx * 0.4, s.y, s.z - s.dz * 0.4, 0.35);
        if (Math.random() < 0.5) this.fx.muzzleSmoke(s.x, s.y, s.z);
      }
    }
  }

  /** Взрыв снаряда: урон и толчок машинам, пешеходы в клочья или в полёт, уличная мелочь — в стороны. */
  blast(x, y, z, shooter, directCar = null, local = true) {
    const R = CANNON.radius;
    this.fx.blast(x, Math.max(0.6, y - 0.6), z);
    const lis = this.listener;
    const v = lis ? Math.max(0, 1 - Math.hypot(x - lis.x, z - lis.z) / 120) ** 2 : 1;
    this.audio.boom(Math.max(0.05, v));
    const now = performance.now();
    for (const car of this.cars) {
      if (car.wrecked || sameTeam(car, shooter)) continue; // дружественного огня нет
      const dx = car.x - x, dz = car.z - z;
      const d = Math.max(0, Math.hypot(dx, dz) - 1.1);
      const k = Math.max(0, 1 - d / R);
      const direct = car === directCar;
      if (!direct && k <= 0) continue;
      const dmg = (direct ? CANNON.direct : 0) + CANNON.splash * k;
      if (car.remote) {
        // чужая машина по сети: урон и толчок посчитает её владелец, здесь — только надпись стрелку
        if (car !== shooter && this.onCarHit) this.onCarHit(car, shooter, dmg, direct, local);
        continue;
      }
      const l = Math.hypot(dx, dz) || 1;
      const nx = dx / l, nz = dz / l;
      car.vx += nx * CANNON.push * Math.max(k, direct ? 0.6 : 0);
      car.vz += nz * CANNON.push * Math.max(k, direct ? 0.6 : 0);
      car.angVel += rand(-1.5, 1.5) * k;
      if (car === shooter) continue; // свой снаряд только толкает
      car.lastAttacker = shooter;
      car.lastAttackAt = now;
      car.applyDamage(dmg, x, z, nx, nz);
      if (this.onCarHit) this.onCarHit(car, shooter, dmg, direct, local);
    }
    if (this.peds) {
      this.peds.explosion(x, z, R, local ? shooter : REMOTE_SHOT);
      this.peds.alert(x, z, 30);
    }
    if (this.breakables) this.breakables.blast(x, z, R * 0.8);
    if (this.onBlast) this.onBlast(x, z, shooter);
  }
}
