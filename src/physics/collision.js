/**
 * Простой 2D (плоскость XZ) мир коллизий: AABB (здания, стены) и круги (столбы, деревья, мелочь).
 * Пространственная сетка для быстрых запросов и DDA-рейкаст для пуль/камеры.
 */
const AABB = 0;
const CIRCLE = 1;

export class CollisionWorld {
  constructor(cellSize = 16) {
    this.cs = cellSize;
    this.cells = new Map();
    this.all = [];
    this._stamp = 1;
    this._out = [];
    this._hit = { t: 0, nx: 0, nz: 0, collider: null };
  }

  _key(ix, iz) {
    return (ix + 512) * 1024 + (iz + 512);
  }

  _insert(c) {
    const cs = this.cs;
    const ix0 = Math.floor(c.minX / cs), ix1 = Math.floor(c.maxX / cs);
    const iz0 = Math.floor(c.minZ / cs), iz1 = Math.floor(c.maxZ / cs);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const k = this._key(ix, iz);
        let arr = this.cells.get(k);
        if (!arr) this.cells.set(k, (arr = []));
        arr.push(c);
      }
    }
    this.all.push(c);
    return c;
  }

  addAABB(minX, minZ, maxX, maxZ, data = {}) {
    return this._insert({ type: AABB, minX, minZ, maxX, maxZ, active: true, solid: true, h: 10, _s: 0, ...data });
  }

  addCircle(x, z, r, data = {}) {
    return this._insert({ type: CIRCLE, x, z, r, minX: x - r, minZ: z - r, maxX: x + r, maxZ: z + r, active: true, solid: true, h: 10, _s: 0, ...data });
  }

  /** Все активные коллайдеры, чьи границы пересекают прямоугольник. Возвращает переиспользуемый массив. */
  query(minX, minZ, maxX, maxZ) {
    const out = this._out;
    out.length = 0;
    const stamp = ++this._stamp;
    const cs = this.cs;
    const ix0 = Math.floor(minX / cs), ix1 = Math.floor(maxX / cs);
    const iz0 = Math.floor(minZ / cs), iz1 = Math.floor(maxZ / cs);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const arr = this.cells.get(this._key(ix, iz));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const c = arr[i];
          if (c._s === stamp) continue;
          c._s = stamp;
          if (!c.active) continue;
          if (c.maxX < minX || c.minX > maxX || c.maxZ < minZ || c.minZ > maxZ) continue;
          out.push(c);
        }
      }
    }
    return out;
  }

  queryCircle(x, z, r) {
    return this.query(x - r, z - r, x + r, z + r);
  }

  /**
   * Луч из (ox,oz) по нормированному направлению (dx,dz).
   * filter(c) → true, если коллайдер учитывать. Возвращает переиспользуемый объект или null.
   */
  raycast(ox, oz, dx, dz, maxT, filter) {
    const cs = this.cs;
    let ix = Math.floor(ox / cs), iz = Math.floor(oz / cs);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const adx = Math.abs(dx), adz = Math.abs(dz);
    const tDeltaX = adx > 1e-9 ? cs / adx : Infinity;
    const tDeltaZ = adz > 1e-9 ? cs / adz : Infinity;
    let tMaxX = adx > 1e-9 ? (dx > 0 ? (ix + 1) * cs - ox : ox - ix * cs) / adx : Infinity;
    let tMaxZ = adz > 1e-9 ? (dz > 0 ? (iz + 1) * cs - oz : oz - iz * cs) / adz : Infinity;
    const stamp = ++this._stamp;
    let bestT = maxT, best = null, bnx = 0, bnz = 0;
    let t = 0;
    for (let guard = 0; guard < 256; guard++) {
      const arr = this.cells.get(this._key(ix, iz));
      if (arr) {
        for (let i = 0; i < arr.length; i++) {
          const c = arr[i];
          if (c._s === stamp) continue;
          c._s = stamp;
          if (!c.active || (filter && !filter(c))) continue;
          if (c.type === CIRCLE) {
            const r = rayCircle(ox, oz, dx, dz, c.x, c.z, c.r);
            if (r >= 0 && r < bestT) {
              bestT = r;
              best = c;
              const hx = ox + dx * r - c.x, hz = oz + dz * r - c.z;
              const l = Math.hypot(hx, hz) || 1;
              bnx = hx / l;
              bnz = hz / l;
            }
          } else {
            const r = rayAABB(ox, oz, dx, dz, c, RAY_N);
            if (r >= 0 && r < bestT) {
              bestT = r;
              best = c;
              bnx = RAY_N.nx;
              bnz = RAY_N.nz;
            }
          }
        }
      }
      if (tMaxX < tMaxZ) {
        t = tMaxX;
        tMaxX += tDeltaX;
        ix += stepX;
      } else {
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        iz += stepZ;
      }
      if (t > bestT) break;
    }
    if (!best) return null;
    const h = this._hit;
    h.t = bestT;
    h.nx = bnx;
    h.nz = bnz;
    h.collider = best;
    return h;
  }
}

