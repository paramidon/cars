import * as THREE from 'three';
import './style.css';
import { QUALITY, IS_TOUCH, DEBUG, MUTE, TEST_MAP, PHYS_RAPIER } from './config.js';
import { Physics, initRapier, rapierStats } from './physics/rapier.js';
import { Vehicle } from './physics/vehicle.js';
import { buildCity } from './world/city.js';
import { Breakables } from './world/props.js';
import { FX } from './effects/fx.js';
import { Debris } from './effects/debris.js';
import { AudioFX } from './audio.js';
import { Car, sameTeam } from './car.js';
import { BotGunner } from './gunner.js';
import { Zone, spawnPoints, zoneCenter, roadPointNear } from './zone.js';
import { wrapAngle } from './utils.js';
import { Pedestrians } from './pedestrians.js';
import { Artillery, CANNON } from './cannon.js';
import { MachineGuns } from './mg.js';
import { Molotovs } from './molotov.js';
import { Input } from './input.js';
import { ChaseCamera } from './camera.js';
import { HUD } from './hud.js';
import { Race, RACE } from './race.js';
import { Rival, RIVALS, GRID, maxCars, gridPoint, collideCars, carHitDamage } from './racers.js';
import { CarTag } from './tag.js';
import { Netplay } from './net/netplay.js';
import { Lobby } from './net/lobby.js';
import { CrashReporter } from './crash.js';
import { Xray } from './xray.js';
import { phrase, seriesPhrase } from './words.js';
import { version } from '../package.json';

const $ = (id) => document.getElementById(id);
const NO_INPUT = { throttle: 0, brake: 0, steer: 0, handbrake: false, fire: false, aim: 0, aimDX: 0 };
const STOP_INPUT = { throttle: 0, brake: 0, steer: 0, handbrake: true, fire: false, aim: 0, aimDX: 0 };
// сколько корпуса чинит убийство: давить выгоднее, чем стрелять
const HEAL = { car: 6, gib: 8, crush: 8, explosion: 2, gun: 2 };
const WEAPON_NAME = { cannon: 'ПУШКА', mg: 'ПУЛЕМЁТ' };
const WRECK_HEAL = 15; // разбил машину тараном или из пушки — подлатался
const WRECK_CREDIT_MS = 4000; // чей последний удар был за столько мс до взрыва, тот и разбил
const COMBO_TIME = 4; // убийства не дальше стольких с друг от друга копят комбо
const GORE_WARN = [20, 30, 35]; // на скольких пешеходах предупредить, что соперник близок к победе
const BEST_KEY = 'cars-and-guts:best';
const WIN_BONUS = 3000;
const PLAYER_COLOR = '#e5262b';
const SHADOW_EXTENT = 60;
const SHADOW_MAP = 2048;
const SOLO_KEY = 'cars-and-guts:solo';
// автопилот моей машины, когда я сижу в пушке
const AUTOPILOT = { name: 'АВТОПИЛОТ', color: '#b3121a', aggr: 0.1, gore: 0.12, speed: 0.95, corner: 12, lane: 0 };
const AIM_MOUSE = 0.0032; // рад на пиксель мыши
const AIM_KEYS = 2.6; // рад/с — поворот башни клавишами и стиком
const AIM_DIST = 35; // м — прицел показывает, куда придёт снаряд на таком расстоянии
const _aimV = new THREE.Vector3();
const WIN_TEXT = { finish: 'ПОБЕДА! ПЕРВЫЙ!', annihilation: 'ВСЕ ТАЧКИ РАЗБИТЫ!', carnage: `${RACE.goreWin} ПЕШЕХОДОВ!` };
const LOSE_TEXT = {
  finish: (n) => `${n} финишировал первым`,
  annihilation: (n) => `${n} разбил всех`,
  carnage: (n) => `${n} первым набил ${RACE.goreWin} пешеходов`,
};

