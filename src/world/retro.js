import * as THREE from 'three';
import { mulberry32, clamp } from '../utils.js';
import { GeoBuilder, addBox, addCyl, addBlob, addCylMatrix } from './geom.js';
import { CollisionWorld } from '../physics/collision.js';
import * as TX from './textures.js';
import { XRAY } from '../xray.js';

/*
 * АТОМГРАД — the retro-futurist race map (`?map=retro`): a city of the 1960s' idea of the future on rolling ground.
 * The ground is a heightfield (a hill in the north, a dry concrete canal in the west, a sunken plaza in the middle);
 * a skyway on Y-pylons runs along the east side with a gap to jump; three bridges cross the canal; stunt ramps stand on
 * the south boulevard and a kicker on the hilltop. Saucer towers, domes, ribbon-window slabs, diners with butterfly
 * roofs, starburst signs and neon. Returns the same interface as buildCity() (src/world/city.js).
 */

const col = (hex) => new THREE.Color(hex);
const S = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const Z3 = [0, 0];
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _d = new THREE.Vector3();
const _y = new THREE.Vector3(0, 1, 0);

/** The layout, m. The race goes round the ring road: east on the south boulevard, north over the skyway, west over the hill, south along the canal's bed. */
export const ATOM = {
  outer: 196, // the fence's inner face (as the city's)
  cell: 2, // the terrain heightfield's cell
  ring: 150, // the ring road's centre lines: x = ±150, z = ±150
  road: 14, // a road's width (the south boulevard: z 139…161)
  streets: [-70, 0, 70], // the inner streets' centre lines, both ways
  // a plateau h m high (half sizes ax × az) sloping off over w m; it flattens out within `fade` m of the fence
  hill: { x: 0, z: -150, ax: 36, az: 14, h: 10, w: 70, fade: 32 },
  // the dry canal along the west ring road: bed half width, banks (≈34°), depth; full depth up to |z| = len, rising over `ramp` m
  canal: { x: -150, bed: 9, bank: 10.5, depth: 7, len: 72, ramp: 58 },
  // the sunken plaza in the middle: flat bottom radius, slope width, depth, the monument's island
  bowl: { r: 14, w: 26, depth: 4.5, island: 6 },
  // the skyway along x = 150: deck h m high; its ramps (ground end, deck end); a kicker on deck A before the gap
  sky: { x0: 144, x1: 156, h: 7, south: [127, 82], north: [-127, -82], kick: [12, 4], kickH: 1.2, gap: [-6, 4] },
  // stunt ramps in the south boulevard's middle: up along +x, a gap, a landing ramp down
  stunt: { z0: 145, z1: 155, up: [40, 54], down: [64, 80], h: 2.4 },
  // a kicker on the hilltop's west lip, pointing west (−x)
  kicker: { x0: -36, x1: -28, z0: -155, z1: -145, h: 1.4 },
  // bridges across the canal on the inner streets' lines
  bridge: { x0: -176, x1: -128, t: 1 },
};

/** Sky, fog and light for this map (main.js). */
export const ATOM_LOOK = { top: '#2b5f9c', horizon: '#f5cfa8', fog: [130, 420], hemi: ['#ffe8d0', '#5f6a58', 1.3], sun: ['#ffd8a6', 2.5] };

/** Height of the bare ground at (x, z): the hill, the canal, the bowl. Smooth; the heightfield samples it at its nodes. */
export function atomShape(x, z) {
  const { outer, hill: H, canal: K, bowl: B } = ATOM;
  let h = 0;
  const d = Math.hypot(Math.max(Math.abs(x - H.x) - H.ax, 0), Math.max(Math.abs(z - H.z) - H.az, 0));
  if (d < H.w) h += H.h * (1 - S(d / H.w)) * S((outer - Math.max(Math.abs(x), Math.abs(z))) / H.fade);
  const a = 1 - (Math.abs(x - K.x) - K.bed) / K.bank;
  if (a > 0) h -= K.depth * Math.min(a, 1) * (1 - S((Math.abs(z) - K.len) / K.ramp));
  const r = Math.hypot(x, z);
  if (r < B.r + B.w) h -= B.depth * (1 - S((r - B.r) / B.w));
  return h;
}

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Ribbon windows: a 12 × 14 m tile, 4 floors — a white spandrel and a band of glass with thin mullions on each. */
function ribbonTexture() {
  return canvasTex(256, 256, (g) => {
    const r = mulberry32(31);
    g.fillStyle = '#f3efe6';
    g.fillRect(0, 0, 256, 256);
    for (let f = 0; f < 4; f++) {
      const y = f * 64, gy = y + 24, gh = 32;
      const grad = g.createLinearGradient(0, gy, 0, gy + gh);
      grad.addColorStop(0, '#6f9cb2');
      grad.addColorStop(1, '#22465a');
      g.fillStyle = grad;
      g.fillRect(0, gy, 256, gh);
      for (let x = 0; x < 256; x += 32) {
        if (r() < 0.14) {
          g.fillStyle = 'rgba(255,212,140,0.9)';
          g.fillRect(x + 3, gy + 3, 29, gh - 5);
        }
        g.fillStyle = '#e6e1d6';
        g.fillRect(x, gy, 3, gh);
      }
      g.fillStyle = 'rgba(0,0,0,0.16)';
      g.fillRect(0, gy, 256, 3);
      g.fillStyle = 'rgba(0,0,0,0.07)';
      g.fillRect(0, y + 10, 256, 2);
    }
  });
}

/** A breeze-block screen: a 6 × 6 m tile of 8 × 8 blocks, each with a round hole and a four-point star. */
function screenTexture() {
  return canvasTex(256, 256, (g) => {
    g.fillStyle = '#f4eee2';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        const cx = i * 32 + 16, cy = j * 32 + 16;
        g.fillStyle = 'rgba(60,50,40,0.55)';
        g.beginPath();
        g.arc(cx, cy, 10, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#f4eee2';
        g.beginPath();
        g.moveTo(cx, cy - 11);
        g.lineTo(cx + 3, cy);
        g.lineTo(cx, cy + 11);
        g.lineTo(cx - 3, cy);
        g.closePath();
        g.fill();
        g.beginPath();
        g.moveTo(cx - 11, cy);
        g.lineTo(cx, cy + 3);
        g.lineTo(cx + 11, cy);
        g.lineTo(cx, cy - 3);
        g.closePath();
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.08)';
        g.strokeRect(i * 32 + 0.5, j * 32 + 0.5, 31, 31);
      }
    }
  });
}

/** Pale concrete paving: slabs 4 m long with joints, speckled. */
function roadTexture() {
  return canvasTex(256, 256, (g) => {
    const r = mulberry32(77);
    g.fillStyle = '#b4b0ba';
    g.fillRect(0, 0, 256, 256);
    const cols = ['#a7a3ad', '#bebac4', '#9d99a3', '#c6c2cb'];
    for (let i = 0; i < 5000; i++) {
      g.fillStyle = cols[Math.floor(r() * cols.length)];
      const s = 0.6 + r() * 1.4;
      g.fillRect(r() * 256, r() * 256, s, s);
    }
    g.fillStyle = 'rgba(60,55,70,0.35)';
    g.fillRect(0, 0, 256, 2);
    g.fillRect(0, 128, 256, 2);
    g.fillStyle = 'rgba(60,55,70,0.18)';
    g.fillRect(0, 0, 2, 256);
    g.fillRect(128, 0, 2, 256);
  });
}

/** A bright lawn. */
function lawnTexture() {
  return canvasTex(256, 256, (g) => {
    const r = mulberry32(19);
    g.fillStyle = '#9cc56a';
    g.fillRect(0, 0, 256, 256);
    const cols = ['#8fb95c', '#a9d077', '#86b055', '#b5d985', '#97bf63'];
    for (let i = 0; i < 4000; i++) {
      g.strokeStyle = cols[Math.floor(r() * cols.length)];
      const x = r() * 256, y = r() * 256;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (r() - 0.5) * 3, y - 2 - r() * 4);
      g.stroke();
    }
  });
}

/** The welcome arch's banner: the map's name. */
function bannerTexture() {
  const t = canvasTex(1024, 160, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#1d4f7a');
    grad.addColorStop(1, '#0f2c48');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#ff9a3c';
    g.lineWidth = 8;
    g.strokeRect(10, 10, w - 20, h - 20);
    g.font = 'italic 900 112px "Arial Black", Impact, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ff5ab4';
    g.fillText('АТОМГРАД', w / 2 + 5, h / 2 + 6);
    g.fillStyle = '#7ff6ee';
    g.fillText('АТОМГРАД', w / 2, h / 2);
  });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

