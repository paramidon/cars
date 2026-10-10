/**
 * In-browser physics measurements (PHYSICS_PLAN.md, sessions 2, 3 and 5). Not part of the game build: load it into a running
 * dev server page and call the functions with the game, e.g. in the console of `/?mute&map=test`:
 *
 *   const t = await import('/tests/physics.js');
 *   await t.handling(game);             // test ground: top speed, acceleration, yaw rates, handbrake, reverse, speedometer
 *   await t.leanRace(game, { secs: 75 }); // city: max lean of every car in an 8-car race
 *   await t.botLaps(game, { runs: 6 });   // city: bots' average speed, 6 seeded runs of 25 s
 *   await t.wallDamage(game);           // test ground: hull lost nose first into a wall / a pole 
 *   await t.botBattles(game, { type: 'royale', bots: 19 }); // city: 10 bot games of 2 min — stuck bots, wrecks, kills
 *   // also: landings, carCrashes, blasts, pedJumps, props, muzzle (session 3), sideHit, obstacle, wallScrape, rollovers,
 *   // gunnerTilt (session 5)
 *
 * Rapier is the only car physics since session 5; the `phys: 'old'` results in PHYSICS_PLAN.md were measured before
 * that, with `?phys=rapier` left out. The functions stop the page's own
 * animation loop and step the game by hand (game.step(1/60)), so they run faster than real time; reload afterwards.
 */

const DT = 1 / 60;
const KMH = 3.6;
const DEG = 180 / Math.PI;

/** Seeded Math.random replacement (mulberry32). */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const idle = () => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, fire: false, aim: 0, aimDX: 0, lookBack: false });

