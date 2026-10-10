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

- [x] Session 1: getting out of traps (smart escape, nearby teleport as a last resort)
- [x] Session 2: navigation data — a layered nav grid built from the map's 3D colliders
- [x] Session 3: paths and driving — A*, path following, speed planning, local avoidance, all modes on the nav
- [x] Session 4: 3D — ramps, jumps, drops, decks and tunnels; bots on the test ground

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
- Read the notes of the earlier sessions in [Session notes](#session-notes) first: their "Left for later" items are
  part of the later sessions' scope.
- Measuring gotchas (found in session 1): editing any file under `src/` or `tests/` makes Vite reload the page and kills
  a running test — don't edit while one runs. After a few minutes in a hidden browser pane Chromium throttles
  `setTimeout(0)` (the tests' tick) to about once a second, so long runs crawl (10 race games: 5+ min instead of 55 s);
  in the page, replace `setTimeout` for 0 ms with a `MessageChannel` post before starting them. A `javascript_tool`
  call times out after 45 s: start long runs as a promise stored on `window` and poll it.

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
   - The teleport spot is `freeSpotNear()` in `zone.js` (constants `SPOT`, called from `Rival.respawn()` in
     `racers.js`); today it samples the city grid's lanes and sidewalks, so it doesn't work on the test ground or a 3D
     map. Port it to `nearestFree` on the grid and keep its rules: 8–30 m from the car (then wider), no solid within
     2.8 m, no car within 6 m, the cost hooks from `respawn()` (out of the humans' view, inside the zone, not past the
     next gate), heading along the cell's drivable direction, `y` = the cell's floor + 2 m — the floor of the layer
     the spot is on (under a deck, in the tube), not `city.groundHeight`.
   - Check: `traps(game, { names: ['pinned', 'teleport'] })` in `tests/physics.js` still teleports at 20 s, ≥ 6 m
     from any car, 2 m up, no damage on landing (session 1's table).
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
   - The offset is `Rival._aroundTrap()` with `this.trap` / `this.lastTrap` and `ESCAPE.trap/near/around/out/reach/
     again/flip` in `racers.js`: replace it by marking the trap's cells expensive for ~10 s and re-planning; keep the
     many-point turn (`_startEscape`, the legs in `think()`, `_room`/`_roomAlong`/`_canSwing`) — it is what gets the car
     out, the path only decides where to go after.
   - Known problem it must fix: with a straight line to the goal, a bot whose goal is behind a building gets out of
     the trap and then drives into that building's wall somewhere else (in `traps()` it shows as `stillMax` up to
     8–12 s after `out` in `treeBuilding`, `boxed`, `caged`, `pinned`). Acceptance: `traps()` — every trap but
     `pinned` out by itself, and after `out` no stay over 5 s away from the goal; `pinned` still teleports at 20 s.
6. Performance: `game.step` with 19 bots, desktop and phone-sized `?q=low`, before/after.
7. From session 2 (the nav grid, `src/nav/grid.js`):
   - `Rival._navPoint` is the last reader of `city.roads` outside the race route: A* replaces it.
   - Spawns and the battle royale's waypoints use "open" floors (`NAV.open` 6 m of walkable floor all round) only
     because today's straight-line steering can't get into yards (with 3 m, 21% of waypoints fell in yards and parks).
     Once bots drive paths, lower `NAV.open` to ~3 m and check that they reach yard waypoints.
   - Path costs: `nav.roomAt(i)` (distance to the nearest unwalkable floor, 0.1 m steps) is there for the penalty near
     solids; `nav.next(i, d)` walks the 8 links; `nav.comp[i] === nav.main` is the reachable area.
   - The grid's build time was measured on a desktop only (city 0.2–0.3 s, test ground 0.13–0.21 s; `navGrid(game)` in
     `tests/physics.js`). Measure it on a real phone together with the frame cost; if it is over ~1 s there, bake the
     grid at build time per map (a few typed arrays, ~1.7 MB raw) or build it in slices behind the menu.
   - Still seen in `botBattles()` royale after session 2: about one game in 10 with a bot within 6 m of one spot for
     10–13 s, in `hunt` mode (e.g. 12.8 s at (−133.7, −24), a yard by the x = −120 street; the session-1 code gave 10.8 s
     in its baseline run) — the straight line to the target; paths should remove it (acceptance: no bot > 10 s).

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
5. From session 2 (the nav grid):
   - Today a ramp's lip and the deck's edge are plain edges (unwalkable floors, no link off them): the links go there.
   - What the grid already needs from a map: static colliders in the Rapier world with a `kind` each (`Physics.kinds`;
     tops of `OBSTACLES` kinds are never floors), `city.bounds` (`x0, z0, x1, z1` — where cars can be — and `y0, y1`
     — the colliders' height range). Upright boxes and cylinders are cheapest (their bottom needs no ray).
   - Floors are sampled at column centres (`NAV.cell` 1.5 m): a drivable strip narrower than that (a plank, a thin
     bridge) may be missed or broken — a finer cell for such a map, or a link along it.
6. From session 3 (paths, `src/nav/path.js`, `Rival._go/_plan/_pursue` in `racers.js`):
   - A* follows the grid's 8 links only; links (jumps, drops, pads) need their own edges in `NavPaths.find` (a link
     list per floor, its cost, the speed range it needs) and `Rival._pursue` / `_pathSpeed` must know a leg is a link
     (hold the speed range to the lip, don't brake for the "corner" at a lip, no steering in the air).
   - `NavPaths.lineFree` (straight legs, the look-ahead chord, the direct line to a goal) follows the floor a step at a
     time (`NAV.step` + 0.3 per 0.75 m sample) and never leaves the level it is on: a leg over a drop or a jump is
     always "blocked" — a link leg must skip that test.
   - Race gates have no height: `Rival._raceGoal` and `_gateLeg` look for the gate's floor at `y` 0 (the highest
     floor ≤ 1 m). A gate on a deck or in a tunnel needs a `y` from the map.
   - The car's place on its path is 2D (`projectOn`): a path crossing itself on two levels (a ramp up to a deck over the
     street it started on) may snap to the wrong level. Project with the height too.
   - The costs know nothing of slopes: a ramp costs like the flat (a steep one should cost more, and a bot should slow
     down before a crest).

**Acceptance**

- On the test ground bots use the big ramp, the deck (up its ramp, and off its edge as a drop) and the tube, and don't
  drive into ramps' sides; numbers: how many of N bot runs take each feature, how many get stuck.
- City numbers unchanged from session 3.

## Session notes

_Each session appends its notes here: decisions, measurements, problems left for later._

### Session 1 (2026-10-10): getting out of traps

**What was done** (`src/racers.js`, `src/zone.js`, `src/physics/rapier.js`, `src/physics/vehicle.js`, `src/car.js`)

