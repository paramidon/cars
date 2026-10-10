/**
 * Paths over the nav grid (NAV_PLAN.md session 3). A* over the walkable floors of the main area (layers come with the
 * grid's links); a metre costs more near solids, much more by a wreck (an obstacle the grid doesn't know) or a bot's
 * own trap, and less through a crowd for a butcher. Searches run from a queue under a per-frame budget. The floor path
 * is pulled into straight legs a car can drive — a strip of walkable floor on the same level along each leg — and the
 * corners ahead are kept for planning the speed.
 */
import { NAV } from './grid.js';

export const PATH = {
  budget: 3000, // floors a frame's searches may expand (the first search of a frame always runs)
  max: 12000, // a search that expands this many floors stops and returns the way to the floor nearest the goal
  greed: 1.4, // the heuristic's weight: a path may cost a little more than the best one, found several times faster
  // (at 2 the searches ignore the costs below and take alleys: twice faster again, but not worth it)…
  greedFar: 0.6, // … plus this much more for a goal `far` m away or further (linearly): a long way is searched again
  far: 300, // on the way anyway
  room: 8, // m — a floor closer than this to an unwalkable one costs more per metre (a fast car needs room)…
  roomCost: 3, // … up to this much more right by it (room NAV.cell), as the square of the closeness: paths keep off
  // walls, trees and poles…
  alley: 3, // m — … and a floor with less room than this (an alley, a gap a car turns into only in several goes)…
  alleyCost: 4, // … this much more again at room NAV.cell, linearly
  wreck: 4, // m around a wreck (or a car standing still for `still` s: a jam, a car wedged somewhere)…
  wreckCost: 6, // … a metre costs this much more
  still: 2,
  trap: 5, // m around the spot a bot got stuck at (for ESCAPE.trap s)…
  trapCost: 10, // … a metre costs this bot this much more: its new path goes another way if there is one
  turnRoom: 8, // m — a moving car's turning room: a floor this close behind it (the way it drives)…
  backCost: 4, // … costs up to this much more per metre (at 10 m/s and faster): a path doesn't start with a U-turn
  // unless the way ahead is much longer
  keep: 0.7, // a floor of the bot's last path to the same goal costs this much: a new search doesn't flip to another
  // way about as long (east round the block, then west, then east…) as the car turns
  crowd: 0.5, // a butcher (gore 1) pays this much less per metre through a crowd…
  crowdFull: 4, // … of this many living pedestrians in one crowd cell
  crowdCell: 4, // columns per crowd cell side (6 m)
  wide: 3, // m — a straight leg wants floors with this much room (NavGrid.roomAt) all along it…
  narrow: 2.1, // … or at least this much where there's no more (an alley): a car's half width and a margin from a
  // tree or a pole (a floor by an unwalkable one has room 1.5 — its far side may be 0.6 m from a tree)
  ends: 2, // m at either end of a leg where any walkable floor will do (a leg starts and ends by a corner)
  sample: 0.75, // m between samples along a leg
  leg: 60, // m — the longest straight leg
  turn: 0.3, // rad — a corner for speed planning: the turns of the vertices within `merge` m summed…
  merge: 8,
  refresh: 0.5, // s between updates of the wrecks and the crowds
};

const SQ2 = Math.SQRT2;
const DX = [1, 1, 0, -1, -1, -1, 0, 1], DZ = [0, 1, 1, 1, 0, -1, -1, -1];

