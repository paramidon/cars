import { clamp } from './utils.js';

const FIRE_KEYS = ['KeyF', 'KeyJ', 'KeyK', 'ControlLeft', 'ControlRight', 'ShiftRight'];
const BLOCK_DEFAULT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

/**
 * Единый ввод: клавиатура + мышь, сенсорный джойстик + кнопки, геймпад.
 * Результат — state: { throttle, brake, steer, handbrake, fire, aim, aimDX, lookBack }.
 * Для стрелка в башне: aim — скорость поворота −1…1 (клавиши, стик), aimDX — сдвиг мыши в пикселях
 * (мышь захватывается кликом, когда gunner = true).
 */
export class Input {
  constructor(canvas, touchUI) {
    this.canvas = canvas;
    this.keys = new Set();
    this.state = { throttle: 0, brake: 0, steer: 0, handbrake: false, fire: false, aim: 0, aimDX: 0, lookBack: false };
    this.gunner = false; // сидим в башне: клик захватывает мышь, пробел — тоже огонь
    this.aimDX = 0;
    this.mouse = { x: 0, y: 0, down: false, lastMove: -1e9, over: false };
    this.touch = { joyId: null, jx: 0, jy: 0, fire: false, brake: false };
    this.usingTouch = false;
    this.onAction = null; // (name) => void
    this.onTouchDetected = null;
    this._padPrev = [];

    window.addEventListener('keydown', (e) => {
      // печатают в поле (имя, адрес сервера в лобби) или крутят ползунки и галочки настроек звука —
      // стрелки и пробел им, а не машине; Esc всё равно закрывает экран
      if (e.target instanceof HTMLInputElement) {
        if (e.code === 'Escape' && !e.repeat) this._actionKey(e.code);
        return;
      }
      if (BLOCK_DEFAULT.has(e.code)) e.preventDefault();
      if (!e.repeat) this._actionKey(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouse.down = false;
      this._resetTouch();
    });

    canvas.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === canvas) this.aimDX += e.movementX;
      const r = canvas.getBoundingClientRect();
      this.mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      this.mouse.lastMove = performance.now();
      this.mouse.over = true;
    });
    canvas.addEventListener('mouseleave', () => (this.mouse.over = false));
    canvas.addEventListener('mousedown', (e) => {
      if (this.gunner && document.pointerLockElement !== canvas && !this.usingTouch) {
        try {
          canvas.requestPointerLock?.();
        } catch {
          // захват мыши запрещён — крутим башню клавишами
        }
      }
      if (e.button === 0) {
        this.mouse.down = true;
        this.mouse.lastMove = performance.now();
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.down = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('touchstart', () => this._markTouch(), { passive: true });
    document.addEventListener('gesturestart', (e) => e.preventDefault());

    if (touchUI) this._bindTouch(touchUI);
  }

  _markTouch() {
    if (!this.usingTouch) {
      this.usingTouch = true;
      if (this.onTouchDetected) this.onTouchDetected();
    }
  }

  _actionKey(code) {
    const map = { KeyC: 'camera', Escape: 'pause', KeyP: 'pause', KeyR: 'respawn', KeyM: 'mute', Enter: 'confirm' };
    if (map[code] && this.onAction) this.onAction(map[code]);
  }

  _resetTouch() {
    this.touch.joyId = null;
    this.touch.jx = 0;
    this.touch.jy = 0;
    this.touch.fire = false;
    this.touch.brake = false;
  }

  _bindTouch({ zone, base, knob, fire, brake }) {
    const R = 60;
    let cx = 0, cy = 0;
    const setKnob = (dx, dy) => {
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    zone.addEventListener('pointerdown', (e) => {
      if (this.touch.joyId !== null) return;
      this._markTouch();
      e.preventDefault();
      this.touch.joyId = e.pointerId;
      zone.setPointerCapture(e.pointerId);
      const zr = zone.getBoundingClientRect();
      cx = e.clientX;
      cy = e.clientY;
      base.style.left = `${cx - zr.left}px`;
      base.style.top = `${cy - zr.top}px`;
      base.classList.add('active');
      setKnob(0, 0);
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.touch.joyId) return;
      e.preventDefault();
      let dx = e.clientX - cx, dy = e.clientY - cy;
      const l = Math.hypot(dx, dy);
      if (l > R) {
        dx = (dx / l) * R;
        dy = (dy / l) * R;
      }
      this.touch.jx = dx / R;
      this.touch.jy = dy / R;
      setKnob(dx, dy);
    });
    const end = (e) => {
      if (e.pointerId !== this.touch.joyId) return;
      this.touch.joyId = null;
      this.touch.jx = 0;
      this.touch.jy = 0;
      base.classList.remove('active');
      setKnob(0, 0);
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);

    const hold = (el, key) => {
      const on = (e) => {
        e.preventDefault();
        this._markTouch();
        this.touch[key] = true;
        el.classList.add('pressed');
        el.setPointerCapture?.(e.pointerId);
      };
      const off = () => {
        this.touch[key] = false;
        el.classList.remove('pressed');
      };
      el.addEventListener('pointerdown', on);
      el.addEventListener('pointerup', off);
      el.addEventListener('pointercancel', off);
      el.addEventListener('lostpointercapture', off);
    };
    hold(fire, 'fire');
    hold(brake, 'brake');
  }

  update() {
    const k = this.keys;
    let thr = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    let brk = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    // руль с клавиш — сразу; плавность (на скорости руль туже) даёт сама машина, второе сглаживание тут
    // только добавляло задержку
    const right = k.has('KeyD') || k.has('ArrowRight') ? 1 : 0;
    const left = k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0;
    let steer = right - left;
    let hb = k.has('Space');
    let fire = this.mouse.down || FIRE_KEYS.some((c) => k.has(c)) || (this.gunner && k.has('Space'));
    const turnKeys = (k.has('KeyD') || k.has('ArrowRight') || k.has('KeyE') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') || k.has('KeyQ') ? 1 : 0);
    let aim = turnKeys;
    let back = k.has('KeyV'); // пока зажата — смотрим назад

    // сенсорный джойстик: направление стика ≈ куда ехать относительно машины
    if (this.touch.joyId !== null) {
      const jx = this.touch.jx, jy = this.touch.jy;
      const len = Math.hypot(jx, jy);
      if (len > 0.15) {
        const sx = Math.abs(jx) < 0.1 ? 0 : jx;
        steer = Math.sign(sx) * Math.pow(Math.abs(sx), 1.3);
        aim = steer;
        if (jy > 0.35) {
          brk = Math.max(brk, clamp(jy * 1.3, 0, 1));
        } else {
          thr = Math.max(thr, clamp(len * 1.25, 0, 1));
        }
      }
    }
    if (this.touch.fire) fire = true;
    if (this.touch.brake) hb = true;

    // геймпад
    let pad = null;
    try {
      // в некоторых встраиваниях Gamepad API запрещён и бросает исключение
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      pad = pads ? Array.from(pads).find((p) => p && p.connected) : null;
    } catch {
      pad = null;
    }
    if (pad) {
      const ax0 = pad.axes[0] || 0;
      if (Math.abs(ax0) > 0.15) steer = aim = ax0;
      const ax2 = pad.axes[2] || 0; // правый стик — башня
      if (Math.abs(ax2) > 0.15) aim = ax2;
      const b = (i) => pad.buttons[i] || { pressed: false, value: 0 };
      thr = Math.max(thr, b(7).value);
      brk = Math.max(brk, b(6).value);
      if (b(0).pressed) hb = true;
      if (b(4).pressed) back = true; // LB
      if (b(2).pressed || b(5).pressed) fire = true;
      const edges = [[3, 'camera'], [9, 'pause'], [8, 'respawn']];
      for (const [i, name] of edges) {
        const now = b(i).pressed;
        if (now && !this._padPrev[i] && this.onAction) this.onAction(name);
        this._padPrev[i] = now;
      }
    }

    const s = this.state;
    s.throttle = thr;
    s.brake = brk;
    s.steer = clamp(steer, -1, 1);
    s.handbrake = hb;
    s.fire = fire;
    s.aim = clamp(aim, -1, 1);
    s.aimDX = this.aimDX;
    s.lookBack = back;
    this.aimDX = 0;
    return s;
  }
}
