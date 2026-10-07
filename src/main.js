import * as THREE from 'three';
import './style.css';
import { QUALITY, IS_TOUCH, DEBUG } from './config.js';
import { buildCity } from './world/city.js';
import { Breakables } from './world/props.js';
import { FX } from './effects/fx.js';
import { Debris } from './effects/debris.js';
import { AudioFX } from './audio.js';
import { Car } from './car.js';
import { Pedestrians } from './pedestrians.js';
import { Artillery, CANNON } from './cannon.js';
import { Input } from './input.js';
import { ChaseCamera } from './camera.js';
import { HUD } from './hud.js';
import { Race, RACE } from './race.js';
import { Rival, RIVALS, GRID, gridPoint, collideCars, carHitDamage } from './racers.js';
import { CarTag } from './tag.js';
import { Netplay } from './net/netplay.js';
import { Lobby } from './net/lobby.js';
import { CrashReporter } from './crash.js';
import { phrase } from './words.js';
import { version } from '../package.json';

const $ = (id) => document.getElementById(id);
const NO_INPUT = { throttle: 0, brake: 0, steer: 0, handbrake: false, fire: false };
const STOP_INPUT = { throttle: 0, brake: 0, steer: 0, handbrake: true, fire: false };
// сколько корпуса чинит убийство: давить выгоднее, чем стрелять
const HEAL = { car: 6, gib: 8, crush: 8, explosion: 2 };
const WRECK_HEAL = 15; // разбил машину тараном или из пушки — подлатался
const WRECK_CREDIT_MS = 4000; // чей последний удар был за столько мс до взрыва, тот и разбил
const GORE_WARN = [25, 40, 45]; // на скольких пешеходах предупредить, что соперник близок к победе
const BEST_KEY = 'cars-and-guts:best';
const WIN_BONUS = 3000;
const PLAYER_COLOR = '#e5262b';
const SHADOW_EXTENT = 60;
const SHADOW_MAP = 2048;
const WIN_TEXT = { finish: 'ПОБЕДА! ПЕРВЫЙ!', annihilation: 'ВСЕ ТАЧКИ РАЗБИТЫ!', carnage: `${RACE.goreWin} ПЕШЕХОДОВ!` };
const LOSE_TEXT = {
  finish: (n) => `${n} финишировал первым`,
  annihilation: (n) => `${n} разбил всех`,
  carnage: (n) => `${n} первым набил ${RACE.goreWin} пешеходов`,
};

