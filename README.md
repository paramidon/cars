# Cars & Guts

A Carmageddon-style arcade racing and car-mayhem prototype built on **three.js**. A small city, a checkpoint track,
four rivals, crowds of pedestrians, and a red car with a spiked bull bar and a cannon on the roof.
Plays on desktop and on phones.

**How to win** — three ways: finish first after 3 laps, wreck all rival cars, or be the first to run down
50 pedestrians. If a rival gets there first (finishes or racks up 50 pedestrians), you lose. You can also
lose by wrecking your own car or running out of time.

**Games** (the menu sets the game, the mode, your seat and the number of rivals: 1–7 in a race, at most 8 cars in total; battle royale also offers 10, 15 or 19 — up to 20 cars):

- **Race** — 3 laps through checkpoints, as described above.
- **Battle royale** — all cars are scattered around the city (at least 45 m apart, on open spots of the bots' nav grid —
  3 m of drivable floor all round, heading along the longest free line), every man for himself.
  There is no track and no timer; instead there is a red cylindrical zone visible from anywhere in the city (and on the minimap). Its center is a random point in the city, but at most 0.62 of the map's half width from its middle (in the city: at least one block away from the wall — `ZONE.centerIn`) and not inside a building: on a floor of the nav grid that can be driven to from the rest of the map (a road, sidewalk, plaza or courtyard, not a closed yard) with nothing solid within 4 m (`ZONE.centerFree`). After 5 s it
  starts to shrink and collapses to a point in about 2 minutes; outside it the car's hull melts — 2.5 per second at first,
  up to 8 at the end. The last survivor wins, or whoever first runs down 50 pedestrians. In the battle, bots cruise between open spots of the nav grid
  inside the zone, don't chase a victim out of it, and don't single out humans; racers turn into "survivors" —
  more aggressive (aggression at least 0.5). `R` puts you back on an open spot inside the zone. Works in crew mode and online.

**Modes**:

- **Classic** — you drive, the cannon points straight ahead.
- **Crew** — every car has a driver and a gunner, the turret rotates 360°. Take the wheel and a bot shoots,
  or take the gun and the autopilot drives (it follows the track and is sometimes distracted by pedestrians and enemies).
  Rival turrets are manned by bots too: they pick the nearest car (or pedestrians if there are no cars), miss a little
  and fire with pauses. The mode is noticeably bloodier: in 2 minutes bots wreck each other 2–3 times more often than in classic.

## Features

