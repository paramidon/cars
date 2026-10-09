/**
 * A car on Rapier: a dynamic rigid body with a two-box chassis, mass and centre of mass set explicitly, and Rapier's
 * DynamicRayCastVehicleController for the four ray-cast wheels — suspension only, the tyres themselves hold
 * nothing. Grip, thrust and steering come from the arcade layer: each step, while wheels touch the ground, the
 * car's own handling (Car._drive, the same numbers as the old physics) turns input into new forward and lateral
 * speeds and a yaw rate, and the body's velocity is nudged towards them. In the air, or leaning hard, the car is
 * purely physical. The body frame is the car model's frame: x to the left, y up from the wheels' contact, z forward.
 */
import * as THREE from 'three';
import { RAPIER, PHYS } from './rapier.js';
import { clamp } from '../utils.js';

export const VEH = {
  mass: 1200, // kg
  com: 0.55, // m — centre of mass above the wheels' contact: rolled past ~60° (atan(0.95 / 0.55)) the car falls over
  inertia: [2050, 2250, 600], // kg·m² about the car's x (pitch), y (yaw) and z (roll) axes — a 2 × 1.4 × 4.3 m box
  // chassis colliders, centre and half sizes: the lower body (as wide as the tyres) and the cabin
  lower: { at: [0, 0.68, 0], half: [1.1, 0.38, 2.25] },
  cabin: { at: [0, 1.36, -0.3], half: [0.8, 0.3, 1.05] },
  friction: 0.4, // body against walls and the ground (sliding on the side or the roof)
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
  // test-ground pads
  boost: 36, // m/s ≈ 130 km/h along the heading
  launch: 18, // m/s straight up (catapult)
};

const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _lv = new THREE.Vector3();
const _av = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);

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
    for (const part of [VEH.lower, VEH.cabin]) {
      const cd = RAPIER.ColliderDesc.cuboid(...part.half).setTranslation(...part.at).setDensity(0);
      w.createCollider(cd.setFriction(VEH.friction).setRestitution(VEH.restitution), this.body);
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
    this.contacts = 0; // wheels on the ground at the last step
    this.tippedT = 0;
    this.righting = null;
    this.padIn = null;
    phys.vehicles.push(this);
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
    this.sync();
  }

  savePrev() {
    this.prevP.copy(this.curP);
    this.prevQ.copy(this.curQ);
  }

  afterStep() {
    const t = this.body.translation(), r = this.body.rotation();
    this.curP.set(t.x, t.y, t.z);
    this.curQ.set(r.x, r.y, r.z, r.w);
    if (this.righting?.done) this._endRighting();
  }

  /** Before a physics step: suspension, the arcade layer (input → velocity), pads. */
  preStep(h, inp) {
    const car = this.car, b = this.body, ctrl = this.ctrl;
    if (this.righting) {
      this._rightStep(h);
      return;
    }
    ctrl.updateVehicle(h);
    let n = 0;
    for (let i = 0; i < 4; i++) if (ctrl.wheelIsInContact(i)) n++;
    this.contacts = n;

    const r = b.rotation(), lv = b.linvel(), av = b.angvel();
    _q.set(r.x, r.y, r.z, r.w);
    _f.set(0, 0, 1).applyQuaternion(_q);
    _r.set(-1, 0, 0).applyQuaternion(_q);
    _u.set(0, 1, 0).applyQuaternion(_q);
    _lv.set(lv.x, lv.y, lv.z);
    _av.set(av.x, av.y, av.z);
    const vF = _lv.dot(_f), vR = _lv.dot(_r), yawRate = _av.dot(_u);
    car.angVel = yawRate;
    car._drive(h, inp, vF, vR);
    const k = (n / 4) * clamp((_u.y - VEH.upNone) / (VEH.upFull - VEH.upNone), 0, 1);
    let changed = false;
    if (k > 0) {
      _lv.addScaledVector(_f, (car.vF - vF) * k).addScaledVector(_r, (car.vR - vR) * k);
      _av.addScaledVector(_u, (car.angVel - yawRate) * k);
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
  }

  /** Once a frame: the flip rule — a car on its side or roof that has (nearly) stopped rolls back onto its wheels. */
  update(dt) {
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

  /** A sudden change of velocity (an explosion's jolt), m/s and rad/s. */
  kick(vx, vy, vz, wx = 0, wy = 0, wz = 0) {
    if (this.righting) return;
    const b = this.body, lv = b.linvel(), av = b.angvel();
    b.setLinvel({ x: lv.x + vx, y: lv.y + vy, z: lv.z + vz }, true);
    b.setAngvel({ x: av.x + wx, y: av.y + wy, z: av.z + wz }, true);
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
