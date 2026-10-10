/**
 * Two-client network measurements (PHYSICS_PLAN.md, session 4). Not part of the game build. Start the WebSocket server
 * (`npm run server`, port 8080) and the dev server, open `/tests/net.html` (two games side by side: A on the left, B on
 * the right) and in its console:
 *
 *   const t = await import('/tests/net.js');
 *   const s = await t.setup({ query: '?mute&map=test' }); // A hosts, B joins, the race starts
 *   await t.jump(s);       // A off the big ramp: A's car on A's screen vs its ghost on B's
 *   await t.rollover(s);   // A with two wheels up the big ramp: rolls over, rights itself
 *   await t.ram(s);        // A into the side of B's parked car: knock and damage on both screens
 *   await t.reconnect(s);  // B's car on its roof, B's page reloads, the race resumes
 *   await t.bandwidth(s);  // bytes per snapshot (city: setup({ query: '?mute', bots: 7 }))
 *   // crew: setup({ mode: 'crew', gunner: true }) seats B in A's gun, then await t.gunner(s)
 *
 * setup({ lag: 60 }) delays every message each client receives by 60 ms (a 120 ms round trip). The page steps both games
 * itself in real time (a hidden Browser pane has no animation frames); input is scripted. Reload the page between
 * setups. The frames share the tab's storage: a game opened in this tab within 85 s after a test resumes its network race
 * (the lobby's session) — open single-player tests in a fresh tab, or wait.
 */

const KMH = 3.6;
const DEG = 180 / Math.PI;
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

