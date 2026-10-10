# Cars & Guts

A Carmageddon-style arcade racing and car-mayhem prototype built on **three.js**. A small city, a checkpoint track,
four rivals, crowds of pedestrians, and a red car with a spiked bull bar and a cannon on the roof.
Plays on desktop and on phones.

**How to win** — three ways: finish first after 3 laps, wreck all rival cars, or be the first to run down
50 pedestrians. If a rival gets there first (finishes or racks up 50 pedestrians), you lose. You can also
lose by wrecking your own car or running out of time.

**Games** (the menu sets the game, the mode, your seat and the number of rivals: 1–7 in a race, at most 8 cars in total; battle royale also offers 10, 15 or 19 — up to 20 cars):

- **Race** — 3 laps through checkpoints, as described above.
- **Battle royale** — all cars are scattered around the city (at least 45 m apart), every man for himself.
  There is no track and no timer; instead there is a red cylindrical zone visible from anywhere in the city (and on the minimap). Its center is a random point in the city, but at least one block away from the wall and not inside a building: on a road, sidewalk, plaza or courtyard that can be driven to (nothing solid within 4 m, and at least one direction reaches a street without a building in the way). After 5 s it
  starts to shrink and collapses to a point in about 2 minutes; outside it the car's hull melts — 2.5 per second at first,
  up to 8 at the end. The last survivor wins, or whoever first runs down 50 pedestrians. In the battle, bots cruise the streets
  inside the zone, don't chase a victim out of it, and don't single out humans; racers turn into "survivors" —
  more aggressive (aggression at least 0.5). `R` puts you back on a road inside the zone. Works in crew mode and online.

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
  it back, patience runs out faster). Everyone backs up when stuck and runs over pedestrians (it repairs their hull too).
  A bot that can't get more than 8 m away from one spot for 8 s (wedged between a tree and a building, circling a
  pedestrian it can't hit) respawns at its last gate (in battle royale — inside the zone; ramming a target within 15 m
  doesn't count), and a pedestrian a bot gave up on isn't picked again for 6 s (`STUCK`, `GORE.skip`). Bots also don't
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
  Online, the host decides the throw (it simulates the crowd) and broadcasts it, the bottle flies for everyone, and the damage to a car is computed by its
  owner. Settings — `MOLOTOV` in `src/molotov.js`.

- **Start**: grid slots (5 slots in 2 rows) are dealt randomly every race — to the player and the rivals alike.
- **Race**: 3 laps through the streets via yellow checkpoint gates, before time runs out. Each gate
  adds as many seconds as the next leg takes at an average speed of ~58 km/h, plus +5 s per lap.
  Pedestrians add a little time (killed +2 s, gibbed +3, crushed +2,
  blown up +1), but the main thing is to reach the finish. A light beam shines above the next gate, the top of the screen shows an
  arrow and the distance, and the route is drawn on the minimap. Time left at the finish turns into points.

- **The city** is generated procedurally (with a fixed seed): 6×6 blocks — office towers, apartment blocks,
  shops with awnings, houses with pitched roofs, parks with a fountain, a plaza with a monument and columns,
  gas stations. Roads with markings and zebra crossings, sidewalks with curbs, a boundary wall around the perimeter.
- **Pedestrians** walk along a sidewalk graph and cross roads at zebra crossings. The crowd is replenished: the dead are replaced
  by new ones — 45–170 m from the player and only where there is no car within 30 m. When they notice a speeding car or an explosion
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
- **Points and combos**: kills no more than 4 s apart (`COMBO_TIME`) multiply points, and the streak gets a name: 2 — "дуплет", 3 — "триплет", 4 — "каре", 5 — "пятилетка", 6 — "кровавая баня", 7 — "джекпот 777", 8 — "жатва", 9 and more — "беспредел ×N" (each tier has several random captions, list — `SERIES` in `src/words.js`); bonuses for air time, wall hits, etc.
  Every kill comes with a caption from a "culinary" vocabulary — "КОТЛЕТА!", "ОТБИВНАЯ!", "ФАРШ!",
  "ЛАВАШ!", "ДУРШЛАГ!"… The lists live in `src/words.js`, add your own.