/** Take over the game: no animation loop, input from `inp`. */
function takeOver(game) {
  game.renderer.setAnimationLoop(null);
  const inp = idle();
  game.input.update = () => inp;
  return inp;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function run(game, secs, each) {
  const n = Math.round(secs / DT);
  for (let i = 0; i < n; i++) {
    if (each && each(i * DT) === false) return;
    game.step(DT);
    if (i % 300 === 299) await tick();
  }
}

/** Move the car by dz along z keeping its velocity (an endless straight on the test ground). */
function shiftZ(car, dz) {
  if (car.rb) {
    const b = car.rb.body, t = b.translation();
    b.setTranslation({ x: t.x, y: t.y, z: t.z + dz }, true);
    car.rb.curP.z += dz;
    car.rb.prevP.z += dz;
    car.rb.sync();
  } else car.z += dz;
}

const r1 = (v) => Math.round(v * 10) / 10;

// a clear lane on the test ground: x = 170, from z = −160 to 150 (then shifted back by 300 m)
const LANE = { x: 170, z0: -160, wrapAt: 150, wrap: -300 };

function lane(game) {
  const car = game.car;
  car.teleport({ x: LANE.x, z: LANE.z0, yaw: 0 });
  for (let i = 0; i < 30; i++) game.step(DT); // settle on the springs
  return car;
}

function keepOnLane(car) {
  if (car.z > LANE.wrapAt) shiftZ(car, LANE.wrap);
}

/** Throttle / brake to hold speed v (m/s): a PI controller (its integral lives on inp). */
function hold(inp, car, v) {
  const e = v - car.vF;
  inp.i = Math.max(-1, Math.min(1, (inp.i || 0) + e * DT * 0.5));
  const u = e * 1.5 + inp.i;
  inp.throttle = Math.max(0, Math.min(1, u));
  inp.brake = u < -0.3 ? Math.min(1, -u * 0.3) : 0;
}

/** Hold speed v until it has been steady for 0.6 s (or 30 s passed), on the endless lane. */
async function reach(game, inp, car, v) {
  Object.assign(inp, idle(), { i: 0 });
  let stable = 0;
  await run(game, 30, () => {
    keepOnLane(car);
    if (v >= 34.9) inp.throttle = 1;
    else hold(inp, car, v);
    stable = Math.abs(car.vF - Math.min(v, 34.9)) < 0.3 ? stable + DT : 0;
    return stable < 0.6;
  });
  if (car.z > -110) shiftZ(car, -110 - car.z);
}

/** Test ground (`?map=test`): the handling numbers the README gives. */
export async function handling(game) {
  if (!game.test) throw new Error('handling(): open the test ground (?map=test)');
  const inp = takeOver(game);
  game.restart();
  const out = { phys: game.phys ? 'rapier' : 'old' };
  // the largest lean of the body through every manoeuvre below (only moves on Rapier)
  let maxLean = 0;
  const step = game.step.bind(game);
  game.step = (dt) => {
    step(dt);
    maxLean = Math.max(maxLean, Math.acos(Math.max(-1, Math.min(1, game.car.upY))) * DEG);
  };

  // acceleration from a standstill and top speed
  let car = lane(game);
  Object.assign(inp, idle(), { throttle: 1 });
  const marks = [1, 2, 3, 5, 9, 20];
  const accel = {};
  let t = 0;
  await run(game, 20.01, () => {
    keepOnLane(car);
    for (const m of marks) if (accel[m] == null && t >= m - 1e-6) accel[m] = r1(car.speed * KMH);
    t += DT;
  });
  out.accel = accel; // km/h after 1, 2, 3, 5, 9 s
  out.topSpeed = accel[20];

  // speedometer against real distance: at top speed, from the grid line z = −100 to z = 100 (200 m)
  let tA = null, tB = null, sum = 0, n = 0, zPrev = car.z;
  t = 0;
  await run(game, 40, () => {
    keepOnLane(car);
    if (tA == null && zPrev < -100 && car.z >= -100) tA = t - ((car.z + 100) / (car.z - zPrev)) * DT;
    if (tA != null && tB == null) {
      sum += car.speed * KMH;
      n++;
      if (zPrev < 100 && car.z >= 100) tB = t - ((car.z - 100) / (car.z - zPrev)) * DT;
    }
    zPrev = car.z;
    t += DT;
    return tB == null;
  });
  const real = (200 / (tB - tA)) * KMH;
  out.speedometer = { shown: r1(sum / n), real: r1(real), ratio: Math.round((sum / n / real) * 1000) / 1000 };

  // yaw rate on full lock at 40 / 60 / 100 / 125 km/h (README: ~120, 107, 69, 56 °/s)
  out.yaw = {};
  for (const kmh of [40, 60, 100, 125]) {
    car = lane(game);
    const v = kmh / KMH;
    await reach(game, inp, car, v);
    let best = 0, atV = 0;
    inp.steer = 1;
    await run(game, 0.8, () => {
      if (kmh >= 125) inp.throttle = 1;
      else hold(inp, car, v);
      if (Math.abs(car.angVel) > best) {
        best = Math.abs(car.angVel);
        atV = car.speed;
      }
    });
    out.yaw[kmh] = { degPerS: r1(best * DEG), atKmh: r1(atV * KMH) };
  }

  // handbrake: at 80 km/h, full lock with the handbrake for 0.6 s, then everything released — how long the car
  // keeps sliding sideways (|vR| above 1 m/s) and how far it turned
  car = lane(game);
  await reach(game, inp, car, 80 / KMH);
  const yaw0 = car.yaw;
  Object.assign(inp, idle(), { steer: 1, handbrake: true });
  let peakSlip = 0;
  await run(game, 0.6, () => {
    peakSlip = Math.max(peakSlip, Math.abs(car.vR));
  });
  Object.assign(inp, idle());
  let slideFor = null;
  t = 0;
  await run(game, 4, () => {
    peakSlip = Math.max(peakSlip, Math.abs(car.vR));
    if (slideFor == null && Math.abs(car.vR) < 1) slideFor = t;
    t += DT;
  });
  out.handbrake = { peakSlip: r1(peakSlip), slideAfterRelease: r1(slideFor ?? 4), turnedDeg: Math.round(Math.abs(car.yaw - yaw0) * DEG) };

  // the worst case for a lean: full lock with the handbrake at top speed, held for 1.5 s
  car = lane(game);
  await reach(game, inp, car, 35);
  Object.assign(inp, idle(), { steer: 1, handbrake: true });
  await run(game, 1.5);
  Object.assign(inp, idle());
  await run(game, 1.5);

  // reverse: brake held from a standstill
  car = lane(game);
  Object.assign(inp, idle(), { brake: 1 });
  car.teleport({ x: LANE.x, z: 140, yaw: 0 });
  let rev = 0;
  await run(game, 8, () => {
    rev = Math.min(rev, car.vF);
  });
  out.reverse = r1(-rev * KMH);
  out.maxLean = r1(maxLean);
  delete game.step;
  out.crashes = window.crash?.entries?.length ?? 0;
  return out;
}

/** An autopilot (the AUTOPILOT bot) for my own car. */
function autopilot(game) {
  const Rival = game.allRivals[0].constructor;
  const def = { name: 'ТЕСТ', color: '#b3121a', aggr: 0.1, gore: 0.12, speed: 0.95, corner: 12, lane: 0 };
  const ap = new Rival(game.scene, game.city, game.fx, game.audio, game.debris, game.quality, game.race, def, 0, game.car);
  ap.setZone(game.royale ? game.zone : null);
  return ap;
}

function soloRace(game, bots, seed) {
  if (game.test) throw new Error('open the city (no ?map=test)');
  takeOver(game);
  Math.random = seeded(seed);
  Object.assign(game.solo, { game: 'race', mode: 'classic', seat: 'driver', bots });
  game.restart();
  game.autoDriver = autopilot(game);
  // my car can't be wrecked: that would end the race (state 'over') and stop every bot
  game.car.applyDamage = () => {};
  // the countdown
  while (game.countdown > 0) game.step(DT);
}

/**
 * City: an 8-car race (`bots` + my car on autopilot) for `secs` s; the largest lean (angle of the body's up vector
 * from vertical) of every car, and how often a car was tipped past 30° and 60°.
 */
export async function leanRace(game, { secs = 75, bots = 7, seed = 1 } = {}) {
  const random = Math.random;
  soloRace(game, bots, seed);
  const stats = game.cars.map((c) => ({ name: c.name, max: 0, at: null, over30: 0, tipped: 0, wasTipped: false, wrecked: false }));
  let t = 0, hits = 0;
  const onHit = game.phys?.onCarHit;
  if (game.phys) {
    game.phys.onCarHit = (...a) => {
      if (a[2] > 4.5) hits++;
      onHit(...a);
    };
  }
  await run(game, secs, () => {
    game.cars.forEach((c, i) => {
      const s = stats[i];
      if (c.wrecked) {
        s.wrecked = true;
        return;
      }
      const lean = Math.acos(Math.max(-1, Math.min(1, c.upY))) * DEG;
      if (lean > s.max) {
        s.max = lean;
        s.at = { t: r1(t), x: r1(c.x), z: r1(c.z), kmh: r1(c.speed * KMH) };
      }
      if (lean > 30) s.over30 += DT;
      const tipped = lean > 60;
      if (tipped && !s.wasTipped) s.tipped++;
      s.wasTipped = tipped;
    });
    t += DT;
  });
  if (game.phys) game.phys.onCarHit = onHit;
  Math.random = random;
  return {
    phys: game.phys ? 'rapier' : 'old',
    secs,
    carHits: hits,
    cars: stats.map((s) => ({ name: s.name, maxLean: r1(s.max), at: s.at, over30s: r1(s.over30), tipped: s.tipped, wrecked: s.wrecked })),
    crashes: window.crash?.entries?.length ?? 0,
  };
}

/** City: `runs` seeded races of `secs` s; each bot's average speed (path length / time) and gates passed. */
export async function botLaps(game, { runs = 6, secs = 25, bots = 7 } = {}) {
  const random = Math.random;
  const res = [];
  for (let k = 0; k < runs; k++) {
    soloRace(game, bots, 1000 + k);
    const rivals = game.rivals;
    const last = rivals.map((r) => ({ x: r.car.x, z: r.car.z }));
    const dist = rivals.map(() => 0);
    let reverses = 0, respawns = 0, wasRev = rivals.map(() => false);
    const where = [];
    for (const r of rivals) {
      const orig = r.respawn;
      r.respawn = function () {
        respawns++;
        where.push([r.name, r1(r.car.x), r1(r.car.z)]);
        return orig.call(this);
      };
    }
    await run(game, secs, () => {
      rivals.forEach((r, i) => {
        const d = Math.hypot(r.car.x - last[i].x, r.car.z - last[i].z);
        if (d < 5) dist[i] += d; // a respawn jumps
        last[i] = { x: r.car.x, z: r.car.z };
        const rev = r.reverseT > 0;
        if (rev && !wasRev[i]) {
          reverses++;
          where.push([r.name, 'rev', r1(r.car.x), r1(r.car.z), r.mode]);
        }
        wasRev[i] = rev;
      });
    });
    for (const r of rivals) delete r.respawn;
    const avg = dist.reduce((a, b) => a + b, 0) / dist.length / secs;
    res.push({
      run: k,
      avgKmh: r1(avg * KMH),
      gates: rivals.reduce((a, r) => a + r.tr.passed, 0),
      perBot: rivals.map((r, i) => r1((dist[i] / secs) * KMH)),
      wrecked: rivals.filter((r) => r.car.wrecked).length,
      reverses,
      respawns,
      where,
    });
  }
  Math.random = random;
  const mean = (f) => r1(res.reduce((a, r) => a + f(r), 0) / res.length);
  return {
    phys: game.phys ? 'rapier' : 'old', runs: res, avgKmh: mean((r) => r.avgKmh), gatesPerRun: mean((r) => r.gates),
    reversesPerRun: mean((r) => r.reverses), respawnsPerRun: mean((r) => r.respawns), wreckedPerRun: mean((r) => r.wrecked), crashes: window.crash?.entries?.length ?? 0 };
}

/**
 * Test ground on Rapier: my car rams the side of a parked car at 40…125 km/h. The victim's largest lean, how fast
 * it was thrown, whether it ended on its wheels, the hit's closing speed and the ram damage.
 */
export async function sideHit(game, { speeds = [40, 60, 80, 100, 125] } = {}) {
  if (!game.test || !game.phys) throw new Error('sideHit(): open /?map=test');
  const inp = takeOver(game);
  game.restart();
  if (!game.dummies.length) game.addPhysDummies(1);
  const B = game.dummies[0], A = game.car;
  B.dummyInp = idle();
  const hits = [];
  const onHit = game.phys.onCarHit;
  game.phys.onCarHit = (...a) => {
    hits.push(r1(a[2] * KMH));
    onHit(...a);
  };
  const out = [];
  for (const kmh of speeds) {
    for (const c of [A, B]) {
      c.health = 100;
      c.wrecked = false;
    }
    B.teleport({ x: LANE.x, z: 60, yaw: Math.PI / 2 });
    A.teleport({ x: LANE.x, z: -120, yaw: 0 });
    Object.assign(inp, idle(), { i: 0 });
    await run(game, 0.3);
    hits.length = 0;
    await run(game, 30, () => {
      hold(inp, A, kmh / KMH);
      if (kmh >= 125) inp.throttle = 1;
      return A.z < 55;
    });
    const v0 = r1(A.speed * KMH);
    Object.assign(inp, idle());
    let lean = 0, thrown = 0, tipped = false;
    await run(game, 4, () => {
      const l = Math.acos(Math.max(-1, Math.min(1, B.upY))) * DEG;
      lean = Math.max(lean, l);
      thrown = Math.max(thrown, B.speed * KMH);
      if (l > 60) tipped = true;
    });
    out.push({ kmh: v0, closingKmh: hits[0] ?? 0, victimMaxLean: Math.round(lean), tipped, victimThrownKmh: Math.round(thrown), upright: B.upY > 0.9, victimHp: Math.round(B.health), ramHp: Math.round(A.health) });
  }
  game.phys.onCarHit = onHit;
  B.teleport({ x: -150, z: 150, yaw: 0 }); // off the lane the other tests use
  return out;
}

/**
 * Test ground: a bot-like driver (steer = 2.2 × bearing, ≤ 15 m/s, ≤ 10 m/s in sharp turns — as Rival.think) heads
 * for a point 10 m behind an obstacle it starts 15 m in front of, at lateral offsets −2…2 m and approach angles
 * 0…60°. Counts the runs where it gets stuck the way a bot would back up (under 1.5 m/s with throttle for 1.4 s).
 * kind: 'pole' (r 0.36), 'tree' (r 0.5) or 'wall' (a 20 m building face).
 */
export async function obstacle(game, { kind = 'pole', secs = 6 } = {}) {
  if (!game.test) throw new Error('obstacle(): open the test ground (?map=test)');
  const inp = takeOver(game);
  game.restart();
  const car = game.car;
  car.applyDamage = () => {}; // the old physics damages the car on the obstacle: a wreck would end the game
  const ox = 170, oz = 0;
  // the obstacle, added to the 2D world and (on Rapier) as a static collider
  if (!game._testObstacle) {
    const w = game.city.world;
    if (kind === 'wall') {
      w.addAABB(ox - 10, oz, ox + 10, oz + 2, { kind: 'building', h: 10 });
      game.phys?.addSolid({ kind: 'building', box: [ox, 5, oz + 1, 10, 5, 1] });
    } else {
      const r = kind === 'tree' ? 0.5 : 0.36;
      w.addCircle(ox, oz, r, { kind, h: 7 });
      game.phys?.addSolid({ kind, cyl: [ox, 3.5, oz, 3.5, r] });
    }
    game._testObstacle = kind;
  }
  const runs = [];
  for (const deg of [0, 20, 40, 60]) {
    for (const off of [-2, -1.2, -0.6, -0.2, 0.2, 0.6, 1.2, 2]) {
      const a = (deg * Math.PI) / 180;
      // start 15 m before the obstacle, coming in at angle a, aimed `off` m to its side
      const sx = ox + off * Math.cos(a) - Math.sin(a) * 15, sz = oz - 15 * Math.cos(a) - off * Math.sin(a);
      const tx = ox + off * Math.cos(a) + Math.sin(a) * 10, tz = oz + 10 * Math.cos(a) - off * Math.sin(a);
      car.teleport({ x: sx, z: sz, yaw: a });
      Object.assign(inp, idle());
      let stuckT = 0, worst = 0, reached = false;
      await run(game, secs, () => {
        const dx = tx - car.x, dz = tz - car.z;
        const s = Math.sin(car.yaw), c = Math.cos(car.yaw);
        const ang = Math.atan2(dx * -c + dz * s, dx * s + dz * c);
        inp.steer = Math.max(-1, Math.min(1, ang * 2.2));
        const vt = Math.abs(ang) > 0.6 ? 10 : 15;
        inp.throttle = car.speed < vt - 0.5 ? 1 : 0;
        inp.brake = car.speed > vt + 1.5 ? 1 : 0;
        if (car.speed < 1.5 && inp.throttle > 0) stuckT += DT;
        else stuckT = Math.max(0, stuckT - DT * 2);
        worst = Math.max(worst, stuckT);
        if (Math.hypot(dx, dz) < 3) reached = true;
        return !reached;
      });
      runs.push({ deg, off, stuck: worst > 1.4, reached });
    }
  }
  return {
    phys: game.phys ? 'rapier' : 'old',
    kind,
    stuck: runs.filter((r) => r.stuck).length,
    notReached: runs.filter((r) => !r.reached).length,
    of: runs.length,
    stuckRuns: runs.filter((r) => r.stuck).map((r) => `${r.deg}°/${r.off}`),
  };
}

/**
 * Test ground: glancing hits on the east boundary wall. The car runs north at `kmh` turned `deg`° towards the wall,
 * keeps going for 1 s after touching it, then steers away. Speed when it touches, when it leaves, and its heading.
 */
export async function wallScrape(game, { speeds = [60, 100], angles = [10, 25, 45] } = {}) {
  if (!game.test) throw new Error('wallScrape(): open the test ground (?map=test)');
  const inp = takeOver(game);
  game.restart();
  const car = game.car;
  car.applyDamage = () => {};
  const wallX = game.city.outer;
  const out = [];
  for (const kmh of speeds) {
    for (const deg of angles) {
      const a = (deg * Math.PI) / 180;
      Object.assign(inp, idle(), { i: 0 });
      // run-up with the car held straight: start further back, heading along the wall first, then turn into it
      car.teleport({ x: wallX - 4 - 25 * Math.sin(a), z: -120, yaw: 0 });
      await run(game, 20, () => {
        hold(inp, car, kmh / KMH);
        return car.z < 40 - 25 * Math.cos(a) - 30;
      });
      // point it at the wall keeping the speed
      const v = car.speed;
      car.teleport({ x: wallX - 4 - 25 * Math.sin(a), z: car.z, yaw: a });
      car.nudge(Math.sin(a) * v, Math.cos(a) * v);
      let touchV = null, touchT = null, leaveV = null, t = 0, maxX = 0, v03 = null, v1 = null;
      await run(game, 5, () => {
        const near = car.x > wallX - 2.1; // the body's half width is 1.1, a corner reaches further at an angle
        if (touchV == null && near) {
          touchV = car.speed;
          touchT = t;
        }
        if (touchT != null && v03 == null && t >= touchT + 0.3) v03 = car.speed;
        if (touchT != null && v1 == null && t >= touchT + 1) v1 = car.speed;
        if (touchT != null && t > touchT + 1) {
          inp.steer = 1; // right, away from the wall (east is the car's left)
          inp.throttle = 1;
          if (leaveV == null && car.x < wallX - 4) leaveV = car.speed;
        } else hold(inp, car, kmh / KMH);
        maxX = Math.max(maxX, car.x);
        t += DT;
      });
      out.push({ kmh, deg, touchKmh: r1((touchV ?? 0) * KMH), after03: r1((v03 ?? 0) * KMH), after1: r1((v1 ?? 0) * KMH), afterLeavingKmh: leaveV == null ? null : r1(leaveV * KMH), leftWall: leaveV != null, intoWallM: r1(maxX - wallX), up: r1(car.upY) });
    }
  }
  return { phys: game.phys ? 'rapier' : 'old', out };
}

/**
 * City: `races` seeded 8-car races of `secs` s (my car on autopilot). Every time a car tips past 60° (not wrecked):
 * the hardest car hit it took in the 1.5 s before (closing speed) and the shell blasts that shoved it.
 */
export async function rollovers(game, { races = 20, secs = 75, seed0 = 100 } = {}) {
  const random = Math.random;
  const tips = [];
  for (let k = 0; k < races; k++) {
    const seed = seed0 + k;
    soloRace(game, 7, seed);
    const shoves = [], hits = [];
    for (const c of game.cars) {
      const nudge = Object.getPrototypeOf(c).nudge;
      c.nudge = (a, b, w = 0) => {
        shoves.push({ t: game.race.clock, car: c, dv: Math.hypot(a, b) });
        nudge.call(c, a, b, w);
      };
      if (c.rb) {
        // on Rapier blasts go through Vehicle.blast, not nudge
        const blast = Object.getPrototypeOf(c.rb).blast;
        c.rb.blast = (x, y, z, dv) => {
          shoves.push({ t: game.race.clock, car: c, dv });
          blast.call(c.rb, x, y, z, dv);
        };
      }
    }
    const onHit = game.phys?.onCarHit;
    if (game.phys) {
      game.phys.onCarHit = (...a) => {
        onHit(...a);
        hits.push({ t: game.race.clock, a: a[0], b: a[1], kmh: a[2] * KMH });
      };
    }
    const was = new Map();
    await run(game, secs, () => {
      for (const c of game.cars) {
        const tipped = !c.wrecked && Math.acos(Math.max(-1, Math.min(1, c.upY))) * DEG > 60;
        if (tipped && !was.get(c)) {
          const T = game.race.clock;
          const hh = hits.filter((x) => (x.a === c || x.b === c) && x.t > T - 1.5);
          tips.push({
            seed, car: c.name, t: r1(T), maxHitKmh: r1(Math.max(0, ...hh.map((x) => x.kmh))),
            blasts: shoves.filter((s) => s.car === c && s.t > T - 1.5 && s.dv > 2).map((s) => r1(s.dv)),
          });
        }
        was.set(c, tipped);
      }
    });
    for (const c of game.cars) {
      delete c.nudge;
      if (c.rb) delete c.rb.blast;
    }
    if (game.phys) game.phys.onCarHit = onHit;
  }
  Math.random = random;
  return { phys: game.phys ? 'rapier' : 'old', races, tips: tips.length, perRace: r1(tips.length / races), list: tips };
}

/**
 * City (session 5): `runs` seeded games of `secs` s with `bots` bots — a race (`game: 'race'`, up to 7 bots) or a battle
 * royale (`'royale'`, up to 19), classic or crew (`mode: 'crew'`: bot gunners in every turret). My car runs on the
 * autopilot and can't be wrecked. Per run: the longest time any bot spent within 6 m of one spot while the game was on
 * (not wrecked, not finished), bots wrecked, pedestrians killed by bots, rams, shots, bot respawns and back-ups, tips
 * past 60° and how long the longest one lasted. A run stops early when the game ends (a bot wins or everyone is wrecked).
 * `each(t, rivals)` is called every step (for tracing one bot).
 */
export async function botBattles(game, { runs = 10, secs = 120, bots = 7, type = 'race', mode = 'classic', seed0 = 500, each = null } = {}) {
  if (game.test) throw new Error('open the city (no ?map=test)');
  const random = Math.random;
  const res = [];
  for (let k = 0; k < runs; k++) {
    takeOver(game);
    Math.random = seeded(seed0 + k);
    Object.assign(game.solo, { game: type, mode, seat: 'driver', bots });
    game.restart();
    game.autoDriver = autopilot(game);
    game.car.applyDamage = () => {};
    while (game.countdown > 0) game.step(DT);
    const rivals = game.rivals;
    const st = rivals.map((r) => ({ ax: r.car.x, az: r.car.z, still: 0, max: 0, at: null, tipT: 0, maxTip: 0, tips: 0 }));
    let respawns = 0, reverses = 0, rams = 0, shots = 0, t = 0;
    const wasRev = rivals.map(() => false);
    for (const r of rivals) {
      const orig = r.respawn;
      r.respawn = function () {
        respawns++;
        return orig.call(this);
      };
    }
    const carHit = game._carHit;
    game._carHit = function (...a) {
      if (a[2] > CAR_HIT_MIN) rams++;
      return carHit.apply(this, a);
    };
    const fire = game._fire;
    game._fire = function (c) {
      if (c.ai || c.botGunner) shots++;
      return fire.call(this, c);
    };
    const kills0 = rivals.reduce((a, r) => a + r.car.kills, 0);
    await run(game, secs, () => {
      if (game.state !== 'play') return false;
      each?.(t, rivals);
      rivals.forEach((r, i) => {
        const s = st[i], c = r.car;
        const rev = r.reverseT > 0;
        if (rev && !wasRev[i]) reverses++;
        wasRev[i] = rev;
        const lean = Math.acos(Math.max(-1, Math.min(1, c.upY))) * DEG;
        if (lean > 60 && !c.wrecked) {
          if (s.tipT === 0) s.tips++;
          s.tipT += DT;
          s.maxTip = Math.max(s.maxTip, s.tipT);
        } else s.tipT = 0;
        if (c.wrecked || r.tr.finished || Math.hypot(c.x - s.ax, c.z - s.az) > 6) {
          s.ax = c.x;
          s.az = c.z;
          s.still = 0;
          return;
        }
        s.still += DT;
        if (s.still > s.max) {
          s.max = s.still;
          s.at = { name: r.name, x: r1(c.x), z: r1(c.z), mode: r.mode, up: r1(c.upY), t: r1(t) };
        }
      });
      t += DT;
    });
    for (const r of rivals) delete r.respawn;
    delete game._fire;
    delete game._carHit;
    const worst = st.reduce((a, s) => (s.max > a.max ? s : a), st[0]);
    res.push({
      run: k, secs: r1(t), state: game.state, stuckMax: r1(worst.max), stuckAt: worst.at,
      wrecked: rivals.filter((r) => r.car.wrecked).length,
      kills: rivals.reduce((a, r) => a + r.car.kills, 0) - kills0,
      rams, shots, respawns, reverses,
      tips: st.reduce((a, s) => a + s.tips, 0), longestTip: r1(Math.max(...st.map((s) => s.maxTip))),
    });
  }
  Math.random = random;
  const mean = (f) => r1(res.reduce((a, r) => a + f(r), 0) / res.length);
  return {
    phys: game.phys ? 'rapier' : 'old', type, mode, bots, secs: mean((r) => r.secs),
    stuckMax: Math.max(...res.map((r) => r.stuckMax)), stuckOver10: res.filter((r) => r.stuckMax > 10).length,
    wrecked: mean((r) => r.wrecked), kills: mean((r) => r.kills), rams: mean((r) => r.rams), shots: mean((r) => r.shots),
    respawns: mean((r) => r.respawns), reverses: mean((r) => r.reverses), tips: mean((r) => r.tips),
    longestTip: Math.max(...res.map((r) => r.longestTip)), crashes: window.crash?.entries?.length ?? 0, runs: res,
  };
}
const CAR_HIT_MIN = 4.5; // CAR_HIT.threshold: a ram that does damage

// ---------------------------------------------------------------- session 3: damage, pedestrians, props, weapons

/** Fresh car at sp: full hull, every part on (the bull bar), standing still. */
function fresh(car, sp) {
  car.reset(sp);
  car.lastAttacker = null;
}

/** Bring car to v m/s along its heading at once and hold it (inp — its input) while each() returns true. */
async function drive(game, inp, car, v, secs, each) {
  car.nudge(Math.sin(car.yaw) * v, Math.cos(car.yaw) * v);
  Object.assign(inp, idle(), { i: 0 });
  await run(game, secs, (t) => {
    hold(inp, car, v);
    if (v >= 34.9) inp.throttle = 1;
    return each ? each(t) : true;
  });
}

const lost = (car) => r1(100 - car.health);

/**
 * Test ground: nose first into the east boundary wall (with and without the bull bar) and into a pole, at
 * 25…125 km/h — the hull lost (README: nothing below ~29 km/h, about 45% at 100 km/h, poles ×1.15, the bull bar's
 * front armour ×0.75). Both physics paths.
 */
export async function wallDamage(game, { speeds = [25, 30, 40, 60, 80, 100, 125] } = {}) {
  if (!game.test) throw new Error('wallDamage(): open the test ground (?map=test)');
  const inp = takeOver(game);
  game.restart();
  const car = game.car;
  const wallX = game.city.outer;
  const pole = { x: 170, z: 100 };
  if (!game._testPole) {
    game.city.world.addCircle(pole.x, pole.z, 0.36, { kind: 'pole', h: 7 });
    game.phys?.addSolid({ kind: 'pole', cyl: [pole.x, 3.5, pole.z, 3.5, 0.36] });
    game._testPole = true;
  }
  const bar = () => car.parts.find((p) => p.kind === 'front');
  const out = [];
  for (const kmh of speeds) {
    const row = { kmh };
    for (const what of ['wall', 'noBar', 'pole']) {
      if (what === 'pole') fresh(car, { x: pole.x, z: pole.z - 25, yaw: 0 });
      else fresh(car, { x: wallX - 25, z: 140, yaw: Math.PI / 2 });
      if (what === 'noBar') bar().detached = true;
      await run(game, 0.2);
      await drive(game, inp, car, kmh / KMH, 3, () => (what === 'pole' ? car.z < pole.z - 2.6 : car.x < wallX - 2.6));
      Object.assign(inp, idle());
      await run(game, 0.6);
      row[what] = lost(car);
      bar().detached = false;
    }
    out.push(row);
  }
  fresh(car, game.city.spawn);
  return { phys: game.phys ? 'rapier' : 'old', crashes: window.crash?.entries?.length ?? 0, out };
}

/**
 * Test ground on Rapier: the car dropped level on its wheels, and upside down on its roof, from heights that give
 * `speeds` m/s at touchdown — the hull lost (wheels: VEH.landScale per m/s above landSafe; roof: roofScale above
 * roofSafe).
 */
export async function landings(game, { speeds = [8, 12, 14, 16, 20, 24] } = {}) {
  if (!game.test || !game.phys) throw new Error('landings(): open /?map=test');
  takeOver(game);
  game.restart();
  const car = game.car, g = -game.phys.world.gravity.y;
  const out = [];
  for (const v of speeds) {
    const h = (v * v) / (2 * g);
    const row = { impact: v, dropM: r1(h) };
    for (const roof of [false, true]) {
      fresh(car, { x: 170, z: 0, yaw: 0 });
      const b = car.rb.body;
      // the wheels' bottom (or the roof, 1.7 m above the origin when upside down) falls h
      b.setTranslation({ x: 170, y: roof ? h + 1.72 : h + 0.02, z: 0 }, true);
      if (roof) b.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true);
      car.rb.afterStep();
      car.rb.prevP.copy(car.rb.curP);
      car.rb.prevQ.copy(car.rb.curQ);
      car.rb.airT = 1;
      let maxV = 0;
      await run(game, 1.6, () => {
        maxV = Math.max(maxV, -car.vy);
      });
      row[roof ? 'roof' : 'wheels'] = lost(car);
      row[roof ? 'roofV' : 'wheelsV'] = r1(maxV);
    }
    out.push(row);
  }
  fresh(car, game.city.spawn);
  return { crashes: window.crash?.entries?.length ?? 0, out };
}

