import * as THREE from 'three';
import { clamp, lerp } from './utils.js';

/** Королевская битва: смертельная зона. Крутить здесь. */
export const ZONE = {
  hold: 5, // с после старта зона ещё не сжимается
  shrink: 120, // с от старта до полного сжатия (радиус 0)
  dps: [2.5, 8], // урон корпусу в секунду снаружи: в начале и к концу сжатия
  height: 160, // м — стена видна из любой точки города
  spawnGap: 45, // м — машины на старте не ближе друг к другу
  hunt: 3, // с после старта боты уже охотятся
};

/** Случайная точка на дороге (на полосе, курс вдоль улицы). */
export function roadPoint(city, rnd = Math.random) {
  const R = city.roads, N = R.length - 1;
  const line = R[Math.floor(rnd() * (N + 1))];
  const t = R[0] + rnd() * (R[N] - R[0]);
  const lane = rnd() < 0.5 ? -3 : 3;
  if (rnd() < 0.5) return { x: t, z: line + lane, yaw: lane > 0 ? -Math.PI / 2 : Math.PI / 2 };
  return { x: line + lane, z: t, yaw: lane > 0 ? Math.PI : 0 };
}

/** Точка на дороге не дальше r от (cx, cz); если такой не нашлось — ближайший к центру перекрёсток. */
export function roadPointNear(city, cx, cz, r, rnd = Math.random) {
  for (let i = 0; i < 40; i++) {
    const p = roadPoint(city, rnd);
    if (Math.hypot(p.x - cx, p.z - cz) <= r) return p;
  }
  const R = city.roads;
  const near = (v) => R.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
  return { x: near(cx), z: near(cz), yaw: rnd() * Math.PI * 2 };
}

/** n мест для старта вразброс по городу. */
export function spawnPoints(city, n, rnd = Math.random) {
  const pts = [];
  for (let k = 0; k < n; k++) {
    let best = null, bd = -1;
    for (let i = 0; i < 30; i++) {
      const p = roadPoint(city, rnd);
      const d = Math.min(Infinity, ...pts.map((q) => Math.hypot(q.x - p.x, q.z - p.z)));
      if (d >= ZONE.spawnGap) {
        best = p;
        break;
      }
      if (d > bd) {
        bd = d;
        best = p;
      }
    }
    pts.push(best);
  }
  return pts;
}

const CENTER_FREE = 4; // м — вокруг центра зоны ни дома, ни памятника: машина должна туда доехать
const solidFilter = (c) => c.kind !== 'breakable' && c.kind !== 'tree' && c.kind !== 'pole';
const wallFilter = (c) => c.kind === 'building' || c.kind === 'wall';

/** Расстояние от точки до коллайдера (0 — внутри). */
function distTo(c, x, z) {
  if (c.r != null) return Math.max(0, Math.hypot(x - c.x, z - c.z) - c.r);
  const dx = Math.max(c.minX - x, 0, x - c.maxX), dz = Math.max(c.minZ - z, 0, z - c.maxZ);
  return Math.hypot(dx, dz);
}

/**
 * До точки можно доехать: рядом нет ничего твёрдого, и хоть в одну из четырёх сторон до улицы
 * (края квартала) не мешает ни один дом — не двор-колодец и не щель между домами.
 */
export function reachable(city, x, z) {
  for (const c of city.world.queryCircle(x, z, CENTER_FREE)) if (solidFilter(c) && distTo(c, x, z) < CENTER_FREE) return false;
  const b = city.blocks.find((q) => x > q.x0 && x < q.x1 && z > q.z0 && z < q.z1);
  if (!b) return true; // на дороге
  const L = b.lot;
  if (x < L.x0 || x > L.x1 || z < L.z0 || z > L.z1) return true; // на тротуаре
  const ways = [[1, 0, b.x1 - x], [-1, 0, x - b.x0], [0, 1, b.z1 - z], [0, -1, z - b.z0]];
  return ways.some(([dx, dz, d]) => !city.world.raycast(x, z, dx, dz, d, wallFilter));
}

