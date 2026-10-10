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

**Left for later**

- `Rival._navPoint` still reads `city.roads` (the only reader outside the race route); session 3 replaces it with A*
  on this grid, as its scope says.
- Spawns and zone waypoints avoid yards (`NAV.open` 6 m) only because the bots can't find their way into them yet;
  with session 3's paths `open` can go down to ~3 m.
- One bot lay tipped for 11.4 s in one game of 20 logged royale games (the others: ≤ 5.1 s; earlier sessions up to
  5.5 s). Not reproduced: a car put on its roof on a wreck rights itself in 2–2.3 s, and the logged tips were cars
  rocking on their side at ~2 m/s (the flip rule's slow rate, 3 s). Unrelated to navigation (it only moved spawns and
  waypoints). Options: (a) log every tip over 6 s in `botBattles()` (speed, spin, righting, contacts) and catch it —
  recommended first; (b) count `tippedT` at the slow rate also above `flipSlow` while the car is tipped and on the
  ground, so a car pushed along on its side still rights itself; (c) a hard cap: tipped for 8 s → `right()` whatever.
- Build time on a real phone isn't measured. If it is over ~1 s there: bake the grid at build time per map (the data
  is a few typed arrays, ~1.7 MB raw, much less compressed) or build it in slices over the menu's first frames.
- Floors are sampled at column centres: a drivable strip narrower than ~1.5 m (a plank, a thin bridge) may be missed
  or broken; session 4 may need a finer cell on such maps or links for them.
- Session 4's links (jumps off ramp lips, drops off the deck, pads) aren't in the grid yet: the ramps' lips and the
  deck's edges are plain edges (unwalkable floors).
