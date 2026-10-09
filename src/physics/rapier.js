/**
 * Rigid-body physics on Rapier (@dimforge/rapier3d-compat — the WASM is embedded as base64, so the single-file
 * build keeps working). The world, static colliders built from the city's plain-data `solids`, and a fixed-step
 * loop with interpolation for rendering. Cars live in physics/vehicle.js.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { clamp } from '../utils.js';

export { RAPIER };

export const PHYS = {
  gravity: 20, // m/s² — arcade gravity, as in the old vertical model: short punchy jumps (the test ground is laid out for it)
  step: 1 / 120, // s — fixed physics step
  maxSteps: 8, // steps per frame at most: after a long freeze the game slows down instead of catching up
  friction: 0.5, // static colliders: the ground, ramps, curbs (a car on its side or roof slides on them)
  wallFriction: 0.1, // walls, buildings, poles, trees… (Physics OBSTACLES): a car pushing into one slides along it
};

/** Steps a car-vs-car contact may take to show its hit (see _carContacts). */
const PAIR_WAIT = 3;

/** Static colliders a car can lean on and slide around (not the surfaces it drives on). */
export const OBSTACLES = new Set(['building', 'wall', 'pole', 'tree', 'pillar', 'fountain', 'statue', 'pump', 'rail']);

/** How long the WASM module took to start, ms. */
export const rapierStats = { initMs: 0 };

/** Start Rapier: decode and compile the embedded WASM. Has to finish before the game is built. */
export async function initRapier() {
  const t0 = performance.now();
  await RAPIER.init();
  rapierStats.initMs = performance.now() - t0;
}

export class Physics {
  /**
   * solids — static colliders from buildCity(): { kind, box: [cx, cy, cz, hx, hy, hz] } | { kind, cyl: [cx, cy, cz,
   * halfHeight, r] } | { kind, hull: [x, y, z, …] }.
   */
  constructor(solids) {
    this.world = new RAPIER.World({ x: 0, y: -PHYS.gravity, z: 0 });
    this.world.timestep = PHYS.step;
    this.events = new RAPIER.EventQueue(true);
    this.acc = 0; // simulated time owed to the frame clock, s
    this.vehicles = [];
    this.carOf = new Map(); // car collider handle → Vehicle
    this.propOf = new Map(); // sensor collider handle → breakable prop (Breakables item)
    this.onCarHit = null; // (a, b, impact, px, pz, nx, nz) — two cars started touching; n points from b to a
    this.kinds = new Map(); // collider handle → kind: 'ground', 'wall', 'building', 'ramp', 'deck', 'rail', 'curb', 'pole', …
    this.stepMs = 0; // average cost of one step (car controls, suspension rays, world step), ms
    this.steps = 0;
    for (const s of solids) this.addSolid(s);
    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  }

  addSolid(s) {
    const desc = s.box
      ? RAPIER.ColliderDesc.cuboid(s.box[3], s.box[4], s.box[5]).setTranslation(s.box[0], s.box[1], s.box[2])
      : s.cyl
        ? RAPIER.ColliderDesc.cylinder(s.cyl[3], s.cyl[4]).setTranslation(s.cyl[0], s.cyl[1], s.cyl[2])
        : RAPIER.ColliderDesc.convexHull(new Float32Array(s.hull));
    if (!desc) throw new Error(`Rapier: degenerate collider (${s.kind})`);
    desc.setFriction(OBSTACLES.has(s.kind) ? PHYS.wallFriction : PHYS.friction);
    const c = this.world.createCollider(desc);
    this.kinds.set(c.handle, s.kind);
    return c;
  }

  /** Where rendering is between the last two physics states, 0…1. */
  get alpha() {
    return clamp(this.acc / PHYS.step, 0, 1);
  }

  /** Advance by dt in fixed steps; before(h) runs before each step (car controls). Returns the number of steps. */
  step(dt, before) {
    this.acc += dt;
    let n = 0;
    while (this.acc >= PHYS.step * 0.999 && n < PHYS.maxSteps) {
      const t0 = performance.now();
      before(PHYS.step);
      // after the controls: the velocities the solver starts from (the closing speed of a hit)
      for (const v of this.vehicles) v.savePrev();
      this.world.step(this.events);
      this._carContacts();
      for (const v of this.vehicles) v.afterStep();
      const ms = performance.now() - t0;
      this.stepMs = this.steps ? this.stepMs + (ms - this.stepMs) * 0.02 : ms;
      this.steps++;
      this.acc -= PHYS.step;
      n++;
    }
    if (n === PHYS.maxSteps || this.acc < 0) this.acc = 0;
    return n;
  }