async function until(fn, ms = 15000, what = 'condition') {
  const t0 = now();
  while (!fn()) {
    if (now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const frame = (id) => document.getElementById(id);

/** Load both frames with `query`; resolves with their windows once both games are up. */
async function load(query) {
  // both frames share the page's storage: no game should resume an earlier test's session
  for (const st of [sessionStorage, localStorage]) st.removeItem('cars-and-guts:session');
  const ws = [];
  for (const id of ['a', 'b']) {
    const f = frame(id);
    f.src = `/${query}`;
    ws.push(f);
  }
  await until(() => ws.every((f) => f.contentWindow?.game?.lobby), 20000, 'games');
  return ws.map((f) => f.contentWindow);
}

/**
 * Step both games from a timer at ~60 Hz in real time (the network runs in real time too). Their own animation loops are
 * stopped: in a hidden Browser pane there are no animation frames. Rendering — every 4th step.
 */
let pumping = null;

function pump(s) {
  // one pump per page: an earlier setup's would step the same frames' games again (twice as fast as real time)
  if (pumping) clearTimeout(pumping.pumpT);
  pumping = s;
  let last = now(), n = 0;
  s.errors = [];
  const loop = () => {
    if (pumping !== s) return;
    const t = now(), dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    for (const k of ['A', 'B']) {
      const g = s[k]?.game;
      if (!g) continue; // B's page is reloading
      if (!g._pumped) {
        g.renderer.setAnimationLoop(null);
        g._pumped = true;
      }
      try {
        g.step(dt);
        if (n % 4 === 0) g.render();
      } catch (e) {
        s.errors.push(`${k}: ${e.message}`);
        if (s.errors.length < 4) console.error(e);
      }
    }
    n++;
    s.pumpT = setTimeout(loop, 15);
  };
  loop();
}

/** Every message this client receives arrives ms later. */
function addLag(w, ms) {
  const c = w.game.lobby.client;
  const dispatch = c._dispatch.bind(c);
  c._dispatch = (msg) => setTimeout(() => dispatch(msg), ms);
}

const idle = () => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, fire: false, aim: 0, aimDX: 0, lookBack: false });

/** Scripted input and per-step hooks for a game: { inp, each } — each() runs before every step, hooks after it. */
function control(w) {
  const g = w.game;
  if (g._ctl) return g._ctl;
  const ctl = { inp: idle(), each: null, hooks: new Set() };
  g.input.update = () => {
    ctl.each?.();
    return ctl.inp;
  };
  const step = g.step;
  g.step = function (dt) {
    step.call(g, dt);
    for (const h of ctl.hooks) h(dt);
  };
  g._ctl = ctl;
  return ctl;
}

/**
 * Two clients in one room, the race started. A creates the room (host), B joins; gunner — crew mode, B sits in A's gun.
 * Returns { A, B, a, b } — the windows and their controls.
 */
export async function setup({ query = '?mute&map=test', game = 'race', mode = 'classic', bots = 0, gunner = false, lag = 0, server = 'localhost:8080' } = {}) {
  const [A, B] = await load(query);
  for (const [w, name] of [[A, 'A'], [B, 'B']]) {
    const d = w.document;
    d.getElementById('net-name').value = name;
    d.getElementById('net-server').value = server;
    await sleep(300); // the lobby asks the page's server whether it is ours (same origin) first
    w.game.lobby.open();
    await w.game.lobby.connect();
    if (!w.game.lobby.client.connected) throw new Error(`${name}: not connected (is the server on ${server} running?)`);
    if (lag) addLag(w, lag);
  }
  const la = A.game.lobby, lb = B.game.lobby;
  la.client.send({ t: 'create', name: 'net test', settings: { game, mode: gunner ? 'crew' : mode, bots, teams: false } });
  await until(() => la.room, 5000, 'room');
  lb.client.send({ t: 'join', room: la.room.id });
  await until(() => lb.room && la.room.players.length === 2, 5000, 'B in the room');
  if (gunner) {
    lb.client.send({ t: 'me', car: la.client.id, seat: 'gunner' });
    await until(() => la.room.players.some((p) => p.id === lb.client.id && p.car === la.client.id && p.seat === 'gunner'), 5000, 'B in the gun');
  }
  la._start();
  await until(() => A.game.net && B.game.net && A.game.state === 'play' && B.game.state === 'play', 10000, 'race start');
  const s = { A, B, a: control(A), b: control(B), ids: { A: la.client.id, B: lb.client.id }, lag };
  pump(s);
  if (!A.game.test) await sleep(3500); // the countdown
  return s;
}

/** Car `id` as `w` sees it (its own car or a ghost). */
const carIn = (w, id) => w.game.net.car(id);

function pose(car) {
  const q = car.rb ? car.rb.quat : { x: 0, y: Math.sin(car.yaw / 2), z: 0, w: Math.cos(car.yaw / 2) };
  return { x: car.x, y: car.y, z: car.z, q: [q.x, q.y, q.z, q.w], up: car.upY, kmh: car.speed * KMH, vy: car.vy || 0, hp: car.health };
}

/** Record car `id` on both screens (after every step, on the parent's clock) while fn runs. */
async function record(s, id, fn) {
  const rec = { A: [], B: [] };
  const hooks = [];
  for (const k of ['A', 'B']) {
    const w = s[k], ctl = s[k.toLowerCase()];
    const h = () => {
      const car = carIn(w, id);
      if (car) rec[k].push({ t: now(), ...pose(car) });
    };
    ctl.hooks.add(h);
    hooks.push([ctl, h]);
  }
  try {
    await fn();
  } finally {
    for (const [ctl, h] of hooks) ctl.hooks.delete(h);
  }
  return rec;
}

const qAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * DEG;
const tilt = (p) => Math.acos(Math.max(-1, Math.min(1, p.up))) * DEG;

/** The owner's series interpolated at time t. */
function at(series, t) {
  let i = series.findIndex((p) => p.t >= t);
  if (i <= 0) return i === 0 ? series[0] : series[series.length - 1];
  const a = series[i - 1], b = series[i], k = (t - a.t) / (b.t - a.t || 1);
  const q = a.q.map((v, j) => v + (b.q[j] * Math.sign(a.q[0] * b.q[0] + a.q[1] * b.q[1] + a.q[2] * b.q[2] + a.q[3] * b.q[3]) - v) * k);
  const l = Math.hypot(...q);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, q: q.map((v) => v / l), up: a.up + (b.up - a.up) * k };
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { mean: r2(s.reduce((a, b) => a + b, 0) / (s.length || 1)), p95: r2(s[Math.floor(s.length * 0.95)] ?? 0), max: r2(s[s.length - 1] ?? 0) };
};

/**
 * How far the ghost (on the screen of `ghostOn`) was from the real car (on its owner's screen) at the same moments:
 * position (m) and rotation (°) errors; the largest tilt each screen showed; and how much later the ghost showed the same
 * pose — the delay that makes the errors smallest.
 */
