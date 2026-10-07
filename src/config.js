const params = new URLSearchParams(location.search);

const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
const noHover = window.matchMedia?.('(hover: none)').matches ?? false;

/** Устройство с тач-экраном без мыши (телефон/планшет). */
export const IS_TOUCH = coarse || (navigator.maxTouchPoints > 0 && noHover);

const qParam = params.get('q');
const LOW = qParam ? qParam === 'low' : IS_TOUCH;

export const QUALITY = {
  low: LOW,
  shadows: !LOW,
  antialias: !LOW,
  pixelRatio: Math.min(window.devicePixelRatio || 1, LOW ? 1.5 : 2),
  pedCount: Number(params.get('peds')) || (LOW ? 45 : 70),
  maxParticles: LOW ? 1500 : 3000,
  maxDecals: LOW ? 350 : 700,
  maxMarks: LOW ? 400 : 900,
};

export const CITY = {
  blocks: 6, // кварталов по каждой оси
  block: 46, // размер квартала вместе с тротуаром, м
  road: 14, // ширина дороги, м
  sidewalk: 4, // ширина тротуара, м
  curb: 0.15, // высота бордюра, м
};

export const DEBUG = params.has('debug');