- **Rivals**: each one's personality is not a fixed role but two scales from 0 to 1: `aggr` (urge to hunt cars)
  and `gore` (urge to hunt pedestrians). They smoothly drive the range at which a bot notices a victim, its field of view,
  the chance to engage, patience and fire rate:
  - blue МОЛНИЯ ("Lightning", #7, aggr 0.1) — a pure racer: follows the track, fires rarely and only at whoever is
    right in front of its nose, rarely and briefly turns off to chase a car;
  - purple РАКЕТА ("Rocket", #21, aggr 0.3) — a scrappy racer: fires more often and sometimes joins a fight;
  - yellow БУЛЬДОЗЕР ("Bulldozer", #66, aggr 0.8) — a hunter: spots cars from afar and chases them through the streets. It doesn't
    push its victim but rams it again and again: after a hit it backs up for ~1–1.5 s, keeping it in its sights, and speeds up again;
  - green МЯСНИК ("Butcher", #13, gore 1) — a butcher: wants to win by being the first to run down 50 pedestrians. It prowls the sidewalks,
    prefers finishing off people who are down, shoots at crowds (if no cars are near them), and when nobody is in sight it
    follows the track.

  Racers are rubber-banded: if they fall far behind they ease off a little, if they get ahead they press a little. For the first ~10 s
  everyone drives together. So that two cars don't circle forever firing and missing, hunting has patience: every hit resets it,
  and without hits the bot gives up the victim after a few seconds and follows the track for a while (if the victim is hunting
  it back, patience runs out faster). Everyone runs over pedestrians (it repairs their hull too).

  Bots drive along paths on the nav grid (`src/nav/path.js`, `NAV_PLAN.md`): A* over the walkable floors, where a metre
  costs more near walls, trees and poles (up to 4× right by them — a fast car needs room), up to 8× in a gap narrower
  than 3 m (an alley a car turns into only in several goes), +6 within 4 m of a wreck or of a car standing still for 2 s
  (a jam), up to half less through a crowd for
  a butcher (`gore` 1), and more behind a moving car within 8 m, so a path doesn't start with a U-turn; a new path to
  the same gate or waypoint pays 0.7 of the cost on the last one's floors, so it doesn't flip between two ways round a block as the
  car turns. Sidewalks cost the same as roads. The floor path is pulled into straight legs with 3 m of room along them (2.1 m in an alley, where
  there's no more); the bot steers at a point 7 m + 0.5 s of its speed ahead on it — nearer if the straight line there
  would cut through a wall — and brakes in time for the path's corners: its personality's corner speed (`corner`, for
  90°) grows as 1/√sin(angle/2) for gentler turns, and drops to 0.35 of that where the corner has less than 5 m of
  room (into an alley). In a race it drives to the next gate with the way on to the gate
  after it already planned (and racers keep their lanes where there's room); a hunter, a butcher or a survivor whose
  goal (the car, the pedestrian, the waypoint) is within 45 m with a straight drivable line to it goes straight at it.
  Searches run from a queue (once a frame's searches have looked at 3000 floors, the rest wait for the next frame); a bot
  gets a new path when its goal moves, when it is 7 m off its path, after an escape or when it's held up by a car.
  A goal on another level (more than 1.5 m up or down, or under another floor — a gate in a tunnel) is searched with a
  better guess of the way left: a Dijkstra back from the goal over 4000 floors first. A metre of slope costs
  150 × (grade − 0.15)² more (the big ramp +1; the deck's ramp and curbs nothing). Paths also take the nav grid's
  jumps — off a ramp's lip, off a deck's edge or a tunnel's portal, over a catapult (see [Physics](#physics)): the run-up
  costs its length, the flight and the run-out after it half their length, plus 4 per jump, 1.5 per m/s the lip needs
  over 14 (a gap: too slow, it falls in) and 2 per m/s of landing harder than 13 m/s; a jump is entered only roughly
  along its way (a run-up shorter than 18 m straight along it, a longer one also from the side, never against it; one
  within 6 m of the car only if the car itself faces within 1 rad of its way — `PATH.startRun`/`startWay`), and
  only by a bot whose top speed is 2 m/s over the middle of the jump's band of speeds. On the run-up the bot holds that
  middle speed, even over its own limit (a finished racer's or a battle survivor's: slower, it would fall short); from
  14 m before the lip to the end of the run-out it searches for no new path and avoids no car (knocked more than 7 m
  off the path there, it drops the jump and gets a new path at once); it
  doesn't brake for 6 m past the lip (braking with the back wheels still on it would pitch the nose down) and holds the
  wheel straight in the air. If it won't make the band's slowest speed by the lip at full throttle (the car's thrust
  against the climb), or within 6 m of the lip it's slower than that or more than 0.45 rad off the jump's way, it gives
  the jump up — it brakes if it can still stop 3 m short of the lip (else it goes), backs off straight for 2 s once
  stopped, and takes no jump off that lip (within 6 m) for 15 s. Lips are taken in turn: a bot heading for a jump
  claims its lip with its arrival time, and one heading for a lip within 4 m of it that would arrive less than 1 s later
  slows down before its run-up to arrive 1 s later (not below 8 m/s — slower, it couldn't make the jump). A straight
  line (a leg of a path, the line to a goal or to the point steered at) may climb or drop no more than 0.25 m plus the
  steepest slope between two samples 0.75 m apart, and crosses a ramp (a slope over 3° that goes on) only within ~30°
  of along it: bots turn before a ramp, not on it, and don't cut onto one over its low side by the foot. It slows down before a crest (the grade dropping by 0.06 or more) to fly at most 8 m off it (the deck's top:
  23 m/s), and brakes in time to stop 3 m short of a drop it isn't taking (a deck's edge while chasing someone across
  it); held there it gets out as below, and the escape's legs and a hunter's back-up see drops too. Cars and wrecks the grid doesn't know: one in the way (ahead within 6 m + 1.1 s of the
  speed, its centre within 3 m of the line; a moving car only if the bot closes in on it at 2 m/s or more) is passed
  0.25, 0.5 or 0.8 rad to one side where the grid has 10 m of room; with no way past, the bot slows down to its speed,
  but not below 4 m/s — it nudges a wreck aside or gets stuck against it and out as below, rather than waiting behind it
  for good. A bot steering more than 0.6 rad off its nose slows to 18 m/s, at 1 rad and more to 10 m/s. A hunter rams
  its target, never avoids it. A slow bot (under 4 m/s) whose path starts more than 2 rad off its nose in a narrow place
  (under 3.5 m of room — an alley) turns round at once in several goes, as below, instead of driving into the walls
  (not again for 3 s). A bot stuck pushing on
  (under 1.5 m/s for 1.4 s) gets itself out: it looks behind (a cast of its box against walls and cars) and, if there is
  at least 1 m of room, backs up, the nose swinging away from what it hit towards the side that leads to its target;
  with no room behind it pulls forward instead, and when that way runs out too it switches — a many-point turn of up to
  6 legs, each until there is 0.4 m left (plus 0.25 s of its speed) or it hasn't moved 0.3 m in 1 s, 3 s pass or the
  nose points the way out; while cars or a wall are along its sides and there are 2 m that way it goes straight first. Then it takes a new path
  that keeps off that spot for 10 s (a metre within 5 m of it costs +10; stuck there again 3 times, it turns out to the other side). Only a bot that
  hasn't got more than 8 m away from one spot for 20 s (ramming a target within 15 m doesn't count) is put on the
  nearest free floor of the nav grid 8–30 m away (no solid within 2.8 m, 1.5 m of walkable floor all round, no car
  within 6 m on its level; out of the players' view if it can, inside the zone in battle royale, not past its next gate
  in a race), 2 m above that floor so it drops onto it — the floor of its own level, under a deck or in a tunnel —
  heading along the floor's way (the longest free line through it) — never back at a gate (`ESCAPE`, `STUCK`, `SPOT` in
  `src/zone.js`). A pedestrian a bot
  gave up on isn't picked again for 6 s (`GORE.skip`). Bots also don't
  fire when a shell would miss because their car is tilted — into the ground, over the target, or from under the car on
  its roof (`Car.shotReaches`); a tipped bot rolls back onto its wheels like any car. Your place is shown at the top of the screen,
  along with how many enemies are left; on desktop the left side shows a table of participants with their pedestrian counts (a rival
  approaching 50 is announced at 25, 40 and 45); rivals are marked on the minimap,
  and each car shows a name and a hull bar above it.
- **Ramming**: that's what the bull bar on the nose is for — ramming nose-first into a side or a rear doesn't hurt it at all.
  Damage depends on the closing speed: how fast the two cars' contact points approach each other along the contact
  normal, so the direction of the hit is already in it — head-on at 100 against 80 km/h is a 178 km/h hit, catching up
  at 55 on a car doing 50 is 5 km/h, a 15° side swipe at 60/60 is 16 km/h (below 16 km/h — `CAR_HIT.threshold` — no
  damage). It grows linearly up to ~60 km/h and three times slower after that, so a single hit can't
  wreck a car from full hull. Nose into a side: 20 km/h — rival −3, 40 — −20, 60 — −36, 80 — −48, 100 — −55,
  130 — −68, 160 — −81; yourself 0. Head-on, each nose with its bull bar takes 0.3 of that (100 against 80 km/h: −32
  to each). Pushing does no damage. Cars are rigid bodies, so a hit also shoves, spins and can roll the other car: a
  parked car rammed in the side at 60 km/h is thrown at ~32 km/h and leans ~3°, at 100 — ~59 km/h and ~13°, at 125 it
  goes over (see [Physics](#physics)). Walls, buildings and thick poles still hurt when hit nose-first (the nose resists them only slightly better).
  Once the bull bar has fallen off, the nose is softer and takes damage when ramming. Whoever wrecks a car by ramming or with the cannon (the last hit
  within 4 s before the explosion) gets +15 hull — both the player and bots; the player also gets +1000 points and +12 s on the timer (`RACE.wreckTime`) — hunting pays off. A wrecked car is out.
- **Cannon** — on the roof of every car. It doesn't aim: the shell flies straight along the car's heading, so you aim
  with the nose. Reload is 1.26 s for the player and 1.89 s for bots (and bots miss a little). A direct hit ("ЕСТЬ ПРОБИТИЕ!" and other random captions) does about −19
  hull (~6 hits wreck a car); the blast hits everyone within ~4 m, pushes cars, tears pedestrians apart and scatters street props.
  Your own shell can't hurt you.
- **Machine gun** — the human's second weapon (bots only have the cannon); one is active at a time, switch with `1` / `2`
  (on a phone — the «ОРУЖИЕ» button, on a gamepad — B). 14 rounds per second, instant bullets, 85 m range;
  −0.7 per bullet to a car (~10 per second, no blast or push); a standing pedestrian drops on the 3rd bullet, one already knocked down on the 2nd (the wounded scatter)
  ("РЕШЕТО!" etc., +75 points, +2 hull, +1 s). In classic mode the turret auto-aims the machine gun at the nearest
  target within ±25° of the nose (up to 55 m; pedestrians get slight priority); with the cannon it faces forward. Overheating:
  after 4 s of continuous fire the machine gun goes silent until it has fully cooled (2.5 s from full heat).
  Weapon readiness is shown by a bar under the hull bar above your car and by a bar at the top left (on a phone — the fill of the fire button):
  for the cannon it grows until it can fire, for the machine gun it shrinks with heat and turns red when overheated. Settings — `MG` in `src/mg.js`.
- **Molotov cocktails** — ~8% of pedestrians hold a bottle. On spotting a car 8–30 m away (with no building in the way),
  such a pedestrian winds up (0.6 s, burning bottle over the head) and throws it with a lead (not always accurate);
  then looks for a new target for 5–9 s. A direct hit does −6 hull; the broken bottle burns as a puddle for 3 s (just fire).
  A bottle breaks on any solid surface in 3D (a wall, a pole, a ramp, the raised deck); its puddle burns on the first
  surface under that point (at the foot of a wall, on the deck).
  Online, the host decides the throw (it simulates the crowd) and broadcasts it, the bottle flies for everyone, and the damage to a car is computed by its
  owner. Settings — `MOLOTOV` in `src/molotov.js`.

- **Start**: grid slots (5 slots in 2 rows) are dealt randomly every race — to the player and the rivals alike.
- **Race**: 3 laps through the streets via yellow checkpoint gates, before time runs out (the map's course,
  `city.course`: a gate has a floor height — one in a tunnel or on a deck counts only for a car from 3 m below its floor
  to 1 m under its top, `RACE.below`). Each gate
  adds as many seconds as the next leg takes at an average speed of ~58 km/h, plus +5 s per lap.
  Pedestrians add a little time (killed +2 s, gibbed +3, crushed +2,
  blown up +1), but the main thing is to reach the finish. A light beam shines above the next gate, the top of the screen shows an
  arrow and the distance, and the route is drawn on the minimap. Time left at the finish turns into points.

- **The city** is generated procedurally (with a fixed seed): 6×6 blocks — office towers, apartment blocks,
  shops with awnings, houses with pitched roofs, parks with a fountain, a plaza with a monument and columns,
  gas stations. Roads with markings and zebra crossings, sidewalks with curbs, a boundary wall around the perimeter.
- **Pedestrians** walk along a sidewalk graph and cross roads at zebra crossings. They are 1.85 m tall (`PED_HEIGHT`). The crowd is replenished: each missing
  pedestrian is replaced 15 s after it went missing (`RESPAWN.time`) by a new one — 50–170 m from the player and only where there is no
  car within 50 m (`RESPAWN.dist`). When they notice a speeding car or an explosion
  they get scared: some freeze, some run waving their arms (sometimes in the wrong direction).
- **Running people over**: at low speed (up to ~40 km/h) a pedestrian is only knocked down — lies there writhing, gets up after a couple of seconds
  and runs away. Someone who is down can be crushed by driving over them. Above 40 km/h the body
  flies off tumbling, hits walls (blood on the walls), and leaves a corpse with a growing pool of blood. Above
  ~85 km/h it is torn to pieces. Driving over corpses, bloody tire tracks, blood spatter on the "windshield" (on screen).
- **Damage**: hitting a wall, building, thick concrete pole, tree or column (on the test ground also the deck's
  sides, the rails, the ramps' sides and the tube's walls) above ~29 km/h takes away "hull": 2.4 per m/s of the impact
  speed — the closing speed at the contact point along its normal — above 8 m/s (nose into a wall at 100 km/h — −35 with the bull bar,
  whose armour takes off a quarter, −47 without it; thick poles, trees and columns ×1.15). Curbs never hurt.
  Touching down on the wheels after a flight harder than 13 m/s (speed into the surface) costs 1.6 hull per m/s above
  that (a 6.4 m drop, 16 m/s — −4.8; the catapult at 70 km/h — ~−8); the body hitting the ground on its side or roof
  costs 2.4 per m/s above 6 m/s (a flip landing on the roof at 12 m/s — −15), with sparks. The body dents where it was
  hit (a roof hit dents the roof, a hard landing the underbody), the bull bar
  and bumper fall off, glass scatters, smoke appears, then fire. At zero — an explosion: wheels and the cannon fly off, nearby
  pedestrians are thrown around. Thin lamp posts, traffic lights, signs, bins, hydrants (they spout water) and benches are simply knocked down.
- **Gates repair**: every gate (a checkpoint or a lap's finish line) gives +6 hull (`RACE.cpHeal`) — to
  the player and rivals alike. So three things add hull and time: pedestrians, wrecked rival cars and gates.
  A hull bar with a number is shown above your car.
- **Blood repair**: every kill repairs the hull a little (hit +6, crushed +8, gibbed +8,
  blown up with the cannon only +2 — running over pays better).
- **Points and combos**: kills no more than 4 s apart (`COMBO_TIME`) multiply points, and the streak gets a name: 2 — "дуплет", 3 — "триплет", 4 — "каре", 5 — "пятилетка", 6 — "кровавая баня", 7 — "джекпот 777", 8 — "жатва", 9 and more — "беспредел ×N" (each tier has several random captions, list — `SERIES` in `src/words.js`); a flight of 0.8 s or more in the air gives a bonus when the car lands: «ПОЛЁТ N С», 10 points per 0.1 s (`AIR_BONUS_MIN` in `main.js`); bonuses for wall hits, etc.
  Every kill comes with a caption from a "culinary" vocabulary — "КОТЛЕТА!", "ОТБИВНАЯ!", "ФАРШ!",
  "ЛАВАШ!", "ДУРШЛАГ!"… The lists live in `src/words.js`, add your own.
- **Bloody tire tracks** appear only when a wheel has rolled through a pool or spot of blood, and trail
  behind that wheel for ~26 m. Tyre marks and bloody tracks lie on whatever the wheel rolls on — the ground, a ramp's
  slope, the deck, the tube's floor (not on another car); a pool in the street doesn't stain a car driving through the
  tube under it.
- All sound is synthesized with WebAudio (engine with gears, tire squeal, cannon shot, shell blast, splat, screams, explosion).
  **Sound settings** — in the main menu and in pause: master volume, "engine and tires", "effects" (shots, hits,
  screams) and "mute all sound". A slider plays a sample right away; settings are remembered in the browser.
  The engine is only heard during a race — it is silent in the menu, in pause and on the results screen.
- **Test ground** — the «ТЕСТОВЫЙ ПОЛИГОН» button in the main menu (or `?map=test`; back — «В ГОРОД»).
  A lot the same size as the city and behind the same wall, but instead of blocks it is flat asphalt with a white 100 m grid (lines at −100, 0 and +100 on both axes),
  two buildings and a row of street props. Pedestrians stand in place and don't get scared (one knocked down gets up and stands where they fell):
  one with Molotov cocktails (throws as usual), a crowd of 20 further away, and beyond it a line of 50 spaced 2 m apart. A dead one
  stands up again in their spot after 15 s if no car is within 50 m. It also has vertical play for the physics:
  - a big 3.5 m ramp in front of the line of 50: at ~108 km/h you land right in it, nose first; with one side up it
    you roll over;
  - three 1.2 m kickers 40 m apart with a boost pad before them (a boosted car lands on the flat between them), and a ramp over the tube's exit trench (clears it from ~79 km/h);
  - the underground tube on the west side: an open trench down 5.5 m, an 80 m covered tunnel with lights and a
    pedestrian standing on its roof, a trench back up; the trenches are fenced with 0.9 m rails, and the camera stays
    under the tunnel's ceiling;
  - a 6 m deck reached by a 40 m ramp, with eight pedestrians on it;
  - orange boost pads (130 km/h along the heading) and a red catapult (18 m/s straight up) right before a 4.5 m wall
    (it clears the wall from ~65 km/h); driving onto a pad shows «УСКОРИТЕЛЬ!» / «КАТАПУЛЬТА!» and shakes the camera.

  No rivals, no track, no timer and no win condition — only
  your own car; if it gets wrecked — «ЕЩЁ ЗАЕЗД». Single player only (online only from a test script). New mechanics
  should be added here too. Layout — `testGround()` and `verticals()` in `src/world/city.js`.
  With `?map=test&bots=N` it's a playable map instead, to exercise the bots' 3D navigation: the menu's race or battle
  royale with N bots (single player as well: the menu has no network button there — a room doesn't check its players'
  maps). The race's gates: before the big ramp, after its landing, on the deck, north of the deck (the
  way there is off its edge), in the tunnel, and the finish after the tube (`course` in `buildCity()`).
- **Back to menu** in single player is available from pause and from the results screen (online, the same place has «ВЫЙТИ ИЗ КОМНАТЫ»): the race is reset and cars return to the start.

## Physics

Every car — yours, the bots', other players' online — is a rigid body in the 3D physics engine **Rapier**
(`@dimforge/rapier3d-compat` 0.19.3; its WASM is embedded, so the single file still works on its own). Collisions,
gravity, suspension, jumps, rollovers and lying on any side come out of one system; the game adds its rules on top:
the arcade handling, damage, tripping and self-righting. How it was built and measured — `PHYSICS_PLAN.md`.

- **World**: fixed steps of 1/120 s (at most 8 per frame: after a long freeze the game slows down rather than
  catching up); the rendered pose is interpolated between the last two steps. Gravity is 20 m/s² — arcade, short
  punchy jumps. The static colliders are built from the same seeded city data on every client: the ground, buildings,
  the wall, poles, trees, columns, the fountain, the statue, planters and pumps (upright cylinders and boxes), the test
  ground's ramps, deck and tube (convex hulls). A curb is a 0.15 m step bevelled over 0.3 m that cars bump over (~3.5°
  of pitch). Walls and obstacles have friction 0.1, the ground 0.5.
- **The car**: 1200 kg, centre of mass 0.55 m above the wheels' contact, inertia 2050 / 2250 / 600 kg·m² (pitch / yaw
  / roll). The chassis is a 2.2 × 0.76 × 4.5 m lower body whose ends are semicircles seen from above, so a car glances
  off a pole or a building's corner instead of snagging, plus a cabin box. Four ray-cast wheels: suspension rest
  0.3 m, travel 0.2 m, stiffness 50 and damping 3 / 3.5 per kg (0.1 m of sag); the tyres themselves hold nothing.
- **Arcade layer**: while wheels touch the ground, the handling (`Car._drive`: thrust curve, brake, the steering table,
  lateral grip and the handbrake slide) is applied to the body as velocity changes, scaled by the share of wheels on
  the ground and faded out as the car leans from ~53° to ~70°. Only the spin about the car's own up axis is set; pitch
  and roll stay physical, and cornering acts at the centre of mass, so the body doesn't lean in turns (the visible
  body roll is a cosmetic spring). Measured: top speed 126 km/h; 0 → 1 / 2 / 3 / 5 / 9 s: 43 / 77 / 99 / 119 /
  125.5 km/h; yaw rate at 40 / 60 / 100 km/h: 120.6 / 107.4 / 69.9 °/s (on full lock at 125 km/h the car slows to
  ~121 km/h: 58 °/s); reverse 39.8 km/h; the speedometer matches the real distance. Driving itself never tips a car
  (full lock, the handbrake at top speed, curbs: under 1° of lean). While the body leans on a wall, a pole or a tree,
  only a quarter of the sideways grip is applied, so a car pushing into one slides along it instead of sticking.
- **Tripping**: for 0.4 s after a hit (another car, a blast), sideways grip harder than 40 m/s² (the hardest turn
  needs ~35) acts ×1.5 at the wheels' contact, below the centre of mass, so a car knocked sideways can trip over its
  own tyres. Only the sideways speed the hit itself gave it counts. In 8-car races cars lean 10–25° in pile-ups, and a
  car rolls over in about one race in five, always from a hard side crash or blasts.
- **Rollovers and self-righting**: rolled past ~59° a car falls over. On its side or roof (its up vector less than
  half up) and nearly still (under 1.5 m/s and 1.5 rad/s) for 1.5 s, it rolls back onto its wheels («НА КОЛЁСА!»);
  rocking on its side or shoved by other cars (under 4 m/s and 4 rad/s, not still) it does so after 3 s:
  still a physical body, so walls push it away, turned upright about its centre of mass at up to 6 rad/s with its
  heading kept, for at most 1.5 s. Whatever it does, tipped for 8 s in a row it rights itself anyway (`VEH.flipMax`: a
  car dragged along on its side faster than that). Hung on an edge — half over a ramp's or a deck's side, leaning more
  than ~32° on two wheels or fewer and still for 2 s (`VEH.hungUp`/`hungWheels`/`hungAfter`) — it is righted the same
  way (it can't drive off, and it isn't tipped enough for the rule above: bots hung 20 s at 52° on one wheel). `R` on
  a tipped car does that at once.
- **Blasts** shove a car (`CANNON.push`, 7 m/s at the centre) with a tenth of it upwards and tilt it away at 1 rad/s
  per m/s: a blast touching its side throws a parked car at 21 km/h and tilts it 40°, 1 m away — 16 km/h and 16°,
  2 m — 11 km/h and 7°, 3 m — 6 km/h and 3°.
- **Weapons and pedestrians** use the car's box turned with its body (2.1 × 1.7 × 4.7 m, up to 2.2 m with the
  cannon). Shells and bullets fly from the barrel's real pose (a car nose-up on a ramp fires upwards; the springs' few
  degrees are ignored) and stop at any solid surface, the ground included; a car on its roof fires into the ground.
  They hit pedestrians in 3D too: a shell only where it passes within 0.4 m of a person's body (`CANNON.pedHitPad`; the
  muzzle is 1.97 m up, so a level shot hits a standing person), so a car nose-up on a ramp fires over heads; the machine
  gun also dips or lifts onto a person by up to 20° off the barrel (`MG.pitchCone`), so it still finishes off the ones
  lying down. A blast's reach and a wreck's counts the height too: one on the deck spares the people under it.
  A pedestrian is hit by that box too: a car flying over heads or driving through the tube under them misses them,
  one landing on them hits as hard as it falls. Street props are sensors: they break when the body touches them faster
  than 2.5 m/s (a car flying over a bin misses it) and slow the car a little (at 40 km/h a lamp or a bench takes off
  ~12%, a bin ~6%).