class Game {
  constructor() {
    // ------------------------------------------------------------ рендер
    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: QUALITY.antialias, powerPreference: 'high-performance' }));
    this.pixelRatio = QUALITY.pixelRatio;
    renderer.setPixelRatio(this.pixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = QUALITY.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    $('app').appendChild(renderer.domElement);

    const scene = (this.scene = new THREE.Scene());
    const horizon = new THREE.Color('#cfdde6');
    scene.background = horizon;
    scene.fog = new THREE.Fog(horizon, 110, 360);
    this._sky(horizon);

    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 1500);

    scene.add(new THREE.HemisphereLight(0xdcecff, 0x6b5a48, 1.35));
    const sun = (this.sun = new THREE.DirectionalLight(0xfff0d8, 2.4));
    sun.castShadow = QUALITY.shadows;
    if (QUALITY.shadows) {
      sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
      const sc = sun.shadow.camera;
      sc.left = sc.bottom = -SHADOW_EXTENT;
      sc.right = sc.top = SHADOW_EXTENT;
      sc.near = 1;
      sc.far = 260;
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.03;
    }
    scene.add(sun, sun.target);

    // ------------------------------------------------------------ мир
    this.city = buildCity(scene, QUALITY);
    this.fx = new FX(scene, this.city.groundHeight, QUALITY);
    this.debris = new Debris(scene, this.city.groundHeight, this.city.world);
    this.audio = new AudioFX();
    this.breakables = new Breakables(scene, this.city.world, this.city.props, this.city.groundHeight, this.debris, this.fx, this.audio, QUALITY);
    this.car = new Car(scene, this.city, this.fx, this.audio, this.debris, QUALITY);
    this.carTag = new CarTag(scene, this.car);
    this.peds = new Pedestrians(scene, this.city, this.fx, this.audio, QUALITY);
    this.artillery = new Artillery(scene, this.city, this.fx, this.audio);
    this.race = new Race(scene, this.city, this.fx, this.audio);
    this.raceLaps = RACE.laps;
    this.rivals = RIVALS.map((def, i) => new Rival(scene, this.city, this.fx, this.audio, this.debris, QUALITY, this.race, def, i));
    this.quality = QUALITY;
    this.net = null; // сетевой заезд (Netplay) или null
    this.netPool = new Map(); // машины людей по сети — живут между заездами
    this.remotes = []; // { car, tag } людей в текущем сетевом заезде
    this.setCars([this.car, ...this.rivals.map((r) => r.car)]);
    this.artillery.peds = this.peds;
    this.artillery.breakables = this.breakables;
    this.artillery.listener = this.car;
    this.reloadTime = CANNON.reload;
    this.standings = [];
    this.position = 1;
    this.hud = new HUD(this.city);
    this.cam = new ChaseCamera(this.camera, this.city);
    this.input = new Input(renderer.domElement, {
      zone: $('joy-zone'),
      base: $('joy-base'),
      knob: $('joy-knob'),
      fire: $('btn-fire'),
      brake: $('btn-brake'),
    });
    this._dbs = new THREE.Vector2();

    this._wire();
    this.lobby = new Lobby(this);
    this._resetStats();
    this.peds.reset(this.cars);

    this.state = 'menu';
    this.overKind = null;
    this.countdown = 0;
    this.halted = false;
    this.time = 0;
    this.lastFrameAt = 0;
    this.lastVisibilityChange = 0;
    this.best = this._loadBest();
    this.timer = new THREE.Timer();
    this.timer.connect(document);
    this.perf = { acc: 0, frames: 0, slow: 0 };
    window.addEventListener('resize', () => this._resize());
    this._resize();
    document.body.classList.toggle('touch', IS_TOUCH);
    renderer.setAnimationLoop((t) => this._tick(t));
  }

  _sky(horizon) {
    const geo = new THREE.SphereGeometry(1200, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new THREE.Color('#4a86c8') }, bottom: { value: horizon.clone() } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying vec3 vP;
        void main(){ float h = clamp(vP.y, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, pow(h, 0.55)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);
  }

  /** Все машины заезда: первая — своя. */
  setCars(list) {
    this.cars = list;
    this.artillery.cars = list;
  }

  _resetStats() {
    this.score = 0;
    this.kills = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.bestCombo = 0;
    this.multi = 0;
    this.lastKill = -10;
    this.playTime = 0;
    this.maxSpeed = 0;
    this.critWarned = false;
    this.wreckShown = false;
  }

  // ------------------------------------------------------------ связи между системами
  _wire() {
    const { car, peds, hud, cam, input } = this;
    car.onBreakable = (c, car_) => this.breakables.hit(c.prop, car_);
    car.onImpact = (impact, px, pz) => {
      cam.shake(Math.min(0.85, impact / 22));
      if (impact > 6) peds.alert(px, pz, 22);
      if (impact > 20 && !car.wrecked) hud.popup(phrase('crash'), 'warn');
    };
    car.onDamage = (dmg) => {
      hud.damageFlash(Math.min(0.85, 0.2 + dmg / 30));
      if (car.health < 25 && car.health > 0 && !this.critWarned) {
        this.critWarned = true;
        hud.popup('КОРПУС КРИТИЧЕН!', 'warn');
      }
    };
    car.onWrecked = () => {
      this._wreckedBy(car)?.heal(WRECK_HEAL);
      peds.explosion(car.x, car.z, 11, car);
      cam.shake(1);
      hud.damageFlash(1);
      hud.popup('ТАЧКА РАЗБИТА!', 'big warn');
      this._gameOver('wreck');
    };
    this.race.onEvent = (type, data) => this._raceEvent(type, data);
    for (const r of this.rivals) {
      const rc = r.car;
      rc.listener = car;
      rc.onBreakable = (c, car_) => this.breakables.hit(c.prop, car_);
      rc.onImpact = (impact, px, pz) => {
        if (impact > 6) peds.alert(px, pz, 18);
      };
      rc.onWrecked = () => this._carWrecked(rc);
    }
    this._onCarHit = (a, b, impact, px, pz, nx, nz) => this._carHit(a, b, impact, px, pz, nx, nz);
    peds.onKill = (p, cause, speed) => this._kill(p, cause, speed);
    peds.onEvent = (type, p) => this._pedEvent(type, p);
    this.artillery.onCarHit = (victim, shooter, dmg, direct) => this._shellHit(victim, shooter, dmg, direct);
    this.artillery.onBlast = (x, z, shooter) => {
      const d = Math.hypot(x - car.x, z - car.z);
      if (shooter === car) cam.shake(0.12);
      if (d < 40) cam.shake(0.5 * (1 - d / 40));
    };

    input.onTouchDetected = () => {
      document.body.classList.add('touch');
      this._syncTouchUI();
    };
    input.onAction = (a) => this._action(a);

    const click = (id, fn) => $(id).addEventListener('click', (e) => {
      e.preventDefault();
      fn();
    });
    click('btn-play', () => this.start());
    click('btn-resume', () => this._setPaused(false));
    click('btn-restart', () => this._again());
    click('btn-net', () => this.lobby.open());
    click('btn-net-leave', () => this.lobby.leaveRoom());
    click('btn-net-leave2', () => this.lobby.leaveRoom());
    click('btn-net-lobby', () => this.net?.toLobby());
    click('btn-restart2', () => this.restart());
    click('btn-unstuck', () => {
      this._unstuck();
      this._setPaused(false);
    });
    click('btn-log', () => crash.open());
    click('btn-prev-crash', () => crash.open(true));
    click('btn-cam', () => this._action('camera'));
    click('btn-mute', () => this._action('mute'));
    click('btn-pause', () => this._action('pause'));
    document.addEventListener('visibilitychange', () => {
      this.lastVisibilityChange = performance.now();
      if (document.hidden && this.state === 'play' && !this.net) this._setPaused(true);
    });
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      crash.report({ message: 'Потерян контекст WebGL: браузер сбросил графику (часто из-за нехватки памяти на телефоне).', stack: '' }, 'webglcontextlost');
    });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => crash.note('Контекст WebGL восстановлен'));
  }

  _action(a) {
    switch (a) {
      case 'camera':
        this.cam.next();
        this.hud.popup(`Камера: ${this.cam.modeName}`, 'info');
        break;
      case 'mute':
        this.audio.setMuted(!this.audio.muted);
        $('btn-mute').classList.toggle('off', this.audio.muted);
        break;
      case 'pause':
        if (this.net) this._setPaused(!this.netPaused);
        else if (this.state === 'play') this._setPaused(true);
        else if (this.state === 'pause') this._setPaused(false);
        break;
      case 'respawn':
        if (this.state === 'play') this._unstuck();
        else if (this.state === 'over' && this.wreckShown) this._again();
        break;
      case 'confirm':
        if (this.state === 'menu' && !this.lobby.visible) this.start();
        else if (this.state === 'over' && this.wreckShown) this._again();
        else if (this.state === 'pause' || this.netPaused) this._setPaused(false);
        break;
    }
  }

  /** Заезд ещё идёт: одному — пока сам в игре; по сети — пока сервер не объявил победителя. */
  _live() {
    return this.net ? this.race.started && !this.net.result : this.state === 'play';
  }

  /** Ещё заезд: одному — сразу, по сети — только хост. */
  _again() {
    if (this.net) this.net.restart();
    else this.restart();
  }

  _kill(p, cause, speed) {
    const killer = p.killer || this.car;
    // чужая машина по сети задавила моего пешехода — у неё свои пешеходы и свой счёт
    if (killer.remote) return;
    if (!killer.wrecked) killer.kills++;
    if (killer !== this.car) {
      // сбил соперник: очков игроку нет, соперник подлатывается и приближается к победе мясника
      killer.heal(HEAL[cause] || 0);
      this._rivalGore(killer);
      return;
    }
    this.kills++;
    const t = this.time;
    this.combo = t - this.lastKill < 3.5 ? this.combo + 1 : 1;
    this.multi = t - this.lastKill < 0.7 ? this.multi + 1 : 1;
    this.lastKill = t;
    this.comboTimer = 3.5;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    const base = { car: 100, gib: 150, crush: 100, gun: 75, explosion: 120 }[cause] ?? 100;
    const cls = cause === 'gib' || cause === 'explosion' ? 'big' : '';
    const pts = base * this.combo;
    this.score += pts;
    this.hud.popup(`${phrase(cause)} +${pts}`, cls);
    if (this.multi === 2) this.hud.popup('ДУПЛЕТ!', 'gold');
    else if (this.multi === 3) this.hud.popup('ТРИПЛЕТ!', 'gold');
    else if (this.multi === 4) this.hud.popup('МЯСОРУБКА!', 'gold big');
    else if (this.multi >= 5) this.hud.popup('МЯСОКОМБИНАТ!', 'gold big');
    if ((cause === 'car' || cause === 'gib') && speed > 13 && this.cam.mode !== 2) this.hud.splatter(Math.min(1.5, speed / 22));
    if (cause === 'car' || cause === 'gib' || cause === 'crush') this.cam.shake(0.12 + speed * 0.006);
    const added = this.state === 'play' ? this.race.addTime(RACE.killTime[cause] || 0) : 0;
    if (added > 0) this.hud.timeBonus(added);
    const healed = this.car.heal(HEAL[cause] || 0);
    if (healed > 0) {
      this.hud.heal(Math.round(healed));
      if (this.car.health > 40) this.critWarned = false;
    }
    if (this.state === 'play' && !this.car.wrecked && this.car.kills >= RACE.goreWin) this._victory('carnage', this.car);
  }

  /** Соперник сбил пешехода: предупредить, если он близок к победе, или объявить его победу. */
  _rivalGore(c) {
    if (!this._live() || c.wrecked) return;
    const k = c.kills;
    if (k >= RACE.goreWin) this._victory('carnage', c);
    else if (GORE_WARN.includes(k)) this.hud.popup(`${c.name}: ${k} ИЗ ${RACE.goreWin} ПЕШЕХОДОВ`, 'warn');
  }

  /** Кто-то выиграл заезд. Одному — сразу; по сети — заявка серверу: кто первый заявил, тот и выиграл. */
  _victory(kind, car) {
    if (this.net) this.net.claim(kind, car);
    else this._result(kind, car, car.name);
  }

  /** Итог заезда: победил car (по сети чужой может быть неизвестен — тогда только имя). */
  _result(kind, car, name) {
    if (car === this.car) {
      if (this.state !== 'play') return;
      const bonus = Math.round(this.race.timeLeft) * 100;
      this.score += WIN_BONUS + bonus + (kind === 'finish' ? 1000 : 0);
      this.hud.popup(WIN_TEXT[kind], 'gold big');
      if (kind === 'finish') {
        if (bonus) this.hud.popup(`ЗАПАС ВРЕМЕНИ +${bonus}`, 'gold');
        this.cam.shake(0.3);
      } else this.hud.popup('ПОБЕДА!', 'gold big');
      this.audio.finish();
      this._gameOver(kind);
      return;
    }
    this.winner = car || { name };
    this.winReason = LOSE_TEXT[kind](name);
    if (this.state !== 'play') return;
    this.hud.popup(this.winReason.toUpperCase(), 'big warn');
    this.audio.timeout();
    this._gameOver('lost');
  }

  _pedEvent(type, p) {
    if (p.killer && p.killer !== this.car) return;
    if (type === 'knock') {
      this.hud.popup(phrase('knock'), 'info');
      return;
    }
    p.bonus = p.bonus || 0;
    const bits = { air: 1, wall: 2, juggle: 4, mince: 8 };
    if (p.bonus & bits[type]) return;
    p.bonus |= bits[type];
    const pts = { air: 50, wall: 50, juggle: 40, mince: 25 }[type];
    this.score += pts;
    this.hud.popup(`${phrase(type)} +${pts}`, 'gold');
  }

  // ------------------------------------------------------------ состояния
  start() {
    this.audio.init();
    if (IS_TOUCH || this.input.usingTouch) {
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req && !document.fullscreenElement) {
        try {
          Promise.resolve(req.call(el))
            .then(() => screen.orientation?.lock?.('landscape'))
            .catch(() => {});
        } catch {
          // полноэкранный режим недоступен — играем как есть
        }
      }
    }
    $('menu').classList.add('hidden');
    this.restart();
  }

  /** slots — места на решётке по сети { netId: номер в GRID }; без них — случайно. */
  restart(slots = null) {
    this.audio.init();
    this.fx.clear();
    this.artillery.clear();
    this.winner = null;
    this.winReason = '';
    this.debris.clear();
    this.breakables.reset();
    // места на старте — каждый заезд случайно
    let slotOf;
    if (slots) slotOf = (c) => GRID[slots[c.netId] ?? 0];
    else {
      const free = GRID.slice(0, this.cars.length);
      for (let i = free.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [free[i], free[j]] = [free[j], free[i]];
      }
      slotOf = (c) => free[this.cars.indexOf(c)];
    }
    this.startPoint = gridPoint(this.city, slotOf(this.car));
    this.car.reset(this.startPoint);
    this.race.reset();
    for (const r of this.rivals) r.reset(slotOf(r.car));
    for (const rc of this.remotes) rc.car.reset(gridPoint(this.city, slotOf(rc.car)));
    this.peds.reset(this.cars);
    this._resetStats();
    this.cam.snap(this.car);
    this.state = 'play';
    this.overKind = null;
    this.countdown = RACE.countdown;
    this.countShown = Infinity;
    this.netPaused = false;
    $('wreck').classList.add('hidden');
    $('pause').classList.add('hidden');
    $('menu').classList.add('hidden');
    document.body.classList.toggle('net', !!this.net);
    this.hud.show(true);
    this._syncTouchUI();
  }

  /** Начать сетевой заезд (из лобби, по сообщению сервера start). */
  startNet(client, room, slots) {
    if (this.net) this.net.dispose();
    this.net = new Netplay(this, client, room);
    this.restart(slots);
  }

  /** Выйти из сетевой игры: машины — как для одиночной, игра — в меню. */
  endNet() {
    if (!this.net) return;
    this.net.dispose();
    this.net = null;
    this.car.setColor('#b3121a');
    this.setCars([this.car, ...this.rivals.map((r) => r.car)]);
    this.restart();
    this.state = 'menu';
    this.hud.show(false);
    this._syncTouchUI();
  }

  _setPaused(p) {
    if (this.net) {
      // по сети мир не останавливается — только меню поверх
      this.netPaused = p && (this.state === 'play' || this.state === 'over');
      $('pause').classList.toggle('hidden', !this.netPaused);
      return;
    }
    if (p && this.state === 'play') {
      this.state = 'pause';
      $('pause').classList.remove('hidden');
      this.audio.suspend();
    } else if (!p && this.state === 'pause') {
      this.state = 'play';
      $('pause').classList.add('hidden');
      this.audio.resume();
      this.timer.reset();
    }
    this._syncTouchUI();
  }

  _unstuck() {
    const car = this.car;
    if (car.wrecked) return;
    // в заезде — к последнему пройденному чекпоинту, лицом по маршруту
    const sp = this.race.respawnPoint(undefined, this.startPoint);
    car.x = sp.x;
    car.z = sp.z;
    car.yaw = sp.yaw;
    car.vx = car.vz = car.angVel = 0;
    this.cam.snap(car);
    this.hud.popup('К ЧЕКПОИНТУ', 'info');
  }

  _syncTouchUI() {
    const show = (IS_TOUCH || this.input.usingTouch) && this.state === 'play';
    $('touch').classList.toggle('hidden', !show);
  }

  _gameOver(kind) {
    if (this.state !== 'play') return;
    this.state = 'over';
    this.overKind = kind;
    this.wreckAt = this.time;
    this.race.done = true;
    this.race._style();
    if (kind === 'finish') this._saveBest();
    else this.newRecord = false;
  }

  _loadBest() {
    try {
      return JSON.parse(localStorage.getItem(BEST_KEY)) || {};
    } catch {
      return {};
    }
  }

  _saveBest() {
    const t = this.race.elapsed;
    this.newRecord = !this.best.time || t < this.best.time;
    if (this.newRecord) this.best.time = t;
    if (!this.best.score || this.score > this.best.score) this.best.score = this.score;
    try {
      localStorage.setItem(BEST_KEY, JSON.stringify(this.best));
    } catch {
      // не страшно
    }
  }

  _showWreck() {
    this.wreckShown = true;
    const fmt = (sec) => {
      const t = Math.max(0, sec);
      const m = Math.floor(t / 60), s2 = t - m * 60;
      return `${m}:${s2.toFixed(1).padStart(4, '0')}`;
    };
    const race = this.race;
    const won = this.overKind === 'finish' || this.overKind === 'annihilation' || this.overKind === 'carnage';
    $('btn-restart').textContent = this.net && !this.net.isHost ? 'ЖДЁМ ХОСТА…' : 'ЕЩЁ ЗАЕЗД';
    $('btn-restart').disabled = !!this.net && !this.net.isHost;
    $('btn-net-lobby').classList.toggle('hidden', !this.net?.isHost);
    const titles = {
      wreck: 'ТАЧКА РАЗБИТА',
      timeout: 'ВРЕМЯ ВЫШЛО',
      lost: 'ПОРАЖЕНИЕ',
      finish: 'ПОБЕДА! ПЕРВЫЙ НА ФИНИШЕ',
      annihilation: 'ПОБЕДА! ВСЕ ТАЧКИ РАЗБИТЫ',
      carnage: `ПОБЕДА! ${RACE.goreWin} ПЕШЕХОДОВ`,
    };
    const title = $('result-title');
    title.textContent = titles[this.overKind] || 'КОНЕЦ';
    title.className = won ? 'gold' : 'red';
    const why = { lost: this.winReason }[this.overKind] || '';
    const laps = this.overKind === 'finish' ? `${RACE.laps}/${RACE.laps}` : `${race.lap - 1}/${RACE.laps}`;
    const best = race.lapTimes.length ? fmt(Math.min(...race.lapTimes)) : '—';
    const rows = [
      ['Итог', won ? 'победа' : why || 'проигрыш'],
      ['Соперников разбито', `${this.cars.filter((c) => c !== this.car && c.wrecked).length} из ${this.cars.length - 1}`],
      ['Очки', this.score.toLocaleString('ru-RU')],
      ['Кругов пройдено', laps],
      ['Время заезда', fmt(race.elapsed)],
      ['Лучший круг', best],
      ['Сбито пешеходов', `${this.kills} из ${RACE.goreWin}`],
      ['Лучшее комбо', `×${this.bestCombo}`],
      ['Макс. скорость', `${Math.round(this.maxSpeed * 3.6)} км/ч`],
    ];
    if (this.overKind === 'finish') rows.splice(3, 0, ['Рекорд трассы', this.newRecord ? 'НОВЫЙ!' : fmt(this.best.time)]);
    const table = this.standings
      .map((e, i) => {
        const st = e.finished ? `финиш ${fmt(e.time)}` : e.car.wrecked ? 'разбит' : `круг ${Math.min(e.lap, RACE.laps)}`;
        return `<div class="st-row${e.player ? ' me' : ''}"><i style="background:${e.color}"></i><span>${i + 1}. ${e.name}</span><small>${e.car.kills} пеш.</small><b>${st}</b></div>`;
      })
      .join('');
    $('stats').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('') + `<div class="st-table">${table}</div>`;
    $('wreck').classList.remove('hidden');
    this._syncTouchUI();
  }

  /** Проехал ворота — подлатался. */
  _gateHeal() {
    const healed = this.car.heal(RACE.cpHeal);
    if (healed > 0) {
      this.hud.heal(Math.round(healed));
      if (this.car.health > 40) this.critWarned = false;
    }
  }

  _raceEvent(type, data) {
    const { hud, audio } = this;
    if (type === 'checkpoint' || type === 'lap') this._gateHeal();
    if (type === 'checkpoint') {
      const b = Math.round(data.bonus);
      this.score += 50;
      hud.popup(`ЧЕКПОИНТ! +${b} С`, 'gold');
      hud.timeBonus(b);
      audio.checkpoint();
    } else if (type === 'lap') {
      const b = Math.round(data.bonus);
      this.score += 300;
      hud.popup(data.last ? 'ПОСЛЕДНИЙ КРУГ!' : `КРУГ ${data.lap}/${RACE.laps}`, 'gold big');
      hud.popup(`+${b} С`, 'gold');
      hud.timeBonus(b);
      audio.lap();
    } else if (type === 'finish') {
      // остаток времени и место — в очки (по сети — если сервер подтвердит, что первый)
      this._victory('finish', this.car);
    } else if (type === 'timeout') {
      hud.popup('ВРЕМЯ ВЫШЛО!', 'big warn');
      audio.timeout();
      this._gameOver('timeout');
    } else if (type === 'tick') {
      audio.tick(data);
    }
  }

  /** Удар машины о машину: урон по зонам, искры, звук, надписи. */
  _carHit(a, b, impact, px, pz, nx, nz) {
    const player = this.car;
    if (a.ai && !a.remote) a.ai.onCarContact(b);
    if (b.ai && !b.remote) b.ai.onCarContact(a);
    const now = performance.now();
    const y = Math.min(a.y, b.y) + 0.8;
    if (impact > 2) this.fx.sparks(px, y, pz, nx, nz, Math.min(24, Math.floor(impact * 1.2)));
    const vol = Math.max(a.vol(), b.vol());
    if (impact > 3 && vol > 0.03 && now - (this._lastCarSound || 0) > 140) {
      this._lastCarSound = now;
      this.audio.crash(Math.min(1.2, impact / 16) * vol);
    }
    if (a === player || b === player) this.cam.shake(Math.min(0.8, impact / 24));
    if (impact > 6) this.peds.alert(px, pz, 18);
    const da = carHitDamage(a, b, impact, px, pz);
    const db = carHitDamage(b, a, impact, px, pz);
    // по сети урон от тарана считает таранящий — у него своя машина точная, а чужая приходит с опозданием
    // и уже после удара; он и шлёт урон владельцу жертвы. Удар чужой машины по своей придёт так же, событием.
    this._ramDamage(a, b, da, px, pz, nx, nz, now);
    this._ramDamage(b, a, db, px, pz, -nx, -nz, now);
    // игрок протаранил соперника
    const dealt = a === player ? db : b === player ? da : 0;
    const victim = a === player ? b : b === player ? a : null;
    if (victim && dealt >= 5 && now - (this._lastRamPopup || 0) > 700 && this.state === 'play') {
      this._lastRamPopup = now;
      this.score += Math.round(dealt) * 10;
      this.hud.popup(`${phrase('ram')} −${Math.round(dealt)}`, 'gold');
    }
  }

  /** Урон victim от тарана by: своим машинам — сразу, чужой по сети — событием её владельцу. */
  _ramDamage(victim, by, dmg, px, pz, nx, nz, now) {
    if (dmg <= 0 || by.remote) return;
    if (victim.remote) {
      this.net.sendHit(victim, by, dmg, px, pz, nx, nz);
      return;
    }
    victim.lastAttacker = by;
    victim.lastAttackAt = now;
    victim.applyDamage(dmg, px, pz, nx, nz);
  }

  /** Снаряд попал в машину. */
  _shellHit(victim, shooter, dmg, direct) {
    const player = this.car;
    if (this.state !== 'play') return;
    if (shooter === player && victim !== player && dmg >= 3) {
      this.score += Math.round(dmg) * 10;
      this.hud.popup(`${direct ? 'ПРЯМОЕ ПОПАДАНИЕ!' : 'ЗАДЕЛ!'} −${Math.round(dmg)}`, 'gold');
    }
    if (victim === player) this.cam.shake(direct ? 0.7 : 0.35);
  }

  /** Кто разбил машину (тараном или из пушки), если он ещё на ходу. */
  _wreckedBy(c) {
    const by = c.lastAttacker;
    if (!by || by === c || by.wrecked || performance.now() - c.lastAttackAt > WRECK_CREDIT_MS) return null;
    return by;
  }

  /** Разбита чужая машина (бот или человек по сети). */
  _carWrecked(c) {
    const player = this.car;
    if (c.ai) c.ai.out = true;
    this.peds.explosion(c.x, c.z, 10, c);
    if (c.vol() > 0.2) this.cam.shake(0.5 * c.vol());
    const by = this._wreckedBy(c);
    const healed = by ? by.heal(WRECK_HEAL) : 0;
    if (this.state !== 'play') return;
    if (by === player) {
      this.score += 1000;
      this.hud.popup(`${c.name} ВЫБИТ! +1000`, 'gold big');
      if (healed > 0) this.hud.heal(Math.round(healed));
      const added = this.race.addTime(RACE.wreckTime);
      if (added > 0) {
        this.hud.popup(`+${added} С`, 'gold');
        this.hud.timeBonus(added);
      }
      if (player.health > 40) this.critWarned = false;
    } else {
      this.hud.popup(by ? `${by.name} РАЗБИЛ ${c.name}` : `${c.name} РАЗБИЛСЯ`, 'info');
    }
    const left = this.cars.filter((o) => o !== player && !o.wrecked).length;
    if (left > 0) this.hud.popup(`ОСТАЛОСЬ ВРАГОВ: ${left}`, 'warn');
  }

  /** Все остальные машины разбиты — победа. */
  _checkAnnihilation() {
    if (this.state !== 'play' || this.car.wrecked || !this.cars.every((c) => c === this.car || c.wrecked)) return;
    this._victory('annihilation', this.car);
  }

  /** Места в гонке: финишировавшие по порядку, остальные — по пройденному пути. */
  _updateStandings() {
    const race = this.race;
    const list = this.cars.map((c) => {
      if (c === this.car) {
        return { car: c, name: 'ТЫ', color: this.net ? c.opts.color : PLAYER_COLOR, player: true, finished: race.place > 0, place: race.place, passed: race.passed, next: race.next, lap: race.lap, time: race.elapsed };
      }
      const t = c.ai ? c.ai.tr : c.netRace; // бот — его счётчик, человек по сети — из снимков
      return { car: c, name: c.name, color: c.opts.color, rival: c.ai, finished: t.finished, place: t.place, passed: t.passed, next: t.next, lap: t.lap, time: t.time };
    });
    for (const e of list) {
      if (e.finished) e.progress = 1e6 - e.place;
      else if (e.car.wrecked) e.progress = -1e6 + e.passed;
      else e.progress = e.passed + race.segmentProgress(e.next, e.car.x, e.car.z);
    }
    list.sort((a, b) => b.progress - a.progress);
    this.standings = list;
    this.position = list.findIndex((e) => e.player) + 1;
  }

  _rivalEvent(r, ev) {
    if (!ev || !this._live()) return;
    if (ev.type === 'checkpoint' || ev.type === 'lap') r.car.heal(RACE.cpHeal);
    if (ev.type === 'finish') this._victory('finish', r.car); // соперник пришёл первым — гонка проиграна
    else if (ev.type === 'lap' && ev.lap === RACE.laps) this.hud.popup(`${r.name}: ПОСЛЕДНИЙ КРУГ`, 'info');
  }

  /** Синхронная физика всех машин: подшаги, столкновения между машинами, потом визуал. */
  _physics(dt, playerInp) {
    const cars = this.cars;
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      cars[0].physicsStep(h, playerInp);
      for (const r of this.rivals) if (!r.car.remote) r.car.physicsStep(h, r.inp);
      collideCars(cars, this._onCarHit);
    }
    cars[0].postUpdate(dt, playerInp);
    for (const r of this.rivals) r.car.postUpdate(dt, r.inp);
    for (const rc of this.remotes) rc.car.postUpdate(dt, NO_INPUT);
  }

  /** Снимок состояния для журнала ошибок. */
  debugState() {
    const car = this.car, race = this.race;
    const counts = {};
    for (const p of this.peds.peds) counts[p.state] = (counts[p.state] || 0) + 1;
    const info = this.renderer.info;
    const r1 = (v) => Math.round(v * 10) / 10;
    return {
      state: this.state,
      over: this.overKind,
      time: r1(this.time),
      countdown: r1(this.countdown),
      car: { x: r1(car.x), z: r1(car.z), yaw: r1(car.yaw), speed: r1(car.speed), health: r1(car.health), wrecked: car.wrecked },
      race: { lap: race.lap, next: race.next, timeLeft: r1(race.timeLeft), elapsed: r1(race.elapsed), done: race.done, position: this.position },
      rivals: this.rivals.map((r) => ({ name: r.name, role: r.role, mode: r.mode, x: r1(r.car.x), z: r1(r.car.z), speed: r1(r.car.speed), health: r1(r.car.health), kills: r.car.kills, lap: r.tr.lap, next: r.tr.next, stuck: r1(r.stuckT), target: r.target ? r.target.name : null })),
      shells: this.artillery.shells.length,
      score: this.score,
      kills: this.kills,
      pedsByState: counts,
      gibsActive: this.peds.gibs.items.filter((g) => g.active).length,
      debris: this.debris.items.length,
      decals: { blood: this.fx.blood.used, marks: this.fx.marks.used },
      render: { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures },
      pixelRatio: this.pixelRatio,
      quality: { low: QUALITY.low, shadows: QUALITY.shadows, peds: QUALITY.pedCount },
      touch: this.input.usingTouch,
    };
  }

  // ------------------------------------------------------------ кадр
  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    document.body.classList.toggle('portrait', h > w);
  }

  _followSun(x, z) {
    const texel = (SHADOW_EXTENT * 2) / SHADOW_MAP;
    const sx = Math.round(x / texel) * texel, sz = Math.round(z / texel) * texel;
    this.sun.position.set(sx - 55, 95, sz - 35);
    this.sun.target.position.set(sx, 0, sz);
    this.sun.target.updateMatrixWorld();
  }

  _adaptResolution(dt) {
    const pf = this.perf;
    pf.acc += dt;
    pf.frames++;
    if (pf.acc < 2) return;
    const fps = pf.frames / pf.acc;
    if (DEBUG) this.hud.setFps(Math.round(fps));
    if (this.state === 'play' && fps < 40 && this.pixelRatio > 0.75) {
      pf.slow++;
      if (pf.slow >= 2) {
        this.pixelRatio = Math.max(0.75, this.pixelRatio - 0.25);
        this.renderer.setPixelRatio(this.pixelRatio);
        this._resize();
        pf.slow = 0;
      }
    } else pf.slow = 0;
    pf.acc = 0;
    pf.frames = 0;
  }

  _tick(now) {
    if (this.halted) return;
    // зависание: кадр шёл больше 2 с, хотя вкладка не пряталась
    const gap = now - this.lastFrameAt;
    if (this.lastFrameAt && gap > 2000 && now - this.lastVisibilityChange > gap && !document.hidden) {
      crash.note(`Зависание: кадр шёл ${(gap / 1000).toFixed(1)} с (состояние: ${this.state})`);
    }
    this.lastFrameAt = now;
    try {
      this.timer.update(now);
      const dt = Math.min(this.timer.getDelta(), 1 / 20);
      this.step(dt);
      this.render();
      this._adaptResolution(dt);
    } catch (err) {
      // остановить цикл, чтобы ошибка не сыпалась каждый кадр, и показать окно
      this.halted = true;
      this.audio.suspend();
      crash.report(err, 'game loop');
    }
  }

  /** Продолжить после ошибки (из окна журнала). */
  resume() {
    if (!this.halted) return;
    this.halted = false;
    this.timer.reset();
    if (this.state === 'play' || this.state === 'over') this.audio.resume();
  }

  /** Один шаг симуляции (публичный — удобно для автотестов). */
  step(dt) {
    const input = this.input.update(dt);
    const { car, cam } = this;

    if (this.state === 'play' || this.state === 'over') {
      this.time += dt;
      if (this.net) this.net.update(dt);
      let inp = this.state !== 'play' ? STOP_INPUT : this.netPaused ? NO_INPUT : input;
      if (this.state === 'play') {
        if (this.countdown > 0) {
          this._countdown(dt);
          inp = NO_INPUT;
        } else {
          this.playTime += dt;
          this.maxSpeed = Math.max(this.maxSpeed, car.speed);
        }
      }
      // заезд кончился (финиш, поражение, авария) — соперники тоже останавливаются;
      // по сети — когда сервер объявил победителя (своя авария других не останавливает)
      const running = this.race.started && (this.net ? !this.net.result : this.state === 'play');
      const me = this.standings.find((e) => e.player);
      const ctx = { cars: this.cars, peds: this.peds, running, raceTime: this.race.clock, playerProgress: me ? me.progress : 0, myProgress: 0, shellSpeed: CANNON.speed };
      for (const r of this.rivals) {
        if (r.car.remote) continue; // ботов по сети ведёт хост
        const mine = this.standings.find((e) => e.rival === r);
        ctx.myProgress = mine ? mine.progress : 0;
        r.think(dt, ctx);
        if (r.inp.fire) this._fire(r.car);
      }
      if (this.state === 'play' && this.countdown <= 0 && inp.fire) this._fire(car);
      this._physics(dt, inp);
      this.artillery.update(dt);
      this.peds.update(dt, this.cars);
      this.breakables.update(dt);
      this.debris.update(dt);
      this.fx.update(dt);
      this.race.update(dt, car);
      for (const r of this.rivals) {
        if (!r.car.remote) this._rivalEvent(r, this.race.track(r.tr, r.car));
        r.updateTag(car);
      }
      for (const rc of this.remotes) rc.tag.update(car);
      this.carTag.update(car);
      this._updateStandings();
      this._checkAnnihilation();
      cam.update(dt, car);
      this._followSun(car.x, car.z);
      this.comboTimer = Math.max(0, this.comboTimer - dt);
      if (this.comboTimer === 0) this.combo = 0;
      this.hud.update(dt, this);
      if (this.state === 'over' && !this.wreckShown && this.time - this.wreckAt > 2.8) this._showWreck();
    } else if (this.state === 'menu') {
      this.time += dt;
      for (const r of this.rivals) r.think(dt, { cars: this.cars, running: false });
      this._physics(dt, NO_INPUT);
      for (const r of this.rivals) r.updateTag(car);
      this.carTag.update(car);
      this.peds.update(dt, this.cars);
      this.fx.update(dt);
      this.race.update(dt, car);
      cam.orbitUpdate(dt, 0, -20);
      this._followSun(0, -20);
    }
  }

  /** Выстрел своей машины или бота; по сети — всем остальным. */
  _fire(car) {
    const shot = this.artillery.fire(car);
    if (shot && this.net) this.net.sendFire(car, shot);
  }

  _countdown(dt) {
    const before = this.countdown;
    this.countdown = Math.max(0, this.countdown - dt);
    const n = Math.ceil(this.countdown);
    if (n < this.countShown) {
      this.countShown = n;
      this.hud.countdown(n > 0 ? String(n) : 'ГАЗУЙ!');
      this.audio.countdown(n);
    }
    if (before > 0 && this.countdown === 0) this.race.start();
  }

  render() {
    this.sky.position.copy(this.camera.position);
    const h = this.renderer.getDrawingBufferSize(this._dbs).y;
    const scale = h / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.fx.normal.material.uniforms.uScale.value = scale;
    this.fx.glow.material.uniforms.uScale.value = scale;
    this.renderer.render(this.scene, this.camera);
  }
}

const crash = new CrashReporter(version);
window.crash = crash;
try {
  const game = new Game();
  window.game = game;
  crash.getContext = () => game.debugState();
  crash.onContinue = () => game.resume();
  crash.onRestart = () => {
    game.halted = false;
    game.timer.reset();
    game.restart();
  };
  // пока окно открыто — игра на паузе
  crash.onOpenChange = (open) => {
    if (open && game.state === 'play') game._setPaused(true);
  };
  if (crash.previous?.entries?.some((e) => e.kind !== 'note' && e.kind !== 'console.error')) {
    document.getElementById('btn-prev-crash').classList.remove('hidden');
  }
} catch (err) {
  crash.report(err, 'запуск игры');
}