export class NavPaths {
  constructor(nav) {
    this.nav = nav;
    const n = nav.y.length;
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.from = new Int32Array(n);
    this.seen = new Uint32Array(n); // = the search's stamp: g, f and from are set
    this.done = new Uint32Array(n); // = the search's stamp: closed
    this.pref = new Uint32Array(n); // = the search's stamp: on the last path (PATH.keep)
    this.heap = new Int32Array(n);
    this.hpos = new Int32Array(n);
    this.stamp = 0;
    // a floor's own cost per metre: 1, more near an unwalkable floor
    this.base = new Float32Array(n);
    const span = PATH.room - nav.cell;
    for (let i = 0; i < n; i++) {
      const r = nav.roomAt(i);
      this.base[i] = 1 + PATH.roomCost * Math.min(1, Math.max(0, (PATH.room - r) / span)) ** 2 + PATH.alleyCost * Math.min(1, Math.max(0, (PATH.alley - r) / (PATH.alley - nav.cell)));
    }
    this.block = new Uint8Array(n); // 1 — by a wreck
    this.blocked = [];
    this.stillT = new WeakMap(); // car → s it has stood still
    this.cnx = Math.ceil(nav.nx / PATH.crowdCell);
    this.crowd = new Float32Array(this.cnx * Math.ceil(nav.nz / PATH.crowdCell)); // 0…1 per crowd cell
    this.queue = [];
    this.spent = 0;
    this.refreshT = 0;
    this.stats = { searches: 0, expanded: 0, capped: 0 };
    this.cache = new Map(); // paths that never change (a race's gate to gate legs)
  }

  // ------------------------------------------------------------------ the world around

  /** Every PATH.refresh s: the floors by wrecks and cars standing still, and the crowds (living pedestrians per crowd cell). */
  update(dt, cars, peds) {
    for (const car of cars) this.stillT.set(car, car.speed < 1 ? (this.stillT.get(car) ?? 0) + dt : 0);
    this.refreshT -= dt;
    if (this.refreshT > 0) return;
    this.refreshT = PATH.refresh;
    const nav = this.nav, c = nav.cell;
    for (const i of this.blocked) this.block[i] = 0;
    this.blocked.length = 0;
    const r = Math.ceil(PATH.wreck / c);
    for (const car of cars) {
      if (!car.wrecked && !(this.stillT.get(car) > PATH.still)) continue;
      const col = nav.col(car.x, car.z);
      if (col < 0) continue;
      const ix = col % nav.nx, iz = (col - ix) / nav.nx;
      for (let jz = Math.max(0, iz - r); jz <= Math.min(nav.nz - 1, iz + r); jz++) {
        for (let jx = Math.max(0, ix - r); jx <= Math.min(nav.nx - 1, ix + r); jx++) {
          if (Math.hypot(jx - ix, jz - iz) * c > PATH.wreck) continue;
          const jc = jz * nav.nx + jx;
          for (let i = nav.start[jc]; i < nav.start[jc + 1]; i++) {
            if (!this.block[i] && Math.abs(nav.y[i] - car.y) < 2) {
              this.block[i] = 1;
              this.blocked.push(i);
            }
          }
        }
      }
    }
    this.crowd.fill(0);
    if (!peds) return;
    const cc = c * PATH.crowdCell, k = 1 / PATH.crowdFull;
    for (const p of peds.peds) {
      if (!peds.isLiving(p)) continue;
      const ix = Math.floor((p.x - nav.x0) / cc), iz = Math.floor((p.z - nav.z0) / cc);
      if (ix < 0 || iz < 0 || ix >= this.cnx) continue;
      const q = iz * this.cnx + ix;
      if (q < this.crowd.length) this.crowd[q] = Math.min(1, this.crowd[q] + k);
    }
  }

  // ------------------------------------------------------------------ the queue

  /** Plan for bot soon: its _plan(paths) is called from run() — this frame if the budget allows, else later. */
  ask(bot) {
    if (bot._queued) return;
    bot._queued = true;
    this.queue.push(bot);
  }

  /** Once a frame, after the bots think: the queued bots plan, oldest first, while the budget lasts. */
  run() {
    this.spent = 0;
    let first = true;
    while (this.queue.length && (first || this.spent < PATH.budget)) {
      const bot = this.queue.shift();
      bot._queued = false;
      bot._plan(this);
      first = false;
    }
  }

  // ------------------------------------------------------------------ searching

  /**
   * The floor a car at (x, y, z) is on, or the nearest reachable one within r m (a car scraping a wall stands on an
   * unwalkable floor) — ahead of it if yaw is given. -1 if none.
   */
  floorAt(x, y, z, r = 6, yaw = null) {
    const nav = this.nav, i = nav.cellAt(x, y, z);
    if (nav.reachable(i)) return i;
    const s = yaw == null ? 0 : Math.sin(yaw), c = yaw == null ? 0 : Math.cos(yaw);
    const cost = yaw == null ? null : (j) => ((nav.cx(nav.colOf[j]) - x) * s + (nav.cz(nav.colOf[j]) - z) * c < 0 ? 3 : 0);
    return nav.nearestFree(x, y, z, r, { cost });
  }

