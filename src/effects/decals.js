import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qr = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Слой декалей (кровь, следы шин) на одном InstancedMesh.
 * Кольцевой буфер: новые декали вытесняют самые старые. Есть прозрачность на экземпляр.
 */
export class DecalLayer {
  constructor(scene, texture, max, { renderOrder = 1, receiveShadow = false } = {}) {
    this.max = max;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.opacity = new Float32Array(max);
    this.aOpacity = new THREE.InstancedBufferAttribute(this.opacity, 1);
    this.aOpacity.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('instanceOpacity', this.aOpacity);

    const mat = new THREE.MeshLambertMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float instanceOpacity;\nvarying float vInstOpacity;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstOpacity = instanceOpacity;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vInstOpacity;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vInstOpacity;');
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.receiveShadow = receiveShadow;
    this.mesh.count = 0;
    for (let i = 0; i < max; i++) this.mesh.setColorAt(i, _c.setRGB(1, 1, 1));
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    this.cursor = 0;
    this.used = 0;
    this.growing = [];
  }

  /** Декаль в точке (x,y,z) с нормалью n, размерами sx×sz и поворотом вокруг нормали. */
  add(x, y, z, nx, ny, nz, sx, sz, rot, r, g, b, opacity = 1) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.max;
    this.used = Math.min(this.max, this.used + 1);
    this.mesh.count = this.used;
    this._set(i, x, y, z, nx, ny, nz, sx, sz, rot);
    this.mesh.setColorAt(i, _c.setRGB(r, g, b));
    this.opacity[i] = opacity;
    this.aOpacity.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    // если декаль из растущих перезаписана — убрать её из списка
    for (let k = this.growing.length - 1; k >= 0; k--) if (this.growing[k].i === i) this.growing.splice(k, 1);
    return i;
  }

  _set(i, x, y, z, nx, ny, nz, sx, sz, rot) {
    _n.set(nx, ny, nz);
    if (ny > 0.999) _q.identity();
    else _q.setFromUnitVectors(UP, _n);
    _qr.setFromAxisAngle(UP, rot);
    _q.multiply(_qr);
    _m.compose(_p.set(x, y, z), _q, _s.set(sx, 1, sz));
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Растущая лужа на земле. */
  addGrowing(x, y, z, size, duration, r, g, b, opacity = 1) {
    const rot = Math.random() * Math.PI * 2;
    const i = this.add(x, y, z, 0, 1, 0, size * 0.25, size * 0.25, rot, r, g, b, opacity);
    this.growing.push({ i, x, y, z, size, t: 0, duration, rot });
  }

  update(dt) {
    for (let k = this.growing.length - 1; k >= 0; k--) {
      const gr = this.growing[k];
      gr.t += dt;
      const f = Math.min(1, gr.t / gr.duration);
      const s = gr.size * (0.25 + 0.75 * (1 - (1 - f) * (1 - f)));
      this._set(gr.i, gr.x, gr.y, gr.z, 0, 1, 0, s, s, gr.rot);
      if (f >= 1) this.growing.splice(k, 1);
    }
  }

  clear() {
    this.used = 0;
    this.cursor = 0;
    this.mesh.count = 0;
    this.growing.length = 0;
  }
}
