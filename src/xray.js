import * as THREE from 'three';

/**
 * «Рентген» сквозь кроны: машины и пешеходы за деревьями видны контуром-сеткой.
 * После обычного кадра кроны ещё раз рисуются в трафарет (только там, где их видно),
 * затем машины и пешеходы — проволокой поверх, но только в тех пикселях и только там, где их заслонила крона.
 */
export const XRAY = {
  near: 70, // м — до сих пор видно в полную силу
  far: 95, // м — дальше не видно совсем
  mask: 1, // слой: кроны деревьев
  car: 2, // слой: машины
  ped: 3, // слой: пешеходы
};

/** Прозрачность гаснет с расстоянием до камеры. */
function fadeByDistance(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uXrayNear = { value: XRAY.near };
    sh.uniforms.uXrayFar = { value: XRAY.far };
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', 'varying float vXrayD;\nvoid main() {')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 xw = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          xw = instanceMatrix * xw;
        #endif
        vXrayD = distance((modelMatrix * xw).xyz, cameraPosition);`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'uniform float uXrayNear;\nuniform float uXrayFar;\nvarying float vXrayD;\nvoid main() {')
      .replace('#include <color_fragment>', '') // без цвета одежды/экземпляров — ровный тон
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.a *= 1.0 - smoothstep(uXrayNear, uXrayFar, vXrayD);');
  };
  mat.customProgramCacheKey = () => 'xray-fade';
  return mat;
}

function behindMat(color, wireframe, opacity) {
  return fadeByDistance(new THREE.MeshBasicMaterial({
    color,
    wireframe,
    opacity,
    transparent: true,
    depthWrite: false,
    depthFunc: THREE.GreaterDepth, // только то, что заслонено
    fog: false,
    toneMapped: false,
    stencilWrite: true, // трафарет только читаем: рисуем, где крона (=1)
    stencilRef: 1,
    stencilFunc: THREE.EqualStencilFunc,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.KeepStencilOp,
    stencilWriteMask: 0,
  }));
}

export class Xray {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.enabled = true;
    // кроны: в трафарет 1 там, где крона — ближайшее к камере (цвет и глубину не трогаем)
    this.maskMat = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
      fog: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilZPass: THREE.ReplaceStencilOp,
    });
    this.passes = [
      [XRAY.car, behindMat(0xff5a2a, false, 0.16)],
      [XRAY.car, behindMat(0xffb08a, true, 0.75)],
      [XRAY.ped, behindMat(0xffe14a, false, 0.22)],
      [XRAY.ped, behindMat(0xfff3a8, true, 0.85)],
    ];
  }

  /** Вызывать сразу после обычного renderer.render(scene, camera). */
  render(camera) {
    if (!this.enabled) return;
    const r = this.renderer, s = this.scene;
    const cam = camera, layers = cam.layers.mask;
    const bg = s.background, autoClear = r.autoClear, shadows = r.shadowMap.autoUpdate;
    s.background = null; // цветной фон иначе заново очистит кадр
    r.autoClear = false;
    r.shadowMap.autoUpdate = false;
    try {
      r.clearStencil();
      s.overrideMaterial = this.maskMat;
      cam.layers.set(XRAY.mask);
      r.render(s, cam);
      for (const [layer, mat] of this.passes) {
        s.overrideMaterial = mat;
        cam.layers.set(layer);
        r.render(s, cam);
      }
    } finally {
      s.overrideMaterial = null;
      s.background = bg;
      cam.layers.mask = layers;
      r.autoClear = autoClear;
      r.shadowMap.autoUpdate = shadows;
    }
  }
}
