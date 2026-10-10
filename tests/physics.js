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
 *   await t.traps(game);                // city: scripted traps — does a stuck bot get out, when is it teleported (NAV_PLAN 1)
 *   await t.navGrid(game);              // city or test ground: the nav grid's build time, size, layers; 3D checks (NAV_PLAN 2)
 *   await t.frameCost(game);            // city: game.step's cost with 19 bots, the bots' share, path searches (NAV_PLAN 3)
 *   await t.waypoints(game);            // city: battle royale waypoints in yards — do bots get there (NAV_PLAN 3)
 *   await t.testGround(game);           // test ground with bots (?map=test&bots=7): ramps, deck, tube used (NAV_PLAN 4)
 *   await t.featureRuns(game);          // test ground with bots: one bot over each feature, 5 starts (NAV_PLAN 4)
 *   await t.botTrace(game, { start: [115, 6.3, 82, 0, 15], goal: [-60, 0, 150] }); // one bot's drive, frame by frame
 *   // also: landings, carCrashes, blasts, pedJumps, props, muzzle (session 3), sideHit, obstacle, wallScrape, rollovers,
 *   // gunnerTilt (session 5), pedShots, rocking, molotovs, tyreMarks (the open problems' fixes)
 *
 * Rapier is the only car physics since session 5 (the old 2D physics was deleted in session 6); the "old physics"
 * numbers in PHYSICS_PLAN.md were measured before that. The functions stop the page's own
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
  const b = car.rb.body, t = b.translation();
  b.setTranslation({ x: t.x, y: t.y, z: t.z + dz }, true);
  car.rb.curP.z += dz;
  car.rb.prevP.z += dz;
  car.rb.sync();
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
  const out = {};
  // the largest lean of the body through every manoeuvre below
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
  const onHit = game.phys.onCarHit;
  game.phys.onCarHit = (...a) => {
    if (a[2] > 4.5) hits++;
    onHit(...a);
  };
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
  game.phys.onCarHit = onHit;
  Math.random = random;
  return {
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
    runs: res, avgKmh: mean((r) => r.avgKmh), gatesPerRun: mean((r) => r.gates),
    reversesPerRun: mean((r) => r.reverses), respawnsPerRun: mean((r) => r.respawns), wreckedPerRun: mean((r) => r.wrecked), crashes: window.crash?.entries?.length ?? 0 };
}

/**
 * Test ground: my car rams the side of a parked car at 40…125 km/h. The victim's largest lean, how fast
 * it was thrown, whether it ended on its wheels, the hit's closing speed and the ram damage.
 */
export async function sideHit(game, { speeds = [40, 60, 80, 100, 125] } = {}) {
  if (!game.test) throw new Error('sideHit(): open /?map=test');
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
  car.applyDamage = () => {}; // a wreck on the obstacle would end the game
  const ox = 170, oz = 0;
  // the obstacle, added to the 2D world (for the bots' line of sight) and as a static collider
  if (!game._testObstacle) {
    const w = game.city.world;
    if (kind === 'wall') {
      w.addAABB(ox - 10, oz, ox + 10, oz + 2, { kind: 'building', h: 10 });
      game.phys.addSolid({ kind: 'building', box: [ox, 5, oz + 1, 10, 5, 1] });
    } else {
      const r = kind === 'tree' ? 0.5 : 0.36;
      w.addCircle(ox, oz, r, { kind, h: 7 });
      game.phys.addSolid({ kind, cyl: [ox, 3.5, oz, 3.5, r] });
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
  return { out };
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
      // blasts go through Vehicle.blast, not nudge
      const blast = Object.getPrototypeOf(c.rb).blast;
      c.rb.blast = (x, y, z, dv) => {
        shoves.push({ t: game.race.clock, car: c, dv });
        blast.call(c.rb, x, y, z, dv);
      };
    }
    const onHit = game.phys.onCarHit;
    game.phys.onCarHit = (...a) => {
      onHit(...a);
      hits.push({ t: game.race.clock, a: a[0], b: a[1], kmh: a[2] * KMH });
    };
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
      delete c.rb.blast;
    }
    game.phys.onCarHit = onHit;
  }
  Math.random = random;
  return { races, tips: tips.length, perRace: r1(tips.length / races), list: tips };
}

