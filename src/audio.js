const SETTINGS_KEY = 'cars-and-guts:sound';

/** Положения ползунков 0..1 (громкость = положение², так ползунок ближе к слуху). */
export const SOUND_DEFAULTS = { master: 0.85, engine: 1, sfx: 1, muted: false };

const gainOf = (v) => v * v;

/**
 * Весь звук синтезируется WebAudio на лету — никаких файлов.
 * Три шины: мотор и шины, эффекты (всё остальное) и общая громкость.
 */
export class AudioFX {
  /** forceMute — начать без звука и не трогать сохранённые настройки (`?mute`, автотесты). */
  constructor({ forceMute = false } = {}) {
    this.ctx = null;
    this.settings = { ...SOUND_DEFAULTS, ...this._load() };
    this.persist = !forceMute;
    if (forceMute) this.settings.muted = true;
    this.engineOn = false; // мотор слышен только в заезде, не в меню и не на паузе
    this._previewUntil = 0;
    this._previewAt = 0;
    this._lastScream = 0;
  }

  _load() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      if (!s || typeof s !== 'object') return {};
      const out = {};
      for (const k of ['master', 'engine', 'sfx']) if (Number.isFinite(s[k])) out[k] = Math.min(1, Math.max(0, s[k]));
      if (typeof s.muted === 'boolean') out.muted = s.muted;
      return out;
    } catch {
      return {};
    }
  }

  _save() {
    if (!this.persist) return;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // хранилище недоступно (приватный режим) — настройки живут до перезагрузки
    }
  }

  get muted() {
    return this.settings.muted;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master.connect(comp);
    comp.connect(ctx.destination);
    this.engineBus = ctx.createGain();
    this.engineBus.connect(this.master);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this._apply(true);

    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // двигатель
    this.eng1 = ctx.createOscillator();
    this.eng1.type = 'sawtooth';
    this.eng2 = ctx.createOscillator();
    this.eng2.type = 'square';
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 600;
    this.engFilter.Q.value = 3;
    const g2 = ctx.createGain();
    g2.gain.value = 0.5;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.eng1.connect(this.engFilter);
    this.eng2.connect(g2).connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(this.engineBus);
    this.eng1.frequency.value = 40;
    this.eng2.frequency.value = 20;
    this.eng1.start();
    this.eng2.start();

    // визг шин
    this.skidSrc = ctx.createBufferSource();
    this.skidSrc.buffer = this.noise;
    this.skidSrc.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1700;
    bp.Q.value = 2.5;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    this.skidSrc.connect(bp).connect(this.skidGain).connect(this.engineBus);
    this.skidSrc.start();
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  _apply(now = false) {
    if (!this.ctx) return;
    const s = this.settings;
    const t = this.ctx.currentTime;
    const set = (node, v) => {
      if (now) node.gain.value = v;
      else node.gain.setTargetAtTime(v, t, 0.04);
    };
    set(this.master, s.muted ? 0 : gainOf(s.master));
    set(this.engineBus, gainOf(s.engine));
    set(this.sfx, gainOf(s.sfx));
  }

  setMuted(m) {
    this.settings.muted = !!m;
    this._apply();
    this._save();
  }

  /** Громкость шины: 'master' | 'engine' | 'sfx', значение 0..1. */
  setVolume(bus, v) {
    if (!(bus in SOUND_DEFAULTS) || bus === 'muted') return;
    this.settings[bus] = Math.min(1, Math.max(0, v));
    this._apply();
    this._save();
  }

  /** Мотор и визг шин — только пока идёт заезд. */
  setEngineOn(on) {
    if (this.engineOn === on) return;
    this.engineOn = on;
    if (on || !this.ctx) return;
    const t = this.ctx.currentTime;
    if (t < this._previewUntil) return;
    this.engGain.gain.cancelScheduledValues(t);
    this.engGain.gain.setTargetAtTime(0, t, 0.12);
    this.skidGain.gain.setTargetAtTime(0, t, 0.05);
  }

  /** Короткий пример звука при движении ползунка. */
  preview(bus) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    if (t - this._previewAt < 0.35) return;
    this._previewAt = t;
    if (bus === 'engine') {
      // перегазовка на месте
      this._previewUntil = t + 1.1;
      const rev = (param, lo, hi) => {
        param.cancelScheduledValues(t);
        param.setTargetAtTime(hi, t, 0.12);
        param.setTargetAtTime(lo, t + 0.45, 0.18);
      };
      rev(this.eng1.frequency, 46, 96);
      rev(this.eng2.frequency, 23, 48);
      rev(this.engFilter.frequency, 450, 1500);
      const g = this.engGain.gain;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(0.12, t, 0.05);
      g.setTargetAtTime(0, t + 0.8, 0.12);
    } else if (bus === 'sfx') this.splat(0.8);
    else this.checkpoint();
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume();
  }

  engine(speed, throttle, running) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    if (t < this._previewUntil) return; // не перебивать пример громкости
    const gears = [0, 9, 17, 25, 33, 60];
    let gi = 0;
    while (gi < gears.length - 2 && speed > gears[gi + 1]) gi++;
    const rpm = Math.min(1, Math.max(0, (speed - gears[gi]) / (gears[gi + 1] - gears[gi])));
    const f = 42 + rpm * 62 + gi * 7 + throttle * 10;
    this.eng1.frequency.setTargetAtTime(f, t, 0.06);
    this.eng2.frequency.setTargetAtTime(f * 0.505, t, 0.06);
    this.engFilter.frequency.setTargetAtTime(380 + rpm * 900 + throttle * 700, t, 0.08);
    this.engGain.gain.setTargetAtTime(running && this.engineOn ? 0.06 + throttle * 0.07 : 0, t, 0.1);
  }

  skid(amount) {
    if (!this.ready) return;
    const v = this.engineOn ? Math.min(0.22, amount * 0.22) : 0;
    this.skidGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.06);
  }

  _noise({ dur, gain, type = 'lowpass', freq = 1000, freqEnd = freq, q = 1, delay = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.sfx);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  _tone({ type = 'sine', freq, freqEnd = freq, dur, gain, delay = 0, attack = 0.005 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(10, freqEnd), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Разбилась бутылка с коктейлем: звон и вспыхнувшее пламя. */
  molotov(v = 1) {
    if (!this.ready || v < 0.03) return;
    this.glass(v);
    this._noise({ dur: 0.7, gain: 0.5 * v, type: 'lowpass', freq: 900, freqEnd: 200 });
  }

  /** Выстрел пулемёта. */
  shot(v = 1) {
    if (!this.ready || v < 0.03) return;
    this._noise({ dur: 0.09, gain: 0.32 * v, type: 'bandpass', freq: 1800, freqEnd: 500, q: 0.8 });
    this._tone({ freq: 160, freqEnd: 45, dur: 0.08, gain: 0.35 * v });
  }

  splat(intensity = 1) {
    if (!this.ready) return;
    const i = Math.min(1.2, intensity);
    this._noise({ dur: 0.35, gain: 0.55 * i, type: 'lowpass', freq: 700, freqEnd: 150 });
    this._noise({ dur: 0.14, gain: 0.25 * i, type: 'bandpass', freq: 1100, freqEnd: 500, q: 4, delay: 0.02 });
    this._tone({ freq: 120, freqEnd: 35, dur: 0.25, gain: 0.55 * i });
  }

  crunch(v = 1) {
    if (!this.ready || v < 0.03) return;
    this._noise({ dur: 0.16, gain: 0.3 * v, type: 'bandpass', freq: 500, freqEnd: 250, q: 2 });
  }

  crash(intensity = 1) {
    if (!this.ready) return;
    const i = Math.min(1.3, intensity);
    this._noise({ dur: 0.6, gain: 0.8 * i, type: 'lowpass', freq: 1500, freqEnd: 120 });
    this._tone({ freq: 80, freqEnd: 28, dur: 0.45, gain: 0.7 * i });
    for (const f of [313, 427, 589, 811]) {
      this._tone({ type: 'square', freq: f * (0.9 + Math.random() * 0.2), freqEnd: f * 0.8, dur: 0.3 + Math.random() * 0.3, gain: 0.03 * i });
    }
  }

  metal(intensity = 0.6) {
    if (!this.ready) return;
    this._tone({ type: 'triangle', freq: 700 + Math.random() * 400, freqEnd: 300, dur: 0.25, gain: 0.18 * intensity });
    this._noise({ dur: 0.12, gain: 0.25 * intensity, type: 'highpass', freq: 2500 });
  }

  glass(v = 1) {
    if (!this.ready) return;
    for (let k = 0; k < 5; k++) {
      this._tone({ freq: 2200 + Math.random() * 2500, dur: 0.15, gain: 0.05 * v, delay: k * 0.03 });
    }
    this._noise({ dur: 0.25, gain: 0.25 * v, type: 'highpass', freq: 4000 });
  }

  explosion(v = 1) {
    if (!this.ready) return;
    this._noise({ dur: 2.0, gain: 1.3 * v, type: 'lowpass', freq: 2200, freqEnd: 60 });
    this._tone({ freq: 65, freqEnd: 22, dur: 1.4, gain: 1.0 * v });
    for (let k = 0; k < 6; k++) this._noise({ dur: 0.12, gain: 0.25 * v, type: 'bandpass', freq: 900, q: 1, delay: 0.25 + Math.random() * 1.2 });
  }

  impact() {
    if (!this.ready) return;
    this._noise({ dur: 0.06, gain: 0.12, type: 'highpass', freq: 3000 });
  }

  /** Выстрел пушки. */
  cannon(v = 1) {
    if (!this.ready || v < 0.03) return;
    this._noise({ dur: 0.45, gain: 0.75 * v, type: 'lowpass', freq: 1600, freqEnd: 120 });
    this._tone({ freq: 110, freqEnd: 38, dur: 0.35, gain: 0.8 * v });
  }

  /** Разрыв снаряда. */
  boom(v = 1) {
    if (!this.ready || v < 0.03) return;
    this._noise({ dur: 1.0, gain: 1.0 * v, type: 'lowpass', freq: 2000, freqEnd: 70 });
    this._tone({ freq: 70, freqEnd: 26, dur: 0.7, gain: 0.85 * v });
    this._noise({ dur: 0.1, gain: 0.3 * v, type: 'bandpass', freq: 900, q: 1, delay: 0.12 });
  }

  /** 3-2-1 — короткие писки, старт — длинный высокий. */
  countdown(n) {
    if (!this.ready) return;
    if (n > 0) this._tone({ type: 'square', freq: 520, dur: 0.16, gain: 0.12 });
    else this._tone({ type: 'square', freq: 1040, dur: 0.5, gain: 0.14 });
  }

  checkpoint() {
    if (!this.ready) return;
    this._tone({ type: 'triangle', freq: 784, dur: 0.12, gain: 0.25 });
    this._tone({ type: 'triangle', freq: 1175, dur: 0.25, gain: 0.25, delay: 0.09 });
  }

  lap() {
    if (!this.ready) return;
    [523, 659, 784, 1047].forEach((f, i) => this._tone({ type: 'triangle', freq: f, dur: 0.22, gain: 0.22, delay: i * 0.09 }));
  }

  finish() {
    if (!this.ready) return;
    [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this._tone({ type: 'square', freq: f, dur: i === 5 ? 0.8 : 0.18, gain: 0.12, delay: i * 0.13 }));
  }

  timeout() {
    if (!this.ready) return;
    this._tone({ type: 'sawtooth', freq: 320, freqEnd: 70, dur: 1.1, gain: 0.3 });
  }

  /** Тиканье последних секунд: чем меньше осталось, тем выше. */
  tick(sec) {
    if (!this.ready) return;
    this._tone({ type: 'square', freq: 700 + (10 - sec) * 60, dur: 0.06, gain: 0.1 });
  }

  scream() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    if (now - this._lastScream < 0.35) return;
    this._lastScream = now;
    const ctx = this.ctx;
    const t = now;
    const base = 420 + Math.random() * 380;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(base, t);
    o.frequency.linearRampToValueAtTime(base * 1.3, t + 0.12);
    o.frequency.exponentialRampToValueAtTime(base * 0.7, t + 0.65);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 7 + Math.random() * 4;
    const lfoG = ctx.createGain();
    lfoG.gain.value = base * 0.05;
    lfo.connect(lfoG).connect(o.frequency);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 950;
    f1.Q.value = 4;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 2500;
    f2.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
    o.connect(f1).connect(g);
    o.connect(f2).connect(g);
    g.connect(this.sfx);
    o.start(t);
    lfo.start(t);
    o.stop(t + 0.7);
    lfo.stop(t + 0.7);
  }
}
