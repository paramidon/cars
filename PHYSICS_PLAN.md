# Car physics on Rapier: plan

Replace the car physics with a real 3D rigid-body engine, **Rapier** (`@dimforge/rapier3d-compat`). Today the
cars use a hand-written 2D model: three circles on the XZ plane. A vertical layer with special-case patches was
tried on top of it, and this plan replaces that approach.

The work is split into **sessions**. Each session is one request to Claude Code, started fresh with the prompt
given below. Run them in order. At the end of every session, tick its checkbox in the
[Status](#status) section and commit.

- **Branch:** `claude/rapier-physics`, created from `master`. Every session works and commits here. Don't commit
  to `master` or to `claude/carmageddon-game-prototype-m0zs5f`.
- **Reference branch:** `claude/test-verticals`. It holds the previous patch-based attempt, which is not merged
  and is not the base for this work. Use it only as a source of:
  - **test-ground layouts:** ramps, the underground tube, the raised deck and pads, in `verticals()` in
    `src/world/city.js`;
  - **behaviours to reproduce:** jumps, landing nose-first, rolling over when one side drives up a ramp,
    self-righting, the flight bonus;
  - **browser test scripts** (sweeps) to reuse as acceptance tests.

  Do **not** port its physics code: `VERT`, `passesVert`, `topAt`/`y0` colliders, the `entry` ramp edge, the
  suspension in `car.js`.

## Status

- [x] Session 1: spike on the test ground (go/no-go) — **GO**
- [x] Session 2: whole world and all cars on Rapier, handling tuned
- [x] Session 3: damage, rams, props, pedestrians, weapons in 3D
- [x] Session 4: networking
- [x] Session 5: bots on the new physics
- [x] Session 6: remove the old physics, docs, performance
- [x] Session 7 (optional): carry over the non-physics changes from `claude/test-verticals`

## Why

The current model can't represent a car that is tilted, airborne, on its side or on its roof:

- **Collisions are 2D.** Walls, buildings and other cars only push the car in the XZ plane, so a hit never
  pitches or rolls the body.
- **Height is patched on separately.** Height, pitch and roll come from separate rules: per-wheel springs,
  "hull points", per-collider tops, eased push-outs. Every new situation needs another rule, such as half on a
  ledge, tipping off an edge, or lying against a ramp's side.
- **Car-vs-car is circle-vs-circle.** Height is ignored.
- **The network can't show it.** Snapshots carry only `x, z, yaw, vx, vz, angVel, steer, health`, so other
  players never see a car jump, tilt or flip.

With a rigid-body engine, collisions, gravity, rotation, suspension and resting on any side are solved in one
system. The game only adds **game rules** on top: arcade handling, damage, self-righting.

## Target architecture

- **Rapier world** (`src/physics/rapier.js`). It is created once after `await RAPIER.init()`, so the game boot
  in `main.js` becomes async. Fixed step 1/120 s (as today): accumulate frame time and step N times.
- **Static colliders.** They are built from the same deterministic city data, so every client gets the same
  world:
  - the ground: a plane, or cuboids with holes for the tube trenches;
  - buildings and the boundary wall: cuboids;
  - poles, trees, pillars, the fountain: cylinders;
  - test-ground ramps, the deck and the tube: convex hulls or trimeshes.
- **Breakable props** are sensors, or fixed bodies removed on hit, keeping today's `Breakables.hit()` flow.
- **Car = dynamic rigid body.** It uses a compound collider: lower body box plus cabin box. Mass and centre of
  mass are set explicitly, with the centre of mass low (about 0.5–0.6 m above the ground).
- **Suspension and wheel contact** come from Rapier's `DynamicRayCastVehicleController`: four wheels, ray-cast
  suspension.
- **Arcade layer (hybrid).** Each step, while wheels touch the ground, our code turns input into forces and
  velocity changes in the car's local frame. That keeps today's feel and numbers: thrust curve, brake,
  GTA-like steering (`yawCap`, `steerTime`, `yawResp`, `yawUnwind`), lateral grip and handbrake slide
  (`grip`, `hbGrip`, `slideRecover`). With no wheels on the ground the arcade layer is off and the car is
  purely physical.
- **Damage** comes from contact-force events (`ActiveEvents.CONTACT_FORCE_EVENTS`), mapped to the existing
  rules: wall damage threshold and scale, front armour, `carHitDamage` zones, the landing damage threshold.
- **Flipped car** is a game rule, not physics. If its up vector is below about 0.5 and it is nearly still for
  1.5 s, it rolls back onto its wheels: an applied torque or a scripted rotation, with the «НА КОЛЁСА!» popup.
  `R` (unstuck) also puts it back on its wheels.
- **Remote cars (network)** are kinematic bodies (`kinematicPositionBased`) driven by interpolated snapshots
  with full position and rotation. Local cars collide with them. Damage and knock-back for the victim are sent
  to its owner as an event, as today.
- **Stays on the 2D grid**, with heights from the car's real pose:
  - pedestrians;
  - shell and bullet ray casts;
  - camera occlusion;
  - bot navigation.

  The pedestrian–car contact uses the car's oriented box from its quaternion, not the flat yaw rectangle.
- **Stays exactly as it is:**
  - owner-authoritative netcode, so determinism is **not** required;
  - the single-file build;
  - `mangle: false`;
  - version gating.

## Rules for every session

- Read `CLAUDE.md` and the relevant README sections first. Write docs, comments and commit messages in English
  (existing Russian code comments stay). Talk to the user in Russian.
- Work on `claude/rapier-physics` and commit at the end of the session with a descriptive message.
- `npm run build` must pass. `dist/cars-and-guts.html` must stay a single self-contained file: Rapier's WASM
  has to be inlined (the `-compat` package embeds it as base64).
- Verify in the browser with `?mute`, through `window.game`, `game.step(dt)` and `game.debugState()`, as the
  previous sessions did. Report numbers, not impressions.
- If port 5173 is busy (another session's dev server), add a temporary `.claude/launch.json` entry on another
  port. Revert it before committing.
- Keep the README in sync: gameplay rules and exact numbers.
- At the end, tick the session in [Status](#status) and add short notes under
  [Session notes](#session-notes): decisions, measured numbers, open problems.

---

## Session 1: spike on the test ground (go/no-go)

**Model:** Claude Opus 5.5 (`claude-opus-5-5`). This session makes the architecture decisions.

**Prompt:**

> Do Session 1 of PHYSICS_PLAN.md on branch claude/rapier-physics.

**Scope**

1. Add `@dimforge/rapier3d-compat` (pin an exact version). Make the boot async (`await RAPIER.init()` before
   `new Game()`), and keep the crash reporter working if init fails.
2. Gate everything behind `?phys=rapier`, and only on the test ground (`?map=test`). The city and the network
   keep the old physics in this session.
3. `src/physics/rapier.js`: the world, a fixed-step loop and static colliders for the test ground (ground,
   wall, the two buildings).
4. Rebuild the test-ground vertical structures from `claude/test-verticals` (`verticals()` in
   `src/world/city.js`) as meshes plus Rapier colliders:
   - the big ramp and the three kickers;
   - the jump ramp over the tube's exit trench;
   - the underground tube (open trenches with holes in the ground mesh, covered section, rails, lights);
   - the 6 m deck with its ramp;
   - the boost and catapult pads.

   Take the geometry, not the old physics.
5. The player's car on Rapier:
   - a compound chassis and a `DynamicRayCastVehicleController` with 4 wheels;
   - the hybrid arcade layer (first pass);
   - mesh sync from the body's position and quaternion;
   - the camera following the body (heading from velocity when the car is upside down);
   - in the tube the camera must stay under the ceiling.
6. A flip rule: self-right after 1.5 s on the side or roof, plus `R`.
7. **Measure and write into Session notes:**
   - bundle size before and after;
   - Rapier step time with 1 car and with 20 dummy cars;
   - FPS with `?q=low`, with a phone-sized viewport if possible;
   - init time.

**Acceptance**

- Straight jump off the big ramp: the nose drops after the lip and the front wheels land first.
- Two wheels up the big ramp: the car rolls, tips over at about 55–60° and lies on its side or roof. No snapping,
  no hard angle limits, no sideways pops. It self-rights after 1.5 s.
- Half on, half off the deck's edge: it either climbs on or falls off. Its body never ends up inside the deck.
- The tube, the deck ramp, the catapult over the wall and the rail stops all work. Hitting the deck's side or a
  kicker's back face from the ground is a wall.
- No errors in `crash.entries`.
- **Go/no-go:** write a recommendation in Session notes (feel, size, performance). If no-go, stop here and
  report.

## Session 2: whole world and all cars on Rapier, handling tuned

**Model:** Claude Opus 5.5 (`claude-opus-5-5`). Tuning the handling against the README numbers needs careful
iteration.

**Prompt:**

> Do Session 2 of PHYSICS_PLAN.md on branch claude/rapier-physics.

**Scope**

1. Static colliders for the whole city: buildings, wall, poles, trees, pillars, fountain, statue, pumps, curbs.
   Curbs are low boxes or a ground height step, so cars bump over them.
2. All cars (player and bots, solo) on Rapier. Make `?phys=rapier` work in the city too, still behind the flag.
3. Tune the handling to the README numbers. Write a small in-browser test that measures each one:
   - top speed about 126–130 km/h;
   - acceleration curve;
   - yaw rate at 40 / 60 / 100 / 125 km/h (about 120°/s, 107°/s, 69°/s, 56°/s);
   - handbrake slide and the ~1 s grip recovery;
   - reverse speed;
   - the speedometer matching real distance: 200 m between the test-ground grid lines (master has a 20 m grid,
     lines at multiples of 20 m).
4. Car-vs-car contact through Rapier: chassis against chassis, so a hit can pitch or roll the other car.
5. Weight, centre of mass and inertia chosen so normal city driving never tips a car (check the max lean in a
   75 s, 8-car race). Hard side hits at speed may tip.

**Acceptance**

- A table "README number vs measured" in Session notes, every line within about 5%.
- Bots still complete laps at a similar average speed: compare against old physics with the same seed, 6 runs
  of 25 s each.
- No tipping in normal city driving.

## Session 3: damage, rams, props, pedestrians, weapons in 3D

**Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`). Mostly mapping existing rules onto the new events.

**Prompt:**

> Do Session 3 of PHYSICS_PLAN.md on branch claude/rapier-physics.

**Scope**

1. Wall and obstacle damage from contact-force events. Keep the README rules:
   - threshold about 29 km/h;
   - head-on into a wall at 100 km/h costs about 45%;
   - poles, pillars and trees ×1.15;
   - front armour ×0.75;
   - the bull bar and bumper detaching;
   - deformation at the contact point.
2. Car-vs-car damage: `carHitDamage` and the zones, from the contact point and the relative velocity.
   Wreck credit and healing are unchanged. Also check the `plan.md` item about using the closing speed and the
   direction (head-on vs catching up vs side) and implement it here if it fits. Remove that item from
   `plan.md` when done.
3. Landing damage: impact above about 13 m/s costs 1.6 hull per m/s. Add damage from rolling over hard onto the
   roof.
4. Breakable props: sensors or removable bodies, `Breakables.hit()` unchanged.
5. Pedestrians: contact against the car's oriented box (quaternion), not the yaw rectangle.
   - a car flying over heads or driving in the tube under them doesn't touch them;
   - landing on them or rolling over them does;
   - knock, kill, gib and crush thresholds unchanged.
6. Shells, bullets and molotovs:
   - the muzzle comes from the body's transform, so a tilted or flipped car fires where its gun points;
   - car hits use the car's oriented box in 3D;
   - shell blasts give an impulse to nearby cars, so a close blast can tip a car.

**Acceptance**

- The README damage numbers are reproduced by measurement (table in Session notes).
- A shell blast next to a car visibly shoves and tilts it.
- The pedestrian line and the deck pedestrians react correctly to jumps (fly over vs land on them).

## Session 4: networking

**Model:** Claude Opus 5.5 (`claude-opus-5-5`). Netcode is the riskiest integration.

**Prompt:**

> Do Session 4 of PHYSICS_PLAN.md on branch claude/rapier-physics.

**Scope**

1. Snapshot rows (`'s'`, 20 Hz) add y, the rotation quaternion (quantized), linear velocity y and angular
   velocity (3 axes). Keep the row compact.
2. Remote cars are kinematic bodies. Interpolate position with slerp-ed rotation and extrapolate briefly with
   velocities. Local cars collide with them.
3. Rams: the rammer computes damage and also the knock-back impulse for the victim, and sends both in the
   `'e'` event. The owner applies the impulse to its own body.
4. Crew mode: the gunner's turret, aiming and firing on a tilted or flipped car.
5. Reconnect and resume restore the full pose (position and rotation).
6. Version gating unchanged: the build hash changes automatically.

**Acceptance**

Two browsers plus `npm run serve`:

- A jump, a rollover and self-righting look the same on both screens.
- A ram knocks and damages the victim on both screens.
- Reconnecting mid-race restores a flipped car correctly.
- Write the bandwidth before and after into Session notes (bytes per snapshot).

## Session 5: bots on the new physics

**Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`).

**Prompt:**

> Do Session 5 of PHYSICS_PLAN.md on branch claude/rapier-physics.

**Scope**

1. `Rival` and `AUTOPILOT` drive through the same input → arcade layer. Check:
   - hunt, ram and back-up;
   - the gore behaviour;
   - unstuck logic when tilted or flipped (they self-right too);
   - battle royale zone behaviour.
2. `BotGunner` aims correctly from a tilted car.
3. Remove the `?phys=rapier` flag: Rapier becomes the only path for solo, city, test ground and battle royale.

**Acceptance**

- 10 races and battles of 2 minutes each with 7 or 19 bots. No bot stuck for more than 10 s, no errors.
- Wreck and kill counts similar to before (numbers in Session notes).

## Session 6: remove the old physics, docs, performance

**Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`).

**Prompt:**

> Do Session 6 of PHYSICS_PLAN.md on branch claude/rapier-physics.

**Scope**

1. Delete the old car physics:
   - `_step`, `_collide`, `_impact`, the 2D integration in `car.js`;
   - `collideCars` / `collidePair` in `racers.js`;
   - anything in `physics/collision.js` only cars used. Keep what pedestrians, weapons, camera and AI still use.
2. Performance on a phone-sized viewport with `?q=low` and 20 cars. Write the numbers in Session notes.
3. Rewrite the README sections:
   - "Damage", "Ramming", "How it works", the tuning list (new constants: the arcade layer, mass, suspension,
     flip rule);
   - CLAUDE.md "Architecture": there is now a physics engine;
   - the test ground.
4. Final pass: `npm run build`, the single-file check, full browser verification of city, test ground and
   network.

**Acceptance**

- No dead physics code left.
- Docs describe the new system with exact numbers.
- Branch ready to merge. Ask the user before merging into `master`.

## Session 7 (optional): carry over the non-physics changes from `claude/test-verticals`

**Model:** Claude Haiku 5.5 (`claude-haiku-5-5`). Small mechanical ports. Use Sonnet if anything conflicts.

**Prompt:**

> Do Session 7 of PHYSICS_PLAN.md on branch claude/rapier-physics.

**Scope.** Changes made on `claude/test-verticals` that are not physics. Port each one only if the user still
wants it (ask first):

- pedestrians 1.85 m tall (`PED_HEIGHT`, scaled model);
- respawn 15 s / 50 m everywhere (`RESPAWN`);
- the white 100 m grid on the test ground;
- the flight bonus «ПОЛЁТ N С» (10 points per 0.1 s from 0.8 s);
- boost / catapult popups.

## Session notes

_Each session appends its notes here: decisions, measurements, problems left for later._

### Session 1 (2026-10-09): spike on the test ground — GO

**Recommendation: go.** Jumps, nose-first landings, rollovers and resting on the side or roof come out of the
physics with no special cases. The handling numbers are unchanged, because both paths run the same code. The physics
costs 0.27 ms per frame for 20 cars on desktop. The price is +2.2 MB of bundle (+0.85 MB gzip) and 20–50 ms more at
boot.

**Decisions**

- **Package:** `@dimforge/rapier3d-compat` pinned at **0.19.3**, not the newest 0.21.0. The 0.21 module is 4.3 MB
  (WASM 3.0 MB), 0.19.3 is 2.2 MB (WASM 1.57 MB), and everything used here is the same in both.
- **Flag:** `PHYS_RAPIER` in `config.js` is `?map=test&phys=rapier`. Rapier is always in the bundle (static import),
  but `RAPIER.init()` and the world only run with the flag. The boot is async (`boot()` in `main.js`); an init failure
  goes to the crash reporter like any boot error. The vertical structures exist only with the flag.
- **World** (`physics/rapier.js`, `PHYS`):
  - gravity 20 m/s², the old arcade value: the test ground is laid out for it (at 9.81 the big ramp's jump would be
    46 m instead of 27 m);
  - fixed step 1/120 s with an accumulator, at most 8 steps per frame; the rendered pose is interpolated between
    the last two steps;
  - static colliders come from `city.solids`: plain data (boxes, convex hulls) built by `buildCity`, so `city.js`
    doesn't import Rapier. The city's wall, buildings and ground slab are already collected (unused until Session 2).
    The tube is dug into 8 m ground slabs; ramps are convex hulls whose bottom goes 0.5 m under the ground.
- **Car** (`physics/vehicle.js`, `VEH`):
  - body origin = the model's origin (the wheels' contact level), so the mesh sync is a plain copy;
  - 1200 kg, centre of mass 0.55 m up, inertia 2050 / 2250 / 600 kg·m² (pitch / yaw / roll);
  - chassis: a lower box 2.2 × 0.76 × 4.5 m (as wide as the tyres) plus a cabin box;
  - `DynamicRayCastVehicleController`: rest 0.3 m, travel 0.2 m, stiffness 50, damping 3 / 3.5. Rapier multiplies
    stiffness and damping by the mass, so the sag is g / 4k = 0.1 m (measured: suspension length 0.2 at rest).
    Tyre friction in Rapier is off (`frictionSlip` 0, side stiffness 0);
  - `recomputeMassPropertiesFromColliders()` right after creating the body. Rapier computes the mass only at the next
    step, and a body rotated before that gets NaNs. This blew up the whole world when the 20 dummies were added.
- **Arcade layer:** `Car._step` is split; the handling itself is now `Car._drive(h, inp, vF, vR)`. The old path
  integrates its result as before. The Rapier path reads vF, vR and the yaw rate from the body in the car's frame,
  runs `_drive`, and applies the difference × k, where k = (wheels on the ground / 4) × a fade from up·Y 0.6 to 0.35.
  Only the yaw part of the angular velocity is touched, so pitch and roll are free physics. Cornering acts at the
  centre of mass, so the body doesn't lean in turns (the old cosmetic body-roll spring is kept).
- **Flip rule:** up·Y < 0.5 and speed and spin below 1.5 for 1.5 s start the righting. The first version (a kinematic
  body, scripted slerp) swept the chassis up to 0.7 m into the deck when the car lay next to it. It was replaced by
  a dynamic righting: angular velocity towards upright (up to 6 rad/s, about the centre of mass, heading kept) and a
  vertical velocity that holds the centre of mass up to 0.9 m higher; walls push the body away. `R` on a tipped car
  rights it in place («НА КОЛЁСА!»); on an upright car `R` teleports as before.
- **Kept 2D for now:** street props break on contact on the Rapier path (the old circle test, above 2.5 m/s, not while
  in the air) and don't stop the car. Pedestrians, shells, bullets and camera occlusion are unchanged.
- **Not ported:** the flight bonus, pad popups and the 100 m grid (Session 7).
- **Debug:** `game.addPhysDummies(n)` adds n Rapier cars driving in circles (used for the 20-car numbers).

**Measurements** (this PC, Chromium in the app's browser pane)

| What | Old physics | Rapier |
| --- | --- | --- |
| JS bundle (gzip) | 985 KB (241 KB) | 3238 KB (1089 KB) |
| `dist/cars-and-guts.html` | 1890 KB | 4090 KB (WASM inlined, no extra files) |
| `RAPIER.init()` | — | 13 ms warm, 61 ms cold |
| Game ready, prod single file | 111 ms warm | 128–147 ms warm, 272 ms cold |
| Physics step, 1 car (world.step) | — | 0.029 ms (0.016), 0.06 ms per frame |
| Physics step, 20 cars (world.step) | — | 0.136–0.153 ms (0.047), 0.27 ms per frame |
| Frame cost `?q=low`, 375×812, 1 car | — | 1.1 ms (p99 2.6) |
| Frame cost `?q=low`, 375×812, 20 cars | — | 1.98 ms (p99 3.1) |

"Frame cost" is step + render + `gl.finish()` per frame, measured by hand. Real FPS couldn't be measured: the browser
pane was hidden (requestAnimationFrame paused), and this is desktop hardware anyway. Measure on a phone in Session 6.

Handling is unchanged: 0 → 1 / 2 / 3 / 9 s gives 42.9 / 76.9 / 99.2 / 125.5 km/h on both paths. Yaw rate at
40 / 60 / 100 / 125 km/h: Rapier 119 / 106 / 69 / 58 °/s, old 121 / 108 / 70 / 60. Body lean on full lock: 0.1°.

**Acceptance**

- **Big ramp, straight:** lip at 108 km/h, pitch +10.7° at the lip → −18.4° at touchdown, front wheels first, lands at
  z = −0.7 (in the line of 50). At 83 km/h: −26.7°, front first. The car settles level.
- **Two wheels up the big ramp** (10 runs, both sides, 40–100 km/h, offsets ±0.6 m): rolls smoothly and tips past
  ~59° (static tipping angle between 58° and 60°), lies on its side (64–90°) or roof; at 70–100 km/h it
  barrel-rolls. Largest sideways move 0.04 m per frame at 40 km/h (0.076 at 100 km/h, the roll's own speed), no pops.
  Every run rights itself 1.5 s after stopping.
- **Deck edge,** 156 runs: 60 up the deck ramp near its sides steering off, 36 off the deck's edges in all directions at
  8 and 20 km/h, 60 sliding sideways off the ramp next to the deck's front face. No chassis corner got more than
  0.123 m inside a ramp, the deck or the ground (contact slop). Given time, all of them end upright.
- **Walls:** the deck's side at 60 km/h, a kicker's back face at 50 km/h and a rail at 40 km/h all stop the car at
  the face. Tube at 60 km/h: drives through, floor at −5.59 m, camera never above −1.1 m (ceiling −0.6 m).
  Catapult at 60 km/h: lowest chassis corner 6.57 m over the 4.5 m wall, lands upright. The exit-trench jump clears
  the trench from 79 km/h. Kickers after the boost pad: 130 km/h, 0.4–0.6 s flights, front-first landings.
- `crash.entries` stayed empty in every run. Rapier's init prints one `console.warn` ("using deprecated parameters
  for the initialization function"); it comes from the package itself.

**Open problems**

- No damage, sparks or sound from walls and landings on the Rapier path (Session 3, contact-force events).
- Pedestrians are still hit in 2D: flying over the line of 50 still kills them (Session 3).
- The nose dive off a lip is strong (about 50°/s at g = 20, touchdown at −18…−27°). Fine for now; Session 2 may
  want more pitch inertia or a little air stabilisation.
- Tyre marks and bloody tracks are skipped where a wheel's contact isn't at `city.groundHeight` (ramp slopes, the
  tunnel floor), because fx draws them flat on the ground.
- Car-vs-car contact exists only between Rapier bodies (the dummies); `collideCars` still runs for the old cars.

### Session 2 (2026-10-09): whole world and all cars on Rapier

**Result:** with `?phys=rapier` every car (mine and the bots, solo) is a Rapier body, in the city and on the test
ground. The handling numbers are identical to the old physics, bots keep their pace, driving never tips a car, and a
hard side hit can.

**Decisions**

- **Flag:** `PHYS_RAPIER` is now `?phys=rapier` alone (city or test ground). The vertical structures still exist only on
  the test ground. Network play isn't on Rapier yet (session 4), so with the flag the «СЕТЕВАЯ ИГРА» button is hidden.
- **City colliders** (`city.solids`):
  - every block (sidewalk and lot) and the outer sidewalk ring are curb-high steps, built as convex hulls with their
    edges bevelled over 0.3 m (`curbSolid`, `CURB_BEVEL`). Plain boxes didn't work: a wheel's ray that grazes the
    curb's vertical face gets that face's sideways normal, and Rapier pushes the suspension force (51 kN) along it, so
    a car crawling at 3 km/h stopped dead with its rear wheels on the curb line;
  - poles, trees, pillars, the fountain, the statue, the planters and the pumps come from the 2D colliders in one pass
    at the end of `buildCity`: a circle becomes an upright cylinder (`{ cyl }`, new in `Physics.addSolid`), a box a
    cuboid, from the ground up to the collider's `h`. Breakable props stay non-solid (2D smash, as in session 1).
- **All cars:** `Game._addBody()` gives the main car and all 19 rivals a `Vehicle`. Rivals not in the lineup are taken
  out of the world (`Vehicle.setActive` → `body.setEnabled(false)`). On Rapier the city's menu starts from the solo
  lineup (`_resetWorld()` at boot); otherwise all 19 rivals' bodies would start piled on 8 grid slots.
- **Moving cars:** `Car.teleport(sp)` (respawn, unstuck, `Rival.respawn`) and `Car.nudge(dvx, dvz, dw)` (shell recoil
  and blast shove, pedestrian hits) work on both paths; on Rapier writing `car.x` or `car.vx` does nothing.
- **Car vs car:** `collideCars` is off on Rapier; the chassis collide as bodies. Car colliders have
  `COLLISION_EVENTS`; `Physics._carContacts()` turns a started contact between two cars into the old
  `onCarHit(a, b, impact, px, pz, nx, nz)`: the normal and point come from the contact manifold, and `impact` is the
  closing speed along the normal at that point, from the velocities *before* the step (`Vehicle.pointVelPrev`). So
  ram damage, sparks, sounds, the ram popup and the bots' back-up keep working. Ram damage measured on a parked car
  (side hit): 40 / 60 / 80 / 100 / 125 km/h → −19 / −36 / −48 / −54 / −61 (README: −20, −36, −48, −55).
- **Obstacles: chassis shape, friction, grip.** With session 1's box chassis the bots got stuck about four times as
  often and drove 13% slower. Three causes, each fixed and measured with `obstacle()` (a bot-like driver aiming 10 m
  behind a pole it starts 15 m in front of, 32 runs at offsets ±0.2…2 m and angles 0…60°):
  - a square corner or a flat nose snags where the old round-ended car (circles of 1 m) glanced off. The lower body's
    ends are now semicircles seen from above (`VEH.lower.corner` = 1.1 m, half its width; `roundedBox`);
  - friction: the old physics pushed a car out of an obstacle by moving it, which no friction could hold back. On
    Rapier, pushing into a pole 0.2 m off-centre, the sideways part of the thrust (~1.8 m/s²) is less than friction
    (~3.9 m/s²), so the car stuck there. Walls, buildings, poles, trees, pillars, the fountain, the statue, pumps and
    rails now have friction 0.1 (`PHYS.wallFriction`, the `OBSTACLES` kinds); the ground keeps 0.5. Car bodies: 0.3,
    `Min` combine rule;
  - grip: the contact turned the car's forward speed into sideways speed, and the arcade grip took that away at once,
    so it stayed pinned. While the chassis touches an obstacle (`Vehicle.leans`, kept from collision events), only
    `VEH.leanGrip` = 0.25 of the sideways grip is applied.

  Result: 0 of 32 runs stuck on the pole (old physics: 8 stuck, all eventually got round; Rapier before: 16 stuck,
  8 never got round). Glancing hits on a wall (`wallScrape()`) keep more speed than on the old physics, where a car hit
  at 45° stayed pinned nose-first (100 km/h at 45°: 0.3 s later 55 km/h, old 17); the Rapier car slides along it.
- **Yaw rate:** the body's angular damping (0.3/s) took ~1.5% off the yaw rate. The arcade layer now pre-compensates
  it, and the yaw rates match the old physics to 0.1°/s.
- **Tripping** (new rule, `VEH.tripAccel` / `trip` / `tripTime`): grip still acts at the centre of mass (no lean in
  turns). But for 0.4 s after a hit (a car contact or `kick()`), grip deceleration above 40 m/s² (the hardest turn
  needs ~35) acts ×1.5 at the wheels' contact, below the centre of mass, and rolls the car towards where it was sliding.
  Without it a 125 km/h T-bone leaned the victim 4°. Only the sideways speed the hit itself gave the car can trip it
  (`tripV`, from the velocity change over the hit's step). With a plain time window, a car already spinning out at
  100 km/h rolled over after a light tap. ×2 tipped a car in 7 of 20 races once the chassis became round-ended (it
  throws a car sideways harder in a glancing car-vs-car hit), ×1.5: 2 in 40.
- **Not done here:** damage from walls, landings and props (session 3), pedestrians against the oriented box
  (session 3), network (session 4), bots handling flips (session 5).
- **Tests:** `tests/physics.js` is an ES module loaded into a dev-server page (`await import('/tests/physics.js')`) with
  `handling(game)`, `leanRace(game)`, `botLaps(game)`, `sideHit(game)`, `obstacle(game)`, `wallScrape(game)` and
  `rollovers(game)`. They stop the animation loop, step the game
  by hand and replace `Math.random` with a seeded one. In races my car runs on an autopilot (an `AUTOPILOT`-like
  `Rival`) and can't be wrecked; otherwise the race would end ('over') and stop every bot. After an edit, Vite serves
  a module as `…?t=…`, so `import('/src/…')` from the console may get a second copy of it: tune constants through the
  game's own objects.

**Handling: README vs measured** (`handling()`, test ground, lane x = 170; the old physics gives the same numbers in
every row)

| What | README / target | Rapier | Old |
| --- | --- | --- | --- |
| Top speed | 126–130 km/h | 126.0 | 126.0 |
| 0 → 1 / 2 / 3 / 5 / 9 s | (old physics) | 42.9 / 76.9 / 99.2 / 118.9 / 125.5 km/h | same |
| Yaw rate at 40 km/h | ~120°/s | 120.6 (at 40.6) | 120.6 |
| Yaw rate at 60 km/h | ~107°/s | 107.4 (at 60.5) | 107.4 |
| Yaw rate at 100 km/h | ~69°/s | 69.9 (at 100.1) | 69.9 |
| Yaw rate at 125 km/h | ~56°/s | 58.3 (at 120.7: full lock costs speed; `yawCap` there is 58.2) | 58.3 |
| Handbrake: 80 km/h, 0.6 s on full lock, then released | keeps sliding for ~1 s | turns 83°, peak 13.1 m/s sideways; below 1 m/s 0.6 s after release, full grip at 1.4 s (`slideRecover`) | same |
| Reverse | 11 m/s (`maxReverse`) = 39.6 km/h | 39.8 | 39.8 |
| Speedometer vs distance (200 m between grid lines, top speed) | ratio 1 | 126.0 shown, 126.0 real: 1.000 | 1.000 |
| Lean in all of the above, plus 1.5 s of handbrake on full lock at top speed | — | 0.1° | — |

**Bots** (`botLaps()`, city, 7 bots plus my car on autopilot, 25 s from the green light, seeded, 12 runs each; average
of all bots' path length over time)

| | Avg speed | Gates per run (7 bots) | Back-ups when stuck, per run | Wrecked per run |
| --- | --- | --- | --- | --- |
| Old physics | 59.6 km/h | 15.5 | 2.0 | 1.4 |
| Rapier, session 1's box chassis | 51.9 km/h | 13.3 | 8.8 | 1.4 |
| Rapier, rounded corners (r 0.9) | 61.3 km/h (an earlier run: 60.0) | 16.2 | 4.0 | 1.3 |
| Rapier, final (round ends, wall friction, lean grip) | 62.3 km/h (an earlier run: 60.9) | 16.3 | 1.3 | 0.8 |

Runs of the same configuration spread by about ±3 km/h. Note for these tests: in races my car can't be wrecked; on
the test ground `obstacle()` and `wallScrape()` make it invulnerable too, or on the old physics it wrecks itself on
the obstacle and the game stops ('over').

**Lean in races** (city, 8 cars, 75 s, final settings): `leanRace()` over 10 seeds — the largest lean per race 9–26°
(median 14°), always in pile-ups, no car tipped. `rollovers()` over 40 seeds: 2 cars rolled over, both in side
crashes — 98 km/h closing speed plus a shell blast, and two cars ramming the same car within 0.04 s at 43 km/h each,
throwing it sideways at 46 km/h.

**Side hits** (`sideHit()`, test ground, my car into the side of a parked car)

| Closing speed | 40 | 60 | 80 | 100 | 124 km/h |
| --- | --- | --- | --- | --- | --- |
| Victim's largest lean | 1° | 3° | 8° | 13° | 123° (tipped) |
| Victim thrown at | 24 | 32 | 43 | 59 | 67 km/h |

**Curbs** (a block's edge at x = 7, both ways, 2–100 km/h): every run gets over; at 2 km/h it takes a while but never
stops. Pitch at most 3.8° (0.15 m over a 2.8 m wheelbase is 3.1°), vertical speed at most 1 m/s.

**Cost** (battle royale, 20 cars, 60 s, no rendering): one world step 0.143 ms (two per frame); `game.step` 0.68 ms per
frame, the same as on the old physics (0.68 ms). `crash.entries` stayed empty in every run.

**Session 1 re-checked** after the chassis change: off the big ramp (88 km/h at the lip) the car lands front wheels
first at −25.5° and settles upright; with two wheels up the big ramp at 70 km/h it barrel-rolls and ends on its
wheels; the tube at 60 km/h works (floor −5.54 m, camera never above −1.1 m). A correction to session 1's notes: the
catapult clears the 4.5 m wall from ~65 km/h. At 60 km/h the rear wheels clip the top and the car lands on its roof.
Session 1's own code does the same (checked), so its "6.57 m at 60 km/h" was probably measured at a higher speed.

**Open problems**

- No damage from walls, landings and props on Rapier yet (session 3), so there are fewer wrecks than on the old physics.
- Pedestrians are still hit in 2D (session 3).
- Tripping is a game rule on top of the physics. Session 3's shell blasts should go through `Vehicle.kick()` (already
  the case for `Car.nudge()`), so that a close blast can tip a car.

### Session 3 (2026-10-09): damage, rams, props, pedestrians, weapons in 3D

**Result:** on `?phys=rapier` a car takes damage from walls, landings and rollovers by the old rules, rams use the
closing speed along the contact normal, props are sensors, and pedestrians, shells, bullets and bottles test the car's
box turned with its body. The old physics' numbers are unchanged (measured on both paths).

**Decisions**

- **Contact impacts, not contact-force events.** A force has to be mapped back to a speed and depends on the solver,
  while the rules are written in speeds. `Vehicle.staticHits()` runs after every step for a car whose chassis touches a
  static collider (kept from collision events in `Vehicle.statics`): for each solver contact point, the closing speed
  along the normal from the velocities the solver started from. A normal within ~53° of horizontal (`VEH.wallNormal`)
  is a wall hit and goes to the old `Car._impact` (threshold 8 m/s, ×2.4, poles/trees/columns ×1.15, front armour ×0.75,
  sparks, sound, camera shake). `HARD` also has `rail`, `deck` and `ramp`, and the tube's trench walls count as `wall`.
  Curbs never count.
- **Velocities saved after the controls** (`savePrev` moved after `preStep`) and kept for two steps (`Vehicle.pre`).
  A contact the solver sees coming (a speculative contact) can lose its speed one step before Rapier reports it as
  started, so a just-started contact takes the larger closing speed of the two steps (`Vehicle.closing`).
- **Car vs car: wait for a usable normal.** Two convex hulls meeting exactly nose to nose (two vertical edges) gave a
  vertical normal and no push on the first step, so the head-on test measured 0 km/h. `Physics._carContacts` now keeps
  a started pair pending for up to 3 steps (`PAIR_WAIT`) and fires `onCarHit` at the first step that closes along its
  normal (> 0.5 m/s).
- **Landings** (`VEH.landAir` 0.12 s, `landSafe` 13 m/s, `landScale` 1.6): the first wheel contact after a flight; the
  impact is the speed into the surface along the wheels' contact normals, taken before the springs act (in `preStep`).
  If the body comes down on a floor first (nose first off a ledge), that is the landing, from its contact points.
- **Roof and side hits** (`roofSafe` 6 m/s, `roofScale` 2.4): a floor contact while the body's up vector is less than
  0.5 along the contact normal. Sparks above 2.5 m/s, a dent at the contact point.
- **Dents in 3D:** `applyDamage(dmg, px, pz, nx, nz, py, ny)` takes an optional height and vertical push and works in
  the body's frame (`Car.toLocal` / `toWorld`: the rigid body's quaternion, or the heading on the old physics), so a
  roof hit dents the roof and a landing pushes the underbody up.
- **Props:** a sensor cylinder per breakable prop (`PROP_TYPES[…].h`, `Physics.addProps`), overlaps kept in
  `Vehicle.props`; `Car._breakProps` breaks them above 2.5 m/s. `Breakables.hit()` is unchanged except that it slows
  the car through `car.nudge`: writing `car.vx` does nothing on Rapier, so props never slowed a Rapier car before.
- **Pedestrians:** `_contact` tests the person as a vertical segment (standing, lying or flying) against the car's box
  (`Car.segHit`: 2.1 × 1.7 × 4.7 m, grown by 0.3 m). The hit speed adds the car's falling speed, so landing on someone
  hits as hard as the car falls. The old `p.cy < 2.6` checks are gone (the box has the height).
- **Weapons:** `Car.muzzle()` comes from the body's transform and returns `dy`; the barrel's slope is reduced by 4°
  (`MUZZLE_LEVEL`) so that a car pitching on its springs still fires level. Shells keep `dy`, fly in 3D and stop at any
  static collider, the ground included (`Physics.castStatic`, a ray that skips cars and sensors). Car hits are a ray
  against the car's box up to the cannon (2.2 m), grown by 0.4 m for shells (`CANNON.carHitPad`, was `carHitR`) and not
  at all for bullets. `dy` is sent with the network `fire` event. Bottles test each step of their flight against the
  box grown by 0.3 m.
- **Blasts:** `Vehicle.blast()` gives the push (`CANNON.push` × k, as before) with `VEH.blastLift` 0.1 of it upwards,
  plus `blastSpin` 1 rad/s of tilt away from the blast per m/s, through `kick()`, so the tripping rule can add to it.
  The first try, an impulse at the body's point nearest to the blast with 40% lift, flipped a parked car onto its roof
  from any blast closer than 1 m. The tilt is very sensitive near the tipping angle: `blastSpin` 1.15 already tips a
  parked car on a direct hit.
- **Not done here:** molotov bottles still meet walls in 2D; the pedestrians' side of shell and bullet ray casts is 2D,
  with the shot's length cut by the 3D hit.

**Wall damage** (`wallDamage()`, test ground, nose first into the boundary wall or a pole; hull lost)

| km/h | 25 | 30 | 40 | 60 | 80 | 100 | 125 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Wall, bull bar: Rapier | 0 | 0.6 | 5.6 | 15.7 | 25.8 | 35.3 | 45.9 |
| Wall, bull bar: old | 0 | 0.6 | 5.6 | 15.6 | 25.6 | 35.5 | 47.5 |
| Wall, no bull bar: Rapier | 0 | 0.8 | 7.5 | 20.9 | 34.4 | 47.0 | 61.2 |
| Wall, no bull bar: old | 0 | 0.8 | 7.4 | 20.8 | 34.1 | 47.3 | 63.3 |
| Pole, bull bar: Rapier / old | 0 / 0 | 0.7 / 0.7 | 6.4 / 6.4 | 18 / 18 | 29.4 / 29.4 | 40.8 / 40.8 | 54.6 / 54.6 |

The README said "nose into a wall at 100 km/h — about 45%". Both paths give 35 with the bull bar and 47 without it
((27.8 − 8) × 2.4 × 0.75); the README now gives both numbers.

**Landings and roof hits** (`landings()`, dropped level; hull lost)

| Impact, m/s | 8 | 12 | 14 | 16 | 20 | 24 |
| --- | --- | --- | --- | --- | --- | --- |
| On the wheels (rule: 1.6 × (v − 13)) | 0 | 0 | 1.6 | 4.8 | 11.2 | 17.6 |
| On the roof (rule: 2.4 × (v − 6)) | 5.2 | 14.8 | 19.6 | 24.4 | 34 | 43.6 |

On the test ground: the big ramp at top speed lands at 13.0 m/s (no damage), the catapult at 70 km/h at 18 m/s (−8),
off the deck's far edge at 60 km/h at 15.6 m/s (−4.1), the exit-trench jump at 80 km/h at 10 m/s (none).

**Rams** (`carCrashes()`, `sideHit()`, and the `plan.md` item). The closing speed is the relative velocity of the two
contact points along the contact normal, so the direction is already in it. Head-on 100 vs 80 km/h: closing 178 km/h,
−32.4 to each car (both noses, zone 0.3). Catching up at 55 on a car doing 50: 5 km/h, nothing. 60 into a parked car's
side: 60 km/h, −36.5. A 15° side swipe at 60/60: 16 km/h, nothing. `sideHit()` is unchanged from session 2 (−19 / −36
/ −48 / −54 / −61 at 40…125 km/h). The `plan.md` item is removed: it describes how the rule already works.

**Blasts** (`blasts()`, a parked car, the blast 1.5 m up by its side)

| Gap to the side | 0 m (and a direct hit) | 1 m | 2 m | 3 m |
| --- | --- | --- | --- | --- |
| Largest lean | 40° | 16° | 7° | 3° |
| Thrown at | 21 km/h | 16 | 11 | 6 |

In races (`rollovers()`, 20 seeded 8-car races of 75 s), 4 cars tipped past 60°: 3 from hard car hits (60–105 km/h
closing) and 1 from two blasts of 6 m/s each within 1.5 s. Session 2 had 2 in 40, but there blasts did no tilting.

**Pedestrians** (`pedJumps()`): off the big ramp at the line of 50, with the lip taken at 87 / 108 / 116 km/h, the car
is 0 / 0.1 / 1.4 m over the line and hits one person each time (killed, gibbed, gibbed). With the lip at 123 / 135 km/h
it is 2.6 / 4.5 m over the line and hits nobody. Through the line on the flat at 60: one killed. Up the deck ramp at
60: two of the deck's pedestrians hit. Through the tube at 60 under a pedestrian standing on its roof: nobody hit
(floor −5.5 m); on the roof at 60: hit.

**Props** (`props()`, 40 km/h): a lamp, a bin and a bench break and slow the car by 10 / 4 / 10% on both paths (on
Rapier before this session: 0%). Over a bin in the air (2.5 m up, 72 km/h): not broken.

**Weapons** (`muzzle()`, and a shot at a parked car 40 m ahead): level, the muzzle is 1.97 m up with slope 0 and a
direct hit does −20.5; nose up 2°: slope 0; 10°: 6°, and the shell flies over the car; 30°: 26°. The machine gun:
14 bullets at 30 m do −9.8 (14 × 0.7).

**Bots** (`botLaps()`, 12 runs): 58.1 km/h (session 2: 62.3, old physics: 59.6), 14.5 gates, 1.4 back-ups and 1.6
wrecked per run (session 2: 0.8, old: 1.4). Walls hurt again. `crash.entries` stayed empty in every run.

**Open problems**

- After the boost pad at 130 km/h the car lands on the second kicker nose down and rolls onto its side. Session 2's
  code does the same (checked with this session's changes stashed); session 1 noted front-first landings there.
- A head-on at 100 vs 80 km/h does −32 to each car, less than a T-bone at 60 (−36): with the bull bar the nose takes
  0.3 of the damage. Whether head-ons should hurt more is a tuning question (`CAR_HIT.zone.front`), not physics.
- A car on its roof fires into the ground under it (it fires where its barrel points).

### Session 4 (2026-10-09): networking

**Result:** `?phys=rapier` works online. Other players' cars are bodies that follow their snapshots, so a jump, a rollover
and self-righting look the same on both screens. A ram knocks and damages the victim on both screens, with single
player's numbers, also with a 120 ms round trip. A reconnect puts a car back exactly as it lay. The old physics keeps
working online with the same snapshot format.

**Decisions**

- **Version gating:** with the flag `GAME_VERSION` gets `+rapier` (`net/client.js`). A room on the other physics shows as
  "другая версия". The server's build check in the lobby compares `BUILD_VERSION`, without the suffix. The «СЕТЕВАЯ ИГРА»
  button is back on Rapier.
- **Snapshot row**, the same on both paths (`carRow` / `readRow` in `netplay.js`):
  `[id, x, y, z, q, vx, vy, vz, wx, wy, wz, steer, health, flags, lap, next, passed, kills, accel, turret, timeLeft]`.
  - `q` is the rotation packed into one integer below 2³², "smallest three": the index of the largest component, then the
    other three in 10 bits each, at most ~0.1° off (`packQuat`).
  - Velocity and spin are rounded to 0.1, `health` to 0.1. The old physics sends `y`, a yaw-only `q` and spin about `y`.
  - New flags: 32 — in the air, so the ghost is carried forward with gravity; 64 flips at every `Car.teleport`, so a
    respawn moves the ghosts at once instead of sliding them up to 8 m.
  - Snapshots are sent after the frame's physics (`Netplay.send`). Before this, each one was a frame old, which added
    ~30 ms of lag at 100 km/h.
  - The send accumulators now keep their remainder. Zeroing it gave 15–16 car snapshots and 8.6 crowd snapshots per
    second at 60 fps; now it is 20 and 10.
- **Remote cars are dynamic "ghosts", not kinematic bodies (a change from the plan).** A kinematic body has infinite
  mass: the rammer would stop dead as against a moving wall, and on the victim's screen the rammer's ghost would keep
  pushing until the snapshots caught up. A ghost (`Vehicle.setRemote`, `GHOST`) is a dynamic body with a car's mass and
  inertia:
  - no gravity, no suspension force, no angular damping;
  - collision groups (`GROUPS` in `rapier.js`) make it touch only the cars driven on this computer: not the world, not
    other ghosts, not prop sensors;
  - each physics step a critically damped spring (12 rad/s), with the target's velocity fed forward, pulls it towards its
    last snapshot carried forward by the snapshot's velocities (at most 0.25 s past the network delay; in the air with
    gravity). On the way down the target and the body itself stop 0.15 m below the ground, because the first-wheel-touch
    snapshot still falls at 13 m/s and the ghost sank 0.6 m before this rule;
  - more than 8 m away from its target it is put there at once;
  - once a frame its wheels cast their rays (static world only, zero force) for the wheel meshes and the shadow.

  A car driven here that hits a ghost gets an equal-mass response, and the ghost takes its own share.
- **Network delay:** each client pings the server every 2 s and keeps the smallest of the last 5 round trips. An `'s'`
  message carries `l`, the sender's half round trip. The receiver counts each snapshot as `l` + its own half older (at
  most 0.15 s, `LEAD_MAX`), on both physics paths. With 60 ms one way, the bots' ghosts in a race went from 1.5 m to
  0.42 m behind their cars.
- **Rams** (`Vehicle.localKnock` / `netKnock` / `ghostHit`, `Game._ramDamage`):
  - both computers resolve the hit, each for its own car;
  - the one that drove into the ghost sends the ghost's velocity and spin change (`j`) with the damage, even when the
    damage is 0;
  - the owner reconciles it with its own solver's share over 0.4 s: along the knock's direction the car ends up with
    max(own, event). An event that arrives first is applied in full, and a later local contact takes back the overlap;
  - in every measured ram the two shares agreed within ~10% (e.g. 9.97 / 10.03 m/s at 60 km/h).
- **Just-hit ghosts.** After a hit, a ghost's snapshots still show the car before the hit for a round trip or more.
  - Before the fix the spring drove the rammer's ghost on into the victim, and pulled the victim's ghost back into the
    rammer for second and third hits: with 120 ms round trips, damage at 100 km/h was 54 + 19 + 3.
  - Now a just-hit ghost moves on its own share. On its wheels, the sideways part fades with the car's grip (`CAR_GRIP`).
    This lasts until a snapshot's velocity has changed by half of what the ghost's own has, at most 0.4 s.
  - Holding for a fixed one or two snapshots was tried: still double hits with a delay.
- **Ghosts that let go** (`ghostDeep`, `_putOverlaps`, `_setThrough`):
  - **the problem:** with a car put right onto another car (a respawn), each computer pushed its own car out of the other's
    ghost the same way, each ghost following the other car's snapshots. Both cars sped up together, to 276 km/h in half a
    second (measured), and an idle pair crawled 10 m;
  - **the fix:** a ghost more than 0.3 m inside a car driven here, or more than 2 m from its target, touches no car until
    nothing overlaps it and it is within 1 m of its target;
  - a teleport, and a ghost put at its target, check overlaps at once, before the solver acts;
  - the wheels of cars driven here don't stand on ghosts (`GROUPS.wheels`): a car overlapping a ghost was bounced 1 m up
    by its own suspension rays.

  Gotcha: changing a collider's groups from inside a Rapier query callback is silently lost. Collect the hits first.
- **Crew:** a human gunner aims through the body's rotation (`Car.turretToward`). On a tilted or flipped car the turret
  turns in the body's plane and takes the nearest direction to the requested heading. On resume, `aimYaw` comes from the
  barrel. `BotGunner` and the classic machine gun's auto-aim still use plain yaw arithmetic (session 5).
- **Reconnect / resume:** a car driven here gets its full pose from the server's last row (`Vehicle.setPose`), and ghosts
  are put at theirs.
- **Tests:** `tests/net.html` + `tests/net.js`.
  - Two games side by side in iframes, joined in a room through the real server.
  - The Browser pane is hidden (no animation frames), so the page steps both games from a timer in real time.
  - `lag` delays every message a client receives.
  - Gotcha: an earlier setup's pump in the same page stepped the games again at 2× speed; there is now one pump per page.
  - Gotcha: the frames share the tab's storage, so a game opened in the same tab within 85 s resumes the test's room.

**A car vs its ghost** (the owner's screen vs the other screen, sampled every frame on one clock; lag — one way)

| | Lag 0 | Lag 60 ms |
| --- | --- | --- |
| Jump off the big ramp, lip 97 km/h, 0.87 s in the air: pitch real / ghost | −16…23° / −19…25° | −16…23° / −23…26° |
| … position error mean / p95 / max | 0.11 / 0.19 / 0.33 m | 0.24 / 0.5 / 0.65 m |
| … rotation error mean / p95 / max | 1.0 / 6.7 / 22° | 2.0 / 14 / 25° |
| Rollover at 45 km/h, lying on its side, self-righting: past 60° real / ghost | 6.28 / 6.28 s | 6.27 / 6.28 s |
| … upright again real / ghost | 9.65 / 9.59 s | 9.67 / 9.67 s |
| … largest tilt real / ghost; position error mean; rotation error mean / p95 | 93 / 100°; 0.05 m; 1.1 / 8° | 93 / 106°; 0.14 m; 2.2 / 14° |
| Rollover at 70 km/h (barrel-rolls back onto its wheels): past 60° / upright, real / ghost | 4.55 / 5.95 s, 4.58 / 5.98 s | — |
| Ordinary racing, 6 host bots, 55–70 km/h, 20 s: position / rotation error mean | 0.15 m / 1.35° | 0.42 m / 3.0° |
| The same on the old physics | 1.4 m / 2.0° | — |

**Rams** (`ram()`: A into the side of B's parked car on the test ground; B's own screen / its ghost on A's; damage as B
got it, the same number on both screens)

| Closing km/h | 40 | 60 | 80 | 100 | 123 |
| --- | --- | --- | --- | --- | --- |
| Single player (session 2): thrown / lean | 24 / 1° | 32 / 3° | 43 / 8° | 59 / 13° | 67 / tipped |
| Lag 0: thrown own / ghost | 22 / 22 | 36 / 36 | 44 / 45 | 55 / 55 | 60 / 56 |
| Lag 0: lean own | 1° | 2° | 8° | 12° | 122° (tipped on both) |
| Lag 60 ms: thrown own / ghost | 17 / 18 | 30 / 30 | 43 / 37 | 50 / 60 | 64 / 68 |
| Lag 60 ms: lean own | 3° | 6° | 14° | 45° | 103° (tipped on both) |
| Damage (both lags) | 19.8–19.9 | 36.6 | 47.9 | 53.8 | 60.5 |

Single runs spread by ±5 km/h and some degrees: a lag-60 run before the delay compensation gave 19 / 30 / 43 / 60 / 64 km/h
and 2 / 6 / 7 / 10° at 40–100. With 60 ms the victim's own contact comes ~35 ms after A's and A's event ~100 ms after,
and each hit counts once.

**Crew gunner** (`gunner()`: B in A's gun, A's car posed, B asks for headings 0 / 90 / 200°)

| A's car | Barrel on B's screen | B's barrel vs A's real one | A's shell vs A's barrel |
| --- | --- | --- | --- |
| Level | 0 / 90 / 200° | ≤ 0.1° | ≤ 0.1°, 3 cm from the muzzle |
| Across the big ramp (13°) | 0° (9° up) / 90° / 201° (8° down) | ≤ 0.1° | ≤ 0.1° |
| On its side | 17 / 17 / 197° (the nearest the turret can turn to) | 0° | 0° |
| On its roof (135–179°) | 0 / 92.5 / 200° | ≤ 1.8° | ≤ 2.6° |

**Reconnect** (`reconnect()`): B's car lying on its roof at (30, 1.66, 120); B's page reloads, and it is back in the race
0.5 s later at (30, 1.66, 120) on its roof, with 0° of rotation change. A's ghost of it is the same. 1.2–1.3 s later it
rights itself, upright on both screens. `crash.entries` stayed empty on both.

**Bandwidth** (`bandwidth()`: city, host A with its car and 6 bots, 7 rows per message, 8 s)

| | Bytes per car row | Per message (7 rows) | Per second at 20 Hz |
| --- | --- | --- | --- |
| Before (old format, same cars) | 66 | 501 | 10.0 KB |
| After | 80 | 601 | 12.0 KB |

**Cost** (battle royale, 20 cars, 30 s, both games in one page, no rendering):

| | `game.step` mean / p95 | One physics step |
| --- | --- | --- |
| Host (19 bots, B's ghost) | 2.7 / 4.7 ms | 0.30 ms |
| Guest (19 ghosts) | 2.0 / 3.4 ms | 0.20 ms |

10 cars were wrecked on both screens alike, with no errors. The production build served by `npm run server` passes the
same checks: jump, rollover, rams at 60 / 100, reconnect. `tests/physics.js` single-player numbers are unchanged:
handling, and `sideHit()` 24 / 32 / 43 / 59 / 67 km/h.

**Open problems**

- Spin carried forward through an impact overshoots: the ghost of a car falling onto its side rolls ~7–13° too far for a
  moment, and with the delay compensation rotation p95 is ~14° in rollovers. Fading the tipping part of the spin made
  the ghost lag ~0.1 s through every roll instead (tried, reverted). Decided with the user: leave it as it is (it shows
  for a moment only); letting ghosts collide with the ground is the fallback if it ever bothers players.
- On the old physics online, a remote car is immovable. The rammer stops dead against it and the victim's own screen
  sees a stopped rammer's ghost, so the victim is hardly knocked (it existed before; it goes with the old physics in
  session 6).
- Two cars left overlapping at rest pass through each other until one moves off.
- `BotGunner` and the machine gun's auto-aim on tilted cars: session 5.
- The delay emulation only delays receiving, and real jitter or packet loss wasn't tested. Online play on the test ground
  is reachable only from a script (the menu hides the button there).

### Session 5 (2026-10-10): bots on the new physics

**Result:** `?phys=rapier` is gone: every car is on Rapier in single player, the city, the test ground (which always has
the ramps, the tube and the deck now), battle royale and online. Bots drive, hunt, ram, back up and self-right on it with
wreck and kill counts within the old physics' spread. Two AI traps that existed on both physics are fixed, and bot
gunners and the machine gun's auto-aim aim correctly from a tilted car.

**Decisions**

- **Bots needed no driving changes.** `Rival` and the autopilot already drive through `Car._drive` on Rapier (session 2).
  A tipped bot rolls back onto its wheels by the flip rule like any car (the arcade layer is off while it lies there).
- **Stuck rule** (`STUCK` in `racers.js`, new). A bot that hasn't got more than 8 m away from one spot for 8 s
  respawns. The old rule (`stuckT` > 5 s) never fired in a trap: each back-up resets `stuckT`, so a bot wedged between a
  tree and a building (two at the north edge of the city, x ≈ 47 and −21, z ≈ 165) backed up and drove in again for up
  to 56 s (old physics) / 28 s (Rapier). Ramming a target within 15 m doesn't count, nor does a finished bot. A first try
  — respawn on the 3rd back-up within 8 m — still left 11.8 s and didn't catch bots circling a pedestrian.
- **Butchers circling a pedestrian:** a bot gave up a pedestrian it couldn't hit (inside its turning circle) after
  `GORE.give` and picked the same one 0.3 s later. A pedestrian given up on is now skipped for 6 s (`GORE.skip`).
- **Turret on a tilted car** (`Car.turretToward`). Session 4 projected the wanted heading onto the body's plane. On a car
  rolled 30° that maps heading 45° to a barrel at 37°, and `BotGunner`, which stepped the barrel's world heading, stalled
  for good at −7.6° asked for 200° (each step was undone by the projection). Now the turret takes the angle whose barrel
  lies in the wanted heading's vertical plane — the exact heading, tilted up or down with the car — and only when that
  points more than 50° up or down (`TURRET_STEEP`; on its side) the nearest direction, as before. `BotGunner` steps the
  turret angle towards it (2.6 rad/s in the turret's own angle), `MG.autoAim` asks it too, and `Car.aimYaw` is the
  barrel's real heading on Rapier.
- **Bots don't fire shots that can't land** (`Car.shotReaches`): shells fly straight, so a tilted barrel can hit the
  ground a few metres away (rolled 30°, target to the side: −26°) or pass over the target (nose up 13° at 30 m: 6.7 m
  high). A bot driver (`_shouldFire`, `_shouldFireAtPeds`) and a bot gunner fire only if the barrel's line passes the
  target at 0.4 m below its feet … 0.4 m above its top, and nothing static lies between the body's middle and the muzzle
  (on its roof the muzzle is under the ground — the session 3 open problem for bots).
- **Flag removed:** `PHYS_RAPIER` (config), the `+rapier` version suffix (`GAME_VERSION` = `BUILD_VERSION`), the
  test ground's verticals are unconditional. The old path's code (`_step`, `collideCars`, the `!this.phys` branches in
  `main.js`, `cannon.js`, `mg.js`, `car.js`) is unreachable now and goes in session 6.
- **Tests:** `botBattles()` (city: N seeded 2-minute games, race or battle royale, classic or crew; my car on the
  autopilot and unwreckable; the longest time any bot stayed within 6 m of one spot, wrecks, kills, rams, shots,
  respawns, back-ups, tips) and `gunnerTilt()` (test ground) in `tests/physics.js`.

**Bot games** (`botBattles()`, 10 seeded games of 120 s per row; a game ends early when a bot wins or all bots are
wrecked; "stuck" — the longest any bot stayed within 6 m of one spot while the game was on; per game averages)

| | Stuck max, s | Wrecked | Ped kills | Rams > 4.5 m/s | Shots | Respawns | Tipped > 60° (longest) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Race, 7 bots — old physics, old AI | 13.5 (2 games > 10) | 4.7 | 40.3 | 24.5 | 72.8 | 0 | — |
| … old physics, new AI | 8.4 | 4.2 | 54.3 | 22.9 | 85.9 | 0.6 | — |
| … Rapier, old AI | 13.6 (1) | 4.1 | 51.6 | 18.7 | 78.8 | 0 | 0.1 (3.5 s) |
| … **Rapier, final** | **8.7** | **4.2** | **48.6** | 19.1 | 82.8 | 0.2 | 0.1 (1.2 s) |
| Royale, 19 bots — old physics, old AI | 56.2 (6) | 18.8 | 70.6 | 66.4 | 136 | 0 | — |
| … old physics, new AI | 8.7 | 18.7 | 57.3 | 62.8 | 130 | 0.9 | — |
| … Rapier, old AI | 9.8 | 18.7 | 71.5 | 58.6 | 141 | 0 | 0.8 (4.4 s) |
| … **Rapier, final** | **8.7** | **18.7** | **65.6** | 56.7 | 128 | 0.2 | 0.5 (5.5 s) |
| Race crew, 7 bots — old physics, old AI (5 games) | 38.5 (3) | 5.8 | 39.4 | 16 | 131 | 0 | — |
| … old physics, new AI | 8.1 | 6.1 | 36.6 | 14.9 | 129 | 0.8 | — |
| … **Rapier, final** | **6.1** | **6.0** | **34.8** | 16.7 | 120 | 0 | 1.2 (4.9 s) |
| Royale crew, 19 bots — old physics, old AI (5 games) | 14 (1) | 19 | 59.8 | 30.4 | 201 | 0 | — |
| … old physics, new AI | 9.5 | 18.8 | 68.9 | 26.8 | 199 | 0.8 | — |
| … **Rapier, final** | **8.1** | **18.9** | **57.8** | 33 | 189 | 0.3 | 1.2 (3.4 s) |

Kill counts swing ±20 between seeds of one configuration (19–74 in one race row), so the differences in that column are
noise. Rapier has ~15% fewer hard rams than the old physics (cars glance off each other's round ends). `crash.entries`
stayed empty in all 160 games. The "old AI" rows on Rapier were run with the gunner fix already in.

**Gunner on a tilted car** (`gunnerTilt()`: the car posed, a target 30 m away; the barrel's heading error after 3 s of
turning; "old" — what the old yaw arithmetic of `BotGunner` would point at)

| Pose | 0° | 45° | 270° | 200° | Fires |
| --- | --- | --- | --- | --- | --- |
| Level | 0 | 0 | 0 | 0 | all |
| Nose up 13° | 0 (old 0) | 0 (old 0.7) | 0 | 0 (old 0.5) | only at 270° (the barrel is level there; at 0/45/200° it points 9°/5°/−8°) |
| Rolled 30° | 0 | 0 (old −4.1) | 0 | 0 (old −2.5) | 0° only (−26° at 270°: into the ground) |
| On its side | 0 | −45 (can't turn there) | 90 (can't) | −20 (nearest: 180°) | 0° only |
| On its roof | 0 | 0 (old −90) | 0 (old −180) | 0 (old −40) | none (muzzle under the ground) |

The machine gun's auto-aim, rolled 30°, target at 20°: 0° off. Over the network (`tests/net.js` `gunner()`), B's barrel on
A's car: level and across the ramp ≤ 0.1°, on its roof 89.8° asked 90° (session 4: 92.5°), on its side unchanged (17°
nearest).

**Online** (the dev build through `npm run server`): `ram()` at 60 / 100 km/h — thrown 36 / 60 km/h on both screens,
−36.6 / −53.8, as in session 4. A battle royale in crew mode with 7 host bots (`follow()`, 25 s): ghosts 0.17 m / 1.3°
from their cars. The production single file boots on Rapier with no flag. Handling (`handling()`) is unchanged: 42.9 /
76.9 / 99.2 / 118.9 / 125.5 km/h, top 126, yaw rates 120.6 / 107.4 / 69.9 / 58.3 °/s, lean 0.1°.

**Open problems**

- A bot on its side can lie for up to 5.5 s: the flip rule waits for 1.5 s of stillness, and a car rocking on its side
  or pushed by others isn't still. Fine for now.
- Respawning at the last gate costs a stuck racer its place. Decided with the user: the bot should get out by itself and
  be teleported only after 20 s, to a free spot nearby, 2 m above the ground — `NAV_PLAN.md` session 1.
- The bots' navigation is 2D and tied to the city's grid (`_clearLine`, `_navPoint`, `race.route`, `roadPointNear`), and
  future maps will be 3D. Planned as its own project: `NAV_PLAN.md` (nav grid from the 3D colliders, A*, links for
  jumps and drops).

### Session 6 (2026-10-10): remove the old physics, docs, performance

**Result:** the old 2D car physics is deleted. Rapier is the only path and no code branches on it any more (`car.rb` is
always there). Every measurement of sessions 2–5 comes out the same after the removal, single player and online. The
README has a new "Physics" section; its damage, ramming, test ground, networking and tuning parts and CLAUDE.md's
"Architecture" describe the engine.

**Removed** (code and tests: −434 / +158 lines)

- `car.js`: `_step`, `_collide`, `update()`, `HIT_Z` / `HIT_R` / `CAR_INERTIA`, `P.restitution` / `P.inertia`, the
  cosmetic hop (`hop` / `hopVel`, also in `pedestrians.js` and `tag.js`), and every `this.rb ? … : …` fallback (`_rot`,
  `toLocal` / `toWorld`, `aimYaw`, `turretToward`, `shotReaches`, `nudge`, `explode`, `_syncMesh`, tyre marks).
  `_afterPhysics` became `postUpdate`. `Car._impact` stays: `Vehicle.staticHits` calls it for wall hits.
- `racers.js`: `collideCars`, `collidePair`, `CAR_HIT.restitution`.
- `main.js`: the 2D sub-steps and `collideCars` in `_physics`, every `if (this.phys)`. `_addBody` is the one place that
  gives a car its body (also for `addPhysDummies`); `Car.reset` places the body only once it exists.
- `cannon.js`, `mg.js`: the 2D wall ray casts for shells and bullets, the level-fire heights and the blast's 2D shove;
  `Physics` is now a constructor argument of `Artillery` and `MachineGuns`.
- `net/netplay.js`: the old remote-car interpolation (`EXTRAP_MAX`, `SNAP_DIST`, yaw damping), the yaw-only snapshot
  row and resume branches; `readRow` no longer returns `yaw` / `angVel`.
- `physics/collision.js`: nothing in it was used by cars alone; `circleVsCollider` is no longer exported (only
  `pushOutCircle` uses it). The 2D world stays for pedestrians, debris, the camera, the bots' navigation and sight, the
  machine gun's auto-aim and the molotovs.
- `tests/physics.js`, `tests/net.js`: the `phys: 'old'` fields and the `game.phys ?` / `car.rb ?` branches.

**Checks after the removal** (dev server, `?mute`; equal to the earlier sessions unless noted)

- `handling()`: 42.9 / 76.9 / 99.2 / 118.9 / 125.5 km/h, top 126, yaw 120.6 / 107.4 / 69.9 / 58.3 °/s, reverse 39.8,
  lean 0.1°.
- `sideHit()`: thrown 24 / 32 / 43 / 59 / 67 km/h, lean 1 / 3 / 8 / 13 / 123°; `wallDamage()`, `landings()`, `blasts()`,
  `pedJumps()`, `props()`, `muzzle()`, `gunnerTilt()` — the session 3 and 5 tables to the digit.
- `botBattles()` (city, seeded games of 120 s; per game):

  | | Games | Stuck max, s | Wrecked | Ped kills | Rams > 4.5 m/s | Shots | Tipped > 60° (longest) | Errors |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | Race, 7 bots | 10 | 9.3 | 4.0 | 47.1 | 16.6 | 76.3 | 0.5 (3.5 s) | 0 |
  | Royale, 19 bots | 5 | 7.8 | 18.4 | 76.8 | 55.2 | 142 | 1.4 (3 s) | 0 |
  | Race crew, 7 bots | 3 | 8.3 | 6.3 | 28.3 | 15 | 105 | 0.7 (1.9 s) | 0 |

  Within session 5's spread. The same seed run twice gives different games — also with `performance.now()` replaced by
  the game's clock — so the state a `restart()` carries over (the crowd, debris, broken props, Rapier's contact caches)
  is the likely cause. Bot rows compare as statistics only.
- Online (`tests/net.js` through `npm run server`): jump off the big ramp — pitch real / ghost −16…23° / −19…24°,
  position error 0.1 m mean, rotation 0.96°; rollover — past 60° at 4.55 / 4.57 s, upright at 8.97 / 8.94 s; rams at
  60 / 100 km/h — thrown 30 / 55 km/h on both screens, −36.6 / −53.8, knocks local 9.96 vs event 10.01 m/s; reconnect —
  back on its roof at the same spot after 0.51 s, 0° of rotation change; crew gunner — the session 5 table; city with 7
  host bots — ghosts 0.15 m / 1.05° from their cars; 80 bytes per car row, 12.2 KB/s. No errors on either screen.
- The production single file (`dist/cars-and-guts.html`, 4106 KB) boots the city and the test ground from the server
  with no errors and no requests besides the optional Google font.

**Performance** (this PC, Chromium in the app's browser pane, a 375 × 812 viewport, `?q=low` — pixel ratio 1.5, no
shadows, 54 pedestrians; the pane is hidden, so there are no animation frames: each frame is `game.step(1/60)` +
`game.render()` + `gl.finish()`, measured by hand; 360 frames from the green light)

| | `game.step` mean / p95 | Render mean | Frame mean / p95 / p99 | One physics step |
| --- | --- | --- | --- | --- |
| Battle royale, 20 cars (3 runs) | 1.53–1.6 / 2.2–2.5 ms | 1.3–1.8 ms | 2.8–3.4 / 3.7–4.5 / 4.3–5.8 ms | 0.34 ms |
| Race, 2 cars | 0.64 / 1.0 ms | 1.53 ms | 2.18 / 2.6 / 3.8 ms | 0.16 ms |

Inside a 20-car frame (two physics steps): Rapier's `world.step` 0.37 ms, the cars' controls and suspension
(`Vehicle.preStep`) 0.24, `afterStep` 0.05, `savePrev` 0.03, car contacts 0.02 — the physics is 0.72 of the 1.58 ms of
`game.step`; the bots' thinking 0.10. Nothing stands out to optimise. Real FPS on a phone is still unmeasured (no phone
here): open the game with `?q=low&debug` on one.

**Not bugs**

- `ram()` at 60 km/h ended with the victim on 100 hull: it was thrown into the test ground's pedestrians, killed five and
  healed +8 each.

**Open problems** (carried over, none new)

- Ghosts overshoot the spin through an impact for a moment (left as it is, session 4).
- Two cars left overlapping at rest online pass through each other until one moves off.
- A bot on its side can lie for up to 5.5 s before it is still enough to self-right.
- Molotov bottles meet walls in 2D; the pedestrians' side of shell and bullet ray casts is 2D.
- Tyre marks and bloody tracks are skipped where a wheel isn't on the flat ground (ramps, the tube's floor).
- Real phone FPS (above).

The branch is ready to merge; ask the user before merging it into `master`.

### Session 7 (2026-10-10): carry-over of the non-physics changes

The user asked for Session 7 as a whole, so all five items were ported without asking one by one. None of
`claude/test-verticals`' physics code was touched.

- **Pedestrians 1.85 m** (`PED_HEIGHT` in `pedestrians.js`): the model is built 1.91 m tall, so the root matrix is scaled by
  1.85 / 1.91 about the feet. Hit boxes and gameplay numbers are unchanged.
- **Respawn** (`RESPAWN`: 15 s, 50 m): on the test ground a dead pedestrian's spot refills after 15 s only with no car
  within 50 m (was 5 s / 8 m). In the city each missing pedestrian gets a due time (`dueAt`, 15 s after it went missing),
  and the new one appears only 50–170 m from the human player and 50 m from every car (was 45 m / 30 m). Measured: the
  test ground refilled at 15.0 s with the car far away and not at all with the car 30 m away; in the city 10 removed
  pedestrians were back between 15 and 30 s.
- **100 m grid:** white lines (0.3 m wide) at −100, 0 and +100 on both axes instead of the 20 m grid; they still stop at the
  tube's open trenches.
- **Flight bonus «ПОЛЁТ N С»:** `Vehicle._land` now passes the flight time too: `car.onLand(air, impact)`. In `main.js`, for
  the car I'm in, a flight of ≥ 0.8 s (`AIR_BONUS_MIN`) gives `round(air × 10) × 10` points, and any landing above 4 m/s
  shakes the camera. Measured: the big ramp at full throttle from 40 m gives «ПОЛЁТ 0.9 С +90».
- **Pad popups:** `Vehicle.preStep` calls `car.onPad(type)` when the car drives onto a pad: «УСКОРИТЕЛЬ!» / «КАТАПУЛЬТА!» and a
  camera shake (0.15 / 0.4).
- **Docs:** README (test ground, pedestrians, points) and the test ground's note in `index.html` are updated.
- **Problems found:** none new. Initialising `Pedestrians.dueAt` in the constructor (and not only in `reset`) was a fix
  made while porting, so `update` can't run before `reset`.
