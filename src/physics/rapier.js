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
  /** solids — static colliders from buildCity(): { kind, box: [cx, cy, cz, hx, hy, hz] } | { kind, hull: [x, y, z, …] }. */
  constructor(solids) {
    this.world = new RAPIER.World({ x: 0, y: -PHYS.gravity, z: 0 });
    this.world.timestep = PHYS.step;
    this.acc = 0; // simulated time owed to the frame clock, s
    this.vehicles = [];
    this.kinds = new Map(); // collider handle → kind: 'ground', 'wall', 'building', 'ramp', 'deck', 'rail', 'curb'
    this.stepMs = 0; // average cost of one step (car controls, suspension rays, world step), ms
    this.steps = 0;
    for (const s of solids) this.addSolid(s);
    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  }

  addSolid(s) {
    const desc = s.box
      ? RAPIER.ColliderDesc.cuboid(s.box[3], s.box[4], s.box[5]).setTranslation(s.box[0], s.box[1], s.box[2])
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
      this.world.step();
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

  /** Height of the first surface straight below (x, y, z) within maxDist, ignoring body; null if there is none. */
  groundBelow(x, y, z, maxDist, body = null) {
    const r = this._ray;
    r.origin = { x, y, z };
    const hit = this.world.castRay(r, maxDist, true, undefined, undefined, undefined, body ?? undefined);
    return hit ? y - hit.timeOfImpact : null;
  }
}
