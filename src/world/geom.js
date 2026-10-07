import * as THREE from 'three';

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const ZERO_UV4 = [[0, 0], [0, 0], [0, 0], [0, 0]];

function faceNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/**
 * Накопитель треугольников с позициями/нормалями/UV/цветами.
 * Всё статичное в городе сливается в несколько больших мешей — мало draw call'ов.
 */
export class GeoBuilder {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
  }

  get empty() {
    return this.pos.length === 0;
  }

  _vert(p, n, uv, c) {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.uv.push(uv[0], uv[1]);
    this.col.push(c.r, c.g, c.b);
  }

  /** Треугольник; если задан outward, порядок вершин подправляется так, чтобы грань смотрела наружу. */
  tri(a, b, c, uva, uvb, uvc, color, outward) {
    let n = faceNormal(a, b, c);
    if (outward && n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0) {
      [b, c] = [c, b];
      [uvb, uvc] = [uvc, uvb];
      n = [-n[0], -n[1], -n[2]];
    }
    this._vert(a, n, uva, color);
    this._vert(b, n, uvb, color);
    this._vert(c, n, uvc, color);
  }

  quad(a, b, c, d, uvs, color, outward) {
    const U = uvs || ZERO_UV4;
    let flip = false;
    if (outward) {
      const n = faceNormal(a, b, c);
      flip = n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0;
    }
    if (flip) {
      this.tri(a, d, c, U[0], U[3], U[2], color);
      this.tri(a, c, b, U[0], U[2], U[1], color);
    } else {
      this.tri(a, b, c, U[0], U[1], U[2], color);
      this.tri(a, c, d, U[0], U[2], U[3], color);
    }
  }

  /** Горизонтальный прямоугольник, смотрящий вверх, с UV в мировых координатах. */
  flat(x0, z0, x1, z1, y, color, uvScale = 4) {
    this.quad(
      [x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0],
      [[x0 / uvScale, z0 / uvScale], [x0 / uvScale, z1 / uvScale], [x1 / uvScale, z1 / uvScale], [x1 / uvScale, z0 / uvScale]],
      color, [0, 1, 0],
    );
  }

  /** Добавить произвольную BufferGeometry с матрицей и сплошным цветом. */
  addGeometry(geom, matrix, color) {
    const g = geom.index ? geom.toNonIndexed() : geom;
    const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
    _nm.getNormalMatrix(matrix);
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      _n.fromBufferAttribute(n, i).applyMatrix3(_nm).normalize();
      this.pos.push(_v.x, _v.y, _v.z);
      this.nor.push(_n.x, _n.y, _n.z);
      this.uv.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
      this.col.push(color.r, color.g, color.b);
    }
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

const flatten = (g) => (g.index ? g.toNonIndexed() : g);
const unitBox = flatten(new THREE.BoxGeometry(1, 1, 1));
const cylCache = new Map();
const icoCache = new Map();

function cyl(segments) {
  if (!cylCache.has(segments)) cylCache.set(segments, flatten(new THREE.CylinderGeometry(1, 1, 1, segments)));
  return cylCache.get(segments);
}

function ico(detail) {
  if (!icoCache.has(detail)) icoCache.set(detail, flatten(new THREE.IcosahedronGeometry(1, detail)));
  return icoCache.get(detail);
}

/** Коробка: центр (x,y,z), размеры (sx,sy,sz), поворот вокруг Y. */
export function addBox(b, x, y, z, sx, sy, sz, color, rotY = 0) {
  _q.setFromAxisAngle(_up, rotY);
  _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  b.addGeometry(unitBox, _m, color);
}

/** Цилиндр, стоящий на точке (x, y, z) основанием. */
export function addCyl(b, x, y, z, r, h, color, segments = 8, rTop = r) {
  if (rTop !== r) {
    const g = flatten(new THREE.CylinderGeometry(rTop, r, 1, segments));
    _m.compose(_p.set(x, y + h / 2, z), _q.identity(), _s.set(1, h, 1));
    b.addGeometry(g, _m, color);
    return;
  }
  _m.compose(_p.set(x, y + h / 2, z), _q.identity(), _s.set(r, h, r));
  b.addGeometry(cyl(segments), _m, color);
}

/** Цилиндр, ориентированный по произвольной матрице (единичный цилиндр высотой 1, радиус 1). */
export function addCylMatrix(b, matrix, color, segments = 8) {
  b.addGeometry(cyl(segments), matrix, color);
}

export function addBlob(b, x, y, z, r, color, detail = 0, sy = 1) {
  _m.compose(_p.set(x, y, z), _q.setFromEuler(new THREE.Euler(Math.random(), Math.random(), 0)), _s.set(r, r * sy, r));
  b.addGeometry(ico(detail), _m, color);
}
