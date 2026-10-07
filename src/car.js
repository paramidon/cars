import * as THREE from 'three';
import { clamp, lerp, moveToward, rand } from './utils.js';
import { circleVsCollider } from './physics/collision.js';
import { flashTexture, blobShadowTexture } from './world/textures.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Копия геометрии, сдвинутая в (x, y, z); при color — с вертекс-цветом. */
function placed(geo, x, y, z, color = null) {
  const g = geo.clone();
  g.translate(x, y, z);
  if (color) {
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }
  return g;
}

/** Предельная скорость поворота (рад/с) на скорости v (м/с) — по таблице P.yawCap. */
function yawCap(v) {
  const T = P.yawCap;
  if (v <= T[0][0]) return T[0][1];
  for (let i = 1; i < T.length; i++) {
    if (v <= T[i][0]) return lerp(T[i - 1][1], T[i][1], (v - T[i - 1][0]) / (T[i][0] - T[i - 1][0]));
  }
  return T[T.length - 1][1];
}

const P = {
  engine: 13,
  speedCurve: 40, // тяга падает квадратично к этой скорости
  brake: 26,
  reverseAccel: 8,
  maxReverse: 11,
  roll: 0.6,
  drag: 0.002,
  wheelBase: 2.7,
  grip: 9,
  hbGrip: 1.5,
  steerLow: 0.6, // наибольший угол колёс, рад
  // предельная скорость поворота машины от скорости: [м/с, рад/с], между точками — линейно.
  // Растёт только до ~40 км/ч (на малом ходу машина и так поворачивает медленно), дальше плавно падает.
  yawCap: [[11, 2.1], [17, 1.85], [22, 1.5], [28, 1.2], [35, 0.97]], // 40 км/ч 120°/с … 125 км/ч 56°/с
  // руль «тяжелеет» плавной S-кривой между hardFrom и hardTo; параметры ниже — [лёгкий руль, тяжёлый]
  hardFrom: 10, // м/с ≈ 35 км/ч
  hardTo: 35, // м/с ≈ 125 км/ч
  steerTime: [0.18, 0.4], // за сколько секунд руль доходит до упора
  steerReturn: 0.08, // а от упора к центру — всегда быстро, с любой скорости
  yawResp: [9, 5], // как быстро машина отзывается на руль
  yawUnwind: 12, // а перестаёт крутиться, когда руль выпрямили, — всегда быстро
  restitution: 0.25,
  inertia: 1.9,
  damageThreshold: 8, // м/с ≈ 29 км/ч — ниже этого удар не повреждает
  damageScale: 2.4,
};

// машина в коллизиях — три круга вдоль корпуса
export const HIT_Z = [-1.3, 0, 1.3];
export const HIT_R = 1.0;
export const CAR_INERTIA = P.inertia;
// лоб с кенгурятником держит удар: урон по передней части при ударе о столб/стену
const FRONT_ARMOR_WALL = 0.75;
export const CAR_HALF_W = 1.05;
const BLOOD_TRACK = 26; // сколько метров колесо мажет кровью после лужи
export const CAR_HALF_L = 2.35;

const HARD = new Set(['building', 'wall', 'pole', 'tree', 'pillar', 'fountain', 'statue', 'pump']);
const PEN = { nx: 0, nz: 0, depth: 0, px: 0, pz: 0 };
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

const WHEELS = [
  { x: 0.95, z: 1.42, front: true },
  { x: -0.95, z: 1.42, front: true },
  { x: 0.95, z: -1.38, front: false },
  { x: -0.95, z: -1.38, front: false },
];

