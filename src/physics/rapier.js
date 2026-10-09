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
  friction: 0.5, // static colliders (ground, walls, ramps)
};

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
    desc.setFriction(PHYS.friction);
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
      for (const v of this.vehicles) v.savePrev();
      before(PHYS.step);
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
    const w = this.world, seen = this._seen ?? (this._seen = new Set());
    seen.clear();
    this.events.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const A = this.carOf.get(h1), B = this.carOf.get(h2);
      if (!A || !B || A === B) return;
      const key = A.id < B.id ? A.id * 4096 + B.id : B.id * 4096 + A.id;
      if (seen.has(key)) return;
      seen.add(key);
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
      // closing speed along the normal (B → A) of the two contact points, before the step
      const va = A.pointVelPrev(px, py, pz), vax = va.x, vay = va.y, vaz = va.z;
      const vb = B.pointVelPrev(px, py, pz);
      const vn = (vax - vb.x) * nx + (vay - vb.y) * ny + (vaz - vb.z) * nz;
      A.hit();
      B.hit();
      const hl = Math.hypot(nx, nz) || 1;
      this.onCarHit?.(A.car, B.car, Math.max(0, -vn), px, pz, nx / hl, nz / hl);
    });
  }

  /** Height of the first surface straight below (x, y, z) within maxDist, ignoring body; null if there is none. */
  groundBelow(x, y, z, maxDist, body = null) {
    const r = this._ray;
    r.origin = { x, y, z };
    const hit = this.world.castRay(r, maxDist, true, undefined, undefined, undefined, body ?? undefined);
    return hit ? y - hit.timeOfImpact : null;
  }
}
