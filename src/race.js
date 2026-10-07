import * as THREE from 'three';

/** Настройки заезда — крутить здесь. */
export const RACE = {
  laps: 3,
  goreWin: 50, // третий способ победы — первым сбить столько пешеходов
  pace: 16, // м/с: за каждый отрезок даётся столько времени, сколько его ехать с такой средней скоростью
  startBuffer: 20, // запас на старте, с
  lapBonus: 5, // доп. секунды за пройденный круг
  radius: 11, // радиус засчитывания чекпоинта, м
  countdown: 3, // обратный отсчёт перед стартом, с
  // секунды за убийства
  killTime: { car: 2, gib: 3, crush: 2, explosion: 1 },
  wreckTime: 12, // секунды за разбитую машину соперника — стимул охотиться
  cpHeal: 6, // корпус за каждые ворота (и игроку, и соперникам) — стимул ехать по кругу
};

const GATE_HALF = 7.6; // полуширина ворот (дорога 14 м)
const GATE_H = 7;

function canvasTex(w, h, draw, redrawOnFonts = false) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (redrawOnFonts && document.fonts?.ready) {
    // надпись рисуется шрифтом Russo One — перерисовать, когда он загрузится
    document.fonts.ready.then(() => {
      const g = c.getContext('2d');
      g.clearRect(0, 0, w, h);
      draw(g, w, h);
      t.needsUpdate = true;
    });
  }
  return t;
}

function bannerTex(label, finish) {
  return canvasTex(512, 64, (g, w, h) => {
    if (finish) {
      const s = 16;
      for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) {
        g.fillStyle = (x / s + y / s) % 2 ? '#111' : '#f4f4f4';
        g.fillRect(x, y, s, s);
      }
      g.fillStyle = '#d4161c';
      g.fillRect(w / 2 - 110, 6, 220, h - 12);
    } else {
      g.fillStyle = '#ffd23f';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#1a1a1a';
      for (let x = -20; x < w; x += 46) {
        g.beginPath();
        g.moveTo(x, 8);
        g.lineTo(x + 16, h / 2);
        g.lineTo(x, h - 8);
        g.lineTo(x + 10, h - 8);
        g.lineTo(x + 26, h / 2);
        g.lineTo(x + 10, 8);
        g.fill();
      }
      g.fillStyle = '#ffd23f';
      g.fillRect(w / 2 - 130, 6, 260, h - 12);
    }
    g.fillStyle = finish ? '#fff' : '#1a1a1a';
    g.font = 'bold 40px "Russo One", "Arial Black", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, w / 2, h / 2 + 2);
  }, true);
}

