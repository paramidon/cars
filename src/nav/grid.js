/**
 * The bots' navigation data (NAV_PLAN.md session 2): a layered grid built at load from the map's static colliders in
 * the Rapier world and the map's bounds — nothing map-specific. Columns of NAV.cell m cover the bounds; each column
 * holds every floor a car can stand on, found with two vertical rays through the world (down: each collider's top,
 * up: its bottom), so a tunnel's floor and the street over it are two layers of one column. Neighbouring floors are
 * linked when the step between them can be driven over; a floor is walkable when no solid stands within NAV.inflate
 * of its centre (a cylinder test above the floor) and it isn't at an edge (a drop, a ramp's side).
 */
import { RAPIER, OBSTACLES } from '../physics/rapier.js';

export const NAV = {
  cell: 1.5, // m — a column's size on X and Z
  step: 0.4, // m — the highest step between neighbouring floors a car drives over (curbs are 0.15)
  slope: 32, // ° — a floor's normal at most this far from up (the curbs' bevels are ~27°, ramps ≤ 13°)
  clear: 2, // m of free room above a floor (the car is 1.4 m tall)
  inflate: 1.1, // m — the car's half width and a margin: no solid this close to a walkable floor's centre
  open: 6, // m — "open" floors (spawns, waypoints): no unwalkable floor this close (in the city: streets and squares)
};

// directions to the 8 neighbours: dx, dz (the index into link[] is the direction)
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const F_WALK = 1, F_SOLID = 2, F_EDGE = 4;
const ROOM_MAX = 25.5; // m — room is kept in 0.1 m steps in a byte

export class NavGrid {
  /**
   * phys — Physics (static colliders only are looked at); bounds — { x0, z0, x1, z1, y0, y1 }: the area cars can be in
   * and the height range of the colliders.
   */
  constructor(phys, bounds) {
    const t0 = performance.now();
    this.phys = phys;
    const c = NAV.cell;
    this.cell = c;
    this.x0 = bounds.x0;
    this.z0 = bounds.z0;
    this.nx = Math.ceil((bounds.x1 - bounds.x0) / c);
    this.nz = Math.ceil((bounds.z1 - bounds.z0) / c);
    this.kinds = [];
    this._kindIx = new Map();
    this._shape = new RAPIER.Cylinder(0.5, NAV.inflate);
    this._rot = { x: 0, y: 0, z: 0, w: 1 };
    this._flags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS | RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC;
    const phases = {};
    const phase = (name, f) => {
      const t = performance.now();
      f();
      phases[name] = Math.round(performance.now() - t);
    };
    phase('floors', () => this._floors(bounds));
    phase('links', () => this._link());
    phase('walkable', () => this._walk());
    phase('areas', () => this._components());
    phase('room', () => this._room());
    const kb = [this.start, this.y, this.kind, this.flags, this.link, this.comp, this.room, this.colOf, this.free]
      .reduce((s, a) => s + a.byteLength, 0) / 1024;
    const layers = [];
    for (let col = 0; col < this.nx * this.nz; col++) {
      for (let l = 0; l < this.start[col + 1] - this.start[col]; l++) layers[l] = (layers[l] ?? 0) + 1;
    }
    this.stats = { ms: Math.round(performance.now() - t0), columns: this.nx * this.nz, cells: this.y.length, layers, walkable: this.free.length, kb: Math.round(kb), phases };
  }

  // ------------------------------------------------------------------ building