function compare(rec, owner, ghostOn) {
  const real = rec[owner], ghost = rec[ghostOn].filter((p) => p.t > real[0].t && p.t < real[real.length - 1].t);
  const err = (lagMs) => {
    const dp = [], dq = [], dy = [];
    for (const p of ghost) {
      const r = at(real, p.t - lagMs);
      dp.push(Math.hypot(p.x - r.x, p.y - r.y, p.z - r.z));
      dq.push(qAngle(p.q, r.q));
      dy.push(p.y - r.y);
    }
    return { dp, dq, dy };
  };
  const e = err(0);
  let best = 0, bestE = Infinity;
  for (let ms = 0; ms <= 300; ms += 10) {
    const { dp } = err(ms);
    const m = dp.reduce((a, b) => a + b, 0) / dp.length;
    if (m < bestE) {
      bestE = m;
      best = ms;
    }
  }
  return {
    samples: ghost.length,
    posErrM: stats(e.dp),
    rotErrDeg: stats(e.dq),
    ghostDelayMs: best,
    posErrAtDelayM: r2(bestE),
    // the ghost's height against the real car's at the same moment: lowest (sunk below it) and highest
    heightErrM: [r2(Math.min(...e.dy)), r2(Math.max(...e.dy))],
    maxTilt: { real: Math.round(Math.max(...real.map(tilt))), ghost: Math.round(Math.max(...ghost.map(tilt))) },
    endTilt: { real: Math.round(tilt(real[real.length - 1])), ghost: Math.round(tilt(ghost[ghost.length - 1])) },
  };
}

/** Run `each(dt)` before every step of w's game until it returns false (or secs pass). */
function drive(ctl, secs, each) {
  return new Promise((resolve) => {
    const t0 = now();
    let last = t0;
    ctl.each = () => {
      const t = now(), dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      if ((t - t0) / 1000 > secs || each(dt) === false) {
        ctl.each = null;
        Object.assign(ctl.inp, idle());
        resolve();
      }
    };
  });
}

/** Throttle / brake to hold speed v (m/s), a PI controller. */
function hold(inp, car, v, dt) {
  const e = v - car.vF;
  inp.i = Math.max(-1, Math.min(1, (inp.i || 0) + e * dt * 0.5));
  const u = e * 1.5 + inp.i;
  inp.throttle = Math.max(0, Math.min(1, u));
  inp.brake = u < -0.3 ? Math.min(1, -u * 0.3) : 0;
}

/** Put a player's own car at (x, z) facing yaw, invulnerable and with the flip rule as usual; wait for the ghosts. */
async function place(s, who, x, z, yaw) {
  const car = s[who].game.car;
  car.teleport({ x, z, yaw });
  await sleep(600);
}

/** Make both players' cars unbreakable for the test (damage is still counted in `hits`). */
function armour(s) {
  for (const k of ['A', 'B']) {
    const car = s[k].game.car;
    if (car._realDamage) continue;
    car._realDamage = car.applyDamage;
    car.hits = [];
    car.applyDamage = function (dmg, ...rest) {
      this.hits.push(r1(dmg));
      const hp = this.health;
      this._realDamage(dmg, ...rest);
      this.health = Math.max(hp - dmg, 30); // never wrecked here
    };
  }
}

/** Test ground: A off the big ramp at full throttle (the lip at ~100 km/h); A's car vs its ghost on B's screen. */
export async function jump(s) {
  const A = s.A.game;
  await place(s, 'B', 150, 140, 0);
  await place(s, 'A', -15, -100, 0);
  let lip = null, air = 0, landKmh = null;
  const rec = await record(s, s.ids.A, () =>
    drive(s.a, 9, (dt) => {
      const car = A.car;
      if (car.z < -31) s.a.inp.throttle = 1;
      else {
        if (lip == null) lip = r1(car.speed * KMH);
        Object.assign(s.a.inp, idle());
      }
      if (car.rb.contacts === 0) air += dt;
      else if (air > 0.2 && landKmh == null) landKmh = r1(car.speed * KMH);
      return !(car.z > 35 || (landKmh != null && car.speed < 1));
    }),
  );
  const pitch = (p) => Math.asin(Math.max(-1, Math.min(1, 2 * (p.q[3] * p.q[0] - p.q[1] * p.q[2])))) * DEG;
  const lo = (series) => Math.round(Math.min(...series.map(pitch)));
  const hi = (series) => Math.round(Math.max(...series.map(pitch)));
  return { lipKmh: lip, airS: r2(air), pitch: { real: [lo(rec.A), hi(rec.A)], ghost: [lo(rec.B), hi(rec.B)] }, ...compare(rec, 'A', 'B') };
}