  /**
   * Cars that started touching during the last step: Rapier has already pushed them apart (the bodies' own masses,
   * restitution and friction); the game gets the hit (sparks, sound, ram damage, the bots' back-up) with the closing
   * speed taken from the velocities before the step, at the contact point.
   */
  _carContacts() {
    const pending = this._pending ?? (this._pending = new Map());
    this.events.drainCollisionEvents((h1, h2, started) => {
      const A = this.carOf.get(h1), B = this.carOf.get(h2);
      if (!A !== !B) {
        // a car and a static collider (or a prop's sensor): keep track of what the chassis touches (Vehicle.touch)
        const v = A || B, own = A ? h1 : h2, other = A ? h2 : h1;
        const prop = this.propOf.get(other);
        if (prop) v.overlap(prop, started);
        else v.touch(own, other, started, this.kinds.get(other));
        return;
      }
      if (!started || !A || !B || A === B) return;
      const key = A.id < B.id ? A.id * 4096 + B.id : B.id * 4096 + A.id;
      if (!pending.has(key)) pending.set(key, { A, B, h1, h2, steps: 0 });
    });
    for (const [key, c] of pending) {
      // the first contact between two convex hulls can come with a useless normal (two vertical edges meeting nose to
      // nose give a vertical one, and nothing is pushed): the hit is taken at the first step that closes in along
      // its normal, at most PAIR_WAIT steps after the contact started
      const hit = this._closing(c.A, c.B, c.h1, c.h2);
      if (hit.impact < 0.5 && ++c.steps < PAIR_WAIT) continue;
      pending.delete(key);
      c.A.hit();
      c.B.hit();
      const hl = Math.hypot(hit.nx, hit.nz) || 1;
      this.onCarHit?.(c.A.car, c.B.car, hit.impact, hit.px, hit.pz, hit.nx / hl, hit.nz / hl);
    }
  }

  /** Contact point, normal (B → A) and closing speed of cars A and B touching through colliders h1 (A's) and h2. */
  _closing(A, B, h1, h2) {
    const w = this.world, out = this._hit ?? (this._hit = {});
    let px = (A.curP.x + B.curP.x) / 2, py = (A.curP.y + B.curP.y) / 2, pz = (A.curP.z + B.curP.z) / 2;
    let nx = A.curP.x - B.curP.x, ny = 0, nz = A.curP.z - B.curP.z;
    w.contactPair(w.getCollider(h1), w.getCollider(h2), (m, flipped) => {
      // the manifold's normal points from its first collider to its second; flipped — that first one is h2 (B's)
      const n = m.normal(), sgn = flipped ? 1 : -1;
      nx = n.x * sgn;
      ny = n.y * sgn;
      nz = n.z * sgn;
      const k = m.numSolverContacts();
      if (!k) return;
      px = py = pz = 0;
      for (let i = 0; i < k; i++) {
        const p = m.solverContactPoint(i);
        px += p.x / k;
        py += p.y / k;
        pz += p.z / k;
      }
    });
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    // closing speed along the normal (B → A) of the two contact points, before the step (and the one before it:
    // a contact the solver saw coming is taken off a step before it is reported as started)
    let vn = 0;
    for (let k = 0; k < 2; k++) {
      const va = A.pointVelPrev(px, py, pz, k), vax = va.x, vay = va.y, vaz = va.z;
      const vb = B.pointVelPrev(px, py, pz, k);
      vn = Math.min(vn, (vax - vb.x) * nx + (vay - vb.y) * ny + (vaz - vb.z) * nz);
    }
    return Object.assign(out, { impact: -vn, px, pz, nx, nz });
  }

  /**
   * Breakable street props (Breakables items: x, y, z, def.radius, def.h) as sensors: a car whose chassis overlaps one
   * breaks it (Vehicle.overlap, Car._breakProps) — in 3D, so a car flying over a bin or lying on its roof is right.
   */
  addProps(items) {
    for (const it of items) {
      const h = it.def.h / 2;
      const desc = RAPIER.ColliderDesc.cylinder(h, it.def.radius).setTranslation(it.x, it.y + h, it.z).setSensor(true);
      this.propOf.set(this.world.createCollider(desc).handle, it);
    }
  }

  /**
   * First static surface (not a car, not a sensor) along the ray from (x, y, z) in the unit direction (dx, dy, dz)
   * within maxT: { t, nx, ny, nz, kind } or null. Shells, bullets.
   */
  castStatic(x, y, z, dx, dy, dz, maxT) {
    const r = this._ray;
    r.origin = { x, y, z };
    r.dir = { x: dx, y: dy, z: dz };
    const flags = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    const hit = this.world.castRayAndGetNormal(r, maxT, true, flags);
    r.dir = { x: 0, y: -1, z: 0 };
    if (!hit) return null;
    const n = hit.normal;
    return { t: hit.timeOfImpact, nx: n.x, ny: n.y, nz: n.z, kind: this.kinds.get(hit.collider.handle) };
  }

  /** Height of the first surface straight below (x, y, z) within maxDist, ignoring body; null if there is none. */
  groundBelow(x, y, z, maxDist, body = null) {
    const r = this._ray;
    r.origin = { x, y, z };
    const flags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    const hit = this.world.castRay(r, maxDist, true, flags, undefined, undefined, body ?? undefined);
    return hit ? y - hit.timeOfImpact : null;
  }
}
