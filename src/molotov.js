import * as THREE from 'three';
import { rand } from './utils.js';

/** Коктейли Молотова: их кидают некоторые пешеходы. Крутить здесь. */
export const MOLOTOV = {
  share: 0.08, // доля пешеходов с бутылкой (решается по номеру поколения — у всех игроков одни и те же)
  range: [8, 30], // м — кидают в машину не ближе и не дальше
  cooldown: [5, 9], // с между бросками одного пешехода
  windup: 0.6, // с замаха: рука с горящей бутылкой над головой
  speed: 15, // м/с по горизонтали (время полёта — по расстоянию, 0.4–1.8 с)
  miss: 1.6, // м — разброс точки, куда целятся (бегущую машину упреждают не до конца)
  damage: 6, // урон машине прямым попаданием
  burn: 3, // с горит лужа на месте разбитой бутылки (просто огонь, урона нет)
  gravity: 18,
};

const wallFilter = (c) => c.kind !== 'breakable' && c.h >= 1.5;

/** Летящие бутылки и горящие лужи. */
export class Molotovs {
  constructor(scene, city, fx, audio) {
    this.world = city.world;
    this.ground = city.groundHeight;
    this.fx = fx;
    this.audio = audio;
    this.cars = [];
    this.listener = null;
    this.onCarHit = null; // (car, dmg) — бутылка разбилась о мою машину (или о бота, которого считаю я)
    this.items = [];
    this.fires = [];
    const geo = new THREE.CylinderGeometry(0.07, 0.09, 0.3, 8);
    const mat = new THREE.MeshLambertMaterial({ color: 0x3f8a3a, emissive: 0x1a3a10 });
    this.pool = Array.from({ length: 16 }, () => {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      scene.add(m);
      return m;
    });
  }

  clear() {
    for (const b of this.items) b.mesh.visible = false;
    this.items.length = 0;
    this.fires.length = 0;
  }

  /** Бросок: откуда и с какой скоростью (у всех игроков одинаково — по сети приходит то же). */
  throw(x, y, z, vx, vy, vz) {
    const mesh = this.pool.find((m) => !m.visible) || this.items.shift()?.mesh;
    if (!mesh) return;
    mesh.visible = true;
    mesh.position.set(x, y, z);
    this.items.push({ x, y, z, vx, vy, vz, mesh, trail: 0, spin: rand(8, 14) });
  }

  _vol(x, z) {
    const l = this.listener;
    return l ? Math.max(0, 1 - Math.hypot(x - l.x, z - l.z) / 90) ** 2 : 1;
  }

  /** Бутылка разбилась: вспышка огня и лужа, которая ещё погорит. */
  _shatter(x, y, z) {
    for (let k = 0; k < 14; k++) this.fx.fire(x + rand(-0.8, 0.8), y + rand(0, 0.6), z + rand(-0.8, 0.8), rand(0.6, 1.2));
    this.fx.glass(x, y, z, 8);
    this.audio.molotov(this._vol(x, z));
    this.fires.push({ x, z, t: MOLOTOV.burn, acc: 0 });
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const b = this.items[i];
      const nx = b.x + b.vx * dt, nz = b.z + b.vz * dt;
      b.vy -= MOLOTOV.gravity * dt;
      const ny = b.y + b.vy * dt;
      let done = false;
      // о машину: this step's flight enters the car's box (turned with its body), grown by 0.3 m
      for (const car of this.cars) {
        if (car.wrecked) continue;
        const t = car.segHit(b.x, b.y, b.z, nx, ny, nz, 0.3);
        if (t < 0) continue;
        this._shatter(b.x + (nx - b.x) * t, Math.max(b.y + (ny - b.y) * t, car.y + 1), b.z + (nz - b.z) * t);
        if (!car.remote && this.onCarHit) this.onCarHit(car, MOLOTOV.damage, nx, nz, b.vx, b.vz);
        done = true;
        break;
      }
      if (!done) {
        const step = Math.hypot(nx - b.x, nz - b.z);
        const w = ny < 6 && step > 0 ? this.world.raycast(b.x, b.z, (nx - b.x) / step, (nz - b.z) / step, step, wallFilter) : null;
        if (w) {
          this._shatter(b.x + ((nx - b.x) / step) * w.t, ny, b.z + ((nz - b.z) / step) * w.t);
          done = true;
        } else if (ny <= this.ground(nx, nz) + 0.1) {
          this._shatter(nx, this.ground(nx, nz) + 0.1, nz);
          done = true;
        }
      }
      if (done) {
        b.mesh.visible = false;
        this.items.splice(i, 1);
        continue;
      }
      b.x = nx;
      b.y = ny;
      b.z = nz;
      b.mesh.position.set(nx, ny, nz);
      b.mesh.rotation.x += b.spin * dt;
      b.mesh.rotation.z += b.spin * 0.6 * dt;
      b.trail -= dt;
      if (b.trail <= 0) {
        b.trail = 0.03;
        this.fx.fire(nx, ny + 0.15, nz, 0.3);
      }
    }
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.t -= dt;
      f.acc -= dt;
      if (f.acc <= 0) {
        f.acc = 0.07;
        const k = Math.min(1, f.t / 1.5);
        this.fx.fire(f.x + rand(-1, 1), this.ground(f.x, f.z) + 0.1, f.z + rand(-1, 1), rand(0.5, 0.9) * (0.4 + k * 0.6));
      }
      if (f.t <= 0) this.fires.splice(i, 1);
    }
  }
}