/** Test ground: A with its left wheels up the big ramp at kmh: rolls over, lies there, rights itself (the flip rule). */
export async function rollover(s, { kmh = 70, x = -21.6 } = {}) {
  const A = s.A.game;
  await place(s, 'B', 150, 140, 0);
  await place(s, 'A', x, -110, 0);
  let tipped = null, righted = null;
  const t0 = now();
  const rec = await record(s, s.ids.A, () =>
    drive(s.a, 14, (dt) => {
      const car = A.car;
      if (car.z < -45 && tipped == null) hold(s.a.inp, car, kmh / KMH, dt);
      else Object.assign(s.a.inp, idle());
      if (tipped == null && car.upY < 0.5) tipped = r2((now() - t0) / 1000);
      if (tipped != null && righted == null && car.rb.righting) righted = r2((now() - t0) / 1000);
      return !(righted != null && !car.rb.righting && car.upY > 0.95 && car.speed < 0.5);
    }),
  );
  // when each screen first showed the car past 60° and back upright
  const when = (series, f) => {
    const p = series.find(f);
    return p ? r2((p.t - t0) / 1000) : null;
  };
  const times = (series) => {
    const over = when(series, (p) => tilt(p) > 60);
    return { over60: over, upright: over == null ? null : when(series, (p) => p.t - t0 > over * 1000 + 300 && tilt(p) < 10) };
  };
  return { tippedAt: tipped, rightingAt: righted, real: times(rec.A), ghost: times(rec.B), ...compare(rec, 'A', 'B') };
}

/**
 * Test ground: B's car parked across the lane, A drives into its side at each speed. On both screens: A's speed after
 * the hit, B's speed and lean (its own car on B's screen, its ghost on A's), the damage (B computes none: A sends it),
 * and how B's knock came: its own solver's share and the event's (Vehicle.netKnock).
 */
export async function ram(s, { speeds = [40, 60, 100] } = {}) {
  const A = s.A.game, B = s.B.game;
  armour(s);
  const out = [];
  const rbB = B.car.rb ?? {}; // (no knocks to log on the old physics)
  const log = [];
  const nk = rbB.netKnock?.bind(rbB), lk = rbB.localKnock?.bind(rbB);
  if (nk) {
    rbB.netKnock = (o, dv, dw) => {
      log.push({ k: 'event', dv: r2(dv.length()), t: now() });
      nk(o, dv, dw);
    };
    rbB.localKnock = (o) => {
      log.push({ k: 'local', dv: r2(rbB.knockV.length()), t: now() });
      lk(o);
    };
  }
  for (const kmh of speeds) {
    B.car.health = A.car.health = 100;
    await place(s, 'B', 170, 60, Math.PI / 2);
    await place(s, 'A', 170, -100, 0);
    log.length = 0;
    B.car.hits.length = 0;
    let hitAt = null, aBefore = 0, aAfter = null, where = null;
    const ghostB = carIn(s.A, s.ids.B);
    const rec = await record(s, s.ids.B, () =>
      drive(s.a, 25, (dt) => {
        const car = A.car;
        if (hitAt == null) {
          hold(s.a.inp, car, kmh / KMH, dt);
          if (kmh >= 120) s.a.inp.throttle = 1;
          aBefore = car.speed * KMH;
          if (car.z > 56) {
            hitAt = now();
            where = { A: [r2(car.x), r2(car.z)], ghostB: [r2(ghostB.x), r2(ghostB.z), r2(ghostB.yaw)], B: [r2(B.car.x), r2(B.car.z), r2(B.car.yaw)] };
          }
        } else {
          Object.assign(s.a.inp, idle());
          if (aAfter == null && now() - hitAt > 400) aAfter = car.speed * KMH;
        }
        return hitAt == null || now() - hitAt < 2500;
      }),
    );
    const thrown = (series) => Math.round(Math.max(...series.filter((p) => p.t > hitAt - 200).map((p) => p.kmh)));
    out.push({
      kmh: Math.round(aBefore),
      where,
      rammerKmhAfter: Math.round(aAfter ?? -1),
      victimThrownKmh: { own: thrown(rec.B), ghost: thrown(rec.A) },
      victimLean: { own: Math.round(Math.max(...rec.B.map(tilt))), ghost: Math.round(Math.max(...rec.A.map(tilt))) },
      victimDamage: B.car.hits.slice(),
      victimHpSeenByA: r1(ghostB.health),
      victimHpOwn: r1(B.car.health),
      knocks: log.map((e) => `${e.k} ${e.dv} @${Math.round(e.t - hitAt)}ms`),
      ...compare(rec, 'B', 'A'),
    });
  }
  if (nk) {
    rbB.netKnock = nk;
    rbB.localKnock = lk;
  }
  return out;
}

