import * as THREE from 'three';
import { mulberry32 } from '../utils.js';

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTexture(c, { repeat = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function speckle(g, w, h, n, rng, colors, maxR = 1.5) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[Math.floor(rng() * colors.length)];
    const r = 0.5 + rng() * maxR;
    g.fillRect(rng() * w, rng() * h, r, r);
  }
}

const pickR = (rng, arr) => arr[Math.floor(rng() * arr.length)];

/** Фасады. Белая основа тонируется вертекс-цветом здания. */
export function facadeTexture(style) {
  const rng = mulberry32(style.length * 977 + 13);

  if (style === 'apartment') {
    // 4 окна × 4 этажа, плитка 12 × 12.8 м
    const c = makeCanvas(256, 256);
    const g = c.getContext('2d');
    g.fillStyle = '#efefef';
    g.fillRect(0, 0, 256, 256);
    speckle(g, 256, 256, 1800, rng, ['#e0e0e0', '#f9f9f9', '#d8d8d8']);
    for (let r = 0; r < 4; r++) {
      for (let col = 0; col < 4; col++) {
        const x = col * 64;
        const y = r * 64;
        g.fillStyle = 'rgba(0,0,0,0.10)';
        g.fillRect(x, y + 59, 64, 5);
        const lit = rng() < 0.12;
        const wx = x + 15, wy = y + 12, ww = 34, wh = 36;
        g.fillStyle = '#cfcfcf';
        g.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);
        const grad = g.createLinearGradient(wx, wy, wx + ww, wy + wh);
        if (lit) {
          grad.addColorStop(0, '#f8e2a4');
          grad.addColorStop(1, '#d6a35a');
        } else {
          const b = 35 + rng() * 40;
          grad.addColorStop(0, `rgb(${b + 40},${b + 60},${b + 80})`);
          grad.addColorStop(1, `rgb(${b},${b + 12},${b + 28})`);
        }
        g.fillStyle = grad;
        g.fillRect(wx, wy, ww, wh);
        if (!lit && rng() < 0.35) {
          g.fillStyle = pickR(rng, ['#c9b79c', '#b88c8c', '#9cb4c9', '#d8d0c0']);
          g.fillRect(wx + (rng() < 0.5 ? 0 : ww * 0.7), wy, ww * 0.3, wh);
        }
        g.fillStyle = '#bdbdbd';
        g.fillRect(wx + ww / 2 - 1.5, wy, 3, wh);
        g.fillRect(wx, wy + wh * 0.32, ww, 2);
        g.fillStyle = '#8f8f8f';
        g.fillRect(wx - 5, wy + wh + 3, ww + 10, 4);
        if (rng() < 0.18) {
          // балкон
          g.fillStyle = '#a9a9a9';
          g.fillRect(wx - 6, wy + wh - 8, ww + 12, 12);
          g.fillStyle = 'rgba(0,0,0,0.25)';
          for (let k = 0; k < 7; k++) g.fillRect(wx - 4 + k * 7, wy + wh - 8, 2, 12);
        }
      }
    }
    return toTexture(c);
  }

  if (style === 'office') {
    // стеклянная башня 4 × 4 панели, плитка 12 × 14 м
    const c = makeCanvas(256, 256);
    const g = c.getContext('2d');
    g.fillStyle = '#b9c3cc';
    g.fillRect(0, 0, 256, 256);
    for (let r = 0; r < 4; r++) {
      for (let col = 0; col < 4; col++) {
        const x = col * 64, y = r * 64;
        const k = rng();
        const grad = g.createLinearGradient(x, y, x + 64, y + 50);
        if (k < 0.06) {
          grad.addColorStop(0, '#f3e3b0');
          grad.addColorStop(1, '#c9a868');
        } else {
          const b = 0.75 + rng() * 0.35;
          grad.addColorStop(0, `rgb(${110 * b},${150 * b},${185 * b})`);
          grad.addColorStop(1, `rgb(${40 * b},${70 * b},${100 * b})`);
        }
        g.fillStyle = grad;
        g.fillRect(x + 3, y + 3, 58, 47);
        g.fillStyle = '#8994a0';
        g.fillRect(x, y + 52, 64, 12);
        g.fillStyle = 'rgba(0,0,0,0.12)';
        g.fillRect(x + 31, y + 3, 2, 47);
      }
    }
    // блики
    g.globalAlpha = 0.12;
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 6; i++) {
      const x = rng() * 256;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + 30, 0);
      g.lineTo(x - 60, 256);
      g.lineTo(x - 90, 256);
      g.fill();
    }
    g.globalAlpha = 1;
    return toTexture(c);
  }

  if (style === 'shop') {
    // 2 витрины × 1 этаж, плитка 8 × 4.5 м
    const c = makeCanvas(256, 128);
    const g = c.getContext('2d');
    g.fillStyle = '#eeeeee';
    g.fillRect(0, 0, 256, 128);
    speckle(g, 256, 128, 600, rng, ['#e2e2e2', '#f7f7f7']);
    for (let bay = 0; bay < 2; bay++) {
      const x = bay * 128;
      g.fillStyle = pickR(rng, ['#c0392b', '#2471a3', '#1e8449', '#d4ac0d', '#7d3c98', '#ca6f1e']);
      g.fillRect(x + 8, 8, 112, 22);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      for (let k = 0; k < 6; k++) g.fillRect(x + 20 + k * 15, 14, 9, 10);
      const grad = g.createLinearGradient(x, 40, x + 100, 120);
      grad.addColorStop(0, '#6d8aa0');
      grad.addColorStop(1, '#22323f');
      g.fillStyle = '#9a9a9a';
      g.fillRect(x + 7, 37, 114, 84);
      g.fillStyle = grad;
      g.fillRect(x + 10, 40, 108, 78);
      g.fillStyle = 'rgba(255,255,255,0.15)';
      g.fillRect(x + 20, 44, 14, 70);
      g.fillStyle = '#7a7a7a';
      g.fillRect(x + 62, 40, 3, 78);
      if (bay === 0) {
        g.fillStyle = '#3b2a20';
        g.fillRect(x + 86, 54, 26, 64);
        g.fillStyle = '#d4b04c';
        g.fillRect(x + 90, 86, 3, 6);
      }
    }
    g.fillStyle = '#7d7d7d';
    g.fillRect(0, 120, 256, 8);
    return toTexture(c);
  }

  // house: 2 окна × 1 этаж, плитка 6 × 3 м
  const c = makeCanvas(128, 128);
  const g = c.getContext('2d');
  g.fillStyle = '#f4f4f4';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = 'rgba(0,0,0,0.06)';
  for (let y = 0; y < 128; y += 8) g.fillRect(0, y, 128, 2);
  for (let w = 0; w < 2; w++) {
    const x = w * 64 + 16, y = 32;
    const sh = pickR(rng, ['#2e5e3b', '#6b3b2a', '#2f4f7f']);
    g.fillStyle = sh;
    g.fillRect(x - 9, y, 8, 44);
    g.fillRect(x + 33, y, 8, 44);
    g.fillStyle = '#ffffff';
    g.fillRect(x - 2, y - 2, 36, 48);
    const grad = g.createLinearGradient(x, y, x + 32, y + 44);
    grad.addColorStop(0, '#89a9c4');
    grad.addColorStop(1, '#30475c');
    g.fillStyle = grad;
    g.fillRect(x, y, 32, 44);
    g.fillStyle = '#ffffff';
    g.fillRect(x + 15, y, 2, 44);
    g.fillRect(x, y + 20, 32, 2);
  }
  return toTexture(c);
}