/**
 * City (session 5): `runs` seeded games of `secs` s with `bots` bots — a race (`game: 'race'`, up to 7 bots) or a battle
 * royale (`'royale'`, up to 19), classic or crew (`mode: 'crew'`: bot gunners in every turret). My car runs on the
 * autopilot and can't be wrecked. Per run: the longest time any bot spent within 6 m of one spot while the game was on
 * (not wrecked, not finished) — and the same not counting rams of the car it hunts within 15 m (`stuckNoRam`, as the
 * STUCK rule) —, bots wrecked, pedestrians killed by bots, rams, shots, bot teleports (Rival.respawn) and
 * back-ups, tips
 * past 60° and how long the longest one lasted (tips over LONG_TIP s traced every 0.5 s in `longTips`). A run stops early when the game ends (a bot wins or everyone is wrecked).
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
    const st = rivals.map((r) => ({ ax: r.car.x, az: r.car.z, still: 0, max: 0, at: null, still2: 0, max2: 0, at2: null, tipT: 0, maxTip: 0, tips: 0 }));
    let teleports = 0, reverses = 0, rams = 0, shots = 0, t = 0;
    const longTips = [];
    const wasRev = rivals.map(() => false);
    for (const r of rivals) {
      const orig = r.respawn;
      r.respawn = function () {
        teleports++;
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
          if (s.tipT === 0) (s.tips++, (s.trace = []));
          s.tipT += DT;
          s.maxTip = Math.max(s.maxTip, s.tipT);
          // a long tip: what the car does every 0.5 s from 4 s on (kept if it lasts over LONG_TIP s)
          if (s.tipT > 4 && Math.round(s.tipT / DT) % 30 === 0) s.trace.push(tipSample(game, r, s.tipT, t));
        } else {
          if (s.tipT > LONG_TIP) longTips.push({ run: k, name: r.name, secs: r1(s.tipT), trace: s.trace });
          s.tipT = 0;
        }
        if (c.wrecked || r.tr.finished || Math.hypot(c.x - s.ax, c.z - s.az) > 6) {
          s.ax = c.x;
          s.az = c.z;
          s.still = 0;
          s.still2 = 0;
          return;
        }
        s.still += DT;
        if (s.still > s.max) {
          s.max = s.still;
          s.at = { name: r.name, x: r1(c.x), z: r1(c.z), mode: r.mode, up: r1(c.upY), t: r1(t) };
        }
        // the same, not counting the time it rams the car it hunts within STUCK.ram (15 m), as the STUCK rule doesn't
        if (!(r.mode === 'hunt' && r.target && Math.hypot(r.target.x - c.x, r.target.z - c.z) < 15)) s.still2 += DT;
        if (s.still2 > s.max2) {
          s.max2 = s.still2;
          s.at2 = { name: r.name, x: r1(c.x), z: r1(c.z), mode: r.mode, t: r1(t) };
        }
      });
      t += DT;
    });
    for (const r of rivals) delete r.respawn;
    const uturns = rivals.reduce((a, r) => a + r.uturns, 0);
    delete game._fire;
    delete game._carHit;
    const worst = st.reduce((a, s) => (s.max > a.max ? s : a), st[0]);
    const worst2 = st.reduce((a, s) => (s.max2 > a.max2 ? s : a), st[0]);
    res.push({
      run: k, secs: r1(t), state: game.state, stuckMax: r1(worst.max), stuckAt: worst.at, stuckNoRam: r1(worst2.max2), stuckNoRamAt: worst2.at2,
      wrecked: rivals.filter((r) => r.car.wrecked).length,
      kills: rivals.reduce((a, r) => a + r.car.kills, 0) - kills0,
      rams, shots, teleports, reverses, uturns,
      tips: st.reduce((a, s) => a + s.tips, 0), longestTip: r1(Math.max(...st.map((s) => s.maxTip))),
      longTips: [...longTips, ...st.filter((s) => s.tipT > LONG_TIP).map((s, i) => ({ run: k, name: 'still tipped at the end', secs: r1(s.tipT), trace: s.trace }))],
    });
  }
  Math.random = random;
  const mean = (f) => r1(res.reduce((a, r) => a + f(r), 0) / res.length);
  return {
    type, mode, bots, secs: mean((r) => r.secs),
    stuckMax: Math.max(...res.map((r) => r.stuckMax)), stuckOver10: res.filter((r) => r.stuckMax > 10).length,
    stuckNoRam: Math.max(...res.map((r) => r.stuckNoRam)), stuckNoRamOver10: res.filter((r) => r.stuckNoRam > 10).length,
    wrecked: mean((r) => r.wrecked), kills: mean((r) => r.kills), rams: mean((r) => r.rams), shots: mean((r) => r.shots),
    teleports: mean((r) => r.teleports), reverses: mean((r) => r.reverses), uturns: mean((r) => r.uturns), tips: mean((r) => r.tips),
    longestTip: Math.max(...res.map((r) => r.longestTip)), longTips: res.flatMap((r) => r.longTips), crashes: window.crash?.entries?.length ?? 0, runs: res,
  };
}
const CAR_HIT_MIN = 4.5; // CAR_HIT.threshold: a ram that does damage
const LONG_TIP = 6; // s tipped past 60° that botBattles() reports in detail (longTips)

/** A tipped bot's state for botBattles()' longTips: speed, spin, the flip rule's clock, what it touches. */
function tipSample(game, r, tipT, t) {
  const c = r.car, b = c.rb, lv = b.body.linvel(), av = b.body.angvel();
  return {
    t: r1(t), tip: r1(tipT), x: r1(c.x), y: Math.round(c.y * 100) / 100, z: r1(c.z), up: Math.round(c.upY * 100) / 100,
    v: Math.round(Math.hypot(lv.x, lv.y, lv.z) * 100) / 100, w: Math.round(Math.hypot(av.x, av.y, av.z) * 100) / 100,
    righting: b.righting ? r1(b.righting.t) : null, tippedT: Math.round((b.tippedT ?? 0) * 100) / 100, wheels: b.contacts,
    statics: [...b.statics.values()].map((q) => q[2]),
    cars: game.cars.filter((o) => o !== c && Math.hypot(o.x - c.x, o.z - c.z) < 6).map((o) => `${o.wrecked ? 'wreck' : 'car'} ${r1(Math.hypot(o.x - c.x, o.z - c.z))}`),
  };
}

// ---------------------------------------------------------------- NAV_PLAN session 1: getting out of traps

/**
 * Scripted traps (city, NAV_PLAN session 1). One bot, its race target swapped for a fixed `goal` behind the trap, and
 * other bots wrecked and parked as obstacles (`wrecks`: [x, z, yaw]). Per trap and seed: when it first got 8 m
 * from where it started (`out`, s; null — never), the legs of its escapes backwards and forwards, teleports, the longest it then stayed
 * within 6 m of one spot (not at the goal), and for a teleport where it went: distance, the nearest car there, the drop height.
 * `teleport` — not a trap: the bot's teleport called directly next to a crowd of parked cars.
 */
export const TRAPS = {
  // nose between a building's corner (x ≤ 44.7, z ≤ 165) and a tree (46.5, 166.5); the goal straight on past them
  treeBuilding: { at: [45.2, 169.6, Math.PI], goal: [45.5, 120], wrecks: [] },
  // on a street, nose against a wreck, another wreck along its left side: out the right way
  wreckSide: { at: [60, 150, Math.PI], goal: [60, 80], wrecks: [[60, 145.2, Math.PI / 2], [62.6, 150.5, Math.PI]] },
  // nose against a building (north face z = 165), a wreck along each side: back out, then around
  boxed: { at: [40, 167.6, Math.PI], goal: [40, 120], wrecks: [[37.6, 167.8, Math.PI], [42.4, 167.8, Math.PI]] },
  // … and a wreck across its tail too: pushing the wrecks or the 20 s teleport
  caged: { at: [40, 167.6, Math.PI], goal: [40, 120], wrecks: [[37.6, 167.8, Math.PI], [42.4, 167.8, Math.PI], [40, 172.4, Math.PI / 2]] },
  // caged by wrecks that can't be pushed (pinned in place): only the 20 s teleport gets it out
  pinned: { at: [40, 167.6, Math.PI], goal: [40, 120], pin: true, wrecks: [[37.7, 167.8, Math.PI], [42.3, 167.8, Math.PI], [40, 171.5, Math.PI / 2]] },
  // in a 6.5 m alley between two buildings (z 146.5…153), nose against the south one: a many-point turn
  alley: { at: [37.5, 148.6, Math.PI], goal: [30, 125], wrecks: [] },
  teleport: { at: [0, 100, 0], goal: [0, 160], wrecks: [[0, 108, 0], [6, 100, 0], [-6, 100, 0], [0, 92, 0], [3, 120, 0], [-3, 82, 0]] },
};

