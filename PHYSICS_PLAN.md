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
- [ ] Session 3: damage, rams, props, pedestrians, weapons in 3D
- [ ] Session 4: networking
- [ ] Session 5: bots on the new physics
- [ ] Session 6: remove the old physics, docs, performance
- [ ] Session 7 (optional): carry over the non-physics changes from `claude/test-verticals`

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