- **Looking around:** `Physics.castBox` — a box shape cast against static colliders and cars (ghosts and wrecks too, not
  the car's own body, not sensors). `Rival._room(end, dx, dz)` casts only one end of the car's lower body (1.2 m of it,
  raised over curbs): a cast of the whole body stops at once on whatever its other end is wedged against, as Rapier
  reports a touching shape that slides along it as a hit at 0. Sideways casts are a little shorter, lengthwise ones a
  little narrower, for the same reason. `Vehicle.wallNormal()` — the sum of the wall-like contact normals the body has
  now (curbs and floors don't count).
- **Escape** (`ESCAPE`): stuck pushing on (< 1.5 m/s for 1.4 s, as before) → `_startEscape` finds what it hit (the
  walls it touches + cars within 5.5 m; nothing — straight ahead), picks a side along it (towards the target, not into
  a building by the 2D raycast; at the same spot again — the same side for 3 tries, then the other), and the way out
  (along the obstacle and 0.8 away from it). Then a **many-point turn**: legs back and forward (backing first if there
  is ≥ 1 m behind), each until the nose points within 0.45 rad of the way out (done), the room that way is down to
  0.4 m + 0.25 s of speed or the car hasn't moved 0.3 m in 1 s (switch, up to 6 legs), or 3 s. While a side is blocked
  and there are ≥ 2 m of room along the leg it goes straight first, otherwise it turns the wheel anyway. No shooting
  during an escape.
- **Not the same line again:** for 10 s the trap's spot (2 m into the obstacle from the car) is avoided — a target line
  passing within 4.5 m of it goes through a point 7 m to its side and 2.5 m out, until the bot is within 5 m of that
  point (closer, it would orbit it inside its turning circle).
- **Teleport** (`STUCK.time` 8 → 20 s; the `stuckT > 5` rule removed — with the escape it never fired): `respawn()`
  puts the bot on `freeSpotNear()` (`zone.js`, `SPOT`): the nearest spot on a street lane or sidewalk 8–30 m away (then
  60, 120, 240 m) with no solid within 2.8 m and no car within 6 m; +25 m of cost if a human car sees it (ahead within
  60°, ≤ 90 m, no building between), +200 outside the zone in battle royale; in a race ruled out if it is past the next
  gate or more than 60 m further from it than the car is. Heading along the street the way of the route / the zone
  centre / its own heading; `y` = floor + 2 m (`Car.teleport` takes an optional `sp.y`). The same for every bot, the
  autopilot and battle royale. The player's own "unstuck" button still goes to the last gate (not a bot rule).
- **Tests:** `traps()` in `tests/physics.js` (scripted traps, below); `botBattles()` reports `teleports` instead of
  `respawns`.

**Scripted traps** (`traps()`: one bot, its target a fixed point behind the trap, other bots wrecked and parked as
obstacles; 5 starts per trap, each turned and shifted a little; "out" — first 8 m away)

| Trap | Out by itself | Out after, s | Legs back / forward | Teleports |
| --- | --- | --- | --- | --- |
| Nose between a building corner and a tree | 5 / 5 | 3.9–5.2 | 1–6 / 1–3 | 0 |
| Nose against a wreck, a wreck along its side | 5 / 5 | 1.8 | 0–1 / 0 | 0 |
| Nose against a building, a wreck along each side | 5 / 5 | 3.2–3.3 | 2–3 / 0–2 | 0 |
| … and a wreck across the tail (it shoves them) | 5 / 5 | 6.4–11.8 | 4–8 / 3–6 | 0 |
| … the same wrecks pinned in place | 0 / 5 | — | 12–15 / 19–20 | 5, at 20.0 s, 10 m away, nearest car 6.1 m, 2 m up |
| 6.5 m alley between two buildings, nose to a wall | 5 / 5 | 5.5–7.7 | 2–4 / 1–3 | 0 |
| Teleport called next to 6 parked cars | — | — | — | spot 14 m away, nearest car 7.1 m, 2 m up, lands with no damage |

The first version on the same traps: tree 7.7 s, the side-wrecks box 7.5–10.4 s, the shoved cage 3 teleports out of 5,
the alley stuck for good (forward pushes only).

**`botBattles()`** (city, seeded games of 120 s; per game; "stuck" — the longest any bot stayed within 6 m of one spot)

| | Games | Stuck max, s (games > 10 s) | Wrecked | Ped kills | Rams > 4.5 m/s | Shots | Teleports | Back-ups | Tipped > 60° (longest) | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Race, 7 bots | 10 | 9.0 (0) | 4.0 | 49.0 | 16.3 | 76.4 | 0.1 | 6.8 | 0.3 (3.4 s) | 0 |
| Royale, 19 bots | 10 | 9.2 (0) | 18.8 | 53.9 | 56.9 | 124 | 0 | 9.7 | 0.3 (3.2 s) | 0 |
| Race crew, 7 bots | 5 | 5.9 (0) | 6.6 | 33.6 | 15.4 | 115 | 0 | 3.0 | 0.8 (3.2 s) | 0 |
| Royale crew, 19 bots | 5 | 8.8 (0) | 19.0 | 58.8 | 27.8 | 185 | 0 | 7.4 | 0.2 (0.5 s) | 0 |

Session 5's final rows (stuck / wrecked / kills / rams / shots): race 8.7 / 4.2 / 48.6 / 19.1 / 82.8, royale 8.7 / 18.7 /
65.6 / 56.7 / 128, race crew 6.1 / 6.0 / 34.8 / 16.7 / 120, royale crew 8.1 / 18.9 / 57.8 / 33 / 189, with 0–0.3
respawns per game. Now the bots stay as unstuck without being moved (one teleport in 30 games) though they may wait 20 s
instead of 8. Kills swing ±20 between seeds, as noted there. An intermediate version (before the "held" and "turn
anyway" rules) had 3 games out of 33 with a bot stuck 10–13.6 s.

**Problems found and fixed during the session**

- The "past the next gate" test first used `race.segmentProgress`, which clamps to 1.05 everywhere beyond the gate
  before it is passed (at the start of a race): every nearby spot was ruled out, and the first teleport went 112 m away.
  Now it compares the course distance to the next gate.
- A whole-body cast behind a car whose nose touches a tree returned 0 (the touching tree counts as a hit), so the bot
  never backed up far. Fixed by casting only the end that moves.
- After an escape the bot orbited the detour point, which lay inside its turning circle. Fixed by dropping the detour
  within 5 m of the point.
- In a narrow alley there was never 2 m behind, so the bot only pushed forward into the wall, and the side flipped on
  every try. Fixed by the many-point turn, the 1 m threshold and keeping the side for 3 tries.
- Wrecks along both sides: backing out on full lock swung the tail into a wreck at once. Fixed by backing straight
  while a side is blocked.
- In real games (logs of every bot still for > 9 s) a bot sometimes backed up for 3 s without moving (held by
  something the casts don't see — hung on a wreck or a curb edge), or rocked straight back and forth 0.5 m beside a
  wreck. Fixed by the "held" switch and by turning the wheel anyway when there's no room to go straight.

**Left for later**

- The goal is still a straight line: a bot whose target is behind a building gets out of the trap and then drives into
  that building's wall somewhere else (the scripted traps show it after getting out: still up to 8–12 s near the goal's
  building). Session 3's paths fix that; its re-plan should replace `_aroundTrap`'s sideways point.
- `freeSpotNear` reads `city.roads` (the grid's lanes and sidewalks): session 2 ports it to the nav grid, which also
  makes it work on the test ground and on 3D maps (a floor under a deck, etc.).
- Gotchas for measuring: editing any file under `src/` or `tests/` makes Vite reload the page mid-run; and after a few
  minutes in a hidden pane Chromium throttles `setTimeout(0)` (the tests' tick) to about once a second — 10 race games
  took over 5 min instead of 55 s. Replacing `setTimeout` for 0 ms with a `MessageChannel` post in the page fixes it.

### Session 2 (2026-10-10): navigation data

**What was done** (`src/nav/grid.js`, `src/nav/debug.js`, `src/zone.js`, `src/main.js`, `src/racers.js`,
`src/physics/rapier.js`, `src/world/city.js`, `src/car.js`, `src/net/netplay.js`, `src/config.js`)

- **`NavGrid`** (`NAV`: `cell` 1.5 m, `step` 0.4 m, `slope` 32°, `clear` 2 m, `inflate` 1.1 m, `open` 6 m), built in
  `Game` right after the Rapier world and the prop sensors, before any car: `game.nav`, also `city.nav` (the bots and
  `makeStart` reach it through their city). Input: the Rapier world (static colliders only — sensors and bodies are
  filtered out) and `city.bounds` (the fence's inner face; the height range from the solids). Nothing else from the
  map.
  - **Floors:** per column, one downward `intersectionsWithRay` gives every collider's top (and normal); the bottoms
    of upright boxes and cylinders come from the collider itself; an upward ray (hull bottoms) is cast only where a
    hull has something ≥ `clear` below its top (ramps, the trenches). The colliders are merged into solid intervals;
    a floor is the top of an interval with ≥ 2 m to the next one, a normal within 32° of up, and not the top of an
    `OBSTACLES` kind (roofs, tree tops, wall tops, rails are dropped). Stored CSR by column: `y`, `kind`, slope.
  - **Links:** to the nearest floor in each of the 8 neighbour columns whose step, measured off either floor's slope
    plane, is ≤ `step` (a ramp rises along itself; across it, its side is a step). The first version allowed
    `step + dist·tan(slope)` in any direction and linked 6 of the 113 ramp-side floors to the ground.
  - **Walkable:** linked all round (not at a drop, the deck's edge, a ramp's side) and no static collider within
    `inflate` of the centre — an upright cylinder from `step` (more on a slope) to `clear` above the floor, so curbs
    and ramps under it don't count; breakables are sensors, never obstacles. **Areas:** the biggest connected set of
    walkable floors is `main`, its floors `free`. **Room:** Dijkstra distance to the nearest unwalkable floor, 0.1 m.
  - **Queries:** `cellAt(x, y, z)` (the highest floor ≤ y + 1 m in the column), `isFree`, `nearestFree(x, y, z, r,
    { min, filter, cost })` (candidates sorted by distance, a floor on another level counts its height difference
    twice; `cost` only called while a floor could still win), `randomCell(filter)`, `solidNear(i, r)`, `axis(i)` (the
    floor's way: of 4 lines through it, the longest run of walkable floors), `pos`, `layer`, `kindOf`, `roomAt`, `next`.
  - Rapier's scene queries see nothing before the first step: `Physics` now steps the empty world once after adding
    the solids.
- **Ported to the grid** (`zone.js`): `navSpot` (a floor → `{ x, y, z, yaw }` along `axis`), `randomSpot` (was
  `roadPoint`), `spotNear` (was `roadPointNear`; the zone waypoints and the royale `R` unstuck), `spawnPoints`,
  `reachable` (a reachable floor in the column with no solid within `ZONE.centerFree` 4 m — connectivity replaces the
  "a way to the street" raycasts), `zoneCenter` (within `ZONE.centerIn` 0.62 of the map's half size — 120 m in the
  city, as before), `freeSpotNear(nav, x, y, z, …)` (same rules: 8–30 m then ×2, no solid within 2.8 m — the exact
  cylinder test, ≥ 1.5 m of walkable floor round it — `SPOT.edge`, no car within 6 m on its level, the same cost
  hooks, heading along `axis` the way of `dir`, `y` = that floor + 2 m). Spawns and waypoints use "open" floors (room
  ≥ 6 m, then 3, then any): with room ≥ 3, 21% of waypoints fell in yards and parks, which today's straight-line
  steering can't reach; at 6 m it's ~6%, mostly squares. Spawn points carry `y` (`Car.reset` takes `sp.y`, the
  network start sends it). `findRoadSpawn` in `city.js` was dead code and is gone.
- `?debug=nav` (`DEBUG_NAV`) draws every floor: road green, sidewalk blue, ramp yellow, deck grey, upper layers
  lighter; unwalkable small dark red, walkable off the main area purple (none on either map). `game.debugState().nav`.
- `navGrid(game)` in `tests/physics.js`: build time (median of 5 rebuilds), size, floors per layer and kind, and on the
  test ground the 3D checks below.

**Grids** (screenshots: [city block](docs/nav/city-block.jpg), [deck and its ramp](docs/nav/test-deck.jpg),
[tube's trench and roof](docs/nav/test-tube.jpg))

| | Columns | Floors (layer 0 / 1) | Walkable | Not walkable | Kinds (walkable) | KB |
| --- | --- | --- | --- | --- | --- | --- |
| City | 66 564 | 59 055 / 0 | 52 736 | 6 319 | road 27 189, sidewalk 25 547 | 1 677 |
| Test ground | 66 564 | 65 653 / 318 | 64 047 | 1 924 | ground 60 227 (306 on layer 1), sidewalk 3 157, ramp 332, deck 331 | 1 863 |

Test ground checks: the column at (−130, 10) has two walkable floors, the tube at −5.5 and the street over it at 0;
flooding the walkable floors from the deck without entering ramps reaches only the deck's 331 floors (from the deck
with ramps: everything); 0 of the 113 ramp floors along a side are walkable; `freeSpotNear` from inside the tube puts
the car on the tube's floor (y −3.5, 8.8 m away), from the deck on the deck (y 8), from the street over the tube on the
street (y 2).

**Build time** (desktop; the page's own build at load, then rebuilds — noisy by ±30% between pages)

| | Load, ms | Rebuilds, ms | Phases at load: floors / links / walkable / areas / room |
| --- | --- | --- | --- |
| City, desktop window | 195–201 | 244–306 | 137 / 7 / 34 / 5 / 12 |
| City, 375 × 812 `?q=low` | 199 | 191–214 | 140 / 7 / 35 / 4 / 12 |
| Test ground, desktop window | 127 | 127–143 | 79 / 6 / 27 / 4 / 10 |
| Test ground, 375 × 812 `?q=low` | 159 | 205–234 | 98 / 7 / 37 / 5 / 13 |

A Rapier ray call costs ~1.3–2 µs from JS (66 564 single rays: 89 ms; multi-hit: 125 ms), so the rays are most of it;
the first version cast an upward ray in every column and took 210–470 ms. `?q=low` changes nothing for the CPU — no
real phone was available; at 3–5× slower than this desktop a phone would take ~0.6–1 s at load.

**Checks**

- `traps(game, { names: ['pinned', 'teleport'] })`: `pinned` 5 / 5 teleported at 20.0 s, 9.5–9.9 m away, nearest car
  6.2 m, 2 m up; `teleport` 12.5–13.7 m away, nearest car 6.1–6.8 m, 2 m up, landed with full hull — as in session 1.
- Network (`tests/net.html`, royale with 5 bots): both clients start with the same zone centre and spawn points.
- `botBattles()` (city, seeded games of 120 s; per game). Rows are statistics only (the same seed gives a different
  game, and a page that has run other games gives different numbers), so the session-1 code was rerun in the same
  conditions as a baseline:

| | Games | Stuck max, s (games > 10 s) | Wrecked | Ped kills | Rams > 4.5 m/s | Shots | Teleports | Back-ups | Tipped > 60° (longest) | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Royale, 19 bots — run 1 | 10 | 7.8 (0) | 18.9 | 67.8 | 55 | 127 | 0 | 12.5 | 1.0 (11.4 s) | 0 |
| … run 2 | 10 | 9.7 (0) | 18.9 | 61.1 | 53.7 | 117 | 0 | 14.2 | 0.7 (5.1 s) | 0 |
| … baseline (session 1 code) | 10 | 10.8 (1) | 18.6 | 56.1 | 55.5 | 121 | 0 | 13.7 | 0.8 (3.6 s) | 0 |
| Royale crew, 19 bots | 5 | 8.2 (0) | 19.0 | 38.6 | 29.8 | 169 | 0 | 8.6 | 0.8 (4.4 s) | 0 |
| … baseline | 5 | 6.7 (0) | 19.0 | 44.2 | 25 | 186 | 0 | 5.6 | 1.6 (4.6 s) | 0 |
| Race, 7 bots (fresh page) | 10 | 9.0 (0) | 3.8 | 56.3 | 14.1 | 78.5 | 0 | 8.0 | 0.1 (0.2 s) | 0 |
| Race crew, 7 bots (after other rows) | 5 | 4.6 (0) | 6.4 | 37.4 | 11 | 125 | 0 | 1.4 | 0.4 (4.8 s) | 0 |

Royale rows are within the baseline's spread (kills swing 17–92 per game; crew games end in 45–101 s when every bot is
wrecked). Session 1's royale crew row (58.8 kills) and its back-ups (9.7) aren't reproduced by its own code today
either. A race run after the royale rows in the same page gave 38 kills; in a fresh page 56.

**Follow-up (the same day): the open problems**

- The 11.4 s tip: `botBattles()` now traces every tip over 6 s (`longTips`: speed, spin, the flip rule's clock, righting,
  wheels, what the body touches, cars within 6 m, every 0.5 s from 4 s on). 60 more royale games (seeds 500–559): the
  longest tip 4 s, none traced — 1 in 80 logged games, not reproduced. Safety net added instead (`VEH.flipMax` 8 s in
  `src/physics/vehicle.js`): a car tipped 8 s in a row rights itself whatever it does. Check: a car on its side dragged
  at 5 m/s (the flip rule's rate is 0 above 4 m/s) is righted at 8.03 s; before, never.
- The rest moved into the later sessions' scopes: `_navPoint`, `NAV.open`, path costs and the phone build time into
  session 3 (item 7), the ramps' lips and the deck's edges, what a map must provide and thin strips into session 4
  (item 5).

**Left for later** (now in sessions 3 and 4's scopes)

- `Rival._navPoint` still reads `city.roads` (the only reader outside the race route); session 3 replaces it with A*
  on this grid, as its scope says.
- Spawns and zone waypoints avoid yards (`NAV.open` 6 m) only because the bots can't find their way into them yet;
  with session 3's paths `open` can go down to ~3 m.
- ~~One bot lay tipped for 11.4 s in one game of 20 logged royale games~~ — done in the follow-up above: options (a)
  (every tip over 6 s traced in `botBattles()`) and (c) (`VEH.flipMax` 8 s cap). Option (b) — count `tippedT` at the
  slow rate also above `flipSlow` while the car is tipped and on the ground — wasn't needed.
- Build time on a real phone isn't measured. If it is over ~1 s there: bake the grid at build time per map (the data
  is a few typed arrays, ~1.7 MB raw, much less compressed) or build it in slices over the menu's first frames.
- Floors are sampled at column centres: a drivable strip narrower than ~1.5 m (a plank, a thin bridge) may be missed
  or broken; session 4 may need a finer cell on such maps or links for them.
- Session 4's links (jumps off ramp lips, drops off the deck, pads) aren't in the grid yet: the ramps' lips and the
  deck's edges are plain edges (unwalkable floors).

### Session 3 (2026-10-10): paths and driving

**What was done** (`src/nav/path.js` — new, `src/racers.js`, `src/main.js`, `src/nav/debug.js`, `src/nav/grid.js`,
`src/zone.js`, `tests/physics.js`)

- **`NavPaths`** (`game.paths`, also `city.paths`; constants `PATH`): weighted A* over the walkable floors of the main
  area (the grid's 8 links, so layers come with them), typed arrays with a search stamp (no clearing), an indexed heap.
  Cost per metre: 1, plus up to +3 near unwalkable floors (the square of the closeness under 8 m of room — a fast car
  needs room, so streets win over block interiors), plus up to +4 under 3 m of room (alleys a car turns into only in
  several goes), +6 within 4 m of a wreck or a car standing still for 2 s, +10 within 5 m of the bot's own traps (10 s),
  more behind a moving car within 8 m (up to +4 at 10 m/s: a path doesn't start with a U-turn), up to −50% through a
  crowd for a butcher (`gore` 1; crowds counted per 6 m cell every 0.5 s), ×0.7 on the last path's floors for the same
  gate or waypoint (no flipping between two ways round a block). Heuristic weight 1.4, up to 2.0 for goals 300 m away.
  A search stops at 12 000 floors and returns the way to the floor nearest the goal (the bot searches again 30 m before
  that end). Searches run from a queue once a frame after the bots think (`Game.step`), oldest first, until 3000
  floors are expanded (the first always runs).
- **Straight legs:** `smooth()` pulls the floor path into legs: from each corner the farthest floor (≤ 60 m) a straight
  line reaches with 3 m of room all along it (`lineFree`: a sample every 0.75 m, the floor under it followed on its
  level a step at a time), else 2.1 m (an alley), else the next floor. The first try checked a strip ±0.7 m wide with
  offset samples: legs grazed trees and poles (a floor next to an unwalkable one may be 0.6 m from a tree), cars hit
  them at 100 km/h. `polyline()` keeps the corners (vertices within 8 m summed, ≥ 0.3 rad).
- **Driving** (`Rival._go`, `_plan`, `_pursue`, `_pathSpeed`, constants `DRIVE`): every mode asks for a goal — race:
  the next gate (`_raceGoal`; the path goes on along a cached gate-to-gate leg, and on passing a gate the rest of the
  path is kept and the next leg appended, no search); hunt: the target car; gore: the pedestrian; battle royale: the
  zone waypoint or, by the wall, its centre. A goal that isn't a gate, within 45 m with a straight line of 2.1 m room to
  it, is driven at directly (a hunter at its target with the lead, as before). New path when the goal moves (fixed:
  1 m; moving: 3 m + 15% of its distance), the car is 7 m off the path, after an escape, held up by a car, or 30 m
  before a partial path's end; at most one search per bot per 0.4 s. The point steered at is 7 m + 0.5 s ahead on the
  path, nearer (0.6 of it, then the next vertex) if the straight line to it lacks room; racers shift it by their lane
  where that line has room (re-checked every 0.15 s). Speed: brake (15 m/s²) to each corner's speed 5 m before it, the
  corner speed = `def.corner` (90°) × √(sin 45° / sin(angle/2)), × down to 0.35 under 5 m of room at the corner. The
  old formula (made for the route's 90° corners) slowed every 23° kink to 59 km/h. Steering off the nose: over 0.6 rad
  18 m/s, 1 rad and more 10 m/s (was 10 m/s past 0.6 rad: every kink braked hard).
- **Local avoidance** (`Rival._avoidCars`, `AVOID`): cars and wrecks ahead (2 m past my nose up to 6 m + 1.1 s of
  speed, within 3 m of the line to the steering point; moving cars only if I close in at 2 m/s or more; not the hunt
  target; not when the steering point is over 1.2 rad off the nose — it has to turn first): the nearest of ±0.25, 0.5,
  0.8 rad that is clear and has 10 m of drivable floor (the side taken last time first, for 1 s); none — slow to the
  blocker's speed but not below 4 m/s, and search again (a still car costs extra). The first version braked to 0 behind
  a wreck and never counted as stuck: in `wreckSide`, `boxed`, `caged` the bot sat 20 s and was teleported; and with
  wrecks beside it counted as "ahead" it never pushed into the wall, so the escape didn't know where the obstacle was.
- **Escape:** the many-point turn is session 1's; `_aroundTrap`'s sideways point is gone: the trap spot goes into
  `traps` (costs above) and the bot searches again. `_navPoint` (the last reader of `city.roads` outside the route) and
  `_clearLine` are gone; `_sees` (the 2D sight line) is only for picking pedestrians. Bots no longer use
  `cornersAhead`/`pointAt` (`race.project` still serves the respawn's course distance and the standings).
- **`NAV.open` 6 → 3 m** (spawns and waypoints); `?debug=nav` draws every bot's path (magenta, `pathLines`).
- **Tests:** `frameCost()` (step cost with 19 bots, the bots' share, searches), `waypoints()` (royale waypoints in
  yards: reached or not), `botBattles()` also reports `stuckNoRam` (the stuck time without ramming the hunt target
  within 15 m, as the `STUCK` rule counts it); `traps()` sets the goal through `_raceGoal`.

**Measured.** Rows are statistics: the same seed gives a different game, and the sim isn't deterministic between pages.
The session-2 code was run alongside as a baseline (a git worktree on a second dev server, same tests).

Scripted traps (`traps()`, 5 starts each; "after out" — the longest stay within 6 m of one spot more than 12 m from the
goal; "end" — distance to the goal at 30 s)

| Trap | Out by itself | Out after, s | Legs back / forward | After out, max s (baseline) | End, m (baseline) |
| --- | --- | --- | --- | --- | --- |
| Tree and building corner | 5 / 5 | 4.4–5.5 | 1 / 1 | 1.5 (0.7–12.3) | 4.9–5.3 (1.5–28) |
| Wreck ahead, wreck beside | 5 / 5 | 1.4–1.6 | 0–1 / 0–1 | 0.7 (0.8–1.1) | 5.5–7.1 (2.4–5.7) |
| Building ahead, wrecks both sides | 5 / 5 | 3.2–9.4 | 1–5 / 0–4 | 2.9 (2.8–6.2) | 2.9–5.3 (6.2–9.8) |
| … and a wreck across the tail | 5 / 5 | 6.6–11.5 | 6–8 / 4–6 | 4.7 (0.7–6.8) | 2.7–7.3 (2.7–28.9) |
| … pinned | 0 / 5 | — | 12–16 / 19–20 | teleported at 20.0 s, 8–9.8 m away, nearest car 6.2 m, 2 m up | |
| 6.5 m alley | 5 / 5 | 2.9–6.9 | 0–5 / 0–4 | 6.6 in 1 of 5, else ≤ 2.1 (0.3–0.5) | 2.4–6.1 (1.4–8.4) |
| Teleport by 6 parked cars | — | — | — | spot 12.5–13.7 m, nearest car 6.1–6.8 m, 2 m up, full hull | |

Every trap but `pinned` is left by the bot itself and it reaches the goal (the baseline didn't in 3 of 25: it drove
into the goal's building elsewhere). One alley start of 30 stays 6.6 s after "out" (turning round inside the alley,
see Left for later).

Race pace. One racer alone, no hunting (aggr 0, gore 0), 9 gates (a lap and the first gate): **49.3–50.1 s**
(4 starts), the baseline's route following 50.3–53.4 s — paths cut across plazas where the route kept to the street
middles. `botLaps()` (7 bots, 25 s, mixed personalities; noisy — runs of the same code differ by up to 5 km/h):
average speed 53.4–58.5 km/h (5 runs over the session, mean 56.6), the baseline 57.1–61.5 (3 runs); gates passed per
run 14.2–16.8 (mean 15.6), the baseline 15.2–15.8. So the acceptance's "not below ≈ 58–62 km/h" is met by 2 runs of 5:
the bots pass as many gates on shorter paths (less distance for the same progress), and a lone racer laps faster.

`botBattles()` (city, seeded games of 120 s; per game)

| | Games | Stuck max, s (games > 10 s) | Without rams | Wrecked | Ped kills | Rams > 4.5 m/s | Shots | Teleports | Back-ups |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Royale, 19 bots | 10 | 9.4 (0) | 7.7 | 18.3 | 65.8 | 63.2 | 154 | 0 | 12.9 |
| … baseline | 10 | 9.2–11 (0–2) | 10.3 | 18.9 | 53.6–60.7 | 52.8–55.9 | 119–125 | 0 | 11.5–11.7 |
| Race, 7 bots | 10 | 6.6 (0) | 5.7 | 3.1 | 52.7 | 20.3 | 91.6 | 0 | 6.1 |
| … baseline | 10 | 7.2–8.1 (0) | 8.1 | 4.0–4.1 | 41.3–42.9 | 19.2–20.1 | 66–76 | 0 | 5.4–7.4 |
| Royale crew, 19 bots | 5 | 7.2 (0) | 7.2 | 19 | 46 | 22.6 | 195 | 0 | 6.2 |
| … baseline | 5 | 6 (0) | 5.4 | 19 | 40.8 | 28.6 | 176 | 0 | 8.2 |
| Race crew, 7 bots | 5 | 4.9 (0) | 4.9 | 5.8 | 45 | 10.8 | 148 | 0 | 4.4 |
| … baseline | 5 | 5 (0) | 5 | 6 | 47.6 | 10.6 | 138 | 0 | 4.8 |

Kills are up in the classic rows (butchers route through crowds, hunters reach their targets), wrecks the same, no
teleports. Intermediate versions in the session gave 1–4 games over 10 s per row (bots braking to a standstill behind
wrecks, scrums); the baseline itself gave 2 of 10 in one royale run.

Battle royale waypoints (`waypoints()`, 5 games, 19 bots): with `NAV.open` 3, 46% of the waypoints (183 of 395) have under 6 m of room (yards, parks, by walls — kept out before); bots reach 62% of them (mean 10.2 s) and 59% of the open ones (10.7 s). The baseline (open ≥ 6 m only)
reached 48% (mean 12.2 s). Not reached: the bot went hunting, or the zone moved on.

Cost (`frameCost()`, battle royale, 19 bots, 3 × 30 s; `game.step` without rendering). Desktop window, the two codes
alternated: **1.02 / 1.13 ms against 1.07 / 1.03** (+2%); the bots' share 0.072 / 0.081 ms against 0.051 / 0.045
(+0.03 ms). Phone-sized 375 × 812 `?q=low` (step and render, one tab, the codes alternated): step 1.39–1.66 against
1.31–1.49 ms (+8%), of it the bots (think + searches) 0.14–0.18 against 0.08–0.11 ms; the rest is the game played
differently (more cars alive and fighting: physics +0.02–0.05 ms). With rendering (1.1–1.9 ms) the frame is +3–4%.
~17 searches a second, ~190 floors each, ~0.05 ms. The machine's speed drifts by ±15% over minutes (the same code
gave 1.11 and 1.36 ms in two tabs), so only alternated runs compare. An earlier version did 811–1129 floors per
search: butchers' crowd discount had weakened their heuristic to 0.7 (7–10 thousand floors for 120 m), and many long
searches hit the 12 000 cap.

**Problems found and fixed during the session**

- Legs grazed trees (the ±0.7 m strip test): room-based legs (above).
- The route's corner formula braked for every kink: the radius-based one (above). A pure racer went from 71–74 km/h
  alone (behind the baseline's 85) to a faster lap than the baseline.
- On passing a gate a fresh search took a different way than the planned continuation, often a sharp turn right at
  the gate (the car nearly stopped): the path is spliced instead.
- Paths through block interiors (shorter, slower): the room cost up to 8 m.
- Braking to 0 behind wrecks (20 s teleports in three traps): crawl at 4 m/s, stuck counted when pushing.
- Every new search for the same goal could start the other way round a block as the car turned (`caged`: 17 s at an
  alley mouth): heading cost behind the car, alley cost, ×0.7 on the last path's floors (fixed goals only: for a hunt
  target the old way leads to where it was — with it on for hunts too, 4 of 25 games had a bot over 10 s).
- Expensive searches: the heuristic weight by distance, butchers' heuristic not discounted.

**Left for later** (what concerns 3D is in session 4's scope, item 6)

- ~~Turning round in a narrow place~~ — done in the follow-up below, option (a). Options (b) (A* over floor and
  heading with the car's turning radius) and (c) (a stronger heading cost where room is low) weren't needed.
- `botBattles()`' `stuckMax` still counts a hunter ramming in a scrum (`stuckNoRam` doesn't): the remaining long
  stays are mostly scrums (rams went up from ~54 to ~63 per royale).
- The grid's build time on a real phone is still not measured (no phone here); see session 2's options.
- Local avoidance looks at cars analytically (centres in a corridor, no shape): a wreck lying across the corridor's
  edge may be missed. Rapier shape casts (as the escape uses) if it shows.
- Lanes only shift the steering point; with every racer on the same cached gate legs a jam at a narrow gate is
  possible (none seen).

**Follow-up (the same day): turning round on purpose** (`Rival._startTurn`, `_roomHere`, `ESCAPE.uturn*`)

- A bot slower than 4 m/s whose steering point on its path is more than 2 rad off the nose, on a floor with under
  3.5 m of room (or no walkable floor), starts the escape's many-point turn at once towards that point (back first if
  there's 1 m behind), not again for 3 s; it isn't a trap (no cost, no stuck bump after it). `traps()` reports `uturns`,
  `botBattles()` `uturns` per game.
- `traps()`: tree and building out after 1.8–4.1 s (was 4.4–5.5), building with wrecks both sides 1.5–1.6 s in 4 of 5
  (was 3.2), the caged one 8.3–10.8 s (was 6.6–11.5); after out at most 2.4 s everywhere but the same `alley` start 3
  (6.6 s, the turn didn't fire there: it was outside the alley by then; in another page the same start turned twice and
  got out east in 8 s — the outcome depends on the page's state); `pinned` still 20.0 s, 8–9.8 m, nearest car 6.2 m,
  2 m up. Every non-pinned start reaches the goal (end 2.4–7.1 m).
- `botBattles()` (per game): royale stuck max 12.2 s (2 of 10 over 10 s, both a hunter ramming in a scrum —
  `stuckNoRam` 8.7, 0 over 10), wrecked 18.1, kills 69.7, rams 62.9, back-ups 27 (13.8 of them turns), teleports 0;
  race 9.9 (0), wrecked 3.8, kills 45.8, back-ups 12.7 (6.6 turns), teleports 0; royale crew 7.9 (0), kills 52.8;
  race crew 4.6 (0), kills 42.2. `botLaps()` 55.1 km/h, 16 gates per run (within the range above). `frameCost()`:
  step 1.08 ms, the bots 0.079 ms — unchanged.

### Session 4 (2026-10-10): 3D — ramps, jumps, drops, decks and tunnels

**What was done** (`src/nav/links.js` — new, `src/nav/grid.js`, `src/nav/path.js`, `src/nav/debug.js`, `src/racers.js`,
`src/race.js`, `src/world/city.js`, `src/main.js`, `src/config.js`, `src/car.js`, `tests/physics.js`)

- **Jumps** (`buildLinks` in `src/nav/links.js`, constants `JUMP`; `nav.jumps`, CSR by the take-off floor
  `nav.jumpStart`/`jumpTo`). Candidates: an edge floor with a lower floor (> 0.4 m) beyond it in a direction where it
  has no link — off a slope only along the slope (a ramp's lip, not its side), off a flat edge straight out (a deck, a
  tunnel's portal) — and the lip going on sideways; plus every catapult's border floor driven onto straight. The car's
  lower body (a box, no spin) is flown from the lip, starting as the tail leaves it, a shape cast against the static
  colliders every 0.05 s, at 14–36 m/s (a catapult from 6, thrown up at `VEH.launch`). A flight lands well on a
  reachable floor with 1.5 m of room, at most 19 m/s into it, with straight walkable floor (room ≥ 1.5) after it for
  6 m + the way to stop from the lip speed at 15 m/s². The widest range of speeds that land well is cut into bands of
  6 m/s every 4 m/s; a jump per band per entry to the run-up (the straight walkable floors before the lip with walkable
  floors on both sides; an entry every 3 floors from 10 m before a ramp's lip / 9 m before an edge or a catapult up to
  40 m) where a car entering at 8 m/s reaches the band's middle speed by the lip at full throttle (`thrustAt`, new in
  `car.js`, against the climb). A jump keeps its kind (`jump` off a ramp, `drop` off an edge, `launch`), lip, way,
  grade, run-up length, band (`lo`…`hi`), landing distances per speed, the hardest landing (`vin`) and `to` — the
  floor at the end of the run-out after its farthest landing (where A* goes on).
- **Pads:** the map's pads (`city.pads`: boost and catapult rectangles with their floor height) go into `buildNav`;
  `nav.pad[i]` (`PAD`); a catapult's floors aren't walkable (driving over one throws the car: only its jumps lead
  over it). Boost pads are only marked (see Left for later).
- **A\*** (`NavPaths.find`): a jump is an edge from its take-off floor to `to`, costing the run-up's length, half the
  flight and run-out's, +4, +1.5 per m/s its `lo` is over 14 (a gap), +2 per m/s of `vin` over `VEH.landSafe`
  (`PATH.fly/jump/gap/hurt`). Not taken against its way (the last step into the take-off floor; a run-up shorter than
  18 m only straight along it, `PATH.longRun`), by a bot whose top speed is under the band's middle + 2 m/s
  (`speed`), or off a lip within 6 m of one the bot gave up lately (`banned`). The path comes with `cells.jumps`.
  Slopes cost 150 × (grade − 0.15)² more per metre, the grade from the neighbours' heights (the big ramp +1; the deck's
  ramp, curbs and curbs' bevels nothing — a floor normal shows a bevel's 27°). **A goal on another level** (more than
  1.5 m up or down, or under another floor): a Dijkstra back from it over 4000 floors (base costs, jumps backwards,
  `_field`) gives the heuristic (× 0.7 where it got, its radius beyond) — with the plain 2D heuristic the tunnel's gate
  looked a few metres from the street over it, and the search flooded that street until `PATH.max` (12 000) and
  returned a path to the street.
- **Path smoothing:** a leg never passes a take-off floor; a jump adds its lip and the end of its run-out as vertices,
  in a straight line. The polyline carries `jumps` (`k0/k1/k2`, `s0/s1/s2`, `q`), `crests` (the grade over two floors
  dropping by ≥ 0.06 → a speed `√(8 m · g / (2 · drop))`: the deck's top 23 m/s) and `fly` (legs off a lip);
  `joinPaths` and the new `sliceFrom` (the race's splice at a gate) keep them. `projectOn` counts the height off a
  leg's line beyond 2.5 m (×3), except on legs off a lip.
- **Driving** (`Rival`; `DRIVE.commit/onRun/ban/last/offLip/stop/edge`): before a jump the look-ahead stops at the
  take-off floor + 2 m (onto the run-up at its start, not cutting in); on the run-up and over the jump the bot steers
  along the path, holds the band's middle speed (the lip is a "corner" at `hi` − 1), from 14 m before the lip to the
  end of the run-out takes no new path (a search already queued waits) and avoids no car; past the lip it doesn't brake
  for 6 m nor in the air; in the air the wheel is straight. Crossing a run-up's line with the nose more than 1 rad off
  its way isn't being on it: it steers for the take-off floor and asks for a new path. `_jumpCheck`: if at full
  throttle it won't make the band's `lo` by the lip, or within 6 m of the lip it's slower than `lo` − 0.5 or more than
  0.45 rad off the way, it gives the jump up — brakes (only while it can still stop before the lip at 18 m/s², else it
  goes), bans jumps off that lip for 15 s, searches again. `_edgeAhead`: a drop along its heading (a floor more than
  1.45 m lower than the one it follows; a wall or a step up isn't one) within its stopping distance limits its speed to
  stop 3 m short (not on a run-up); held there counts as stuck, and the escape's legs (`_roomAlong`) and a hunter's
  back-up see drops (`_dropDist`).
- **Race course from the map** (`city.course`: a closed route and gates `{ x, z, y, w, h }`; the city's moved out of
  `race.js` unchanged). A gate counts from 3 m below its floor to 1 m under its top (`atGate`, `RACE.below`); a bot's
  goal and gate legs use its `y`. The test ground's course: a gate before the big ramp, one after its landing, one on
  the deck, one north of it (off the deck's edge), one in the tunnel (narrower: `w` 3.6, `h` 4.4), the finish after the
  tube southbound.
- **`?map=test&bots=N`** (`TEST_BOTS`): the test ground as a playable map — the menu's race or battle royale with N
  bots (`game.test` is the free ride only, `game.testMap` the map).
- **`NAV.step` 0.4 → 0.25 m:** the deck ramp's foot had walkable floors on its side (a 0.15–0.4 m vertical face; curbs
  are bevelled), cars cut over it and hit it. No link in the city has a step over 0.25: its grid is unchanged (59 055
  floors, 52 736 walkable).
- `?debug=nav` also draws the jumps (`jumpLines`): the run-up white, the flights at the band's slowest and fastest
  speed orange (off a ramp), cyan (off an edge), red (catapult).
- **Tests:** `testGround()` (test ground with bots: N seeded games, how often bots use each feature — `FEATURES` —,
  hard hits on ramps' and the deck's sides, tips with where and how, given-up jumps, stuck, teleports, gates),
  `featureRuns()` (one bot from before each feature to a goal past it, `FEATURE_RUNS`, 5 starts each), `botTrace()`
  (one bot's drive frame by frame — speed, input, its place on its path, the jump ahead).

**What a map must provide for navigation** (also in the README, Physics): static colliders in the Rapier world with a
kind each (`solids`; tops of `OBSTACLES` kinds are never floors; breakable props are sensors, never obstacles; upright
boxes and cylinders are cheapest — their bottom needs no ray); `bounds` (`x0, z0, x1, z1` — where cars can be — and
`y0, y1` — the colliders' height range); `pads` (boost / catapult rectangles with their floor height); for a race,
`course` (a closed route for progress, standings and the minimap; gates with their floor `y`, and `w`/`h` where the
default 15 × 7 m gate doesn't fit); `spawn` (the race's grid). Spawns, zones and waypoints of a battle royale, the
teleport spots, the jumps and every bot rule come from these.

**Measured.** Rows are statistics: the same seed gives a different game, and pages differ. The session-3 code ran
alongside as a baseline (a git worktree on a second dev server, same tests).

Real car off the test ground's features (the player's car, held at a speed by hand, before the jumps existed): off the
deck at 4–10 m/s it rolls over (8–30 hull lost), 13 m/s pitches it to 59° (`upY` 0.51), 16 to 49°, 20 to 40°, all land
on the wheels; off the big ramp 12–24 m/s at the lip all land well (from a standstill 30 m before it a car gets 23.6 m/s
at the lip); the ramp over the exit trench: 21.7–22.3 m/s at the lip at most (lands just past the far rail). Hence
`JUMP.speeds` from 14, and no jump over the trench (its bands need ~25 m/s).

Jumps: test ground 655 (68 off ramps, 465 off edges, 122 onto the catapult), the phase ~30 ms of a 173–294 ms grid
build (desktop); city none (the phase 3 ms; the grid +290 KB for the pad and jump index arrays).

`featureRuns()` (5 starts each; final code)

| Run | Used the feature | Reached the goal, s | Jumps | Given up | Tips | Side hits | Stuck max, s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Big ramp | 5 / 5 | 5 / 5, 5.7 | 5 | 0 | 0 | 0 | 0.5 |
| Boost pad and kickers | 5 / 5 | 5 / 5, 10.3–10.4 | 10 (2 kickers each) | 0 | 0 | 0 | 1.1 |
| Over the exit trench | 0 / 5 (no jump: too fast for a car) | 5 / 5, 4.6 (round its end) | 0 | 0 | 0 | 0 | 0.6 |
| Up the deck's ramp | 5 / 5 | 5 / 5, 4.0 | 0 | 0 | 0 | 0 | 0.5 |
| Off the deck north | 5 / 5 | 5 / 5, 3.6 | 5 | 0 | 0 | 0 | 0.6 |
| Off the deck west | 5 / 5 | 5 / 5, 3.1–3.2 | 5 | 0 | 0 | 0 | 0.6 |
| Through the tube (free route) | 0 / 5 — over its roof, off the south portal | 5 / 5, 8.7–8.8 | 5 | 0 | 0 | 0 | 0.6 |
| Catapult over the wall | 5 / 5 | 5 / 5, 4.7 | 5 | 0 | 0 | 0 | 0.5 |

`testGround()` — the test ground's race, 7 bots and my car on the autopilot, seeded games of 120 s (a butcher's carnage
win is switched off: the big ramp lands in the line of 50 pedestrians, a butcher got 40 in 47 s). Per 6 games:

| | Big ramp | Up the deck | Off the deck | Through the tube | Jumps | Given up | Tips > 60° | Side hits > 4 m/s | Stuck max, s | Teleports | Gates |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Final | 40 | 50 | 48 | 33 | 74 | 6 | 20 | 9 (6 hunting) | 9.6 | 0 | 281 |
| Before `NAV.step` 0.25 | 39 | 49 | 47 | 33 | 75 | 3 | 18 | 14 (10 hunting) | 11 (1 game) | 0 | 286 |

The first version (one jump per lip) in the same race: big ramp 0, tube 0 (stuck 10 s in the entrance trench), deck 3;
with bands but before the run-up fixes: 22 / 31 / 30 / 17 per 3 games with 28 tips and 18 give-ups. The tips left: 5
at the start (seven cars reach the big ramp together in the first 8 s), ~6 slow ones at the deck's west edge after a
give-up or in a fight, 3 slow falls off the big ramp's west side, the rest hunters and butchers fighting on the deck.

Battle royale on the test ground (4 games of 120 s): the bots fight (26 of 28 wrecked) and rarely get to a feature
(deck 1, the rest 0); one bot 13.1 s at the top of the tube's entrance trench. Not a navigation problem as such.

City, against the session-3 code (`botBattles()`, per game):

| | Games | Stuck max, s (> 10) | Without rams | Wrecked | Ped kills | Rams | Shots | Teleports | Back-ups | Turns |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Royale, 19 bots | 10 | 9.5 (0) | 8.9 | 18 | 67.5 | 58.9 | 157 | 0 | 27.2 | 14.8 |
| … baseline | 10 | 9.8 (0) | 9.7 | 18.4 | 66.4 | 62.3 | 169 | 0 | 28.9 | 14.5 |
| Race, 7 bots, seeds 500… | 10 | 12.9 (2) | 12.9 (1) | 3.2 | 45.4 | 22.5 | 84.7 | 0 | 17.7 | 9.4 |
| … baseline | 10 | 12 (1) | 7.1 | 3.4 | 51.4 | 26.8 | 84 | 0 | 12.2 | 6.2 |
| Race, seeds 600… | 10 | 7.4 (0) | 6.8 | 3.4 | 45.9 | 20 | 78.3 | 0 | 13.5 | 7.5 |
| … baseline | 10 | 9.2 (0) | 8.2 | 3.5 | 47.3 | 26.6 | 88.8 | 0 | 14.5 | 7.7 |
| Royale crew | 5 | 8 (0) | 5.6 | 19 | 44.6 | 31.8 | 210 | 0 | 13.6 | 7.8 |
| … baseline | 5 | 6.8 (0) | 6.8 | 19 | 41.8 | 28.2 | 196 | 0 | 13.4 | 10 |
| Race crew | 5 | 20 (1) | 20 (1) | 5.6 | 36.4 | 8.8 | 133 | 0.2 | 3.6 | 2 |
| … the same seeds again / seeds 520… | 5 + 5 | 6.2 (0) / 6.2 (0) | 6.2 / 6.2 | 6.2 / 6.2 | 35.2 / 29.4 | 11 / 9.4 | 124 / 121 | 0 / 0 | 5.6 / 5.8 | 2.6 / 3.2 |
| … baseline | 5 | 5.6 (0) | 5.6 | 5.8 | 45.8 | 7.2 | 142 | 0 | 5.2 | 2 |

The one crew game with a bot stuck 20 s (teleported) had an 8.8 s tip in it (the `VEH.flipMax` net); it didn't come
back in 10 more crew games, and its trace wasn't kept. `traps()`: as in session 3 (tree and building out after
1.8–4.1 s, wreck beside 1.4–1.6, building with wrecks both sides 1.5–9.2, caged 8.3–10.8, alley 2.9–6.1 with at most
4.3 s after out; pinned teleported at 20.0 s, 8–9.8 m away, nearest car 6.2 m, 2 m up; the teleport by 6 parked cars
12.5–13.7 m away, nearest car 6.1–6.8 m, 2 m up, full hull). `botLaps()` (5 runs, twice): 54.5 / 60.2 km/h, 15.2 /
18.4 gates per run; baseline 57.7 / 60.0, 16.8 / 17.4 (runs of one code differ by up to 5 km/h). `frameCost()`
(royale, 19 bots, 3 × 30 s, the codes alternated): step 1.114 / 1.14 ms against 1.126 / 1.091 (+1.5%), the bots
0.094 / 0.095 ms against 0.083 / 0.079 (+0.013 ms: the edge and drop looks).

**Problems found and fixed during the session**

- One jump per lip with the run-out after its fastest landing (36 m/s: 90 m past the big ramp's lip): it ended far
  past the next gate, A* never took the big ramp. Bands, each with its own run-out.
- The tunnel's gate: searches capped at 12 000 floors, flooding the street over it (the 2D heuristic), and returned a
  path to the street. The goal's field.
- A racer's lane shifted its steering point 1.5 m from the deck ramp's side (a line's end needs no room): the shifted
  point must have room.
- Drops off the deck at ~10 m/s rolled cars over: they came onto a 24 m run-up through a hairpin, still turning
  (`DRIVE.sharp` capped them at 10 m/s), and A* picked bands no run-up could reach (24–30 m/s from a 9 m one). Entries
  along the run-up (a car on the deck near its edge takes the drop from there, not from 24 m back), the reach filter,
  the way rule, the 14 m/s floor and the last check.
- Right past the lip the bot braked for the corner after the landing while its back wheels were still on the deck: the
  nose dropped and it landed on its roof. No braking for 6 m past the lip.
- A search queued before the run-up replaced the path in the air (no jump ahead any more: steering, braking). No
  searches while committed.
- The bot crossed a run-up's line facing elsewhere (going back to a take-off floor behind it), snapped onto the run-up
  and drove off the deck's side. The heading rule and a new path.
- Giving a jump up at the lip, then rolling over it slowly; a many-point turn's forward leg off the deck's edge (the
  casts don't see a drop). Give up only while it can stop; legs, back-ups and an edge look see drops.
- Slopes from floor normals would have taxed curbs' bevels (27°) in the city: grade from the neighbours, over 0.15.
- The deck ramp's foot was walkable from the side (`NAV.step` 0.4): 0.25.

**Left for later** (no later session in this plan yet; options, the recommended one first)

- **The start at a ramp:** a quarter of the test ground's tips are its first 8 s — seven cars take the big ramp's four
  run-up columns at once and collide on it. (a) A lip reservation: a bot on a run-up claims its lip for the time it
  needs; another one whose path goes off the same lip (within 4 m) and would reach it within ~1 s of it slows down or
  takes another band or entry. (b) Spread the start (only the test ground's layout). (c) Accept it (it's a
  Carmageddon start). Recommended (a).
- **Hunters and butchers on ramps and the deck:** most side hits (6 of 9) and a third of the tips are bots fighting on
  the deck and the ramps — driving straight at a target (the direct line only checks floors it samples, a ramp's side
  between two samples or at its foot slips through) and ramming. (a) In direct mode also refuse a line whose
  successive samples differ by more than `NAV.step` (a side crossed between samples), and stop a ram's charge at an
  edge (`_dropDist`). (b) Leave fights as they are (they are the game). Recommended (a).
- **Slow falls at the deck's west edge and the big ramp's west side** (~9 per 6 games, 5–20 km/h): after a give-up the
  bot stops near the lip and the new path or a push takes it over; on the big ramp a bot turned or pushed on it falls
  off its side. (a) After a give-up, back off straight before the new path starts (an escape leg backwards). (b) Make
  the flip rule right a car that fell off a ledge faster. Recommended (a).
- **Boost pads on a run-up aren't modelled:** the trench jump needs ~25 m/s and a car gets ~22 there; a boost pad on
  its run-up would make it usable. (a) Count a boost pad crossed along the run-up in the reach filter (`VEH.boost`) and
  let the bot hold the band's speed after it. (b) Nothing until a map puts a boost before a gap. Recommended (b) — the
  test ground has no boost there.
- **No spin in the flight model:** off an edge at 13–16 m/s a real car pitches 45–60° (covered by `JUMP.speeds` from
  14); a higher ledge may need more. (a) A speed floor growing with the drop's height. (b) Fly a real car body in a
  scratch Rapier world at build time (exact, ~100× the cost). Recommended (a) when a map shows it.
- **The tube is avoided on free routes:** its 8 m width (room 3) costs ~2.8× a metre, so bots go over its roof and
  drop through a portal; the race's gate in it makes them go through. (a) Measure room across a long straight corridor
  only. (b) Leave it (session 3's costs keep fast cars on wide streets). Recommended (b).
- **One-way areas** (reachable only by a drop, no way back) are left out of `main`: never a goal, never a landing.
  Directed reachability over the jumps when a map has such a pit.
- **Thin strips** (session 2's item, unchanged): a drivable strip narrower than a column (1.5 m — a plank, a thin
  bridge) may be missed or broken. A finer `NAV.cell` for such a map, or a link along the strip.
- **Lips only along the grid's 8 directions:** a ramp at 30° to them gets no jump (within ~25° it gets one along the
  grid). Fly along the floor's own gradient when a map has such a ramp.
- **Phone:** the grid's build time and the frame cost are still unmeasured on a real phone (sessions 2–3); the jumps
  add ~30 ms on the desktop.
- **Battle royale on the test ground** turns into a brawl before the bots reach the features (a zone waypoint is a
  random floor). Not needed for navigation.

**Follow-up (the same day): the recommendations applied** (`src/racers.js`, `src/nav/path.js`, `tests/physics.js`)

- **Lips taken in turn** (`Rival._lipTurn`, `DRIVE.lipR/lipGap/lipMin/lipLook`): a bot whose path has a jump within
  60 m claims its lip (`claim`: where, when it gets there at its speed, ≥ 8 m/s); another bot heading for a lip within
  4 m that would get there less than 1 s after it slows down to arrive 1 s later — before its run-up only, not below
  8 m/s (`JUMP.entryV`). The first version yielded down to 5 m/s and on the run-up too: bots then came onto the big
  ramp too slow, gave the jump up on it and stood there (2 games of 6 with a bot 13 s stuck, 15 give-ups).
  `testGround()` reports `yields`.
- **Straight lines and ramps' sides** (`NavPaths.lineFree`): between two samples a line climbs or drops at most
  `NAV.step` + the steepest slope over the distance (0.72 m per 0.75 m; was 1.3 m — a ramp's low side by its foot
  passed); and it crosses a slope only within ~30° of along it (`PATH.along`; slopes over 3° whose neighbour along
  them slopes the same way — 775 floors on the test ground, none in the city: a curb's bevel is one floor wide).
  Direct lines at a target, path legs and the line to the point steered at all use it. A hunter's ram already stops at
  an edge (`_edgeAhead` limits every target speed but on a run-up).
- **Backing off after a give-up** (`DRIVE.retreat`): stopped at the lip after giving a jump up, the bot reverses
  straight for 2 s (while there is 1 m behind) before the new path takes it anywhere; and it gives up only while it can
  stop 3 m short of the lip (was 1.5 m).
- The other recommendations were "nothing until a map needs it" (boost pads on a run-up, spin in the flight model,
  the tube's room cost).

Measured (`featureRuns()` unchanged: every feature 5 / 5, no tips, no side hits). `testGround()`, race, 6 games of
120 s each, per 6 games:

| | Big ramp | Up the deck | Off the deck | Tube | Jumps | Given up | Yields | Tips > 60° (in the first 8 s) | Side hits | Stuck max, s | Teleports | Gates |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Session 4 | 40 | 50 | 48 | 33 | 74 | 6 | — | 20 (5) | 9 | 9.6 | 0 | 281 |
| Lip turns, lines, back-off | 46 | 57 | 55 | 37 | 90 | 1 | 76 | 19 (2) | 11 | 6.7 | 0 | 293 |
| … and lines along ramps | 42 | 51 | 48 | 28 | 82 | 6 | 76 | 17 (2) | 11 | 7.6 | 0 | 254 |

An intermediate run (lines and back-off, the first lip turns) had 3 side hits in 6 games and 347 gates, so side hits
swing 3–11 per 6 games between runs; about two thirds are hunters and butchers fighting at the deck ramp's foot, the
rest a car pushed or scraping along its side in traffic (traced alone, a bot rounds the ramp's corner and turns into
it before its foot). The start's tips at the big ramp: 5 → 2. City (battle royale, 19 bots, 5 games): stuck 11.1 s
(2 games over 10 — hunters ramming in a scrum; without rams 8 s), teleports 0, kills 75, rams 65 — as before.

**Left for later** (updated)

- Side hits at the deck ramp's foot (~2 per game, two thirds in fights): (a) avoidance that sees a ramp's side from
  below (a cast of the box ahead against static colliders, as the escape's), (b) leave them — they cost little hull
  at 15–40 km/h. Recommended (b) unless a map's ramps sit in the traffic's way.
- Slow falls at the deck's west edge (~1 per game, mostly hunters and butchers chasing across the deck): the edge
  look watches the heading only — a car turning by an edge swings its side over. (a) Also look along the velocity and
  to the side the car turns. Recommended (a) if it matters.
- The rest of session 4's list stands (boost pads on a run-up, no spin in flights, the tube's room cost, one-way
  areas, thin strips, lips off the grid's 8 directions, the phone).