- **Bloody tire tracks** appear only when a wheel has rolled through a pool or spot of blood, and trail
  behind that wheel for ~26 m.
- All sound is synthesized with WebAudio (engine with gears, tire squeal, cannon shot, shell blast, splat, screams, explosion).
  **Sound settings** — in the main menu and in pause: master volume, "engine and tires", "effects" (shots, hits,
  screams) and "mute all sound". A slider plays a sample right away; settings are remembered in the browser.
  The engine is only heard during a race — it is silent in the menu, in pause and on the results screen.
- **Test ground** — the «ТЕСТОВЫЙ ПОЛИГОН» button in the main menu (or `?map=test`; back — «В ГОРОД»).
  A lot the same size as the city and behind the same wall, but instead of blocks it is flat asphalt with a 20 m grid,
  two buildings and a row of street props. Pedestrians stand in place and don't get scared (one knocked down gets up and stands where they fell):
  one with Molotov cocktails (throws as usual), a crowd of 20 further away, and beyond it a line of 50 spaced 2 m apart. A dead one
  stands up again in their spot after 5 s if no car is within 8 m. It also has vertical play for the physics:
  - a big 3.5 m ramp in front of the line of 50: at ~108 km/h you land right in it, nose first; with one side up it
    you roll over;
  - three 1.2 m kickers with a boost pad before them, and a ramp over the tube's exit trench (clears it from ~79 km/h);
  - the underground tube on the west side: an open trench down 5.5 m, an 80 m covered tunnel with lights and a
    pedestrian standing on its roof, a trench back up; the trenches are fenced with 0.9 m rails, and the camera stays
    under the tunnel's ceiling;
  - a 6 m deck reached by a 40 m ramp, with eight pedestrians on it;
  - orange boost pads (130 km/h along the heading) and a red catapult (18 m/s straight up) right before a 4.5 m wall
    (it clears the wall from ~65 km/h).

  No rivals, no track, no timer and no win condition — only
  your own car; if it gets wrecked — «ЕЩЁ ЗАЕЗД». Single player only (online only from a test script). New mechanics
  should be added here too. Layout — `testGround()` and `verticals()` in `src/world/city.js`.
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
  half up) and nearly still (under 1.5 m/s and 1.5 rad/s) for 1.5 s, it rolls back onto its wheels («НА КОЛЁСА!»):
  still a physical body, so walls push it away, turned upright about its centre of mass at up to 6 rad/s with its
  heading kept, for at most 1.5 s. `R` on a tipped car does that at once.
- **Blasts** shove a car (`CANNON.push`, 7 m/s at the centre) with a tenth of it upwards and tilt it away at 1 rad/s
  per m/s: a blast touching its side throws a parked car at 21 km/h and tilts it 40°, 1 m away — 16 km/h and 16°,
  2 m — 11 km/h and 7°, 3 m — 6 km/h and 3°.
- **Weapons and pedestrians** use the car's box turned with its body (2.1 × 1.7 × 4.7 m, up to 2.2 m with the
  cannon). Shells and bullets fly from the barrel's real pose (a car nose-up on a ramp fires upwards; the springs' few
  degrees are ignored) and stop at any solid surface, the ground included; a car on its roof fires into the ground.
  A pedestrian is hit by that box too: a car flying over heads or driving through the tube under them misses them,
  one landing on them hits as hard as it falls. Street props are sensors: they break when the body touches them faster
  than 2.5 m/s (a car flying over a bin misses it) and slow the car a little (at 40 km/h a lamp or a bench takes off
  ~12%, a bin ~6%).
- **Everything else is 2D.** Pedestrians, debris, the camera and the bots' navigation and line of sight use a 2D world
  on the XZ plane (buildings are AABBs, poles are circles, a spatial grid, DDA ray casts), with heights from the car's
  real pose — enough for an arcade game and cheap on phones.