/**
 * Test ground on Rapier: my car into another one. Head-on (100 vs 80 km/h), catching up (55 into one doing 50), a
 * T-bone (60 into a parked car's side), a side swipe (60 and 60, 15° apart). Closing speed and the hull each lost.
 */
export async function carCrashes(game) {
  if (!game.test || !game.phys) throw new Error('carCrashes(): open /?map=test');
  const inp = takeOver(game);
  game.restart();
  if (!game.dummies.length) game.addPhysDummies(1);
  const B = game.dummies[0], A = game.car;
  const hits = [];
  const onHit = game.phys.onCarHit;
  game.phys.onCarHit = (...a) => {
    hits.push(r1(a[2] * KMH));
    onHit(...a);
  };
  const cases = [
    { name: 'head-on 100 vs 80', a: [170, -60, 0, 100], b: [170, 0, Math.PI, 80] },
    { name: 'catch-up 55 into 50', a: [170, -67, 0, 55], b: [170, -60, 0, 50] },
    { name: 'T-bone 60 into parked', a: [170, -60, 0, 60], b: [170, -30, Math.PI / 2, 0] },
    { name: 'side swipe 60/60 at 15°', a: [168, -60, 0.13, 60], b: [174, -60, -0.13, 60] },
  ];
  const out = [];
  for (const c of cases) {
    fresh(A, { x: c.a[0], z: c.a[1], yaw: c.a[2] });
    fresh(B, { x: c.b[0], z: c.b[1], yaw: c.b[2] });
    B.dummyInp = idle();
    await run(game, 0.2);
    hits.length = 0;
    B.nudge(Math.sin(B.yaw) * (c.b[3] / KMH), Math.cos(B.yaw) * (c.b[3] / KMH));
    await drive(game, inp, A, c.a[3] / KMH, 6, () => {
      if (c.b[3]) hold(B.dummyInp, B, c.b[3] / KMH);
      return !hits.length;
    });
    Object.assign(inp, idle());
    B.dummyInp = idle();
    await run(game, 1);
    out.push({ case: c.name, closingKmh: hits[0] ?? 0, mine: lost(A), other: lost(B) });
  }
  game.phys.onCarHit = onHit;
  B.teleport({ x: -150, z: 150, yaw: 0 });
  return { crashes: window.crash?.entries?.length ?? 0, out };
}