- **Everything else is 2D.** Pedestrians, debris, the camera and the bots' steering and line of sight use a 2D world
  on the XZ plane (buildings are AABBs, poles are circles, a spatial grid, DDA ray casts), with heights from the car's
  real pose — enough for an arcade game and cheap on phones.
- **The bots' nav grid** (`src/nav/grid.js`, `NAV_PLAN.md`) is built at load from the Rapier world's static colliders
  and the map's bounds, nothing map-specific: columns of 1.5 m (`NAV.cell`) over the map; in each column two vertical
  rays through the world find every collider's top and bottom, and the top of each solid stack is a floor if its
  normal is within 32° of up (`NAV.slope`), there are 2 m of room above it (`NAV.clear`) and it isn't the top of an
  obstacle (a roof, a tree, a wall) — so the tube's floor and the street over it are two layers of one column.
  Neighbouring floors are linked if the step between them, off either floor's slope, is at most 0.25 m (`NAV.step`;
  curbs are 0.15) — a ramp rises along itself, so its side is a step; a floor is walkable if it is linked all round (not at a drop, the deck's edge or a ramp's side)
  and no solid stands within 1.1 m of its centre (`NAV.inflate`, the car's half width and a margin; an upright
  cylinder test above the floor, so curbs and ramps under it don't count, and breakable props never do). The biggest
  connected set of walkable floors is where cars can go; each floor also keeps its kind (the collider under it: road,
  sidewalk, ramp, deck) and its room — the distance to the nearest unwalkable floor. Spawns, the zone's centre and
  waypoints and a stuck bot's teleport spot come from it (spawns and waypoints on "open" floors: 3 m of walkable floor
  all round, `NAV.open`), and the bots drive paths on it (see Rivals). A catapult's floors aren't walkable (a car
  driving over one is thrown; only its jumps lead over it). **Jumps** (`src/nav/links.js`, `JUMP`): from every edge
  floor with a lower floor beyond it — a ramp's lip (along the ramp only, not off its side), a deck's edge, a tunnel's
  portal — and onto every catapult, the car's lower body is flown (a shape cast every 0.05 s, no spin) at 14–36 m/s
  at the lip (a catapult: from 6 m/s, thrown up at 18): a flight lands well on a reachable floor with 1.5 m of room, at
  most 19 m/s into it, with straight walkable floor after it for 6 m plus the way to stop from that speed at 15 m/s²
  (it can't turn or brake in the air). Slower than 14 m/s a car tips over an edge nose first (off the deck: 10 m/s
  and less roll it over, 13 pitch it 60°). The speeds that land well are cut into bands of 6 m/s every 4 m/s; each band
  is a jump per entry to the straight run-up before the lip — every 3 floors from 10 m (off a ramp) or 9 m (off an
  edge, onto a catapult) to 40 m — if a car entering there at 8 m/s reaches the band's middle speed by the lip at full
  throttle. A jump lands at the end of its run-out (where the path goes on). City: none; test ground: 655 — 68 off the
  ramps (the big one, the kickers), 465 off the deck's edges and the tube's portals, 122 onto the catapult (the ramp over
  the tube's exit trench needs ~25 m/s at its lip, more than a car gets there: no jump), found in ~30 ms. Building the grid takes 0.13–0.3 s on a
  desktop (city: 59 055 floors; test ground: 65 971, 318 of them on a second layer — the street over the tube) and
  1.7–2.2 MB. `?debug=nav` draws it: a square per floor, coloured by kind (road green, sidewalk blue, ramp yellow,
  deck grey), upper layers lighter; unwalkable floors small dark red; the jumps — the run-up white, the flights at the
  band's slowest and fastest speed orange (off a ramp), cyan (off an edge) or red (a catapult); and every bot's current
  path in magenta.
- **What a map gives the bots' navigation**: static colliders in the Rapier world, each with a kind (`solids`; the tops
  of `OBSTACLES` kinds are never floors, breakable props are sensors, never obstacles); `bounds` — where cars can be
  (`x0, z0, x1, z1`) and the colliders' height range (`y0, y1`); `pads` — boost and catapult rectangles with their
  floor height; for a race `course` — a closed route (progress, standings, the minimap) and gates `{ x, z, y, w, h }`
  (the last one the finish); `spawn` — the race's grid (battle royale spawns, its zone and waypoints come from the
  grid). Nothing else: the grid, its jumps, the paths and every bot rule are built from these.