/**
 * B's car put right onto A's parked car (a respawn onto it): how fast either car gets on either screen over 3 s, and
 * whether the ghosts let go of each other (Vehicle.ghostDeep). Without that both cars sped up together to 276 km/h.
 */
export async function overlap(s, { dz = 1.3 } = {}) {
  const A = s.A.game, B = s.B.game;
  await place(s, 'A', 170, 60 + dz, 0);
  await place(s, 'B', 120, 140, 0);
  const top = { A: 0, B: 0, ghostA: 0, ghostB: 0 };
  let through = { onA: false, onB: false };
  const ha = () => {
    top.A = Math.max(top.A, A.car.speed * KMH);
    top.ghostB = Math.max(top.ghostB, carIn(s.A, s.ids.B).speed * KMH);
    through.onA ||= carIn(s.A, s.ids.B).rb.through;
  };
  const hb = () => {
    top.B = Math.max(top.B, B.car.speed * KMH);
    top.ghostA = Math.max(top.ghostA, carIn(s.B, s.ids.A).speed * KMH);
    through.onB ||= carIn(s.B, s.ids.A).rb.through;
  };
  s.a.hooks.add(ha);
  s.b.hooks.add(hb);
  B.car.teleport({ x: 170, z: 60, yaw: Math.PI / 2 });
  await sleep(3000);
  s.a.hooks.delete(ha);
  s.b.hooks.delete(hb);
  const at = (c) => [r1(c.x), r1(c.z)];
  return {
    topKmh: Object.fromEntries(Object.entries(top).map(([k, v]) => [k, Math.round(v)])),
    through,
    end: { A: at(A.car), B: at(B.car), ghostAonB: at(carIn(s.B, s.ids.A)), ghostBonA: at(carIn(s.A, s.ids.B)) },
    stillThrough: { onA: carIn(s.A, s.ids.B).rb.through, onB: carIn(s.B, s.ids.A).rb.through },
  };
}

/**
 * B's car rolled onto its roof (or its side: roll 90), B's page reloads within the flip rule's 1.5 s, the race resumes:
 * where B's car is and how it lies before and after, on both screens; then it rights itself.
 */
