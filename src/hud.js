import { ST } from './pedestrians.js';
import { rand } from './utils.js';

const $ = (id) => document.getElementById(id);

/** HUD: очки, корпус, спидометр, всплывающие надписи, кровь на экране, миникарта. */
export class HUD {
  constructor(city) {
    this.city = city;
    this.el = {
      hud: $('hud'),
      score: $('score'),
      kills: $('kills'),
      combo: $('combo'),
      health: $('health-fill'),
      healthWrap: $('health'),
      speed: $('speed'),
      messages: $('messages'),
      fps: $('fps'),
      race: $('race'),
      raceTime: $('race-time'),
      raceLap: $('race-lap'),
      raceCp: $('race-cp'),
      raceArrow: $('race-arrow'),
      raceDist: $('race-dist'),
      countdown: $('countdown'),
      racePos: $('race-pos'),
      standings: $('standings'),
      raceEnemies: $('race-enemies'),
      gun: $('gun'),
      fire: $('btn-fire'),
    };
    this.mm = $('minimap');
    this.mmCtx = this.mm.getContext('2d');
    this.splat = $('splatter');
    this.splatCtx = this.splat.getContext('2d');
    this.splatAlpha = 0;
    this.vignette = $('vignette');
    this.flashT = 0;
    this.cache = {};
    this.frame = 0;
    this._resizeSplat();
    window.addEventListener('resize', () => this._resizeSplat());
  }