export function asphaltTexture() {
  const rng = mulberry32(99);
  const c = makeCanvas(256, 256);
  const g = c.getContext('2d');
  g.fillStyle = '#4b4b50';
  g.fillRect(0, 0, 256, 256);
  speckle(g, 256, 256, 6000, rng, ['#55555a', '#424246', '#5d5d62', '#3c3c40'], 1.6);
  g.strokeStyle = 'rgba(25,25,28,0.35)';
  g.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    g.beginPath();
    let x = rng() * 256, y = rng() * 256;
    g.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += (rng() - 0.5) * 40;
      y += (rng() - 0.5) * 40;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  return toTexture(c);
}

export function tilesTexture() {
  const rng = mulberry32(5);
  const c = makeCanvas(256, 256);
  const g = c.getContext('2d');
  g.fillStyle = '#c4c0b7';
  g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const v = 185 + rng() * 20;
      g.fillStyle = `rgb(${v},${v - 4},${v - 12})`;
      g.fillRect(x * 64 + 2, y * 64 + 2, 60, 60);
    }
  }
  speckle(g, 256, 256, 2500, rng, ['#aaa59c', '#d2cec6', '#b3afa6'], 1.2);
  return toTexture(c);
}

export function grassTexture() {
  const rng = mulberry32(17);
  const c = makeCanvas(256, 256);
  const g = c.getContext('2d');
  g.fillStyle = '#6a9a43';
  g.fillRect(0, 0, 256, 256);
  const cols = ['#5c8a38', '#78a84e', '#4f7c30', '#86b35a', '#6b9440'];
  for (let i = 0; i < 4000; i++) {
    g.strokeStyle = cols[Math.floor(rng() * cols.length)];
    const x = rng() * 256, y = rng() * 256;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rng() - 0.5) * 3, y - 2 - rng() * 4);
    g.stroke();
  }
  return toTexture(c);
}