export async function traps(game, { names = Object.keys(TRAPS), seeds = [0, 1, 2, 3, 4], secs = 30 } = {}) {
  if (game.test) throw new Error('open the city (no ?map=test)');
  const random = Math.random;
  const out = [];
  for (const name of names) {
    for (const seed of seeds) {
      const T = TRAPS[name];
      const inp = takeOver(game);
      Math.random = seeded(seed);
      Object.assign(game.solo, { game: 'race', mode: 'classic', seat: 'driver', bots: Math.max(1, T.wrecks.length + 1) });
      game.restart();
      game.car.applyDamage = () => {};
      Object.assign(inp, idle(), { brake: 1 });
      while (game.countdown > 0) game.step(DT);
      game.car.teleport({ x: -150, z: -175, yaw: 0 }); // me: parked out of the way
      const [bot, ...rest] = game.rivals;
      bot.def = { ...bot.def, aggr: 0, gore: 0 }; // only drives
      const goal = { x: T.goal[0], z: T.goal[1] };
      bot._raceGoal = () => ({ x: goal.x, y: 0, z: goal.z, gate: null }); // drives to the goal, not to a gate
      T.wrecks.forEach(([x, z, yaw], i) => {
        const c = rest[i].car;
        c.explode();
        c.teleport({ x, z, yaw });
      });
      game.step(DT);
      if (T.pin) T.wrecks.forEach((_, i) => {
        const b = rest[i].car.rb.body;
        b.lockTranslations(true, true);
        b.lockRotations(true, true);
      });
      for (const r of rest.slice(T.wrecks.length)) r.car.teleport({ x: 150, z: -175 + 8 * r.index, yaw: 0 });
      for (let i = 0; i < 30; i++) game.step(DT); // the wrecks settle
      const c = bot.car;
      const j = (seed % 5) - 2; // each seed turns and shifts the start a little: −2…2 × (0.15 rad, 0.3 m)
      c.teleport({ x: T.at[0] + j * 0.3, z: T.at[1], yaw: T.at[2] + j * 0.15 });
      bot._clear();
      const x0 = c.x, z0 = c.z;
      const row = { trap: name, seed, out: null, backs: 0, pushes: 0, teleports: 0, stillMax: 0, spot: null };
      if (name === 'teleport') {
        for (let i = 0; i < 10; i++) game.step(DT);
        bot.cars = game.cars;
        const y0 = c.y;
        bot.respawn();
        const near = Math.min(...game.cars.filter((o) => o !== c).map((o) => Math.hypot(o.x - c.x, o.z - c.z)));
        row.spot = { d: r1(Math.hypot(c.x - x0, c.z - z0)), nearestCar: r1(near), lift: r1(c.y - game.city.groundHeight(c.x, c.z)), y0: r1(y0) };
        let maxDrop = 0;
        await run(game, 2, () => void (maxDrop = Math.max(maxDrop, c.y - game.city.groundHeight(c.x, c.z))));
        row.spot.landedHull = r1(c.health);
        row.teleports = bot.teleports;
        delete bot._raceGoal;
        out.push(row);
        continue;
      }
      let t = 0, ax = c.x, az = c.z, still = 0, wasEsc = null, wasLeg = null, tp = 0;
      await run(game, secs, () => {
        const e = bot.esc, leg = e && `${e.back}${e.legs}`;
        if (e && (e !== wasEsc || leg !== wasLeg)) e.back ? row.backs++ : row.pushes++;
        wasEsc = e;
        wasLeg = leg;
        if (bot.teleports > tp) {
          tp = bot.teleports;
          const near = Math.min(...game.cars.filter((o) => o !== c).map((o) => Math.hypot(o.x - c.x, o.z - c.z)));
          row.spot = { t: r1(t), d: r1(Math.hypot(c.x - x0, c.z - z0)), nearestCar: r1(near), lift: r1(c.y - game.city.groundHeight(c.x, c.z)) };
        }
        if (row.out == null && Math.hypot(c.x - x0, c.z - z0) > 8) row.out = r1(t);
        if (Math.hypot(c.x - ax, c.z - az) > 6) {
          ax = c.x;
          az = c.z;
          still = 0;
        } else if (row.out != null && Math.hypot(c.x - goal.x, c.z - goal.z) > 12) row.stillMax = Math.max(row.stillMax, (still += DT));
        t += DT;
      });
      row.teleports = bot.teleports;
      row.uturns = bot.uturns; // turns round on purpose (ESCAPE.uturn)
      if (T.pin) T.wrecks.forEach((_, i) => {
        const b = rest[i].car.rb.body;
        b.lockTranslations(false, true);
        b.lockRotations(false, true);
      });
      row.end = { x: r1(c.x), z: r1(c.z), toGoal: r1(Math.hypot(c.x - goal.x, c.z - goal.z)) };
      delete bot._raceGoal;
      out.push(row);
    }
  }
  Math.random = random;
  return out;
}

// ---------------------------------------------------------------- NAV_PLAN session 2: the nav grid

/**
 * The nav grid (NAV_PLAN session 2), city or test ground: build time (median of `builds` rebuilds), size, floors per
 * layer and kind (walkable / not), and on the test ground the 3D checks — the tube's floor and the street over it are
 * two layers, the deck is reachable from its ramp only, the ramps' sides aren't walkable, a stuck bot's spot in the
 * tube / on the deck stays on that level.
 */