function numberTexture(num, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(64, 64, 50, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#111111';
  g.font = 'bold 64px "Arial Black", Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(num), 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Car {
  /**
   * opts: color — цвет кузова, isPlayer — звук мотора и визга шин, wing — антикрыло с номером (соперники),
   * number — номер на антикрыле, wallDamage — множитель урона о стены/столбы.
   */
  constructor(scene, city, fx, audio, debris, quality, opts = {}) {
    this.scene = scene;
    this.city = city;
    this.world = city.world;
    this.fx = fx;
    this.audio = audio;
    this.debris = debris;
    this.quality = quality;
    this.opts = { color: '#b3121a', isPlayer: true, wing: false, number: null, wallDamage: 1, ...opts };
    this.isPlayer = this.opts.isPlayer;
    this.isCar = true;
    this.name = this.opts.name || 'ТЫ';
    this.listener = null; // машина игрока — звуки чужих машин тише с расстоянием
    this.lastAttacker = null;
    this.lastAttackAt = -1e9;
    this.onBreakable = null; // (collider, car) => boolean
    this.onImpact = null; // (impact) => void
    this.onWrecked = null;
    this.onDamage = null;
    this._build();
    this.reset(city.spawn);
  }

  // ------------------------------------------------------------------ модель
  _build() {
    const root = (this.root = new THREE.Group());
    const body = (this.body = new THREE.Group());
    root.add(body);
    this.scene.add(root);

    this.paintColor = new THREE.Color(this.opts.color);
    this.paint = new THREE.MeshPhongMaterial({ color: this.paintColor, shininess: 70, specular: 0x555555 });
    this.cabinMat = new THREE.MeshPhongMaterial({ color: this.paintColor, vertexColors: true, shininess: 90, specular: 0x777777 });
    this.dark = new THREE.MeshLambertMaterial({ color: 0x222326 });
    this.metal = new THREE.MeshPhongMaterial({ color: 0x9aa0a6, shininess: 80, specular: 0x888888 });
    this.headMat = new THREE.MeshBasicMaterial({ color: 0xfff6d8 });
    this.tailMat = new THREE.MeshBasicMaterial({ color: 0x7a0b0b });
    this.parts = [];

    // кузов
    const bodyGeo = new THREE.BoxGeometry(2.0, 0.6, 4.3, 8, 3, 16);
    const bp = bodyGeo.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      let x = bp.getX(i), y = bp.getY(i), z = bp.getZ(i);
      if (y > 0 && z > 0.9) y -= (z - 0.9) * 0.14; // капот к носу ниже
      if (y > 0 && z < -1.6) y -= (-1.6 - z) * 0.1;
      if (y > 0) x *= 0.96;
      bp.setXYZ(i, x, y, z);
    }
    bodyGeo.computeVertexNormals();
    const bodyMesh = new THREE.Mesh(bodyGeo, this.paint);
    bodyMesh.position.y = 0.78;
    body.add(bodyMesh);

    // кабина: крыша цвета кузова, бока — тёмное стекло (через вертекс-цвета)
    const cabGeo = new THREE.BoxGeometry(1.76, 0.58, 2.1, 6, 3, 8);
    const cp = cabGeo.attributes.position, cn = cabGeo.attributes.normal;
    const colors = [];
    for (let i = 0; i < cp.count; i++) {
      let x = cp.getX(i), y = cp.getY(i), z = cp.getZ(i);
      if (y > 0) {
        x *= 0.86;
        z = z * 0.72 - 0.08;
      }
      cp.setXYZ(i, x, y, z);
      const roof = cn.getY(i) > 0.5;
      if (roof) colors.push(1, 1, 1);
      else colors.push(0.09, 0.1, 0.13);
    }
    cabGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    cabGeo.computeVertexNormals();
    const cabMesh = new THREE.Mesh(cabGeo, this.cabinMat);
    cabMesh.position.set(0, 1.37, -0.25);
    body.add(cabMesh);
    this.deformables = [bodyMesh, cabMesh].map((m) => ({ mesh: m, orig: Float32Array.from(m.geometry.attributes.position.array) }));

    // днище
    const under = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.25, 3.9), this.dark);
    under.position.y = 0.47;
    body.add(under);

    // фары (детали склеены в один меш — меньше вызовов отрисовки)
    const lamp = new THREE.BoxGeometry(0.42, 0.14, 0.06);
    body.add(new THREE.Mesh(mergeGeometries([placed(lamp, -0.62, 0.83, 2.16), placed(lamp, 0.62, 0.83, 2.16)]), this.headMat));
    body.add(new THREE.Mesh(mergeGeometries([placed(lamp, -0.62, 0.86, -2.16), placed(lamp, 0.62, 0.86, -2.16)]), this.tailMat));

    // кенгурятник с шипами — фирменная деталь и броня лба
    const spikeGeo = new THREE.ConeGeometry(0.075, 0.45, 6);
    spikeGeo.rotateX(Math.PI / 2);
    const barParts = [
      placed(new THREE.BoxGeometry(2.1, 0.14, 0.14), 0, 0.62, 2.3),
      placed(new THREE.BoxGeometry(1.6, 0.1, 0.1), 0, 0.92, 2.2),
      placed(new THREE.BoxGeometry(0.1, 0.42, 0.1), -0.6, 0.77, 2.25),
      placed(new THREE.BoxGeometry(0.1, 0.42, 0.1), 0.6, 0.77, 2.25),
    ];
    for (let k = 0; k < 6; k++) barParts.push(placed(spikeGeo, -0.9 + k * 0.36, 0.62, 2.55));
    const bar = new THREE.Mesh(mergeGeometries(barParts), this.metal);
    body.add(bar);
    this._part(bar, 'front');

    const rear = new THREE.Mesh(new THREE.BoxGeometry(2.04, 0.22, 0.2), this.dark);
    rear.position.set(0, 0.58, -2.2);
    body.add(rear);
    this._part(rear, 'rear');

    // колёса
    const tyreGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.34, 16);
    tyreGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.36, 8);
    rimGeo.rotateZ(Math.PI / 2);
    const wheelGeo = mergeGeometries([placed(tyreGeo, 0, 0, 0, '#18181a'), placed(rimGeo, 0, 0, 0, '#9aa0a6')]);
    const wheelMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.wheels = WHEELS.map((w) => {
      const pivot = new THREE.Group();
      pivot.position.set(w.x, 0.42, w.z);
      const spin = new THREE.Group();
      spin.add(new THREE.Mesh(wheelGeo, wheelMat));
      pivot.add(spin);
      root.add(pivot);
      const part = this._part(pivot, 'wheel');
      return { ...w, pivot, spin, part };
    });

    if (this.opts.wing) {
      // антикрыло с номером — чтобы соперников было видно и различимо издалека
      const strut = new THREE.BoxGeometry(0.08, 0.36, 0.25);
      const wing = new THREE.Group();
      wing.add(new THREE.Mesh(
        mergeGeometries([placed(new THREE.BoxGeometry(1.9, 0.08, 0.5), 0, 1.42, -1.95), placed(strut, -0.7, 1.22, -1.9), placed(strut, 0.7, 1.22, -1.9)]),
        this.paint,
      ));
      if (this.opts.number != null) {
        const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.42), new THREE.MeshLambertMaterial({ map: numberTexture(this.opts.number, this.opts.color) }));
        plate.rotation.x = -Math.PI / 2;
        plate.position.set(0, 1.465, -1.95);
        wing.add(plate);
      }
      body.add(wing);
      this._part(wing, 'wing');
    }
    this._buildCannon(body);

    // мягкая тень под машиной
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(2.8, 5.2),
      new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.03;
    blob.renderOrder = 1;
    root.add(blob);

    root.traverse((o) => {
      if (o.isMesh && o !== blob && (!this.flash || o.parent !== this.flash)) {
        o.castShadow = this.quality.shadows;
      }
    });
  }

  /** Пушка на крыше: неподвижная, смотрит строго вперёд по курсу. */
  _buildCannon(body) {
    const gun = (this.cannon = new THREE.Group());
    gun.position.set(0, 1.66, -0.35);
    body.add(gun);
    const olive = new THREE.MeshLambertMaterial({ color: 0x3d4a2f });
    gun.add(new THREE.Mesh(
      mergeGeometries([placed(new THREE.BoxGeometry(0.62, 0.22, 0.8), 0, 0.11, 0), placed(new THREE.BoxGeometry(0.5, 0.2, 0.55), 0, 0.31, -0.05)]),
      olive,
    ));
    // ствол отдельной группой — для отдачи
    const barrel = (this.barrel = new THREE.Group());
    barrel.position.set(0, 0.3, 0);
    const tube = new THREE.CylinderGeometry(0.1, 0.12, 1.7, 10);
    tube.rotateX(Math.PI / 2);
    const brake = new THREE.CylinderGeometry(0.16, 0.16, 0.24, 10);
    brake.rotateX(Math.PI / 2);
    barrel.add(new THREE.Mesh(mergeGeometries([placed(tube, 0, 0, 0.75), placed(brake, 0, 0, 1.62)]), this.dark));
    gun.add(barrel);
    const flashMat = new THREE.MeshBasicMaterial({ map: flashTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const flash = (this.flash = new THREE.Group());
    const fp = new THREE.PlaneGeometry(1.5, 1.5);
    const f1 = new THREE.Mesh(fp, flashMat);
    const f2 = new THREE.Mesh(fp, flashMat);
    f2.rotation.y = Math.PI / 2;
    const f3 = new THREE.Mesh(fp, flashMat);
    f3.rotation.x = Math.PI / 2;
    flash.add(f1, f2, f3);
    flash.position.set(0, 0, 2.1);
    flash.visible = false;
    barrel.add(flash);
    this._part(gun, 'cannon');
    if (this.isPlayer && !this.quality.low) {
      this.muzzleLight = new THREE.PointLight(0xffb050, 0, 14, 2);
      this.muzzleLight.position.set(0, 0.1, 2.2);
      barrel.add(this.muzzleLight);
    }
  }

  /** Точка вылета снаряда в мире. */
  muzzle() {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    return { x: this.x + s * 1.9, y: this.y + this.hop + 1.96, z: this.z + c * 1.9, dx: s, dz: c };
  }

  /** Анимация выстрела: отдача ствола и вспышка. */
  kick() {
    this.recoilT = 1;
    this.flashT = 0.07;
    if (this.flash) {
      this.flash.rotation.z = Math.random() * Math.PI;
      const k = 0.8 + Math.random() * 0.5;
      this.flash.scale.set(k, k, k * 1.3);
    }
  }

  _part(obj, kind) {
    const part = { obj, kind, parent: obj.parent, pos: obj.position.clone(), quat: obj.quaternion.clone(), detached: false };
    this.parts.push(part);
    return part;
  }

  _detach(part, vx, vy, vz) {
    if (part.detached) return;
    part.detached = true;
    const o = part.obj;
    o.updateWorldMatrix(true, false);
    o.matrixWorld.decompose(_p, _q, _s);
    this.scene.add(o);
    o.position.copy(_p);
    o.quaternion.copy(_q);
    this.debris.spawn(o, {
      mode: 'fly',
      vx, vy, vz,
      wx: rand(-9, 9), wy: rand(-6, 6), wz: rand(-9, 9),
      radius: part.kind === 'wheel' ? 0.42 : 0.2,
      persistent: true,
    });
  }

  // ------------------------------------------------------------------ состояние
  reset(sp) {
    this.x = sp.x;
    this.z = sp.z;
    this.y = this.city.groundHeight(sp.x, sp.z);
    this.yaw = sp.yaw;
    this.vx = 0;
    this.vz = 0;
    this.angVel = 0;
    this.steer = 0;
    this.vF = 0;
    this.vR = 0;
    this.health = 100;
    this.kills = 0; // сбитые пешеходы — для победы «мясника»
    this.wrecked = false;
    this.wreckTime = 0;
    this.frontHits = 0;
    this.rearHits = 0;
    this.trails = WHEELS.map(() => ({ skid: false, sx: 0, sz: 0, blood: 0, bx: 0, bz: 0 }));
    this.roll = 0;
    this.rollVel = 0;
    this.pitch = 0;
    this.pitchVel = 0;
    this.hop = 0;
    this.hopVel = 0;
    this.throttle = 0;
    this.braking = false;
    this.slip = 0;
    this.lastImpact = 0;
    this.reload = 0;
    this.recoilT = 0;
    this.flashT = 0;
    this.smokeAcc = 0;

    for (const d of this.deformables) {
      const pos = d.mesh.geometry.attributes.position;
      pos.array.set(d.orig);
      pos.needsUpdate = true;
      d.mesh.geometry.computeVertexNormals();
    }
    for (const part of this.parts) {
      if (part.detached) {
        this.debris.remove(part.obj);
        this.scene.remove(part.obj);
        part.parent.add(part.obj);
        part.detached = false;
      }
      part.obj.position.copy(part.pos);
      part.obj.quaternion.copy(part.quat);
    }
    this.paint.color.copy(this.paintColor);
    this.cabinMat.color.copy(this.paintColor);
    this.headMat.color.set(0xfff6d8);
    this.tailMat.color.set(0x7a0b0b);
    this._syncMesh(0);
  }

  /** Громкость звуков этой машины для игрока (1 — своя машина). */
  vol() {
    if (this.isPlayer || !this.listener) return 1;
    const d = Math.hypot(this.x - this.listener.x, this.z - this.listener.z);
    const k = Math.max(0, 1 - d / 90);
    return k * k;
  }

  /** Локальные координаты точки: lx — вбок (влево +), lz — вперёд. */
  local(px, pz) {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const dx = px - this.x, dz = pz - this.z;
    return { lx: dx * c - dz * s, lz: dx * s + dz * c };
  }

  /** Часть корпуса, куда пришёлся удар. */
  zoneAt(px, pz) {
    const { lz } = this.local(px, pz);
    if (lz > 1.1) return 'front';
    if (lz < -1.3) return 'rear';
    return 'side';
  }

  get frontArmored() {
    const f = this.parts.find((p) => p.kind === 'front');
    return f && !f.detached;
  }

  get speed() {
    return Math.hypot(this.vx, this.vz);
  }

  /** Направления: вперёд (fx, fz) и вправо (rx, rz). */
  axes() {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    return { fx: s, fz: c, rx: -c, rz: s };
  }

  // ------------------------------------------------------------------ физика
  update(dt, input) {
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.physicsStep(h, input);
    this.postUpdate(dt, input);
  }

  /** Один подшаг физики: движение и столкновения со статикой. */
  physicsStep(h, input) {
    this._step(h, input);
    this._collide();
  }

  /** После всех подшагов: визуал, следы, дым, звук. */
  postUpdate(dt, input) {
    this._afterPhysics(dt, input);
  }

  _step(h, inp) {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const fx = s, fz = c, rx = -c, rz = s;
    let vF = this.vx * fx + this.vz * fz;
    let vR = this.vx * rx + this.vz * rz;
    let thr = inp.throttle, brk = inp.brake, st = inp.steer, hb = inp.handbrake;
    if (this.wrecked) {
      thr = 0;
      brk = 0;
      st = 0;
      hb = true;
    }

    const spd = Math.abs(vF);
    const t = clamp((spd - P.hardFrom) / (P.hardTo - P.hardFrom), 0, 1);
    const hard = t * t * (3 - 2 * t);
    // на скорости руль «тупеет»: угол такой, чтобы машина крутилась не быстрее yawCap, в поворот руль крутится
    // медленнее, машина отзывается с ленцой. Но выпрямить руль и перестать поворачивать можно всегда быстро —
    // колёса сами тянутся к центру, а при перекладке в другую сторону медленно набирается только новый поворот.
    let maxSteer = P.steerLow;
    if (spd > 1) maxSteer = Math.min(maxSteer, Math.atan((yawCap(spd) * P.wheelBase) / spd));
    const want = st * maxSteer;
    let left = h;
    if (this.steer * want < 0 || Math.abs(want) < Math.abs(this.steer)) {
      const stop = this.steer * want < 0 ? 0 : want;
      const fast = maxSteer / P.steerReturn;
      const need = Math.abs(stop - this.steer) / fast;
      this.steer = moveToward(this.steer, stop, fast * h);
      left = Math.max(0, h - need);
    }
    if (left > 0) this.steer = moveToward(this.steer, want, (maxSteer / lerp(P.steerTime[0], P.steerTime[1], hard)) * left);

    let a = 0;
    if (thr > 0) {
      if (vF < -0.5) a += P.brake * thr;
      else a += P.engine * thr * Math.max(0, 1 - (vF / P.speedCurve) ** 2);
    }
    this.braking = false;
    if (brk > 0) {
      if (vF > 0.5) {
        a -= P.brake * brk;
        this.braking = true;
      } else if (vF > -P.maxReverse) a -= P.reverseAccel * brk;
    }
    vF += a * h;
    const res = (P.roll + P.drag * vF * vF + (hb ? 7 : 0) + (this.wrecked ? 5 : 0)) * h;
    if (vF > res) vF -= res;
    else if (vF < -res) vF += res;
    else if (thr === 0 && brk === 0) vF = 0;

    vR *= Math.exp(-(hb ? P.hbGrip : P.grip) * h);

    let target = -(vF / P.wheelBase) * Math.tan(this.steer);
    if (hb && spd > 3) target *= 1.5;
    const unwind = this.angVel * target < 0 || Math.abs(target) < Math.abs(this.angVel);
    const resp = unwind ? P.yawUnwind : lerp(P.yawResp[0], P.yawResp[1], hard);
    this.angVel += (target - this.angVel) * Math.min(1, resp * h);

    // скорость собирается по старым осям — при повороте часть уходит в боковую и гасится сцеплением (занос)
    this.vx = fx * vF + rx * vR;
    this.vz = fz * vF + rz * vR;
    this.yaw += this.angVel * h;
    this.x += this.vx * h;
    this.z += this.vz * h;
    this.vF = vF;
    this.vR = vR;
    this.accel = a;
    this.throttle = thr;
    this.handbrake = hb;
  }

  _collide() {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    let maxImpact = 0, inx = 0, inz = 0, ipx = 0, ipz = 0, hitC = null;
    for (let k = 0; k < HIT_Z.length; k++) {
      const oz = HIT_Z[k];
      const cx = this.x + s * oz, cz = this.z + c * oz;
      const list = this.world.queryCircle(cx, cz, HIT_R);
      for (let j = 0; j < list.length; j++) {
        const col = list[j];
        if (!circleVsCollider(cx, cz, HIT_R, col, PEN)) continue;
        if (col.kind === 'breakable') {
          if (this.speed > 2.5 && this.onBreakable && this.onBreakable(col, this)) continue;
        }
        this.x += PEN.nx * PEN.depth;
        this.z += PEN.nz * PEN.depth;
        const rX = PEN.px - this.x, rZ = PEN.pz - this.z;
        const vpx = this.vx + this.angVel * rZ, vpz = this.vz - this.angVel * rX;
        const vn = vpx * PEN.nx + vpz * PEN.nz;
        if (vn >= 0) continue;
        const rn = rZ * PEN.nx - rX * PEN.nz;
        const jn = (-(1 + P.restitution) * vn) / (1 + (rn * rn) / P.inertia);
        this.vx += jn * PEN.nx;
        this.vz += jn * PEN.nz;
        this.angVel += (jn * rn) / P.inertia;
        // трение вдоль стены
        const tx = -PEN.nz, tz = PEN.nx;
        const vt = vpx * tx + vpz * tz;
        const rt = rZ * tx - rX * tz;
        let jt = -vt / (1 + (rt * rt) / P.inertia);
        const mf = 0.3 * jn;
        jt = clamp(jt, -mf, mf);
        this.vx += jt * tx;
        this.vz += jt * tz;
        this.angVel += (jt * rt) / P.inertia;
        if (-vn > maxImpact) {
          maxImpact = -vn;
          inx = PEN.nx;
          inz = PEN.nz;
          ipx = PEN.px;
          ipz = PEN.pz;
          hitC = col;
        }
      }
    }
    if (maxImpact > 0) this._impact(maxImpact, inx, inz, ipx, ipz, hitC);
  }

  _impact(impact, nx, nz, px, pz, col) {
    const now = performance.now();
    const y = this.y + 0.8;
    if (impact > 2.5) {
      this.fx.sparks(px, y, pz, nx, nz, Math.min(30, Math.floor(impact * 1.5)));
      const v = this.vol();
      if (now - this.lastImpact > 120 && v > 0.03) this.audio.crash(Math.min(1.2, impact / 18) * v);
      this.lastImpact = now;
    }
    if (impact > 5) this.fx.dust(px, y - 0.3, pz, 5);
    if (this.onImpact) this.onImpact(impact, px, pz);
    if (!HARD.has(col.kind) || impact < P.damageThreshold || this.wrecked) return;
    let mult = col.kind === 'pole' || col.kind === 'pillar' || col.kind === 'tree' ? 1.15 : 1;
    if (this.frontArmored && this.zoneAt(px, pz) === 'front') mult *= FRONT_ARMOR_WALL;
    const dmg = (impact - P.damageThreshold) * P.damageScale * mult * this.opts.wallDamage;
    this.applyDamage(dmg, px, pz, nx, nz);
  }

  /** Подлатать корпус (за убийства). Возвращает, сколько реально добавилось. */
  heal(amount) {
    if (this.wrecked) return 0;
    const before = this.health;
    this.health = Math.min(100, this.health + amount);
    return this.health - before;
  }

  applyDamage(dmg, px, pz, nx, nz) {
    if (this.wrecked) return;
    this.health = Math.max(0, this.health - dmg);
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const dx = px - this.x, dz = pz - this.z;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    const nlx = nx * c - nz * s, nlz = nx * s + nz * c;
    this._deform(lx, lz, nlx, nlz, Math.min(0.5, 0.06 + dmg * 0.012));
    if (lz > 1.2) this.frontHits += dmg;
    if (lz < -1.2) this.rearHits += dmg;
    const part = (k) => this.parts.find((p) => p.kind === k);
    if (this.frontHits > 30) this._detach(part('front'), this.vx * 0.5 + nx * 3, 3, this.vz * 0.5 + nz * 3);
    if (this.rearHits > 30) this._detach(part('rear'), this.vx * 0.5 + nx * 3, 2.5, this.vz * 0.5 + nz * 3);
    if (dmg > 14) {
      this.fx.glass(px, this.y + 1.3, pz, Math.min(30, Math.floor(dmg)));
      if (this.vol() > 0.05) this.audio.glass(this.vol());
    }
    if (this.onDamage) this.onDamage(dmg);
    if (this.health <= 0) this.explode();
  }

  _deform(lx, lz, nlx, nlz, amount) {
    const R = 1.35;
    for (const d of this.deformables) {
      const geo = d.mesh.geometry;
      const arr = geo.attributes.position.array;
      const o = d.orig;
      const mx = d.mesh.position.x, my = d.mesh.position.y, mz = d.mesh.position.z;
      for (let i = 0; i < arr.length; i += 3) {
        const vx = arr[i] + mx, vy = arr[i + 1] + my, vz = arr[i + 2] + mz;
        const ddx = vx - lx, ddz = vz - lz, ddy = vy - 0.9;
        const d2 = ddx * ddx + ddz * ddz + ddy * ddy * 0.4;
        if (d2 > R * R) continue;
        const f = 1 - Math.sqrt(d2) / R;
        const k = amount * f * f * (0.75 + Math.random() * 0.5);
        arr[i] += nlx * k;
        arr[i + 2] += nlz * k;
        arr[i + 1] -= k * 0.35 * Math.random();
        const ex = arr[i] - o[i], ey = arr[i + 1] - o[i + 1], ez = arr[i + 2] - o[i + 2];
        const e = Math.hypot(ex, ey, ez);
        if (e > 0.6) {
          arr[i] = o[i] + (ex / e) * 0.6;
          arr[i + 1] = o[i + 1] + (ey / e) * 0.6;
          arr[i + 2] = o[i + 2] + (ez / e) * 0.6;
        }
      }
      geo.attributes.position.needsUpdate = true;
      geo.computeVertexNormals();
    }
  }

  explode() {
    if (this.wrecked) return;
    this.wrecked = true;
    this.health = 0;
    this.wreckTime = 0;
    this.paint.color.set(0x1d1a18);
    this.cabinMat.color.set(0x2a2522);
    this.headMat.color.set(0x222222);
    this.tailMat.color.set(0x220000);
    this.fx.explosion(this.x, this.y + 0.8, this.z);
    this.fx.glass(this.x, this.y + 1.4, this.z, 40);
    this.audio.explosion(Math.max(0.15, this.vol()));
    this.hopVel = 6;
    const byKind = (k) => this.parts.filter((p) => p.kind === k);
    for (const top of [...byKind('cannon'), ...byKind('wing')]) this._detach(top, this.vx * 0.4 + rand(-3, 3), 11, this.vz * 0.4 + rand(-3, 3));
    for (const p of [...byKind('front'), ...byKind('rear')]) this._detach(p, this.vx * 0.4 + rand(-5, 5), rand(5, 9), this.vz * 0.4 + rand(-5, 5));
    const ws = byKind('wheel');
    for (const p of [ws[0], ws[3]]) this._detach(p, rand(-6, 6), rand(4, 8), rand(-6, 6));
    if (this.onWrecked) this.onWrecked();
  }

  // ------------------------------------------------------------------ визуал и эффекты
  /**
   * Отрезок следа от последней отмеченной точки колеса до текущей — след всегда позади колеса.
   * Возвращает длину нарисованного отрезка (0, если колесо проехало слишком мало).
   */
  _trailMark(wx, wz, tr, kx, kz, step, r, g, b, opacity) {
    const dx = wx - tr[kx], dz = wz - tr[kz];
    const d = Math.hypot(dx, dz);
    if (d > 4) {
      // машину переставили (или кадр был огромным) — не тянуть полосу через полкарты
      tr[kx] = wx;
      tr[kz] = wz;
      return 0;
    }
    if (d < step) return 0;
    this.fx.tireMark((wx + tr[kx]) / 2, (wz + tr[kz]) / 2, Math.atan2(dx, dz), d + 0.04, r, g, b, opacity);
    tr[kx] = wx;
    tr[kz] = wz;
    return d;
  }

  _afterPhysics(dt, input) {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const speed = this.speed;

    // высота над землёй (бордюр) и подскоки
    const gy = this.city.groundHeight(this.x, this.z);
    const dy = gy - this.y;
    if (Math.abs(dy) > 0.05) this.pitchVel += -dy * 6 * Math.sign(this.vF || 1);
    this.y += dy * Math.min(1, dt * 20);
    this.hopVel -= 20 * dt;
    this.hop = Math.max(0, this.hop + this.hopVel * dt);
    if (this.hop === 0) this.hopVel = 0;

    // крен и тангаж на пружинах
    const lat = this.vF * this.angVel;
    const rollT = clamp(lat * 0.012, -0.11, 0.11);
    const pitchT = clamp(-(this.accel || 0) * 0.005, -0.07, 0.07);
    this.rollVel += ((rollT - this.roll) * 90 - this.rollVel * 11) * dt;
    this.pitchVel += ((pitchT - this.pitch) * 90 - this.pitchVel * 11) * dt;
    this.roll += this.rollVel * dt;
    this.pitch += this.pitchVel * dt;

    this._syncMesh(dt);
    this.tailMat.color.set(this.wrecked ? 0x220000 : this.braking ? 0xff2020 : 0x7a0b0b);

    // занос, следы шин
    const slip = Math.abs(this.vR);
    const skidding = !this.wrecked && ((slip > 3.2 && speed > 4) || (this.handbrake && speed > 5) || (this.braking && this.vF > 9));
    this.slip = skidding ? clamp(slip / 10 + (this.handbrake ? 0.4 : 0) + (this.braking ? 0.3 : 0), 0, 1) : 0;
    if (this.isPlayer) this.audio.skid(this.slip);
    for (let i = 0; i < 4; i++) {
      const w = WHEELS[i], tr = this.trails[i];
      const wx = this.x + w.x * c + w.z * s, wz = this.z - w.x * s + w.z * c;

      // юз: чёрные полосы от задних колёс
      if (skidding && i >= 2) {
        if (!tr.skid) {
          tr.skid = true;
          tr.sx = wx;
          tr.sz = wz;
        }
        const d = this._trailMark(wx, wz, tr, 'sx', 'sz', 0.25, 0.05, 0.05, 0.05, 0.55);
        if (d > 0 && Math.random() < 0.35) this.fx.tireSmoke(wx, this.y + 0.2, wz);
      } else tr.skid = false;

      // кровь: колесо пачкается, только проехав по крови, и оставляет след позади себя
      if (!this.wrecked && this.fx.bloodAt(wx, wz)) {
        if (tr.blood <= 0) {
          tr.bx = wx;
          tr.bz = wz;
        }
        tr.blood = BLOOD_TRACK;
      }
      if (tr.blood > 0) {
        const op = Math.min(1, tr.blood / 12) * 0.75;
        const d = this._trailMark(wx, wz, tr, 'bx', 'bz', 0.35, 0.55, 0.02, 0.02, op);
        tr.blood -= d;
      }
    }

    // дым и огонь от повреждений
    if (this.health < 55 || this.wrecked) {
      this.wreckTime += this.wrecked ? dt : 0;
      const k = this.wrecked ? 1 : 1 - this.health / 55;
      this.smokeAcc += dt * (4 + k * 18);
      const hx = this.x + s * 1.5, hz = this.z + c * 1.5;
      while (this.smokeAcc > 1) {
        this.smokeAcc -= 1;
        this.fx.smoke(hx + rand(-0.4, 0.4), this.y + 1.1 + this.hop, hz + rand(-0.4, 0.4), k, 0.7 + k * 0.7);
      }
      if ((this.health < 25 || this.wrecked) && Math.random() < dt * (this.wrecked ? 50 : 22)) {
        this.fx.fire(hx, this.y + 1.0 + this.hop, hz, this.wrecked ? 1.1 : 0.7);
        if (this.wrecked) this.fx.fire(this.x + rand(-0.6, 0.6), this.y + 1.3 + this.hop, this.z + rand(-1, 1), 1.2);
      }
    }

    if (this.isPlayer) this.audio.engine(speed, this.wrecked ? 0 : input.throttle, !this.wrecked);
  }

  _syncMesh(dt) {
    const r = this.root;
    r.position.set(this.x, this.y + this.hop, this.z);
    r.rotation.y = this.yaw;
    this.body.rotation.set(this.pitch, 0, this.roll);
    const spinD = (this.vF * dt) / 0.42;
    for (const w of this.wheels) {
      if (w.part.detached) continue;
      w.spin.rotation.x += spinD;
      // steer > 0 — поворот вправо, а вправо у машины — локальная −X
      if (w.front) w.pivot.rotation.y = -this.steer;
    }
    // отдача ствола и вспышка
    this.recoilT = Math.max(0, this.recoilT - dt * 3.5);
    this.barrel.position.z = -0.35 * Math.sin(Math.min(1, this.recoilT) * Math.PI * 0.5);
    this.flashT -= dt;
    this.flash.visible = this.flashT > 0;
    if (this.muzzleLight) this.muzzleLight.intensity = this.flashT > 0 ? 60 : 0;
  }
}
