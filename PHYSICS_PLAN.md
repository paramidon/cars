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

- [ ] Session 1: spike on the test ground (go/no-go)
- [ ] Session 2: whole world and all cars on Rapier, handling tuned
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