/**
 * Где сожмётся зона: где угодно в городе, но не ближе квартала к забору (до предпоследней улицы)
 * и не в доме — на дороге, тротуаре, площади или во дворе, куда можно доехать.
 */
export function zoneCenter(city, rnd = Math.random) {
  const lim = city.roads[city.roads.length - 2];
  for (let i = 0; i < 200; i++) {
    const cx = (rnd() * 2 - 1) * lim, cz = (rnd() * 2 - 1) * lim;
    if (reachable(city, cx, cz)) return { cx, cz };
  }
  const p = roadPoint(city, rnd); // не нашлось — на дорогу (почти не бывает)
  return { cx: Math.max(-lim, Math.min(lim, p.x)), cz: Math.max(-lim, Math.min(lim, p.z)) };
}

const vert = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const frag = `
uniform float uTime;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  // наклонные бегущие полосы, внизу ярче, вверх тают
  float stripe = step(0.5, fract(vUv.x * 120.0 + vUv.y * 6.0 - uTime * 0.6));
  float fade = 0.35 + 0.65 * pow(1.0 - vUv.y, 0.8); // до самого верха — чтобы стену было видно из-за домов
  float glow = smoothstep(0.04, 0.0, vUv.y);
  float a = (0.2 + stripe * 0.16) * fade + glow * 0.5;
  gl_FragColor = vec4(uColor * (1.0 + glow), a);
}`;

/** Цилиндр зоны: виден сквозь туман, стягивается к центру; снаружи корпус тает. */
export class Zone {
  constructor(scene) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 128, 1, true);
    geo.translate(0, 0.5, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color('#ff3b1f') } },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.wall = new THREE.Mesh(geo, this.mat);
    this.wall.renderOrder = 8;
    this.wall.frustumCulled = false;
    this.wall.visible = false;
    scene.add(this.wall);
    this.active = false;
    this.cx = 0;
    this.cz = 0;
    this.r0 = 0;
    this.radius = Infinity;
    this.t = 0;
  }

  /** Начать: центр (cx, cz); радиус сначала такой, чтобы накрыть весь город. */
  start(cx, cz, city) {
    const o = city.outer + 2;
    this.cx = cx;
    this.cz = cz;
    this.r0 = Math.max(...[[-o, -o], [o, -o], [-o, o], [o, o]].map(([x, z]) => Math.hypot(x - cx, z - cz))) + 10;
    this.active = true;
    this.wall.visible = true;
    this.update(0);
  }

  stop() {
    this.active = false;
    this.wall.visible = false;
    this.radius = Infinity;
  }

  /** Доля сжатия 0…1 на момент t (с от старта заезда). */
  progress(t) {
    return clamp((t - ZONE.hold) / (ZONE.shrink - ZONE.hold), 0, 1);
  }

  update(t) {
    if (!this.active) return;
    this.t = t;
    this.radius = this.r0 * (1 - this.progress(t));
    const r = Math.max(0.05, this.radius);
    this.wall.position.set(this.cx, 0, this.cz);
    this.wall.scale.set(r, ZONE.height, r);
    this.mat.uniforms.uTime.value = performance.now() / 1000;
  }

  outside(x, z) {
    return this.active && Math.hypot(x - this.cx, z - this.cz) > this.radius;
  }

  /** Скорость сжатия, м/с (до начала сжатия — 0). */
  get speed() {
    return this.t < ZONE.hold ? 0 : this.r0 / (ZONE.shrink - ZONE.hold);
  }

  /** Окажется ли точка снаружи через ahead секунд (с запасом margin м) — для ботов. */
  unsafe(x, z, ahead = 0, margin = 0) {
    return this.active && Math.hypot(x - this.cx, z - this.cz) > this.radius - this.speed * ahead - margin;
  }

  /** Урон в секунду снаружи сейчас. */
  get dps() {
    return lerp(ZONE.dps[0], ZONE.dps[1], this.progress(this.t));
  }

  /** Сколько секунд до полного сжатия. */
  get timeLeft() {
    return Math.max(0, ZONE.shrink - this.t);
  }
}