  /**
   * A* from floor a to floor b: the floors in between, a first, or null. traps — [{ x, z }]: a metre within PATH.trap
   * of one costs PATH.trapCost more; gore 0…1 — a metre through a crowd costs up to PATH.crowd × gore less; wrecks
   * false — wrecks cost nothing extra; car — { x, z, yaw, v }: floors behind a moving car, within PATH.turnRoom of it,
   * cost up to PATH.backCost more; prefer — floors (the last path to this goal) that cost PATH.keep as much.
   */
  find(a, b, { traps = null, gore = 0, wrecks = true, car = null, prefer = null } = {}) {
    const nav = this.nav;
    if (a < 0 || b < 0) return null;
    if (a === b) return [a];
    if (++this.stamp > 0xfffffff0) {
      this.seen.fill(0);
      this.done.fill(0);
      this.pref.fill(0);
      this.stamp = 1;
    }
    const st = this.stamp;
    const { g, f, from, seen, done, heap, hpos, base, block, crowd, pref } = this;
    if (prefer) for (const i of prefer) pref[i] = st;
    const { link, start, colOf, comp, y } = nav;
    const nx = nav.nx, c = nav.cell, main = nav.main, cnx = this.cnx, cc = PATH.crowdCell;
    const less = gore * PATH.crowd;
    const bcol = colOf[b], bx = bcol % nx, bz = (bcol - bx) / nx, acol = colOf[a];
    const hk = PATH.greed + PATH.greedFar * Math.min(1, (Math.hypot((acol % nx) - bx, (acol - (acol % nx)) / nx - bz) * c) / PATH.far);
    const tr2 = (PATH.trap / c) ** 2;
    // traps in column units
    const tp = traps && traps.map((t) => [(t.x - nav.x0) / c - 0.5, (t.z - nav.z0) / c - 0.5]);
    // the car's place and way in column units, and how much its speed makes turning back cost
    const back = car ? PATH.backCost * Math.min(1, Math.max(0, car.v / 10)) : 0;
    const cx = car && (car.x - nav.x0) / c - 0.5, cz = car && (car.z - nav.z0) / c - 0.5;
    const fx = car && Math.sin(car.yaw), fz = car && Math.cos(car.yaw), turn2 = (PATH.turnRoom / c) ** 2;
    const h = (col) => {
      const ix = col % nx, ddx = Math.abs(ix - bx), ddz = Math.abs((col - ix) / nx - bz);
      return (ddx > ddz ? ddx + (SQ2 - 1) * ddz : ddz + (SQ2 - 1) * ddx) * c * hk;
    };
    let size = 0;
    const up = (k, j) => {
      const fj = f[j];
      while (k > 0) {
        const p = (k - 1) >> 1, pj = heap[p];
        if (f[pj] <= fj) break;
        heap[k] = pj;
        hpos[pj] = k;
        k = p;
      }
      heap[k] = j;
      hpos[j] = k;
    };
    const pop = () => {
      const top = heap[0], last = heap[--size];
      if (size > 0) {
        const fl = f[last];
        let k = 0;
        for (;;) {
          let m = 2 * k + 1;
          if (m >= size) break;
          if (m + 1 < size && f[heap[m + 1]] < f[heap[m]]) m++;
          if (f[heap[m]] >= fl) break;
          heap[k] = heap[m];
          hpos[heap[k]] = k;
          k = m;
        }
        heap[k] = last;
        hpos[last] = k;
      }
      return top;
    };
    g[a] = 0;
    f[a] = h(colOf[a]);
    from[a] = -1;
    seen[a] = st;
    up(size++, a);
    let n = 0, best = a, bh = Infinity, found = false;
    while (size) {
      const i = pop();
      done[i] = st;
      if (i === b) {
        found = true;
        break;
      }
      const col = colOf[i], hi = f[i] - g[i];
      if (hi < bh) {
        bh = hi;
        best = i;
      }
      if (++n > PATH.max) break;
      const gi = g[i], yi = y[i];
      for (let d = 0; d < 8; d++) {
        const l = link[i * 8 + d];
        if (!l) continue;
        const jc = col + DX[d] + DZ[d] * nx, j = start[jc] + l - 1;
        if (comp[j] !== main || done[j] === st) continue;
        let w = base[j];
        if (wrecks && block[j]) w += PATH.wreckCost;
        if (tp || back) {
          const jx = jc % nx, jz = (jc - jx) / nx;
          if (tp) for (const [px, pz] of tp) if ((jx - px) ** 2 + (jz - pz) ** 2 < tr2) w += PATH.trapCost;
          if (back) {
            const rx = jx - cx, rz = jz - cz, r2 = rx * rx + rz * rz, ahead = rx * fx + rz * fz;
            if (r2 < turn2 && ahead < 0) w += (back * -ahead) / Math.sqrt(r2);
          }
        }
        if (less) w *= 1 - less * crowd[Math.floor((jc - (jc % nx)) / nx / cc) * cnx + Math.floor((jc % nx) / cc)];
        if (pref[j] === st) w *= PATH.keep;
        const ng = gi + ((d & 1 ? c * SQ2 : c) + Math.abs(y[j] - yi)) * w;
        if (seen[j] === st) {
          if (ng >= g[j]) continue;
          f[j] += ng - g[j];
          g[j] = ng;
          from[j] = i;
          up(hpos[j], j);
        } else {
          seen[j] = st;
          g[j] = ng;
          f[j] = ng + h(jc);
          from[j] = i;
          up(size++, j);
        }
      }
    }
    this.spent += n;
    this.stats.searches++;
    this.stats.expanded += n;
    this.capped = !found; // the last search stopped short of its goal
    if (!found) this.stats.capped++;
    const out = [];
    for (let i = found ? b : best; i >= 0; i = from[i]) out.push(i);
    return out.reverse();
  }

