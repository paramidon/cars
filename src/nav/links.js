/**
 * The nav grid's jumps (NAV_PLAN.md session 4): links for what the grid's neighbour links can't see — off a ramp's lip,
 * off an edge (a deck, a tunnel's portal) down to a lower floor, over a catapult. Each is found by flying the car's
 * lower body (a box, a shape cast per step) from the lip at a range of speeds through the Rapier world's static
 * colliders: a flight that lands on a reachable floor with room, not too hard, with a straight run-out after it, is
 * good. The lip speeds that land well are cut into bands (JUMP.band): a jump per band and per entry to the straight
 * run-up before the lip (its take-off floor, where A* enters it) keeps its speeds (a bot holds the middle one on the
 * run-up) and the floor at the end of the run-out after its farthest landing (where A* goes on).
 * Built from the colliders and the map's pads only, like the rest of the grid.
 */
import { RAPIER, PHYS } from '../physics/rapier.js';
import { VEH } from '../physics/vehicle.js';
import { thrustAt } from '../car.js';

export const JUMP = {
  speeds: [14, 36, 2], // m/s at the lip the flights are tried at: from, to, step (slower, a car going off an edge
  // tips over it nose first and lands on its roof: off the deck, 10 m/s and less roll it over, 13 pitches it 60°, 16 45°)
  launchFrom: 6, // m/s — onto a catapult from this speed (it throws the whole car up)
  dt: 0.05, // s — a step of a simulated flight (a shape cast of the box along it)
  flight: 3, // s — the longest flight looked at
  body: [1, 0.32, 2.05], // m — half sizes of the box flown (the car's lower body, VEH.lower, a little smaller)…
  bodyY: 0.68, // … its centre this high above the wheels' contact
  run: [10, 9], // m of straight run-up before the lip at least: off a slope (a ramp's lip) / off a flat edge, onto a pad
  runMax: 40, // m — the longest run-up looked at; A* may enter it (take off) at any of its floors from run[] m to this,
  entries: 3, // every this many floors (a car arriving on a deck near its edge takes the drop from there, not from 40 m back)…
  entryV: 8, // m/s — … if a car entering it there at this speed (out of a corner) reaches the band's middle speed by the
  // lip at full throttle (thrustAt, against the climb)
  out: [6, 15], // m of straight walkable floor after a landing: out[0] + the way to stop from the lip speed braking at
  // out[1] m/s² (it can't turn or brake in the air: after landing it needs room for both)
  outRoom: 1.5, // m of room (NavGrid.roomAt) along that run-out…
  room: 1.5, // … and at the floor landed on
  impact: 19, // m/s at most into the floor on landing (more than VEH.landSafe costs hull: a catapult's fall is ~18)
  lip: 0.9, // a slope's edge is a lip only along the slope's own way (the cosine; across it, it's the ramp's side)
  band: 6, // m/s — the speeds that land well are cut into bands this wide, every `bandStep` m/s: a jump per band, each
  bandStep: 4, // with its own landing and run-out (A* picks the one that fits where it goes; the bot holds its middle)
};

const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const STEP = 0.4; // m — a floor this much lower beyond an edge makes it a drop (or a gap) to fly off

/**
 * Find the jumps of nav (a NavGrid with its floors, links, flags and room built) and the map's pads. Sets nav.jumps —
 * [{ kind: 'jump' | 'drop' | 'launch', from, to, lip: { x, y, z }, dx, dz, grade, run, lo, hi, land: [m from the lip
 * per speed lo, lo + step … hi], out, vin }] — and nav.jumpStart / nav.jumpTo (CSR by the take-off floor `from`).
 */