- **Cost** (a desktop PC, a phone-sized 375 × 812 window, `?q=low`): a battle royale of 20 cars takes ~3.3 ms a frame
  — the simulation 1.6 ms (of it the physics 0.7: Rapier's world 0.37, the cars' controls and suspension 0.24), the
  rendering 1.8 ms; with 2 cars 2.2 ms. Rapier adds ~2.2 MB to the bundle (0.85 MB gzipped) and 10–60 ms to the boot.
  The bots' paths add ~0.03–0.06 ms a frame with 19 bots (~17 searches a second, ~200 floors each; once a frame's
  searches have looked at 3000 floors the rest wait for the next frame, and one search stops at 12 000).

Settings — `PHYS` in `src/physics/rapier.js`, `VEH` and `GHOST` in `src/physics/vehicle.js`. Measurements —
`tests/physics.js` (single player) and `tests/net.js` (two clients), run in the browser.

## Multiplayer

Up to 4 people per room plus bots: 0–7 in a race (at most 8 cars in total), up to 19 in battle royale (at most 20 cars in total). You need one computer running the server — no public IP needed.

```bash
npm install
npm run serve      # builds the game and starts the server on port 8080 (npm run server — without building)
```

The server serves the game itself, so your friend opens it **from your server** — then your versions match automatically.
How to reach it without a public IP:

- **Cloudflare tunnel** (no sign-up, free): install `cloudflared`
  (`winget install Cloudflare.cloudflared`) and run `cloudflared tunnel --url http://localhost:8080`.
  It gives you an address `https://….trycloudflare.com` — send that to your friend. Works through any NAT and passes WebSocket.
- **VPN network** — Radmin VPN, ZeroTier, Tailscale: both on the same virtual network, your friend opens
  `http://<your VPN address>:8080` (the server prints its addresses on start). Ping is usually lower than through a tunnel.
- **Same Wi-Fi network** — `http://<LAN address>:8080`.

In the game: «ИГРА ПО СЕТИ» → name → «ПОДКЛЮЧИТЬСЯ» → one player creates a room, the other joins, the host presses «СТАРТ».
If the game wasn't opened from the server (e.g. `npm run dev`), the lobby shows a field for the server address.

**Room settings** (set on creation, the host can change them before the start): game (race / battle royale),
mode (classic / crew), number of bots (0–7, in battle also 10 / 15 / 19; at most 8 cars in a race and 20 in battle), teams (none / 2 teams).

- **Teams** — red and blue, everyone picks their own. You don't hurt your own: shells pass through, ramming does no damage,
  bot gunners don't fire at teammates. Points and pedestrian kills are shared (the HUD shows the team total), one player's win is everyone's win.
  Wreck everyone = wreck all the other team's cars.
