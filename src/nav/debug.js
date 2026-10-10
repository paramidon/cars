/**
 * `?debug=nav`: the nav grid drawn over the map — a small square on every floor, coloured by its kind and layer;
 * unwalkable floors (a solid within NAV.inflate, an edge) dark red, walkable ones cut off from the main area purple.
 */
import * as THREE from 'three';

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
