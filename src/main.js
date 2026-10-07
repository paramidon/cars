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
import { pick } from './utils.js';

const $ = (id) => document.getElementById(id);
const NO_INPUT = { throttle: 0, brake: 0, steer: 0, handbrake: false, fire: false };
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
    this.time = 0;
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
      if (impact > 20 && !car.wrecked) hud.popup(pick(['БАБАХ!', 'ХРЯСЬ!', 'В ЛЕПЁШКУ!']), 'warn');
    };
    car.onDamage = (dmg) => {
      hud.damageFlash(Math.min(0.85, 0.2 + dmg / 30));
      if (car.health < 25 && car.health > 0 && !this.critWarned) {
        this.critWarned = true;
        hud.popup('КОРПУС КРИТИЧЕН!', 'warn');
      }
    };
    car.onWrecked = () => {
      peds.explosion(car.x, car.z, 11);
      cam.shake(1);
      hud.damageFlash(1);
      hud.popup('ТАЧКА РАЗБИТА!', 'big warn');
      this.state = 'wrecked';
      this.wreckAt = this.time;
    };
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
    click('btn-cam', () => this._action('camera'));
    click('btn-mute', () => this._action('mute'));
    click('btn-pause', () => this._action('pause'));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'play') this._setPaused(true);
    });
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
        else if (this.state === 'wrecked') this.restart();
        break;
      case 'confirm':
        if (this.state === 'menu') this.start();
        else if (this.state === 'wrecked' && this.wreckShown) this.restart();
        else if (this.state === 'pause') this._setPaused(false);
        break;
    }
  }

  _kill(p, cause, speed) {
    this.kills++;
    const t = this.time;
    this.combo = t - this.lastKill < 3.5 ? this.combo + 1 : 1;
    this.multi = t - this.lastKill < 0.7 ? this.multi + 1 : 1;
    this.lastKill = t;
    this.comboTimer = 3.5;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    let base = 100, text = '', cls = '';
    switch (cause) {
      case 'car':
        text = pick(['СБИТ!', 'ПОД КОЛЁСА!', 'ШМЯК!', 'ДАВИ!', 'СТРАЙК!']);
        break;
      case 'gib':
        base = 150;
        text = pick(['В ФАРШ!', 'В КЛОЧЬЯ!', 'НА ЗАПЧАСТИ!']);
        cls = 'big';
        break;
      case 'gun':
        base = 75;
        text = pick(['РАССТРЕЛЯН', 'НАШПИГОВАН', 'ДЫРЯВЫЙ']);
        break;
      case 'explosion':
        base = 120;
        text = 'ВЗРЫВНОЙ!';
        cls = 'big';
        break;
    }
    const pts = base * this.combo;
    this.score += pts;
    this.hud.popup(`${text} +${pts}`, cls);
    if (this.multi === 2) this.hud.popup('ДУПЛЕТ!', 'gold');
    else if (this.multi === 3) this.hud.popup('ТРИПЛЕТ!', 'gold');
    else if (this.multi >= 4) this.hud.popup('МЯСОРУБКА!', 'gold big');
    if ((cause === 'car' || cause === 'gib') && speed > 13 && this.cam.mode !== 2) this.hud.splatter(Math.min(1.5, speed / 22));
    if (cause === 'car' || cause === 'gib') this.cam.shake(0.12 + speed * 0.006);
  }

  _pedEvent(type, p) {
    p.bonus = p.bonus || 0;
    const bits = { air: 1, wall: 2, juggle: 4, mince: 8 };
    if (p.bonus & bits[type]) return;
    p.bonus |= bits[type];
    const table = {
      air: [50, 'ПОЛЁТ НОРМАЛЬНЫЙ!'],
      wall: [50, 'НА СТЕНУ!'],
      juggle: [40, 'ЖОНГЛЁР!'],
      mince: [25, 'ФАРШ'],
    };
    const [pts, text] = table[type];
    this.score += pts;
    this.hud.popup(`${text} +${pts}`, 'gold');
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
    this.peds.reset(this.car);
    this._resetStats();
    this.cam.snap(this.car);
    this.state = 'play';
    $('wreck').classList.add('hidden');
    $('pause').classList.add('hidden');
    this.hud.show(true);
    this._syncTouchUI();
    this.hud.popup('ДАВИ ИХ ВСЕХ!', 'big');
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
    const sp = this.city.findRoadSpawn(car.x, car.z, car.yaw);
    car.x = sp.x;
    car.z = sp.z;
    car.yaw = sp.yaw;
    car.vx = car.vz = car.angVel = 0;
    this.cam.snap(car);
    this.hud.popup('НА ДОРОГУ', 'info');
  }

  _syncTouchUI() {
    const show = (IS_TOUCH || this.input.usingTouch) && this.state === 'play';
    $('touch').classList.toggle('hidden', !show);
  }

  _showWreck() {
    this.wreckShown = true;
    const t = Math.floor(this.playTime);
    $('stats').innerHTML = `
      <div><span>Очки</span><b>${this.score.toLocaleString('ru-RU')}</b></div>
      <div><span>Сбито пешеходов</span><b>${this.kills}</b></div>
      <div><span>Лучшее комбо</span><b>×${this.bestCombo}</b></div>
      <div><span>Макс. скорость</span><b>${Math.round(this.maxSpeed * 3.6)} км/ч</b></div>
      <div><span>Время</span><b>${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}</b></div>`;
    $('wreck').classList.remove('hidden');
    this._syncTouchUI();
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
    this.timer.update(now);
    const dt = Math.min(this.timer.getDelta(), 1 / 20);
    this.step(dt);
    this.render();
    this._adaptResolution(dt);
  }

  /** Один шаг симуляции (публичный — удобно для автотестов). */
  step(dt) {
    const input = this.input.update(dt);
    const { car, cam } = this;

    if (this.state === 'play' || this.state === 'wrecked') {
      this.time += dt;
      const inp = this.state === 'play' ? input : NO_INPUT;
      if (this.state === 'play') {
        this.playTime += dt;
        this.maxSpeed = Math.max(this.maxSpeed, car.speed);
      }
      car.update(dt, inp);
      this._updateAim();
      this.gun.update(dt, inp.fire, this.aim);
      this.peds.update(dt, car);
      this.breakables.update(dt);
      this.debris.update(dt);
      this.fx.update(dt);
      cam.update(dt, car);
      this._followSun(car.x, car.z);
      this.comboTimer = Math.max(0, this.comboTimer - dt);
      if (this.comboTimer === 0) this.combo = 0;
      this.hud.update(dt, this);
      if (this.state === 'wrecked' && !this.wreckShown && this.time - this.wreckAt > 2.8) this._showWreck();
    } else if (this.state === 'menu') {
      this.time += dt;
      car.update(dt, NO_INPUT);
      this.peds.update(dt, car);
      this.fx.update(dt);
      cam.orbitUpdate(dt, 0, -20);
      this._followSun(0, -20);
    }
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

window.game = new Game();