- **Crew online** — everyone picks a seat: driving their own car (a bot in the gun), in the gun of their own car (a bot drives)
  or a free seat with a friend: «В ПУШКЕ У …» ("in …'s gun") — your friend drives, you shoot (or the other way round). Car mates
  are a team too: shared points, they don't hurt each other. You can play against a friend both as a driver and as a gunner.

**Versions.** The game has a fingerprint: the version from `package.json` + a hash of the sources (`scripts/build-id.mjs`), shown
in the lobby. A room only admits players with the same fingerprint; a room with a different version is greyed out in the list with a note.

**How it works.** The server (`server/server.js`) handles the lobby, rooms and message relaying; it doesn't simulate the game.
Everyone simulates their own car, and the host also simulates the bots; other cars arrive as snapshots 20 times a second
and follow them as ghosts (below). Ram damage is computed by the rammer (their own car is exact) and sent to the victim's owner;
shells fly for everyone, and the owner of the hit car computes the damage locally. A car is simulated by whoever is driving it (and if a bot
is driving — by whoever is in the gun); a gunner in someone else's car rotates the turret locally and sends its angle to the owner, and also fires
locally. Street props (lamp posts, traffic lights, signs, bins, hydrants, benches) are broken by whoever's car or shell hit them,
and they immediately broadcast the ids of what broke — the same thing falls for everyone, and the debris flies the same way.
The host simulates the pedestrian crowd: 10 times a second it broadcasts who is walking or running where, which way they face and who got scared
(new ones appear near a random human player); for everyone else pedestrians smoothly follow the snapshots. A pedestrian is hit by whoever's
car or shell hit them: they immediately broadcast what happened (knocked down, killed, crushed, torn apart),
where the body is and where and how hard it was hit — everyone simulates and draws the body's flight, blood and pieces themselves, and only
the hitter gets the points. Who finished first,
wrecked everyone or ran down 50 pedestrians is decided by the server (whoever claimed first). Pausing online doesn't stop the world.
Every client measures its round trip to the server (a ping every 2 s) and sends half of it with its snapshots: the receiver
adds its own half and carries each snapshot forward by that much (at most 0.15 s), so a car is shown where it is now, not
where it was when the snapshot left.