class Game {
  constructor() {
    // ------------------------------------------------------------ рендер
    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: QUALITY.antialias, powerPreference: 'high-performance', stencil: true }));
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
    this.test = TEST_MAP; // тестовый полигон: один, без соперников, трассы и условий победы
    this.city = buildCity(scene, QUALITY, TEST_MAP);
    this.xray = new Xray(renderer, scene);
    this.fx = new FX(scene, this.city.groundHeight, QUALITY);
    this.debris = new Debris(scene, this.city.groundHeight, this.city.world);
    this.audio = new AudioFX({ forceMute: MUTE });
    this.breakables = new Breakables(scene, this.city.world, this.city.props, this.city.groundHeight, this.debris, this.fx, this.audio, QUALITY);
    // ?phys=rapier: every car is a rigid body in a Rapier world (PHYSICS_PLAN.md)
    this.phys = PHYS_RAPIER ? new Physics(this.city.solids) : null;
    this.phys?.addProps(this.breakables.items);
    this.mainCar = new Car(scene, this.city, this.fx, this.audio, this.debris, QUALITY);
    this._addBody(this.mainCar);
    this.car = this.mainCar; // машина, в которой я сижу (по сети может быть чужая — если я в её пушке)
    this.carTag = new CarTag(scene, this.car);
    this.peds = new Pedestrians(scene, this.city, this.fx, this.audio, QUALITY);
    this.artillery = new Artillery(scene, this.city, this.fx, this.audio);
    this.mg = new MachineGuns(scene, this.city, this.fx, this.audio);
    this.molotovs = new Molotovs(scene, this.city, this.fx, this.audio);
    this.weapon = 'cannon'; // моё оружие: cannon | mg (у ботов — только пушка)
    this.race = new Race(scene, this.city, this.fx, this.audio);
    this.raceLaps = RACE.laps;
    this.allRivals = RIVALS.map((def, i) => new Rival(scene, this.city, this.fx, this.audio, this.debris, QUALITY, this.race, def, i));
    for (const r of this.allRivals) this._addBody(r.car);
    this.rivals = [...this.allRivals]; // боты в этом заезде
    this.quality = QUALITY;
    this.mode = 'classic'; // classic — пушка по курсу у водителя; crew — у каждой машины водитель и стрелок
    this.seat = 'driver'; // где сижу я: driver | gunner
    this.aimYaw = 0; // куда смотрит моя башня (мировой угол), когда я стрелок
    this.autoDriver = null; // бот за рулём моей машины, когда я в пушке
    this.solo = this._loadSolo();
    this.zone = new Zone(scene); // королевская битва: смертельная зона
    this.royale = false;
    this.net = null; // сетевой заезд (Netplay) или null
    this.netPool = new Map(); // машины людей по сети — живут между заездами
    this.remotes = []; // { car, tag } людей в текущем сетевом заезде
    this.dummies = []; // extra Rapier cars driving in circles — addPhysDummies(), for measuring the physics cost
    this.setCars([this.car, ...this.rivals.map((r) => r.car)]);
    this.artillery.peds = this.peds;
    this.artillery.breakables = this.breakables;
    this.artillery.phys = this.mg.phys = this.phys;
    this.artillery.listener = this.car;
    this.mg.peds = this.peds;
    this.molotovs.listener = this.car;
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
    // на полигоне и в меню на фоне — одна моя машина; on Rapier the city's menu also starts from the solo lineup
    // (the unused rivals' bodies leave the world instead of piling up on the grid)
    if (this.test || this.phys) this._resetWorld();

    this.state = 'menu';
    this.soundOpen = null; // 'menu' | 'pause' — откуда открыли настройки звука
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
    document.body.classList.toggle('test', this.test);
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

  /** On Rapier: give the car a rigid body (standing where the car is). */
  _addBody(car) {
    if (!this.phys) return;
    car.rb = new Vehicle(this.phys, car);
    car.rb.place(car.x, car.y, car.z, car.yaw);
  }

  /** Все машины заезда: первая — своя. */
  setCars(list) {
    this.cars = list;
    this.artillery.cars = list;
    this.molotovs.cars = list;
  }

  _resetStats() {
    this.score = 0;
    this.kills = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.bestCombo = 0;
    this.lastKill = -10;
    this.playTime = 0;
    this.maxSpeed = 0;
    this.critWarned = false;
    this.wreckShown = false;
  }

  // ------------------------------------------------------------ связи между системами
  _wire() {
    const { peds, cam, input } = this;
    this._bindCar(this.mainCar);
    this.race.onEvent = (type, data) => this._raceEvent(type, data);
    for (const r of this.allRivals) this._bindCar(r.car);
    this._onCarHit = (a, b, impact, px, pz, nx, nz) => this._carHit(a, b, impact, px, pz, nx, nz);
    if (this.phys) this.phys.onCarHit = this._onCarHit; // on Rapier the engine itself pushes cars apart
    peds.onKill = (p, cause, speed) => this._kill(p, cause, speed);
    peds.onEvent = (type, p) => this._pedEvent(type, p);
    this.artillery.onCarHit = (victim, shooter, dmg, direct, local) => this._shellHit(victim, shooter, dmg, direct, local);
    this.mg.onCarHit = (victim, shooter, dmg, x, z, dx, dz) => this._bulletHit(victim, shooter, dmg, x, z, dx, dz);
    // пешеход бросил коктейль (считает толпу хост — он и рассылает бросок); урон машине — её владельцу
    peds.onThrow = (...v) => {
      if (this.state === 'menu') return; // в заставке меню не кидаются
      this.molotovs.throw(...v);
      this.net?.sendMolotov(v);
    };
    this.molotovs.onCarHit = (car, dmg, x, z, vx, vz) => {
      const l = Math.hypot(vx, vz) || 1;
      car.applyDamage(dmg, x, z, vx / l, vz / l);
      if (car === this.car && this.state === 'play') {
        this.hud.popup(`${phrase('molotov')} −${dmg}`, 'warn');
        this.cam.shake(0.3);
      }
    };
    this.artillery.onBlast = (x, z, shooter) => {
      const car = this.car;
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
    for (const seg of document.querySelectorAll('#solo-setup .seg')) {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]');
        if (!b) return;
        e.preventDefault();
        const key = seg.dataset.key;
        this.solo[key] = key === 'bots' ? Number(b.dataset.v) : b.dataset.v;
        this._saveSolo();
      });
    }
    this._syncSoloUI();
    click('btn-resume', () => this._setPaused(false));
    click('btn-restart', () => this._again());
    click('btn-net', () => this.lobby.open());
    // полигон ⇄ город: другая карта строится при запуске, поэтому — перезагрузка с ?map=test или без
    $('btn-map').textContent = this.test ? 'В ГОРОД' : 'ТЕСТОВЫЙ ПОЛИГОН';
    click('btn-map', () => {
      const q = new URLSearchParams(location.search);
      if (this.test) q.delete('map');
      else q.set('map', 'test');
      const qs = q.toString();
      location.href = location.pathname + (qs ? `?${qs}` : '') + location.hash;
    });
    click('btn-net-leave', () => this.lobby.leaveRoom());
    click('btn-net-leave2', () => this.lobby.leaveRoom());
    click('btn-net-lobby', () => this.net?.toLobby());
    click('btn-restart2', () => this.restart());
    click('btn-menu', () => this.toMenu());
    click('btn-menu2', () => this.toMenu());
    click('btn-sound', () => this._openSound());
    click('btn-sound2', () => this._openSound());
    click('btn-sound-done', () => this._closeSound());
    for (const el of document.querySelectorAll('#sound input[type=range]')) {
      el.addEventListener('input', () => {
        this.audio.init();
        this.audio.setVolume(el.dataset.bus, el.value / 100);
        this._syncSoundUI();
        this.audio.preview(el.dataset.bus);
      });
    }
    $('snd-mute').addEventListener('change', (e) => {
      this.audio.init();
      this.audio.setMuted(e.target.checked);
      this._syncSoundUI();
    });
    this._syncSoundUI();
    click('btn-unstuck', () => {
      this._unstuck();
      this._setPaused(false);
    });
    click('btn-log', () => crash.open());
    click('btn-prev-crash', () => crash.open(true));
    click('btn-cam', () => this._action('camera'));
    $('btn-weapon').addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this._action('weapon');
    });
    click('btn-mute', () => this._action('mute'));
    click('btn-pause', () => this._action('pause'));
    document.addEventListener('visibilitychange', () => {
      this.lastVisibilityChange = performance.now();
      if (document.hidden && this.state === 'play' && !this.net) this._setPaused(true);
      if (document.hidden) this.audio.suspend();
      else if (!this.halted) this.audio.resume();
    });
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      crash.report({ message: 'Потерян контекст WebGL: браузер сбросил графику (часто из-за нехватки памяти на телефоне).', stack: '' }, 'webglcontextlost');
    });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => crash.note('Контекст WebGL восстановлен'));
  }

  _action(a) {
    switch (a) {
      case 'weapon1':
      case 'weapon2':
      case 'weapon':
        this._setWeapon(a === 'weapon1' ? 'cannon' : a === 'weapon2' ? 'mg' : this.weapon === 'mg' ? 'cannon' : 'mg');
        break;
      case 'camera':
        this.cam.next();
        this.hud.popup(`Камера: ${this.cam.modeName}`, 'info');
        break;
      case 'mute':
        this.audio.setMuted(!this.audio.muted);
        this._syncSoundUI();
        break;
      case 'pause':
        if (this.soundOpen) this._closeSound();
        else if (this.net) this._setPaused(!this.netPaused);
        else if (this.state === 'play') this._setPaused(true);
        else if (this.state === 'pause') this._setPaused(false);
        break;
      case 'respawn':
        if (this.state === 'play') this._unstuck();
        else if (this.state === 'over' && this.wreckShown) this._again();
        break;
      case 'confirm':
        if (this.soundOpen) this._closeSound();
        else if (this.state === 'menu' && !this.lobby.visible) this.start();
        else if (this.state === 'over' && this.wreckShown) this._again();
        else if (this.state === 'pause' || this.netPaused) this._setPaused(false);
        break;
    }
  }

  /** Обработчики машины: что делать при ударе, уроне, взрыве — своей (в которой сижу) или чужой. */
  _bindCar(car) {
    car.onBreakable = (c, car_) => this.breakables.hit(c.prop, car_);
    car.onImpact = (impact, px, pz) => {
      const mine = car === this.car;
      if (impact > 6) this.peds.alert(px, pz, mine ? 22 : 18);
      if (!mine) return;
      this.cam.shake(Math.min(0.85, impact / 22));
      if (impact > 20 && !car.wrecked) this.hud.popup(phrase('crash'), 'warn');
    };
    car.onDamage = (dmg) => {
      if (car === this.car) this._myDamage(dmg);
    };
    car.onWrecked = () => (car === this.car ? this._myWreck() : this._carWrecked(car));
    car.onRight = () => {
      if (car === this.car && this.state === 'play') this.hud.popup('НА КОЛЁСА!', 'info');
    };
  }

  _myDamage(dmg) {
    this.hud.damageFlash(Math.min(0.85, 0.2 + dmg / 30));
    if (this.car.health < 25 && this.car.health > 0 && !this.critWarned) {
      this.critWarned = true;
      this.hud.popup('КОРПУС КРИТИЧЕН!', 'warn');
    }
  }

  _myWreck() {
    const car = this.car;
    this._wreckedBy(car)?.heal(WRECK_HEAL);
    this.peds.explosion(car.x, car.z, 11, car);
    this.cam.shake(1);
    this.hud.damageFlash(1);
    this.hud.popup('ТАЧКА РАЗБИТА!', 'big warn');
    this._gameOver('wreck');
  }

  // ------------------------------------------------------------ кто где сидит
  _loadSolo() {
    const def = { game: 'race', mode: 'classic', seat: 'driver', bots: 4 };
    try {
      return { ...def, ...JSON.parse(localStorage.getItem(SOLO_KEY)) };
    } catch {
      return def;
    }
  }

  _saveSolo() {
    try {
      localStorage.setItem(SOLO_KEY, JSON.stringify(this.solo));
    } catch {
      // не страшно
    }
    this._syncSoloUI();
  }

  _syncSoloUI() {
    for (const seg of document.querySelectorAll('#solo-setup .seg')) {
      const key = seg.dataset.key;
      const v = key === 'bots' ? Math.min(this.solo.bots, maxCars(this.solo.game) - 1) : this.solo[key];
      for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === String(v));
    }
    $('solo-setup').classList.toggle('crew', this.solo.mode === 'crew');
    $('solo-setup').classList.toggle('royale', this.solo.game === 'royale');
  }

  /** Расстановка для игры одному: моя машина и боты по настройкам меню. */
  _soloLineup() {
    const { mode, bots, game } = this.test ? { mode: 'classic', bots: 0, game: 'race' } : this.solo;
    const crew = mode === 'crew';
    const seat = crew ? this.solo.seat : 'driver';
    const car = this.mainCar;
    car.crew = { driver: seat === 'driver' ? 'me' : 'bot', gunner: crew ? (seat === 'gunner' ? 'me' : 'bot') : null };
    car.team = null;
    car.remote = false;
    car.netId = undefined;
    car.name = 'ТЫ';
    const rivals = this.test ? [] : this.allRivals.slice(0, Math.max(1, Math.min(maxCars(game) - 1, bots)));
    for (const r of rivals) {
      r.car.crew = { driver: 'bot', gunner: crew ? 'bot' : null };
      r.car.team = null;
      r.car.remote = false;
    }
    return { car, seat, mode, game, rivals, others: [] };
  }

  /**
   * Состав заезда: car — машина, где сижу я (seat — за рулём или в пушке); rivals — боты; others — машины
   * людей по сети. У каждой машины car.crew = { driver, gunner }: 'me', 'bot', id игрока или null (нет пушки).
   */
  applyLineup({ car, seat, mode, game = 'race', rivals, others = [] }) {
    this.mode = mode;
    this.seat = seat;
    // королевская битва: трассы и таймера нет, есть сжимающаяся зона
    this.royale = game === 'royale';
    this.race.enabled = !this.royale && !this.test;
    document.body.classList.toggle('royale', this.royale);
    for (const r of rivals) r.setZone(this.royale ? this.zone : null);
    for (const r of this.allRivals) {
      const on = rivals.includes(r);
      r.car.root.visible = on;
      if (r.tag) r.tag.sprite.visible = on;
      if (!on) r.car.x = r.car.z = 1e5; // не участвует — подальше от пешеходов и столкновений
      r.car.rb?.setActive(on);
    }
    this.rivals = rivals;
    const mainUsed = car === this.mainCar || others.includes(this.mainCar);
    this.mainCar.root.visible = mainUsed;
    if (!mainUsed) this.mainCar.x = this.mainCar.z = 1e5;
    this.mainCar.rb?.setActive(mainUsed);
    this.car = car;
    car.root.visible = true;
    this.carTag.car = car;
    this.setCars([car, ...others.filter((c) => c !== car), ...rivals.map((r) => r.car)]);
    for (const c of this.cars) {
      c.isPlayer = c === car; // звук мотора, перезарядка как у человека
      c.listener = c === car ? null : car;
      // on Rapier: a car another computer drives is a ghost following its snapshots
      c.rb?.setActive(true);
      c.rb?.setRemote(!!c.remote);
    }
    this.artillery.listener = car;
    this.molotovs.listener = car;
    this.input.gunner = seat === 'gunner';
    document.body.classList.toggle('gunner', seat === 'gunner');
    this.autoDriver = seat === 'gunner' && !car.remote && car.crew?.driver === 'bot'
      ? new Rival(this.scene, this.city, this.fx, this.audio, this.debris, QUALITY, this.race, AUTOPILOT, 0, car)
      : null;
    this.autoDriver?.setZone(this.royale ? this.zone : null);
    for (const c of this.cars) {
      c.botGunner = mode === 'crew' && c.crew?.gunner === 'bot' && !c.remote ? new BotGunner(c, this.city.world, c.ai ? c.ai.def.gore : 0.4) : null;
    }
  }

  /** Очки и сбитые — мои или всей команды (по сети). */
  teamScore() {
    return this.score + (this.net ? this.net.teamStat('score') : 0);
  }

  teamKills() {
    return this.kills + (this.net ? this.net.teamStat('kills') : 0);
  }

  /** Стрелок: повернуть башню мышью / клавишами / стиком; мировой угол держится, как бы машина ни крутилась. */
  _aim(dt, inp) {
    const car = this.car;
    if (car.wrecked) return;
    this.aimYaw = wrapAngle(this.aimYaw - inp.aimDX * AIM_MOUSE - inp.aim * AIM_KEYS * dt);
    car.turretYaw = car.turretToward(this.aimYaw);
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
    // (кроме машины, в пушке которой сижу я: мои снаряды — мои очки)
    if (killer.remote && killer !== this.car) return;
    if (!killer.wrecked) killer.kills++;
    if (killer !== this.car) {
      // сбил соперник: очков игроку нет, соперник подлатывается и приближается к победе мясника
      killer.heal(HEAL[cause] || 0);
      this._rivalGore(killer);
      return;
    }
    this.kills++;
    const t = this.time;
    this.combo = t - this.lastKill < COMBO_TIME ? this.combo + 1 : 1;
    this.lastKill = t;
    this.comboTimer = COMBO_TIME;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    const base = { car: 100, gib: 150, crush: 100, gun: 75, explosion: 120 }[cause] ?? 100;
    const cls = cause === 'gib' || cause === 'explosion' ? 'big' : '';
    const pts = base * this.combo;
    this.score += pts;
    this.hud.popup(`${phrase(cause)} +${pts}`, cls);
    if (this.combo >= 2) this.hud.popup(seriesPhrase(this.combo), this.combo >= 4 ? 'gold big' : 'gold');
    if ((cause === 'car' || cause === 'gib') && speed > 13 && this.cam.mode !== 2) this.hud.splatter(Math.min(1.5, speed / 22));
    if (cause === 'car' || cause === 'gib' || cause === 'crush') this.cam.shake(0.12 + speed * 0.006);
    const added = this.state === 'play' ? this.race.addTime(RACE.killTime[cause] || 0) : 0;
    if (added > 0) this.hud.timeBonus(added);
    const healed = this.car.heal(HEAL[cause] || 0);
    if (healed > 0) {
      this.hud.heal(Math.round(healed));
      if (this.car.health > 40) this.critWarned = false;
    }
    if (this.state === 'play' && !this.test && !this.car.wrecked && this.teamKills() >= RACE.goreWin) this._victory('carnage', this.car);
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
    // выиграл я, мой экипаж или моя команда
    if (car === this.car || (car && sameTeam(car, this.car))) {
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
    this.winReason = this.royale && kind === 'annihilation' ? `${name} — последний выживший` : LOSE_TEXT[kind](name);
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

  /**
   * slots — места по сети { netId: номер в GRID } (в королевской битве — точки { x, z, yaw }); без них — случайно.
   * zoneAt — центр зоны { cx, cz } (королевская битва по сети: его выбирает хост).
   */
  restart(slots = null, zoneAt = null) {
    this.audio.init();
    this.audio.resume();
    this._resetWorld(slots, zoneAt);
    this.cam.snap(this.car);
    this.state = 'play';
    this.countdown = this.test ? 0 : RACE.countdown; // на полигоне — без отсчёта
    if (this.test) this.race.start();
    this.countShown = Infinity;
    this.netPaused = false;
    this._hideScreens();
    document.body.classList.toggle('net', !!this.net);
    this.hud.show(true);
    this._syncTouchUI();
  }

  /** Бросить заезд и вернуться в главное меню (город с машинами на старте крутится на фоне). */
  toMenu() {
    this._resetWorld();
    this.state = 'menu';
    this.countdown = 0;
    this._hideScreens();
    $('menu').classList.remove('hidden');
    this.hud.show(false);
    this.audio.setEngineOn(false);
    this.audio.resume();
    this.timer.reset();
    this._syncTouchUI();
  }

  _resetWorld(slots = null, zoneAt = null) {
    this.fx.clear();
    this.artillery.clear();
    this.mg.clear();
    this.molotovs.clear();
    this.winner = null;
    this.winReason = '';
    this.overKind = null;
    this.debris.clear();
    this.breakables.reset();
    if (!this.net) this.applyLineup(this._soloLineup());
    for (const c of this.cars) Object.assign(c, { mgHeat: 0, mgLock: false, mgCD: 0, mgFiring: false, mgVisual: false, mgTarget: null });
    // места на старте — каждый заезд случайно: в гонке — на решётке, в битве — вразброс по городу
    let pointOf;
    if (this.royale) {
      const pts = slots ? null : spawnPoints(this.city, this.cars.length);
      pointOf = (c) => (slots ? slots[c.netId] : pts[this.cars.indexOf(c)]) || this.city.spawn;
    } else if (slots) pointOf = (c) => gridPoint(this.city, GRID[slots[c.netId] ?? 0]);
    else {
      const free = GRID.slice(0, this.cars.length);
      for (let i = free.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [free[i], free[j]] = [free[j], free[i]];
      }
      pointOf = (c) => gridPoint(this.city, free[this.cars.indexOf(c)]);
    }
    this.startPoint = pointOf(this.car);
    this.race.reset();
    for (const c of this.cars) {
      if (c.ai) c.ai.reset(pointOf(c));
      else c.reset(pointOf(c));
    }
    if (this.royale) {
      const zc = zoneAt || zoneCenter(this.city);
      this.zone.start(zc.cx, zc.cz, this.city);
    } else this.zone.stop();
    this.zoneHurtT = 0;
    this.autoDriver?._clear();
    this.aimYaw = this.car.yaw;
    this.peds.reset(this.cars);
    this._resetStats();
    this.hud.reset();
  }

  _hideScreens() {
    for (const id of ['menu', 'pause', 'wreck', 'sound']) $(id).classList.add('hidden');
    this.soundOpen = null;
  }

  // ------------------------------------------------------------ настройки звука
  _openSound() {
    // клик по кнопке — жест пользователя, можно завести звук и сразу дать послушать громкость
    this.audio.init();
    this.soundOpen = this.state === 'menu' ? 'menu' : 'pause';
    $(this.soundOpen).classList.add('hidden');
    $('sound').classList.remove('hidden');
    this._syncSoundUI();
  }

  _closeSound() {
    if (!this.soundOpen) return;
    $('sound').classList.add('hidden');
    $(this.soundOpen).classList.remove('hidden');
    this.soundOpen = null;
  }

  _syncSoundUI() {
    const s = this.audio.settings;
    for (const bus of ['master', 'engine', 'sfx']) {
      const v = Math.round(s[bus] * 100);
      const el = $(`vol-${bus}`);
      if (Number(el.value) !== v) el.value = v;
      $(`vol-${bus}-v`).textContent = `${v}%`;
    }
    $('snd-mute').checked = s.muted;
    $('sound').querySelector('.sound-set').classList.toggle('off', s.muted);
    $('btn-mute').classList.toggle('off', s.muted);
  }

  /** Начать сетевой заезд (из лобби, по сообщению сервера start); resume — вернулся посреди заезда. */
  startNet(client, room, slots, resume = null, zoneAt = null) {
    if (this.net) this.net.dispose();
    this.net = new Netplay(this, client, room);
    this.restart(slots, zoneAt);
    if (resume) this.net.resume(resume);
  }

  /** Выйти из сетевой игры: машины — как для одиночной, игра — в меню. */
  endNet() {
    if (!this.net) return;
    this.net.dispose();
    this.net = null;
    this.mainCar.setColor('#b3121a');
    this.restart();
    this.state = 'menu';
    this.hud.show(false);
    this._syncTouchUI();
  }

  _setPaused(p) {
    if (this.net) {
      // по сети мир не останавливается — только меню поверх
      this.netPaused = p && (this.state === 'play' || this.state === 'over');
      if (this.netPaused) document.exitPointerLock?.();
      $('pause').classList.toggle('hidden', !this.netPaused);
      return;
    }
    if (p && this.state === 'play') {
      this.state = 'pause';
      document.exitPointerLock?.();
      $('pause').classList.remove('hidden');
      this.audio.setEngineOn(false); // контекст не глушим — в паузе можно крутить громкость
    } else if (!p && this.state === 'pause') {
      this.state = 'play';
      this._hideScreens();
      this.audio.resume();
      this.timer.reset();
    }
    this._syncTouchUI();
  }

  _unstuck() {
    const car = this.car;
    if (car.wrecked || car.remote) return; // за рулём не я — переставлять машину не мне
    if (car.rb?.tipped) {
      // on its side or roof: back onto the wheels where it lies
      car.rb.right();
      return;
    }
    // в заезде — к последнему пройденному чекпоинту, лицом по маршруту; в битве — на дорогу внутри зоны
    const z = this.zone;
    car.teleport(this.royale ? roadPointNear(this.city, z.cx, z.cz, Math.max(12, z.radius * 0.6)) : this.race.respawnPoint(undefined, this.startPoint));
    this.cam.snap(car);
    this.hud.popup(this.royale ? 'В ЗОНУ' : this.test ? 'НА СТАРТ' : 'К ЧЕКПОИНТУ', 'info');
  }

  /** Королевская битва: сжать зону; снаружи свои машины (их считаю я) теряют корпус, разбитые — без виноватых. */
  _zoneTick(dt) {
    const z = this.zone;
    // битва окончена (победа/поражение, не просто мой вылет) — зона замирает и больше не бьёт
    if (this.winner || (this.state === 'over' && this.overKind !== 'wreck')) return;
    z.update(this.race.clock);
    if (!this.race.started) return;
    const dmg = z.dps * dt;
    this.zoneHurtT -= dt;
    for (const c of this.cars) {
      if (c.remote || c.wrecked || !z.outside(c.x, c.z)) continue;
      c.health = Math.max(0, c.health - dmg);
      if (c === this.car && this.zoneHurtT <= 0) {
        this.zoneHurtT = 0.7;
        this.hud.damageFlash(0.3);
        if (!this.zoneWarnT || this.time - this.zoneWarnT > 3) {
          this.zoneWarnT = this.time;
          this.hud.popup('ВНЕ ЗОНЫ! КОРПУС ТАЕТ', 'warn');
        }
      }
      if (c.health <= 0) {
        c.lastAttacker = null;
        c.explode();
      }
    }
  }

  _syncTouchUI() {
    const show = (IS_TOUCH || this.input.usingTouch) && this.state === 'play';
    $('touch').classList.toggle('hidden', !show);
  }

  _gameOver(kind) {
    if (this.state !== 'play') return;
    this.state = 'over';
    document.exitPointerLock?.();
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
      annihilation: this.royale ? 'ПОБЕДА! ПОСЛЕДНИЙ ВЫЖИВШИЙ' : 'ПОБЕДА! ВСЕ ТАЧКИ РАЗБИТЫ',
      carnage: `ПОБЕДА! ${RACE.goreWin} ПЕШЕХОДОВ`,
    };
    const title = $('result-title');
    title.textContent = titles[this.overKind] || 'КОНЕЦ';
    title.className = won ? 'gold' : 'red';
    const why = { lost: this.winReason }[this.overKind] || '';
    const laps = this.overKind === 'finish' ? `${RACE.laps}/${RACE.laps}` : `${race.lap - 1}/${RACE.laps}`;
    const best = race.lapTimes.length ? fmt(Math.min(...race.lapTimes)) : '—';
    let rows = [
      ['Итог', won ? 'победа' : why || 'проигрыш'],
      ['Соперников разбито', `${this._enemies().filter((c) => c.wrecked).length} из ${this._enemies().length}`],
      ['Очки', this.score.toLocaleString('ru-RU')],
      ...(this.teamScore() !== this.score ? [['Очки команды', this.teamScore().toLocaleString('ru-RU')]] : []),
      ['Кругов пройдено', laps],
      ['Время заезда', fmt(race.elapsed)],
      ['Лучший круг', best],
      ['Сбито пешеходов', `${this.teamKills()} из ${RACE.goreWin}`],
      ['Лучшее комбо', `×${this.bestCombo}`],
      ['Макс. скорость', `${Math.round(this.maxSpeed * 3.6)} км/ч`],
    ];
    if (this.overKind === 'finish') rows.splice(3, 0, ['Рекорд трассы', this.newRecord ? 'НОВЫЙ!' : fmt(this.best.time)]);
    if (this.royale) {
      // в битве нет кругов и таймера — вместо них место и сколько продержался
      const place = 1 + this._enemies().filter((c) => !c.wrecked).length;
      rows = rows.filter(([k]) => !['Кругов пройдено', 'Время заезда', 'Лучший круг'].includes(k));
      rows.splice(1, 0, ['Место', `${won ? 1 : place} из ${this.cars.length}`], ['Продержался', fmt(race.clock)]);
    }
    if (this.test) {
      // на полигоне ни соперников, ни трассы, ни победы
      rows = rows.filter(([k]) => !['Итог', 'Соперников разбито', 'Кругов пройдено', 'Время заезда', 'Лучший круг', 'Сбито пешеходов'].includes(k));
      rows.splice(1, 0, ['Сбито пешеходов', this.kills], ['Продержался', fmt(race.clock)]);
    }
    const table = this.standings
      .map((e, i) => {
        const st = this.royale ? (e.car.wrecked ? 'разбит' : 'жив') : e.finished ? `финиш ${fmt(e.time)}` : e.car.wrecked ? 'разбит' : `круг ${Math.min(e.lap, RACE.laps)}`;
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
  /** Все чужие машины: не я и не мои по команде. */
  _enemies() {
    return this.cars.filter((c) => c !== this.car && !sameTeam(c, this.car));
  }

  _carHit(a, b, impact, px, pz, nx, nz) {
    const player = this.car;
    const friends = sameTeam(a, b); // своих не бьём — только толкаемся
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
    const da = friends ? 0 : carHitDamage(a, b, impact, px, pz);
    const db = friends ? 0 : carHitDamage(b, a, impact, px, pz);
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

  /**
   * Урон victim от тарана by: своим машинам — сразу, чужой по сети — событием её владельцу. On Rapier the event also
   * carries the knock: what this computer's solver did to the victim's ghost (Vehicle.netKnock), even with no damage.
   */
  _ramDamage(victim, by, dmg, px, pz, nx, nz, now) {
    if (by.remote) return;
    if (victim.remote) {
      const k = victim.rb && victim.rb.knockV.length() + victim.rb.knockW.length() > 0.3 ? victim.rb : null;
      if (dmg > 0 || k) this.net.sendHit(victim, by, Math.max(0, dmg), px, pz, nx, nz, k);
      return;
    }
    if (dmg <= 0) return;
    victim.lastAttacker = by;
    victim.lastAttackAt = now;
    victim.applyDamage(dmg, px, pz, nx, nz);
  }

  /** Снаряд попал в машину. */
  /** local — снаряд выпущен с этого компьютера (выстрел напарника по сети очков мне не даёт). */
  _shellHit(victim, shooter, dmg, direct, local = true) {
    const player = this.car;
    if (this.state !== 'play') return;
    if (shooter === player && local && victim !== player && dmg >= 3) {
      this.score += Math.round(dmg) * 10;
      this.hud.popup(`${phrase(direct ? 'shell' : 'splash')} −${Math.round(dmg)}`, 'gold');
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
    const left = this._enemies().filter((o) => !o.wrecked).length;
    if (left > 0) this.hud.popup(`ОСТАЛОСЬ ВРАГОВ: ${left}`, 'warn');
  }

  /** Все остальные машины разбиты — победа. */
  _checkAnnihilation() {
    const enemies = this._enemies();
    if (this.state !== 'play' || this.car.wrecked || !enemies.length || !enemies.every((c) => c.wrecked)) return;
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
      // битва: живые выше (больше сбил — выше), разбитые — кто дольше продержался
      if (this.royale) e.progress = e.car.wrecked ? -1e6 - e.car.wreckTime : e.car.kills;
      else if (e.finished) e.progress = 1e6 - e.place;
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
    const sub = (h) => {
      if (!cars[0].remote) cars[0].physicsStep(h, playerInp); // в пушке чужой машины — её ведёт хозяин
      for (const r of this.rivals) if (!r.car.remote) r.car.physicsStep(h, r.inp);
      for (const c of this.dummies) c.physicsStep(h, c.dummyInp);
      if (!this.phys) collideCars(cars, this._onCarHit);
    };
    if (this.phys) this.phys.step(dt, sub); // Rapier: fixed steps, the pose is interpolated in postUpdate
    else {
      const n = Math.max(1, Math.ceil(dt / (1 / 120)));
      for (let i = 0; i < n; i++) sub(dt / n);
    }
    for (const c of this.dummies) c.postUpdate(dt, c.dummyInp);
    cars[0].postUpdate(dt, playerInp);
    for (const r of this.rivals) r.car.postUpdate(dt, r.inp);
    for (const rc of this.remotes) if (rc.car !== cars[0]) rc.car.postUpdate(dt, NO_INPUT);
  }

  /** Debug (?phys=rapier&map=test): n more cars on Rapier driving in circles on the test ground's open asphalt. */
  addPhysDummies(n) {
    if (!this.phys || !this.test) return 0;
    for (let i = 0; i < n; i++) {
      const k = this.dummies.length;
      const c = new Car(this.scene, this.city, this.fx, this.audio, this.debris, QUALITY, { isPlayer: false, wing: true, color: '#3a7bd5', number: k + 2 });
      c.rb = new Vehicle(this.phys, c);
      c.reset({ x: -90 + (k % 5) * 30, z: 100 + Math.floor(k / 5) * 22, yaw: (k * 1.3) % (Math.PI * 2) });
      c.dummyInp = { throttle: 0.7, brake: 0, steer: k % 2 ? 0.5 : -0.5, handbrake: false };
      this.dummies.push(c);
    }
    return this.dummies.length;
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
      map: this.test ? 'test' : 'city',
      phys: this.phys
        ? {
          y: r1(car.y), up: Math.round(car.upY * 100) / 100, vy: r1(car.vy || 0), wheels: car.rb?.contacts,
          righting: !!car.rb?.righting, stepMs: Math.round(this.phys.stepMs * 1000) / 1000, steps: this.phys.steps,
          bodies: this.phys.vehicles.length, initMs: Math.round(rapierStats.initMs),
        }
        : null,
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
      // после timer.reset() метка кадра бывает чуть раньше сброса — шаг не должен быть отрицательным
      const dt = Math.min(Math.max(0, this.timer.getDelta()), 1 / 20);
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
    const input = this.input.update();
    const { car, cam } = this;
    this.audio.setEngineOn(this.state === 'play');

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
        if (r.inp.fire && this.mode !== 'crew') this._fire(r.car); // в «экипаже» стреляет бот в башне
      }
      // руль: сам, автопилот (я в пушке) или никто (машину ведёт хозяин по сети)
      let drive = this.seat === 'driver' ? inp : NO_INPUT;
      if (this.autoDriver) {
        ctx.myProgress = ctx.playerProgress;
        drive = this.state !== 'play' ? STOP_INPUT : this.countdown > 0 ? NO_INPUT : this.autoDriver.think(dt, ctx);
      }
      // пушки
      const canShoot = this.state === 'play' && this.countdown <= 0 && !this.netPaused;
      const myGun = this.seat === 'gunner' || this.mode !== 'crew'; // стреляю я (в классике — водитель)
      if (this.seat === 'gunner' && this.state === 'play') this._aim(dt, inp);
      // классика: с пулемётом башня сама доворачивает на цель, с пушкой смотрит вперёд
      if (this.seat === 'driver' && this.mode !== 'crew' && !car.remote) this.mg.autoAim(car, this.cars, dt, this.weapon === 'mg');
      car.mgFiring = false;
      if (myGun) {
        const mg = this.weapon === 'mg';
        car.mgFiring = this.mg.update(car, dt, mg && canShoot && inp.fire, this.cars);
        if (!mg && canShoot && inp.fire) this._fire(car);
      }
      // чужие очереди по сети — только трассеры и звук (пули считает стрелок)
      for (const c of this.cars) if (c.mgVisual && !(c === car && myGun)) this.mg.update(c, dt, true, this.cars, false);
      if (this.mode === 'crew' && running) {
        const gctx = { cars: this.cars, peds: this.peds, shellSpeed: CANNON.speed };
        for (const c of this.cars) if (c.botGunner && c.botGunner.update(dt, gctx)) this._fire(c);
      }
      this._physics(dt, drive);
      if (this.net) this.net.send(dt);
      this.artillery.update(dt);
      this.mg.tick(dt);
      this.molotovs.update(dt);
      this.peds.update(dt, this.cars);
      this.breakables.update(dt);
      this.debris.update(dt);
      this.fx.update(dt);
      this.race.update(dt, car);
      if (this.royale) this._zoneTick(dt);
      for (const r of this.rivals) {
        if (!r.car.remote) this._rivalEvent(r, this.race.track(r.tr, r.car));
        r.updateTag(car);
      }
      if (this.autoDriver) this.race.track(this.autoDriver.tr, car); // автопилоту — свой счётчик ворот (куда вернуть)
      for (const rc of this.remotes) {
        if (rc.car === car) rc.tag.sprite.visible = false; // над своей машиной — своя полоска
        else rc.tag.update(car);
      }
      this.carTag.weapon = this.seat === 'gunner' || this.mode !== 'crew' ? this.weaponInfo() : null;
      this.carTag.update(car);
      this._updateStandings();
      this._checkAnnihilation();
      cam.update(dt, car, this.seat === 'gunner' && !car.wrecked ? this.aimYaw : null, input.lookBack && this.state === 'play' && !car.wrecked);
      this._followSun(car.x, car.z);
      this.comboTimer = Math.max(0, this.comboTimer - dt);
      if (this.comboTimer === 0) this.combo = 0;
      this.hud.update(dt, this);
      if (this.state === 'over' && !this.wreckShown && this.time - this.wreckAt > 2.8) this._showWreck();
    } else if (this.state === 'menu') {
      this.time += dt;
      if (this.zone.active) this.zone.stop();
      for (const r of this.rivals) r.think(dt, { cars: this.cars, running: false });
      this._physics(dt, NO_INPUT);
      // в меню машина стоит — мотор и визг шин молчат
      this.audio.engine(0, 0, false);
      this.audio.skid(0);
      for (const r of this.rivals) r.updateTag(car);
      this.carTag.update(car);
      this.peds.update(dt, this.cars);
      this.fx.update(dt);
      this.race.update(dt, car);
      cam.orbitUpdate(dt, 0, -20);
      this._followSun(0, -20);
    }
  }

  /** Сменить своё оружие (активно только одно). */
  _setWeapon(w) {
    if (w === this.weapon) return;
    this.weapon = w;
    if (this.state === 'play') this.hud.popup(WEAPON_NAME[w], 'info');
  }

  /** Состояние моего оружия для HUD: p — готовность 0…1 (у пулемёта — сколько осталось до перегрева). */
  weaponInfo() {
    const car = this.car;
    if (this.weapon === 'mg') return { name: WEAPON_NAME.mg, p: 1 - (car.mgHeat || 0), ready: !car.mgLock, hot: !!car.mgLock };
    return { name: WEAPON_NAME.cannon, p: 1 - Math.min(1, car.reload / this.reloadTime), ready: car.reload <= 0, hot: false };
  }

  /** Моя пуля попала в машину: урон считаю я; машину другого игрока (или бота хоста) — пусть посчитает он. */
  _bulletHit(victim, shooter, dmg, x, z, dx, dz) {
    if (victim.remote) this.net?.sendHit(victim, shooter, dmg, x, z, dx, dz);
    else {
      victim.lastAttacker = shooter;
      victim.lastAttackAt = performance.now();
      victim.applyDamage(dmg, x, z, dx, dz);
    }
    if (shooter === this.car && this.state === 'play') this.score += Math.round(dmg * 10);
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

  /** Прицел стрелка: точка в AIM_DIST м по стволу — на экран. */
  _crosshair() {
    const el = $('crosshair');
    if (this.seat !== 'gunner' || this.car.wrecked) return;
    const m = this.car.muzzle();
    _aimV.set(m.x + m.dx * AIM_DIST, m.y, m.z + m.dz * AIM_DIST).project(this.camera);
    el.style.left = `${((_aimV.x + 1) / 2) * 100}%`;
    el.style.top = `${((1 - _aimV.y) / 2) * 100}%`;
  }

  render() {
    this._crosshair();
    this.sky.position.copy(this.camera.position);
    const h = this.renderer.getDrawingBufferSize(this._dbs).y;
    const scale = h / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.fx.normal.material.uniforms.uScale.value = scale;
    this.fx.glow.material.uniforms.uScale.value = scale;
    this.renderer.render(this.scene, this.camera);
    this.xray.render(this.camera);
  }
}

const crash = new CrashReporter(version);
window.crash = crash;
boot();

async function boot() {
  try {
    // the rigid-body engine's WASM has to be up before the world is built
    if (PHYS_RAPIER) await initRapier();
    start();
  } catch (err) {
    crash.report(err, 'запуск игры');
  }
}

function start() {
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
}
