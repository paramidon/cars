import * as THREE from 'three';
import { pushOutCircle } from '../physics/collision.js';

const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();

/**
 * Обломки: сбитые столбы падают (topple), мелочь и детали машины летят и кувыркаются (fly).
 */
export class Debris {
  constructor(scene, groundHeight, world) {
    this.scene = scene;
    this.groundHeight = groundHeight;
    this.world = world;
    this.items = [];
    this.max = 70;
  }

  spawn(obj, o) {
    const it = {
      obj,
      mode: o.mode || 'fly',
      vx: o.vx || 0,
      vy: o.vy || 0,
      vz: o.vz || 0,
      wx: o.wx || 0,
      wy: o.wy || 0,
      wz: o.wz || 0,
      radius: o.radius ?? 0.25,
      persistent: !!o.persistent,
      resting: false,
      t: 0,
    };
    if (it.mode === 'topple') {
      // ось падения перпендикулярна направлению удара
      it.axis = new THREE.Vector3(o.dirz, 0, -o.dirx).normalize();
      it.theta = 0;
      it.omega = o.omega || 1;
      it.baseQ = obj.quaternion.clone();
      it.baseY = obj.position.y;
      it.bounced = false;
    }
    this.items.push(it);
    if (this.items.length > this.max) {
      const idx = this.items.findIndex((x) => !x.persistent);
      if (idx >= 0) {
        this.scene.remove(this.items[idx].obj);
        this.items.splice(idx, 1);
      }
    }
    return it;
  }

  remove(obj) {
    const idx = this.items.findIndex((x) => x.obj === obj);
    if (idx >= 0) this.items.splice(idx, 1);
  }

  clear() {
    for (const it of this.items) if (!it.persistent) this.scene.remove(it.obj);
    this.items.length = 0;
  }

  update(dt) {
    for (const it of this.items) {
      if (it.resting) continue;
      it.t += dt;
      const o = it.obj;
      if (it.mode === 'topple') {
        // перевёрнутый маятник: чем сильнее наклон, тем быстрее падает
        it.omega += 9 * Math.sin(Math.max(0.05, it.theta)) * dt;
        it.theta += it.omega * dt;
        if (it.theta >= Math.PI / 2) {
          it.theta = Math.PI / 2;
          if (!it.bounced && it.omega > 1.5) {
            it.omega = -it.omega * 0.18;
            it.bounced = true;
          } else {
            it.omega = 0;
          }
        }
        _q.setFromAxisAngle(it.axis, it.theta);
        o.quaternion.copy(_q).multiply(it.baseQ);
        o.position.x += it.vx * dt;
        o.position.z += it.vz * dt;
        const f = Math.exp(-3 * dt);
        it.vx *= f;
        it.vz *= f;
        const g = this.groundHeight(o.position.x, o.position.z);
        o.position.y = g + (it.theta / (Math.PI / 2)) * it.radius;
        if (it.theta >= Math.PI / 2 && it.omega === 0 && Math.abs(it.vx) + Math.abs(it.vz) < 0.1) it.resting = true;
        continue;
      }
      // свободный полёт
      it.vy -= 20 * dt;
      o.position.x += it.vx * dt;
      o.position.y += it.vy * dt;
      o.position.z += it.vz * dt;
      const w = Math.hypot(it.wx, it.wy, it.wz);
      if (w > 1e-4) {
        _axis.set(it.wx / w, it.wy / w, it.wz / w);
        _q.setFromAxisAngle(_axis, w * dt);
        o.quaternion.premultiply(_q);
      }
      const push = pushOutCircle(this.world, o.position.x, o.position.z, it.radius);
      if (push.hit) {
        o.position.x = push.x;
        o.position.z = push.z;
        const vn = it.vx * push.nx + it.vz * push.nz;
        if (vn < 0) {
          it.vx -= 1.4 * vn * push.nx;
          it.vz -= 1.4 * vn * push.nz;
        }
      }
      const g = this.groundHeight(o.position.x, o.position.z) + it.radius;
      if (o.position.y < g) {
        o.position.y = g;
        if (it.vy < -2.5) {
          it.vy = -it.vy * 0.3;
          it.vx *= 0.6;
          it.vz *= 0.6;
          it.wx *= 0.5;
          it.wy *= 0.5;
          it.wz *= 0.5;
        } else {
          it.vy = 0;
          const f = Math.exp(-5 * dt);
          it.vx *= f;
          it.vz *= f;
          it.wx *= f;
          it.wy *= f;
          it.wz *= f;
          if (Math.abs(it.vx) + Math.abs(it.vz) < 0.15) it.resting = true;
        }
      }
    }
  }
}