  /** The floors of every column, bottom to top: y, the collider's kind, the slope (dy/dx, dy/dz) — CSR by column. */
  _floors(b) {
    const w = this.phys.world, c = this.cell, ncol = this.nx * this.nz;
    const top = b.y1 + 1, bot = b.y0 - 1, H = top - bot;
    const down = new RAPIER.Ray({ x: 0, y: top, z: 0 }, { x: 0, y: -1, z: 0 });
    const up = new RAPIER.Ray({ x: 0, y: bot, z: 0 }, { x: 0, y: 1, z: 0 });
    const cosMax = Math.cos((NAV.slope * Math.PI) / 180);
    // a collider's bottom is flat for an upright box or cylinder: its lowest point, no ray needed (a ray call costs
    // ~2 µs, half the build); other shapes (hulls: ramps, curbs, slopes) get an upward ray where it matters
    const flatBot = new Map();
    w.forEachCollider((col) => {
      const T = RAPIER.ShapeType, t = col.shapeType(), r = col.rotation();
      if (col.isSensor() || Math.abs(r.w) < 0.99999) return;
      if (t === T.Cuboid) flatBot.set(col.handle, col.translation().y - col.halfExtents().y);
      else if (t === T.Cylinder) flatBot.set(col.handle, col.translation().y - col.halfHeight());
    });
    const start = new Int32Array(ncol + 1);
    const ys = [], kinds = [], gxs = [], gzs = [];
    const hits = []; // colliders crossing this column: { h, top, bot, nx, ny, nz }
    const pool = [];
    const bots = new Map();
    const found = [];
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const x = this.x0 + (ix + 0.5) * c, z = this.z0 + (iz + 0.5) * c, col = iz * this.nx + ix;
        start[col] = ys.length;
        hits.length = 0;
        down.origin = { x, y: top, z };
        w.intersectionsWithRay(down, H, true, (q) => {
          const e = pool[hits.length] ?? (pool[hits.length] = {});
          const nm = q.normal;
          e.h = q.collider.handle;
          e.top = top - q.timeOfImpact;
          e.bot = flatBot.get(e.h);
          e.nx = nm.x;
          e.ny = nm.y;
          e.nz = nm.z;
          hits.push(e);
          return true;
        }, this._flags);
        if (!hits.length) continue;
        hits.sort((p, q) => q.top - p.top);
        // a collider whose bottom is unknown matters only if something lies NAV.clear or more below its top (a floor
        // it may roof, or merge with); otherwise every floor under it is too low anyway, and its top stands for it
        let need = false;
        for (let k = 0; k < hits.length - 1; k++) if (hits[k].bot === undefined && hits[hits.length - 1].top <= hits[k].top - NAV.clear) need = true;
        if (need) {
          bots.clear();
          up.origin = { x, y: bot, z };
          w.intersectionsWithRay(up, H, true, (q) => {
            bots.set(q.collider.handle, bot + q.timeOfImpact);
            return true;
          }, this._flags);
        }
        for (const e of hits) if (e.bot === undefined) e.bot = need ? bots.get(e.h) ?? -Infinity : e.top;
        // the colliders as intervals, merged where they overlap: a floor is the top of each merged interval, with the
        // room up to the bottom of the one above
        let ceil = Infinity, k = 0;
        found.length = 0;
        while (k < hits.length) {
          const g = hits[k++];
          let lo = g.bot;
          while (k < hits.length && hits[k].top >= lo - 0.01) lo = Math.min(lo, hits[k++].bot);
          const kind = this.phys.kinds.get(g.h);
          if (ceil - g.top >= NAV.clear && g.ny >= cosMax && !OBSTACLES.has(kind)) found.push(g.top, this._kindOf(kind), -g.nx / g.ny, -g.nz / g.ny);
          ceil = lo;
        }
        for (let f = found.length - 4; f >= 0; f -= 4) {
          ys.push(found[f]);
          kinds.push(found[f + 1]);
          gxs.push(found[f + 2]);
          gzs.push(found[f + 3]);
        }
      }
    }
    start[ncol] = ys.length;
    const n = ys.length;
    this.start = start;
    this.y = Float32Array.from(ys);
    this.kind = Uint8Array.from(kinds);
    this._gx = Float32Array.from(gxs);
    this._gz = Float32Array.from(gzs);
    this.colOf = new Int32Array(n);
    for (let col = 0; col < ncol; col++) this.colOf.fill(col, start[col], start[col + 1]);
  }

  _kindOf(name) {
    let k = this._kindIx.get(name);
    if (k == null) {
      k = this.kinds.length;
      this.kinds.push(name);
      this._kindIx.set(name, k);
    }
    return k;
  }

  /** Links to the neighbours' floors a car can drive to: link[i·8 + dir] = the neighbour's layer + 1, 0 — none. */
  _link() {
    const n = this.y.length, c = this.cell;
    this.link = new Uint8Array(n * 8);
    for (let i = 0; i < n; i++) {
      const col = this.colOf[i], ix = col % this.nx, iz = (col - ix) / this.nx;
      for (let d = 0; d < 8; d++) {
        const jx = ix + DIRS[d][0], jz = iz + DIRS[d][1];
        if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) continue;
        const jc = jz * this.nx + jx, ox = DIRS[d][0] * c, oz = DIRS[d][1] * c;
        let best = -1, bd = Infinity;
        for (let j = this.start[jc]; j < this.start[jc + 1]; j++) {
          // the step off either floor's plane (a slope rises along itself, not across: a ramp's side is a step)
          const dy = this.y[j] - this.y[i];
          const st = Math.min(Math.abs(dy - this._gx[i] * ox - this._gz[i] * oz), Math.abs(dy - this._gx[j] * ox - this._gz[j] * oz));
          if (st <= NAV.step && st < bd) {
            bd = st;
            best = j - this.start[jc];
          }
        }
        if (best >= 0) this.link[i * 8 + d] = best + 1;
      }
    }
  }

  /** Walkable floors: linked all round (not at a drop or a side) and no solid within NAV.inflate above the floor. */
  _walk() {
    const n = this.y.length;
    this.flags = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let f = 0;
      for (let d = 0; d < 8; d++) if (!this.link[i * 8 + d]) f |= F_EDGE;
      if (!f && this._solidNear(i, NAV.inflate)) f |= F_SOLID;
      this.flags[i] = f || F_WALK;
    }
  }

  /**
   * A solid within r of floor i's centre, between a step's height above the floor (more on a slope) and NAV.clear: an
   * upright cylinder test against the static colliders.
   */
  _solidNear(i, r) {
    // (a wide test on a slope would start above the car: at least 0.3 m of band are kept)
    const hi = NAV.clear, lo = Math.min(NAV.step + r * Math.hypot(this._gx[i], this._gz[i]), hi - 0.3);
    if (r !== this._shape.radius) this._shape = new RAPIER.Cylinder(0.5, r);
    this._shape.halfHeight = (hi - lo) / 2;
    const col = this.colOf[i];
    const p = { x: this.cx(col), y: this.y[i] + (lo + hi) / 2, z: this.cz(col) };
    return !!this.phys.world.intersectionWithShape(p, this._rot, this._shape, this._flags);
  }

  /** Connected areas of walkable floors; `main` — the biggest (where the cars are), `free` — its floors. */
  _components() {
    const n = this.y.length;
    const comp = (this.comp = new Uint16Array(n)); // 0 — not walkable
    const queue = new Int32Array(n);
    const sizes = [0];
    for (let s = 0; s < n; s++) {
      if (comp[s] || !(this.flags[s] & F_WALK)) continue;
      const id = sizes.length;
      let qh = 0, qt = 0;
      queue[qt++] = s;
      comp[s] = id;
      while (qh < qt) {
        const i = queue[qh++];
        for (let d = 0; d < 8; d++) {
          const j = this.next(i, d);
          if (j >= 0 && !comp[j] && this.flags[j] & F_WALK) {
            comp[j] = id;
            queue[qt++] = j;
          }
        }
      }
      sizes.push(qt);
    }
    this.main = sizes.indexOf(Math.max(...sizes));
    this.free = new Int32Array(sizes[this.main]);
    let k = 0;
    for (let i = 0; i < n; i++) if (comp[i] === this.main) this.free[k++] = i;
  }

  /** room[i] — distance from floor i to the nearest unwalkable floor (or a column without a linked floor), 0.1 m steps. */
  _room() {
    const n = this.y.length, c = this.cell;
    const dist = new Float32Array(n).fill(Infinity);
    // Dijkstra from the unwalkable floors over the links; a missing link is an unwalkable neighbour
    const heap = new Int32Array(n * 8 + 8), hd = new Float32Array(n * 8 + 8);
    let size = 0;
    const push = (i, d) => {
      let k = size++;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (hd[p] <= d) break;
        heap[k] = heap[p];
        hd[k] = hd[p];
        k = p;
      }
      heap[k] = i;
      hd[k] = d;
    };
    const pop = () => {
      const top = heap[0];
      const li = heap[--size], ld = hd[size];
      let k = 0;
      for (;;) {
        let m = 2 * k + 1;
        if (m >= size) break;
        if (m + 1 < size && hd[m + 1] < hd[m]) m++;
        if (hd[m] >= ld) break;
        heap[k] = heap[m];
        hd[k] = hd[m];
        k = m;
      }
      heap[k] = li;
      hd[k] = ld;
      return top;
    };
    for (let i = 0; i < n; i++) {
      if (!(this.flags[i] & F_WALK)) {
        dist[i] = 0;
        push(i, 0);
      }
    }
    while (size) {
      const d0 = hd[0], i = pop();
      if (d0 > dist[i]) continue;
      for (let d = 0; d < 8; d++) {
        const j = this.next(i, d);
        if (j < 0) continue;
        const nd = d0 + (d & 1 ? c * Math.SQRT2 : c);
        if (nd < dist[j]) {
          dist[j] = nd;
          push(j, nd);
        }
      }
    }
    this.room = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.room[i] = Math.round(Math.min(dist[i], ROOM_MAX) * 10);
  }

  // ------------------------------------------------------------------ queries

  /** Column centre of column col. */
  cx(col) {
    return this.x0 + ((col % this.nx) + 0.5) * this.cell;
  }

  cz(col) {
    return this.z0 + (Math.floor(col / this.nx) + 0.5) * this.cell;
  }

  /** Column under (x, z), or -1 outside the grid. */
  col(x, z) {
    const ix = Math.floor((x - this.x0) / this.cell), iz = Math.floor((z - this.z0) / this.cell);
    return ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz ? -1 : iz * this.nx + ix;
  }

  /** The floor linked to floor i in direction d (0…7), or -1. */
  next(i, d) {
    const l = this.link[i * 8 + d];
    if (!l) return -1;
    const col = this.colOf[i], jc = col + DIRS[d][0] + DIRS[d][1] * this.nx;
    return this.start[jc] + l - 1;
  }

  /** Floor i's centre: { x, y, z }. */
  pos(i) {
    const col = this.colOf[i];
    return { x: this.cx(col), y: this.y[i], z: this.cz(col) };
  }

  kindOf(i) {
    return this.kinds[this.kind[i]];
  }

  /** Layer of floor i in its column, 0 — the lowest. */
  layer(i) {
    return i - this.start[this.colOf[i]];
  }

  walkable(i) {
    return i >= 0 && !!(this.flags[i] & F_WALK);
  }

  /** Walkable and in the main area: a car can drive there from where the others are. */
  reachable(i) {
    return i >= 0 && this.comp[i] === this.main;
  }

  /** Metres from floor i to the nearest unwalkable floor (up to 25.5). */
  roomAt(i) {
    return this.room[i] / 10;
  }

  /**
   * The floor under the point (x, y, z): the highest floor in its column at most `up` m above y (a car's y is its
   * floor's height, a falling car's is higher), else the lowest one. -1 if the column has none.
   */
  cellAt(x, y, z, up = 1) {
    const col = this.col(x, z);
    if (col < 0) return -1;
    const s = this.start[col], e = this.start[col + 1];
    if (s === e) return -1;
    for (let i = e - 1; i >= s; i--) if (this.y[i] <= y + up) return i;
    return s;
  }

  /** The point stands on a floor a car can drive on and reach the others from. */
  isFree(x, y, z) {
    return this.reachable(this.cellAt(x, y, z));
  }

  /** Any solid (static collider) within r of floor i's centre above the floor (see _solidNear). */
  solidNear(i, r) {
    return this._solidNear(i, r);
  }

  /**
   * The nearest reachable floor to (x, y, z) within r m (horizontally; a floor on another level counts its height
   * difference twice; y null — any level): min — at least this far; filter(i) — false skips it; cost(i) — metres added to its distance
   * (≥ 0, Infinity rules it out; only called for floors that could still win). -1 if none.
   */
  nearestFree(x, y, z, r, { min = 0, filter = null, cost = null } = {}) {
    const c = this.cell;
    const ix0 = Math.max(0, Math.floor((x - r - this.x0) / c)), ix1 = Math.min(this.nx - 1, Math.floor((x + r - this.x0) / c));
    const iz0 = Math.max(0, Math.floor((z - r - this.z0) / c)), iz1 = Math.min(this.nz - 1, Math.floor((z + r - this.z0) / c));
    const cand = [];
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const col = iz * this.nx + ix, px = this.x0 + (ix + 0.5) * c, pz = this.z0 + (iz + 0.5) * c;
        const dh = Math.hypot(px - x, pz - z);
        if (dh > r || dh < min) continue;
        for (let i = this.start[col]; i < this.start[col + 1]; i++) {
          if (this.comp[i] === this.main) cand.push(y == null ? dh : dh + 2 * Math.abs(this.y[i] - y), i);
        }
      }
    }
    const order = new Int32Array(cand.length / 2).map((_, k) => k).sort((a, b) => cand[2 * a] - cand[2 * b]);
    let best = -1, bs = Infinity;
    for (const k of order) {
      const d = cand[2 * k], i = cand[2 * k + 1];
      if (d >= bs) break;
      if (filter && !filter(i)) continue;
      const s = d + (cost ? cost(i) : 0);
      if (s < bs) {
        bs = s;
        best = i;
      }
    }
    return best;
  }

  /** A random reachable floor passing filter(i) (tries `tries` picks), or -1. */
  randomCell(filter = null, rnd = Math.random, tries = 400) {
    const F = this.free;
    if (!F.length) return -1;
    for (let k = 0; k < tries; k++) {
      const i = F[Math.floor(rnd() * F.length)];
      if (!filter || filter(i)) return i;
    }
    return -1;
  }

  /**
   * The way a car would drive at floor i: of the four lines through it (along X, Z and the diagonals), the one with
   * the longest run of walkable floors both ways (up to `look` m each way) — along a street, not across it.
   * { x, z } unit, `len` — the run's length, m.
   */
  axis(i, look = 40) {
    const steps = Math.ceil(look / this.cell);
    let best = 0, bl = -1;
    for (let d = 0; d < 4; d++) {
      let len = 0;
      for (const dd of [d, d + 4]) {
        let j = i;
        for (let k = 0; k < steps; k++) {
          j = this.next(j, dd);
          if (j < 0 || !(this.flags[j] & F_WALK)) break;
          len += d & 1 ? Math.SQRT2 : 1;
        }
      }
      if (len > bl) {
        bl = len;
        best = d;
      }
    }
    const [dx, dz] = DIRS[best], l = Math.hypot(dx, dz);
    return { x: dx / l, z: dz / l, len: bl * this.cell };
  }
}

/** Build the nav grid for a map: its Rapier world (static colliders) and bounds. */
export function buildNav(phys, bounds) {
  return new NavGrid(phys, bounds);
}
