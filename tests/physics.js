/**
 * In-browser physics measurements (PHYSICS_PLAN.md, session 2). Not part of the game build: load it into a running
 * dev server page and call the functions with the game, e.g. in the console of `/?mute&map=test&phys=rapier`:
 *
 *   const t = await import('/tests/physics.js');
 *   await t.handling(game);             // test ground: top speed, acceleration, yaw rates, handbrake, reverse, speedometer
 *   await t.leanRace(game, { secs: 75 }); // city: max lean of every car in an 8-car race
 *   await t.botLaps(game, { runs: 6 });   // city: bots' average speed, 6 seeded runs of 25 s
 *
 * Run the same calls without `phys=rapier` to get the old physics' numbers. The functions stop the page's own
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
  if (!game.test || !game.phys) throw new Error('sideHit(): open /?map=test&phys=rapier');
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
    for (const c of game.cars) delete c.nudge;
    if (game.phys) game.phys.onCarHit = onHit;
  }
  Math.random = random;
  return { phys: game.phys ? 'rapier' : 'old', races, tips: tips.length, perRace: r1(tips.length / races), list: tips };
}
