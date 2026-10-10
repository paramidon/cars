import * as THREE from 'three';
import { clamp, lerp } from './utils.js';
import { NAV } from './nav/grid.js';

/** Королевская битва: смертельная зона. Крутить здесь. */
export const ZONE = {
  hold: 5, // с после старта зона ещё не сжимается
  shrink: 120, // с от старта до полного сжатия (радиус 0)
  dps: [2.5, 8], // урон корпусу в секунду снаружи: в начале и к концу сжатия
  height: 160, // м — стена видна из любой точки города
  spawnGap: 45, // м — машины на старте не ближе друг к другу
  hunt: 3, // с после старта боты уже охотятся
  centerIn: 0.62, // центр зоны — не дальше этой доли полуширины карты от её середины (в городе — до предпоследней улицы)
  centerFree: 4, // м — вокруг центра зоны ни дома, ни памятника: машина должна туда доехать
};

/**
 * A car's spot on nav floor i: { x, y, z, yaw } on the floor, heading along the floor's way (NavGrid.axis) — the way
 * of `want` ({ x, z }) if given, else either way.
 */
export function navSpot(nav, i, want = null, rnd = Math.random) {
  const p = nav.pos(i), a = nav.axis(i);
  const s = want ? (a.x * want.x + a.z * want.z >= 0 ? 1 : -1) : rnd() < 0.5 ? 1 : -1;
  return { x: p.x, y: p.y, z: p.z, yaw: Math.atan2(a.x * s, a.z * s) };
}

/**
 * An open floor: reachable, with `room` m of walkable floor all round — a street or a square rather than a gap between
 * a wall and a tree or a yard (today's bots steer straight at their waypoints). A map without such room gets less.
 */
const OPEN = [NAV.open, NAV.open / 2, 0];
const open = (nav, i, room) => nav.reachable(i) && nav.roomAt(i) >= room;

/** A random open spot on the map (heading along the way). */
export function randomSpot(nav, rnd = Math.random) {
  for (const room of OPEN) {
    const i = nav.randomCell((k) => open(nav, k, room), rnd);
    if (i >= 0) return navSpot(nav, i, null, rnd);
  }
  return navSpot(nav, nav.free[0], null, rnd);
}

/** A random open spot within r of (cx, cz); if there is none, the nearest open one. */
export function spotNear(nav, cx, cz, r, rnd = Math.random) {
  for (let k = 0; k < 60; k++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r;
    const col = nav.col(cx + Math.cos(a) * d, cz + Math.sin(a) * d);
    if (col < 0) continue;
    const s = nav.start[col], n = nav.start[col + 1] - s;
    if (!n) continue;
    const i = s + Math.floor(rnd() * n);
    if (open(nav, i, OPEN[0])) return navSpot(nav, i, null, rnd);
  }
  const far = Math.hypot(nav.nx, nav.nz) * nav.cell;
  for (const room of OPEN) {
    for (let d = Math.max(20, r); d < 2 * far; d *= 2) {
      const i = nav.nearestFree(cx, null, cz, d, { filter: (k) => open(nav, k, room) });
      if (i >= 0) return navSpot(nav, i, null, rnd);
    }
  }
  return navSpot(nav, nav.free[0], null, rnd);
}

/** Where a stuck bot is put (NAV_PLAN session 1): see freeSpotNear. */
export const SPOT = {
  r: 30, // m — searched this far around the car first (then 2×, 4×… if nothing is free)
  min: 8, // m — at least this far, out of the trap
  clear: 2.8, // m — no solid (a building, a tree, a pole, a wall…) this close
  edge: 1.5, // m of walkable floor all round: not at a drop or a ramp's side
  cars: 6, // m — no car this close (on the same level: within `level` m up or down)
  level: 4,
  lift: 2, // m above the floor: it drops onto it, so a car that drives in meanwhile isn't hit from inside
};

/**
 * The nearest free nav floor to (x, y, z), at least SPOT.min and preferably within SPOT.r away: no solid within
 * SPOT.clear, no car of `cars` within SPOT.cars. cost(px, pz) adds metres to a spot's distance (out of the zone, in a
 * human's view, past the next gate…; Infinity rules it out). Heading along the floor's way, the way of dir(px, pz) →
 * { x, z } if given. Returns { x, y, z, yaw } with y SPOT.lift above the floor (of the level the spot is on: under a
 * deck, in a tunnel), or null.
 */
export function freeSpotNear(nav, x, y, z, { cars = [], self = null, cost = null, dir = null } = {}) {
  const filter = (i) => {
    if (nav.roomAt(i) < SPOT.edge) return false;
    const p = nav.pos(i);
    for (const c of cars) if (c !== self && Math.hypot(c.x - p.x, c.z - p.z) < SPOT.cars && Math.abs(c.y - p.y) < SPOT.level) return false;
    return !nav.solidNear(i, SPOT.clear);
  };
  const costAt = cost && ((i) => {
    const p = nav.pos(i);
    return cost(p.x, p.z);
  });
  for (let r = SPOT.r; r <= 8 * SPOT.r; r *= 2) {
    const i = nav.nearestFree(x, y, z, r, { min: SPOT.min, filter, cost: costAt });
    if (i < 0) continue;
    const p = nav.pos(i);
    const sp = navSpot(nav, i, dir ? dir(p.x, p.z) : null);
    sp.y += SPOT.lift;
    return sp;
  }
  return null;
}

/** n мест для старта вразброс по карте. */
export function spawnPoints(nav, n, rnd = Math.random) {
  const pts = [];
  for (let k = 0; k < n; k++) {
    let best = null, bd = -1;
    for (let i = 0; i < 30; i++) {
      const p = randomSpot(nav, rnd);
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

/**
 * До точки можно доехать: под ней пол, связанный с остальной картой (не двор-колодец и не щель между домами), и
 * вокруг на ZONE.centerFree м нет ничего твёрдого.
 */
export function reachable(nav, x, z) {
  const col = nav.col(x, z);
  if (col < 0) return false;
  for (let i = nav.start[col]; i < nav.start[col + 1]; i++) if (nav.reachable(i) && !nav.solidNear(i, ZONE.centerFree)) return true;
  return false;
}

/**
 * Где сожмётся зона: где угодно на карте, но не ближе ZONE.centerIn её полуширины к краю, и не в доме — на дороге,
 * тротуаре, площади или во дворе, куда можно доехать.
 */
export function zoneCenter(nav, rnd = Math.random) {
  const hx = (nav.nx * nav.cell) / 2, hz = (nav.nz * nav.cell) / 2, mx = nav.x0 + hx, mz = nav.z0 + hz;
  const lx = hx * ZONE.centerIn, lz = hz * ZONE.centerIn;
  for (let k = 0; k < 200; k++) {
    const cx = mx + (rnd() * 2 - 1) * lx, cz = mz + (rnd() * 2 - 1) * lz;
    if (reachable(nav, cx, cz)) return { cx, cz };
  }
  const p = spotNear(nav, mx, mz, Math.min(lx, lz), rnd); // не нашлось (почти не бывает)
  return { cx: p.x, cz: p.z };
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