const RAY_N = { nx: 0, nz: 0 };

export function rayCircle(ox, oz, dx, dz, cx, cz, r) {
  const fx = ox - cx, fz = oz - cz;
  const b = fx * dx + fz * dz;
  const c = fx * fx + fz * fz - r * r;
  if (c < 0) return 0; // начало внутри
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : -1;
}

function rayAABB(ox, oz, dx, dz, c, n) {
  let tmin = 0, tmax = Infinity;
  n.nx = 0;
  n.nz = 0;
  if (Math.abs(dx) < 1e-9) {
    if (ox < c.minX || ox > c.maxX) return -1;
  } else {
    const inv = 1 / dx;
    let t1 = (c.minX - ox) * inv, t2 = (c.maxX - ox) * inv;
    let nx = -1;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
      nx = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      n.nx = nx;
      n.nz = 0;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (Math.abs(dz) < 1e-9) {
    if (oz < c.minZ || oz > c.maxZ) return -1;
  } else {
    const inv = 1 / dz;
    let t1 = (c.minZ - oz) * inv, t2 = (c.maxZ - oz) * inv;
    let nz = -1;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
      nz = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      n.nx = 0;
      n.nz = nz;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/**
 * Пересечение круга с коллайдером. Заполняет out: нормаль (от препятствия к кругу),
 * глубину проникновения и точку контакта на поверхности препятствия.
 */
function circleVsCollider(x, z, r, c, out) {
  if (c.type === CIRCLE) {
    const dx = x - c.x, dz = z - c.z;
    const rr = r + c.r;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr) return false;
    const d = Math.sqrt(d2);
    if (d < 1e-6) {
      out.nx = 1;
      out.nz = 0;
      out.depth = rr;
    } else {
      out.nx = dx / d;
      out.nz = dz / d;
      out.depth = rr - d;
    }
    out.px = c.x + out.nx * c.r;
    out.pz = c.z + out.nz * c.r;
    return true;
  }
  const qx = x < c.minX ? c.minX : x > c.maxX ? c.maxX : x;
  const qz = z < c.minZ ? c.minZ : z > c.maxZ ? c.maxZ : z;
  const dx = x - qx, dz = z - qz;
  const d2 = dx * dx + dz * dz;
  if (d2 > 1e-12) {
    if (d2 >= r * r) return false;
    const d = Math.sqrt(d2);
    out.nx = dx / d;
    out.nz = dz / d;
    out.depth = r - d;
    out.px = qx;
    out.pz = qz;
    return true;
  }
  // центр внутри прямоугольника — выталкиваем по кратчайшей оси
  const dl = x - c.minX, dr = c.maxX - x, db = z - c.minZ, dt = c.maxZ - z;
  const m = Math.min(dl, dr, db, dt);
  if (m === dl) {
    out.nx = -1; out.nz = 0; out.depth = r + dl; out.px = c.minX; out.pz = z;
  } else if (m === dr) {
    out.nx = 1; out.nz = 0; out.depth = r + dr; out.px = c.maxX; out.pz = z;
  } else if (m === db) {
    out.nx = 0; out.nz = -1; out.depth = r + db; out.px = x; out.pz = c.minZ;
  } else {
    out.nx = 0; out.nz = 1; out.depth = r + dt; out.px = x; out.pz = c.maxZ;
  }
  return true;
}

/** Вытолкнуть круг из всех твёрдых коллайдеров. Возвращает суммарный сдвиг или null. */
const _pen = { nx: 0, nz: 0, depth: 0, px: 0, pz: 0 };
const _push = { x: 0, z: 0, nx: 0, nz: 0, hit: false };
export function pushOutCircle(world, x, z, r, solidOnly = true) {
  _push.x = x;
  _push.z = z;
  _push.hit = false;
  const list = world.queryCircle(x, z, r);
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (solidOnly && (!c.solid || c.kind === 'breakable')) continue;
    if (circleVsCollider(_push.x, _push.z, r, c, _pen)) {
      _push.x += _pen.nx * _pen.depth;
      _push.z += _pen.nz * _pen.depth;
      _push.nx = _pen.nx;
      _push.nz = _pen.nz;
      _push.hit = true;
    }
  }
  return _push;
}