/**
 * Test ground on Rapier: a shell's blast by a parked car's left side, 0…3 m from it, y m up (0.9 — the body's middle;
 * 1.96 — a level shot's height),
 * and a direct hit there. The car's largest lean, how fast it was thrown, the hull lost, did it tip over.
 */
export async function blasts(game, { gaps = [0, 1, 2, 3], y = 0.9 } = {}) {
  if (!game.test || !game.phys) throw new Error('blasts(): open /?map=test');
  takeOver(game);
  game.restart();
  if (!game.dummies.length) game.addPhysDummies(1);
  const B = game.dummies[0];
  B.dummyInp = idle();
  const out = [];
  for (const direct of [false, true]) {
    for (const gap of direct ? [0] : gaps) {
      fresh(B, { x: 170, z: 0, yaw: 0 });
      await run(game, 0.3);
      const cars = game.artillery.cars;
      game.artillery.cars = [B]; // the dummies aren't in the race
      game.artillery.blast(170 + 1.1 + gap, B.y + y, 0, game.car, direct ? B : null);
      game.artillery.cars = cars;
      let lean = 0, thrown = 0;
      await run(game, 3, () => {
        lean = Math.max(lean, Math.acos(Math.max(-1, Math.min(1, B.upY))) * DEG);
        thrown = Math.max(thrown, B.speed * KMH);
      });
      out.push({ direct, gapM: gap, maxLeanDeg: Math.round(lean), thrownKmh: r1(thrown), hull: lost(B), tipped: lean > 60 });
    }
  }
  B.teleport({ x: -150, z: 150, yaw: 0 });
  return { crashes: window.crash?.entries?.length ?? 0, out };
}

