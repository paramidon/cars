# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Cars & Guts is a Carmageddon-style arcade racing and car-combat prototype built on three.js. It uses plain ES-module JavaScript, with no framework and no TypeScript. It runs on desktop and phones, and it has optional multiplayer through a small Node WebSocket server. `README.md` is the source of truth for gameplay rules, exact tuning numbers, controls and how the netcode works. Read the relevant section before changing behavior.

**Language:** all Markdown docs (`README.md`, `CLAUDE.md`, `plan.md`) and commit messages are in English. Existing code comments are in Russian — leave them as they are, don't translate them; new code comments go in English. In-game UI strings stay in Russian. Talk to the user in Russian.

## Commands

```bash
npm install
npm run dev      # Vite dev server on :5173 (+ LAN address); also "dev" in .claude/launch.json
npm run build    # vite build → dist/, then scripts/inline.mjs → dist/cars-and-guts.html (single file) + dist/build.json
npm run server   # node server/server.js [port]: serves dist/ + WebSocket lobby on :8080 (or PORT env)
npm run serve    # build, then server
```

The project has no linter and no test suite. Use `npm run build` to check that everything compiles. `tests/physics.js` is an in-browser measurement module for the physics (handling numbers, lean in a race, bots' pace, side hits, damage, blasts, pedestrians and props against the car's box): `await import('/tests/physics.js')` in a dev-server page, see its header. To verify behavior, run the game in a browser:

- `window.game` is the `Game` instance.
- `game.step(dt)` is public so scripts can step the simulation.
- `game.debugState()` dumps the current state.
- `window.crash` is the crash reporter.

URL parameters: `?mute` (use it for automated runs), `?debug` (FPS counter), `?q=low|high` (graphics quality), `?peds=N` (number of live pedestrians), `?map=test` (test ground: flat lot, two buildings, stationary pedestrians, no rivals and no win condition; add new mechanics there too), `?phys=rapier` (every car on Rapier, in the city and on the test ground, which then also gets ramps, the tube and the deck; single player only — work in progress, see `PHYSICS_PLAN.md`).

## Architecture

- **`src/main.js` holds the `Game` class.** It owns every subsystem, the state machine (`menu` / `play` / `pause` / `over`), scoring, healing, win and lose, and the wiring between systems (callbacks set in `_wire()`). `step(dt)` defines the per-frame update order. `_physics()` substeps car physics at ≤1/120 s and calls `collideCars` (on Rapier: fixed 1/120 s steps of the world, and car-vs-car hits come from its contact events). Damage routing lives here, not in `car.js`: `_carHit`, `_ramDamage`, `_shellHit`, `_carWrecked`.
- **`this.cars[0]` is always the car I'm in (`game.car`).** In network crew mode this can be someone else's car, because I may sit in its gun turret, so it isn't necessarily `game.mainCar`. `applyLineup()` is the one place that sets who races, seats, mode (`classic` / `crew`), game type (`race` / `royale`), bot gunners and the autopilot. Both solo and network starts go through it.
- **There is no physics engine.** All collisions happen in the XZ plane (`physics/collision.js`): buildings are AABBs, props are circles, lookups use a spatial grid, and raycasts use DDA. Each car is three circles (`HIT_Z` / `HIT_R` in `car.js`). The exception, behind `?phys=rapier`: every car (`car.rb`, a `Vehicle`) is a Rapier rigid body in a world of static colliders built from the city's plain-data `solids` (`physics/rapier.js`, `physics/vehicle.js`; the boot is async because the WASM has to start first). Its handling is the same `Car._drive` as the old path, applied as velocity changes while wheels touch the ground. Move a car with `car.teleport()` and push it with `car.nudge()`, not by writing `x`/`vx`: on Rapier those are read back from the body every frame. Pedestrians, the camera and bot navigation still use the 2D world; pedestrians, shells, bullets and bottles test the car's box turned with its body (`Car.segHit`/`rayHit`), shells and bullets cast rays against Rapier's static colliders (`Physics.castStatic`), breakable props are Rapier sensors, and wall, landing and roof damage come from the body's contacts (`Vehicle.staticHits`).
- **The world:** `world/city.js` generates the city from a fixed seed, so every client builds the same world. `world/geom.js` merges static geometry into ~11 meshes, and `world/textures.js` draws textures on canvases. Pedestrians are drawn with one `InstancedMesh` per body part.
- **Bots:** `Rival` in `racers.js` drives: it follows the track and hunts cars or pedestrians, steered by two 0..1 scales, `aggr` and `gore`. `BotGunner` in `gunner.js` aims and fires turrets in crew mode. When the player sits in the gun turret, a `Rival` built from the `AUTOPILOT` definition drives their car.
- **Tuning constants** are uppercase objects at the top of each module: `P` (`car.js`), `RACE`, `CANNON`, `RIVALS` / `HUNT` / `GORE` / `CAR_HIT` (`racers.js`), `ZONE`, `GUNNER`, `HEAL` (`main.js`), `QUALITY` / `CITY` (`config.js`). The last section of the README says what each one controls.

### Networking (`server/server.js`, `src/net/`)

- **The server never simulates the game.** It runs the lobby and rooms, relays messages, and decides who claimed a victory first. It also serves `dist/`, so `npm run server` only picks up game changes after `npm run build`.
- **Ownership:**
  - Each client simulates the car it drives. If a bot drives the car, the client in that car's gun turret simulates it.
  - The host simulates the bots and the pedestrian crowd.
  - Other players' cars have `car.remote = true`. Skip physics, AI and damage on them; `Netplay.update` interpolates them from snapshots.
  - Before changing anything that modifies world state, check `remote`, `game.net` and `peds.netRole`, and decide which client owns the change.
- **Damage:** whoever causes it computes it and broadcasts it as an `'e'` event. That is the rammer for rams, the hitter for pedestrians and the breaker for props. For shells, the hit car's owner computes damage locally.
- **Snapshots:** cars are sent as `'s'` messages at 20 Hz, and the host sends the crowd as `'ped'` messages at 10 Hz.
- **Version gating:** `__BUILD__` is a SHA-1 of `src/`, `index.html` and `package.json` (`scripts/build-id.mjs`, line endings normalized). Any source change produces a new version, and a room only admits clients with the same version, so all players must run the same build.
- **Reconnects:** the server holds a disconnected player's slot for 90 s, along with their last snapshot, stats and broken props, so they can resume.

### Crash reporting

`crash.js` stops the loop on any exception in `_tick`, on a shader error or on WebGL context loss. It then shows the stack trace together with a `debugState()` snapshot, and keeps the last entries in localStorage. The build is minified with `mangle: false` on purpose so stack traces keep real function names. Don't change that.

## Conventions

- **Keep the single-file build working.** Assets are inlined (`assetsInlineLimit` 1 MB) so `dist/cars-and-guts.html` runs on its own. Make sure new assets don't end up as separate files.
- **Keep the README in sync.** It documents gameplay rules and exact numbers (damage, speeds, timings). When you change behavior or a constant it describes, update the README in the same commit.
- **`plan.md` is the user's to-do list.** Remove an item once it's done; don't rewrite the file otherwise.
- **`PHYSICS_PLAN.md` is the plan for moving car physics to Rapier**, done in sessions on `claude/rapier-physics`. Follow the session you are asked to do, then tick it and add notes there.
- **Branches:** don't commit directly to `master` or `claude/carmageddon-game-prototype-m0zs5f`. Work on a `claude/*` branch.
