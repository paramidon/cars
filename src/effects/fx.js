import * as THREE from 'three';
import { ParticleSystem, KIND } from './particles.js';
import { DecalLayer } from './decals.js';
import { bloodTexture, markTexture } from '../world/textures.js';
import { rand } from '../utils.js';

/** Все визуальные эффекты в одном месте: кровь, искры, дым, огонь, вода, следы шин. */
export class FX {
  constructor(scene, groundHeight, quality) {
    this.groundHeight = groundHeight;
    this.normal = new ParticleSystem(scene, quality.maxParticles, { soft: 0.45 });
    this.glow = new ParticleSystem(scene, Math.floor(quality.maxParticles / 2), { additive: true, soft: 0.2 });
    this.blood = new DecalLayer(scene, bloodTexture(), quality.maxDecals, { renderOrder: 1 });
    this.marks = new DecalLayer(scene, markTexture(), quality.maxMarks, { renderOrder: 0 });
    // крупные пятна крови на земле: колесо, проехав по ним, начинает оставлять кровавый след
    this.spots = Array.from({ length: 160 }, () => ({ x: 0, z: 0, r2: 0 }));
    this.spotIdx = 0;
    this._onBloodLand = (x, y, z, size) => {
      if (Math.random() < 0.45) {
        const s = size * rand(2.2, 4.5);
        this._addSpot(x, z, s * 0.38);
        this.blood.add(x, y + 0.012 + Math.random() * 0.004, z, 0, 1, 0, s, s, Math.random() * 6.28, rand(0.75, 1), 1, 1, 0.95);
      }
    };
  }

  update(dt) {
    this.normal.update(dt, this.groundHeight, this._onBloodLand);
    this.glow.update(dt, this.groundHeight, null);
    this.blood.update(dt);
  }

  clear() {
    this.normal.clear();
    this.glow.clear();
    this.blood.clear();
    this.marks.clear();
    for (const sp of this.spots) sp.r2 = 0;
  }

  _addSpot(x, z, r) {
    const sp = this.spots[this.spotIdx];
    this.spotIdx = (this.spotIdx + 1) % this.spots.length;
    sp.x = x;
    sp.z = z;
    sp.r2 = r * r;
  }

  /** Место, где колёса гарантированно испачкаются (удар, раздавливание) — без отдельной декали. */
  bloodSpot(x, z, r) {
    this._addSpot(x, z, r);
  }

  /** Есть ли под точкой (x, z) лужа крови. */
  bloodAt(x, z) {
    for (const sp of this.spots) {
      const dx = x - sp.x, dz = z - sp.z;
      if (dx * dx + dz * dz < sp.r2) return true;
    }
    return false;
  }

  // ------------------------------------------------------------- кровь
  /** Фонтан крови в направлении (dx,dz) с разбросом. */
  bloodBurst(x, y, z, dx, dz, speed, count) {
    for (let i = 0; i < count; i++) {
      const s = speed * rand(0.2, 1);
      const r = rand(0.45, 0.75);
      this.normal.spawn(
        x + rand(-0.2, 0.2), y + rand(-0.2, 0.3), z + rand(-0.2, 0.2),
        dx * s + rand(-3, 3), rand(1.5, 6) + speed * rand(0, 0.3), dz * s + rand(-3, 3),
        rand(0.8, 1.6), rand(0.08, 0.2), r, 0.0, 0.0, 1, 18, 0.4, 0, KIND.BLOOD,
      );
    }
  }

  /** Брызги от пули: узкий конус по направлению выстрела. */
  bloodSpray(x, y, z, dx, dz, count = 8) {
    for (let i = 0; i < count; i++) {
      const s = rand(2, 7);
      this.normal.spawn(x, y, z, dx * s + rand(-1.2, 1.2), rand(-0.5, 2.5), dz * s + rand(-1.2, 1.2),
        rand(0.5, 1.1), rand(0.06, 0.14), rand(0.5, 0.8), 0, 0, 1, 16, 0.6, 0, KIND.BLOOD);
    }
    // красная дымка
    for (let i = 0; i < 3; i++) {
      this.normal.spawn(x, y, z, dx * rand(0.5, 2), rand(0, 0.5), dz * rand(0.5, 2), 0.35, 0.35, 0.6, 0.02, 0.02, 0.5, 0, 2, 2.5, KIND.SMOKE);
    }
  }

  bloodPool(x, z, size, duration = 2) {
    this._addSpot(x, z, size * 0.42);
    const y = this.groundHeight(x, z) + 0.01 + Math.random() * 0.005;
    this.blood.addGrowing(x, y, z, size, duration, rand(0.65, 0.85), 1, 1, 1);
  }

  bloodSplat(x, z, size) {
    if (size >= 0.9) this._addSpot(x, z, size * 0.4);
    const y = this.groundHeight(x, z) + 0.012 + Math.random() * 0.005;
    this.blood.add(x, y, z, 0, 1, 0, size, size, Math.random() * 6.28, rand(0.8, 1), 1, 1, 1);
  }