export async function navGrid(game, { builds = 5 } = {}) {
  const { NavGrid } = await import('/src/nav/grid.js');
  const { freeSpotNear } = await import('/src/zone.js');
  const ms = [];
  for (let k = 0; k < builds; k++) ms.push(new NavGrid(game.phys, game.city.bounds).stats.ms);
  ms.sort((a, b) => a - b);
  const n = game.nav, kinds = {};
  for (let i = 0; i < n.y.length; i++) {
    const key = `${n.kindOf(i)} L${n.layer(i)}`;
    const e = (kinds[key] ??= { walkable: 0, not: 0 });
    n.reachable(i) ? e.walkable++ : e.not++;
  }
  const res = { buildMs: ms[ms.length >> 1], buildMsAll: ms, ...n.stats, kinds };
  if (!game.test) return res;
  const column = (x, z) => {
    const col = n.col(x, z), out = [];
    for (let i = n.start[col]; i < n.start[col + 1]; i++) out.push({ kind: n.kindOf(i), y: r1(n.y[i]), walkable: n.reachable(i) });
    return out;
  };
  // flood the walkable floors from i, not entering floors skip(j) rules out
  const flood = (i, skip) => {
    const seen = new Set([i]), q = [i], by = {};
    while (q.length) {
      const k = q.pop();
      by[n.kindOf(k)] = (by[n.kindOf(k)] ?? 0) + 1;
      for (let d = 0; d < 8; d++) {
        const j = n.next(k, d);
        if (j >= 0 && !seen.has(j) && n.reachable(j) && !skip(j)) seen.add(j), q.push(j);
      }
    }
    return by;
  };
  const deck = n.cellAt(115, 6, 95);
  let sides = 0, sideCells = 0;
  for (let i = 0; i < n.y.length; i++) {
    if (n.kindOf(i) !== 'ramp') continue;
    // a ramp floor beside a ground floor more than a step lower: its side
    for (let d = 0; d < 8; d += 2) {
      const p = n.pos(i), c = n.cellAt(p.x + [1, 0, -1, 0][d / 2] * n.cell, p.y, p.z + [0, 1, 0, -1][d / 2] * n.cell);
      if (c >= 0 && n.kindOf(c) !== 'ramp' && n.y[i] - n.y[c] > 0.6) {
        sideCells++;
        if (n.reachable(i)) sides++;
        break;
      }
    }
  }
  const spot = (x, y, z) => {
    const sp = freeSpotNear(n, x, y, z, { cars: [] });
    return sp && { x: r1(sp.x), y: r1(sp.y), z: r1(sp.z), d: r1(Math.hypot(sp.x - x, sp.z - z)) };
  };
  Object.assign(res, {
    tube: column(-130, 10),
    deckWithoutRamps: flood(deck, (j) => n.kindOf(j) === 'ramp'), // only the deck itself: no way off it but its ramp
    deckReach: flood(deck, () => false),
    rampSides: { floors: sideCells, walkable: sides },
    spotInTube: spot(-130, -5.5, 10),
    spotOnDeck: spot(115, 6, 95),
    spotUnderTubeRoof: spot(-130, 0, 10),
  });
  return res;
}

// ---------------------------------------------------------------- NAV_PLAN session 3: paths and driving

/**
 * City: the simulation's cost per frame (NAV_PLAN session 3) — `runs` seeded battle royales (or races) with `bots`
 * bots, `secs` s each after the countdown, my car on the autopilot; the mean and the 99th percentile of game.step (no
 * rendering) and of the bots' share of it (think + path searches), ms.
 */
export async function frameCost(game, { runs = 3, secs = 30, bots = 19, type = 'royale', seed0 = 700 } = {}) {
  if (game.test) throw new Error('open the city (no ?map=test)');
  const random = Math.random;
  const steps = [], ai = [];
  let searches = 0, expanded = 0;
  for (let k = 0; k < runs; k++) {
    takeOver(game);
    Math.random = seeded(seed0 + k);
    Object.assign(game.solo, { game: type, mode: 'classic', seat: 'driver', bots });
    game.restart();
    game.autoDriver = autopilot(game);
    game.car.applyDamage = () => {};
    while (game.countdown > 0) game.step(DT);
    let botMs = 0;
    const wrap = (o, name) => {
      const f = Object.getPrototypeOf(o)[name];
      o[name] = function (...a) {
        const t = performance.now();
        const r = f.apply(this, a);
        botMs += performance.now() - t;
        return r;
      };
    };
    for (const r of [...game.rivals, game.autoDriver]) wrap(r, 'think');
    if (game.paths) wrap(game.paths, 'run');
    const s0 = game.paths?.stats ? { ...game.paths.stats } : null;
    await run(game, secs, () => {
      if (game.state !== 'play') return false;
      botMs = 0;
      const t = performance.now();
      game.step(DT);
      steps.push(performance.now() - t);
      ai.push(botMs);
      return true;
    });
    if (s0) {
      searches += game.paths.stats.searches - s0.searches;
      expanded += game.paths.stats.expanded - s0.expanded;
    }
    for (const r of [...game.rivals, game.autoDriver]) delete r.think;
    if (game.paths) delete game.paths.run;
  }
  Math.random = random;
  const stat = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return { mean: Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 1000) / 1000, p99: Math.round(s[Math.floor(s.length * 0.99)] * 1000) / 1000, max: Math.round(s[s.length - 1] * 1000) / 1000 };
  };
  const frames = steps.length;
  return { type, bots, frames, step: stat(steps), bots_ms: stat(ai), searchesPerS: r1(searches / (frames * DT)), expandedPerSearch: searches ? Math.round(expanded / searches) : 0 };
}

/**
 * City (NAV_PLAN session 3): battle royale waypoints — `runs` seeded games of `secs` s with `bots` bots; every waypoint
 * a bot was given (Rival.wp): how much room its floor has (under NAV.open 6 m — in a yard, a park, by a wall: session
 * 2 kept them out), whether the bot got within 10 m of it before it was replaced (reached) and how long that took.
 */
export async function waypoints(game, { runs = 5, secs = 120, bots = 19, seed0 = 900 } = {}) {
  const all = [];
  const cur = new Map();
  const close = (r, t) => {
    const w = cur.get(r);
    if (w) all.push({ ...w, secs: w.reached == null ? null : r1(w.reached - w.t0), left: r1(t - w.t0) });
    cur.delete(r);
  };
  let T = 0;
  const each = (t, rivals) => {
    T = t;
    for (const r of rivals) {
      const w = cur.get(r);
      if (r.car.wrecked) {
        if (w) close(r, t);
        continue;
      }
      if (!w || w.wp !== r.wp) {
        if (w) close(r, t);
        if (r.wp) {
          const i = game.nav.cellAt(r.wp.x, r.wp.y + 0.5, r.wp.z);
          cur.set(r, { wp: r.wp, room: r1(game.nav.roomAt(i)), t0: t, reached: null });
        }
        continue;
      }
      if (w.reached == null && Math.hypot(r.car.x - w.wp.x, r.car.z - w.wp.z) < 10.5) w.reached = t;
    }
  };
  const res = await botBattles(game, { runs, secs, bots, type: 'royale', seed0, each: (t, rivals) => {
    if (t === 0) for (const r of [...cur.keys()]) close(r, T);
    each(t, rivals);
  } });
  for (const r of [...cur.keys()]) close(r, T);
  const rows = all.map(({ wp, ...w }) => w);
  const sum = (f) => {
    const a = rows.filter(f), done = a.filter((w) => w.reached != null);
    return { n: a.length, reached: done.length, share: a.length ? r1((done.length / a.length) * 100) : 0, meanSecs: done.length ? r1(done.reduce((s, w) => s + w.secs, 0) / done.length) : null, maxSecs: done.length ? Math.max(...done.map((w) => w.secs)) : null };
  };
  return { open: sum((w) => w.room >= 6), yards: sum((w) => w.room < 6), stuckMax: res.stuckMax, stuckOver10: res.stuckOver10, teleports: res.teleports, notReachedYards: rows.filter((w) => w.room < 6 && w.reached == null).slice(0, 20) };
}

