import { ST } from './pedestrians.js';
import { rand } from './utils.js';
import { RACE } from './race.js';

const $ = (id) => document.getElementById(id);
const STANDINGS_MAX = 10; // строк в таблице участников на экране

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
      gunName: $('gun-name'),
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

  /** Убрать следы прошлого заезда: надписи, кровь на экране, отсчёт. */
  reset() {
    this.el.messages.replaceChildren();
    this.splatAlpha = 0;
    this.splat.style.opacity = 0;
    this.splatCtx.clearRect(0, 0, this.splat.width, this.splat.height);
    this.flashT = 0;
    this.vignette.style.opacity = 0;
    const cd = this.el.countdown;
    cd.classList.remove('show', 'go');
    cd.textContent = '';
  }

  update(dt, game) {
    const { car } = game;
    this._set('score', this.el.score, game.teamScore().toLocaleString('ru-RU'));
    this._set('kills', this.el.kills, `${game.teamKills()}/${RACE.goreWin}`);
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
    const zone = game.royale ? game.zone : null;
    const t = zone ? zone.timeLeft : race.timeLeft;
    const clock = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const out = zone && zone.outside(car.x, car.z);
    const txt = zone ? (t > 0 ? `ЗОНА ${clock}` : 'ЗОНА СЖАТА') : t < 10 ? t.toFixed(1) : clock;
    this._set('rt', this.el.raceTime, txt);
    const low = zone ? out : t < 10 && !race.done;
    if (this.cache.low !== low) {
      this.cache.low = low;
      this.el.race.classList.toggle('low', low);
    }
    this._set('rl', this.el.raceLap, `КРУГ ${Math.min(race.lap, game.raceLaps)}/${game.raceLaps}`);
    this._set('rp', this.el.racePos, `${game.position}/${game.cars.length}`);
    this._set('re', this.el.raceEnemies, String(game._enemies().filter((c) => !c.wrecked).length));
    // оружие: перезарядка пушки или нагрев пулемёта
    const w = game.weaponInfo();
    const p = Math.round(w.p * 20) / 20;
    const key = `${w.name}${p}${w.ready}${w.hot}`;
    if (this.cache.gun !== key) {
      this.cache.gun = key;
      for (const el of [this.el.gun, this.el.fire]) {
        el.style.setProperty('--p', p);
        el.classList.toggle('ready', w.ready);
        el.classList.toggle('hot', w.hot);
      }
      this.el.gunName.textContent = w.hot ? 'ПЕРЕГРЕВ' : w.name;
      this.el.fire.textContent = w.name;
    }
    if (this.frame % 10 === 0) this._standings(game);
    if (zone) {
      // битва: стрелка — на середину зоны, расстояние — до её края
      this._set('rc', this.el.raceCp, out ? 'ВНЕ ЗОНЫ!' : 'В ЗОНЕ');
      const dx = zone.cx - car.x, dz = zone.cz - car.z;
      const s = Math.sin(car.yaw), c = Math.cos(car.yaw);
      const ang = Math.atan2(dx * -c + dz * s, dx * s + dz * c);
      this.el.raceArrow.style.transform = `rotate(${ang.toFixed(3)}rad)`;
      const edge = Math.abs(Math.hypot(dx, dz) - zone.radius);
      this._set('rd', this.el.raceDist, out ? `${Math.round(edge)} м до зоны` : `${Math.round(edge)} м до края`);
      return;
    }
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
    const key = game.standings.map((e) => `${e.name}${e.car.wrecked ? 'x' : ''}${e.finished ? 'f' : ''}${e.car.kills}`).join('|');
    if (key === this.cache.standings) return;
    this.cache.standings = key;
    // в битве до 20 машин — показываем первых, а себя всегда (последней строкой, если не попал в первые)
    const rows = game.standings.map((e, i) => [e, i]);
    const top = rows.slice(0, STANDINGS_MAX);
    const me = rows.find(([e]) => e.player);
    if (me && !top.includes(me)) top[STANDINGS_MAX - 1] = me;
    this.el.standings.innerHTML = top
      .map(([e, i]) => {
        const note = e.finished ? ' ✓' : e.car.wrecked ? ' ✕' : '';
        return `<div class="${e.player ? 'me' : ''}${e.car.wrecked ? ' out' : ''}"><i style="background:${e.color}"></i>${i + 1}. ${e.name}${note}<small title="сбито пешеходов">${e.car.kills}</small></div>`;
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
    ctx.drawImage(game.royale && mm.plain ? mm.plain : mm.canvas, 0, 0);
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
    // зона королевской битвы — красный круг
    if (game.royale && game.zone.active) {
      const z = game.zone;
      const [zx, zy] = toScreen(z.cx, z.cz);
      ctx.strokeStyle = 'rgba(255, 70, 40, 0.95)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(zx, zy, Math.max(1, z.radius * scale), 0, Math.PI * 2);
      ctx.stroke();
    }
    // следующий и последующий чекпоинты; если далеко — метка на краю круга
    const race = game.race;
    const R = W / 2 - 9;
    const marks = [[race.cps[(race.next + 1) % race.cps.length], 0.45], [race.target, 1]];
    for (const [cp, alpha] of marks) {
      if (!cp || race.done || game.royale) continue;
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
    // соперники (боты и люди по сети) — цветные стрелки; далеко — на краю круга
    for (const rc of game.cars) {
      if (rc === car) continue;
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
      ctx.fillStyle = rc.wrecked ? '#555' : rc.opts.color;
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