**Snapshots and ghosts.** A snapshot carries a car's full pose: position with height, rotation (one
number: the quaternion's three smallest components, 10 bits each, ~0.1°), velocity and spin on all three axes — 80 bytes
per car (a host with 7 cars sends 12 KB/s). A car another computer drives is a *ghost*: a body of a car's
mass with no gravity that touches only the cars driven here, pulled each physics step towards its snapshot (carried
forward by its velocities, in the air with gravity, never below the ground) by a critically damped spring of 12 rad/s.
So jumps, rollovers and self-righting look the same on every screen (in tests: a ghost 0.1 m and ~1° from its car on
average, both screens showing a car past 60° and back on its wheels within 0.06 s), and a car driven here that hits a
ghost bounces as off a car, not a wall. A hit is resolved on both computers, each for its own car; the one that drove
into the ghost also sends what its solver did to the ghost (the knock) with the ram damage, and the victim's owner
takes the larger of the two along the knock's direction — never their sum — so the hit lands even if its own screen
missed it. A ghost just hit moves on its own share of the hit (its sideways part fading with the car's grip) until a
snapshot shows the hit, at most 0.4 s — otherwise, with a delay, the victim's ghost would spring back into the rammer and
hit it again. A ghost more than 0.3 m inside a car driven here (one put onto the other) or more than 2 m from where its
snapshot puts it touches no car until it is clear and caught up: both computers pushing their own car out of the
other's ghost would push both cars the same way, faster and faster. Two cars left inside each other that way ease apart:
each computer moves its own car out of the other's ghost at 1.5 m/s at least (`GHOST.ease`), the other one away from
it, so they part on both screens within a second. A respawn moves the ghosts at once. Measured with
120 ms round trips, a ram does the same damage as single player (36.6 at 60 km/h, 53.8 at 100) and throws the victim
about as far. Coming back after a reload puts the car exactly as it was — on its roof if it lay on its roof. The
gunner in someone else's car aims through the car's real rotation: on a tilted or flipped car the turret turns in the
body's own plane and the barrel points at the heading the gunner looks along (nose up across a ramp it tilts up or
down with the car); only when that would point it more than 50° up or down (on its side) does it take the nearest
direction it can. Bot gunners and the machine gun's auto-aim turn the turret the same way.

**If you drop out.** When the connection breaks, the game reconnects by itself every 2 s, and the server holds your slot for 90 s
(the others see «СВЯЗЬ ПОТЕРЯНА, ЖДЁМ…» — "connection lost, waiting"; while the gunner is away, a bot fires their gun). Even if the page
reloaded or the tab was closed and reopened, the game returns you to the same race: car, hull, lap, gates,
time and points — from the last snapshot the server remembered; street props broken while you were away are removed too. The host can come back the same way (while they are away, bots stand still).
The «ВЫЙТИ ИЗ КОМНАТЫ» button leaves for good; if the host leaves or doesn't come back within 90 s, the room closes.

## Controls