// ---------------------------------------------------------------- NAV_PLAN session 4: 3D

// the test ground's features (src/world/city.js: the ramps, the tube, the deck, the catapult) — where a car uses them
const FEATURES = {
  bigRamp: (c, p) => p.z < -29.5 && c.z >= -29.5 && c.x > -21 && c.x < -9 && c.y > 2.5, // off its lip (z −30, 3.5 m)
  kicker: (c, p) => c.x > 70 && c.x < 78 && c.y > 0.8 && [-104, -64, -24].some((z) => p.z < z && c.z >= z),
  trenchJump: (c, p) => p.x < -140 && c.x >= -140 && c.z > 64 && c.z < 74 && c.y > 2, // over the tube's exit trench
  deckUp: (c, p) => !onDeck(p) && onDeck(c),
  // off the deck's edge (not down its ramp: x 108…122 at z 80)
  deckDrop: (c, p) => onDeck(p) && !onDeck(c) && !(c.x > 108 && c.x < 122 && c.z < 81),
  tube: (c, p) => !inTube(p) && inTube(c),
  catapult: (c, p, car) => car.rb.body.linvel().y > 14 && c.x > 140 && c.x < 152 && c.z > -40 && c.z < -25 && !(p.vy > 14),
};
const onDeck = (c) => c.x > 100 && c.x < 130 && c.z > 80 && c.z < 110 && c.y > 5;
const inTube = (c) => c.x > -134 && c.x < -126 && c.z > -30 && c.z < 50 && c.y < -3;

/**
 * Test ground with bots (NAV_PLAN session 4; open `/?mute&map=test&bots=7`): `runs` seeded games of `secs` s (the
 * menu's race over the big ramp, the deck and the tube, or `type: 'royale'`), my car on the autopilot. Per game: how
 * many times bots used each feature (FEATURES), hard hits (over 4 m/s) on a ramp's or the deck's side, the longest any
 * bot stayed within 6 m of one spot, teleports, tips, wrecks, jumps driven off / given up, gates passed.
 */
export async function testGround(game, { runs = 5, secs = 120, type = 'race', mode = 'classic', seed0 = 1100 } = {}) {
  if (!game.testMap || game.test) throw new Error('open the test ground with bots (?map=test&bots=7)');
  const random = Math.random;
  const res = [];
  for (let k = 0; k < runs; k++) {
    takeOver(game);
    Math.random = seeded(seed0 + k);
    Object.assign(game.solo, { game: type, mode, seat: 'driver' });
    game.restart();
    game.autoDriver = autopilot(game);
    game.car.applyDamage = () => {};
    // a butcher's 40 kills (the line of 50 pedestrians is where the big ramp lands) would end the game early
    const victory = game._victory;
    game._victory = function (kind, car) {
      if (kind !== 'carnage') return victory.call(this, kind, car);
    };
    while (game.countdown > 0) game.step(DT);
    const rivals = game.rivals;
    const used = Object.fromEntries(Object.keys(FEATURES).map((f) => [f, 0]));
    const tipLog = [], abortLog = [];
    const sides = [], walls = {};
    let teleports = 0, t = 0;
    const st = rivals.map((r) => ({ p: { x: r.car.x, y: r.car.y, z: r.car.z, vy: 0 }, ax: r.car.x, az: r.car.z, still: 0, max: 0, at: null, tipT: 0, tips: 0 }));
    for (const r of rivals) {
      const orig = r.respawn;
      r.respawn = function () {
        teleports++;
        return orig.call(this);
      };
      const imp = r.car._impact;
      r.car._impact = function (into, nx, nz, x, z, kind, y) {
        if (into > 4) {
          walls[kind] = (walls[kind] ?? 0) + 1;
          if (kind === 'ramp' || kind === 'deck') sides.push({ t: r1(t), name: r.name, kind, kmh: r1(into * KMH), x: r1(x), y: r1(y), z: r1(z), mode: r.mode });
        }
        return imp.call(this, into, nx, nz, x, z, kind, y);
      };
    }
    const j0 = rivals.map((r) => [r.jumpsTaken, r.aborts]);
    await run(game, secs, () => {
      if (game.state !== 'play') return false;
      rivals.forEach((r, i) => {
        const c = r.car, s = st[i];
        if (c.wrecked) return;
        const cur = { x: c.x, y: c.y, z: c.z, vy: c.rb.body.linvel().y };
        for (const [f, test] of Object.entries(FEATURES)) if (test(cur, s.p, c)) used[f]++;
        s.p = cur;
        const lean = Math.acos(Math.max(-1, Math.min(1, c.upY))) * DEG;
        if (lean > 60) {
          if (s.tipT === 0) {
            s.tips++;
            tipLog.push({ t: r1(t), name: r.name, x: r1(c.x), y: r1(c.y), z: r1(c.z), kmh: r1(c.speed * KMH), air: r1(c.rb.airT), mode: r.mode, jump: !!r._jumpAhead() });
          }
          s.tipT += DT;
        } else s.tipT = 0;
        if (r.aborts > (s.ab ?? 0)) {
          const J = r._jumpAhead(), jd = J && game.nav.jumps[J.q];
          abortLog.push({ t: r1(t), name: r.name, x: r1(c.x), z: r1(c.z), kmh: r1(c.speed * KMH), kind: jd?.kind, lo: jd?.lo, hi: jd?.hi, toLip: J && r1(J.s1 - r.pathS) });
        }
        s.ab = r.aborts;
        if (r.tr.finished || Math.hypot(c.x - s.ax, c.z - s.az) > 6) {
          s.ax = c.x;
          s.az = c.z;
          s.still = 0;
          return;
        }
        s.still += DT;
        if (s.still > s.max) {
          s.max = s.still;
          s.at = { name: r.name, x: r1(c.x), y: r1(c.y), z: r1(c.z), mode: r.mode, t: r1(t) };
        }
      });
      t += DT;
    });
    for (const r of rivals) {
      delete r.respawn;
      delete r.car._impact;
    }
    delete game._victory;
    const worst = st.reduce((a, s) => (s.max > a.max ? s : a), st[0]);
    res.push({
      tipLog, abortLog,
      run: k, secs: r1(t), used, sideHits: sides.length, sides: sides.slice(0, 10), walls, stuckMax: r1(worst.max), stuckAt: worst.at, teleports,
      tips: st.reduce((a, s) => a + s.tips, 0), wrecked: rivals.filter((r) => r.car.wrecked).length,
      jumps: rivals.reduce((a, r, i) => a + r.jumpsTaken - j0[i][0], 0), aborts: rivals.reduce((a, r, i) => a + r.aborts - j0[i][1], 0),
      gates: rivals.reduce((a, r) => a + r.tr.passed, 0), laps: rivals.map((r) => r.tr.lap - 1 + (r.tr.finished ? 1 : 0)),
      kills: rivals.reduce((a, r) => a + r.car.kills, 0),
    });
  }
  Math.random = random;
  const sum = (f) => res.reduce((a, r) => a + f(r), 0);
  return {
    type, bots: game.rivals.length, runs, used: Object.fromEntries(Object.keys(FEATURES).map((f) => [f, sum((r) => r.used[f])])),
    sideHits: sum((r) => r.sideHits), stuckMax: Math.max(...res.map((r) => r.stuckMax)), stuckOver10: res.filter((r) => r.stuckMax > 10).length,
    teleports: sum((r) => r.teleports), tips: sum((r) => r.tips), wrecked: sum((r) => r.wrecked), jumps: sum((r) => r.jumps), aborts: sum((r) => r.aborts),
    gates: sum((r) => r.gates), crashes: window.crash?.entries?.length ?? 0, runs: res,
  };
}

