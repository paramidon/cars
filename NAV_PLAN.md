# Bot navigation: plan

Give the bots real navigation that works on any map, including future 3D maps with several levels, ramps, jumps and
tunnels. The city is only the prototype's test map: nothing in the bots may depend on its regular grid of streets.

The work is split into **sessions**. Each session is one request to Claude Code, started fresh with the prompt given
below. Run them in order. At the end of every session, tick its checkbox in [Status](#status), add notes under
[Session notes](#session-notes) and commit.

- **Branch:** `claude/bot-navigation`, created from `claude/rapier-physics` once `PHYSICS_PLAN.md` session 6 is done
  (or from `master` after that branch is merged). Every session works and commits here. Don't commit to `master` or to
  `claude/carmageddon-game-prototype-m0zs5f`.
- **Prerequisite:** Rapier is the only car physics (`PHYSICS_PLAN.md` session 5) and the old 2D car physics is deleted
  (session 6). Session 1 below doesn't need session 6 and can run before it.

## Status

- [ ] Session 1: getting out of traps (smart escape, nearby teleport as a last resort)
- [ ] Session 2: navigation data — a layered nav grid built from the map's 3D colliders
- [ ] Session 3: paths and driving — A*, path following, speed planning, local avoidance, all modes on the nav
- [ ] Session 4: 3D — ramps, jumps, drops, decks and tunnels; bots on the test ground

## Decisions already made (with the user, 2026-10-10)

- **Maps will be 3D.** Navigation must handle several levels (a tunnel under a street, a deck above it), slopes, steps,
  jumps off ramps and drops off edges. Nothing may read `city.roads` or assume a grid.
- **Sidewalks are for driving over.** Pedestrians must suffer: cutting corners over a sidewalk, driving along it and
  through a crowd are good, not something to avoid. Only solid things (buildings, walls, trees, poles, pillars, the
  fountain, pumps, rails, wrecks, other cars) are obstacles. Butchers (`gore`) should even prefer crowded sidewalks.
- **Getting out of a trap:** the bot gets itself out (reverses while there is room behind it, turns, takes another way).
  Only if it still hasn't got out after **20 s** (e.g. a wreck blocks it from the side) is it teleported — **not to a
  gate** (the game type isn't necessarily a race) but to a free spot nearby, **~2 m above the ground**, so that it
  doesn't land inside a car that happens to be there.
- Flipped cars need nothing new: the flip rule rights them after 1.5 s of stillness (`VEH.flipUp` … in
  `physics/vehicle.js`).

## How bots navigate now (analysis, 2026-10-10)

`Rival.think()` in `src/racers.js` picks a target point each frame and steers at it (`steer = clamp(angle × 2.2)`),
throttle and brake from a target speed. Where the target point comes from:

| Mode | Target | Problems |
| --- | --- | --- |
| Race (`mode 'race'`) | `race.pointAt(s + 9 + 0.55·v, lane)`: a point ahead on `race.route`, a hard-coded polyline through the city's street centres (`race.js`) | The route is per-map code tied to the grid. The look-ahead cuts corners (good, see above), but nothing checks what is on the cut line: two trees at the north edge (x ≈ 47 and −21, z ≈ 165) trapped bots for up to 56 s before session 5's `STUCK` rule. Corner speed only knows the route's corners, not obstacles, slopes or jumps. |
| Hunt (`'hunt'`) | Straight at the target with lead; if `_clearLine` is blocked, `_navPoint` | `_clearLine` sees only buildings, the wall, the statue and pumps (`losFilter`), so a bot chases straight into trees, poles, pillars, the fountain and wrecks. `_navPoint` picks the neighbouring grid intersection nearest to the target in a straight line: greedy, one step deep, can oscillate around a block, knows nothing but `city.roads`. |
| Gore (`'gore'`) | Straight at the pedestrian | Same blind line. Circling a pedestrian inside its turning circle was fixed in session 5 by giving up (`GORE.skip`), not by driving a reachable line. |
| Battle royale (`zone`) | `roadPointNear(zone centre)` (`zone.js`), `_navPoint` when blocked | `roadPoint` / `roadPointNear` / `spawnPoints` / `reachable` / `zoneCenter` all read `city.roads`. |
| Stuck | `stuckT` > 1.4 s → reverse 0.9–1.4 s blind, steering away from the target; 8 s within 8 m (`STUCK`) or `stuckT` > 5 s → `respawn()` at the last gate (`race.respawnPoint`) or a road point in the zone | The reverse doesn't look behind; after it the bot drives the same line into the same trap; the respawn loses its place and lands exactly on the ground, possibly inside another car. |

Also:

- **Everything is 2D:** bots know no heights. On the test ground (ramps, the deck, the tube) they would drive into a
  ramp's side or off the deck. There are no bots on the test ground now, so it doesn't show.
- **Other cars aren't obstacles** except through the stuck rule and hunting. Bots ram whatever is ahead of them,
  including wrecks.
- **Costs:** `_clearLine` is a DDA raycast in the 2D grid each frame per bot, cheap. `race.project()` loops over all
  route segments, fine for 8. A real pathfinder has to stay within budget for 19 bots on a phone.
- **Network:** only the host runs bots (`CLAUDE.md`, Networking), so navigation needs no determinism or sync. Every
  client builds the same map, so nav data built from it is the same everywhere anyway (a crew gunner's client drives
  its bot car: it needs the nav too).

## Target architecture

- **Nav grid (`src/nav/`), built at load from the map's 3D static colliders**, not from city-specific data:
  - columns of cells ~1.5–2 m on XZ over the map's bounds; in each column, every walkable floor found by casting
    rays down through the Rapier world (`Physics.castStatic`, repeated below each hit), so a tunnel floor and the
    street above it are two layers of one column;
  - a floor is walkable if its normal is within ~30° of up and there is car clearance above it (~2 m, a shape cast of
    the car's box), and it isn't inside a solid inflated by the car's half width (trees, poles, buildings…);
  - neighbouring cells connect if the height step is small enough to drive over (curbs: 0.15 m; ~0.4 m max) and the
    slope between them is drivable; each cell keeps its kind (road, sidewalk, ramp, deck…) from the collider under it;
  - **links** for things a grid can't see: jumps off ramps (lip → landing area, with the speed range that lands there,
    found by simulating the car's flight), drops off edges (one way), pads (boost, catapult);
  - static props that break (lamp posts, bins, benches…) are not obstacles: driving through them is the game;
  - build time and memory are measured on a phone; if building at load is too slow, bake it at build time per map.
- **Paths:** A* on the grid (8-connected, with layers and links), with a coarse level (regions/portals) for long paths
  if needed; costs: length, a penalty near solids, a *bonus* for sidewalks with pedestrians for gore bots; spread
  path queries over frames (a budget per frame), re-plan when the goal moves far or the path is blocked.
- **Driving a path:** string-pull the cell path into a smooth line; steer at a look-ahead point on it (as today's
  `pointAt`); target speed from the line's curvature, slopes and links (a jump needs its speed range, a drop needs to
  slow down); the existing throttle / brake / handbrake logic stays.
- **Local avoidance:** what the grid doesn't know — other cars, wrecks, dynamic debris: a few shape casts of the car's
  box ahead (Rapier), steer to the freer side, brake if both are blocked. Hunters still aim *at* their target.
- **Goals per mode:** race — the next gate (gates come from the map, not a hard-coded route); hunt — the target car
  with lead; gore — the pedestrian; battle royale — a nav cell inside the zone; spawn points, `reachable`, zone
  centres — from the nav grid instead of `city.roads`.
- **Escape from traps** (the user's rule above): reverse while a cast behind says there's room, mark the trap's cells
  expensive for a while, re-plan; after 20 s without getting out, teleport to the nearest free nav cell (no car within
  a few metres), preferably out of the human player's view, 2 m above the floor.
- **Debug:** `?debug=nav` draws the grid's walkable cells by layer, links, and each bot's current path.

## Rules for every session

- Read `CLAUDE.md`, the relevant README sections and this file first. Write docs, comments and commit messages in
  English (existing Russian code comments stay). Talk to the user in Russian.
- `npm run build` must pass, the single-file build must stay single-file.
- Verify in the browser with `?mute` through `window.game`, stepping the game by hand as `tests/physics.js` does. Report
  numbers, not impressions. The bots' acceptance test is `botBattles()` in `tests/physics.js` (city, 10 seeded games of
  2 min per row, race and battle royale, classic and crew); compare with session 5's numbers in `PHYSICS_PLAN.md`.
- Keep the README in sync (rivals' behaviour, tuning constants).
- If port 5173 is busy, add a temporary `.claude/launch.json` entry on another port; revert it before committing.

---

## Session 1: getting out of traps

**Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`).

**Prompt:**

> Do Session 1 of NAV_PLAN.md.

**Scope.** Works with today's navigation; session 3 later swaps "another way" for a real re-plan.

1. Reverse with eyes: a shape cast of the car's box behind (`Physics`, static colliders and cars) — reverse while there
   are ≥ 2 m free, up to ~3 s, steering so the nose swings away from the obstacle the bot hit (the contact's normal
   from `Vehicle.statics` / car contacts), not just away from the target.
2. After the reverse, don't drive the same line: remember the trap's spot and, for ~10 s, aim around it (e.g. a point
   offset sideways past the obstacle, or `_navPoint` excluding the trap's direction).
3. Replace session 5's `STUCK` respawn (8 s within 8 m → last gate) with the user's rule: only after **20 s** without
   getting more than ~8 m away (ramming a target nearby still doesn't count), teleport to the nearest free road or
   sidewalk spot within ~30 m (no car within 6 m), preferably not in the human player's view, at **floor + 2 m**,
   heading along the road. Never to a gate. The same function for `stuckT` > 5 s (wedged still), for the autopilot
   (`AUTOPILOT`), and for battle royale. `Car.teleport` needs a height for that (today it puts the car on the ground).
4. Test: a scripted trap (a bot pushed between a tree and a building, a wreck parked against its side), `botBattles()`.

**Acceptance**

- In the scripted traps the bot gets out on its own in most cases; teleports only when really blocked, never inside
  another car.
- `botBattles()` (all four rows): longest stuck time and teleports per game reported; no errors; pace and wrecks
  within session 5's spread.

## Session 2: navigation data

**Model:** Claude Opus 5.5 (`claude-opus-5-5`).

**Prompt:**

> Do Session 2 of NAV_PLAN.md.

**Scope**

1. `src/nav/grid.js`: the layered nav grid of [Target architecture](#target-architecture), built from the Rapier world
   (static colliders) and the map's bounds after the city or test ground is built. Cell size, max step, max slope,
   clearance and inflation as an uppercase `NAV` constants object.
2. Queries: `cellAt(x, y, z)` (the layer under a point), `nearestFree(x, y, z, r)`, `isFree(x, y, z)`, `randomCell(filter)`.
3. Port the city-grid helpers to it: `roadPoint`, `roadPointNear`, `spawnPoints`, `reachable`, `zoneCenter` (`zone.js`)
   and session 1's teleport spot. Nothing outside the race route still reads `city.roads`.
4. `?debug=nav`: draw walkable cells coloured by layer and kind.
5. Measure: build time and memory, desktop and a phone-sized `?q=low`; the city and the test ground (the tube's floor
   and the street above it must be two layers; the deck reachable from its ramp only; ramps' sides not walkable).

**Acceptance**

- City and test ground grids look right in `?debug=nav` (screenshots in the notes), with numbers: cells per layer, build
  ms, KB.
- Battle royale spawns and zone points come from the grid; `botBattles()` royale rows unchanged within spread.

## Session 3: paths and driving

**Model:** Claude Opus 5.5 (`claude-opus-5-5`).

**Prompt:**

> Do Session 3 of NAV_PLAN.md.

**Scope**

1. A* over the nav grid (layers, links), path smoothing, a per-frame query budget, re-planning rules.
2. Bots drive paths in every mode: race to the next gate (the map's gates; `race.route` stays only for the minimap),
   hunt, gore, battle royale, the autopilot. Replace `_clearLine`, `_navPoint` and `pointAt`-following. Sidewalks are
   fine to cross and cut over; gore bots prefer crowded ones.
3. Speed planning from the path's curvature (replaces `cornersAhead` for bots).
4. Local avoidance of cars and wrecks with shape casts ahead; hunters still ram their target.
5. Session 1's escape re-plans around the trap instead of its sideways offset.
6. Performance: `game.step` with 19 bots, desktop and phone-sized `?q=low`, before/after.

**Acceptance**

- `botBattles()` all four rows: no bot stuck > 10 s, teleports rarer than session 1, wrecks and kills in the same range
  as session 5 (or more kills, if gore bots get better at it).
- `botLaps()`: average bot speed not below session 5's (≈ 58–62 km/h).
- Frame cost within +10% of before.

## Session 4: 3D — ramps, jumps, drops, decks and tunnels

**Model:** Claude Opus 5.5 (`claude-opus-5-5`).

**Prompt:**

> Do Session 4 of NAV_PLAN.md.

**Scope**

1. Links: jumps off ramps (simulate the car's flight from the lip at several speeds to find where it lands; the link
   carries the speed range), drops off edges, boost and catapult pads.
2. Path following over links: reach the needed speed before a lip, slow down before a drop, don't steer in the air.
3. Bots on the test ground: a way to start a race or battle there with bots (a URL option such as `?map=test&bots=N`,
   with gates or a zone placed for it), so the 3D features get exercised.
4. Write down what a future map must provide for navigation (colliders, kinds, gates, spawn areas) — the nav itself
   must need nothing map-specific beyond that.

**Acceptance**

- On the test ground bots use the big ramp, the deck (up its ramp, and off its edge as a drop) and the tube, and don't
  drive into ramps' sides; numbers: how many of N bot runs take each feature, how many get stuck.
- City numbers unchanged from session 3.

## Session notes

_Each session appends its notes here: decisions, measurements, problems left for later._