  // ------------------------------------------------------------------ straight legs

  /**
   * A car can drive straight from (x0, y0, z0) to (x1, z1): every PATH.sample m along the line (from `skip` m on) the
   * floor under it — on the level the line is on: it may climb or drop a step at a time, not jump layers — is
   * reachable and, but within PATH.ends of either end, has `room` m of room or more (NavGrid.roomAt).
   */
  lineFree(x0, y0, z0, x1, z1, room, skip = 0) {
    const nav = this.nav, dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz);
    if (L < 1e-3) return true;
    const ux = dx / L, uz = dz / L, n = Math.ceil(L / PATH.sample), up = NAV.step + 0.3, r10 = room * 10 - 0.5;
    let y = y0;
    for (let k = 1; k <= n; k++) {
      const t = (k / n) * L;
      if (t < skip) continue;
      const i = nav.cellAt(x0 + ux * t, y, z0 + uz * t, up);
      if (!nav.reachable(i) || Math.abs(nav.y[i] - y) > up + PATH.sample) return false;
      if (nav.room[i] < r10 && t > PATH.ends && t < L - PATH.ends) return false;
      y = nav.y[i];
    }
    return true;
  }

  /**
   * The floor path `cells` pulled into straight legs: from each corner, the farthest floor within PATH.leg that a
   * straight line with PATH.wide of room reaches (PATH.narrow where there's no more; the next floor where there's not
   * even that). (sx, sy, sz) — where it starts (the car), else the
   * first floor. Returns a polyline (see polyline()).
   */
  smooth(cells, sx = null, sy = 0, sz = 0) {
    const nav = this.nav, n = cells.length;
    const xs = [], ys = [], zs = [];
    const P = (k) => nav.pos(cells[k]);
    let a = 0, pa = sx == null ? P(0) : { x: sx, y: sy, z: sz };
    xs.push(pa.x), ys.push(pa.y), zs.push(pa.z);
    while (a < n - 1) {
      let best = a + 1;
      for (const w of [PATH.wide, PATH.narrow]) {
        let fails = 0;
        for (let j = a + 2; j < n; j++) {
          const pj = P(j);
          if (Math.hypot(pj.x - pa.x, pj.z - pa.z) > PATH.leg) break;
          if (this.lineFree(pa.x, pa.y, pa.z, pj.x, pj.z, w)) {
            best = j;
            fails = 0;
          } else if (++fails > 2) break;
        }
        if (best > a + 1) break;
      }
      a = best;
      pa = P(a);
      xs.push(pa.x), ys.push(pa.y), zs.push(pa.z);
    }
    return polyline(xs, ys, zs);
  }
}