/** Count the pedestrians my car hits (kills and knock-downs) while fn runs. */
async function pedHits(game, fn) {
  const peds = game.peds, onKill = peds.onKill, onEvent = peds.onEvent;
  const hit = [];
  peds.onKill = (p, cause, s) => {
    hit.push({ x: r1(p.x), z: r1(p.z), cause, kmh: r1(s * KMH) });
    onKill(p, cause, s);
  };
  peds.onEvent = (type, p) => {
    if (type === 'knock') hit.push({ x: r1(p.x), z: r1(p.z), cause: 'knock' });
    onEvent(type, p);
  };
  try {
    await fn();
  } finally {
    peds.onKill = onKill;
    peds.onEvent = onEvent;
  }
  return hit;
}

/**
 * Test ground: pedestrians against the car's box. Off the big ramp straight at the line of 50 (z = 0), starting at
 * 90…180 km/h (above top speed only to fly far enough): the speed at the lip, the car's height over the line and who
 * it hits; through the line on the flat; up the deck's ramp onto
 * the deck (its eight pedestrians); along the tube under a pedestrian standing on its roof.
 */
export async function pedJumps(game, { speeds = [90, 120, 140, 160, 180] } = {}) {
  if (!game.test) throw new Error('pedJumps(): open the test ground (?map=test)');
  const inp = takeOver(game);
  const car = game.car;
  const out = [];
  const runs = [
    ...speeds.map((k) => ({ name: `big ramp ${k}`, kmh: k, x: -15, z: -100, to: 25, lineZ: 0 })),
    { name: 'line on the flat 60', kmh: 60, x: 21, z: -40, to: 10, lineZ: 0 },
    { name: 'deck ramp 60', kmh: 60, x: 117, z: 10, to: 108 },
    { name: 'tube 60 (one standing on its roof)', kmh: 60, x: -130, z: -90, to: 60, tube: true },
    { name: 'on the tube roof 60 (the same one)', kmh: 60, x: -130, z: -25, to: 30, tube: true },
  ];
  for (const r of runs) {
    game.restart();
    car.applyDamage = () => {};
    if (r.tube) {
      // the molotov thrower, moved over the middle of the tunnel
      const p = game.peds.peds.find((q) => q.molotov) ?? game.peds.peds[0];
      p.x = -130;
      p.z = 10;
    }
    fresh(car, { x: r.x, z: r.z, yaw: 0 });
    await run(game, 0.3);
    let yAt = null, minY = 0, lip = null;
    const hit = await pedHits(game, () =>
      drive(game, inp, car, r.kmh / KMH, 8, () => {
        if (r.lineZ != null && yAt == null && car.z > r.lineZ) yAt = r1(car.y - game.city.groundHeight(car.x, car.z));
        if (r.lineZ != null && r.x === -15 && car.z > -31) Object.assign(inp, idle()); // let go at the lip
        if (r.tube) minY = Math.min(minY, car.y);
        if (lip == null && car.z > -31) lip = r1(car.speed * KMH);
        return car.z < r.to;
      }),
    );
    delete car.applyDamage;
    out.push({ run: r.name, lipKmh: r.x === -15 ? lip : undefined, heightOverLine: yAt, lowestY: r.tube ? r1(minY) : undefined, endZ: r1(car.z), hits: hit.length, causes: [...new Set(hit.map((h) => h.cause))].join(','), at: hit.slice(0, 4) });
  }
  return { phys: game.phys ? 'rapier' : 'old', crashes: window.crash?.entries?.length ?? 0, out };
}

