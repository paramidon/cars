import * as THREE from 'three';
import { clamp, damp, dampAngle } from './utils.js';

const MODES = [
  { name: 'Сзади', dist: 9.5, height: 4.0, look: 4, fov: 62 },
  { name: 'Дальняя', dist: 15, height: 7.5, look: 5, fov: 60 },
  { name: 'Сверху', dist: 7, height: 30, look: 6, fov: 55 },
];

const camFilter = (c) => c.kind === 'building' || c.kind === 'wall';

/** Камера преследования с инерцией, тряской и защитой от заслонения зданиями. */
export class ChaseCamera {
  constructor(camera, city) {
    this.camera = camera;
    this.city = city;
    this.mode = 0;
    this.yaw = 0;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.trauma = 0;
    this.distMul = 1;
    this.inited = false;
    this.orbit = 0;
    this.back = false; // смотрим назад (зажата V)
  }

  get modeName() {
    return MODES[this.mode].name;
  }

  next() {
    this.mode = (this.mode + 1) % MODES.length;
  }

  shake(v) {
    this.trauma = Math.min(1, this.trauma + v);
  }

  snap(car) {
    this.inited = false;
    this.update(1 / 60, car);
  }

  /**
   * aimYaw — сидим в башне: камера смотрит вдоль ствола, а не по курсу машины.
   * back — вид назад: камера сразу перескакивает вперёд машины и смотрит ей за спину.
   */
  update(dt, car, aimYaw = null, back = false) {
    const m = MODES[this.mode];
    const cam = this.camera;
    const portrait = cam.aspect < 1;
    const speed = car.speed;
    if (back !== this.back) {
      this.back = back;
      this.inited = false; // без плавного облёта — перескок, как в зеркале
    }

    // направление: по курсу машины, при быстром заносе — немного по вектору скорости
    let heading = aimYaw ?? car.yaw;
    // a car on its side or roof: follow where it is going, or hold the view while it lies still
    const flipped = aimYaw == null && car.upY < 0.5;
    if (flipped) heading = speed > 3 ? Math.atan2(car.vx, car.vz) : this.heading ?? heading;
    this.heading = heading;
    let dirYaw = heading + (back ? Math.PI : 0);
    if (aimYaw == null && !flipped && !back && speed > 6 && car.vF > 0) {
      const velYaw = Math.atan2(car.vx, car.vz);
      dirYaw = car.yaw + Math.atan2(Math.sin(velYaw - car.yaw), Math.cos(velYaw - car.yaw)) * 0.35;
    }
    if (!this.inited) this.yaw = dirYaw;
    this.yaw = dampAngle(this.yaw, dirYaw, car.wrecked ? 0.6 : aimYaw != null ? 14 : 4.5, dt);
    if (car.wrecked) this.yaw += dt * 0.35;

    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let dist = m.dist * (1 + speed * 0.008) * (portrait ? 1.35 : 1);
    let height = m.height + speed * 0.025 + (portrait ? 1.5 : 0);
    if (car.wrecked) {
      dist *= 1.5;
      height += 3;
    }

    // не прятать машину за домом
    if (this.mode !== 2) {
      const hit = this.city.world.raycast(car.x, car.z, -fx, -fz, dist + 0.6, camFilter);
      const want = hit && hit.collider.h > 2 ? Math.max(3.2, hit.t - 0.6) : dist;
      this.distMul = damp(this.distMul, want / dist, want < dist * this.distMul ? 12 : 2.5, dt);
      dist *= this.distMul;
      if (this.distMul < 0.8) height += (1 - this.distMul) * 4;
    }

    let tx = car.x - fx * dist, tz = car.z - fz * dist, ty = car.y + height;
    // in the test ground's tube: stay under the ceiling and between the walls
    const roof = this.city.roofOver?.(car.x, car.z, car.y) || this.city.roofOver?.(tx, tz, car.y);
    if (roof) {
      ty = Math.min(ty, roof.ceil - 0.5);
      tx = clamp(tx, roof.x0 + 0.8, roof.x1 - 0.8);
    }
    const lookAhead = aimYaw != null ? m.look + 14 : m.look + Math.min(speed * 0.2, 6);
    const lx = car.x + fx * lookAhead, lz = car.z + fz * lookAhead, ly = car.y + 1.2;

    if (!this.inited) {
      this.pos.set(tx, ty, tz);
      this.look.set(lx, ly, lz);
      this.inited = true;
    }
    const k = this.mode === 2 ? 6 : 9;
    this.pos.x = damp(this.pos.x, tx, k, dt);
    this.pos.y = damp(this.pos.y, ty, k * 0.7, dt);
    this.pos.z = damp(this.pos.z, tz, k, dt);
    if (roof) {
      this.pos.y = Math.min(this.pos.y, roof.ceil - 0.5);
      this.pos.x = clamp(this.pos.x, roof.x0 + 0.8, roof.x1 - 0.8);
    }
    this.look.x = damp(this.look.x, lx, 12, dt);
    this.look.y = damp(this.look.y, ly, 12, dt);
    this.look.z = damp(this.look.z, lz, 12, dt);

    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const sh = this.trauma * this.trauma;
    cam.position.set(
      this.pos.x + (Math.random() - 0.5) * sh * 1.2,
      this.pos.y + (Math.random() - 0.5) * sh * 1.0,
      this.pos.z + (Math.random() - 0.5) * sh * 1.2,
    );
    cam.lookAt(this.look);
    const fov = clamp(m.fov + speed * 0.32 + (portrait ? 12 : 0), 40, 95);
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov = damp(cam.fov, fov, 4, dt);
      cam.updateProjectionMatrix();
    }
  }

  /** Медленный облёт города для заставки меню. */
  orbitUpdate(dt, cx, cz) {
    this.orbit += dt * 0.06;
    const r = 150;
    const cam = this.camera;
    cam.position.set(cx + Math.cos(this.orbit) * r, 75, cz + Math.sin(this.orbit) * r);
    cam.lookAt(cx, 0, cz);
    if (cam.fov !== 55) {
      cam.fov = 55;
      cam.updateProjectionMatrix();
    }
    this.inited = false;
  }
}
