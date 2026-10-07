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
import { MachineGun } from './weapon.js';
import { Input } from './input.js';
import { ChaseCamera } from './camera.js';
import { HUD } from './hud.js';
import { Race, RACE } from './race.js';
import { Rival, RIVALS, collideCars, carHitDamage } from './racers.js';
import { CrashReporter } from './crash.js';
import { phrase } from './words.js';
import { version } from '../package.json';

const $ = (id) => document.getElementById(id);
const NO_INPUT = { throttle: 0, brake: 0, steer: 0, handbrake: false, fire: false };
const STOP_INPUT = { throttle: 0, brake: 0, steer: 0, handbrake: true, fire: false };
// сколько корпуса чинит убийство: давить выгоднее, чем стрелять
const HEAL = { car: 6, gib: 8, crush: 8, gun: 2 };
const BEST_KEY = 'cars-and-guts:best';
const PLACE_BONUS = [3000, 1500, 600, 200];
const PLAYER_COLOR = '#e5262b';
const SHADOW_EXTENT = 60;
const SHADOW_MAP = 2048;

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
    this.peds = new Pedestrians(scene, this.city, this.fx, this.audio, QUALITY);
    this.gun = new MachineGun(scene, this.car, this.city, this.peds, this.fx, this.audio);
    this.race = new Race(scene, this.city, this.fx, this.audio);
    this.raceLaps = RACE.laps;
    this.rivals = RIVALS.map((def, i) => new Rival(scene, this.city, this.fx, this.audio, this.debris, QUALITY, this.race, def, i));
    this.cars = [this.car, ...this.rivals.map((r) => r.car)];
    this.gun.rivals = this.rivals.map((r) => r.car);
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
    this.raycaster = new THREE.Raycaster();
    this.aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1);
    this.aim = { mode: 'auto', x: 0, z: 0 };
    this._aimHit = new THREE.Vector3();
    this._dbs = new THREE.Vector2();

    this._wire();
    this._resetStats();
    this.peds.reset(this.car);

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
      rc.onWrecked = () => this._rivalWrecked(r);
    }
    this._onCarHit = (a, b, impact, px, pz, nx, nz) => this._carHit(a, b, impact, px, pz, nx, nz);
    peds.onKill = (p, cause, speed) => this._kill(p, cause, speed);
    peds.onEvent = (type, p) => this._pedEvent(type, p);
    this.gun.onShot = () => cam.shake(0.015);

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
    click('btn-restart', () => this.restart());
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
      if (document.hidden && this.state === 'play') this._setPaused(true);
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
        if (this.state === 'play') this._setPaused(true);
        else if (this.state === 'pause') this._setPaused(false);
        break;
      case 'respawn':
        if (this.state === 'play') this._unstuck();
        else if (this.state === 'over' && this.wreckShown) this.restart();
        break;
      case 'confirm':
        if (this.state === 'menu') this.start();
        else if (this.state === 'over' && this.wreckShown) this.restart();
        else if (this.state === 'pause') this._setPaused(false);
        break;
    }
  }

  _kill(p, cause, speed) {
    if (p.killer && p.killer !== this.car) {
      // сбил соперник: очков игроку нет, соперник подлатывается
      p.killer.heal(HEAL[cause] || 0);
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

  restart() {
    this.audio.init();
    this.fx.clear();
    this.debris.clear();
    this.breakables.reset();
    this.car.reset(this.city.spawn);
    this.race.reset();
    for (const r of this.rivals) r.reset();
    this.peds.reset(this.car);
    this._resetStats();
    this.cam.snap(this.car);
    this.state = 'play';
    this.overKind = null;
    this.countdown = RACE.countdown;
    this.countShown = Infinity;
    $('wreck').classList.add('hidden');
    $('pause').classList.add('hidden');
    this.hud.show(true);
    this._syncTouchUI();
  }

  _setPaused(p) {
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
    const sp = this.race.respawnPoint();
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
    const place = race.place;
    const titles = { wreck: 'ТАЧКА РАЗБИТА', timeout: 'ВРЕМЯ ВЫШЛО', finish: place === 1 ? 'ПОБЕДА!' : `${place}-Е МЕСТО` };
    const title = $('result-title');
    title.textContent = titles[this.overKind] || 'КОНЕЦ';
    title.className = this.overKind === 'finish' && place <= 2 ? 'gold' : 'red';
    const laps = this.overKind === 'finish' ? `${RACE.laps}/${RACE.laps}` : `${race.lap - 1}/${RACE.laps}`;
    const best = race.lapTimes.length ? fmt(Math.min(...race.lapTimes)) : '—';
    const rows = [
      ['Место', this.overKind === 'finish' ? `${place} из ${this.cars.length}` : 'сход'],
      ['Очки', this.score.toLocaleString('ru-RU')],
      ['Кругов пройдено', laps],
      ['Время заезда', fmt(race.elapsed)],
      ['Лучший круг', best],
      ['Сбито пешеходов', this.kills],
      ['Лучшее комбо', `×${this.bestCombo}`],
      ['Макс. скорость', `${Math.round(this.maxSpeed * 3.6)} км/ч`],
    ];
    if (this.overKind === 'finish') rows.splice(3, 0, ['Рекорд трассы', this.newRecord ? 'НОВЫЙ!' : fmt(this.best.time)]);
    const table = this.standings
      .map((e, i) => {
        const st = e.finished ? `финиш ${fmt(e.time)}` : e.car.wrecked ? 'разбит' : e.player && this.overKind !== 'finish' ? 'сход' : `круг ${Math.min(e.lap, RACE.laps)}`;
        return `<div class="st-row${e.player ? ' me' : ''}"><i style="background:${e.color}"></i><span>${i + 1}. ${e.name}</span><b>${st}</b></div>`;
      })
      .join('');
    $('stats').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('') + `<div class="st-table">${table}</div>`;
    $('wreck').classList.remove('hidden');
    this._syncTouchUI();
  }

  _raceEvent(type, data) {
    const { hud, audio } = this;
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
      // остаток времени и место — в очки
      const bonus = Math.round(this.race.timeLeft) * 100;
      const placeBonus = PLACE_BONUS[data.place - 1] || 0;
      this.score += 1000 + bonus + placeBonus;
      hud.popup(data.place === 1 ? 'ПОБЕДА!' : `ФИНИШ: ${data.place}-Е МЕСТО`, 'gold big');
      if (bonus) hud.popup(`ЗАПАС ВРЕМЕНИ +${bonus}`, 'gold');
      audio.finish();
      this.cam.shake(0.3);
      this._gameOver('finish');
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
    const da = carHitDamage(a, impact, px, pz);
    const db = carHitDamage(b, impact, px, pz);
    if (da > 0) {
      a.lastAttacker = b;
      a.lastAttackAt = now;
      a.applyDamage(da, px, pz, nx, nz);
    }
    if (db > 0) {
      b.lastAttacker = a;
      b.lastAttackAt = now;
      b.applyDamage(db, px, pz, -nx, -nz);
    }
    // игрок протаранил соперника
    const dealt = a === player ? db : b === player ? da : 0;
    const victim = a === player ? b : b === player ? a : null;
    if (victim && dealt >= 5 && now - (this._lastRamPopup || 0) > 700 && this.state === 'play') {
      this._lastRamPopup = now;
      this.score += Math.round(dealt) * 10;
      this.hud.popup(`${phrase('ram')} −${Math.round(dealt)}`, 'gold');
    }
  }

  _rivalWrecked(r) {
    const c = r.car, player = this.car;
    r.out = true;
    this.peds.explosion(c.x, c.z, 10, c);
    if (c.vol() > 0.2) this.cam.shake(0.5 * c.vol());
    const byPlayer = c.lastAttacker === player && performance.now() - c.lastAttackAt < 4000;
    if (this.state !== 'play') return;
    if (byPlayer) {
      this.score += 1000;
      this.hud.popup(`${r.name} ВЫБИТ! +1000`, 'gold big');
      this.car.heal(15);
      this.hud.heal(15);
    } else this.hud.popup(`${r.name} РАЗБИЛСЯ`, 'info');
  }

  /** Места в гонке: финишировавшие по порядку, остальные — по пройденному пути. */
  _updateStandings() {
    const race = this.race;
    const list = [
      { car: this.car, name: 'ТЫ', color: PLAYER_COLOR, player: true, finished: race.place > 0, place: race.place, passed: race.passed, next: race.next, lap: race.lap, time: race.elapsed },
      ...this.rivals.map((r) => ({ car: r.car, name: r.name, color: r.color, rival: r, finished: r.tr.finished, place: r.tr.place, passed: r.tr.passed, next: r.tr.next, lap: r.tr.lap, time: r.tr.time })),
    ];
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
    if (!ev || this.state !== 'play') return;
    if (ev.type === 'finish') this.hud.popup(`${r.name} ФИНИШИРОВАЛ ${ev.place}-М`, 'warn');
    else if (ev.type === 'lap' && ev.lap === RACE.laps) this.hud.popup(`${r.name}: ПОСЛЕДНИЙ КРУГ`, 'info');
  }

  /** Синхронная физика всех машин: подшаги, столкновения между машинами, потом визуал. */
  _physics(dt, playerInp) {
    const cars = this.cars;
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      cars[0].physicsStep(h, playerInp);
      for (let k = 0; k < this.rivals.length; k++) this.rivals[k].car.physicsStep(h, this.rivals[k].inp);
      collideCars(cars, this._onCarHit);
    }
    cars[0].postUpdate(dt, playerInp);
    for (const r of this.rivals) r.car.postUpdate(dt, r.inp);
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
      rivals: this.rivals.map((r) => ({ name: r.name, x: r1(r.car.x), z: r1(r.car.z), speed: r1(r.car.speed), health: r1(r.car.health), lap: r.tr.lap, next: r.tr.next, stuck: r1(r.stuckT) })),
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

  _updateAim() {
    if (!this.input.mouseAim) {
      this.aim.mode = 'auto';
      return;
    }
    this.aimPlane.constant = -(this.car.y + 1.2);
    this.raycaster.setFromCamera(this.input.mouse, this.camera);
    if (this.raycaster.ray.intersectPlane(this.aimPlane, this._aimHit)) {
      this.aim.mode = 'mouse';
      this.aim.x = this._aimHit.x;
      this.aim.z = this._aimHit.z;
    } else this.aim.mode = 'auto';
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
      let inp = this.state === 'play' ? input : STOP_INPUT;
      if (this.state === 'play') {
        if (this.countdown > 0) {
          this._countdown(dt);
          inp = NO_INPUT;
        } else {
          this.playTime += dt;
          this.maxSpeed = Math.max(this.maxSpeed, car.speed);
        }
      }
      const running = this.race.started;
      const me = this.standings.find((e) => e.player);
      for (const r of this.rivals) {
        const mine = this.standings.find((e) => e.rival === r);
        r.think(dt, car, running, me ? me.progress : 0, mine ? mine.progress : 0);
      }
      this._physics(dt, inp);
      this._updateAim();
      this.gun.update(dt, inp.fire, this.aim);
      this.peds.update(dt, this.cars);
      this.breakables.update(dt);
      this.debris.update(dt);
      this.fx.update(dt);
      this.race.update(dt, car);
      for (const r of this.rivals) {
        this._rivalEvent(r, this.race.track(r.tr, r.car));
        r.updateTag(car);
      }
      this._updateStandings();
      cam.update(dt, car);
      this._followSun(car.x, car.z);
      this.comboTimer = Math.max(0, this.comboTimer - dt);
      if (this.comboTimer === 0) this.combo = 0;
      this.hud.update(dt, this);
      if (this.state === 'over' && !this.wreckShown && this.time - this.wreckAt > 2.8) this._showWreck();
    } else if (this.state === 'menu') {
      this.time += dt;
      for (const r of this.rivals) r.think(dt, car, false, 0, 0);
      this._physics(dt, NO_INPUT);
      for (const r of this.rivals) r.updateTag(car);
      this.peds.update(dt, this.cars);
      this.fx.update(dt);
      this.race.update(dt, car);
      cam.orbitUpdate(dt, 0, -20);
      this._followSun(0, -20);
    }
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