const curtainTex = () => {
  const t = canvasTex(64, 128, (g, w, h) => {
    const grad = g.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-out';
    for (let y = 0; y < h; y += 8) {
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(0, y, w, 3);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
};

const beamTex = () => canvasTex(16, 128, (g, w, h) => {
  const grad = g.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
});

/**
 * Заезд по чекпоинтам: ворота на улицах города, круги, таймер.
 * Маршрут — замкнутая ломаная по дорогам, чекпоинты стоят посреди кварталов.
 */
export class Race {
  constructor(scene, city, fx, audio) {
    this.scene = scene;
    this.city = city;
    this.fx = fx;
    this.audio = audio;
    this.onEvent = null; // (type, data)

    const r = city.roads; // [-180, -120, -60, 0, 60, 120, 180]
    // замкнутый маршрут по улицам (по часовой стрелке, если смотреть сверху на карту)
    this.route = [
      [r[3], r[0]], [r[3], r[4]], [r[5], r[4]], [r[5], r[6]],
      [r[1], r[6]], [r[1], r[2]], [r[2], r[2]], [r[2], r[0]],
    ];
    // чекпоинты: посередине кварталов; последний — старт/финиш
    const mid = (a, b) => (a + b) / 2;
    const pts = [
      [r[3], mid(r[2], r[3])],
      [mid(r[4], r[5]), r[4]],
      [r[5], mid(r[5], r[6])],
      [mid(r[2], r[3]), r[6]],
      [r[1], mid(r[4], r[5])],
      [mid(r[1], r[2]), r[2]],
      [r[2], mid(r[0], r[1])],
      [r[3], city.spawn.z + 16], // старт/финиш — линия перед стартовой решёткой
    ];
    this._buildRoute();
    this.cps = pts.map(([x, z], i) => this._makeCheckpoint(x, z, i === pts.length - 1));
    const L = this.length;
    for (let i = 0; i < this.cps.length; i++) {
      const a = this.cps[i], b = this.cps[(i + 1) % this.cps.length];
      a.toNext = (((b.s - a.s) % L) + L) % L; // путь по маршруту до следующего чекпоинта
    }
    this.finishIdx = this.cps.length - 1;
    const startS = this._project(city.spawn.x, city.spawn.z).s;
    this.startToFirst = (((this.cps[0].s - startS) % L) + L) % L;

    // световой столб над активным чекпоинтом — виден из-за домов
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(1.4, 1.4, 120, 16, 1, true),
      new THREE.MeshBasicMaterial({ map: beamTex(), color: 0xffd23f, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    );
    this.beam.position.y = 60;
    this.beam.renderOrder = 4;
    scene.add(this.beam);

    this._drawMinimapRoute();
    this.reset();
  }

  // ------------------------------------------------------------ маршрут
  _buildRoute() {
    const R = this.route;
    this.segs = [];
    let s = 0;
    for (let i = 0; i < R.length; i++) {
      const [ax, az] = R[i], [bx, bz] = R[(i + 1) % R.length];
      const len = Math.hypot(bx - ax, bz - az);
      this.segs.push({ ax, az, bx, bz, len, s0: s, dx: (bx - ax) / len, dz: (bz - az) / len });
      s += len;
    }
    this.length = s;
  }

  /** Ближайшая точка маршрута: длина пути s, направление дороги и расстояние до неё. */
  _project(x, z) {
    let best = null, bd = Infinity;
    for (const g of this.segs) {
      const t = Math.max(0, Math.min(g.len, (x - g.ax) * g.dx + (z - g.az) * g.dz));
      const px = g.ax + g.dx * t, pz = g.az + g.dz * t;
      const d = (x - px) ** 2 + (z - pz) ** 2;
      if (d < bd) {
        bd = d;
        best = { s: g.s0 + t, dx: g.dx, dz: g.dz, dist: 0 };
      }
    }
    best.dist = Math.sqrt(bd);
    return best;
  }

  project(x, z) {
    return this._project(x, z);
  }

  _seg(s) {
    const L = this.length;
    s = ((s % L) + L) % L;
    for (const g of this.segs) if (s <= g.s0 + g.len) return [g, s - g.s0];
    return [this.segs[this.segs.length - 1], 0];
  }

  /** Точка маршрута на пути s со сдвигом вправо на lateral метров. */
  pointAt(s, lateral = 0) {
    const [g, t] = this._seg(s);
    // вправо от направления (dx, dz) — это (-dz, dx)
    return { x: g.ax + g.dx * t - g.dz * lateral, z: g.az + g.dz * t + g.dx * lateral, dx: g.dx, dz: g.dz };
  }

  /** Ближайшие повороты впереди: [{dist, angle}, …]. */
  cornersAhead(s, count = 2) {
    const [g0, t] = this._seg(s);
    const i0 = this.segs.indexOf(g0);
    const out = [];
    let dist = g0.len - t;
    for (let k = 0; k < count; k++) {
      const a = this.segs[(i0 + k) % this.segs.length], b = this.segs[(i0 + k + 1) % this.segs.length];
      const angle = Math.acos(Math.max(-1, Math.min(1, a.dx * b.dx + a.dz * b.dz)));
      out.push({ dist, angle });
      dist += b.len;
    }
    return out;
  }

  /** Пройденная доля пути до следующего чекпоинта у участника (0…1). */
  segmentProgress(next, x, z) {
    const cp = this.cps[next];
    const prev = this.cps[(next - 1 + this.cps.length) % this.cps.length];
    const L = this.length;
    let rem = (((cp.s - this._project(x, z).s) % L) + L) % L;
    if (rem > L * 0.5) rem -= L; // чуть проскочил ворота, но ещё не засчитано
    // может быть меньше 0 — например, на старте до линии
    return Math.min(1.05, 1 - rem / (prev.toNext || 1));
  }

  _makeCheckpoint(x, z, finish) {
    const pr = this._project(x, z);
    const yaw = Math.atan2(pr.dx, pr.dz);
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = yaw;

    const postMat = new THREE.MeshBasicMaterial({ color: finish ? 0xf4f4f4 : 0xffd23f, transparent: true });
    const postGeo = new THREE.CylinderGeometry(0.3, 0.4, GATE_H, 10);
    for (const sx of [-GATE_HALF, GATE_HALF]) {
      const p = new THREE.Mesh(postGeo, postMat);
      p.position.set(sx, GATE_H / 2, 0);
      group.add(p);
    }
    const plain = new THREE.MeshBasicMaterial({ color: finish ? 0x222222 : 0x1a1a1a, transparent: true });
    const bannerMat = new THREE.MeshBasicMaterial({ map: bannerTex(finish ? 'ФИНИШ' : 'ЧЕКПОИНТ', finish), transparent: true });
    const banner = new THREE.Mesh(new THREE.BoxGeometry(GATE_HALF * 2 + 0.8, 1.5, 0.3), [plain, plain, plain, plain, bannerMat, bannerMat]);
    banner.position.y = GATE_H - 0.3;
    group.add(banner);

    const curtainMat = new THREE.MeshBasicMaterial({
      map: curtainTex(), color: finish ? 0xffffff : 0xffd23f, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const curtain = new THREE.Mesh(new THREE.PlaneGeometry(GATE_HALF * 2, GATE_H - 1.1), curtainMat);
    curtain.position.y = (GATE_H - 1.1) / 2;
    curtain.renderOrder = 3;
    group.add(curtain);

    // полоса на асфальте
    const lineTex = finish
      ? canvasTex(256, 32, (g, w, h) => {
          for (let y = 0; y < h; y += 16) for (let x = 0; x < w; x += 16) {
            g.fillStyle = (x / 16 + y / 16) % 2 ? '#111' : '#f4f4f4';
            g.fillRect(x, y, 16, 16);
          }
        })
      : canvasTex(256, 32, (g, w, h) => {
          g.fillStyle = '#ffd23f';
          g.fillRect(0, 0, w, h);
        });
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(GATE_HALF * 2, 1.6),
      new THREE.MeshLambertMaterial({ map: lineTex, transparent: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    line.rotation.x = -Math.PI / 2;
    line.position.y = 0.03;
    group.add(line);

    this.scene.add(group);
    return { x, z, s: pr.s, yaw, dx: pr.dx, dz: pr.dz, finish, group, postMat, plain, bannerMat, curtainMat, curtain, line, flash: 0, toNext: 0 };
  }

  _drawMinimapRoute() {
    const mm = this.city.minimap;
    const g = mm.canvas.getContext('2d');
    const P = (v) => (v + mm.ext) * mm.k;
    g.save();
    g.strokeStyle = 'rgba(255, 210, 63, 0.55)';
    g.lineWidth = 5;
    g.lineJoin = 'round';
    g.setLineDash([10, 7]);
    g.beginPath();
    this.route.forEach(([x, z], i) => (i ? g.lineTo(P(x), P(z)) : g.moveTo(P(x), P(z))));
    g.closePath();
    g.stroke();
    g.restore();
  }

  // ------------------------------------------------------------ состояние
  reset() {
    this.started = false;
    this.done = false;
    this.lap = 1;
    this.next = 0;
    this.passed = 0; // всего чекпоинтов за заезд
    this.elapsed = 0;
    this.clock = 0; // общее время заезда — идёт и после финиша игрока, для соперников
    this.lapTime = 0;
    this.lapTimes = [];
    this.timeLeft = RACE.startBuffer + this.startToFirst / RACE.pace;
    this.lastTick = Infinity;
    this.lastCp = -1;
    this.finishCount = 0; // сколько участников уже финишировало
    this.place = 0; // место игрока на финише
    for (const cp of this.cps) cp.flash = 0;
    this._style();
  }

  start() {
    this.started = true;
  }

  get totalCps() {
    return this.cps.length;
  }

  get target() {
    return this.cps[this.next];
  }

  addTime(sec) {
    if (!this.started || this.done || sec <= 0) return 0;
    this.timeLeft += sec;
    return sec;
  }

  /** Куда поставить застрявшую машину: последний пройденный чекпоинт (или старт). */
  respawnPoint(lastCp = this.lastCp, start = this.city.spawn) {
    if (lastCp < 0) return { ...start };
    const cp = this.cps[lastCp];
    // правая полоса, чуть дальше ворот
    const rx = -cp.dz, rz = cp.dx;
    return { x: cp.x + cp.dx * 4 + rx * 3.5, z: cp.z + cp.dz * 4 + rz * 3.5, yaw: cp.yaw };
  }

  /** Подсветка: активные ворота яркие, следующие тусклые, остальные спрятаны (финиш видно всегда). */
  _style() {
    const n = this.cps.length;
    this.cps.forEach((cp, i) => {
      const active = !this.done && i === this.next;
      const upcoming = !this.done && i === (this.next + 1) % n;
      const visible = active || upcoming || cp.finish || cp.flash > 0;
      cp.group.visible = visible;
      const k = active ? 1 : cp.finish ? 0.45 : 0.3;
      cp.postMat.opacity = k;
      cp.plain.opacity = k;
      cp.bannerMat.opacity = Math.min(1, k + 0.2);
      cp.curtainMat.opacity = active ? 0.45 : 0.08;
      cp.line.material.opacity = active ? 0.95 : 0.4;
    });
    const t = this.cps[this.next];
    this.beam.visible = !this.done;
    this.beam.position.x = t.x;
    this.beam.position.z = t.z;
    this.beam.material.color.set(t.finish ? 0xffffff : 0xffd23f);
  }

  _emit(type, data) {
    if (this.onEvent) this.onEvent(type, data);
  }

  update(dt, car) {
    // анимация
    const time = performance.now() / 1000;
    for (const cp of this.cps) {
      if (!cp.group.visible) continue;
      cp.curtainMat.map.offset.y = -time * 0.6;
      if (cp.flash > 0) {
        cp.flash = Math.max(0, cp.flash - dt * 1.6);
        cp.curtainMat.opacity = 0.45 + cp.flash;
        cp.group.scale.setScalar(1 + (1 - cp.flash) * 0.15 * cp.flash);
        if (cp.flash === 0) {
          cp.group.scale.setScalar(1);
          this._style();
        }
      }
    }
    this.beam.material.opacity = 0.55 + Math.sin(time * 4) * 0.2;

    if (this.started) this.clock += dt;
    if (!this.started || this.done) return;
    this.elapsed += dt;
    this.lapTime += dt;
    this.timeLeft = Math.max(0, this.timeLeft - dt);

    // тиканье последних секунд
    const sec = Math.ceil(this.timeLeft);
    if (sec <= 10 && sec < this.lastTick && this.timeLeft > 0) this._emit('tick', sec);
    this.lastTick = sec;

    const cp = this.cps[this.next];
    if ((car.x - cp.x) ** 2 + (car.z - cp.z) ** 2 < RACE.radius * RACE.radius) this._pass(cp, car);
    else if (this.timeLeft <= 0) {
      this.done = true;
      this._style();
      this._emit('timeout');
    }
  }

  /** Новый счётчик прогресса для соперника. */
  newTracker() {
    return { lap: 1, next: 0, passed: 0, lastCp: -1, finished: false, place: 0, time: 0 };
  }

  /** Прогресс соперника по воротам; возвращает событие или null. */
  track(tr, car) {
    if (!this.started || tr.finished) return null;
    const cp = this.cps[tr.next];
    if ((car.x - cp.x) ** 2 + (car.z - cp.z) ** 2 >= RACE.radius * RACE.radius) return null;
    tr.lastCp = tr.next;
    tr.passed++;
    if (cp.finish) {
      if (tr.lap >= RACE.laps) {
        tr.finished = true;
        tr.place = ++this.finishCount;
        tr.time = this.clock;
        return { type: 'finish', place: tr.place };
      }
      tr.lap++;
      tr.next = 0;
      return { type: 'lap', lap: tr.lap };
    }
    tr.next++;
    return { type: 'checkpoint' };
  }

  _pass(cp, car) {
    const idx = this.next;
    this.lastCp = idx;
    this.passed++;
    cp.flash = 1;
    for (const sx of [-GATE_HALF, GATE_HALF]) {
      const px = cp.x + Math.cos(cp.yaw) * sx, pz = cp.z - Math.sin(cp.yaw) * sx;
      this.fx.sparks(px, 4, pz, 0, 0, 18);
    }
    if (cp.finish) {
      this.lapTimes.push(this.lapTime);
      this.lapTime = 0;
      if (this.lap >= RACE.laps) {
        this.done = true;
        this.place = ++this.finishCount;
        this._style();
        cp.group.visible = true;
        this._emit('finish', { total: this.elapsed, lapTimes: this.lapTimes, place: this.place });
        return;
      }
      this.lap++;
      const bonus = cp.toNext / RACE.pace + RACE.lapBonus;
      this.timeLeft += bonus;
      this.next = 0;
      this._style();
      this._emit('lap', { lap: this.lap, bonus, lapTime: this.lapTimes[this.lapTimes.length - 1], last: this.lap === RACE.laps });
      return;
    }
    const bonus = cp.toNext / RACE.pace;
    this.timeLeft += bonus;
    this.next = idx + 1;
    this._style();
    this._emit('checkpoint', { index: idx, bonus });
  }
}