/**
 * Test ground: the row of street props (z = −75, x = 15…59). Into a lamp, a bin, a bench at 40 km/h on the ground;
 * over a bin in the air (dropped from 2.5 m, 20 m/s). Broken or not, and the speed lost.
 */
export async function props(game) {
  if (!game.test) throw new Error('props(): open the test ground (?map=test)');
  const inp = takeOver(game);
  const car = game.car, items = game.breakables.items;
  const out = [];
  for (const [name, x, air] of [['lamp', 15, false], ['bin', 19, false], ['bench', 27, false], ['bin in the air', 43, true]]) {
    if (air && !game.phys) continue;
    game.restart();
    const it = items.find((q) => Math.abs(q.x - x) < 0.1 && Math.abs(q.z + 75) < 0.1);
    fresh(car, { x, z: air ? -78.5 : -90, yaw: 0 });
    await run(game, 0.2);
    let v0 = 0, v1 = 0;
    if (air) {
      const b = car.rb.body;
      b.setTranslation({ x, y: 2.5, z: -78.5 }, true);
      car.rb.afterStep();
      car.rb.prevP.copy(car.rb.curP);
      car.nudge(0, 20);
      v0 = 20;
      await run(game, 0.4);
      v1 = car.speed;
    } else {
      await drive(game, inp, car, 40 / KMH, 3, () => car.z < -79);
      v0 = car.speed;
      Object.assign(inp, idle());
      await run(game, 0.35);
      v1 = car.speed;
    }
    out.push({ prop: name, type: it?.type, broken: !it?.alive, kmhBefore: r1(v0 * KMH), kmhAfter: r1(v1 * KMH) });
  }
  return { phys: game.phys ? 'rapier' : 'old', crashes: window.crash?.entries?.length ?? 0, out };
}

