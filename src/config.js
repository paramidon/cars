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
  pedCount: Number(params.get('peds')) || (LOW ? 54 : 84),
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
/** `?mute` — начать без звука, не меняя сохранённых настроек (удобно для автотестов). */
export const MUTE = params.has('mute');
/** `?map=test` — тестовый полигон: пустая площадка с парой домов, неподвижные пешеходы, без соперников и победы. */
export const TEST_MAP = params.get('map') === 'test';
/**
 * `?phys=rapier` (only with `?map=test`) — the player's car on the rigid-body engine Rapier, plus ramps, the tube and
 * the deck on the test ground. Work in progress (PHYSICS_PLAN.md); the city and the network keep the old physics.
 */
export const PHYS_RAPIER = TEST_MAP && params.get('phys') === 'rapier';