export async function reconnect(s, { roll = 180 } = {}) {
  const B = s.B.game;
  await place(s, 'B', 30, 120, 0.4);
  const rb = B.car.rb, b = rb.body, t = b.translation();
  const q = new (rb.quat.constructor)().setFromAxisAngle({ x: 0, y: 0, z: 1 }, (roll * Math.PI) / 180);
  q.premultiply(new (rb.quat.constructor)().setFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.4));
  b.setTranslation({ x: t.x, y: t.y + 1.5, z: t.z }, true);
  b.setRotation(q, true);
  await sleep(1000); // fallen and lying; snapshots sent
  const before = pose(B.car);
  const ghostBefore = pose(carIn(s.A, s.ids.B));
  // the session the reloaded page resumes is the last one stored, and both frames share the storage: B's
  s.A.game.lobby._remember = () => {};
  B.lobby._remember();
  frame('b').contentWindow.location.reload();
  const t0 = now();
  await sleep(500);
  await until(() => frame('b').contentWindow.game?.net && frame('b').contentWindow.game.state === 'play', 20000, 'B back in the race');
  const back = r2((now() - t0) / 1000);
  s.B = frame('b').contentWindow;
  s.b = control(s.B);
  const B2 = s.B.game;
  const after = pose(B2.car);
  const ghostAfter = pose(carIn(s.A, s.ids.B));
  // then the flip rule: still for 1.5 s, then righting
  let rightedAfter = null;
  const t1 = now();
  await drive(s.b, 8, () => {
    if (rightedAfter == null && B2.car.rb.righting) rightedAfter = r2((now() - t1) / 1000);
    return !(rightedAfter != null && !B2.car.rb.righting && B2.car.upY > 0.95);
  });
  await sleep(500);
  const fmt = (p) => ({ x: r2(p.x), y: r2(p.y), z: r2(p.z), up: r2(p.up) });
  return {
    resumedAfterS: back,
    ownBefore: fmt(before),
    ownAfter: fmt(after),
    ghostOnABefore: fmt(ghostBefore),
    ghostOnAAfter: fmt(ghostAfter),
    rotChangeDeg: r1(qAngle(before.q, after.q)),
    rightingStartedAfterS: rightedAfter,
    endUp: { own: r2(B2.car.upY), ghostOnA: r2(carIn(s.A, s.ids.B).upY) },
    crashes: [s.A.crash?.entries?.length ?? 0, s.B.crash?.entries?.length ?? 0],
  };
}

/**
 * Crew (setup({ gunner: true })): B in A's gun. A's car lies as `pose` says ('level', 'ramp' — parked across the big
 * ramp's slope, 'side', 'roof'); B turns the turret to each world heading and fires. The barrel's direction on B's
 * screen (the ghost) vs the heading asked for and vs A's screen (the real body, with the turret angle B sent); the shell
 * as A's screen got it.
 */
export async function gunner(s, { poses = ['level', 'ramp', 'side', 'roof'], headings = [0, 90, 200] } = {}) {
  const A = s.A.game, B = s.B.game;
  armour(s);
  const out = [];
  const shots = [];
  const fire = A.artillery.fire.bind(A.artillery);
  A.artillery.fire = (car, shot) => {
    if (shot) shots.push(shot);
    return fire(car, shot);
  };
  for (const p of poses) {
    if (p === 'ramp') await place(s, 'A', -15, -38, Math.PI / 2);
    else await place(s, 'A', 40, 110, 0.3);
    const rb = A.car.rb, b = rb.body;
    if (p === 'side' || p === 'roof') {
      const t = b.translation();
      const Q = rb.quat.constructor;
      const q = new Q().setFromAxisAngle({ x: 0, y: 0, z: 1 }, p === 'side' ? Math.PI / 2 : Math.PI).premultiply(new Q().setFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.3));
      b.setTranslation({ x: t.x, y: t.y + (p === 'side' ? 1.3 : 1.8), z: t.z }, true);
      b.setRotation(q, true);
    }
    // keep it lying there: no flip rule during the test
    const stay = () => (rb.tippedT = -1e9);
    s.a.hooks.add(stay);
    await sleep(1500);
    for (const hd of headings) {
      B.aimYaw = (hd * Math.PI) / 180;
      await sleep(700); // the turret angle reaches A
      const mB = B.car.muzzle(), mA = A.car.muzzle();
      const ang = (m) => (Math.atan2(m.dx, m.dz) * DEG + 360) % 360;
      const between = (m, n) => Math.acos(Math.max(-1, Math.min(1, m.dx * n.dx + m.dy * n.dy + m.dz * n.dz))) * DEG;
      shots.length = 0;
      B.car.reload = 0;
      s.b.inp.fire = true;
      await sleep(100);
      s.b.inp.fire = false;
      await sleep(400);
      const sh = shots[0];
      out.push({
        pose: p,
        tiltDeg: Math.round(Math.acos(Math.max(-1, Math.min(1, A.car.upY))) * DEG),
        askedDeg: hd,
        barrelOnB: { headingDeg: r1(ang(mB)), slopeDeg: r1(Math.asin(mB.dy) * DEG) },
        barrelOnA: { headingDeg: r1(ang(mA)), slopeDeg: r1(Math.asin(mA.dy) * DEG) },
        barrelDiffDeg: r1(between(mA, mB)),
        shellOnA: sh ? { headingDeg: r1(ang(sh)), diffFromRealBarrelDeg: r1(between(sh, mA)), fromM: r2(Math.hypot(sh.x - mA.x, sh.y - mA.y, sh.z - mA.z)) } : null,
      });
    }
    s.a.hooks.delete(stay);
    rb.tippedT = 0;
  }
  A.artillery.fire = fire;
  return out;
}