  _resizeSplat() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.splat.width = Math.floor(window.innerWidth * dpr);
    this.splat.height = Math.floor(window.innerHeight * dpr);
    this.splatAlpha = 0;
    this.splat.style.opacity = 0;
  }

  _set(key, el, value) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    el.textContent = value;
  }

  show(v) {
    this.el.hud.classList.toggle('hidden', !v);
  }

  update(dt, game) {
    const { car } = game;
    this._set('score', this.el.score, game.score.toLocaleString('ru-RU'));
    this._set('kills', this.el.kills, String(game.kills));
    this._set('speed', this.el.speed, String(Math.round(car.speed * 3.6)));
    const combo = game.combo > 1 && game.comboTimer > 0 ? `КОМБО ×${game.combo}` : '';
    this._set('combo', this.el.combo, combo);
    const hp = Math.max(0, Math.round(car.health));
    if (this.cache.hp !== hp) {
      this.cache.hp = hp;
      this.el.health.style.width = `${hp}%`;
      this.el.health.style.background = hp > 60 ? '#5fd35f' : hp > 30 ? '#f5b82e' : '#ff3b30';
      this.el.healthWrap.classList.toggle('critical', hp <= 25);
    }

    // кровь на «стекле»
    if (this.splatAlpha > 0) {
      this.splatAlpha = Math.max(0, this.splatAlpha - dt * 0.45);
      this.splat.style.opacity = this.splatAlpha.toFixed(3);
      if (this.splatAlpha === 0) this.splatCtx.clearRect(0, 0, this.splat.width, this.splat.height);
    }
    if (this.flashT > 0) {
      this.flashT = Math.max(0, this.flashT - dt * 2.5);
      this.vignette.style.opacity = this.flashT.toFixed(3);
    }

    this._race(game);
    this.frame++;
    if (this.frame % 2 === 0) this._minimap(game);
  }

  /** Таймер, круг, чекпоинт и стрелка на следующие ворота. */
  _race(game) {
    const { race, car } = game;
    const t = race.timeLeft;
    const txt = t < 10 ? t.toFixed(1) : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    this._set('rt', this.el.raceTime, txt);
    const low = t < 10 && !race.done;
    if (this.cache.low !== low) {
      this.cache.low = low;
      this.el.race.classList.toggle('low', low);
    }
    this._set('rl', this.el.raceLap, `КРУГ ${Math.min(race.lap, game.raceLaps)}/${game.raceLaps}`);
    this._set('rp', this.el.racePos, `${game.position}/${game.cars.length}`);
    this._set('re', this.el.raceEnemies, String(game.rivals.filter((r) => !r.car.wrecked).length));
    // перезарядка пушки
    const p = Math.round((1 - Math.min(1, game.car.reload / game.reloadTime)) * 20) / 20;
    if (this.cache.gunP !== p) {
      this.cache.gunP = p;
      for (const el of [this.el.gun, this.el.fire]) {
        el.style.setProperty('--p', p);
        el.classList.toggle('ready', p >= 1);
      }
    }
    if (this.frame % 10 === 0) this._standings(game);
    this._set('rc', this.el.raceCp, race.target.finish ? 'К ФИНИШУ' : `ЧП ${race.next + 1}/${race.totalCps - 1}`);
    const cp = race.target;
    const dx = cp.x - car.x, dz = cp.z - car.z;
    const s = Math.sin(car.yaw), c = Math.cos(car.yaw);
    const fwd = dx * s + dz * c, right = dx * -c + dz * s;
    const ang = Math.atan2(right, fwd);
    this.el.raceArrow.style.transform = `rotate(${ang.toFixed(3)}rad)`;
    this._set('rd', this.el.raceDist, `${Math.round(Math.hypot(dx, dz))} м`);
  }

  /** Таблица участников (ПК). */
  _standings(game) {
    const key = game.standings.map((e) => `${e.name}${e.car.wrecked ? 'x' : ''}${e.finished ? 'f' : ''}`).join('|');
    if (key === this.cache.standings) return;
    this.cache.standings = key;
    this.el.standings.innerHTML = game.standings
      .map((e, i) => {
        const note = e.finished ? ' ✓' : e.car.wrecked ? ' ✕' : '';
        return `<div class="${e.player ? 'me' : ''}${e.car.wrecked ? ' out' : ''}"><i style="background:${e.color}"></i>${i + 1}. ${e.name}${note}</div>`;
      })
      .join('');
  }

  /** Большие цифры отсчёта перед стартом. */
  countdown(text) {
    const el = this.el.countdown;
    el.textContent = text;
    el.classList.remove('go', 'show');
    void el.offsetWidth;
    el.classList.add('show');
    if (text.length > 1) el.classList.add('go');
  }

  /** «+N с» у таймера. */
  timeBonus(sec) {
    const d = document.createElement('span');
    d.className = 'time-pop';
    d.textContent = `+${Math.round(sec)} с`;
    this.el.race.appendChild(d);
    setTimeout(() => d.remove(), 1300);
  }

  setFps(v) {
    if (this.el.fps) this.el.fps.textContent = `${v} FPS`;
  }

  popup(text, cls = '') {
    const d = document.createElement('div');
    d.className = `msg ${cls}`;
    d.textContent = text;
    this.el.messages.appendChild(d);
    while (this.el.messages.children.length > 4) this.el.messages.firstChild.remove();
    setTimeout(() => d.remove(), 1700);
  }

  /** Корпус подлатали: зелёная вспышка полоски и всплывающее «+N». */
  heal(amount) {
    const wrap = this.el.healthWrap;
    const d = document.createElement('span');
    d.className = 'heal-pop';
    d.textContent = `+${amount}`;
    wrap.appendChild(d);
    setTimeout(() => d.remove(), 1200);
    wrap.classList.remove('healed');
    void wrap.offsetWidth; // перезапуск анимации
    wrap.classList.add('healed');
  }

  damageFlash(strength = 0.6) {
    this.flashT = Math.min(1, Math.max(this.flashT, strength));
  }

  /** Брызги крови на экране. */
  splatter(intensity = 1) {
    const c = this.splatCtx;
    const W = this.splat.width, H = this.splat.height;
    if (this.splatAlpha < 0.05) c.clearRect(0, 0, W, H);
    const n = Math.floor(3 + intensity * 6);
    const unit = Math.min(W, H);
    for (let i = 0; i < n; i++) {
      const x = rand(0.05, 0.95) * W;
      const y = rand(0.05, 0.75) * H;
      const r = unit * rand(0.02, 0.07) * (0.6 + intensity * 0.5);
      const g = c.createRadialGradient(x, y, r * 0.1, x, y, r);
      g.addColorStop(0, 'rgba(110,0,0,0.95)');
      g.addColorStop(0.7, 'rgba(150,8,8,0.85)');
      g.addColorStop(1, 'rgba(150,8,8,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = 'rgba(130,4,4,0.85)';
      for (let k = 0; k < 7; k++) {
        const a = Math.random() * Math.PI * 2, d = r * rand(0.9, 1.8);
        c.beginPath();
        c.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * rand(0.05, 0.16), 0, Math.PI * 2);
        c.fill();
      }
      // потёки
      const drips = Math.floor(rand(0, 3));
      for (let k = 0; k < drips; k++) {
        const dx = x + rand(-r * 0.6, r * 0.6);
        const len = r * rand(1, 3.5);
        const w = r * rand(0.08, 0.16);
        c.fillRect(dx - w / 2, y, w, len);
        c.beginPath();
        c.arc(dx, y + len, w * 0.9, 0, Math.PI * 2);
        c.fill();
      }
    }
    this.splatAlpha = Math.min(1, this.splatAlpha + 0.5 + intensity * 0.3);
    this.splat.style.opacity = this.splatAlpha.toFixed(3);
  }

  _minimap(game) {
    const { car, peds } = game;
    const ctx = this.mmCtx;
    const W = this.mm.width, H = this.mm.height;
    const cx = W / 2, cy = H / 2;
    const scale = W / 170; // ~85 м в каждую сторону
    const mm = this.city.minimap;
    const c = Math.cos(car.yaw), s = Math.sin(car.yaw);
    const k = mm.k;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.beginPath();
    ctx.arc(cx, cy, W / 2 - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#2b2d2a';
    ctx.fillRect(0, 0, W, H);
    // мир → экран: экранное «вверх» = курс машины, «вправо» = правый борт
    const a = (-c * scale) / k, cc = (s * scale) / k;
    const b = (-s * scale) / k, d = (-c * scale) / k;
    const ox = -mm.ext - car.x, oz = -mm.ext - car.z;
    const e = cx + scale * (-c * ox + s * oz);
    const f = cy - scale * (s * ox + c * oz);
    ctx.setTransform(a, b, cc, d, e, f);
    ctx.drawImage(mm.canvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const toScreen = (x, z) => {
      const dx = x - car.x, dz = z - car.z;
      return [cx + scale * (-c * dx + s * dz), cy - scale * (s * dx + c * dz)];
    };
    for (const p of peds.peds) {
      if (p.state === ST.FREE) continue;
      const [sx, sy] = toScreen(p.x, p.z);
      if (sx < -4 || sy < -4 || sx > W + 4 || sy > H + 4) continue;
      const down = p.state === ST.DOWN || p.state === ST.GETUP || (p.state === ST.FLYING && p.knocked);
      const dead = !down && (p.state === ST.DEAD || p.state === ST.FLYING);
      ctx.fillStyle = dead ? '#6b0d0d' : down ? '#ff9f1a' : p.state === ST.PANIC || p.state === ST.COWER ? '#ffd23f' : '#ff5a4f';
      ctx.fillRect(sx - 2, sy - 2, 4, 4);
    }
    // следующий и последующий чекпоинты; если далеко — метка на краю круга
    const race = game.race;
    const R = W / 2 - 9;
    const marks = [[race.cps[(race.next + 1) % race.cps.length], 0.45], [race.target, 1]];
    for (const [cp, alpha] of marks) {
      if (!cp || race.done) continue;
      let [sx, sy] = toScreen(cp.x, cp.z);
      const ox = sx - cx, oy = sy - cy;
      const d = Math.hypot(ox, oy);
      const edge = d > R;
      if (edge) {
        sx = cx + (ox / d) * R;
        sy = cy + (oy / d) * R;
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = cp.finish ? '#ffffff' : '#ffd23f';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, edge ? 5 : 6 + (alpha === 1 ? Math.sin(performance.now() / 150) * 1.5 : 0), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // соперники — цветные стрелки; далеко — на краю круга
    for (const r of game.rivals) {
      const rc = r.car;
      let [sx, sy] = toScreen(rc.x, rc.z);
      const ox = sx - cx, oy = sy - cy;
      const d = Math.hypot(ox, oy);
      const edge = d > R;
      if (edge) {
        sx = cx + (ox / d) * R;
        sy = cy + (oy / d) * R;
      }
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(-(rc.yaw - car.yaw));
      ctx.fillStyle = rc.wrecked ? '#555' : r.color;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      const k = edge ? 0.7 : 1;
      ctx.beginPath();
      ctx.moveTo(0, -7 * k);
      ctx.lineTo(5 * k, 5 * k);
      ctx.lineTo(-5 * k, 5 * k);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
    // машина
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = car.wrecked ? '#888' : '#ffffff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(6, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, W / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();
  }
}
