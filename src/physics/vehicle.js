/**
 * A car on Rapier: a dynamic rigid body with a two-box chassis, mass and centre of mass set explicitly, and Rapier's
 * DynamicRayCastVehicleController for the four ray-cast wheels — suspension only, the tyres themselves hold
 * nothing. Grip, thrust and steering come from the arcade layer: each step, while wheels touch the ground, the
 * car's own handling (Car._drive, the same numbers as the old physics) turns input into new forward and lateral
 * speeds and a yaw rate, and the body's velocity is nudged towards them. In the air, or leaning hard, the car is
 * purely physical. The body frame is the car model's frame: x to the left, y up from the wheels' contact, z forward.
 */
import * as THREE from 'three';
import { RAPIER, PHYS, OBSTACLES, GROUPS } from './rapier.js';
import { CAR_GRIP } from '../car.js';
import { clamp } from '../utils.js';

export const VEH = {
  mass: 1200, // kg
  com: 0.55, // m — centre of mass above the wheels' contact: rolled past ~60° (atan(0.95 / 0.55)) the car falls over
  inertia: [2050, 2250, 600], // kg·m² about the car's x (pitch), y (yaw) and z (roll) axes — a 2 × 1.4 × 4.3 m box
  // chassis colliders, centre and half sizes: the lower body (as wide as the tyres) and the cabin. Seen from above the
  // lower body's ends are rounded with radius `corner` m — half its width, so the nose and the tail are semicircles,
  // like the old physics' round-ended car: a hit on a pole, a tree or a building's corner glances off instead of
  // snagging on a square corner or a flat nose
  lower: { at: [0, 0.68, 0], half: [1.1, 0.38, 2.25], corner: 1.1 },
  cabin: { at: [0, 1.36, -0.3], half: [0.8, 0.3, 1.05] },
  friction: 0.3, // body against walls, cars and the ground (sliding along a wall, on the side or the roof); the lower
  // of the two surfaces' values is used — the old physics' wall friction was 0.3 too
  restitution: 0.15,
  angularDamping: 0.3, // 1/s — spin slowly fades, in the air too
  // ray-cast suspension; Rapier multiplies stiffness and damping by the car's mass, so they are per kg, per wheel
  wheelRadius: 0.42,
  rest: 0.3, // m — suspension rest length
  travel: 0.2, // m — compression past the rest position before the bump stop (the body's collider) takes over
  stiffness: 50, // (m/s²)/m — sag under the car's weight: gravity / (4 · stiffness) = 0.1 m
  compression: 3, // damping while the spring compresses, (m/s²)/(m/s)
  relaxation: 3.5, // … and while it extends
  // the arcade layer fades out as the car leans: full while up·Y ≥ upFull (~53°), none below upNone (~70°)
  upFull: 0.6,
  upNone: 0.35,
  // on its side or roof (up·Y < flipUp) and nearly still (flipStill m/s and rad/s) for flipAfter s, the car rolls
  // back onto its wheels: still a dynamic body (walls push it away), it is turned upright about its centre of mass at
  // up to rightRate rad/s, heading kept, its centre of mass held up to rightLift m higher the more upside down it is;
  // after rightTime s at most it is let go
  flipUp: 0.5,
  flipAfter: 1.5,
  flipStill: 1.5,
  rightRate: 6,
  rightLift: 0.9,
  rightTime: 1.5,
  // tripping (see preStep): for tripTime s after a hit (another car, a blast), sideways deceleration by grip above
  // tripAccel m/s² (the hardest turn needs ~35) rolls the car, as if that part of the grip acted at the wheels'
  // contact; trip — how much of it does. Only the sideways speed the hit itself gave the car can trip it: a car that
  // spins out on its own, or gets a light tap while sliding, doesn't roll over
  tripAccel: 40,
  trip: 1.5,
  tripTime: 0.4,
  // how much of the sideways grip is left while the body leans on a wall, a pole, a tree… (see preStep)
  leanGrip: 0.25,
  // hits on static colliders, game rules on top of the physics (see staticHits). A contact whose normal is within
  // ~53° of horizontal (y < wallNormal) is a wall hit (Car._impact: P.damageThreshold, P.damageScale, front armour…).
  // Touching down on the wheels after more than landAir s in the air, an impact (speed into the surface) above
  // landSafe m/s costs landScale hull per m/s more; the body hitting a floor on its side or roof — above roofSafe m/s,
  // roofScale per m/s
  wallNormal: 0.6,
  landAir: 0.12,
  landSafe: 13,
  landScale: 1.6,
  roofSafe: 6,
  roofScale: 2.4,
  // a shell's blast (Vehicle.blast): the speed it gives the car, blastLift of it upwards (the sine of its angle), and
  // blastSpin rad/s of tilt away from the blast per m/s of it — a close one shoves the car and tilts it
  blastLift: 0.1,
  blastSpin: 1,
  // test-ground pads
  boost: 36, // m/s ≈ 130 km/h along the heading
  launch: 18, // m/s straight up (catapult)
};

/**
 * Network ghosts — cars another computer drives (Vehicle.setRemote). A ghost is a dynamic body of a car's mass with no
 * gravity, no suspension and no tyres, that touches only the cars driven here. Each step a critically damped spring of
 * `rate` rad/s pulls it towards its last snapshot, carried forward by the snapshot's velocities (at most `ahead` s; in
 * the air, with gravity too). So a car driven here that hits a ghost gets the response of hitting a car, not a wall, and
 * the ghost takes its own share of the hit — as it will on its owner's screen — until the snapshots catch up.
 */