export function roofTexture() {
  const rng = mulberry32(31);
  const c = makeCanvas(128, 128);
  const g = c.getContext('2d');
  g.fillStyle = '#d0d0d0';
  g.fillRect(0, 0, 128, 128);
  speckle(g, 128, 128, 1500, rng, ['#bdbdbd', '#e0e0e0', '#b0b0b0'], 1.5);
  g.fillStyle = 'rgba(0,0,0,0.07)';
  for (let i = 0; i < 128; i += 32) {
    g.fillRect(i, 0, 1, 128);
    g.fillRect(0, i, 128, 1);
  }
  return toTexture(c);
}

/** Кровавая клякса — для луж и брызг на земле/стенах. */
export function bloodTexture() {
  const rng = mulberry32(7);
  const c = makeCanvas(256, 256);
  const g = c.getContext('2d');
  const blob = (x, y, r) => {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  g.fillStyle = '#ffffff';
  for (let i = 0; i < 16; i++) {
    const a = rng() * Math.PI * 2, d = rng() * 34;
    blob(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 16 + rng() * 30);
  }
  // потёки-лучи
  for (let i = 0; i < 9; i++) {
    const a = rng() * Math.PI * 2;
    const len = 50 + rng() * 55;
    for (let k = 0; k < 12; k++) {
      const t = k / 12;
      blob(128 + Math.cos(a) * len * t, 128 + Math.sin(a) * len * t, (1 - t) * 9 + 2);
    }
  }
  for (let i = 0; i < 45; i++) {
    const a = rng() * Math.PI * 2, d = 55 + rng() * 62;
    blob(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 1.5 + rng() * 6);
  }
  // тон: тёмная середина, ярче по краям
  g.globalCompositeOperation = 'source-atop';
  const grad = g.createRadialGradient(128, 128, 10, 128, 128, 128);
  grad.addColorStop(0, '#5e0000');
  grad.addColorStop(0.5, '#8a0303');
  grad.addColorStop(1, '#b10f0f');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  g.globalCompositeOperation = 'source-over';
  const t = toTexture(c, { repeat: false });
  return t;
}

/** Мягкая полоса для следов шин. */
export function markTexture() {
  const c = makeCanvas(32, 64);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 32, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.75, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 64);
  g.globalCompositeOperation = 'destination-in';
  const v = g.createLinearGradient(0, 0, 0, 64);
  v.addColorStop(0, 'rgba(0,0,0,0.3)');
  v.addColorStop(0.2, 'rgba(0,0,0,1)');
  v.addColorStop(0.8, 'rgba(0,0,0,1)');
  v.addColorStop(1, 'rgba(0,0,0,0.3)');
  g.fillStyle = v;
  g.fillRect(0, 0, 32, 64);
  return toTexture(c, { repeat: false });
}

export function flashTexture() {
  const c = makeCanvas(64, 64);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,230,1)');
  grad.addColorStop(0.25, 'rgba(255,210,90,0.9)');
  grad.addColorStop(1, 'rgba(255,120,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(255,240,180,0.9)';
  for (let i = 0; i < 6; i++) {
    g.save();
    g.translate(32, 32);
    g.rotate((i / 6) * Math.PI * 2);
    g.beginPath();
    g.moveTo(-3, 0);
    g.lineTo(0, -31);
    g.lineTo(3, 0);
    g.fill();
    g.restore();
  }
  return toTexture(c, { repeat: false });
}

export function blobShadowTexture() {
  const c = makeCanvas(64, 64);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.6)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return toTexture(c, { repeat: false });
}
