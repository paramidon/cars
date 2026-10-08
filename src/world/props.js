import * as THREE from 'three';
import { GeoBuilder, addBox, addCyl } from './geom.js';
import { rand } from '../utils.js';

const col = (hex) => new THREE.Color(hex);

function buildLamp() {
  const b = new GeoBuilder();
  const dark = col('#3b3f45');
  addCyl(b, 0, 0, 0, 0.17, 0.6, dark, 8);
  addCyl(b, 0, 0, 0, 0.09, 6.4, dark, 8, 0.07);
  addBox(b, 0, 6.3, 0.75, 0.09, 0.09, 1.6, dark);
  addBox(b, 0, 6.22, 1.5, 0.36, 0.14, 0.62, dark);
  addBox(b, 0, 6.13, 1.5, 0.3, 0.06, 0.52, col('#fff4c8'));
  return b.build();
}

function buildTraffic() {
  const b = new GeoBuilder();
  const dark = col('#2f3236');
  addCyl(b, 0, 0, 0, 0.1, 4.4, dark, 8);
  addBox(b, 0, 3.9, 0.12, 0.38, 1.1, 0.32, col('#1d1f22'));
  addBox(b, 0, 4.22, 0.29, 0.22, 0.22, 0.04, col('#e53935'));
  addBox(b, 0, 3.9, 0.29, 0.22, 0.22, 0.04, col('#fbc02d'));
  addBox(b, 0, 3.58, 0.29, 0.22, 0.22, 0.04, col('#43a047'));
  return b.build();
}

function buildSign() {
  const b = new GeoBuilder();
  addCyl(b, 0, 0, 0, 0.05, 2.5, col('#9aa0a6'), 6);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(0, 2.55, 0.06),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, Math.PI / 8)),
    new THREE.Vector3(0.4, 0.04, 0.4),
  );
  b.addGeometry(new THREE.CylinderGeometry(1, 1, 1, 8).toNonIndexed(), m, col('#c62828'));
  addBox(b, 0, 2.55, 0.085, 0.42, 0.08, 0.01, col('#ffffff'));
  return b.build();
}

function buildBin() {
  const b = new GeoBuilder();
  addCyl(b, 0, 0, 0, 0.3, 0.9, col('#2f6b3a'), 10, 0.33);
  addCyl(b, 0, 0.9, 0, 0.35, 0.08, col('#24532d'), 10);
  return b.build();
}

function buildHydrant() {
  const b = new GeoBuilder();
  const red = col('#c62828');
  addCyl(b, 0, 0, 0, 0.17, 0.7, red, 8);
  addCyl(b, 0, 0.7, 0, 0.2, 0.08, red, 8);
  addCyl(b, 0, 0.78, 0, 0.12, 0.12, col('#e0b000'), 8);
  addBox(b, 0, 0.5, 0, 0.5, 0.12, 0.12, red);
  return b.build();
}

function buildBench() {
  const b = new GeoBuilder();
  const wood = col('#8d5a33');
  const iron = col('#2e2e2e');
  addBox(b, 0, 0.45, 0, 1.7, 0.08, 0.5, wood);
  addBox(b, 0, 0.8, -0.24, 1.7, 0.4, 0.06, wood);
  for (const x of [-0.7, 0.7]) {
    addBox(b, x, 0.22, 0, 0.08, 0.45, 0.45, iron);
    addBox(b, x, 0.65, -0.24, 0.08, 0.5, 0.06, iron);
  }
  return b.build();
}

export const PROP_TYPES = {
  lamp: { build: buildLamp, radius: 0.22, mode: 'topple', slow: 0.1, size: 0.12 },
  traffic: { build: buildTraffic, radius: 0.2, mode: 'topple', slow: 0.1, size: 0.15 },
  sign: { build: buildSign, radius: 0.14, mode: 'topple', slow: 0.04, size: 0.06 },
  bin: { build: buildBin, radius: 0.36, mode: 'fly', slow: 0.04, size: 0.35 },
  hydrant: { build: buildHydrant, radius: 0.24, mode: 'fly', slow: 0.07, size: 0.2, water: true },
  bench: { build: buildBench, radius: 0.85, mode: 'fly', slow: 0.1, size: 0.3 },
};

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _up = new THREE.Vector3(0, 1, 0);

