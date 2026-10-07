import * as THREE from 'three';

export const KIND = {
  BLOOD: 1,
  SPARK: 2,
  SMOKE: 3,
  FIRE: 4,
  WATER: 5,
  BOUNCE: 6, // стекло, гильзы, щепки
  DUST: 7,
};

const VERT = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
uniform float uScale;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.2, -mv.z);
  gl_Position = projectionMatrix * mv;
  if (aSize <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float uSoft;
varying vec4 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float a = vColor.a * (1.0 - smoothstep(uSoft, 1.0, d));
  gl_FragColor = vec4(vColor.rgb, a);
}`;

/**
 * Пул точечных частиц с собственным шейдером (размер в метрах, цвет+альфа на частицу).
 * Все массивы типизированные, без аллокаций в кадре.
 */
export class ParticleSystem {
  constructor(scene, max, { additive = false, soft = 0.55 } = {}) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.gravity = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.kind = new Uint8Array(max);
    this.alive = new Uint8Array(max);
    this.cursor = 0;

    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aColor', this.aColor);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 400 }, uSoft: { value: soft } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
    scene.add(this.points);
  }

  spawn(x, y, z, vx, vy, vz, life, size, r, g, b, a, gravity, drag, grow, kind) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.max;
    const i3 = i * 3, i4 = i * 4;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.col[i4] = r;
    this.col[i4 + 1] = g;
    this.col[i4 + 2] = b;
    this.col[i4 + 3] = a;
    this.alpha0[i] = a;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = size;
    this.size[i] = size;
    this.grow[i] = grow;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
    this.kind[i] = kind;
    this.alive[i] = 1;
  }

  clear() {
    this.alive.fill(0);
    this.size.fill(0);
    this.aSize.needsUpdate = true;
  }

  update(dt, groundAt, onBloodLand) {
    const { pos, vel, col, size, life, maxLife, size0, grow, alpha0, gravity, drag, kind, alive } = this;
    for (let i = 0; i < this.max; i++) {
      if (!alive[i]) continue;
      life[i] -= dt;
      if (life[i] <= 0) {
        alive[i] = 0;
        size[i] = 0;
        continue;
      }
      const i3 = i * 3;
      const k = kind[i];
      vel[i3 + 1] -= gravity[i] * dt;
      const dr = Math.max(0, 1 - drag[i] * dt);
      vel[i3] *= dr;
      vel[i3 + 1] *= dr;
      vel[i3 + 2] *= dr;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;

      const t = 1 - life[i] / maxLife[i];
      size[i] = size0[i] * (1 + grow[i] * t);
      let a = alpha0[i];
      if (k === KIND.SMOKE || k === KIND.DUST) a *= Math.min(1, t * 6) * (1 - t);
      else if (k === KIND.FIRE) {
        a *= 1 - t;
        // огонь: от жёлтого к красному
        col[i * 4 + 1] = Math.max(0.15, 0.85 - t * 0.9);
        col[i * 4 + 2] = Math.max(0.0, 0.35 - t * 0.6);
      } else if (k === KIND.SPARK) a *= 1 - t * t;
      else if (t > 0.8) a *= (1 - t) * 5;
      col[i * 4 + 3] = a;

      if (k === KIND.SMOKE || k === KIND.FIRE) continue;
      const gy = groundAt(pos[i3], pos[i3 + 2]) + 0.03;
      if (pos[i3 + 1] < gy) {
        if (k === KIND.BLOOD) {
          alive[i] = 0;
          size[i] = 0;
          if (onBloodLand) onBloodLand(pos[i3], gy, pos[i3 + 2], size0[i]);
        } else if (k === KIND.WATER) {
          alive[i] = 0;
          size[i] = 0;
        } else {
          pos[i3 + 1] = gy;
          vel[i3 + 1] = Math.abs(vel[i3 + 1]) > 1.5 ? -vel[i3 + 1] * 0.35 : 0;
          vel[i3] *= 0.6;
          vel[i3 + 2] *= 0.6;
        }
      }
    }
    this.aPos.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aColor.needsUpdate = true;
  }
}