export function buildLinks(nav, pads) {
  const n = nav.y.length, c = nav.cell;
  const world = nav.phys.world;
  const shape = new RAPIER.Cuboid(...JUMP.body);
  const flags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS | RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC;
  const g = PHYS.gravity, cosMax = Math.cos((32 * Math.PI) / 180);
  const jumps = [];
  const launch = pads.some((p) => p.type === 'launch');

  /** Fly the box from (x, y, z) (its wheels' contact) with velocity (vx, vy, vz), turned to yaw: the landing or null. */
  const fly = (x, y, z, vx, vy, vz, yaw) => {
    const rot = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    let px = x, py = y + JUMP.bodyY, pz = z;
    const dt = JUMP.dt;
    for (let t = 0; t < JUMP.flight; t += dt) {
      const sx = vx * dt, sy = vy * dt - 0.5 * g * dt * dt, sz = vz * dt, L = Math.hypot(sx, sy, sz);
      const hit = world.castShape({ x: px, y: py, z: pz }, rot, { x: sx / L, y: sy / L, z: sz / L }, shape, 0, L, false, flags);
      if (hit) {
        const k = hit.time_of_impact / L, wy = vy - g * dt * k;
        // the surface's normal (the collider's side of the contact)
        const nm = hit.normal1;
        const up = nm.y >= 0 ? nm : { x: -nm.x, y: -nm.y, z: -nm.z };
        return { x: px + sx * k, y: py + sy * k - JUMP.bodyY, z: pz + sz * k, ny: Math.abs(nm.y), vin: -(vx * up.x + wy * up.y + vz * up.z), t: t + dt * k };
      }
      px += sx;
      py += sy;
      pz += sz;
      vy -= g * dt;
    }
    return null;
  };

  /** A landing { x, y, z, ny, vin } is good: the floor it hits is reachable, has room, and a straight run-out along d. */
  const landing = (h, d, v) => {
    if (!h || h.ny < cosMax || h.vin > JUMP.impact) return null;
    const box = h.y + JUMP.bodyY - JUMP.body[1];
    const i = nav.cellAt(h.x, box, h.z, 0.6);
    if (!nav.reachable(i) || Math.abs(nav.y[i] - box) > 0.7 || nav.roomAt(i) < JUMP.room) return null;
    const step = d & 1 ? c * Math.SQRT2 : c, need = JUMP.out[0] + (v * v) / (2 * JUMP.out[1]);
    let k = i;
    for (let s = 0; s < need; s += step) {
      k = nav.next(k, d);
      if (!nav.reachable(k) || nav.roomAt(k) < JUMP.outRoom) return null;
    }
    return { i, out: k };
  };

  /**
   * The straight run-up from floor k back against d (k included): reachable floors with reachable ones on both sides,
   * up to JUMP.runMax. [floors], the farthest last.
   */
  const runUp = (k, d) => {
    const back = (d + 4) % 8, step = d & 1 ? c * Math.SQRT2 : c, chain = [];
    for (let len = 0; len < JUMP.runMax && nav.reachable(k); len += step) {
      if (!nav.reachable(nav.next(k, (d + 2) % 8)) || !nav.reachable(nav.next(k, (d + 6) % 8))) break;
      chain.push(k);
      k = nav.next(k, back);
    }
    return chain;
  };

  /**
   * Try the speeds: off the lip (x, y, z) along d (unit ux, uz), rising `grade` per metre (a catapult: thrown up at
   * VEH.launch instead). The widest range of speeds that land well, cut into bands → a jump per band.
   */
  const tryJump = (kind, entries, x, y, z, d, ux, uz, grade) => {
    const [v0, v1, dv] = JUMP.speeds, yaw = Math.atan2(ux, uz), cs = 1 / Math.sqrt(1 + grade * grade);
    let best = null, cur = null;
    for (let v = kind === 'launch' ? JUMP.launchFrom : v0; v <= v1 + 1e-6; v += dv) {
      let vx = v * ux * cs, vz = v * uz * cs, vy = v * grade * cs, sx = x, sy = y, sz = z;
      if (kind === 'launch') vy = VEH.launch;
      else {
        // the flight starts as the tail leaves the lip: until then the car keeps its line
        sx += (vx / v) * JUMP.body[2];
        sy += (vy / v) * JUMP.body[2];
        sz += (vz / v) * JUMP.body[2];
      }
      const h = fly(sx, sy, sz, vx, vy, vz, yaw);
      const L = landing(h, d, v);
      if (L) {
        if (!cur) cur = { lo: v, hi: v, at: [] };
        cur.hi = v;
        cur.at.push({ v, land: Math.round(Math.hypot(h.x - x, h.z - z) * 10) / 10, out: L.out, vin: h.vin });
      } else cur = null;
      if (cur && (!best || cur.hi - cur.lo > best.hi - best.lo)) best = cur;
    }
    if (!best || best.hi - best.lo < JUMP.band) return;
    for (let lo = best.lo; lo + JUMP.band <= best.hi + 1e-6; lo += JUMP.bandStep) {
      const at = best.at.filter((a) => a.v >= lo - 1e-6 && a.v <= lo + JUMP.band + 1e-6), last = at[at.length - 1];
      const band = { kind, to: last.out, lip: { x, y, z }, dx: ux, dz: uz, grade, lo, hi: last.v, step: dv, land: at.map((a) => a.land), vin: Math.round(Math.max(...at.map((a) => a.vin)) * 10) / 10 };
      for (const e of entries) if (reach(e.run, y - nav.y[e.from]) >= (lo + last.v) / 2 + 1) jumps.push({ ...band, from: e.from, run: e.run });
    }
  };

  /** The speed at the end of a run-up `run` m long climbing `climb` m, entered at JUMP.entryV at full throttle. */
  const reach = (run, climb) => {
    let v = JUMP.entryV;
    for (let k = 0; k < 8; k++) v = Math.sqrt(Math.max(0, v * v + 2 * (thrustAt(v) - (g * climb) / run) * (run / 8)));
    return v;
  };

  /** Where A* may enter a run-up (`chain`, from the lip back, `step` m apart): every JUMP.entries floors from `min` m on, and its far end. */
  const entriesOf = (chain, step, min) => {
    const out = [];
    for (let m = 0; m < chain.length; m++) {
      const run = (m + 1) * step;
      if (run >= min && ((m + 1) % JUMP.entries === 0 || m === chain.length - 1)) out.push({ from: chain[m], run });
    }
    return out;
  };

  for (let j = 0; j < n; j++) {
    if (!nav.edge(j)) continue;
    const col = nav.colOf[j], ix = col % nav.nx, iz = (col - ix) / nav.nx;
    const gx = nav._gx[j], gz = nav._gz[j], slope = Math.hypot(gx, gz);
    for (let d = 0; d < 8; d++) {
      if (nav.link[j * 8 + d]) continue;
      const l = d & 1 ? Math.SQRT2 : 1, ux = DIRS[d][0] / l, uz = DIRS[d][1] / l;
      // off a slope only along it (a ramp's lip, not its side); off a flat edge straight out
      if (slope > 0.02 ? Math.abs(gx * ux + gz * uz) < JUMP.lip * slope : d & 1) continue;
      // something lower beyond: a drop or a gap, not a wall's foot
      const jx = ix + DIRS[d][0], jz = iz + DIRS[d][1];
      if (jx < 0 || jz < 0 || jx >= nav.nx || jz >= nav.nz) continue;
      const jc = jz * nav.nx + jx;
      let lower = false;
      for (let k = nav.start[jc]; k < nav.start[jc + 1]; k++) if (nav.y[k] < nav.y[j] - STEP) lower = true;
      if (!lower) continue;
      // the lip goes on sideways (not a ramp's corner)
      if (!nav.link[j * 8 + ((d + 2) % 8)] || !nav.link[j * 8 + ((d + 6) % 8)]) continue;
      const chain = runUp(nav.next(j, (d + 4) % 8), d);
      const step = l * c, entries = entriesOf(chain, step, JUMP.run[slope > 0.02 ? 0 : 1]);
      if (!entries.length) continue;
      const grade = gx * ux + gz * uz;
      const p = nav.pos(j);
      tryJump(slope > 0.02 && grade > 0 ? 'jump' : 'drop', entries, p.x + ux * step * 0.5, p.y + grade * step * 0.5, p.z + uz * step * 0.5, d, ux, uz, grade);
    }
  }

  // catapults: driven onto from a walkable floor beside one, straight across its edge
  if (launch) {
    for (let j = 0; j < n; j++) {
      if (nav.pad[j] !== 2) continue;
      for (let d = 0; d < 8; d += 2) {
        const k = nav.next(j, (d + 4) % 8);
        if (!nav.reachable(k) || nav.pad[nav.next(j, (d + 2) % 8)] !== 2 || nav.pad[nav.next(j, (d + 6) % 8)] !== 2) continue;
        const chain = runUp(k, d), entries = entriesOf(chain, c, JUMP.run[1]);
        if (!entries.length) continue;
        const [ux, uz] = DIRS[d], p = nav.pos(k);
        tryJump('launch', entries, p.x + ux * c * 0.5, nav.y[j], p.z + uz * c * 0.5, d, ux, uz, 0);
      }
    }
  }

  // CSR by the take-off floor
  jumps.sort((a, b) => a.from - b.from);
  nav.jumps = jumps;
  nav.jumpStart = new Int32Array(n + 1);
  nav.jumpTo = new Int32Array(jumps.length);
  for (const J of jumps) nav.jumpStart[J.from + 1]++;
  for (let i = 0; i < n; i++) nav.jumpStart[i + 1] += nav.jumpStart[i];
  jumps.forEach((J, q) => (nav.jumpTo[q] = J.to));
}