// scripted runs over the test ground's features: start [x, y, z, yaw, speed], goal [x, y, z], the feature expected
export const FEATURE_RUNS = {
  bigRamp: { start: [-15, 0, -95, 0, 10], goal: [-15, 0, 30], expect: 'bigRamp' },
  kickers: { start: [74, 0, -165, 0, 10], goal: [74, 0, -5], expect: 'kicker' }, // the boost pad, then 3 kickers
  trenchJump: { start: [-178, 0, 69, Math.PI / 2, 10], goal: [-95, 0, 69], expect: 'trenchJump' },
  deckUp: { start: [115, 0, -10, 0, 10], goal: [115, 6, 100], expect: 'deckUp' },
  dropNorth: { start: [115, 6, 84, 0, 8], goal: [115, 0, 150], expect: 'deckDrop' },
  dropWest: { start: [115, 6, 95, -Math.PI / 2, 8], goal: [55, 0, 95], expect: 'deckDrop' },
  tube: { start: [-130, 0, 125, Math.PI, 10], goal: [-130, 0, -100], expect: 'tube' },
  catapult: { start: [146, 0, -75, 0, 10], goal: [146, 0, 25], expect: 'catapult' },
};

/**
 * Test ground (NAV_PLAN session 4): one bot per run from before a feature to a goal past it (FEATURE_RUNS), `seeds`
 * starts each, shifted ±1 m and turned ±0.1 rad. Per run: whether it used the feature (FEATURES), reached the goal
 * (within 12 m) and when, its jumps and give-ups, tips past 60°, hard hits on a ramp's or the deck's side, the longest
 * stay within 6 m of one spot, teleports.
 */
export async function featureRuns(game, { names = Object.keys(FEATURE_RUNS), seeds = [0, 1, 2, 3, 4], secs = 25 } = {}) {
  if (!game.testMap || game.test) throw new Error('open the test ground with bots (?map=test&bots=7)');
  const random = Math.random;
  const rows = [];
  for (const name of names) {
    const F = FEATURE_RUNS[name];
    for (const seed of seeds) {
      takeOver(game);
      Math.random = seeded(seed);
      game.restart();
      game.car.applyDamage = () => {};
      while (game.countdown > 0) game.step(DT);
      game.car.teleport({ x: 150, z: -175, yaw: 0 });
      const [bot, ...rest] = game.rivals;
      rest.forEach((r, i) => r.car.teleport({ x: -150 + 8 * i, z: -175, yaw: 0 }));
      bot.def = { ...bot.def, aggr: 0, gore: 0 };
      bot._raceGoal = () => ({ x: F.goal[0], y: F.goal[1], z: F.goal[2], gate: null });
      const j = (seed % 5) - 2, yaw = F.start[3] + j * 0.05, c = bot.car;
      c.teleport({ x: F.start[0] + j * 0.5 * Math.cos(yaw), y: F.start[1] + 0.3, z: F.start[2] - j * 0.5 * Math.sin(yaw), yaw });
      bot._clear();
      c.nudge(Math.sin(yaw) * F.start[4], Math.cos(yaw) * F.start[4]);
      const row = { run: name, seed, used: 0, reached: null, jumps: 0, aborts: 0, tips: 0, sides: 0, stillMax: 0, teleports: 0 };
      const imp = c._impact;
      c._impact = function (into, nx, nz, x, z, kind, y) {
        if (into > 4 && (kind === 'ramp' || kind === 'deck')) row.sides++;
        return imp.call(this, into, nx, nz, x, z, kind, y);
      };
      let p = { x: c.x, y: c.y, z: c.z, vy: 0 }, ax = c.x, az = c.z, still = 0, tipped = false, t = 0;
      await run(game, secs, () => {
        const cur = { x: c.x, y: c.y, z: c.z, vy: c.rb.body.linvel().y };
        if (FEATURES[F.expect](cur, p, c)) row.used++;
        p = cur;
        const tip = c.upY < 0.5;
        if (tip && !tipped) row.tips++;
        tipped = tip;
        if (Math.hypot(c.x - ax, c.z - az) > 6) (ax = c.x), (az = c.z), (still = 0);
        else row.stillMax = Math.max(row.stillMax, (still += DT));
        t += DT;
        if (Math.hypot(c.x - F.goal[0], c.z - F.goal[2]) < 12 && Math.abs(c.y - F.goal[1]) < 3) {
          row.reached = r1(t);
          return false;
        }
      });
      Object.assign(row, { jumps: bot.jumpsTaken, aborts: bot.aborts, teleports: bot.teleports, stillMax: r1(row.stillMax), end: [r1(c.x), r1(c.y), r1(c.z)] });
      delete c._impact;
      delete bot._raceGoal;
      rows.push(row);
    }
  }
  Math.random = random;
  const sum = {};
  for (const r of rows) {
    const s = (sum[r.run] ??= { runs: 0, used: 0, reached: 0, secs: [], jumps: 0, aborts: 0, tips: 0, sides: 0, stillMax: 0, teleports: 0 });
    s.runs++;
    if (r.used) s.used++;
    if (r.reached != null) (s.reached++, s.secs.push(r.reached));
    s.jumps += r.jumps;
    s.aborts += r.aborts;
    s.tips += r.tips;
    s.sides += r.sides;
    s.teleports += r.teleports;
    s.stillMax = Math.max(s.stillMax, r.stillMax);
  }
  for (const s of Object.values(sum)) s.secs = s.secs.length ? `${Math.min(...s.secs)}–${Math.max(...s.secs)}` : '—';
  return { sum, rows };
}