/**
 * Ordinary driving: every car the host's bots drive (city: setup({ query: '?mute', bots: 7 })), on the host's
 * screen vs its ghost on B's, over secs. Position and rotation errors over all of them.
 */
export async function follow(s, { secs = 15 } = {}) {
  const ids = s.A.game.rivals.map((r) => r.car.netId);
  const rec = { A: [], B: [] };
  const hooks = ['A', 'B'].map((k) => {
    const h = () => {
      const t = now();
      for (const id of ids) {
        const c = carIn(s[k], id);
        if (c && !c.wrecked) rec[k].push({ id, t, ...pose(c) });
      }
    };
    s[k.toLowerCase()].hooks.add(h);
    return [s[k.toLowerCase()], h];
  });
  await sleep(secs * 1000);
  for (const [ctl, h] of hooks) ctl.hooks.delete(h);
  const out = { cars: ids.length, kmh: Math.round(rec.A.reduce((a, p) => a + p.kmh, 0) / (rec.A.length || 1)) };
  const dp = [], dq = [];
  for (const id of ids) {
    const r = { A: rec.A.filter((p) => p.id === id), B: rec.B.filter((p) => p.id === id) };
    if (r.A.length < 10 || r.B.length < 10) continue;
    const c = compare(r, 'A', 'B');
    dp.push(c.posErrM.mean);
    dq.push(c.rotErrDeg.mean);
    out[id] = { pos: c.posErrM, rot: c.rotErrDeg };
  }
  out.meanPosErrM = r2(dp.reduce((a, b) => a + b, 0) / (dp.length || 1));
  out.meanRotErrDeg = r2(dq.reduce((a, b) => a + b, 0) / (dq.length || 1));
  return out;
}

/** The size of A's snapshots ('s' messages) over secs: per message, per car row, per second; and the old format's. */
export async function bandwidth(s, { secs = 5 } = {}) {
  const g = s.A.game, c = g.lobby.client;
  const send = c.send.bind(c);
  const sizes = [], rows = [], old = [], oldRows = [];
  c.send = (msg) => {
    if (msg.t === 's') {
      sizes.push(JSON.stringify(msg).length);
      for (const r of msg.c) rows.push(JSON.stringify(r).length);
      const o = msg.c.map((r) => oldRow(g, g.net.car(r[0]), r));
      for (const r of o) oldRows.push(JSON.stringify(r).length);
      old.push(JSON.stringify({ ...msg, c: o }).length);
    }
    send(msg);
  };
  await sleep(secs * 1000);
  c.send = send;
  const avg = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / (xs.length || 1));
  const out = { messages: sizes.length, cars: rows.length / (sizes.length || 1), bytesPerMessage: avg(sizes), bytesPerRow: avg(rows), bytesPerSecond: Math.round(sizes.reduce((a, b) => a + b, 0) / secs) };
  out.old = { bytesPerMessage: avg(old), bytesPerRow: avg(oldRows), bytesPerSecond: Math.round(old.reduce((a, b) => a + b, 0) / secs) };
  return out;
}

/** The same car's row in the format before session 4: [id, x, z, yaw, vx, vz, angVel, steer, health, flags, …]. */
function oldRow(g, car, r) {
  const [id, , , , , , , , , , , , , flags, lap, next, passed, kills, , , timeLeft] = r;
  return [id, r2(car.x), r2(car.z), r2(car.yaw), r2(car.vx), r2(car.vz), r2(car.angVel), r2(car.steer), r2(car.health), flags & 31, lap, next, passed, kills, r2(car.accel || 0), r2(car.turretYaw), timeLeft];
}