- **Cost** (a desktop PC, a phone-sized 375 × 812 window, `?q=low`): a battle royale of 20 cars takes ~3.3 ms a frame
  — the simulation 1.6 ms (of it the physics 0.7: Rapier's world 0.37, the cars' controls and suspension 0.24), the
  rendering 1.8 ms; with 2 cars 2.2 ms. Rapier adds ~2.2 MB to the bundle (0.85 MB gzipped) and 10–60 ms to the boot.

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
other's ghost would push both cars the same way, faster and faster. A respawn moves the ghosts at once. Measured with
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
- `?map=test` — the test ground instead of the city;
- `?debug` — FPS counter;
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
  racers.js           rivals: personalities (RIVALS), AI — track, hunting cars and pedestrians, car hits (CAR_HIT)
  tag.js              label above a car: name and hull bar
  gunner.js           bot gunner in the turret (crew mode): target choice, turning, firing (settings — GUNNER)
  zone.js             battle royale: cylindrical zone, spawn points (settings — ZONE)
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
                      bot games (stuck bots, wrecks, kills), the bot gunner on a tilted car
tests/net.html, net.js  two games side by side in one page, joined in a room through the server: a car vs its ghost
                      in jumps, rollovers and ordinary driving, rams, the gunner on a tilted car, reconnecting, bytes
```

Cars are bodies in the Rapier physics engine; everything else collides in the XZ plane (see [Physics](#physics)).
Pedestrians (all body parts) are drawn in ~6 draw calls via
`InstancedMesh`. On a weak device the render resolution drops automatically if the FPS sags.

Main tuning numbers: `PHYS` in `src/physics/rapier.js` (gravity, the step and `maxSteps` per frame, ground and wall friction) and `VEH` in `src/physics/vehicle.js` (`mass`, centre of mass — `com`, `inertia`, chassis shape — `lower`/`cabin`, its `friction`/`restitution`, `angularDamping`, suspension — `wheelRadius`/`rest`/`travel`/`stiffness`/`compression`/`relaxation`, the arcade layer's fade with lean — `upFull`/`upNone`, grip against obstacles — `leanGrip`, the flip rule — `flipUp`/`flipAfter`/`flipStill`/`rightRate`/`rightLift`/`rightTime`, tripping — `tripAccel`/`trip`/`tripTime`, wall hits — `wallNormal`, landing and roof damage — `landAir`/`landSafe`/`landScale`/`roofSafe`/`roofScale`, blasts — `blastLift`/`blastSpin`, pads — `boost`/`launch`; `GHOST` — other players' cars over the network: the spring's `rate`, how far a snapshot is carried forward — `ahead`, `sink`, `snap`, passing through — `deep`/`loose`, a just-hit ghost — `holdShow`/`hold`, reconciling knocks — `knockWindow`), `SNAP_HZ`/`LEAD_MAX` in `src/net/netplay.js` (snapshots a second, the most a snapshot is carried forward for the network's delay), `P` in `src/car.js` (thrust, grip, steering at speed — the `yawCap` table and `hardFrom`/`hardTo`/`steerTime`/`yawResp`, steering return — `steerReturn`/`yawUnwind`, damage threshold and multiplier),
`HEAL` in `src/main.js` (repair for kills), `RACE` in `src/race.js` (laps, pace, time bonuses),
`CANNON` in `src/cannon.js` (reload, damage, blast radius), `MG` in `src/mg.js` (machine gun), `MOLOTOV` in `src/molotov.js` (cocktails), `RIVALS` (personality `aggr`/`gore`, speed; battle bots beyond seven reuse the same personalities under names from `EXTRA`), `MAX_CARS`/`MAX_CARS_ROYALE` (cars in a race / in battle),
`HUNT`/`GORE`/`PREY_WEIGHT`/`HUNT_DELAY`, `STUCK` and `CAR_HIT` in `src/racers.js` (how personality scales turn into behavior,
whom hunters go after, when a stuck bot respawns, ram damage), `RACE.goreWin` (how many pedestrians to win), `KNOCK_SPEED`/`KILL_SPEED` and pedestrian reactions in `_panic()`
in `src/pedestrians.js`, `QUALITY`/`CITY` in `src/config.js`.