/**
 * One bot driving from `start` [x, y, z, yaw, speed] to a fixed `goal` [x, y, z] (any map; the other cars parked
 * out of the way): every `every` frames a line — time, position, speed, heading, its input, its place on its path and
 * the jump ahead (kind, band, where its run-up starts and its lip are), wheels on the ground, the body's up.
 */
export async function botTrace(game, { start, goal, secs = 8, every = 6, def = null } = {}) {
  takeOver(game);
  game.restart();
  game.car.applyDamage = () => {};
  while (game.countdown > 0) game.step(DT);
  game.car.teleport({ x: 150, z: -175, yaw: 0 });
  const [bot, ...rest] = game.rivals;
  rest.forEach((r, i) => r.car.teleport({ x: -150 + 8 * i, z: -175, yaw: 0 }));
  bot.def = { ...bot.def, aggr: 0, gore: 0, ...def };
  bot._raceGoal = () => ({ x: goal[0], y: goal[1], z: goal[2], gate: null });
  bot.car.teleport({ x: start[0], y: start[1], z: start[2], yaw: start[3] });
  bot._clear();
  if (start[4]) bot.car.nudge(Math.sin(start[3]) * start[4], Math.cos(start[3]) * start[4]);
  const log = [];
  for (let i = 0, t = 0; i < secs / DT; i++, t += DT) {
    game.step(DT);
    const c = bot.car, J = bot._jumpAhead(), jd = J && game.nav.jumps[J.q], inp = bot.inp;
    if (i % every) continue;
    log.push([r1(t), r1(c.x), r1(c.y), r1(c.z), `${r1(c.speed)}m/s`, `yaw ${r1(c.yaw)}`, `thr ${inp.throttle} br ${inp.brake} st ${r1(inp.steer)}`, `s ${r1(bot.pathS)}`,
      J ? `${jd.kind} ${jd.lo}-${jd.hi} from ${r1(J.s0)} lip ${r1(J.s1)} way ${jd.dx},${jd.dz}${J.dropped ? ' dropped' : ''}` : '-', `wheels ${c.rb.contacts}`, `up ${r1(c.upY)}`].join(' '));
  }
  delete bot._raceGoal;
  return log;
}

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
    game.phys.addSolid({ kind: 'pole', cyl: [pole.x, 3.5, pole.z, 3.5, 0.36] });
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
  return { crashes: window.crash?.entries?.length ?? 0, out };
}

/**
 * Test ground: the car dropped level on its wheels, and upside down on its roof, from heights that give
 * `speeds` m/s at touchdown — the hull lost (wheels: VEH.landScale per m/s above landSafe; roof: roofScale above
 * roofSafe).
 */