/**
 * A polyline { x, y, z, s, corners }: s — the distance along it to each vertex; corners — [{ s, k, angle }] (k — the
 * vertex) where it turns
 * by PATH.turn or more (the turns of vertices within PATH.merge m of each other summed: a curve of short legs is one
 * corner).
 */
export function polyline(x, y, z) {
  const n = x.length, s = [0];
  for (let k = 1; k < n; k++) s.push(s[k - 1] + Math.hypot(x[k] - x[k - 1], z[k] - z[k - 1]));
  const corners = [];
  let cs = 0, ck = 0, ca = 0, last = -Infinity;
  for (let k = 1; k < n - 1; k++) {
    const a1 = Math.atan2(x[k] - x[k - 1], z[k] - z[k - 1]), a2 = Math.atan2(x[k + 1] - x[k], z[k + 1] - z[k]);
    let t = a2 - a1;
    t -= Math.round(t / (2 * Math.PI)) * 2 * Math.PI;
    if (Math.abs(t) < 0.05) continue;
    if (s[k] - last > PATH.merge) {
      if (Math.abs(ca) >= PATH.turn) corners.push({ s: cs, k: ck, angle: Math.abs(ca) });
      cs = s[k];
      ck = k;
      ca = 0;
    }
    ca += t;
    last = s[k];
  }
  if (Math.abs(ca) >= PATH.turn) corners.push({ s: cs, k: ck, angle: Math.abs(ca) });
  return { x, y, z, s, corners, length: s[n - 1] };
}

/** Polyline a, then b (b's first vertex dropped if a ends there). */
export function joinPaths(a, b) {
  const n = a.x.length, k = Math.hypot(b.x[0] - a.x[n - 1], b.z[0] - a.z[n - 1]) < 0.5 ? 1 : 0;
  return polyline([...a.x, ...b.x.slice(k)], [...a.y, ...b.y.slice(k)], [...a.z, ...b.z.slice(k)]);
}

/** The nearest point of polyline P to (x, z), looking at legs k0 − 1 … k0 + 4 only: { k (leg), s, d }. */
export function projectOn(P, x, z, k0 = 0) {
  const n = P.x.length;
  let best = { k: 0, s: 0, d: Infinity };
  if (n < 2) return { k: 0, s: 0, d: Math.hypot(P.x[0] - x, P.z[0] - z) };
  for (let k = Math.max(0, k0 - 1); k < Math.min(n - 1, k0 + 5); k++) {
    const ax = P.x[k], az = P.z[k], dx = P.x[k + 1] - ax, dz = P.z[k + 1] - az, L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
    const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
    if (d < best.d) best = { k, s: P.s[k] + t * (P.s[k + 1] - P.s[k]), d };
  }
  return best;
}

/** The point at distance s along polyline P (clamped to its ends): { x, y, z, dx, dz } — dx, dz the leg's way. */
export function pointOn(P, s) {
  const n = P.x.length;
  if (n < 2) return { x: P.x[0], y: P.y[0], z: P.z[0], dx: 0, dz: 1 };
  let k = 0;
  while (k < n - 2 && P.s[k + 1] < s) k++;
  const L = P.s[k + 1] - P.s[k] || 1, t = Math.max(0, Math.min(1, (s - P.s[k]) / L));
  const dx = (P.x[k + 1] - P.x[k]) / L, dz = (P.z[k + 1] - P.z[k]) / L;
  return { x: P.x[k] + (P.x[k + 1] - P.x[k]) * t, y: P.y[k] + (P.y[k + 1] - P.y[k]) * t, z: P.z[k] + (P.z[k + 1] - P.z[k]) * t, dx, dz };
}