export function buildRetro(scene, quality) {
  const rng = mulberry32(1957);
  const R = (a, b) => a + rng() * (b - a);
  const pickR = (arr) => arr[Math.floor(rng() * arr.length)];
  const A = ATOM, outer = A.outer, L = outer + 4, C = A.cell, NC = Math.round((2 * L) / C), NV = NC + 1;
  const HW = A.road / 2, K = A.canal, SK = A.sky, ST = A.streets;
  const world = new CollisionWorld(16);
  const g = {
    terrain: new GeoBuilder(),
    lawn: new GeoBuilder(), // the ground's layers (lawns, roads, paving) are laid a little over the terrain
    asphalt: new GeoBuilder(),
    walk: new GeoBuilder(),
    ribbon: new GeoBuilder(),
    screen: new GeoBuilder(),
    roof: new GeoBuilder(),
    props: new GeoBuilder(),
    foliage: new GeoBuilder(),
    marks: new GeoBuilder(),
    neon: new GeoBuilder(), // unlit: neon tubes, signs, lights
  };
  const solids = []; // static colliders for Rapier, as in buildCity(), plus { kind, hf } — the terrain heightfield
  const surfaces = []; // ground over the terrain (decks, ramps, bridges): { x0, z0, x1, z1, at(x, z) }
  const buildings = []; // for the minimap: { x0, z0, x1, z1, h } or { x, z, r, h }
  const props = [];
  const nodes = [];
  const blocks = [];

  const WHITE = col('#ffffff');
  const CREAM = col('#f1e9d8'), CONCRETE = col('#c4bcad'), CHROME = col('#dde2e6'), TEAL = col('#2aa39c');
  const ORANGE = col('#f08a24'), RED = col('#d8452f'), GLASS = col('#2c5970'), DARK = col('#2a2a30');
  const YELLOW = col('#f2c230');
  const PASTEL = ['#7fd1c7', '#f7a59a', '#f6d27a', '#a8c8f0', '#f2efe6', '#c9b6e8', '#9fdcb0', '#ffc9a0'];
  const ACCENT = ['#e8553f', '#1f9e9a', '#f2a93b', '#3a6fb0', '#d94f8a', '#6bbf59'];
  const NEON = ['#ff4fae', '#39f0e3', '#ffb03a', '#a6ff63', '#ff6a3d'];
  const neon = () => col(pickR(NEON));

  const solidBox = (x0, y0, z0, x1, y1, z1, kind) => {
    solids.push({ kind, box: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2] });
  };
  const solidCyl = (x, y0, z, y1, r, kind) => solids.push({ kind, cyl: [x, (y0 + y1) / 2, z, (y1 - y0) / 2, r] });
  const solidHull = (hull, kind) => solids.push({ kind, hull });

  // ---------------------------------------------------------------- the terrain
  const hgt = new Float32Array(NV * NV); // node heights, [iz · NV + ix]
  for (let iz = 0; iz < NV; iz++) for (let ix = 0; ix < NV; ix++) hgt[iz * NV + ix] = atomShape(-L + ix * C, -L + iz * C);
  /** Height of the terrain at (x, z), exactly as the heightfield collider has it. */
  function terrainAt(x, z) {
    const fx = clamp((x + L) / C, 0, NC - 1e-6), fz = clamp((z + L) / C, 0, NC - 1e-6);
    const ix = Math.floor(fx), iz = Math.floor(fz), u = fx - ix, v = fz - iz, k = iz * NV + ix;
    const h00 = hgt[k], h10 = hgt[k + 1], h01 = hgt[k + NV], h11 = hgt[k + NV + 1];
    // Rapier splits each cell into two triangles along the diagonal from (x0, z1) to (x1, z0)
    return u + v <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * v : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  }
  {
    // the collider: heights column by column (Rapier's rows go along z, columns along x)
    const heights = new Float32Array(NV * NV);
    for (let iz = 0; iz < NV; iz++) for (let ix = 0; ix < NV; ix++) heights[iz + ix * NV] = hgt[iz * NV + ix];
    solids.push({ kind: 'ground', hf: { rows: NC, cols: NC, heights, sx: 2 * L, sz: 2 * L, cx: 0, cz: 0 } });
  }
  /** The terrain's smooth normal at (x, z) (shading only). */
  function normalAt(x, z) {
    const dx = (atomShape(x + 1, z) - atomShape(x - 1, z)) / 2, dz = (atomShape(x, z + 1) - atomShape(x, z - 1)) / 2;
    const l = Math.hypot(dx, 1, dz);
    return [-dx / l, 1 / l, -dz / l];
  }
  /** Lowest and highest terrain under a rectangle (sampled every half cell). */
  function under(x0, z0, x1, z1) {
    let lo = Infinity, hi = -Infinity;
    const nx = Math.max(1, Math.ceil((x1 - x0) / (C / 2))), nz = Math.max(1, Math.ceil((z1 - z0) / (C / 2)));
    for (let i = 0; i <= nx; i++) {
      for (let j = 0; j <= nz; j++) {
        const h = terrainAt(x0 + ((x1 - x0) * i) / nx, z0 + ((z1 - z0) * j) / nz);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    return { lo, hi };
  }

  const UP = [0, 1, 0];
  /** Keep the part of a convex polygon [[x, z], …] where sgn · (x + z − k) ≤ 0. */
  function clipHalf(poly, k, sgn) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const fp = sgn * (p[0] + p[1] - k), fq = sgn * (q[0] + q[1] - k);
      if (fp <= 0) out.push(p);
      if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
        const t = fp / (fp - fq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    return out;
  }
  /**
   * Lay the rectangle [x0, x1] × [z0, z1] on the terrain, lift m over it: cut along the heightfield's cells and
   * diagonals, so it lies exactly on the collider's triangles (runs of flat cells are merged). tint(x, z) — a colour per vertex.
   */
  function drape(b, x0, z0, x1, z1, color, uv, lift = 0.02, tint = null) {
    const put = (x, z, y, n) => b._vert([x, y, z], n, [x / uv, z / uv], tint ? tint(x, z) : color);
    const poly = (pts) => {
      const v = pts.map(([x, z]) => [x, z, terrainAt(x, z) + lift, normalAt(x, z)]);
      for (let i = 1; i + 1 < v.length; i++) for (const p of [v[0], v[i], v[i + 1]]) put(p[0], p[1], p[2], p[3]);
    };
    const ix0 = Math.max(0, Math.floor((x0 + L) / C)), ix1 = Math.min(NC - 1, Math.ceil((x1 + L) / C) - 1);
    const iz0 = Math.max(0, Math.floor((z0 + L) / C)), iz1 = Math.min(NC - 1, Math.ceil((z1 + L) / C) - 1);
    for (let iz = iz0; iz <= iz1; iz++) {
      const cz0 = -L + iz * C, za = Math.max(z0, cz0), zb = Math.min(z1, cz0 + C);
      if (zb - za < 1e-4) continue;
      let run = null; // flat cells at one height: [xa, xb, h]
      const flush = () => {
        if (!run) return;
        const [xa, xb, h] = run, y = h + lift;
        for (const [x, z] of [[xa, za], [xa, zb], [xb, zb], [xa, za], [xb, zb], [xb, za]]) put(x, z, y, UP);
        run = null;
      };
      for (let ix = ix0; ix <= ix1; ix++) {
        const cx0 = -L + ix * C, xa = Math.max(x0, cx0), xb = Math.min(x1, cx0 + C);
        if (xb - xa < 1e-4) continue;
        const k = iz * NV + ix, h = hgt[k];
        if (hgt[k + 1] === h && hgt[k + NV] === h && hgt[k + NV + 1] === h) {
          if (run && run[2] === h && Math.abs(run[1] - xa) < 1e-6) run[1] = xb;
          else {
            flush();
            run = [xa, xb, h];
          }
          continue;
        }
        flush();
        const rect = [[xa, za], [xa, zb], [xb, zb], [xb, za]], d = cx0 + cz0 + C;
        const pa = clipHalf(rect, d, 1), pb = clipHalf(rect, d, -1);
        if (pa.length >= 3) poly(pa);
        if (pb.length >= 3) poly(pb);
      }
      flush();
    }
  }

  // ---------------------------------------------------------------- small shape helpers
  /** A prism along a segment: w wide, h tall from the heights ay → by. */
  function bar(b, ax, ay, az, bx, by, bz, w, h, color) {
    const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1, px = ((-dz / l) * w) / 2, pz = ((dx / l) * w) / 2;
    const a0 = [ax + px, ay, az + pz], a1 = [ax - px, ay, az - pz], b0 = [bx + px, by, bz + pz], b1 = [bx - px, by, bz - pz];
    const up = (p) => [p[0], p[1] + h, p[2]];
    b.quad(up(a0), up(b0), up(b1), up(a1), null, color, [0, 1, 0]);
    b.quad(a0, b0, up(b0), up(a0), null, color, [px, 0, pz]);
    b.quad(a1, b1, up(b1), up(a1), null, color, [-px, 0, -pz]);
    b.quad(a0, a1, up(a1), up(a0), null, color, [-dx, 0, -dz]);
    b.quad(b0, b1, up(b1), up(b0), null, color, [dx, 0, dz]);
    b.quad(a0, b0, b1, a1, null, color, [0, -1, 0]);
  }
  /** A cylinder of radius r from point a to point b. */
  function rod(b, ax, ay, az, bx, by, bz, r, color, seg = 8) {
    _d.set(bx - ax, by - ay, bz - az);
    const l = _d.length();
    _q.setFromUnitVectors(_y, _d.normalize());
    _m.compose(_p.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _q, _s.set(r, l, r));
    addCylMatrix(b, _m, color, seg);
  }
  /** A parabolic arch in the vertical plane through (x0, z0)–(x1, z1): feet at y0, the crown y1 high in the middle. */
  function arch(b, x0, z0, y0a, x1, z1, y0b, y1, w, h, color, n = 10) {
    let px = x0, pz = z0, py = y0a;
    for (let i = 1; i <= n; i++) {
      const t = i / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      const y = y0a + (y0b - y0a) * t + (y1 - (y0a + y0b) / 2) * 4 * t * (1 - t);
      bar(b, px, py, pz, x, y, z, w, h, color);
      px = x;
      pz = z;
      py = y;
    }
  }
  /** A starburst sign: 12 spikes in a vertical plane facing yaw, both faces, glowing. */
  function starburst(x, y, z, r, color, yaw = 0) {
    const fx = Math.cos(yaw), fz = -Math.sin(yaw), n = [Math.sin(yaw), 0, Math.cos(yaw)], nb = [-n[0], 0, -n[2]];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 + 0.13, len = k % 2 ? r * 0.55 : r, ux = Math.cos(a), uy = Math.sin(a), w = 0.12 * r;
      const tip = [x + fx * ux * len, y + uy * len, z + fz * ux * len];
      const a1 = [x - fx * uy * w, y + ux * w, z - fz * uy * w], a2 = [x + fx * uy * w, y - ux * w, z + fz * uy * w];
      g.neon.tri(a1, a2, tip, Z3, Z3, Z3, color, n);
      g.neon.tri(a1, a2, tip, Z3, Z3, Z3, color, nb);
    }
    addBlob(g.neon, x, y, z, 0.2 * r, CREAM, 1);
  }
  /** Something round that stops cars (a pole, a trunk, a column): a 2D circle and an upright cylinder from the ground; returns the ground's height. */
  function post(x, z, r, h, kind) {
    const y0 = under(x - r, z - r, x + r, z + r).lo;
    world.addCircle(x, z, r, { kind, h });
    solidCyl(x, y0 - 0.5, z, y0 + h, r, kind);
    return y0;
  }
  /** A concrete podium under a building on a slope: from below the lowest ground to the highest. */
  function podium(x0, z0, x1, z1, lo, hi) {
    addBox(g.props, (x0 + x1) / 2, (lo + hi) / 2, (z0 + z1) / 2, x1 - x0, hi - lo, z1 - z0, CONCRETE);
    addBox(g.neon, (x0 + x1) / 2, hi - 0.15, (z0 + z1) / 2, x1 - x0 + 0.06, 0.12, z1 - z0 + 0.06, col('#ffb03a'));
  }
  function wallQuad(b, ax, az, bx, bz, y0, y1, tw, th, color, out, uOff) {
    const len = Math.hypot(bx - ax, bz - az);
    const u0 = uOff, u1 = uOff + len / tw, v1 = (y1 - y0) / th;
    b.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], [[u0, 0], [u1, 0], [u1, v1], [u0, v1]], color, out);
  }

  // ---------------------------------------------------------------- what lies on the ground (1 m cells)
  const M = { none: 0, road: 1, walk: 2, plaza: 3, lawn: 4, concrete: 5, lot: 6 };
  const MN = 2 * L;
  const mask = new Uint8Array(MN * MN);
  const paint = (x0, z0, x1, z1, v) => {
    const a = Math.max(0, Math.round(x0 + L)), b = Math.min(MN, Math.round(x1 + L));
    for (let z = Math.max(0, Math.round(z0 + L)); z < Math.min(MN, Math.round(z1 + L)); z++) mask.fill(v, z * MN + a, z * MN + b);
  };
  const paintDisc = (cx, cz, r, v) => {
    for (let z = Math.floor(cz - r); z < cz + r; z++) {
      for (let x = Math.floor(cx - r); x < cx + r; x++) if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) < r) paint(x, z, x + 1, z + 1, v);
    }
  };
  const maskAt = (x, z) => {
    const ix = Math.floor(x + L), iz = Math.floor(z + L);
    return ix < 0 || iz < 0 || ix >= MN || iz >= MN ? 0 : mask[iz * MN + ix];
  };

  // the blocks between the streets (a 4 m sidewalk round a lot)
  const XR = [[-128, -77], [-63, -7], [7, 63], [77, 136]];
  const ZR = [[-143, -77], [-63, -7], [7, 63], [77, 139]];
  const SW = 4;
  paint(K.x - K.bed - K.bank - 1.5, -132, K.x + K.bed + K.bank + 1.5, 132, M.concrete); // the canal's concrete
  paint(-129, -143, -128, 139, M.walk); // the promenade along its rim
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const [x0, x1] = XR[i], [z0, z1] = ZR[j];
      const central = (i === 1 || i === 2) && (j === 1 || j === 2);
      const lot = { x0: x0 + SW, z0: z0 + SW, x1: x1 - SW, z1: z1 - SW };
      const bl = { i, j, x0, z0, x1, z1, lot, type: central ? 'plaza' : 'lot' };
      blocks.push(bl);
      paint(x0, z0, x1, z1, M.walk);
      paint(lot.x0, lot.z0, lot.x1, lot.z1, central ? M.plaza : M.lawn);
    }
  }
  // roads
  const roads = [
    [-188, 139, 164, 161], // the south boulevard
    [-188, -157, 164, -143], // the hill road
    [136, -157, 164, 161], // the east road, under the skyway
    [-157, -143, -143, 139], // the canal's bed
    [-188, -143, -176, 139], // the west service road, to the bridges
  ];
  for (const s of ST) {
    roads.push([s - HW, -143, s + HW, 139]);
    roads.push([-128, s - HW, 136, s + HW]);
  }
  for (const r of roads) paint(...r, M.road);
  paintDisc(0, 0, A.bowl.r, M.road); // the roundabout in the bowl
  // the outer strips: a sidewalk south of the boulevard, the motel's car park, a sidewalk by the canal's west rim
  paint(-188, 161, 164, 165, M.walk);
  paint(-176, -143, -171, 139, M.walk);
  paint(8, 165, 72, 173, M.lot);
  paint(-44, 165, -10, 170, M.lot);
  paint(88, -56, 130, -46, M.lot); // the diner's car park

  // ---------------------------------------------------------------- terrain and ground layers as meshes
  const grassLo = col('#ffffff'), grassHi = col('#fff0bc'), grassDeep = col('#e4f0dc');
  drape(g.terrain, -L, -L, L, L, null, 6, 0, (x, z) => {
    const h = terrainAt(x, z);
    return h > 3 ? grassHi : h < -0.5 ? grassDeep : grassLo;
  });
  // far ground round the playing square
  const far = col('#e9e2b8');
  for (const [x0, z0, x1, z1] of [[-1400, -1400, 1400, -L], [-1400, L, 1400, 1400], [-1400, -L, -L, L], [L, -L, 1400, L]]) g.terrain.flat(x0, z0, x1, z1, 0, far, 6);
  const LAYER = {
    [M.road]: [g.asphalt, col('#8f8b99'), 8],
    [M.walk]: [g.walk, col('#fff6e6'), 4],
    [M.plaza]: [g.walk, col('#ffc9b0'), 3],
    [M.lawn]: [g.lawn, col('#f4ffe8'), 6],
    [M.concrete]: [g.asphalt, col('#fff4e2'), 8],
    [M.lot]: [g.asphalt, col('#c9c3d6'), 8],
  };
  {
    // merge the mask into rectangles: runs along x, grown along z while the same run goes on
    const open = new Map();
    const emit = (r, z1) => {
      const [b, c, uv] = LAYER[r.v];
      drape(b, r.x0 - L, r.z0 - L, r.x1 - L, z1 - L, c, uv, 0.02);
    };
    for (let z = 0; z <= MN; z++) {
      const runs = new Map();
      if (z < MN) {
        for (let x = 0; x < MN;) {
          const v = mask[z * MN + x];
          let e = x + 1;
          while (e < MN && mask[z * MN + e] === v) e++;
          if (v) runs.set(`${x},${e},${v}`, [x, e, v]);
          x = e;
        }
      }
      for (const [key, r] of open) {
        if (!runs.has(key)) {
          emit(r, z);
          open.delete(key);
        }
      }
      for (const [key, [x0, x1, v]] of runs) if (!open.has(key)) open.set(key, { x0, x1, z0: z, v });
    }
  }
  // lane markings: dashes down a road's middle (not across a crossing), zebras where the pedestrians cross
  const MARK = col('#f6f2e8');
  const markRect = (x0, z0, x1, z1, c = MARK) => drape(g.marks, x0, z0, x1, z1, c, 4, 0.04);
  function dashes(x0, z0, x1, z1, half) {
    const alongX = x1 - x0 > z1 - z0;
    const len = alongX ? x1 - x0 : z1 - z0;
    for (let s = 2; s + 3 <= len; s += 6) {
      const cx = alongX ? x0 + s + 1.5 : x0, cz = alongX ? z0 : z0 + s + 1.5;
      const side = half + 1.5;
      if (maskAt(cx, cz) !== M.road) continue;
      if (alongX ? maskAt(cx, cz - side) === M.road || maskAt(cx, cz + side) === M.road : maskAt(cx - side, cz) === M.road || maskAt(cx + side, cz) === M.road) continue;
      if (alongX) markRect(x0 + s, z0 - 0.1, x0 + s + 3, z0 + 0.1);
      else markRect(x0 - 0.1, z0 + s, x0 + 0.1, z0 + s + 3);
    }
  }
  dashes(-188, 150, 164, 150, 11);
  dashes(-188, -150, 164, -150, HW);
  dashes(-150, -143, -150, 139, HW);
  dashes(-182, -143, -182, 139, 6);
  for (const s of ST) {
    dashes(s, -143, s, 139, HW);
    dashes(-128, s, 136, s, HW);
  }
  // the boulevard's edge lines
  for (const z of [139.4, 160.6]) markRect(-188, z - 0.1, 136, z + 0.1);

  // ---------------------------------------------------------------- ramps, decks, rails
  const RAMP_TOP = col('#ddd5c6'), FASCIA = col('#3cb6ae'), UNDER = col('#9a948a');
  /** Ramp rising from h0 to h1 along dir ('+z', '-z', '+x', '-x') standing on `base`: a surface, a convex collider, a mesh. */
  function ramp(x0, z0, x1, z1, dir, h0, h1, base, stripes = true) {
    const alongX = dir[1] === 'x', sgn = dir[0] === '+' ? 1 : -1;
    const at = (x, z) => {
      let t = alongX ? (x - x0) / (x1 - x0) : (z - z0) / (z1 - z0);
      if (sgn < 0) t = 1 - t;
      return h0 + (h1 - h0) * clamp(t, 0, 1);
    };
    surfaces.push({ x0, z0, x1, z1, at });
    const hull = [];
    for (const [x, z] of [[x0, z0], [x0, z1], [x1, z1], [x1, z0]]) hull.push(x, at(x, z), z, x, base - 0.5, z);
    solidHull(hull, 'ramp');
    const P = (x, z, dy = 0) => [x, at(x, z) + dy, z];
    g.asphalt.quad(P(x0, z0), P(x0, z1), P(x1, z1), P(x1, z0), [[x0 / 8, z0 / 8], [x0 / 8, z1 / 8], [x1 / 8, z1 / 8], [x1 / 8, z0 / 8]], RAMP_TOP, [0, 1, 0]);
    const side = (ax, az, bx, bz, out) => g.props.quad([ax, base - 0.3, az], [bx, base - 0.3, bz], P(bx, bz), P(ax, az), null, FASCIA, out);
    side(x0, z0, x1, z0, [0, 0, -1]);
    side(x0, z1, x1, z1, [0, 0, 1]);
    side(x0, z0, x0, z1, [-1, 0, 0]);
    side(x1, z0, x1, z1, [1, 0, 0]);
    if (!stripes) return at;
    // yellow and black bands across the top, the last one at the lip
    const len = alongX ? x1 - x0 : z1 - z0;
    for (let d = 1, k = 0; d < len - 0.1; d += 1.2, k++) {
      if (d < len - 3.6 && k % 3) continue;
      const a = sgn > 0 ? d : len - d - 0.6, b = a + 0.6, c = k % 2 ? DARK : YELLOW;
      const q = alongX
        ? [P(x0 + a, z0, 0.02), P(x0 + a, z1, 0.02), P(x0 + b, z1, 0.02), P(x0 + b, z0, 0.02)]
        : [P(x0, z0 + a, 0.02), P(x0, z0 + b, 0.02), P(x1, z0 + b, 0.02), P(x1, z0 + a, 0.02)];
      g.marks.quad(...q, null, c, [0, 1, 0]);
    }
    return at;
  }
  /** A flat deck at height y, t thick, on whatever holds it up. */
  function deck(x0, z0, x1, z1, y, t, lift = 0) {
    surfaces.push({ x0, z0, x1, z1, at: () => y });
    solidBox(x0, y - t, z0, x1, y, z1, 'deck');
    const top = y + lift;
    g.asphalt.quad([x0, top, z0], [x0, top, z1], [x1, top, z1], [x1, top, z0], [[x0 / 8, z0 / 8], [x0 / 8, z1 / 8], [x1 / 8, z1 / 8], [x1 / 8, z0 / 8]], col('#8f8b99'), [0, 1, 0]);
    g.props.quad([x0, y - t, z0], [x1, y - t, z0], [x1, y - t, z1], [x0, y - t, z1], null, UNDER, [0, -1, 0]);
    const side = (ax, az, bx, bz, out) => g.props.quad([ax, y - t, az], [bx, y - t, bz], [bx, top, bz], [ax, top, az], null, FASCIA, out);
    side(x0, z0, x1, z0, [0, 0, -1]);
    side(x0, z1, x1, z1, [0, 0, 1]);
    side(x0, z0, x0, z1, [-1, 0, 0]);
    side(x1, z0, x1, z1, [1, 0, 0]);
  }
  /** A 0.9 m rail from (ax, az) to (bx, bz) standing on the heights ya → yb: a convex collider, a bar on posts. */
  function rail(ax, az, ya, bx, bz, yb, color = CHROME) {
    const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz), px = (-dz / l) * 0.15, pz = (dx / l) * 0.15;
    const hull = [];
    for (const [x, z, y] of [[ax + px, az + pz, ya], [ax - px, az - pz, ya], [bx + px, bz + pz, yb], [bx - px, bz - pz, yb]]) hull.push(x, y - 0.3, z, x, y + 0.9, z);
    solidHull(hull, 'rail');
    bar(g.props, ax, ya + 0.66, az, bx, yb + 0.66, bz, 0.24, 0.24, color);
    bar(g.props, ax, ya + 0.3, az, bx, yb + 0.3, bz, 0.12, 0.12, TEAL);
    const n = Math.max(1, Math.round(l / 2.5));
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      addBox(g.props, ax + dx * f, ya + (yb - ya) * f + 0.33, az + dz * f, 0.12, 0.66, 0.12, DARK);
    }
  }

  // ---------------------------------------------------------------- the skyway (east side, x = 150)
  {
    const { x0, x1, h } = SK, xc = (x0 + x1) / 2, t = 1;
    const [sG, sD] = SK.south, [nG, nD] = SK.north, [k0, k1] = SK.kick, [gap0, gap1] = SK.gap;
    deck(x0, gap1, x1, sD, h, t); // deck A: from the south ramp's top to the gap
    deck(x0, nD, x1, gap0, h, t); // deck B: from the gap to the north ramp's top
    ramp(x0, sD, x1, sG, '-z', 0, h, 0); // up, northbound
    ramp(x0, nG, x1, nD, '+z', 0, h, 0); // down, northbound
    // the kicker before the gap, between the rails
    ramp(x0 + 0.45, k1, x1 - 0.45, k0, '-z', h, h + SK.kickH, h);
    // rails along both edges, the ramps too
    const rx = [x0 + 0.3, x1 - 0.3];
    for (const x of rx) {
      rail(x, sG, 0, x, sD, h);
      rail(x, sD, h, x, gap1, h);
      rail(x, gap0, h, x, nD, h);
      rail(x, nD, h, x, nG, 0);
    }
    // markings: a dashed middle, the gap's hazard bands
    for (let z = nD + 3; z < sD - 3; z += 6) {
      if (z > gap0 - 3 && z < k0 + 3) continue;
      g.marks.quad([xc - 0.1, h + 0.02, z], [xc - 0.1, h + 0.02, z + 3], [xc + 0.1, h + 0.02, z + 3], [xc + 0.1, h + 0.02, z], null, MARK, [0, 1, 0]);
    }
    for (let x = x0 + 0.6; x < x1 - 0.6; x += 1.2) {
      const c = Math.round((x - x0) / 1.2) % 2 ? DARK : YELLOW;
      g.marks.quad([x, h + 0.02, gap0 - 1.5], [x, h + 0.02, gap0], [x + 1.2, h + 0.02, gap0], [x + 1.2, h + 0.02, gap0 - 1.5], null, c, [0, 1, 0]);
    }
    // glowing chevrons on deck A pointing at the kicker (northbound, −z)
    const CH = col('#ff6a3d');
    for (let z = k0 + 4; z < k0 + 26; z += 5) {
      const y = h + 0.03, w = 3.6;
      g.neon.quad([xc - w, y, z + 1.4], [xc - w, y, z + 2.2], [xc, y, z + 0.8], [xc, y, z], null, CH, [0, 1, 0]);
      g.neon.quad([xc, y, z], [xc, y, z + 0.8], [xc + w, y, z + 2.2], [xc + w, y, z + 1.4], null, CH, [0, 1, 0]);
    }
    // neon strips under the deck's edges
    for (const [za, zb] of [[gap1, sD], [nD, gap0]]) {
      for (const x of [x0 + 0.1, x1 - 0.1]) addBox(g.neon, x, h - t - 0.06, (za + zb) / 2, 0.14, 0.12, zb - za, col('#ff4fae'));
    }
    // Y-pylons: a column and two arms under a cross beam (the streets at z = ±70 and 0 pass between them)
    for (const z of [-56, -40, -24, -11, 11, 24, 40, 56]) {
      const yb = h - t;
      const y0 = post(xc, z, 1.1, yb, 'pillar');
      addCyl(g.props, xc, y0 - 0.4, z, 1.1, 4.8 - y0 + 0.4, CREAM, 14, 0.9);
      rod(g.props, xc, 4.2, z, x0 + 1, yb - 0.5, z, 0.45, CREAM, 8);
      rod(g.props, xc, 4.2, z, x1 - 1, yb - 0.5, z, 0.45, CREAM, 8);
      addBox(g.props, xc, yb - 0.3, z, x1 - x0 - 0.6, 0.6, 1.3, TEAL);
      addCyl(g.neon, xc, 2.4, z, 1.13, 0.25, col('#39f0e3'), 14);
    }
    // lamp posts on the rails with boomerang heads
    for (let z = nD + 8; z < sD; z += 24) {
      if (z > gap0 - 4 && z < gap1 + 4) continue;
      for (const x of rx) {
        const s = x < xc ? 1 : -1;
        addCyl(g.props, x, h, z, 0.1, 5.5, DARK, 6);
        bar(g.props, x, h + 5.4, z, x + s * 1.8, h + 5.9, z, 0.3, 0.16, DARK);
        addBox(g.neon, x + s * 1.3, h + 5.5, z, 0.9, 0.08, 0.35, col('#fff2c8'));
      }
    }
  }

  // ---------------------------------------------------------------- the canal: bridges, rails along the rims
  {
    const { x0, x1, t } = A.bridge, cx0 = K.x - K.bed - K.bank - 0.5, cx1 = K.x + K.bed + K.bank + 0.5;
    for (const zc of ST) {
      const z0 = zc - HW, z1 = zc + HW;
      deck(x0, z0, x1, z1, 0, t, 0.03);
      rail(cx0, z0 + 0.3, 0, cx1, z0 + 0.3, 0);
      rail(cx0, z1 - 0.3, 0, cx1, z1 - 0.3, 0);
      for (const z of [z0, z1]) addBox(g.neon, (cx0 + cx1) / 2, -t - 0.05, z, cx1 - cx0, 0.1, 0.12, col('#39f0e3'));
      // an orange parabolic arch under each edge, its feet on the banks
      const fa = K.x - 15, fb = K.x + 15;
      for (const z of [z0 + 1, z1 - 1]) arch(g.props, fa, z, terrainAt(fa, z) - 0.3, fb, z, terrainAt(fb, z) - 0.3, -t - 0.05, 0.7, 0.5, ORANGE, 14);
      for (let x = x0 + 2; x + 3 < x1; x += 6) g.marks.quad([x, 0.05, zc - 0.1], [x, 0.05, zc + 0.1], [x + 3, 0.05, zc + 0.1], [x + 3, 0.05, zc - 0.1], null, MARK, [0, 1, 0]);
    }
    const spans = [[-115, ST[0] - HW], [ST[0] + HW, ST[1] - HW], [ST[1] + HW, ST[2] - HW], [ST[2] + HW, 115]];
    for (const [za, zb] of spans) {
      for (const x of [cx0 - 0.2, cx1 + 0.2]) rail(x, za, 0, x, zb, 0, col('#f2efe6'));
    }
    // ladders of light down the banks every 20 m
    for (let z = -100; z <= 100; z += 20) {
      if (ST.some((s) => Math.abs(z - s) < 10)) continue;
      for (const s of [-1, 1]) {
        const xa = K.x + s * (K.bed + K.bank), xb = K.x + s * K.bed;
        bar(g.neon, xa, terrainAt(xa, z) + 0.02, z, xb, terrainAt(xb, z) + 0.02, z, 0.25, 0.04, col('#ffb03a'));
      }
    }
  }

  // ---------------------------------------------------------------- stunt ramps and the hilltop kicker
  {
    const T = A.stunt;
    ramp(T.up[0], T.z0, T.up[1], T.z1, '+x', 0, T.h, 0);
    ramp(T.down[0], T.z0, T.down[1], T.z1, '-x', 0, T.h, 0);
    const y = 0.04, CH = col('#ffb03a'), zc = (T.z0 + T.z1) / 2;
    for (let x = T.up[0] - 26; x < T.up[0] - 4; x += 5) {
      g.neon.quad([x, y, zc - 4], [x + 0.8, y, zc - 4], [x + 2, y, zc], [x + 1.2, y, zc], null, CH, [0, 1, 0]);
      g.neon.quad([x + 1.2, y, zc], [x + 2, y, zc], [x + 0.8, y, zc + 4], [x, y, zc + 4], null, CH, [0, 1, 0]);
    }
    const H = A.kicker, top = terrainAt((H.x0 + H.x1) / 2, (H.z0 + H.z1) / 2);
    ramp(H.x0, H.z0, H.x1, H.z1, '-x', top, top + H.h, top);
  }

  // ---------------------------------------------------------------- buildings
  /** A slab with ribbon windows (or a breeze-block screen), an overhanging roof and a fin. */
  function slab(x0, z0, x1, z1, floors, color, tex = 'ribbon', accent = col(pickR(ACCENT))) {
    const { lo, hi } = under(x0 - 0.6, z0 - 0.6, x1 + 0.6, z1 + 0.6);
    const base = hi, top = base + floors * 3.5;
    const sunk = hi - lo > 0.05;
    if (sunk) podium(x0 - 0.6, z0 - 0.6, x1 + 0.6, z1 + 0.6, lo - 0.4, hi);
    const [tw, th] = tex === 'ribbon' ? [12, 14] : [6, 6];
    const b = g[tex], u = Math.floor(rng() * 4) * 0.25;
    wallQuad(b, x0, z1, x1, z1, base, top, tw, th, color, [0, 0, 1], u);
    wallQuad(b, x1, z0, x0, z0, base, top, tw, th, color, [0, 0, -1], u);
    wallQuad(b, x1, z1, x1, z0, base, top, tw, th, color, [1, 0, 0], u);
    wallQuad(b, x0, z0, x0, z1, base, top, tw, th, color, [-1, 0, 0], u);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;
    addBox(g.props, cx, top + 0.25, cz, w + 1.6, 0.5, d + 1.6, CREAM);
    g.roof.flat(x0 - 0.8, z0 - 0.8, x1 + 0.8, z1 + 0.8, top + 0.51, col('#9c9690'), 4);
    addBox(g.neon, cx, top - 0.06, cz, w + 1.62, 0.12, d + 1.62, neon());
    // the fin: a tall sign on one end of the roof, a neon edge
    if (w >= d) {
      const fx = rng() < 0.5 ? x0 + 1.5 : x1 - 1.5;
      addBox(g.props, fx, top + 4.5, cz, 0.6, 8, d * 0.7, accent);
      addBox(g.neon, fx, top + 4.5, cz - d * 0.35 - 0.05, 0.64, 8, 0.12, neon());
    } else {
      const fz = rng() < 0.5 ? z0 + 1.5 : z1 - 1.5;
      addBox(g.props, cx, top + 4.5, fz, w * 0.7, 8, 0.6, accent);
      addBox(g.neon, cx - w * 0.35 - 0.05, top + 4.5, fz, 0.12, 8, 0.64, neon());
    }
    const p = sunk ? 0.6 : 0;
    world.addAABB(x0 - p, z0 - p, x1 + p, z1 + p, { kind: 'building', h: top });
    solidBox(x0 - p, lo - 0.5, z0 - p, x1 + p, top + 0.5, z1 + p, 'building');
    buildings.push({ x0, z0, x1, z1, h: top });
  }

  /** A saucer tower: a drum, a tapered shaft, a flying saucer H m up, an antenna. */
  function needle(x, z, H) {
    const { lo, hi } = under(x - 6, z - 6, x + 6, z + 6);
    const base = hi, accent = col(pickR(ACCENT)), glow = neon();
    addCyl(g.props, x, lo - 0.5, z, 6, base - lo + 3.5, CREAM, 24);
    addCyl(g.neon, x, base + 2.7, z, 6.04, 0.25, glow, 24);
    addCyl(g.props, x, base + 3, z, 2, H - 3, CHROME, 14, 1.4);
    for (let y = base + 8; y < base + H - 4; y += 7) addCyl(g.props, x, y, z, 1.95 - ((y - base) / H) * 0.55, 0.6, accent, 14);
    const sy = base + H;
    addCyl(g.props, x, sy - 2.5, z, 1.6, 2.5, accent, 28, 10);
    addCyl(g.neon, x, sy, z, 10.05, 0.35, glow, 28);
    addCyl(g.props, x, sy + 0.35, z, 9.6, 0.9, GLASS, 28, 8.8);
    addCyl(g.props, x, sy + 1.25, z, 8.8, 1.6, CHROME, 28, 4);
    addCyl(g.props, x, sy + 2.85, z, 4, 1.2, accent, 20, 1);
    addCyl(g.props, x, sy + 4, z, 0.25, 12, CHROME, 6, 0.05);
    addBlob(g.neon, x, sy + 16.2, z, 0.5, col('#ff3b3b'), 1);
    world.addCircle(x, z, 6, { kind: 'building', h: sy + 4 });
    solidCyl(x, lo - 0.5, z, base + 3, 6, 'building');
    solidCyl(x, base + 3, z, sy - 2.5, 2, 'building');
    solidCyl(x, sy - 2.5, z, sy + 4, 10, 'building');
    buildings.push({ x, z, r: 6, disc: 10, h: sy + 4 });
  }

  /** A dome on a drum: panels in two tones, a neon ring, an oculus and a finial. One convex collider. */
  function dome(x, z, r, color = col(pickR(PASTEL))) {
    const { lo, hi } = under(x - r - 0.6, z - r - 0.6, x + r + 0.6, z + r + 0.6);
    const base = hi + 1.6, M2 = 24, N2 = 6, glow = neon(), dark = color.clone().multiplyScalar(0.82);
    addCyl(g.props, x, lo - 0.5, z, r + 0.6, base - lo + 0.5, CREAM, 32);
    addCyl(g.neon, x, base - 0.3, z, r + 0.64, 0.22, glow, 32);
    const P = (i, j) => {
      const la = (i / N2) * (Math.PI / 2) * 0.96, lo2 = (j / M2) * Math.PI * 2;
      return [x + r * Math.cos(la) * Math.cos(lo2), base + r * Math.sin(la), z + r * Math.cos(la) * Math.sin(lo2)];
    };
    const hull = [];
    for (let j = 0; j < M2; j++) {
      const a = (j / M2) * Math.PI * 2;
      hull.push(x + (r + 0.6) * Math.cos(a), lo - 0.5, z + (r + 0.6) * Math.sin(a));
      for (let i = 0; i < N2; i++) {
        const a0 = P(i, j), a1 = P(i, j + 1), b0 = P(i + 1, j), b1 = P(i + 1, j + 1);
        const mx = (a0[0] + b1[0]) / 2 - x, my = (a0[1] + b1[1]) / 2 - base, mz = (a0[2] + b1[2]) / 2 - z;
        g.props.quad(a0, a1, b1, b0, null, i === N2 - 1 ? CREAM : (i + j) % 2 ? color : dark, [mx, my, mz]);
        hull.push(...a0);
      }
    }
    hull.push(x, base + r, z);
    const cap = P(N2, 0)[1];
    addCyl(g.neon, x, cap - 0.1, z, r * Math.cos(Math.PI / 2 * 0.96) + 0.4, 0.3, glow, 16);
    addCyl(g.props, x, cap, z, 0.3, 3.5, CHROME, 6, 0.05);
    world.addCircle(x, z, r + 0.6, { kind: 'building', h: base + r });
    solidHull(hull, 'building');
    buildings.push({ x, z, r: r + 0.6, h: base + r });
  }

  /** Levels of glass stacked and turned 22.5° each, white slabs between them. */
  function stack(x, z, levels, color = col(pickR(PASTEL))) {
    const { lo, hi } = under(x - 6, z - 6, x + 6, z + 6);
    let y = hi;
    addBox(g.props, x, (lo + hi) / 2 - 0.25, z, 12.4, hi - lo + 0.5, 12.4, CONCRETE);
    solidBox(x - 6.2, lo - 0.5, z - 6.2, x + 6.2, hi + 4.2, z + 6.2, 'building');
    for (let k = 0; k < levels; k++) {
      const s = k === 0 ? 12 : 15 + (k % 2) * 3, rot = (k * Math.PI) / 8, H = 4.2;
      addBox(g.props, x, y + (H - 0.6) / 2, z, s - 1.2, H - 0.6, s - 1.2, GLASS, rot);
      addBox(g.props, x, y + H - 0.3, z, s, 0.6, s, k % 2 ? color : CREAM, rot);
      addBox(g.neon, x, y + H - 0.66, z, s + 0.05, 0.1, s + 0.05, k % 2 ? neon() : col('#fff2c8'), rot);
      if (k) {
        const hull = [], c = Math.cos(rot), sn = Math.sin(rot);
        for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const px = x + (a * c + b * sn) * (s / 2), pz = z + (-a * sn + b * c) * (s / 2);
          hull.push(px, y, pz, px, y + H, pz);
        }
        solidHull(hull, 'building');
      }
      y += H;
    }
    addCyl(g.props, x, y, z, 0.2, 9, CHROME, 6, 0.05);
    starburst(x, y + 9.5, z, 1.6, neon(), rng() * Math.PI);
    world.addAABB(x - 6.2, z - 6.2, x + 6.2, z + 6.2, { kind: 'building', h: y });
    buildings.push({ x0: x - 6.2, z0: z - 6.2, x1: x + 6.2, z1: z + 6.2, h: y });
  }

  /** A diner: a low box with a band of glass, a butterfly roof, neon trim and a starburst sign on a pole. */
  function diner(x0, z0, x1, z1, color = col(pickR(PASTEL)), signAt = null) {
    const { lo, hi } = under(x0 - 1.6, z0 - 1.6, x1 + 1.6, z1 + 1.6);
    const base = hi, H = 4.2, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;
    if (hi - lo > 0.05) podium(x0 - 1.6, z0 - 1.6, x1 + 1.6, z1 + 1.6, lo - 0.4, hi);
    addBox(g.props, cx, base + H / 2, cz, w, H, d, color);
    addBox(g.props, cx, base + 2.1, cz, w + 0.1, 2, d + 0.1, GLASS);
    // the roof: two planes falling to a valley along the long side
    const o = 1.5, yh = base + H + 1.5, yv = base + H + 0.2, roofC = col(pickR(ACCENT));
    if (w >= d) {
      for (const ze of [z0 - o, z1 + o]) {
        const a = [x0 - o, yh, ze], b = [x1 + o, yh, ze], c = [x1 + o, yv, cz], e = [x0 - o, yv, cz];
        g.props.quad(a, b, c, e, null, roofC, [0, 1, 0]);
        g.props.quad(a, b, c, e, null, CREAM, [0, -1, 0]);
        bar(g.neon, x0 - o, yh - 0.12, ze, x1 + o, yh - 0.12, ze, 0.12, 0.12, neon());
      }
    } else {
      for (const xe of [x0 - o, x1 + o]) {
        const a = [xe, yh, z0 - o], b = [xe, yh, z1 + o], c = [cx, yv, z1 + o], e = [cx, yv, z0 - o];
        g.props.quad(a, b, c, e, null, roofC, [0, 1, 0]);
        g.props.quad(a, b, c, e, null, CREAM, [0, -1, 0]);
        bar(g.neon, xe, yh - 0.12, z0 - o, xe, yh - 0.12, z1 + o, 0.12, 0.12, neon());
      }
    }
    world.addAABB(x0, z0, x1, z1, { kind: 'building', h: base + H });
    solidBox(x0, lo - 0.5, z0, x1, base + H + 0.2, z1, 'building');
    buildings.push({ x0, z0, x1, z1, h: base + H });
    if (signAt) sign(signAt[0], signAt[1], signAt[2] ?? 0);
  }

  /** A starburst on a tall pole, turned to yaw. */
  function sign(x, z, yaw) {
    const y0 = post(x, z, 0.35, 11, 'pole');
    addCyl(g.props, x, y0, z, 0.35, 9, CHROME, 8, 0.25);
    addBox(g.props, x, y0 + 7.4, z, Math.abs(Math.cos(yaw)) * 4 + 0.4, 1.6, Math.abs(Math.sin(yaw)) * 4 + 0.4, col(pickR(ACCENT)));
    starburst(x, y0 + 10.6, z, 2.2, neon(), yaw);
  }

  /** A rocket on its fins: the monument by the start. */
  function rocket(x, z) {
    const y0 = post(x, z, 3.4, 24, 'statue');
    addCyl(g.props, x, y0 - 0.3, z, 5.2, 0.9, CONCRETE, 28);
    addCyl(g.neon, x, y0 + 0.5, z, 5.24, 0.18, col('#39f0e3'), 28);
    addCyl(g.props, x, y0 + 1.6, z, 2.2, 14, CHROME, 22, 2);
    for (const y of [5, 11]) addCyl(g.props, x, y0 + y, z, 2.22 - y * 0.012, 1, RED, 22);
    addCyl(g.props, x, y0 + 15.6, z, 2, 7, RED, 22, 0.05);
    addCyl(g.neon, x, y0 + 0.9, z, 1.5, 0.7, ORANGE, 16, 1.9);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.4, dx = Math.cos(a), dz = Math.sin(a);
      addBox(g.props, x + dx * 2.9, y0 + 3.4, z + dz * 2.9, 0.4, 5.4, 2.6, RED, Math.atan2(dx, dz));
    }
    addCyl(g.neon, x, y0 + 12.4, z, 2.08, 0.2, col('#ffb03a'), 22);
    buildings.push({ x, z, r: 3.4, h: y0 + 24 });
  }

  /** An atom: a ball and three glowing orbits on a pole. */
  function atom(x, z, y, r = 3) {
    const y0 = post(x, z, 0.4, y + r, 'pole');
    addCyl(g.props, x, y0, z, 0.4, y, CHROME, 8, 0.25);
    addBlob(g.props, x, y0 + y, z, r * 0.3, RED, 1);
    for (let k = 0; k < 3; k++) {
      _q.setFromEuler(new THREE.Euler(Math.PI / 2 + (k - 1) * 0.95, (k * Math.PI) / 3, 0));
      _m.compose(_p.set(x, y0 + y, z), _q, _s.set(1, 1, 1));
      g.neon.addGeometry(new THREE.TorusGeometry(r, 0.09, 6, 36), _m, col(NEON[k]));
    }
  }

  /** Trees: palms and «lollipops». */
  function palm(x, z, s = 1) {
    const y0 = post(x, z, 0.36 * s, 8 * s, 'tree');
    const H = 7.6 * s, ty = y0 + H;
    addCyl(g.props, x, y0, z, 0.36 * s, H, col('#8b6b4b'), 7, 0.22 * s);
    const leaf = col(pickR(['#3f8f5a', '#4c9a4a', '#2f7f63']));
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + R(-0.25, 0.25), len = R(3.2, 4.4) * s, c = Math.cos(a), sn = Math.sin(a);
      const e = [x + c * len, ty - R(1.3, 2.3) * s, z + sn * len], m = [x + c * len * 0.5, ty + 0.45 * s, z + sn * len * 0.5];
      const px = -sn * 0.75 * s, pz = c * 0.75 * s, t0 = [x, ty, z];
      for (const out of [[0, 1, 0], [0, -1, 0]]) {
        g.foliage.tri(t0, [m[0] + px, m[1], m[2] + pz], e, Z3, Z3, Z3, leaf, out);
        g.foliage.tri(t0, e, [m[0] - px, m[1], m[2] - pz], Z3, Z3, Z3, leaf, out);
      }
    }
    addBlob(g.foliage, x, ty - 0.2, z, 0.55 * s, col('#5a4a2a'), 0);
  }
  function lolly(x, z, s = 1) {
    const y0 = post(x, z, 0.28 * s, 6 * s, 'tree');
    addCyl(g.props, x, y0, z, 0.2 * s, 3 * s, col('#6b5a48'), 7);
    addBlob(g.foliage, x, y0 + 4 * s, z, 1.8 * s, col(pickR(['#4f9a6e', '#6fae5a', '#3f8a7a', '#d0a63c', '#8fb050'])), quality.low ? 0 : 1);
  }

  /** A billboard on two legs: three colour bands and a neon frame, facing yaw. */
  function billboard(x, z, w, h, y, yaw) {
    const c = Math.cos(yaw), s = -Math.sin(yaw);
    let y0 = 0;
    for (const o of [-w / 3, w / 3]) y0 = Math.max(y0, post(x + c * o, z + s * o, 0.4, y + h, 'pole'));
    for (const o of [-w / 3, w / 3]) addCyl(g.props, x + c * o, y0 - 0.3, z + s * o, 0.4, y + 0.3, CHROME, 8);
    const cols = [col(pickR(PASTEL)), col(pickR(ACCENT)), CREAM];
    for (let k = 0; k < 3; k++) addBox(g.props, x, y0 + y + (h * (k + 0.5)) / 3, z, w, h / 3, 0.5, cols[k], yaw);
    for (const yy of [y0 + y, y0 + y + h]) addBox(g.neon, x, yy, z, w + 0.2, 0.14, 0.56, col('#39f0e3'), yaw);
    starburst(x + Math.sin(yaw) * 0.4, y0 + y + h * 0.66, z + Math.cos(yaw) * 0.4, h * 0.22, col('#fff2c8'), yaw);
  }

  /** A radio mast with neon beads. */
  function mast(x, z, H) {
    const y0 = post(x, z, 1.1, H, 'pole');
    addCyl(g.props, x, y0 - 0.3, z, 1.1, H, col('#d8452f'), 8, 0.15);
    for (let y = 6; y < H; y += 6) addCyl(g.props, x, y0 + y, z, 1.2 - (y / H) * 1.05, 0.6, WHITE, 8);
    addBlob(g.neon, x, y0 + H + 0.3, z, 0.5, col('#ff3b3b'), 1);
  }

  // the blocks: what stands on each lot (i — west to east, j — north to south)
  const TREES = [];
  const tree = (x, z, s) => {
    TREES.push([x, z]);
    if (rng() < 0.5) palm(x, z, s);
    else lolly(x, z, s);
  };
  const lotTrees = (lot, n, avoid) => {
    for (let k = 0, tries = 0; k < n && tries < 80; tries++) {
      const x = R(lot.x0 + 2.5, lot.x1 - 2.5), z = R(lot.z0 + 2.5, lot.z1 - 2.5);
      if (avoid.some(([ax0, az0, ax1, az1]) => x > ax0 - 3 && x < ax1 + 3 && z > az0 - 3 && z < az1 + 3)) continue;
      if (TREES.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < 5)) continue;
      tree(x, z, R(0.85, 1.15));
      k++;
    }
  };
  const P = (hex) => col(hex);
  const LOTS = {
    '0,0': (l) => (dome(-102, -112, 13, P('#a8c8f0')), lotTrees(l, 6, [[-116, -126, -88, -98]])),
    '1,0': (l) => (slab(-52, -130, -38, -90, 9, P('#f7a59a')), lotTrees(l, 5, [[-53, -131, -37, -89]])),
    '2,0': (l) => (needle(30, -126, 44), diner(40, -103, 55, -92, P('#f6d27a'), [16, -88, Math.PI / 2]), lotTrees(l, 4, [[23, -133, 37, -119], [38, -105, 57, -90]])),
    '3,0': (l) => (slab(90, -132, 124, -118, 12, P('#f2efe6'), 'screen'), stack(106, -96, 4), lotTrees(l, 3, [[89, -133, 125, -117], [99, -103, 113, -89]])),
    '0,1': (l) => (stack(-102, -35, 5, P('#f6d27a')), lotTrees(l, 5, [[-109, -42, -95, -28]])),
    '1,1': () => needle(-44, -44, 34),
    '2,1': () => slab(24, -56, 54, -46, 7, P('#7fd1c7')),
    '3,1': (l) => (diner(95, -40, 118, -28, P('#ffc9a0'), [88, -18, 0]), lotTrees(l, 3, [[86, -62, 133, -26]])),
    '0,2': (l) => (slab(-118, 16, -104, 54, 8, P('#c9b6e8'), 'screen'), lotTrees(l, 6, [[-119, 15, -103, 55]])),
    '1,2': () => dome(-44, 44, 9, P('#9fdcb0')),
    '2,2': () => stack(44, 44, 4),
    '3,2': (l) => (slab(86, 16, 100, 54, 10, P('#a8c8f0')), slab(110, 20, 127, 38, 6, P('#f7a59a'), 'screen'), lotTrees(l, 2, [[85, 15, 128, 55]])),
    '0,3': (l) => (atom(-102, 108, 7, 3.4), lotTrees(l, 9, [[-106, 104, -98, 112]])),
    '1,3': (l) => (rocket(-35, 108), lotTrees(l, 5, [[-41, 102, -29, 114]])),
    '2,3': (l) => (slab(16, 114, 54, 128, 2, P('#f6d27a'), 'screen'), sign(20, 97, Math.PI / 2), lotTrees(l, 4, [[15, 113, 55, 129], [18, 95, 22, 99]])),
    '3,3': (l) => (needle(106, 108, 38), lotTrees(l, 4, [[99, 101, 113, 115]])),
  };
  for (const bl of blocks) LOTS[`${bl.i},${bl.j}`](bl.lot);

  // the outer strips
  diner(-40, 174, -14, 186, P('#7fd1c7'), [-27, 167.5, 0]);
  slab(10, 176, 70, 188, 2, P('#f7a59a'), 'screen');
  sign(4, 168, 0);
  for (let x = -180; x <= 150; x += 22) if (x < -48 || (x > -6 && x < 4) || x > 76) palm(x, 167.5, R(0.9, 1.15));
  for (let z = -130; z <= 130; z += 20) if (Math.abs(Math.abs(z) - 92) > 8) palm(-192, z, R(0.9, 1.1));
  billboard(-192, 92, 14, 6, 5, Math.PI / 2);
  billboard(-192, -92, 14, 6, 5, Math.PI / 2);
  billboard(186, 0, 30, 12, 5, -Math.PI / 2); // the drive-in's screen on the east side
  slab(172, 92, 190, 130, 9, P('#c9b6e8'));
  dome(180, -110, 9);
  for (let z = -60; z <= 60; z += 30) lolly(171, z + 15, 1);
  // the north: the observatory on the hilltop, radio masts, a slab and a dome by the corners
  dome(0, -171, 9, P('#f2efe6'));
  mast(-64, -176, 30);
  mast(64, -176, 30);
  slab(-150, -190, -120, -174, 8, P('#a8c8f0'));
  dome(130, -178, 10, P('#f6d27a'));
  for (const x of [-96, -40, 40, 96]) lolly(x, -165, 1.1);
  // the sunken plaza's monument: a Sputnik on a column inside atom rings, on an island in the roundabout
  {
    const B = A.bowl, by = terrainAt(0, 0);
    addCyl(g.props, 0, by - 0.3, 0, B.island, 1.5, CREAM, 36);
    addCyl(g.foliage, 0, by + 1.2, 0, B.island - 0.4, 0.15, col('#7fae5a'), 36);
    addCyl(g.neon, 0, by + 0.9, 0, B.island + 0.05, 0.22, col('#ff4fae'), 36);
    addCyl(g.props, 0, by + 1.2, 0, 0.7, 8, CHROME, 12, 0.35);
    const sy = by + 10.5;
    addBlob(g.props, 0, sy, 0, 2.4, CHROME, 2);
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) rod(g.props, dx * 1.2, sy - 0.4, dz * 1.2, dx * 5.5, sy - 6, dz * 5.5, 0.07, CHROME, 5);
    for (let k = 0; k < 3; k++) {
      _q.setFromEuler(new THREE.Euler(Math.PI / 2 + (k - 1) * 0.95, (k * Math.PI) / 3, 0));
      _m.compose(_p.set(0, sy, 0), _q, _s.set(1, 1, 1));
      g.neon.addGeometry(new THREE.TorusGeometry(4.2, 0.12, 6, 40), _m, col(NEON[k]));
    }
    world.addCircle(0, 0, B.island, { kind: 'statue', h: 14 });
    solidCyl(0, by - 0.5, 0, by + 1.2, B.island, 'statue');
    solidCyl(0, by + 1.2, 0, sy + 2.4, 2.4, 'statue');
  }
  // the welcome arch over the boulevard: «АТОМГРАД» between two pylons
  {
    const ax = -132, za = 137, zb = 163;
    for (const z of [za, zb]) {
      post(ax, z, 0.8, 11, 'pole');
      addCyl(g.props, ax, -0.3, z, 0.8, 11.3, CREAM, 12, 0.55);
      addCyl(g.neon, ax, 3, z, 0.82, 0.25, col('#ff4fae'), 12);
    }
    addBox(g.props, ax, 9.6, (za + zb) / 2, 1.2, 3.4, zb - za + 1, col('#1d4f7a'));
    arch(g.neon, ax, za, 11, ax, zb, 11, 14.5, 0.25, 0.25, col('#ffb03a'), 16);
    const tex = bannerTexture();
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(zb - za - 2, 3), mat);
      m.position.set(ax + s * 0.62, 9.6, (za + zb) / 2);
      m.rotation.y = (s * Math.PI) / 2;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      scene.add(m);
    }
  }

  // ---------------------------------------------------------------- the fence, the monorail, the skyline
  {
    const WALL_H = 4.5, WT = 1.2, span = 2 * outer + 2 * WT;
    addBox(g.props, 0, WALL_H / 2, -outer - WT / 2, span, WALL_H, WT, CREAM);
    addBox(g.props, 0, WALL_H / 2, outer + WT / 2, span, WALL_H, WT, CREAM);
    addBox(g.props, -outer - WT / 2, WALL_H / 2, 0, WT, WALL_H, span, CREAM);
    addBox(g.props, outer + WT / 2, WALL_H / 2, 0, WT, WALL_H, span, CREAM);
    for (const [x, z, sx, sz] of [[0, -outer + 0.02, span, 0.1], [0, outer - 0.02, span, 0.1], [-outer + 0.02, 0, 0.1, span], [outer - 0.02, 0, 0.1, span]]) {
      addBox(g.props, x, 0.6, z, sx, 1.2, sz, TEAL);
      addBox(g.neon, x, 3.9, z, sx, 0.15, sz, col('#ffb03a'));
    }
    world.addAABB(-outer - WT, -outer - WT, outer + WT, -outer, { kind: 'wall', h: WALL_H });
    world.addAABB(-outer - WT, outer, outer + WT, outer + WT, { kind: 'wall', h: WALL_H });
    world.addAABB(-outer - WT, -outer, -outer, outer, { kind: 'wall', h: WALL_H });
    world.addAABB(outer, -outer, outer + WT, outer, { kind: 'wall', h: WALL_H });
    solidBox(-outer - WT, -1, -outer - WT, outer + WT, WALL_H, -outer, 'wall');
    solidBox(-outer - WT, -1, outer, outer + WT, WALL_H, outer + WT, 'wall');
    solidBox(-outer - WT, -1, -outer, -outer, WALL_H, outer, 'wall');
    solidBox(outer, -1, -outer, outer + WT, WALL_H, outer, 'wall');
    for (let p = -outer + 8; p < outer; p += 16) {
      const o = outer + WT + 0.3;
      for (const [x, z] of [[p, -o], [p, o], [-o, p], [o, p]]) {
        addCyl(g.props, x, 0, z, 0.55, WALL_H + 0.5, TEAL, 10);
        addBlob(g.neon, x, WALL_H + 0.8, z, 0.35, col('#fff2c8'), 0);
      }
    }
    // the monorail round the city, on T-pylons, with a train on the south side
    const D = outer + 26, MY = 15;
    for (const [ax, az, bx, bz] of [[-D, -D, D, -D], [D, -D, D, D], [D, D, -D, D], [-D, D, -D, -D]]) {
      bar(g.props, ax, MY, az, bx, MY, bz, 1.6, 1.2, CREAM);
      bar(g.neon, ax, MY - 0.12, az, bx, MY - 0.12, bz, 1.64, 0.1, col('#39f0e3'));
      const l = Math.hypot(bx - ax, bz - az);
      for (let s = 0; s < l; s += 30) {
        const x = ax + ((bx - ax) * s) / l, z = az + ((bz - az) * s) / l;
        addCyl(g.props, x, 0, z, 0.9, MY, CHROME, 10, 0.7);
        addBox(g.props, x, MY - 0.3, z, 3, 0.6, 3, TEAL);
      }
    }
    for (let k = 0; k < 3; k++) {
      const x0 = -40 + k * 16.5, y = MY + 2.6;
      rod(g.props, x0, y, D, x0 + 15, y, D, 1.7, CREAM, 14);
      rod(g.props, x0, y - 0.5, D, x0 + 15, y - 0.5, D, 1.74, RED, 14);
      rod(g.neon, x0 + 1, y + 0.6, D, x0 + 14, y + 0.6, D, 1.72, col('#fff2c8'), 14);
      if (k === 2) {
        _q.setFromUnitVectors(_y, _d.set(1, 0, 0));
        _m.compose(_p.set(x0 + 18, y, D), _q, _s.set(1, 6, 1));
        g.props.addGeometry(new THREE.CylinderGeometry(0.1, 1.7, 1, 14), _m, CREAM);
      }
    }
    // the skyline: saucer towers, domes and slabs far beyond the fence
    const skyCols = ['#9fb3c8', '#b7aec8', '#c9b7a8', '#a8bdb6', '#bfc6cf'];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2 + R(-0.03, 0.03);
      const d = R(outer + 70, outer + 170) / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      const x = Math.cos(a) * d, z = Math.sin(a) * d, c = col(pickR(skyCols)), t = rng();
      if (t < 0.25) {
        const H = R(40, 80);
        addCyl(g.props, x, 0, z, 2.5, H, c, 10, 1.6);
        addCyl(g.props, x, H, z, 9, 1.5, c, 18, 4);
        addCyl(g.props, x, H - 2, z, 2, 2, c, 18, 9);
      } else if (t < 0.45) {
        const r = R(14, 26);
        addBlob(g.props, x, 0, z, r, c, 1, 0.75);
      } else {
        const h = R(14, 60);
        addBox(g.props, x, h / 2, z, R(14, 30), h, R(12, 24), c, R(0, Math.PI));
      }
    }
  }

  // ---------------------------------------------------------------- pedestrians: block corners, crossings
  const nodeId = (i, j, k) => (j * 4 + i) * 4 + k;
  for (const bl of blocks) {
    const ins = 2;
    for (const [x, z] of [[bl.x0 + ins, bl.z0 + ins], [bl.x1 - ins, bl.z0 + ins], [bl.x1 - ins, bl.z1 - ins], [bl.x0 + ins, bl.z1 - ins]]) nodes.push({ x, z, links: [] });
  }
  const link = (a, b) => {
    nodes[a].links.push(b);
    nodes[b].links.push(a);
  };
  const ZEBRA = col('#f6f2e8');
  const zebraX = (xc, zc) => {
    for (let x = xc - HW + 0.6; x < xc + HW - 0.6; x += 1.1) markRect(x, zc - 1.5, x + 0.55, zc + 1.5, ZEBRA);
  };
  const zebraZ = (xc, zc) => {
    for (let z = zc - HW + 0.6; z < zc + HW - 0.6; z += 1.1) markRect(xc - 1.5, z, xc + 1.5, z + 0.55, ZEBRA);
  };
  for (const bl of blocks) {
    const { i, j } = bl;
    for (let k = 0; k < 4; k++) link(nodeId(i, j, k), nodeId(i, j, (k + 1) % 4));
    if (i + 1 < 4) {
      link(nodeId(i, j, 1), nodeId(i + 1, j, 0));
      link(nodeId(i, j, 2), nodeId(i + 1, j, 3));
      zebraX(ST[i], nodes[nodeId(i, j, 1)].z);
      zebraX(ST[i], nodes[nodeId(i, j, 2)].z);
    }
    if (j + 1 < 4) {
      link(nodeId(i, j, 3), nodeId(i, j + 1, 0));
      link(nodeId(i, j, 2), nodeId(i, j + 1, 1));
      zebraZ(nodes[nodeId(i, j, 3)].x, ST[j]);
      zebraZ(nodes[nodeId(i, j, 2)].x, ST[j]);
    }
  }
  // street props along the sidewalks
  for (const bl of blocks) {
    const { x0, z0, x1, z1 } = bl;
    const sides = [
      { ax: x0, az: z0, dx: 1, dz: 0, ox: 0, oz: -1, len: x1 - x0 },
      { ax: x1, az: z0, dx: 0, dz: 1, ox: 1, oz: 0, len: z1 - z0 },
      { ax: x1, az: z1, dx: -1, dz: 0, ox: 0, oz: 1, len: x1 - x0 },
      { ax: x0, az: z1, dx: 0, dz: -1, ox: -1, oz: 0, len: z1 - z0 },
    ];
    for (const sd of sides) {
      const at = (s, inset) => [sd.ax + sd.dx * s - sd.ox * inset, sd.az + sd.dz * s - sd.oz * inset];
      const yaw = Math.atan2(sd.ox, sd.oz);
      const n = Math.max(1, Math.round((sd.len - 14) / 17));
      for (let k = 0; k <= n; k++) {
        const [x, z] = at(7 + ((sd.len - 14) * k) / n, 0.7);
        props.push({ type: 'lamp', x, z, yaw });
      }
      if (rng() < 0.7) {
        const [x, z] = at(R(11, sd.len - 11), 0.7);
        props.push({ type: pickR(['bin', 'hydrant', 'bench', 'bin']), x, z, yaw });
      }
    }
    [[x0, z0, -1, -1], [x1, z0, 1, -1], [x1, z1, 1, 1], [x0, z1, -1, 1]].forEach(([cx, cz, sx, sz], k) => {
      props.push({ type: (bl.i + bl.j + k) % 2 === 0 ? 'traffic' : 'sign', x: cx - sx * 0.9, z: cz - sz * 0.9, yaw: Math.atan2(sx, sz) });
    });
  }
  for (let x = -176; x < 130; x += 19) if (x < -50 || x > 80) props.push({ type: x % 2 ? 'lamp' : 'bench', x, z: 162, yaw: Math.PI });
  // none on the roundabout in the bowl (the blocks' inner corners)
  for (let i = props.length - 1; i >= 0; i--) if (Math.hypot(props[i].x, props[i].z) < A.bowl.r + 1.5) props.splice(i, 1);

  // ---------------------------------------------------------------- meshes
  const grass = lawnTexture(), asphalt = roadTexture();
  const lay = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 };
  const mats = {
    terrain: new THREE.MeshLambertMaterial({ map: grass, vertexColors: true }),
    lawn: new THREE.MeshLambertMaterial({ map: grass, vertexColors: true, ...lay }),
    asphalt: new THREE.MeshLambertMaterial({ map: asphalt, vertexColors: true, ...lay }),
    walk: new THREE.MeshLambertMaterial({ map: TX.tilesTexture(), vertexColors: true, ...lay }),
    ribbon: new THREE.MeshLambertMaterial({ map: ribbonTexture(), vertexColors: true }),
    screen: new THREE.MeshLambertMaterial({ map: screenTexture(), vertexColors: true }),
    roof: new THREE.MeshLambertMaterial({ map: TX.roofTexture(), vertexColors: true }),
    props: new THREE.MeshLambertMaterial({ vertexColors: true }),
    foliage: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    marks: new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    neon: new THREE.MeshBasicMaterial({ vertexColors: true }),
  };
  const casters = new Set(['ribbon', 'screen', 'roof', 'props', 'foliage']);
  for (const [key, b] of Object.entries(g)) {
    if (b.empty) continue;
    const mesh = new THREE.Mesh(b.build(), mats[key]);
    mesh.castShadow = quality.shadows && casters.has(key);
    mesh.receiveShadow = quality.shadows;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = `atom-${key}`;
    if (key === 'foliage') mesh.layers.enable(XRAY.mask);
    scene.add(mesh);
  }

  // the bots' nav grid bounds: inside the fence, from the canal's bed to the tallest collider
  let y0 = Infinity, y1 = -Infinity;
  for (const s of solids) {
    if (s.box) (y0 = Math.min(y0, s.box[1] - s.box[4])), (y1 = Math.max(y1, s.box[1] + s.box[4]));
    else if (s.cyl) (y0 = Math.min(y0, s.cyl[1] - s.cyl[3])), (y1 = Math.max(y1, s.cyl[1] + s.cyl[3]));
    else if (s.hull) for (let k = 1; k < s.hull.length; k += 3) (y0 = Math.min(y0, s.hull[k])), (y1 = Math.max(y1, s.hull[k]));
  }
  for (const h of hgt) (y0 = Math.min(y0, h)), (y1 = Math.max(y1, h));
  const bounds = { x0: -outer, z0: -outer, x1: outer, z1: outer, y0, y1 };

  // ---------------------------------------------------------------- the race
  const spawn = { x: -100, z: 150, yaw: Math.PI / 2 };
  const hillTop = terrainAt(A.hill.x, A.hill.z);
  const course = {
    route: [[-150, 150], [150, 150], [150, -150], [-150, -150]],
    gates: [
      { x: 110, z: 150, y: 0, w: 11 }, // the boulevard, after the stunt ramps
      { x: 150, z: 40, y: SK.h, w: 5.4 }, // on the skyway, before the gap: the way on is over it
      { x: 0, z: -150, y: hillTop }, // on the hilltop
      { x: K.x, z: -35, y: -K.depth, w: 8.6 }, // in the canal, between the bridges
      { x: K.x, z: 35, y: -K.depth, w: 8.6 },
      { x: spawn.x + 16, z: 150, y: 0, w: 11 }, // start / finish
    ],
  };

  // ---------------------------------------------------------------- the minimap
  const MM = 512, ext = outer + 2, k = MM / (2 * ext);
  const mm = document.createElement('canvas');
  mm.width = mm.height = MM;
  const c2 = mm.getContext('2d');
  const toMap = (v) => (v + ext) * k;
  {
    const img = c2.createImageData(MM, MM);
    const FILL = {
      [M.road]: [69, 67, 82],
      [M.walk]: [196, 186, 168],
      [M.plaza]: [214, 172, 152],
      [M.lawn]: [116, 152, 86],
      [M.concrete]: [190, 180, 162],
      [M.lot]: [120, 116, 132],
    };
    for (let py = 0; py < MM; py++) {
      for (let px = 0; px < MM; px++) {
        const x = (px + 0.5) / k - ext, z = (py + 0.5) / k - ext, o = (py * MM + px) * 4;
        let c;
        if (Math.abs(x) > outer || Math.abs(z) > outer) c = [110, 104, 120];
        else {
          const h = terrainAt(x, z), f = FILL[maskAt(x, z)] || [118, 150, 92];
          const s = 1 + h * 0.035;
          c = [f[0] * s, f[1] * s, f[2] * s];
        }
        img.data[o] = c[0];
        img.data[o + 1] = c[1];
        img.data[o + 2] = c[2];
        img.data[o + 3] = 255;
      }
    }
    c2.putImageData(img, 0, 0);
    const rect = (x0, z0, x1, z1, fill) => {
      c2.fillStyle = fill;
      c2.fillRect(toMap(x0), toMap(z0), (x1 - x0) * k, (z1 - z0) * k);
    };
    for (const s of surfaces) rect(s.x0, s.z0, s.x1, s.z1, s.x0 > 100 ? '#e8a35a' : s.x1 - s.x0 > 40 ? '#45434f' : '#f2c230');
    for (const b of buildings) {
      const v = Math.round(clamp(160 + b.h * 1.6, 160, 240));
      c2.fillStyle = `rgb(${v},${v - 8},${v - 20})`;
      if (b.r != null) {
        c2.beginPath();
        c2.arc(toMap(b.x), toMap(b.z), b.r * k, 0, Math.PI * 2);
        c2.fill();
      } else c2.fillRect(toMap(b.x0), toMap(b.z0), (b.x1 - b.x0) * k, (b.z1 - b.z0) * k);
    }
  }

  // ---------------------------------------------------------------- queries
  /** Height of the ground at (x, z): the highest surface not above `below` (under the skyway: the street or the deck). */
  function groundHeight(x, z, below = Infinity) {
    const t = terrainAt(x, z);
    let best = t <= below ? t : -Infinity;
    for (const s of surfaces) {
      if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      const h = s.at(x, z);
      if (h <= below && h > best) best = h;
    }
    return best > -Infinity ? best : t;
  }

  return {
    map: 'retro',
    world,
    nodes,
    blocks,
    buildings,
    props,
    outer,
    groundHeight,
    /** The bare terrain's height at (x, z) (the camera keeps above it). */
    terrainAt,
    test: false,
    pedLayout: null,
    solids,
    bounds,
    course,
    pads: [],
    padAt: () => null,
    spawn,
    minimap: { canvas: mm, ext, k },
  };
}