export async function landings(game, { speeds = [8, 12, 14, 16, 20, 24] } = {}) {
  if (!game.test) throw new Error('landings(): open /?map=test');
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
 * Test ground: my car into another one. Head-on (100 vs 80 km/h), catching up (55 into one doing 50), a
 * T-bone (60 into a parked car's side), a side swipe (60 and 60, 15° apart). Closing speed and the hull each lost.
 */
export async function carCrashes(game) {
  if (!game.test) throw new Error('carCrashes(): open /?map=test');
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
 * Test ground: a shell's blast by a parked car's left side, 0…3 m from it, y m up (0.9 — the body's middle;
 * 1.96 — a level shot's height),
 * and a direct hit there. The car's largest lean, how fast it was thrown, the hull lost, did it tip over.
 */
export async function blasts(game, { gaps = [0, 1, 2, 3], y = 0.9 } = {}) {
  if (!game.test) throw new Error('blasts(): open /?map=test');
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
  return { crashes: window.crash?.entries?.length ?? 0, out };
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
  return { crashes: window.crash?.entries?.length ?? 0, out };
}

/**
 * Test ground: where a tilted car fires. The car pitched nose-up 2°, 10°, 30°, rolled 90° (on its side),
 * upside down: the muzzle's height and the shell's slope; and a level shot from 40 m into a parked car.
 */
export async function muzzle(game) {
  if (!game.test) throw new Error('muzzle(): open /?map=test');
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
 * Test ground (session 5): the bot gunner and the machine gun's auto-aim on a tilted car. The car is posed
 * (level, nose up 13° as across the big ramp, rolled 30°, on its side, on its roof) facing +z, a target 30 m away at
 * bearings 0 / 45 / 270 / 200°; the gunner turns for 3 s. Per case: the barrel's heading error from the target's bearing
 * (`err`), whether the gunner fired, and what the old yaw-only arithmetic would have pointed at (`oldErr`).
 */
export async function gunnerTilt(game, { gunner = null } = {}) {
  if (!game.test) throw new Error('gunnerTilt(): open /?map=test');
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

/**
 * Test ground: shells and bullets against pedestrians in 3D. A person stands (or lies) on the lane 10 / 25 m in front of
 * the car, which is level or posed nose up 10° / 30° (the body's pose only, for the muzzle). Per case: whether a shell
 * (flown by Artillery.update) or a burst of 6 bullets (MachineGuns._fire) hit them, and the shell's height over them.
 */
export async function pedShots(game) {
  if (!game.test) throw new Error('pedShots(): open /?map=test');
  takeOver(game);
  game.restart();
  const car = game.car, rb = car.rb, peds = game.peds;
  const ST = { WAIT: 2, DEAD: 6 };
  const Q = rb.quat.constructor;
  const ax = (deg) => new Q().setFromAxisAngle({ x: 1, y: 0, z: 0, isVector3: true }, (deg * Math.PI) / 180);
  const p = peds.peds.find((q) => q.state !== 0);
  const others = peds.peds.filter((q) => q !== p).map((q) => [q, q.x, q.z]);
  for (const [q] of others) q.x += 1000; // nobody else on the line
  const out = [];
  for (const [pose, deg] of [['level', 0], ['nose up 10°', -10], ['nose up 30°', -30]]) {
    for (const lying of [false, true]) {
      for (const d of [10, 25]) {
        const res = { pose, ped: lying ? 'lying' : 'standing', distM: d };
        for (const gun of ['shell', 'mg']) {
          fresh(car, { x: 170, z: -60, yaw: 0 });
          rb.quat.copy(ax(deg));
          const g = game.city.groundHeight(170, -60 + d);
          Object.assign(p, { x: 170, z: -60 + d, vx: 0, vz: 0, vy: 0, state: lying ? ST.DEAD : ST.WAIT, deadT: 0 });
          p.cy = lying ? g + 0.16 : g + 1;
          let hit = false;
          const shoot = peds.shoot, explosion = peds.explosion;
          peds.shoot = () => (hit = true);
          peds.explosion = (x, z, R, src, local, y) => {
            const [y0, y1] = peds.span(p);
            const dd = Math.hypot(Math.hypot(p.x - x, p.z - z), y == null ? 0 : Math.max(0, y0 - y, y - y1));
            if (dd < R * 0.4) hit = true;
          };
          try {
            if (gun === 'shell') {
              const m = car.muzzle();
              m.v = 95;
              game.artillery.fire(car, m);
              res.shellOverHeadM = r1(m.y + (m.dy / Math.hypot(m.dx, m.dz)) * d - (p.cy + 0.85));
              for (let i = 0; i < 60 && game.artillery.shells.length; i++) game.artillery.update(DT);
              game.artillery.clear();
            } else for (let i = 0; i < 6; i++) game.mg._fire(car, [car], true);
          } finally {
            peds.shoot = shoot;
            peds.explosion = explosion;
          }
          res[gun] = hit;
        }
        if (lying) delete res.shellOverHeadM; // shells pass over lying people anyway
        out.push(res);
      }
    }
  }
  for (const [q, x, z] of others) Object.assign(q, { x, z });
  fresh(car, game.city.spawn);
  return { crashes: window.crash?.entries?.length ?? 0, out };
}

/**
 * Test ground: the flip rule for a car that isn't still. The car is laid on its side and, from 0.8 s on, its speed along
 * its length is set to `push` m/s every 0.2 s (rocking, shoved by others). When it starts righting itself, if at all.
 */
export async function rocking(game, { pushes = [0, 1, 2, 3, 5] } = {}) {
  if (!game.test) throw new Error('rocking(): open /?map=test');
  takeOver(game);
  const car = game.car, rb = car.rb, b = rb.body;
  const Q = rb.quat.constructor;
  const out = [];
  for (const push of pushes) {
    game.restart();
    fresh(car, { x: 170, z: 0, yaw: 0 });
    await run(game, 10 * DT);
    const t = b.translation();
    b.setTranslation({ x: t.x, y: t.y + 1.3, z: t.z }, true);
    b.setRotation(new Q().setFromAxisAngle({ x: 0, y: 0, z: 1, isVector3: true }, Math.PI / 2), true);
    rb.afterStep();
    rb.prevP.copy(rb.curP);
    rb.prevQ.copy(rb.curQ);
    let righted = null, sum = 0, n = 0;
    await run(game, 12, (T) => {
      if (rb.righting) {
        righted = r1(T);
        return false;
      }
      if (push && T > 0.8 && Math.round(T / DT) % 12 === 0) {
        const v = b.linvel();
        b.setLinvel({ x: v.x, y: v.y, z: push }, true);
      }
      if (T > 1) {
        sum += car.speed;
        n++;
      }
    });
    out.push({ pushMs: push, meanMs: r1(sum / (n || 1)), rightsAtS: righted });
  }
  fresh(car, game.city.spawn);
  return { crashes: window.crash?.entries?.length ?? 0, out };
}

/**
 * Test ground: Molotov bottles against 3D surfaces — thrown at the raised deck's side, dropped onto the deck, onto the big
 * ramp's slope and the flat. Where each one broke and the height its puddle burns at.
 */
export async function molotovs(game) {
  if (!game.test) throw new Error('molotovs(): open /?map=test');
  takeOver(game);
  game.restart();
  game.step(DT); // Rapier's scene queries see the world after a step
  const M = game.molotovs, shatter = M._shatter;
  const out = [];
  for (const [name, x, y, z, vx, vy, vz] of [
    ['at the deck side (x = 100)', 90, 3, 95, 15, 2, 0],
    ['onto the deck (6 m)', 115, 12, 95, 0, 0, 0],
    ['onto the big ramp', -15, 6, -40, 0, 0, 0],
    ['on the flat', 170, 3, -40, 0, 0, 5],
  ]) {
    M.clear();
    let at = null;
    M._shatter = function (a, b, c) {
      at = [r1(a), r1(b), r1(c)];
      shatter.call(this, a, b, c);
    };
    M.throw(x, y, z, vx, vy, vz);
    for (let i = 0; i < 300 && M.items.length; i++) M.update(DT);
    out.push({ throw: name, brokeAt: at, puddleY: M.fires[0] ? Math.round(M.fires[0].y * 100) / 100 : null });
  }
  M._shatter = shatter;
  M.clear();
  return out;
}

/**
 * Test ground: tyre marks off the flat ground — a handbrake slide up the big ramp and through the tube. How many marks
 * were laid on the slope / under the ground, and how far the ramp's marks are from its surface.
 */
export async function tyreMarks(game) {
  if (!game.test) throw new Error('tyreMarks(): open /?map=test');
  const inp = takeOver(game);
  const car = game.car, marks = game.fx.marks;
  const laid = () => Array.from({ length: marks.used }, (_, i) => marks.mesh.instanceMatrix.array.slice(i * 16 + 12, i * 16 + 15));
  const out = [];
  game.restart();
  fresh(car, { x: -15, z: -70, yaw: 0 });
  await run(game, 0.5);
  marks.clear();
  await drive(game, inp, car, 14, 4, () => {
    inp.throttle = 1;
    const on = car.z > -44 && car.z < -33;
    inp.handbrake = on;
    inp.steer = on ? 0.3 : 0;
  });
  const ramp = laid().filter((p) => p[1] > 0.3);
  out.push({ run: 'big ramp', marks: marks.used, onSlope: ramp.length, offSurfaceM: Math.max(0, ...ramp.map((p) => Math.round(Math.abs(p[1] - game.city.groundHeight(p[0], p[2])) * 1000) / 1000)) });
  game.restart();
  fresh(car, { x: -130, z: -90, yaw: 0 });
  await run(game, 0.5);
  marks.clear();
  let i = 0;
  await drive(game, inp, car, 16, 5, () => {
    inp.handbrake = car.y < -3 && i++ % 40 < 15;
  });
  out.push({ run: 'tube', marks: marks.used, underGround: laid().filter((p) => p[1] < -3).length });
  fresh(car, game.city.spawn);
  return { crashes: window.crash?.entries?.length ?? 0, out };
}