/**
 * Test ground on Rapier: where a tilted car fires. The car pitched nose-up 2°, 10°, 30°, rolled 90° (on its side),
 * upside down: the muzzle's height and the shell's slope; and a level shot from 40 m into a parked car.
 */
export async function muzzle(game) {
  if (!game.test || !game.phys) throw new Error('muzzle(): open /?map=test');
  takeOver(game);
  game.restart();
  const car = game.car, rb = car.rb;
  const out = [];
  const Q = rb.quat.constructor;
  const ax = (x, y, z, deg) => new Q().setFromAxisAngle({ x, y, z, isVector3: true }, (deg * Math.PI) / 180);
  for (const [name, q] of [['level', ax(1, 0, 0, 0)], ['nose up 2°', ax(1, 0, 0, -2)], ['nose up 10°', ax(1, 0, 0, -10)], ['nose up 30°', ax(1, 0, 0, -30)], ['on its side', ax(0, 0, 1, 90)], ['upside down', ax(0, 0, 1, 180)]]) {
    fresh(car, { x: 170, z: 0, yaw: 0 });
    rb.quat.copy(q);
    const m = car.muzzle();
    out.push({ pose: name, y: r1(m.y), slopeDeg: r1(Math.asin(m.dy) * DEG), dx: r1(m.dx), dz: r1(m.dz) });
  }
  fresh(car, game.city.spawn);
  return out;
}