  /** Кровавое пятно на вертикальной стене. */
  wallSplat(x, y, z, nx, nz, size) {
    this.blood.add(x + nx * 0.03, y, z + nz * 0.03, nx, 0, nz, size, size, Math.random() * 6.28, rand(0.85, 1), 1, 1, 1);
  }

  // ------------------------------------------------------------- огонь, искры, дым
  sparks(x, y, z, nx, nz, count = 10) {
    for (let i = 0; i < count; i++) {
      const s = rand(3, 11);
      this.glow.spawn(x, y, z, nx * s + rand(-4, 4), rand(0.5, 6), nz * s + rand(-4, 4),
        rand(0.2, 0.5), rand(0.05, 0.11), 1, rand(0.7, 0.95), 0.35, 1, 15, 1, 0, KIND.SPARK);
    }
  }

  muzzleSmoke(x, y, z) {
    this.normal.spawn(x, y, z, rand(-0.3, 0.3), rand(0.3, 1), rand(-0.3, 0.3), 0.6, 0.25, 0.75, 0.75, 0.75, 0.25, -1, 1, 3, KIND.SMOKE);
  }

  smoke(x, y, z, dark = 0.4, size = 0.9) {
    const c = rand(0.15, 0.25) + (1 - dark) * 0.45;
    this.normal.spawn(x + rand(-0.2, 0.2), y, z + rand(-0.2, 0.2), rand(-0.4, 0.4), rand(1.2, 2.4), rand(-0.4, 0.4),
      rand(1.6, 2.8), size, c, c, c, 0.55, -0.6, 0.5, 2.8, KIND.SMOKE);
  }

  tireSmoke(x, y, z) {
    this.normal.spawn(x, y, z, rand(-0.5, 0.5), rand(0.4, 1.2), rand(-0.5, 0.5), rand(0.8, 1.3), 0.7, 0.85, 0.85, 0.85, 0.35, -0.5, 1.2, 3, KIND.SMOKE);
  }

  fire(x, y, z, size = 0.7) {
    this.glow.spawn(x + rand(-0.3, 0.3), y, z + rand(-0.3, 0.3), rand(-0.4, 0.4), rand(1.5, 3.5), rand(-0.4, 0.4),
      rand(0.4, 0.8), size * rand(0.7, 1.2), 1, 0.85, 0.35, 0.9, -1, 0.5, -0.4, KIND.FIRE);
  }

  explosion(x, y, z) {
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(2, 12);
      this.glow.spawn(x, y + rand(0, 1), z, Math.cos(a) * s, rand(1, 10), Math.sin(a) * s,
        rand(0.4, 1.1), rand(0.6, 1.6), 1, 0.8, 0.3, 1, 2, 2, -0.3, KIND.FIRE);
    }
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(1, 5);
      this.normal.spawn(x, y + rand(0, 2), z, Math.cos(a) * s, rand(2, 6), Math.sin(a) * s,
        rand(2, 4), rand(1.5, 2.8), 0.12, 0.11, 0.1, 0.7, -0.4, 1.2, 2, KIND.SMOKE);
    }
    this.sparks(x, y + 1, z, 0, 0, 40);
    this.blood.add(x, this.groundHeight(x, z) + 0.02, z, 0, 1, 0, 7, 7, Math.random() * 6, 0.05, 0.04, 0.04, 0.85);
  }

  glass(x, y, z, count = 14) {
    for (let i = 0; i < count; i++) {
      this.normal.spawn(x, y, z, rand(-4, 4), rand(1, 5), rand(-4, 4), rand(1, 2), rand(0.05, 0.1), 0.7, 0.85, 0.95, 0.9, 18, 0.5, 0, KIND.BOUNCE);
    }
  }

  dust(x, y, z, count = 6) {
    for (let i = 0; i < count; i++) {
      this.normal.spawn(x, y, z, rand(-1.5, 1.5), rand(0.2, 1.5), rand(-1.5, 1.5), rand(0.6, 1.2), rand(0.4, 0.8), 0.62, 0.58, 0.5, 0.4, 0, 1.5, 2, KIND.DUST);
    }
  }

  casing(x, y, z, vx, vy, vz) {
    this.normal.spawn(x, y, z, vx, vy, vz, 1.4, 0.07, 0.85, 0.65, 0.2, 1, 20, 0.2, 0, KIND.BOUNCE);
  }

  water(x, y, z, power = 1) {
    this.normal.spawn(x, y, z, rand(-0.8, 0.8), rand(6, 10) * power, rand(-0.8, 0.8), rand(0.8, 1.4), rand(0.12, 0.22), 0.75, 0.88, 1, 0.75, 14, 0.2, 0.8, KIND.WATER);
  }

  gibTrail(x, y, z) {
    this.normal.spawn(x, y, z, rand(-0.5, 0.5), rand(-0.5, 0.5), rand(-0.5, 0.5), 0.8, rand(0.07, 0.14), 0.55, 0, 0, 1, 14, 0.2, 0, KIND.BLOOD);
  }

  // ------------------------------------------------------------- следы
  tireMark(x, z, yaw, len, r, g, b, opacity) {
    const y = this.groundHeight(x, z) + 0.008;
    this.marks.add(x, y, z, 0, 1, 0, 0.28, len, yaw, r, g, b, opacity);
  }
}
