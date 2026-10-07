/**
 * Весь звук синтезируется WebAudio на лету — никаких файлов.
 */
export class AudioFX {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.volume = 0.7;
    this._lastScream = 0;
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
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master.connect(comp);
    comp.connect(ctx.destination);

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
    this.engFilter.connect(this.engGain).connect(this.master);
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
    this.skidSrc.connect(bp).connect(this.skidGain).connect(this.master);
    this.skidSrc.start();
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
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
    const gears = [0, 9, 17, 25, 33, 60];
    let gi = 0;
    while (gi < gears.length - 2 && speed > gears[gi + 1]) gi++;
    const rpm = Math.min(1, Math.max(0, (speed - gears[gi]) / (gears[gi + 1] - gears[gi])));
    const f = 42 + rpm * 62 + gi * 7 + throttle * 10;
    this.eng1.frequency.setTargetAtTime(f, t, 0.06);
    this.eng2.frequency.setTargetAtTime(f * 0.505, t, 0.06);
    this.engFilter.frequency.setTargetAtTime(380 + rpm * 900 + throttle * 700, t, 0.08);
    this.engGain.gain.setTargetAtTime(running ? 0.06 + throttle * 0.07 : 0, t, 0.1);
  }

  skid(amount) {
    if (!this.ready) return;
    this.skidGain.gain.setTargetAtTime(Math.min(0.22, amount * 0.22), this.ctx.currentTime, 0.06);
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
    src.connect(f).connect(g).connect(this.master);
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
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  shot() {
    if (!this.ready) return;
    this._noise({ dur: 0.09, gain: 0.32, type: 'bandpass', freq: 1800, freqEnd: 500, q: 0.8 });
    this._tone({ freq: 160, freqEnd: 45, dur: 0.08, gain: 0.35 });
  }

  splat(intensity = 1) {
    if (!this.ready) return;
    const i = Math.min(1.2, intensity);
    this._noise({ dur: 0.35, gain: 0.55 * i, type: 'lowpass', freq: 700, freqEnd: 150 });
    this._noise({ dur: 0.14, gain: 0.25 * i, type: 'bandpass', freq: 1100, freqEnd: 500, q: 4, delay: 0.02 });
    this._tone({ freq: 120, freqEnd: 35, dur: 0.25, gain: 0.55 * i });
  }

  crunch() {
    if (!this.ready) return;
    this._noise({ dur: 0.16, gain: 0.3, type: 'bandpass', freq: 500, freqEnd: 250, q: 2 });
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

  glass() {
    if (!this.ready) return;
    for (let k = 0; k < 5; k++) {
      this._tone({ freq: 2200 + Math.random() * 2500, dur: 0.15, gain: 0.05, delay: k * 0.03 });
    }
    this._noise({ dur: 0.25, gain: 0.25, type: 'highpass', freq: 4000 });
  }

  explosion() {
    if (!this.ready) return;
    this._noise({ dur: 2.0, gain: 1.3, type: 'lowpass', freq: 2200, freqEnd: 60 });
    this._tone({ freq: 65, freqEnd: 22, dur: 1.4, gain: 1.0 });
    for (let k = 0; k < 6; k++) this._noise({ dur: 0.12, gain: 0.25, type: 'bandpass', freq: 900, q: 1, delay: 0.25 + Math.random() * 1.2 });
  }

  impact() {
    if (!this.ready) return;
    this._noise({ dur: 0.06, gain: 0.12, type: 'highpass', freq: 3000 });
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
    g.connect(this.master);
    o.start(t);
    lfo.start(t);
    o.stop(t + 0.7);
    lfo.stop(t + 0.7);
  }
}