/** Ломаемая уличная мелочь: фонари, светофоры, знаки, урны, гидранты, скамейки. */
export class Breakables {
  constructor(scene, world, placements, groundHeight, debris, fx, audio, quality) {
    this.scene = scene;
    this.world = world;
    this.debris = debris;
    this.fx = fx;
    this.audio = audio;
    this.groundHeight = groundHeight;
    this.items = [];
    this.meshes = {};
    this.geoms = {};
    this.water = [];
    this.onBreak = null; // (предмет, vx, vz): сломан здесь — по сети сообщить остальным
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });

    const byType = {};
    for (const p of placements) {
      const def = PROP_TYPES[p.type];
      // id — номер в общем списке: город строится из одного зерна, у всех игроков номера совпадают
      const item = { ...p, def, alive: true, y: groundHeight(p.x, p.z), index: 0, id: this.items.length };
      item.collider = world.addCircle(p.x, p.z, def.radius, { kind: 'breakable', prop: item, h: 3 });
      (byType[p.type] ||= []).push(item);
      this.items.push(item);
    }
    for (const [type, list] of Object.entries(byType)) {
      const geo = PROP_TYPES[type].build();
      this.geoms[type] = geo;
      const mesh = new THREE.InstancedMesh(geo, this.material, list.length);
      mesh.castShadow = quality.shadows;
      mesh.receiveShadow = quality.shadows;
      list.forEach((it, i) => {
        it.index = i;
        it.mesh = mesh;
      });
      this.meshes[type] = mesh;
      scene.add(mesh);
    }
    this.reset();
  }

  _matrix(it) {
    _q.setFromAxisAngle(_up, it.yaw);
    return _m.compose(_p.set(it.x, it.y, it.z), _q, _s);
  }

  reset() {
    for (const it of this.items) {
      it.alive = true;
      it.collider.active = true;
      it.mesh.setMatrixAt(it.index, this._matrix(it));
    }
    for (const m of Object.values(this.meshes)) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
    this.water.length = 0;
  }

  /** Убрать предмет со своего места (без обломков). */
  _remove(it) {
    it.alive = false;
    it.collider.active = false;
    it.mesh.setMatrixAt(it.index, _zero);
    it.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Машина врезалась в предмет. Возвращает true — предмет сломан и не мешает.
   * local = false — сломан у другого игрока (пришло по сети): onBreak не зовём.
   */
  hit(it, car, local = true) {
    if (!it.alive) return true;
    const speed = Math.hypot(car.vx, car.vz);
    if (local && this.onBreak) this.onBreak(it, car.vx, car.vz);
    this._remove(it);

    const obj = new THREE.Mesh(this.geoms[it.type], this.material);
    obj.castShadow = true;
    obj.position.set(it.x, it.y, it.z);
    obj.quaternion.setFromAxisAngle(_up, it.yaw);
    this.scene.add(obj);
    const def = it.def;
    const dirx = car.vx / (speed || 1), dirz = car.vz / (speed || 1);
    if (def.mode === 'topple') {
      this.debris.spawn(obj, {
        mode: 'topple',
        dirx, dirz,
        omega: 0.6 + speed * 0.12,
        vx: car.vx * 0.45,
        vz: car.vz * 0.45,
        radius: def.size,
      });
    } else {
      this.debris.spawn(obj, {
        mode: 'fly',
        vx: car.vx * rand(0.8, 1.15) + rand(-1.5, 1.5),
        vy: 3 + speed * rand(0.12, 0.25),
        vz: car.vz * rand(0.8, 1.15) + rand(-1.5, 1.5),
        wx: rand(-8, 8), wy: rand(-4, 4), wz: rand(-8, 8),
        radius: def.size,
      });
    }
    car.vx *= 1 - def.slow;
    car.vz *= 1 - def.slow;
    this.fx.sparks(it.x, it.y + 0.8, it.z, -dirx, -dirz, 8);
    this.fx.dust(it.x, it.y + 0.3, it.z, 4);
    this.audio.metal(Math.min(1, speed / 20) * (car.vol ? car.vol() : 1));
    if (def.water) this.water.push({ x: it.x, y: it.y + 0.5, z: it.z, t: 14 });
    return true;
  }

  /** Сломан у другого игрока: та же картина — обломки летят по его скорости удара. */
  breakNet(id, vx, vz, vol) {
    const it = this.items[id];
    if (it && it.alive) this.hit(it, { vx, vz, vol: () => vol }, false);
  }

  /** Вернулся в идущий заезд: сломанное до тебя просто убрать, без обломков и звука. */
  removeIds(ids) {
    for (const id of ids) {
      const it = this.items[id];
      if (it && it.alive) this._remove(it);
    }
  }

  /** Взрыв: всё ломаемое рядом летит в стороны. */
  blast(x, z, r) {
    for (const it of this.items) {
      if (!it.alive) continue;
      const dx = it.x - x, dz = it.z - z;
      const d = Math.hypot(dx, dz);
      if (d > r) continue;
      const k = (1 - d / r) * 14 + 4;
      const nx = dx / (d || 1), nz = dz / (d || 1);
      this.hit(it, { vx: nx * k, vz: nz * k, vol: () => 0.5 });
    }
  }

  update(dt) {
    for (let i = this.water.length - 1; i >= 0; i--) {
      const w = this.water[i];
      w.t -= dt;
      if (w.t <= 0) {
        this.water.splice(i, 1);
        continue;
      }
      const power = Math.min(1, w.t / 4);
      const n = Math.random() < dt * 60 ? 2 : 1;
      for (let k = 0; k < n; k++) this.fx.water(w.x, w.y, w.z, power);
    }
  }
}