export const GHOST = {
  rate: 12, // rad/s
  ahead: 0.25, // s
  sink: 0.15, // m — carried forward in the air, it goes at most this far below the ground (springs squashed on landing)
  snap: 8, // m — farther than this from where it should be (a respawn), it is put there at once
  deep: 0.3, // m — this far inside a car driven here, it stops touching cars until it overlaps none (ghostDeep)…
  loose: 2, // m — … and so it does this far from where its snapshot puts it, until it is within half of that
  // after a car driven here hits it, it moves on its own share of the hit until a snapshot's velocity has changed by
  // holdShow of what its own has, at most hold s (ghostHit)
  holdShow: 0.5,
  hold: 0.4,
  // a hit between a car driven here and a ghost is resolved on both computers, each for its own car; the one that drove
  // into it also sends the ghost's share (its knock) to the ghost's owner. Within knockWindow s, along the knock's
  // direction the car ends up with the larger of the two, not their sum (see netKnock)
  knockWindow: 0.4,
};

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _lv = new THREE.Vector3();
const _av = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);
const _nn = new THREE.Vector3();
const _s = new THREE.Vector3();

/** A box { at, half, corner } with its four vertical edges rounded (radius corner, 6 segments), as a convex hull. */
function roundedBox({ at, half: [hx, hy, hz], corner: c }) {
  const pts = [];
  for (const y of [at[1] - hy, at[1] + hy]) {
    for (const [sx, sz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      for (let i = 0; i <= 6; i++) {
        const a = (i / 6) * (Math.PI / 2);
        pts.push(at[0] + sx * (hx - c + c * Math.cos(a)), y, at[2] + sz * (hz - c + c * Math.sin(a)));
      }
    }
  }
  return RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
}

export class Vehicle {
  /** car — the Car this body drives (its wheels give the suspension points, its _drive the handling). */
  constructor(phys, car) {
    this.phys = phys;
    this.car = car;
    const w = phys.world;
    const I = VEH.inertia;
    this.body = w.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setAdditionalMassProperties(VEH.mass, { x: 0, y: VEH.com, z: 0 }, { x: I[0], y: I[1], z: I[2] }, { x: 0, y: 0, z: 0, w: 1 })
        .setAngularDamping(VEH.angularDamping)
        .setCanSleep(false),
    );
    this.body.enableCcd(true);
    this.id = phys.vehicles.length + 1;
    this.colliders = [];
    for (const cd of [roundedBox(VEH.lower), RAPIER.ColliderDesc.cuboid(...VEH.cabin.half).setTranslation(...VEH.cabin.at)]) {
      cd.setDensity(0).setFriction(VEH.friction).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
      cd.setRestitution(VEH.restitution).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS).setCollisionGroups(GROUPS.car);
      const c = w.createCollider(cd, this.body);
      this.colliders.push(c);
      phys.carOf.set(c.handle, this);
    }
    // Rapier would compute the mass only at the next step; a body rotated before that ends up with NaNs
    this.body.recomputeMassPropertiesFromColliders();

    const ctrl = (this.ctrl = w.createVehicleController(this.body));
    ctrl.indexUpAxis = 1;
    ctrl.setIndexForwardAxis = 2; // (sic: that is the setter's name in rapier.js)
    // suspension points: at rest the wheels touch the ground exactly where the model's wheels do (body y = 0)
    this.connY = VEH.wheelRadius + VEH.rest - PHYS.gravity / (4 * VEH.stiffness);
    for (const wh of car.wheels) {
      ctrl.addWheel({ x: wh.x, y: this.connY, z: wh.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, VEH.rest, VEH.wheelRadius);
      const i = ctrl.numWheels() - 1;
      ctrl.setWheelSuspensionStiffness(i, VEH.stiffness);
      ctrl.setWheelSuspensionCompression(i, VEH.compression);
      ctrl.setWheelSuspensionRelaxation(i, VEH.relaxation);
      ctrl.setWheelMaxSuspensionTravel(i, VEH.travel);
      ctrl.setWheelMaxSuspensionForce(i, 1e6);
      // no tyre friction in Rapier: grip is the arcade layer's job
      ctrl.setWheelFrictionSlip(i, 0);
      ctrl.setWheelSideFrictionStiffness(i, 0);
    }

    // poses of the last two steps (rendering interpolates between them) and the interpolated rotation
    this.prevP = new THREE.Vector3();
    this.curP = new THREE.Vector3();
    this.prevQ = new THREE.Quaternion();
    this.curQ = new THREE.Quaternion();
    this.quat = new THREE.Quaternion();
    this.up = new THREE.Vector3(0, 1, 0);
    // velocities and centre of mass before the current step and before the one before it (the closing speed of a
    // hit: a contact the solver saw coming takes the speed off a step before Rapier reports it as started)
    this.pre = [0, 1].map(() => ({ v: new THREE.Vector3(), w: new THREE.Vector3(), com: new THREE.Vector3() }));
    this._pv = new THREE.Vector3();
    this.active = true;
    this.tripT = 0; // > 0: just hit, grip can trip the car over (VEH.tripTime)…
    this.tripV = 0; // … stopping at most this much sideways speed more, m/s
    this.statics = new Map(); // "chassis collider:static collider" → [own, other, kind]: what the body touches
    this.leans = new Set(); // … of them, the walls, poles, trees… (Physics OBSTACLES) it leans on
    this.props = new Set(); // breakable props whose sensors the body overlaps
    this.airT = 0; // s with no wheel and no part of the body on anything
    this.setV = new THREE.Vector3(); // the velocity the controls left the body with before the current step
    this.setW = new THREE.Vector3(); // … and the spin
    this.knockV = new THREE.Vector3(); // what the last hit (another car) did to the velocity, on top of the controls
    this.knockW = new THREE.Vector3(); // … and to the spin
    this.contacts = 0; // wheels on the ground at the last step
    this.tippedT = 0;
    this.righting = null;
    this.padIn = null;
    this.ghost = false; // another computer drives this car: the body follows its snapshots (setRemote, GHOST)
    this.net = null; // the ghost's last snapshot { p, q, v, w, air, at }
    this.touching = new Set(); // a ghost: the cars driven here it touches
    this.through = false; // a ghost deep inside a car driven here, touching no car for now (ghostDeep)
    this.ghostErr = 0; // m — how far the ghost is from where its snapshot puts it
    this.hold = null; // a ghost just hit: { t, v0, need } — moving on its own until a snapshot shows the hit (ghostHit)
    this.knocks = new Map(); // other Vehicle → this car's share of a recent hit with it, here and by event (netKnock)
    phys.vehicles.push(this);
  }

  /** Driven here (a dynamic car) or by another computer (a ghost following its snapshots, see GHOST). */
  setRemote(on) {
    if (on === this.ghost) return;
    this._endRighting();
    this.ghost = on;
    this.through = false;
    this.touching.clear();
    const b = this.body, ctrl = this.ctrl;
    b.setGravityScale(on ? 0 : 1, true);
    b.setAngularDamping(on ? 0 : VEH.angularDamping);
    for (const c of this.colliders) c.setCollisionGroups(on ? GROUPS.ghost : GROUPS.car);
    // a ghost's wheels only cast their rays (for the wheel meshes): no spring, no force on the body
    for (let i = 0; i < ctrl.numWheels(); i++) {
      ctrl.setWheelSuspensionStiffness(i, on ? 0 : VEH.stiffness);
      ctrl.setWheelSuspensionCompression(i, on ? 0 : VEH.compression);
      ctrl.setWheelSuspensionRelaxation(i, on ? 0 : VEH.relaxation);
      ctrl.setWheelMaxSuspensionForce(i, on ? 0 : 1e6);
    }
    this.net = null;
    this.statics.clear();
    this.leans.clear();
    this.props.clear();
    this.knocks.clear();
    this.tippedT = 0;
    this.tripT = 0;
  }

  /**
   * A ghost's snapshot: position, rotation q (THREE.Quaternion), velocity, spin (world axes); air — none of its wheels on
   * the ground (carried forward with gravity). snap — put the ghost there at once (resuming a race).
   */
  netState(x, y, z, q, vx, vy, vz, wx, wy, wz, air, snap = false, lead = 0) {
    const first = !this.net;
    const n = this.net ?? (this.net = { p: new THREE.Vector3(), q: new THREE.Quaternion(), v: new THREE.Vector3(), w: new THREE.Vector3(), air: false, at: 0, lead: 0 });
    n.p.set(x, y, z);
    n.q.copy(q);
    n.v.set(vx, vy, vz);
    n.w.set(wx, wy, wz);
    n.air = air;
    // lead — how old the snapshot already is (the network's delay, see Netplay._snapshot)
    n.at = this.phys.time - lead;
    n.lead = lead;
    // this snapshot shows the hit (its velocity has changed by holdShow of what the ghost's own has, by now): follow the
    // snapshots again
    if (this.hold?.need > 0) {
      const v = this.body.linvel();
      if (n.v.distanceTo(this.hold.v0) >= GHOST.holdShow * _f.set(v.x, v.y, v.z).distanceTo(this.hold.v0)) this.hold.need = 0;
    }
    if (first || snap) {
      if (this.hold) this.hold.need = 0;
      this._ghostTarget(lead, true);
    }
  }

  /**
   * Where the ghost's snapshot puts it `age` s after it was sent: into _p, _q (pose) and _lv, _av (velocities). Carried
   * forward GHOST.ahead s past the network's delay at most; after that (snapshots stopped coming) it stays there. put —
   * move the body there at once.
   */
  _ghostTarget(age, put = false) {
    const n = this.net, held = age > GHOST.ahead + n.lead;
    if (held) age = GHOST.ahead + n.lead;
    _p.copy(n.p).addScaledVector(n.v, age);
    _lv.copy(n.v);
    this.floor = null;
    if (n.air && age > 0) {
      _p.y -= 0.5 * PHYS.gravity * age * age;
      _lv.y -= PHYS.gravity * age;
    }
    if ((n.air || n.v.y < -1) && age > 0) {
      // carried forward through a landing (the snapshot of the first wheel's touch still falls fast) it would sink into
      // the ground until the next snapshot: not below it (and the body itself stops there, see ghostStep)
      const gy = this.phys.groundBelow(_p.x, _p.y + 1.5, _p.z, 4, null, true);
      if (gy != null) this.floor = gy - GHOST.sink;
      if (gy != null && _p.y < this.floor) {
        _p.y = this.floor;
        _lv.y = Math.max(0, _lv.y);
      }
    }
    // (spin carried forward through an impact overshoots: a car falling onto its side is shown rolling ~10° too far for a
    // moment. Fading the tipping part of it on the ground instead made the ghost lag ~0.1 s through every roll)
    _q.copy(n.q);
    const wl = n.w.length();
    if (wl > 1e-6) _q.premultiply(_q2.setFromAxisAngle(_av.copy(n.w).divideScalar(wl), wl * age));
    _av.copy(n.w);
    if (held) {
      _lv.set(0, 0, 0);
      _av.set(0, 0, 0);
    }
    if (!put) return;
    const b = this.body;
    b.setTranslation(_p, true);
    b.setRotation(_q, true);
    b.setLinvel(_lv, true);
    b.setAngvel(_av, true);
    this.curP.copy(_p);
    this.prevP.copy(_p);
    this.curQ.copy(_q);
    this.prevQ.copy(_q);
    this.setV.copy(_lv);
    this.setW.copy(_av);
    this.ghostErr = 0;
    this._putOverlaps();
  }

  /**
   * A car driven here hit this ghost (knockV — what the solver did to it): its snapshots still show the car before the
   * hit for a round trip and more, and the spring would drive it on as if nothing happened — the rammer's ghost shoving
   * on into the victim, the victim's springing back into the rammer and hitting it again. So the ghost moves on its own,
   * as the solver left it (its share of the hit; on its wheels the sideways part fades with the car's grip), until a
   * snapshot shows the hit — its velocity has changed by GHOST.holdShow of what the ghost's own has — or GHOST.hold s pass.
   */
  ghostHit() {
    if (!this.net || this.knockV.length() < 0.3) return;
    const h = this.hold ?? (this.hold = { t: 0, v0: new THREE.Vector3(), need: 0 });
    h.t = this.phys.time;
    h.v0.copy(this.net.v);
    h.need = 1;
  }

  /** Before a physics step, for a ghost: steer the body towards its snapshot (GHOST). */
  ghostStep(h) {
    if (!this.net) return;
    const b = this.body, age = Math.max(0, this.phys.time - this.net.at);
    if (this.hold?.need > 0 && this.phys.time - this.hold.t < GHOST.hold) {
      const v = b.linvel(), w = b.angvel();
      _f.set(v.x, v.y, v.z);
      // on its wheels the real car's tyres take the sideways part of the hit away fast (the arcade grip): so does the ghost
      if (this.contacts >= 2 && this.up.y > VEH.upFull) {
        _r.set(-1, 0, 0).applyQuaternion(this.curQ);
        _f.addScaledVector(_r, _f.dot(_r) * (Math.exp(-CAR_GRIP * h) - 1));
        b.setLinvel(_f, true);
      }
      this.setV.copy(_f);
      this.setW.set(w.x, w.y, w.z);
      return;
    }
    if (this.hold) this.hold.need = 0;
    this._ghostTarget(age);
    const t = b.translation();
    const dx = _p.x - t.x, dy = _p.y - t.y, dz = _p.z - t.z;
    const e2 = dx * dx + dy * dy + dz * dz;
    this.ghostErr = Math.sqrt(e2);
    if (e2 > GHOST.snap * GHOST.snap) {
      this._ghostTarget(age, true);
      return;
    }
    // far from where it should be (catching up after a lag spike, a short respawn), it isn't where the car is: on its
    // way there it must not shove a car driven here as hard as the spring pulls
    if (this.ghostErr > GHOST.loose) this._setThrough(true);
    // a critically damped spring towards the target pose, with the target's velocity fed forward
    const om = GHOST.rate, k1 = om * om * h, k2 = 2 * om * h;
    const v = b.linvel(), w = b.angvel(), r = b.rotation();
    _f.set(v.x + k1 * dx + k2 * (_lv.x - v.x), v.y + k1 * dy + k2 * (_lv.y - v.y), v.z + k1 * dz + k2 * (_lv.z - v.z));
    // falling onto the ground: the spring alone would carry it through (the fall's speed against a target that stopped)
    if (this.floor != null) _f.y = Math.max(_f.y, Math.min(8, (this.floor - t.y) / h));
    // the rotation still to go, target · current⁻¹, as a rotation vector (the shorter way round)
    _q2.set(-r.x, -r.y, -r.z, r.w).premultiply(_q);
    if (_q2.w < 0) _q2.set(-_q2.x, -_q2.y, -_q2.z, -_q2.w);
    const s = Math.hypot(_q2.x, _q2.y, _q2.z);
    const e = s > 1e-9 ? (2 * Math.atan2(s, _q2.w)) / s : 2;
    _r.set(w.x + k1 * _q2.x * e + k2 * (_av.x - w.x), w.y + k1 * _q2.y * e + k2 * (_av.y - w.y), w.z + k1 * _q2.z * e + k2 * (_av.z - w.z));
    b.setLinvel(_f, true);
    b.setAngvel(_r, true);
    this.setV.copy(_f);
    this.setW.copy(_r);
  }

  /**
   * After a step, for a ghost. Deep inside a car driven here (one put onto the other: a respawn, a ghost put back where
   * its snapshot says after a lag spike) each computer pushes its own car out of the other's ghost — the same way, as
   * each ghost follows the other car's snapshots — and both cars speed up together (276 km/h in half a second, measured).
   * So a ghost more than GHOST.deep m inside a car driven here touches no car until it overlaps none.
   */
  ghostDeep() {
    const w = this.phys.world;
    if (this.through) {
      if (this.ghostErr > GHOST.loose / 2) return;
      let still = false;
      this._overlaps(this.curP, this.curQ, GROUPS.cars, () => (still = true));
      if (!still) this._setThrough(false);
      return;
    }
    if (!this.touching.size) return;
    let deep = false;
    const check = (m) => {
      for (let i = 0; i < m.numContacts(); i++) if (m.contactDist(i) < -GHOST.deep) deep = true;
    };
    for (const o of this.touching) for (const a of this.colliders) for (const b of o.colliders) w.contactPair(a, b, check);
    if (deep) this._setThrough(true);
  }

  _setThrough(on) {
    if (on === this.through) return;
    this.through = on;
    this.touching.clear();
    for (const c of this.colliders) c.setCollisionGroups(on ? GROUPS.through : GROUPS.ghost);
  }

  /**
   * Put somewhere at once (a teleport, a ghost put where its snapshot says): ghosts and cars driven here that the body
   * now overlaps let go of each other before the solver throws them apart (see ghostDeep).
   */
  _putOverlaps() {
    if (this.ghost) {
      let hit = false;
      this._overlaps(this.curP, this.curQ, GROUPS.cars, () => (hit = true));
      if (hit) this._setThrough(true);
    } else {
      // (not from inside the query: a collider's groups set while Rapier runs the query are lost)
      const hit = new Set();
      this._overlaps(this.curP, this.curQ, GROUPS.ghosts, (c) => hit.add(this.phys.carOf.get(c.handle)));
      for (const v of hit) v?._setThrough(true);
    }
  }

  /** Calls hit(collider) for each collider of `groups` the body's shapes would overlap standing at p turned by q. */
  _overlaps(p, q, groups, hit) {
    const w = this.phys.world;
    this.colliders.forEach((c, i) => {
      const at = i ? VEH.cabin.at : [0, 0, 0];
      _s.set(at[0], at[1], at[2]).applyQuaternion(q).add(p);
      w.intersectionsWithShape(_s, q, c.shape, (o) => {
        hit(o);
        return true;
      }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups, undefined, this.body);
    });
  }

  /** Put a car driven here at (x, y, z) turned by q (a THREE.Quaternion), with velocity v and spin w (resuming a race). */
  setPose(x, y, z, q, v, w) {
    this.place(x, y, z, 0);
    const b = this.body;
    b.setRotation(q, true);
    b.setLinvel(v, true);
    b.setAngvel(w, true);
    this.curQ.copy(q);
    this.prevQ.copy(q);
    this._putOverlaps();
    this.sync();
  }

  /**
   * This car (driven here) took its share of a hit with ghost `other` from its own solver (knockV/W, just measured by
   * hit()): keep it for reconciling with the knock the other computer sends (netKnock).
   */
  localKnock(other) {
    const r = this._knock(other);
    r.lv.add(this.knockV);
    if (r.k > 0) this._knockApply(r);
  }

  /**
   * The computer that drives `other` hit this car (driven here) and sends this car's share of the hit: velocity change dv
   * and spin change dw. Both computers resolve the hit, each for its own car, and either may have missed it or seen it
   * weaker (a ghost is where its car was a moment ago). Within GHOST.knockWindow s, along dv's direction the car gets the
   * larger of the two shares: what its own solver gave it and dv — never their sum.
   */
  netKnock(other, dv, dw) {
    if (this.ghost || this.righting) return;
    let r = this._knock(other);
    if (r.k > 0) r = this._knock(other, true); // a second hit: matched with what happens here from now on
    r.kv.copy(dv);
    r.kw.copy(dw);
    r.k = r.kv.length();
    if (r.k < 1e-3) return;
    this._knockApply(r);
    // what was added on top of the car's own share can trip it, like any hit
    if (r.e > 0) this.hit(_nn.copy(r.kv).multiplyScalar(r.e / r.k));
  }

  /** The record of hits with `other` within GHOST.knockWindow (a new one if there is none, or fresh). */
  _knock(other, fresh = false) {
    let r = this.knocks.get(other);
    if (!r || fresh || this.phys.time - r.t > GHOST.knockWindow) {
      r = { t: this.phys.time, lv: new THREE.Vector3(), kv: new THREE.Vector3(), kw: new THREE.Vector3(), k: 0, e: 0 };
      this.knocks.set(other, r);
    }
    return r;
  }

  /** Top up (or take back) the event's knock so that along its direction the car has max(event, own solver's). */
  _knockApply(r) {
    const along = r.lv.dot(r.kv) / r.k;
    const e = Math.max(0, r.k - along), d = e - r.e;
    r.e = e;
    if (Math.abs(d) < 1e-4) return;
    const b = this.body, lv = b.linvel(), av = b.angvel(), s = d / r.k;
    b.setLinvel({ x: lv.x + r.kv.x * s, y: lv.y + r.kv.y * s, z: lv.z + r.kv.z * s }, true);
    b.setAngvel({ x: av.x + r.kw.x * s, y: av.y + r.kw.y * s, z: av.z + r.kw.z * s }, true);
  }

  /** Put the car upright at (x, y, z) facing yaw, standing still. */
  place(x, y, z, yaw) {
    this._endRighting();
    const b = this.body;
    _q.setFromAxisAngle(_Y, yaw);
    b.setTranslation({ x, y, z }, true);
    b.setRotation(_q, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.curP.set(x, y, z);
    this.prevP.copy(this.curP);
    this.curQ.copy(_q);
    this.prevQ.copy(_q);
    this.tippedT = 0;
    this.padIn = null;
    this.contacts = 4;
    this.airT = 0;
    this.net = null; // a ghost waits here for its first snapshot
    if (this.hold) this.hold.need = 0;
    this.setV.set(0, 0, 0);
    this.setW.set(0, 0, 0);
    this._putOverlaps();
    this.sync();
  }

  savePrev() {
    this.prevP.copy(this.curP);
    this.prevQ.copy(this.curQ);
    const b = this.body, v = b.linvel(), w = b.angvel(), c = b.worldCom();
    const [now, before] = this.pre;
    this.pre = [before, now];
    before.v.set(v.x, v.y, v.z);
    before.w.set(w.x, w.y, w.z);
    before.com.set(c.x, c.y, c.z);
  }

  /** Velocity of the body's point (x, y, z) before the current step (k = 0) or the one before it (k = 1). */
  pointVelPrev(x, y, z, k = 0) {
    const s = this.pre[k];
    _p.set(x, y, z).sub(s.com);
    return this._pv.crossVectors(s.w, _p).add(s.v);
  }

  /**
   * How fast the body's point p closed in along the unit normal n (pointing into the body) before this step — and,
   * for a contact that just started, before the step before it too: the larger. Positive — moving into it.
   */
  closing(p, n, fresh) {
    let c = 0;
    for (let k = 0; k < (fresh ? 2 : 1); k++) {
      const v = this.pointVelPrev(p.x, p.y, p.z, k);
      c = Math.max(c, -(v.x * n.x + v.y * n.y + v.z * n.z));
    }
    return c;
  }

  /** Take the car out of the world (it doesn't race) or put it back. */
  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    this.body.setEnabled(on);
    this.touching.clear();
    this.statics.clear();
    this.leans.clear();
    this.props.clear();
  }

  afterStep() {
    const t = this.body.translation(), r = this.body.rotation();
    this.curP.set(t.x, t.y, t.z);
    this.curQ.set(r.x, r.y, r.z, r.w);
    if (this.righting?.done) this._endRighting();
    else if (!this.righting && this.statics.size) this.staticHits();
  }

  /** Before a physics step: suspension, the arcade layer (input → velocity), pads. */
  preStep(h, inp) {
    const car = this.car, b = this.body, ctrl = this.ctrl;
    if (this.righting) {
      this._rightStep(h);
      return;
    }
    const lv0 = b.linvel();
    ctrl.updateVehicle(h, undefined, GROUPS.wheels);
    let n = 0;
    for (let i = 0; i < 4; i++) if (ctrl.wheelIsInContact(i)) n++;
    this.contacts = n;
    if (n && this.airT > VEH.landAir) {
      // touched down on the wheels: the impact is the speed into the surface (along the wheels' contact normals)
      // before the springs took any of it
      _u.set(0, 0, 0);
      for (let i = 0; i < 4; i++) {
        const cn = ctrl.wheelIsInContact(i) && ctrl.wheelContactNormal(i);
        if (cn) _u.x += cn.x, _u.y += cn.y, _u.z += cn.z;
      }
      if (_u.lengthSq() < 1e-6) _u.set(0, 1, 0);
      _u.normalize();
      this._land(-(lv0.x * _u.x + lv0.y * _u.y + lv0.z * _u.z));
    }
    this.airT = n ? 0 : this.airT + h;

    const r = b.rotation(), lv = b.linvel(), av = b.angvel();
    _q.set(r.x, r.y, r.z, r.w);
    _f.set(0, 0, 1).applyQuaternion(_q);
    _r.set(-1, 0, 0).applyQuaternion(_q);
    _u.set(0, 1, 0).applyQuaternion(_q);
    _lv.set(lv.x, lv.y, lv.z);
    _av.set(av.x, av.y, av.z);
    const vF = _lv.dot(_f), vR = _lv.dot(_r), yawRate = _av.dot(_u);
    this.tripT -= h;
    car.angVel = yawRate;
    car._drive(h, inp, vF, vR);
    const k = (n / 4) * clamp((_u.y - VEH.upNone) / (VEH.upFull - VEH.upNone), 0, 1);
    let changed = false;
    if (k > 0) {
      // leaning on an obstacle, grip lets the car slide along it: the sideways speed the contact gives it isn't taken
      // away, so it glances off a pole or a corner and scrapes along a wall (as the old physics' push-out did)
      const dvR = (car.vR - vR) * k * (this.leans.size ? VEH.leanGrip : 1);
      _lv.addScaledVector(_f, (car.vF - vF) * k).addScaledVector(_r, dvR);
      // the body's angular damping (ω /= 1 + h·d at the step) would shave ~2% off the yaw rate: pre-compensate it
      _av.addScaledVector(_u, (car.angVel * (1 + h * VEH.angularDamping) - yawRate) * k);
      // tripping: grip acts at the centre of mass (no lean in turns), but whatever it stops harder than any turn can
      // ask for (a car knocked sideways) acts at the tyres, below it — the car rolls towards where it was sliding
      const ex = this.tripT > 0 ? Math.min(Math.abs(dvR) - VEH.tripAccel * h, this.tripV) : 0;
      if (ex > 0) this.tripV -= ex;
      if (ex > 0) _av.addScaledVector(_f, (-Math.sign(dvR) * ex * VEH.trip * VEH.mass * VEH.com) / VEH.inertia[2]);
      b.setAngvel(_av, true);
      changed = true;
    }

    // test-ground pads: a boost holds 130 km/h along the heading, a catapult throws the car up once
    const pad = n >= 2 ? car.city.padAt?.(this.curP.x, this.curP.z, this.curP.y) : null;
    if (pad?.type === 'boost') {
      const v = _lv.dot(_f);
      if (v < VEH.boost) {
        _lv.addScaledVector(_f, VEH.boost - v);
        changed = true;
      }
    } else if (pad?.type === 'launch' && pad !== this.padIn) {
      _lv.y = VEH.launch;
      changed = true;
    }
    this.padIn = pad;
    if (changed) b.setLinvel(_lv, true);
    this.setV.copy(_lv);
    this.setW.copy(_av);
  }

  /**
   * Once a frame: the flip rule — a car on its side or roof that has (nearly) stopped rolls back onto its wheels. A
   * ghost only casts its wheels' rays (no force), so that its wheel meshes touch the ground.
   */
  update(dt) {
    if (this.ghost) {
      this.ctrl.updateVehicle(dt, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, GROUPS.rays);
      let n = 0;
      for (let i = 0; i < 4; i++) if (this.ctrl.wheelIsInContact(i)) n++;
      this.contacts = n;
      return;
    }
    if (this.righting || this.car.wrecked) {
      this.tippedT = 0;
      return;
    }
    const lv = this.body.linvel(), av = this.body.angvel();
    const still = Math.hypot(lv.x, lv.y, lv.z) < VEH.flipStill && Math.hypot(av.x, av.y, av.z) < VEH.flipStill;
    this.tippedT = this.up.y < VEH.flipUp && still ? this.tippedT + dt : 0;
    if (this.tippedT > VEH.flipAfter) this.right();
  }

  get tipped() {
    return this.up.y < VEH.flipUp;
  }

  /** Roll back onto the wheels (the flip rule, or R): see VEH.flipUp … rightTime. */
  right() {
    if (this.righting) return;
    const b = this.body, com = b.worldCom();
    const ground = this.phys.groundBelow(com.x, com.y, com.z, 12, b) ?? com.y - 1;
    // lying exactly on the roof, the shortest way up is undefined: roll over a side, always the same one
    _f.set(0, 0, 1).applyQuaternion(this.quat);
    this.righting = { t: 0, ground, roll: _f.clone().setY(0).normalize() };
    this.tippedT = 0;
    this.car.onRight?.();
  }

  /** One step of righting: velocities steer the (still dynamic) body upright and hold it a little above the ground. */
  _rightStep(h) {
    const R = this.righting, b = this.body;
    R.t += h;
    const r = b.rotation(), com = b.worldCom(), lv = b.linvel();
    _q.set(r.x, r.y, r.z, r.w);
    _u.set(0, 1, 0).applyQuaternion(_q);
    _av.crossVectors(_u, _Y);
    const angle = Math.atan2(_av.length(), _u.y);
    if (_av.lengthSq() < 1e-4) _av.copy(R.roll);
    _av.normalize().multiplyScalar(Math.min(VEH.rightRate, angle * 8));
    b.setAngvel(_av, true);
    const lift = R.ground + VEH.com + 0.25 + (VEH.rightLift * angle) / Math.PI;
    b.setLinvel({ x: lv.x * 0.9, y: clamp((lift - com.y) * 8, -4, 6), z: lv.z * 0.9 }, true);
    this.contacts = 0;
    if (angle < 0.06 || R.t > VEH.rightTime) R.done = true;
  }

  _endRighting() {
    if (!this.righting) return;
    this.righting = null;
    const b = this.body, lv = b.linvel();
    b.setLinvel({ x: lv.x, y: Math.min(0, lv.y), z: lv.z }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** A collision event between chassis collider own and static collider other of `kind` (Physics._carContacts). */
  touch(own, other, started, kind) {
    const key = `${own}:${other}`;
    if (started) {
      this.statics.set(key, [own, other, kind, true]);
      if (OBSTACLES.has(kind)) this.leans.add(key);
    } else {
      this.statics.delete(key);
      this.leans.delete(key);
    }
  }

  /** The body started or stopped overlapping a breakable prop's sensor. */
  overlap(prop, started) {
    if (started) this.props.add(prop);
    else this.props.delete(prop);
  }

  /**
   * After a step: hits on the static colliders the body touches, from each contact point's closing speed (the
   * velocities the solver started from, along the contact normal). A wall-like contact is a wall hit (Car._impact);
   * a floor under the body means it isn't in the air (after a flight, it's the landing), and hit on the side or the roof
   * it is a rollover hit (_roof).
   */
  staticHits() {
    const w = this.phys.world;
    let wall = 0, wk = null, roof = 0, land = 0, floor = false;
    const wp = this._wp ?? (this._wp = { x: 0, y: 0, z: 0, nx: 0, nz: 0 });
    const rp = this._rp ?? (this._rp = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 });
    const up = _u.set(0, 1, 0).applyQuaternion(this.curQ);
    for (const st of this.statics.values()) {
      const [own, other, kind, fresh] = st;
      st[3] = false;
      w.contactPair(w.getCollider(own), w.getCollider(other), (m, flipped) => {
        const k = m.numSolverContacts();
        if (!k) return;
        // the manifold's normal points from its first collider to its second; flipped — that first one is the static
        const n = m.normal(), sgn = flipped ? 1 : -1;
        const nx = n.x * sgn, ny = n.y * sgn, nz = n.z * sgn; // out of the static collider, into the car
        const nn = _nn.set(nx, ny, nz);
        const isWall = ny < VEH.wallNormal;
        const onBack = !isWall && up.x * nx + up.y * ny + up.z * nz < VEH.flipUp;
        if (!isWall) floor = true;
        for (let i = 0; i < k; i++) {
          const p = m.solverContactPoint(i);
          const into = this.closing(p, nn, fresh);
          if (isWall && into > wall) {
            wall = into;
            wk = kind === 'ground' ? 'wall' : kind; // the tube's trench walls
            Object.assign(wp, { x: p.x, y: p.y, z: p.z, nx, nz });
          } else if (onBack && into > roof) {
            roof = into;
            Object.assign(rp, { x: p.x, y: p.y, z: p.z, nx, ny, nz });
          } else if (!isWall && !onBack) land = Math.max(land, into);
        }
      });
    }
    if (floor) {
      // came down on the body (the nose first off a ledge) before the wheels: that is the landing
      if (this.airT > VEH.landAir) this._land(land);
      this.airT = 0;
    }
    if (wall > 0 && wk !== 'curb') {
      const l = Math.hypot(wp.nx, wp.nz) || 1;
      this.car._impact(wall, wp.nx / l, wp.nz / l, wp.x, wp.z, wk, wp.y);
    }
    if (roof > 0) this._roof(roof, rp);
  }

  /** Touched down on the wheels after a flight: dust, sound, sparks, and damage above VEH.landSafe. */
  _land(impact) {
    const car = this.car, { x, y, z } = this.curP;
    if (impact > 3) {
      car.fx.dust(x, y + 0.2, z, Math.min(14, Math.floor(impact)));
      const v = car.vol();
      if (impact > 6 && v > 0.03) car.audio.crash(Math.min(1.2, impact / 20) * v);
    }
    if (impact > 9) car.fx.sparks(x, y + 0.3, z, 0, 0, Math.min(24, Math.floor(impact)));
    // the dent: the underbody, pushed up
    if (impact > VEH.landSafe) car.applyDamage((impact - VEH.landSafe) * VEH.landScale, x, z, 0, 0, y, 1);
    car.onLand?.(impact);
  }

  /** The body hit a floor while on its side or roof: sparks, sound, a dent there, damage above VEH.roofSafe. */
  _roof(impact, p) {
    const car = this.car;
    if (impact > 2.5) {
      car.fx.sparks(p.x, p.y + 0.1, p.z, p.nx, p.nz, Math.min(24, Math.floor(impact * 1.5)));
      const v = car.vol(), now = performance.now();
      if (now - car.lastImpact > 120 && v > 0.03) car.audio.crash(Math.min(1.2, impact / 18) * v);
      car.lastImpact = now;
    }
    // the normal points out of the floor, into the car: the dent goes the same way
    if (impact > VEH.roofSafe) car.applyDamage((impact - VEH.roofSafe) * VEH.roofScale, p.x, p.z, p.nx, p.nz, p.y, p.ny);
    car.onImpact?.(impact, p.x, p.z);
  }

  /**
   * Just hit by something: for a moment grip can trip the car over (VEH.trip…). dv — the hit's change of velocity;
   * without it, what the last step did on top of the controls (another car, right after the world step).
   */
  hit(dv = null) {
    if (!dv) {
      const v = this.body.linvel(), w = this.body.angvel();
      dv = this.knockV.set(v.x, v.y, v.z).sub(this.setV);
      this.knockW.set(w.x, w.y, w.z).sub(this.setW);
    }
    const r = this.body.rotation();
    _r.set(-1, 0, 0).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
    const side = Math.abs(dv.x * _r.x + dv.y * _r.y + dv.z * _r.z);
    this.tripV = this.tripT > 0 ? Math.max(this.tripV, side) : side;
    this.tripT = VEH.tripTime;
  }

  /** A sudden change of velocity (an explosion's jolt), m/s and rad/s. */
  kick(vx, vy, vz, wx = 0, wy = 0, wz = 0) {
    if (this.righting || this.ghost) return; // a ghost moves as its snapshots say
    this.hit({ x: vx, y: vy, z: vz });
    const b = this.body, lv = b.linvel(), av = b.angvel();
    b.setLinvel({ x: lv.x + vx, y: lv.y + vy, z: lv.z + vz }, true);
    b.setAngvel({ x: av.x + wx, y: av.y + wy, z: av.z + wz }, true);
  }

  /**
   * A shell's blast at (x, y, z): the car gets dv m/s away from it (VEH.blastLift of that upwards) and tilts away from
   * it (VEH.blastSpin). Through kick(), so for a moment its own grip can trip it over too: a close blast can tip it.
   */
  blast(x, y, z, dv) {
    if (this.righting || dv <= 0) return;
    const b = this.body, com = b.worldCom();
    let dx = com.x - x, dz = com.z - z;
    const l = Math.hypot(dx, dz);
    if (l > 1e-3) {
      dx /= l;
      dz /= l;
    } else dx = dz = 0;
    const up = VEH.blastLift, flat = Math.sqrt(1 - up * up);
    const J = _lv.set(dx * flat, up, dz * flat).multiplyScalar(dv);
    // tilting away from the blast: about the level axis across the push
    const spin = dv * VEH.blastSpin;
    this.kick(J.x, J.y, J.z, dz * spin, 0, -dx * spin);
  }

  /**
   * Once a frame, after the physics steps: the pose interpolated for rendering, and the Car's fields the rest of the
   * game reads — x, y, z, yaw (heading; kept while the nose points straight up or down), vx, vy, vz, vF, vR, angVel,
   * upY (1 upright, 0 on the side, −1 on the roof).
   */
  sync() {
    const car = this.car, a = this.phys.alpha;
    _p.lerpVectors(this.prevP, this.curP, a);
    this.quat.slerpQuaternions(this.prevQ, this.curQ, a);
    car.x = _p.x;
    car.y = _p.y;
    car.z = _p.z;
    _f.set(0, 0, 1).applyQuaternion(this.quat);
    _r.set(-1, 0, 0).applyQuaternion(this.quat);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    if (Math.hypot(_f.x, _f.z) > 0.25) car.yaw = Math.atan2(_f.x, _f.z);
    car.upY = this.up.y;
    const lv = this.body.linvel(), av = this.body.angvel();
    car.vx = lv.x;
    car.vy = lv.y;
    car.vz = lv.z;
    car.vF = lv.x * _f.x + lv.y * _f.y + lv.z * _f.z;
    car.vR = lv.x * _r.x + lv.y * _r.y + lv.z * _r.z;
    car.angVel = av.x * this.up.x + av.y * this.up.y + av.z * this.up.z;
  }

  /** Height of wheel i's centre in the body frame (for the wheel meshes). */
  wheelY(i) {
    const len = this.ctrl.wheelSuspensionLength(i);
    return this.connY - (len ?? VEH.rest);
  }

  /**
   * Wheel i rolls on the ground the 2D effects know about (tyre marks, blood): in contact, and its contact point near
   * city.groundHeight (not on the tunnel's floor under the ground's surface, not on a ramp's slope).
   */
  wheelOnGround(i, wx, wz) {
    if (this.righting || !this.ctrl.wheelIsInContact(i)) return false;
    const c = this.ctrl.wheelContactPoint(i);
    return !!c && Math.abs(c.y - this.car.city.groundHeight(wx, wz)) < 0.25;
  }
}