/**
 * Test ground on Rapier (session 5): the bot gunner and the machine gun's auto-aim on a tilted car. The car is posed
 * (level, nose up 13° as across the big ramp, rolled 30°, on its side, on its roof) facing +z, a target 30 m away at
 * bearings 0 / 45 / 270 / 200°; the gunner turns for 3 s. Per case: the barrel's heading error from the target's bearing
 * (`err`), whether the gunner fired, and what the old yaw-only arithmetic would have pointed at (`oldErr`).
 */
export async function gunnerTilt(game, { gunner = null } = {}) {
  if (!game.test || !game.phys) throw new Error('gunnerTilt(): open /?map=test');
  takeOver(game);
  game.restart();
  const BotGunner = gunner ?? (await import('/src/gunner.js')).BotGunner;
  const car = game.car, rb = car.rb;
  const Q = rb.quat.constructor;
  const ax = (x, y, z, deg) => new Q().setFromAxisAngle({ x, y, z, isVector3: true }, (deg * Math.PI) / 180);
  const heading = () => {
    const m = car.muzzle();
    return Math.atan2(m.dx, m.dz);
  };
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const out = [];
  for (const [pose, q] of [['level', ax(1, 0, 0, 0)], ['nose up 13°', ax(1, 0, 0, -13)], ['rolled 30°', ax(0, 0, 1, 30)], ['on its side', ax(0, 0, 1, 90)], ['on its roof', ax(0, 0, 1, 180)]]) {
    for (const deg of [0, 45, 270, 200]) {
      fresh(car, { x: 170, z: 0, yaw: 0 });
      rb.quat.copy(q);
      car.turretYaw = 0;
      const b = (deg * Math.PI) / 180;
      const T = { isCar: true, name: 'T', y: 0, x: car.x + Math.sin(b) * 30, z: car.z + Math.cos(b) * 30, vx: 0, vz: 0, wrecked: false, team: null };
      const g = new BotGunner(car, game.city.world, 0);
      g.errT = 1e9; // no aiming error
      g.pause = 0;
      car.reload = 0;
      let fired = false;
      for (let i = 0; i < 180; i++) if (g.update(DT, { cars: [car, T], peds: null, shellSpeed: 60 })) fired = true;
      const err = wrap(heading() - b) * DEG;
      // the old arithmetic: the turret at (bearing − yaw) as if the car stood level
      const t0 = car.turretYaw;
      car.turretYaw = wrap(b - car.yaw);
      const oldErr = wrap(heading() - b) * DEG;
      car.turretYaw = t0;
      out.push({ pose, bearing: deg, target: g.target === T, err: r1(err), fired, oldErr: r1(oldErr), slope: r1(Math.asin(car.muzzle().dy) * DEG) });
    }
  }
  // the machine gun's auto-aim (classic): rolled 30°, a target at 20°
  fresh(car, { x: 170, z: 0, yaw: 0 });
  rb.quat.copy(ax(0, 0, 1, 30));
  car.turretYaw = 0;
  const b = (20 * Math.PI) / 180;
  const T = { isCar: true, x: car.x + Math.sin(b) * 20, z: car.z + Math.cos(b) * 20, wrecked: false, team: null };
  car.mgRetarget = 1e9;
  car.mgTarget = T;
  for (let i = 0; i < 120; i++) game.mg.autoAim(car, [car], DT);
  out.push({ pose: 'mg, rolled 30°', bearing: 20, err: r1(wrap(heading() - b) * DEG) });
  fresh(car, game.city.spawn);
  return out;
}