| Desktop | Action |
| --- | --- |
| `W A S D` / arrows | throttle, steering, brake / reverse (the car turns fastest at ~40 km/h, above that steering gradually gets heavier: 60 km/h — ~107°/s, 100 — ~69°/s, 125 — ~56°/s; the car responds lazily — enter a sharp turn at speed with the handbrake; straightening the wheel and flicking it the other way is always quick) |
| `Space` | handbrake (drift; when released the tires don't grip right away, the car keeps sliding sideways for ~1 s) |
| LMB / `F` | fire (in classic the cannon fires straight ahead, the machine gun auto-aims at a target) |
| `1` / `2` | weapon: cannon / machine gun |
| in the gun: mouse, `A`/`D`, `Q`/`E` | rotate the turret (a click on the screen captures the mouse, `Esc` releases it); fire — LMB, `F`, space |
| `C` | camera (behind / far / top-down) |
| `V` (hold) | look back |
| `R` | return the car to the last checkpoint (after a finish/crash — new race) |
| `M` / `Esc` | sound on/off / pause (in pause — resume, sound settings, back to menu) |

Gamepad: RT — throttle, LT — brake, left stick — steering, A — handbrake, X/RB — fire, B — switch weapon, Y — camera, LB (hold) — look back; in the gun the right
(or left) stick rotates the turret.

**Phone**: left thumb — a floating joystick (drive where you pull; down — brake/reverse),
on the right — the fire button (it shows the weapon name), **ОРУЖИЕ** (weapon) and **ДРИФТ** (drift). In the gun, moving the joystick left-right rotates the turret. Best held in landscape.

## Running

```bash
npm install
npm run dev        # http://localhost:5173, plus a LAN address — open it from your phone
npm run build      # build into dist/ + one self-contained file dist/cars-and-guts.html
npm run preview    # preview the build
```

URL parameters:

- `?q=low` / `?q=high` — force low (no shadows, fewer pedestrians) or high graphics
  (default: phone — low, desktop — high);
- `?peds=100` — how many live pedestrians to keep in the city (default 84 on desktop, 54 on a phone);
- `?map=test` — the test ground instead of the city; `?map=test&bots=7` — a race (or battle royale, as chosen in the
  menu) on it with 7 bots;
- `?debug` — FPS counter; `?debug=nav` — also draws the bots' nav grid and their paths (magenta lines; see [Physics](#physics));
- `?mute` — start muted without touching saved settings (automated tests run this way, together with Chromium's `--mute-audio`).

## If the game crashes

Any error (an exception in the game loop, a shader error, losing the WebGL context) stops the game
and opens a window with the stack trace and a state snapshot: where the car is, how many pedestrians are in which state,
how many decals, etc. The «Скопировать» (copy) button puts the report on the clipboard. Freezes longer than 2 s are
logged too. The log opens from the pause menu, and the latest entries are saved in the browser —
if the page reloaded, the main menu shows a link «В прошлый раз игра упала» ("the game crashed last time").
The build doesn't rename functions, so the stack trace shows real names (`Pedestrians._compose`, etc.).

## Architecture

```
src/
  main.js             game loop, states (menu/play/pause/crash), scoring, wiring between systems
  config.js           quality settings and city dimensions
  car.js              the car: model, handling (the arcade layer: bicycle model + lateral grip → drifts),
                      damage rules, body vertex deformation, explosion, the muzzle and turret on a tilted body
  pedestrians.js      crowd: instanced body parts, AI (sidewalk graph, panic), flight, corpses, gibs
  cannon.js           cannons and shells: firing along the heading, flight, blast, damage (settings — CANNON)
  mg.js               machine gun: hitscan bullets, tracers, turret auto-aim, overheating (settings — MG)
  molotov.js          Molotov cocktails: bottle flight, hitting a car, burning puddle (settings — MOLOTOV)
  camera.js           chase camera (inertia, shake, doesn't hide the car behind buildings)
  input.js            keyboard/mouse, touch joystick, gamepad
  hud.js              HUD, popup captions, blood on screen, minimap
  audio.js            synthesized sound: engine and effects buses, volume settings
  physics/collision.js  the 2D world (pedestrians, debris, camera, bots' sight): AABBs + circles, grid, DDA raycast
  physics/rapier.js   the Rapier world, static colliders from the city, prop sensors, fixed 1/120 s
                      steps, car-vs-car hits, ray casts for shells and bullets
  physics/vehicle.js  a car as a rigid body — chassis, ray-cast suspension, arcade layer, tripping,
                      self-righting, wall / landing / roof hits, blasts; a ghost of another player's car (network)
  world/city.js       city generation (and the test ground), pedestrian graph, minimap
  race.js             track, checkpoint gates, laps, timer (settings — RACE at the top of the file)
  racers.js           rivals: personalities (RIVALS), AI — driving paths to gates and targets, hunting cars and
                      pedestrians, avoiding cars, getting out of traps, car hits (CAR_HIT)
  tag.js              label above a car: name and hull bar
  gunner.js           bot gunner in the turret (crew mode): target choice, turning, firing (settings — GUNNER)
  zone.js             battle royale: cylindrical zone, spawn points, zone centre, a stuck bot's teleport spot
                      (settings — ZONE, SPOT)
  nav/grid.js         the bots' nav grid: layered floors from the static colliders, links, walkable floors,
                      queries — cellAt, isFree, nearestFree, randomCell, axis (settings — NAV)
  nav/links.js        the nav grid's jumps: off ramps' lips and edges, over catapults, found by flying the car's
                      box through the colliders (settings — JUMP)
  nav/path.js         the bots' paths: A* over the nav grid and its jumps (costs, a search budget per frame),
                      straight legs, jumps and crests on a path (settings — PATH)
  nav/debug.js        ?debug=nav: the grid, its jumps and the bots' paths drawn over the map
  net/client.js       server connection, game version for rooms, the round trip to the server
  net/lobby.js        the multiplayer screen: connecting, rooms, start
  net/netplay.js      network race: own/remote cars, snapshots (full pose, packed rotation), events, victory claims
  crash.js            error log and the stack trace window
  words.js            captions for kills and stunts
  world/props.js      breakable street props
  world/geom.js       geometry builder (all static geometry is merged into ~11 meshes)
  world/textures.js   procedural canvas textures (facades, asphalt, blood…)
  effects/            particles (custom shader), decals (blood, tire tracks), debris
server/server.js      server: serves dist/, lobby and rooms, relaying, who was first
tests/physics.js      in-browser measurements of the physics: handling numbers, lean in a race, bots' pace, side hits,
                      damage (walls, landings, rams), blasts, pedestrians and props against the car's box, the muzzle,
                      bot games (stuck bots, wrecks, kills), scripted traps for bots, the bot gunner on a tilted car
tests/net.html, net.js  two games side by side in one page, joined in a room through the server: a car vs its ghost
                      in jumps, rollovers and ordinary driving, rams, the gunner on a tilted car, reconnecting, bytes
```

Cars are bodies in the Rapier physics engine; everything else collides in the XZ plane (see [Physics](#physics)).
Pedestrians (all body parts) are drawn in ~6 draw calls via
`InstancedMesh`. On a weak device the render resolution drops automatically if the FPS sags.

Main tuning numbers: `PHYS` in `src/physics/rapier.js` (gravity, the step and `maxSteps` per frame, ground and wall friction) and `VEH` in `src/physics/vehicle.js` (`mass`, centre of mass — `com`, `inertia`, chassis shape — `lower`/`cabin`, its `friction`/`restitution`, `angularDamping`, suspension — `wheelRadius`/`rest`/`travel`/`stiffness`/`compression`/`relaxation`, the arcade layer's fade with lean — `upFull`/`upNone`, grip against obstacles — `leanGrip`, the flip rule — `flipUp`/`flipAfter`/`flipStill`/`flipSlow`/`flipSlowRate`/`flipMax`, hung on an edge — `hungUp`/`hungWheels`/`hungAfter`, righting — `rightRate`/`rightLift`/`rightTime`, tripping — `tripAccel`/`trip`/`tripTime`, wall hits — `wallNormal`, landing and roof damage — `landAir`/`landSafe`/`landScale`/`roofSafe`/`roofScale`, blasts — `blastLift`/`blastSpin`, pads — `boost`/`launch`; `GHOST` — other players' cars over the network: the spring's `rate`, how far a snapshot is carried forward — `ahead`, `sink`, `snap`, passing through — `deep`/`loose`, easing two overlapping cars apart — `ease`, a just-hit ghost — `holdShow`/`hold`, reconciling knocks — `knockWindow`), `SNAP_HZ`/`LEAD_MAX` in `src/net/netplay.js` (snapshots a second, the most a snapshot is carried forward for the network's delay), `P` in `src/car.js` (thrust, grip, steering at speed — the `yawCap` table and `hardFrom`/`hardTo`/`steerTime`/`yawResp`, steering return — `steerReturn`/`yawUnwind`, damage threshold and multiplier),
`HEAL` in `src/main.js` (repair for kills), `RACE` in `src/race.js` (laps, pace, time bonuses, how far under or over a gate counts),
`CANNON` in `src/cannon.js` (reload, damage, blast radius), `MG` in `src/mg.js` (machine gun), `MOLOTOV` in `src/molotov.js` (cocktails), `RIVALS` (personality `aggr`/`gore`, speed; battle bots beyond seven reuse the same personalities under names from `EXTRA`), `MAX_CARS`/`MAX_CARS_ROYALE` (cars in a race / in battle),
`HUNT`/`GORE`/`PREY_WEIGHT`/`HUNT_DELAY`, `DRIVE`, `AVOID`, `ESCAPE`, `STUCK` and `CAR_HIT` in `src/racers.js` (how personality scales turn into behavior,
whom hunters go after, how a bot drives a path and brakes for its corners and crests, holds a jump's speed, takes a lip in turn and gives a jump up, stops before an edge, passes cars and wrecks, how a stuck bot gets out and when it is put elsewhere, ram damage), `SPOT` in `src/zone.js` (where
it is put), `NAV` in `src/nav/grid.js` (the nav grid: cell size, step, slope, clearance, inflation, open spots), `JUMP` in `src/nav/links.js` (the jumps: speeds tried, the flight's step and box, run-ups and their entries, run-outs, landings, bands), `PATH` in `src/nav/path.js` (path costs — room, alleys, wrecks, traps, crowds, turning back, slopes, jumps —, the search budget, the goal's field for another level, straight legs, corners, crests), `RACE.goreWin` (how many pedestrians to win), `KNOCK_SPEED`/`KILL_SPEED` and pedestrian reactions in `_panic()`
in `src/pedestrians.js`, `QUALITY`/`CITY` in `src/config.js`.
