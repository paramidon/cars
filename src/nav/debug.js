/**
 * `?debug=nav`: the nav grid drawn over the map — a small square on every floor, coloured by its kind and layer;
 * unwalkable floors (a solid within NAV.inflate, an edge) dark red, walkable ones cut off from the main area purple;
 * the jumps; and the bots' paths.
 */
import * as THREE from 'three';
import { PHYS } from '../physics/rapier.js';

const KIND = { ground: '#3fa34d', curb: '#3f7fd1', ramp: '#e0a020', deck: '#d0d0d0' };
const OTHER = '#9a7a5a', BLOCKED = '#6a1010', ISLAND = '#a040c0';
// upper layers are lighter, so a deck over a street or a street over a tunnel stands out
const LAYER = [0, 0.35, 0.6];

export function navMesh(nav) {
  const n = nav.y.length, h = nav.cell * 0.42;
  const pos = new Float32Array(n * 12), colr = new Float32Array(n * 12), idx = new Uint32Array(n * 6);
  const c = new THREE.Color(), white = new THREE.Color('#ffffff');
  for (let i = 0; i < n; i++) {
    const p = nav.pos(i), y = p.y + 0.06, s = nav.walkable(i) ? h : h * 0.5;
    const pts = [p.x - s, y, p.z - s, p.x + s, y, p.z - s, p.x + s, y, p.z + s, p.x - s, y, p.z + s];
    pos.set(pts, i * 12);
    if (!nav.walkable(i)) c.set(BLOCKED);
    else if (!nav.reachable(i)) c.set(ISLAND);
    else {
      c.set(KIND[nav.kindOf(i)] ?? OTHER);
      c.lerp(white, LAYER[Math.min(nav.layer(i), LAYER.length - 1)]);
    }
    for (let k = 0; k < 4; k++) colr.set([c.r, c.g, c.b], i * 12 + k * 3);
    idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4, i * 4 + 3, i * 4 + 2], i * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colr, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'nav-debug';
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;
  return mesh;
}

const JUMP_COLOR = { jump: '#ff8a00', drop: '#20d0ff', launch: '#ff2030' };

/**
 * `?debug=nav`: the grid's jumps — the run-up (from the take-off floor to the lip) white, the flights at the slowest
 * and the fastest speed that land well coloured by kind (off a ramp orange, off an edge cyan, a catapult red), then the
 * run-out to where the path goes on.
 */
export function jumpLines(nav) {
  const pts = [], cols = [];
  const c = new THREE.Color(), white = new THREE.Color('#ffffff');
  const seg = (a, b, col) => {
    pts.push(a.x, a.y + 0.3, a.z, b.x, b.y + 0.3, b.z);
    cols.push(col.r, col.g, col.b, col.r, col.g, col.b);
  };
  for (const J of nav.jumps) {
    seg(nav.pos(J.from), J.lip, white);
    c.set(JUMP_COLOR[J.kind]);
    for (const v of [J.lo, J.hi]) {
      // the flight's arc off the lip (the box's own start offset left out)
      const cs = 1 / Math.sqrt(1 + J.grade * J.grade), vh = v * cs, vy = J.kind === 'launch' ? 18 : v * J.grade * cs;
      const L = J.land[Math.round((v - J.lo) / J.step)], T = L / vh;
      let p = J.lip;
      for (let k = 1; k <= 12; k++) {
        const t = (k / 12) * T, q = { x: J.lip.x + J.dx * vh * t, y: J.lip.y + vy * t - 0.5 * PHYS.gravity * t * t, z: J.lip.z + J.dz * vh * t };
        seg(p, q, c);
        p = q;
      }
      if (v === J.hi) seg(p, nav.pos(J.to), white);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cols), 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, fog: false }));
  lines.name = 'nav-jumps';
  lines.renderOrder = 6;
  lines.frustumCulled = false;
  return lines;
}

/** `?debug=nav`: every bot's current path, a magenta line; update(bots) once a frame. */
export function pathLines(max = 4096) {
  const pos = new Float32Array(max * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({ color: '#ff40ff', depthTest: false, transparent: true, fog: false });
  const lines = new THREE.LineSegments(geo, mat);
  lines.name = 'nav-paths';
  lines.renderOrder = 6;
  lines.frustumCulled = false;
  lines.update = (bots) => {
    let k = 0;
    for (const b of bots) {
      const P = b.path;
      if (!P) continue;
      for (let i = 0; i + 1 < P.x.length && k < max; i++, k++) pos.set([P.x[i], P.y[i] + 0.4, P.z[i], P.x[i + 1], P.y[i + 1] + 0.4, P.z[i + 1]], k * 6);
    }
    geo.setDrawRange(0, k * 2);
    geo.attributes.position.needsUpdate = true;
  };
  return lines;
}
