import * as THREE from 'three';
import { CITY } from '../config.js';
import { mulberry32, clamp } from '../utils.js';
import { GeoBuilder, addBox, addCyl, addBlob } from './geom.js';
import { CollisionWorld } from '../physics/collision.js';
import * as TX from './textures.js';
import { XRAY } from '../xray.js';

const col = (hex) => new THREE.Color(hex);

// размеры «плиток» фасадных текстур в метрах
const STYLE = {
  apartment: { tileW: 12, tileH: 12.8, floor: 3.2, snap: 3 },
  office: { tileW: 12, tileH: 14, floor: 3.5, snap: 3 },
  shop: { tileW: 8, tileH: 4.5, floor: 4.5, snap: 4 },
  house: { tileW: 6, tileH: 3, floor: 3, snap: 3 },
};

const APT_COLORS = ['#e8d8c0', '#d9b8a8', '#c9d6df', '#e6e1b8', '#d4c4e0', '#cfe0c8', '#f0e6dc', '#bfc9d1', '#e4c49c'];
const OFFICE_COLORS = ['#ffffff', '#dfe8f0', '#e8f0ff', '#f0f0e8', '#e0f0ea'];
const SHOP_COLORS = ['#f2d0a4', '#c8e6c9', '#ffccbc', '#d1c4e9', '#fff59d', '#b3e5fc', '#f8bbd0'];
const HOUSE_COLORS = ['#f5e6c8', '#e8c9a0', '#cfe3f0', '#f0d5d5', '#dde8c8', '#ffffff', '#e0d0b8'];
const ROOF_COLORS = ['#8b3a2b', '#6b4a3a', '#4a5560', '#9c4f30', '#5a3a2a', '#3f4a3a'];
const AWNING_COLORS = ['#c0392b', '#1f618d', '#239b56', '#b9770e', '#7d3c98', '#d35400'];
const LEAF_COLORS = ['#3f7a2e', '#4c8a34', '#5a9a3a', '#356b28', '#6aa443'];

export function buildCity(scene, quality) {
  const rng = mulberry32(20251);
  const R = (a, b) => a + rng() * (b - a);
  const RI = (a, b) => Math.floor(R(a, b + 1));
  const pickR = (arr) => arr[Math.floor(rng() * arr.length)];
  const snap = (v, s) => Math.max(s, Math.floor(v / s) * s);

  const N = CITY.blocks, B = CITY.block, RD = CITY.road, S = CITY.sidewalk, CURB = CITY.curb;
  const cell = B + RD;
  const half = (N * cell) / 2;
  const edge = half + RD / 2; // внешний край кольцевой дороги
  const outer = edge + 6; // внутренняя грань ограждающей стены
  const roads = [];
  for (let i = 0; i <= N; i++) roads.push(-half + i * cell);

  const world = new CollisionWorld(16);
  const g = {
    apartment: new GeoBuilder(),
    office: new GeoBuilder(),
    shop: new GeoBuilder(),
    house: new GeoBuilder(),
    roof: new GeoBuilder(),
    walk: new GeoBuilder(),
    grass: new GeoBuilder(),
    asphalt: new GeoBuilder(),
    props: new GeoBuilder(),
    foliage: new GeoBuilder(),
    marks: new GeoBuilder(),
  };
  const WHITE = col('#ffffff');
  const buildings = [];
  const blocks = [];
  const props = []; // ломаемые предметы: {type, x, z, yaw}
  const nodes = [];
  const trees = [];

  // ---------------------------------------------------------------- земля и границы
  g.asphalt.flat(-outer - 4, -outer - 4, outer + 4, outer + 4, 0, WHITE, 8);
  g.props.flat(-1400, -1400, 1400, 1400, -0.05, col('#76805f'), 1);

  const curbCol = col('#a9a59d');
  const curbFace = (ax, az, bx, bz, out) => {
    g.props.quad([ax, 0, az], [bx, 0, bz], [bx, CURB, bz], [ax, CURB, az], null, curbCol, out);
  };

  // внешний тротуар вдоль стены
  g.walk.flat(-outer, -outer, outer, -edge, CURB, WHITE, 4);
  g.walk.flat(-outer, edge, outer, outer, CURB, WHITE, 4);
  g.walk.flat(-outer, -edge, -edge, edge, CURB, WHITE, 4);
  g.walk.flat(edge, -edge, outer, edge, CURB, WHITE, 4);
  curbFace(-edge, -edge, edge, -edge, [0, 0, 1]);
  curbFace(-edge, edge, edge, edge, [0, 0, -1]);
  curbFace(-edge, -edge, -edge, edge, [1, 0, 0]);
  curbFace(edge, -edge, edge, edge, [-1, 0, 0]);

  // ограждающая стена
  const WALL_H = 5, WT = 1.2;
  const wallCol = col('#8e8a82');
  const span = 2 * outer + 2 * WT;
  addBox(g.props, 0, WALL_H / 2, -outer - WT / 2, span, WALL_H, WT, wallCol);
  addBox(g.props, 0, WALL_H / 2, outer + WT / 2, span, WALL_H, WT, wallCol);
  addBox(g.props, -outer - WT / 2, WALL_H / 2, 0, WT, WALL_H, span, wallCol);
  addBox(g.props, outer + WT / 2, WALL_H / 2, 0, WT, WALL_H, span, wallCol);
  world.addAABB(-outer - WT, -outer - WT, outer + WT, -outer, { kind: 'wall', h: WALL_H });
  world.addAABB(-outer - WT, outer, outer + WT, outer + WT, { kind: 'wall', h: WALL_H });
  world.addAABB(-outer - WT, -outer, -outer, outer, { kind: 'wall', h: WALL_H });
  world.addAABB(outer, -outer, outer + WT, outer, { kind: 'wall', h: WALL_H });
  const pierCol = col('#7a766f');
  const stripeA = col('#d9b21f'), stripeB = col('#222222');
  for (let p = -outer + 6; p < outer; p += 15) {
    addBox(g.props, p, WALL_H / 2 + 0.2, -outer + 0.3, 0.9, WALL_H + 0.4, 0.6, pierCol);
    addBox(g.props, p, WALL_H / 2 + 0.2, outer - 0.3, 0.9, WALL_H + 0.4, 0.6, pierCol);
    addBox(g.props, -outer + 0.3, WALL_H / 2 + 0.2, p, 0.6, WALL_H + 0.4, 0.9, pierCol);
    addBox(g.props, outer - 0.3, WALL_H / 2 + 0.2, p, 0.6, WALL_H + 0.4, 0.9, pierCol);
  }
  // полосатый низ стены
  const wq = (ax, az, bx, bz, c, out) => g.props.quad([ax, 0, az], [bx, 0, bz], [bx, 1, bz], [ax, 1, az], null, c, out);
  for (let p = -outer; p < outer; p += 2) {
    const c = Math.round((p + outer) / 2) % 2 ? stripeA : stripeB;
    const e = outer - 0.02;
    wq(p, -e, p + 2, -e, c, [0, 0, 1]);
    wq(p, e, p + 2, e, c, [0, 0, -1]);
    wq(-e, p, -e, p + 2, c, [1, 0, 0]);
    wq(e, p, e, p + 2, c, [-1, 0, 0]);
  }

  // далёкий силуэт города за стеной
  const skyCols = ['#8a98a8', '#9aa6b2', '#7d8a99', '#a4adb8', '#94a0ad'];
  for (let i = 0; i < 70; i++) {
    const a = (i / 70) * Math.PI * 2 + R(-0.03, 0.03);
    // кольцо квадратное, как стена: иначе на диагоналях дома оказывались внутри города (и были проезжими)
    const d = R(outer + 45, outer + 140) / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
    const h = R(14, 75);
    addBox(g.props, Math.cos(a) * d, h / 2, Math.sin(a) * d, R(14, 32), h, R(14, 32), col(pickR(skyCols)), R(0, Math.PI));
  }

  // ---------------------------------------------------------------- хелперы
  function wallQuad(b, ax, az, bx, bz, y0, y1, st, color, out, uOff) {
    const len = Math.hypot(bx - ax, bz - az);
    const u0 = uOff, u1 = uOff + len / st.tileW, v1 = (y1 - y0) / st.tileH;
    b.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], [[u0, 0], [u1, 0], [u1, v1], [u0, v1]], color, out);
  }

  function parapet(x0, z0, x1, z1, y, color) {
    const t = 0.3, h = 0.7;
    addBox(g.props, (x0 + x1) / 2, y + h / 2, z0 + t / 2, x1 - x0, h, t, color);
    addBox(g.props, (x0 + x1) / 2, y + h / 2, z1 - t / 2, x1 - x0, h, t, color);
    addBox(g.props, x0 + t / 2, y + h / 2, (z0 + z1) / 2, t, h, z1 - z0 - 2 * t, color);
    addBox(g.props, x1 - t / 2, y + h / 2, (z0 + z1) / 2, t, h, z1 - z0 - 2 * t, color);
  }

  function addBuilding(x0, z0, x1, z1, floors, style, color, { flatRoof = true } = {}) {
    const st = STYLE[style];
    const y0 = CURB, y1 = CURB + floors * st.floor;
    const b = g[style];
    const uOff = Math.floor(rng() * 4) * 0.25;
    wallQuad(b, x0, z1, x1, z1, y0, y1, st, color, [0, 0, 1], uOff);
    wallQuad(b, x1, z0, x0, z0, y0, y1, st, color, [0, 0, -1], uOff);
    wallQuad(b, x1, z1, x1, z0, y0, y1, st, color, [1, 0, 0], uOff);
    wallQuad(b, x0, z0, x0, z1, y0, y1, st, color, [-1, 0, 0], uOff);
    if (flatRoof) {
      g.roof.flat(x0, z0, x1, z1, y1, col(pickR(['#8a8a8a', '#7a7470', '#6f7780', '#8c857a'])), 4);
      parapet(x0, z0, x1, z1, y1, color.clone().multiplyScalar(0.8));
    }
    // цоколь
    if (style !== 'house') {
      const pc = color.clone().multiplyScalar(0.6);
      const e = 0.08;
      addBox(g.props, (x0 + x1) / 2, CURB + 0.4, z0 - e / 2, x1 - x0 + 2 * e, 0.8, e, pc);
      addBox(g.props, (x0 + x1) / 2, CURB + 0.4, z1 + e / 2, x1 - x0 + 2 * e, 0.8, e, pc);
      addBox(g.props, x0 - e / 2, CURB + 0.4, (z0 + z1) / 2, e, 0.8, z1 - z0, pc);
      addBox(g.props, x1 + e / 2, CURB + 0.4, (z0 + z1) / 2, e, 0.8, z1 - z0, pc);
    }
    world.addAABB(x0, z0, x1, z1, { kind: 'building', h: y1 });
    const rec = { x0, z0, x1, z1, h: y1, style };
    buildings.push(rec);
    return rec;
  }

  function addHouseRoof(x0, z0, x1, z1, y, rh, roofColor, wallColor) {
    const o = 0.45;
    const gx0 = x0, gx1 = x1, gz0 = z0, gz1 = z1; // фронтоны по стене
    x0 -= o; x1 += o; z0 -= o; z1 += o;
    const b = g.props;
    if (x1 - x0 >= z1 - z0) {
      const cz = (z0 + z1) / 2;
      const rA = [x0, y + rh, cz], rB = [x1, y + rh, cz];
      b.quad([x0, y, z0], [x1, y, z0], rB, rA, null, roofColor, [0, 1, -1]);
      b.quad([x1, y, z1], [x0, y, z1], rA, rB, null, roofColor, [0, 1, 1]);
      b.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], null, roofColor, [0, -1, 0]);
      const gcz = (gz0 + gz1) / 2;
      b.tri([gx0, y, gz0], [gx0, y + rh * 0.92, gcz], [gx0, y, gz1], [0, 0], [0, 0], [0, 0], wallColor, [-1, 0, 0]);
      b.tri([gx1, y, gz1], [gx1, y + rh * 0.92, gcz], [gx1, y, gz0], [0, 0], [0, 0], [0, 0], wallColor, [1, 0, 0]);
    } else {
      const cx = (x0 + x1) / 2;
      const rA = [cx, y + rh, z0], rB = [cx, y + rh, z1];
      b.quad([x0, y, z1], [x0, y, z0], rA, rB, null, roofColor, [-1, 1, 0]);
      b.quad([x1, y, z0], [x1, y, z1], rB, rA, null, roofColor, [1, 1, 0]);
      b.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], null, roofColor, [0, -1, 0]);
      const gcx = (gx0 + gx1) / 2;
      b.tri([gx0, y, gz0], [gcx, y + rh * 0.92, gz0], [gx1, y, gz0], [0, 0], [0, 0], [0, 0], wallColor, [0, 0, -1]);
      b.tri([gx1, y, gz1], [gcx, y + rh * 0.92, gz1], [gx0, y, gz1], [0, 0], [0, 0], [0, 0], wallColor, [0, 0, 1]);
    }
  }

  const leafDetail = quality.low ? 0 : 1;
  function addTree(x, z, s = 1, y = CURB) {
    addCyl(g.props, x, y, z, 0.3 * s, 2.8 * s, col('#5b4030'), 7, 0.22 * s);
    const leaf = col(pickR(LEAF_COLORS));
    addBlob(g.foliage, x, y + 3.6 * s, z, 1.9 * s, leaf, leafDetail, 0.85);
    addBlob(g.foliage, x + R(-0.7, 0.7) * s, y + 4.6 * s, z + R(-0.7, 0.7) * s, 1.4 * s, leaf.clone().multiplyScalar(1.1), leafDetail);
    if (rng() < 0.5) addBlob(g.foliage, x + R(-1, 1) * s, y + 3.2 * s, z + R(-1, 1) * s, 1.2 * s, leaf.clone().multiplyScalar(0.9), leafDetail);
    world.addCircle(x, z, 0.36 * s, { kind: 'tree', h: 6 });
    trees.push({ x, z });
  }

  function thickPole(x, z, yaw) {
    addCyl(g.props, x, CURB, z, 0.36, 7.5, col('#9d9a92'), 10, 0.28);
    addCyl(g.props, x, CURB, z, 0.375, 0.4, stripeA, 10);
    addCyl(g.props, x, CURB + 0.4, z, 0.37, 0.4, stripeB, 10);
    addCyl(g.props, x, CURB + 0.8, z, 0.365, 0.4, stripeA, 10);
    addBox(g.props, x, CURB + 7.1, z, 2.4, 0.16, 0.16, col('#5a4636'), yaw);
    for (const d of [-1, 1]) {
      const lx = Math.cos(yaw) * d, lz = -Math.sin(yaw) * d;
      addCyl(g.props, x + lx, CURB + 7.18, z + lz, 0.06, 0.22, col('#dfe6e8'), 6);
    }
    world.addCircle(x, z, 0.36, { kind: 'pole', h: 7.5 });
  }

  function pillar(x, z, r, h, color, kind = 'pillar') {
    addCyl(g.props, x, CURB, z, r, h, color, 12);
    addBox(g.props, x, CURB + 0.15, z, r * 2.6, 0.3, r * 2.6, color.clone().multiplyScalar(0.85));
    addBox(g.props, x, CURB + h - 0.15, z, r * 2.4, 0.3, r * 2.4, color.clone().multiplyScalar(0.85));
    world.addCircle(x, z, r, { kind, h });
  }

  function lotGround(lot, kind) {
    if (kind === 'grass') g.grass.flat(lot.x0, lot.z0, lot.x1, lot.z1, CURB, WHITE, 6);
    else if (kind === 'asphalt') g.asphalt.flat(lot.x0, lot.z0, lot.x1, lot.z1, CURB, col('#d6d6d6'), 8);
    else g.walk.flat(lot.x0, lot.z0, lot.x1, lot.z1, CURB, col('#e9e2d4'), 4);
  }

  const lotCenter = (lot) => [(lot.x0 + lot.x1) / 2, (lot.z0 + lot.z1) / 2];

  function rooftopStuff(rec) {
    const w = rec.x1 - rec.x0, d = rec.z1 - rec.z0;
    const n = RI(1, 3);
    for (let k = 0; k < n; k++) {
      const sx = R(2, 4), sz = R(2, 4), sh = R(1, 2.6);
      const x = R(rec.x0 + 1 + sx / 2, rec.x1 - 1 - sx / 2);
      const z = R(rec.z0 + 1 + sz / 2, rec.z1 - 1 - sz / 2);
      if (w > sx + 2 && d > sz + 2) addBox(g.props, x, rec.h + sh / 2, z, sx, sh, sz, col(pickR(['#9a9a9a', '#b0aca5', '#7f8a8f'])));
    }
    if (rng() < 0.4) {
      const x = (rec.x0 + rec.x1) / 2 + R(-2, 2), z = (rec.z0 + rec.z1) / 2 + R(-2, 2);
      addCyl(g.props, x, rec.h, z, 1.3, 2.4, col('#6d5b4b'), 10);
      addCyl(g.props, x, rec.h + 2.4, z, 1.4, 0.5, col('#5a4a3c'), 10, 0.2);
    }
  }

  // ---------------------------------------------------------------- типы кварталов
  const GEN = {
    apartment(lot) {
      lotGround(lot, rng() < 0.5 ? 'grass' : 'paving');
      const m = 2.5;
      const L = { x0: lot.x0 + m, z0: lot.z0 + m, x1: lot.x1 - m, z1: lot.z1 - m };
      const Wd = L.x1 - L.x0, Dd = L.z1 - L.z0;
      const color = col(pickR(APT_COLORS));
      const v = rng();
      const recs = [];
      if (v < 0.35) {
        const w = snap(R(21, Wd), 3), d = snap(R(18, Dd), 3);
        const x0 = L.x0 + R(0, Wd - w), z0 = L.z0 + R(0, Dd - d);
        recs.push(addBuilding(x0, z0, x0 + w, z0 + d, RI(6, 9), 'apartment', color));
      } else if (v < 0.75) {
        const alongX = rng() < 0.5;
        const thick = snap(R(11, 14), 3);
        const len = snap(R(24, alongX ? Wd : Dd), 3);
        for (let k = 0; k < 2; k++) {
          const c2 = k === 0 ? color : col(pickR(APT_COLORS));
          if (alongX) {
            const x0 = L.x0 + (Wd - len) / 2;
            const z0 = k === 0 ? L.z0 : L.z1 - thick;
            recs.push(addBuilding(x0, z0, x0 + len, z0 + thick, RI(5, 9), 'apartment', c2));
          } else {
            const z0 = L.z0 + (Dd - len) / 2;
            const x0 = k === 0 ? L.x0 : L.x1 - thick;
            recs.push(addBuilding(x0, z0, x0 + thick, z0 + len, RI(5, 9), 'apartment', c2));
          }
        }
      } else {
        // Г-образная пара
        const t = 12;
        recs.push(addBuilding(L.x0, L.z0, L.x0 + snap(Wd, 3), L.z0 + t, RI(5, 8), 'apartment', color));
        recs.push(addBuilding(L.x0, L.z0 + t + 4, L.x0 + t, L.z0 + t + 4 + snap(Dd - t - 4, 3), RI(6, 9), 'apartment', color));
        addTree(L.x1 - 6, L.z1 - 6, 1.1);
        addTree(L.x1 - 13, L.z1 - 10, 0.9);
      }
      recs.forEach(rooftopStuff);
    },

    office(lot) {
      lotGround(lot, 'paving');
      const [cx, cz] = lotCenter(lot);
      const color = col(pickR(OFFICE_COLORS));
      const recs = [];
      if (rng() < 0.35) {
        const w = snap(R(12, 15), 3), d = snap(R(18, 24), 3);
        recs.push(addBuilding(cx - w - 2, cz - d / 2, cx - 2, cz + d / 2, RI(8, 14), 'office', color));
        recs.push(addBuilding(cx + 2, cz - d / 2 + 3, cx + 2 + w, cz + d / 2 + 3, RI(7, 12), 'office', col(pickR(OFFICE_COLORS))));
      } else {
        const w = snap(R(18, 27), 3), d = snap(R(18, 26), 3);
        recs.push(addBuilding(cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2, RI(9, 15), 'office', color));
      }
      for (const rec of recs) {
        const x = (rec.x0 + rec.x1) / 2, z = (rec.z0 + rec.z1) / 2;
        addBox(g.props, x, rec.h + 1.6, z, 5, 3.2, 5, col('#9aa3aa'));
        addCyl(g.props, x + 1.5, rec.h + 3.2, z + 1.5, 0.12, 7, col('#c8c8c8'), 6);
      }
      // вход: козырёк на толстых колоннах
      const side = pickR([0, 1, 2, 3]);
      const pc = col('#d8d4cc');
      const cz2 = side === 0 ? lot.z0 + 2.5 : side === 2 ? lot.z1 - 2.5 : cz;
      const cx2 = side === 1 ? lot.x1 - 2.5 : side === 3 ? lot.x0 + 2.5 : cx;
      const along = side === 0 || side === 2;
      for (const o of [-4, 4]) {
        pillar(cx2 + (along ? o : 0), cz2 + (along ? 0 : o), 0.55, 4.2, pc);
      }
      addBox(g.props, cx2, CURB + 4.4, cz2, along ? 11 : 3.2, 0.4, along ? 3.2 : 11, col('#5d6a73'));
    },

    shops(lot) {
      lotGround(lot, 'paving');
      const cw = (lot.x1 - lot.x0) / 2, cd = (lot.z1 - lot.z0) / 2;
      for (let ci = 0; ci < 2; ci++) {
        for (let cj = 0; cj < 2; cj++) {
          const w = snap(R(12, cw - 2.5), 4), d = snap(R(10, cd - 3), 4);
          const x0 = ci === 0 ? lot.x0 + 1 : lot.x1 - 1 - w;
          const z0 = cj === 0 ? lot.z0 + 1 : lot.z1 - 1 - d;
          const color = col(pickR(SHOP_COLORS));
          const rec = addBuilding(x0, z0, x0 + w, z0 + d, RI(1, 2), 'shop', color);
          const ac = col(pickR(AWNING_COLORS));
          const ay = CURB + 3.4;
          // маркизы со стороны улицы
          if (cj === 0) addBox(g.props, x0 + w / 2, ay, z0 - 0.8, w - 1, 0.18, 1.6, ac);
          else addBox(g.props, x0 + w / 2, ay, z0 + d + 0.8, w - 1, 0.18, 1.6, ac);
          if (ci === 0) addBox(g.props, x0 - 0.8, ay, z0 + d / 2, 1.6, 0.18, d - 1, ac);
          else addBox(g.props, x0 + w + 0.8, ay, z0 + d / 2, 1.6, 0.18, d - 1, ac);
          rooftopStuff(rec);
        }
      }
      const [cx, cz] = lotCenter(lot);
      props.push({ type: 'bench', x: cx, z: cz - 2, yaw: 0 });
      props.push({ type: 'bin', x: cx + 2, z: cz + 2, yaw: 0 });
    },

    houses(lot) {
      lotGround(lot, 'grass');
      const cw = (lot.x1 - lot.x0) / 2, cd = (lot.z1 - lot.z0) / 2;
      for (let ci = 0; ci < 2; ci++) {
        for (let cj = 0; cj < 2; cj++) {
          const w = snap(R(9, 12.5), 3), d = snap(R(9, 12.5), 3);
          const cx = lot.x0 + cw * ci + cw / 2 + R(-1.5, 1.5);
          const cz = lot.z0 + cd * cj + cd / 2 + R(-1.5, 1.5);
          const color = col(pickR(HOUSE_COLORS));
          const floors = RI(1, 2);
          const rec = addBuilding(cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2, floors, 'house', color, { flatRoof: false });
          addHouseRoof(rec.x0, rec.z0, rec.x1, rec.z1, rec.h, R(2.2, 3.4), col(pickR(ROOF_COLORS)), color);
          // дерево во дворе
          const tx = ci === 0 ? lot.x0 + 2.5 : lot.x1 - 2.5;
          const tz = cj === 0 ? lot.z0 + 2.5 : lot.z1 - 2.5;
          const clear = tx < rec.x0 - 1.5 || tx > rec.x1 + 1.5 || tz < rec.z0 - 1.5 || tz > rec.z1 + 1.5;
          if (clear && rng() < 0.7) addTree(tx, tz, R(0.8, 1.1));
        }
      }
      // живая изгородь по периметру (без коллизии)
      const hc = col('#3d6b2c');
      const lx = lot.x1 - lot.x0, lz = lot.z1 - lot.z0;
      for (const [x, z, sx, sz] of [
        [lot.x0 + lx * 0.25, lot.z0 + 0.4, lx * 0.4, 0.7],
        [lot.x1 - lx * 0.25, lot.z1 - 0.4, lx * 0.4, 0.7],
        [lot.x0 + 0.4, lot.z1 - lz * 0.25, 0.7, lz * 0.4],
        [lot.x1 - 0.4, lot.z0 + lz * 0.25, 0.7, lz * 0.4],
      ]) addBox(g.foliage, x, CURB + 0.45, z, sx, 0.9, sz, hc);
    },

    park(lot, info) {
      lotGround(lot, 'grass');
      const [cx, cz] = lotCenter(lot);
      const pathCol = col('#d9cfb8');
      g.walk.flat(cx - 1.6, lot.z0, cx + 1.6, lot.z1, CURB + 0.01, pathCol, 4);
      g.walk.flat(lot.x0, cz - 1.6, cx - 1.6, cz + 1.6, CURB + 0.01, pathCol, 4);
      g.walk.flat(cx + 1.6, cz - 1.6, lot.x1, cz + 1.6, CURB + 0.01, pathCol, 4);
      // фонтан
      addCyl(g.props, cx, CURB, cz, 3.4, 0.7, col('#b8b2a6'), 20);
      addCyl(g.props, cx, CURB + 0.02, cz, 3.0, 0.7, col('#4f8fb8'), 20);
      addCyl(g.props, cx, CURB, cz, 0.45, 2.3, col('#a8a296'), 10);
      addCyl(g.props, cx, CURB + 1.7, cz, 1.2, 0.3, col('#b8b2a6'), 14, 0.7);
      world.addCircle(cx, cz, 3.4, { kind: 'fountain', h: 0.85 });
      info.fountain = { x: cx, z: cz };
      // деревья
      let placed = 0;
      for (let tries = 0; tries < 120 && placed < 14; tries++) {
        const x = R(lot.x0 + 2, lot.x1 - 2), z = R(lot.z0 + 2, lot.z1 - 2);
        if (Math.abs(x - cx) < 3 || Math.abs(z - cz) < 3) continue;
        if (Math.hypot(x - cx, z - cz) < 7) continue;
        if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 4.5)) continue;
        addTree(x, z, R(0.9, 1.35));
        placed++;
      }
      for (const [x, z, yaw] of [[cx - 7, cz + 2.4, Math.PI], [cx + 7, cz - 2.4, 0], [cx + 2.4, cz + 7, -Math.PI / 2], [cx - 2.4, cz - 7, Math.PI / 2]]) {
        props.push({ type: 'bench', x, z, yaw });
      }
      props.push({ type: 'bin', x: cx + 2.6, z: cz + 9, yaw: 0 });
      info.inner = [[cx, cz - 9], [cx + 9, cz], [cx, cz + 9], [cx - 9, cz]];
    },

    plaza(lot, info) {
      g.walk.flat(lot.x0, lot.z0, lot.x1, lot.z1, CURB, col('#d6cbb5'), 3);
      const [cx, cz] = lotCenter(lot);
      // постамент и памятник
      const stone = col('#9b958a');
      addBox(g.props, cx, CURB + 1.2, cz, 5, 2.4, 5, stone);
      addBox(g.props, cx, CURB + 0.2, cz, 6.4, 0.4, 6.4, stone.clone().multiplyScalar(0.9));
      const br = col('#7a5a2c');
      const base = CURB + 2.4;
      addBox(g.props, cx - 0.35, base + 1.0, cz, 0.45, 2.0, 0.5, br);
      addBox(g.props, cx + 0.35, base + 1.0, cz, 0.45, 2.0, 0.5, br);
      addBox(g.props, cx, base + 2.9, cz, 1.4, 1.9, 0.75, br);
      addBox(g.props, cx, base + 4.2, cz, 0.6, 0.65, 0.6, br);
      addBox(g.props, cx + 0.95, base + 4.0, cz + 0.2, 0.32, 1.9, 0.32, br);
      addBox(g.props, cx - 0.95, base + 2.6, cz, 0.32, 1.6, 0.32, br);
      world.addAABB(cx - 2.5, cz - 2.5, cx + 2.5, cz + 2.5, { kind: 'statue', h: 8 });
      // колонны
      const pc = col('#e4e0d6');
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pillar(cx + sx * 11, cz + sz * 11, 0.65, 7, pc);
      // кадки с деревьями
      for (const [sx, sz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const x = cx + sx * 12, z = cz + sz * 12;
        addBox(g.props, x, CURB + 0.35, z, 2.2, 0.7, 2.2, col('#8a7a66'));
        addTree(x, z, 0.8, CURB + 0.7);
        world.addAABB(x - 1.1, z - 1.1, x + 1.1, z + 1.1, { kind: 'pillar', h: 0.85 });
      }
      for (const [x, z, yaw] of [[cx - 6, cz - 6, Math.PI / 4], [cx + 6, cz + 6, -Math.PI * 0.75], [cx + 6, cz - 6, -Math.PI / 4], [cx - 6, cz + 6, Math.PI * 0.75]]) {
        props.push({ type: 'bench', x, z, yaw });
      }
      info.inner = [[cx, cz - 7], [cx + 7, cz], [cx, cz + 7], [cx - 7, cz]];
    },

    gas(lot) {
      lotGround(lot, 'asphalt');
      const [cx, cz] = lotCenter(lot);
      const ccz = cz - 4;
      const red = col('#c62828');
      addBox(g.props, cx, CURB + 5.3, ccz, 18, 0.7, 12, col('#f2f2f2'));
      addBox(g.props, cx, CURB + 5.3, ccz, 18.2, 0.45, 12.2, red);
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pillar(cx + sx * 6.5, ccz + sz * 3.6, 0.42, 5, col('#e8e8e8'));
      for (const ox of [-3, 3]) {
        addBox(g.props, cx + ox, CURB + 0.12, ccz, 1.3, 0.25, 5, col('#bdbdbd'));
        for (const oz of [-1.2, 1.2]) {
          addBox(g.props, cx + ox, CURB + 0.95, ccz + oz, 0.8, 1.5, 0.6, col('#efefef'));
          addBox(g.props, cx + ox, CURB + 1.45, ccz + oz, 0.84, 0.35, 0.64, red);
        }
        world.addAABB(cx + ox - 0.65, ccz - 2.5, cx + ox + 0.65, ccz + 2.5, { kind: 'pump', h: 1.8 });
      }
      const rec = addBuilding(cx - 8, lot.z1 - 9, cx + 8, lot.z1 - 1, 1, 'shop', col('#fafafa'));
      rooftopStuff(rec);
      // высокая стела с ценами
      const sx = lot.x0 + 2, sz = lot.z0 + 2;
      addCyl(g.props, sx, CURB, sz, 0.3, 8, col('#7d7d7d'), 10);
      addBox(g.props, sx, CURB + 8.6, sz, 3.4, 2.4, 0.5, red);
      addBox(g.props, sx, CURB + 8.6, sz, 3.0, 1.6, 0.56, col('#f5f5f5'));
      world.addCircle(sx, sz, 0.3, { kind: 'pole', h: 9 });
    },
  };

  // ---------------------------------------------------------------- раскладка кварталов
  const forced = { '2,3': 'plaza', '4,1': 'park', '0,4': 'park', '1,1': 'gas', '4,5': 'gas' };
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const ring = Math.max(Math.abs(i - (N - 1) / 2), Math.abs(j - (N - 1) / 2));
      let type = forced[`${i},${j}`];
      if (!type) {
        if (ring < 1) type = rng() < 0.8 ? 'office' : 'apartment';
        else if (ring < 2) type = pickR(['apartment', 'apartment', 'shops', 'shops', 'office']);
        else type = pickR(['houses', 'houses', 'apartment', 'shops', 'houses']);
      }
      const x0 = roads[i] + RD / 2, x1 = roads[i + 1] - RD / 2;
      const z0 = roads[j] + RD / 2, z1 = roads[j + 1] - RD / 2;
      g.walk.flat(x0, z0, x1, z0 + S, CURB, WHITE, 4);
      g.walk.flat(x0, z1 - S, x1, z1, CURB, WHITE, 4);
      g.walk.flat(x0, z0 + S, x0 + S, z1 - S, CURB, WHITE, 4);
      g.walk.flat(x1 - S, z0 + S, x1, z1 - S, CURB, WHITE, 4);
      curbFace(x0, z0, x1, z0, [0, 0, -1]);
      curbFace(x0, z1, x1, z1, [0, 0, 1]);
      curbFace(x0, z0, x0, z1, [-1, 0, 0]);
      curbFace(x1, z0, x1, z1, [1, 0, 0]);
      const lot = { x0: x0 + S, z0: z0 + S, x1: x1 - S, z1: z1 - S };
      const info = { i, j, type, x0, z0, x1, z1, lot };
      blocks.push(info);
      GEN[type](lot, info);
      sidewalkProps(info);
    }
  }

  function sidewalkProps(info) {
    const { x0, z0, x1, z1, type } = info;
    const leafy = type === 'houses' || type === 'apartment' || type === 'park';
    const sides = [
      { ax: x0, az: z0, dx: 1, dz: 0, ox: 0, oz: -1 },
      { ax: x1, az: z0, dx: 0, dz: 1, ox: 1, oz: 0 },
      { ax: x1, az: z1, dx: -1, dz: 0, ox: 0, oz: 1 },
      { ax: x0, az: z1, dx: 0, dz: -1, ox: -1, oz: 0 },
    ];
    for (const sd of sides) {
      const at = (s, inset) => [sd.ax + sd.dx * s - sd.ox * inset, sd.az + sd.dz * s - sd.oz * inset];
      const yaw = Math.atan2(sd.ox, sd.oz);
      for (const s of [9, 37]) {
        const [x, z] = at(s, 0.7);
        props.push({ type: 'lamp', x, z, yaw });
      }
      const [px, pz] = at(23, 0.75);
      thickPole(px, pz, yaw);
      if (leafy) {
        for (const s of [15.5, 30.5]) {
          const [x, z] = at(s, 1.0);
          addTree(x, z, R(0.75, 0.95));
        }
      } else {
        if (rng() < 0.6) {
          const [x, z] = at(R(14, 17), 0.7);
          props.push({ type: 'bin', x, z, yaw });
        }
        if (rng() < 0.5) {
          const [x, z] = at(R(29, 32), 0.7);
          props.push({ type: 'hydrant', x, z, yaw });
        }
      }
    }
    const corners = [[x0, z0, -1, -1], [x1, z0, 1, -1], [x1, z1, 1, 1], [x0, z1, -1, 1]];
    corners.forEach(([cx, cz, sx, sz], k) => {
      props.push({ type: (info.i + info.j + k) % 2 === 0 ? 'traffic' : 'sign', x: cx - sx * 0.9, z: cz - sz * 0.9, yaw: Math.atan2(sx, sz) });
    });
  }

  // ---------------------------------------------------------------- разметка
  const markCol = col('#f2f2ee');
  const MY = 0.015;
  const markRect = (x0, z0, x1, z1) => g.marks.quad([x0, MY, z0], [x0, MY, z1], [x1, MY, z1], [x1, MY, z0], null, markCol, [0, 1, 0]);
  for (let r = 0; r <= N; r++) {
    for (let s = 0; s < N; s++) {
      const a = roads[s] + RD / 2 + 5, b2 = roads[s + 1] - RD / 2 - 5;
      for (let p = a; p + 3 <= b2; p += 6) {
        markRect(roads[r] - 0.09, p, roads[r] + 0.09, p + 3); // вертикальные дороги (вдоль Z)
        markRect(p, roads[r] - 0.09, p + 3, roads[r] + 0.09); // горизонтальные (вдоль X)
      }
    }
  }
  // зебры у перекрёстков
  const zebraX = (xc, zc) => {
    for (let x = xc - RD / 2 + 0.6; x < xc + RD / 2 - 0.6; x += 1.1) markRect(x, zc - 1.5, x + 0.55, zc + 1.5);
  };
  const zebraZ = (xc, zc) => {
    for (let z = zc - RD / 2 + 0.6; z < zc + RD / 2 - 0.6; z += 1.1) markRect(xc - 1.5, z, xc + 1.5, z + 0.55);
  };

  // ---------------------------------------------------------------- граф пешеходов
  const nodeId = (i, j, k) => (i * N + j) * 4 + k;
  for (const bl of blocks) {
    const ins = S / 2;
    const pts = [[bl.x0 + ins, bl.z0 + ins], [bl.x1 - ins, bl.z0 + ins], [bl.x1 - ins, bl.z1 - ins], [bl.x0 + ins, bl.z1 - ins]];
    for (const [x, z] of pts) nodes.push({ x, z, links: [] });
  }
  const link = (a, b) => {
    nodes[a].links.push(b);
    nodes[b].links.push(a);
  };
  for (const bl of blocks) {
    const { i, j } = bl;
    for (let k = 0; k < 4; k++) link(nodeId(i, j, k), nodeId(i, j, (k + 1) % 4));
    if (i + 1 < N) {
      link(nodeId(i, j, 1), nodeId(i + 1, j, 0));
      link(nodeId(i, j, 2), nodeId(i + 1, j, 3));
      zebraX(roads[i + 1], nodes[nodeId(i, j, 1)].z);
      zebraX(roads[i + 1], nodes[nodeId(i, j, 2)].z);
    }
    if (j + 1 < N) {
      link(nodeId(i, j, 3), nodeId(i, j + 1, 0));
      link(nodeId(i, j, 2), nodeId(i, j + 1, 1));
      zebraZ(nodes[nodeId(i, j, 3)].x, roads[j + 1]);
      zebraZ(nodes[nodeId(i, j, 2)].x, roads[j + 1]);
    }
  }
  for (const bl of blocks) {
    if (!bl.inner) continue;
    const ids = bl.inner.map(([x, z]) => {
      nodes.push({ x, z, links: [] });
      return nodes.length - 1;
    });
    for (let k = 0; k < 4; k++) link(ids[k], ids[(k + 1) % 4]);
    // соединяем с углами тротуара: юг → углы 0,1; восток → 1,2; север → 2,3; запад → 3,0
    for (let k = 0; k < 4; k++) {
      link(ids[k], nodeId(bl.i, bl.j, k));
      link(ids[k], nodeId(bl.i, bl.j, (k + 1) % 4));
    }
  }

  // ---------------------------------------------------------------- меши
  const maps = {
    apartment: TX.facadeTexture('apartment'),
    office: TX.facadeTexture('office'),
    shop: TX.facadeTexture('shop'),
    house: TX.facadeTexture('house'),
    roof: TX.roofTexture(),
    walk: TX.tilesTexture(),
    grass: TX.grassTexture(),
    asphalt: TX.asphaltTexture(),
  };
  const mats = {};
  for (const k of Object.keys(maps)) mats[k] = new THREE.MeshLambertMaterial({ map: maps[k], vertexColors: true });
  mats.props = new THREE.MeshLambertMaterial({ vertexColors: true });
  mats.foliage = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  mats.marks = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const casters = new Set(['apartment', 'office', 'shop', 'house', 'roof', 'props', 'foliage']);
  for (const [key, b] of Object.entries(g)) {
    if (b.empty) continue;
    const mesh = new THREE.Mesh(b.build(), mats[key]);
    mesh.castShadow = quality.shadows && casters.has(key);
    mesh.receiveShadow = quality.shadows;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = `city-${key}`;
    if (key === 'foliage') mesh.layers.enable(XRAY.mask); // кроны: за ними машины и пешеходы видны рентгеном
    scene.add(mesh);
  }

  // ---------------------------------------------------------------- миникарта
  const MM = 512;
  const ext = outer + 2;
  const k = MM / (2 * ext);
  const mm = document.createElement('canvas');
  mm.width = mm.height = MM;
  const c2 = mm.getContext('2d');
  const toMap = (x) => (x + ext) * k;
  const rect = (x0, z0, x1, z1, fill) => {
    c2.fillStyle = fill;
    c2.fillRect(toMap(x0), toMap(z0), (x1 - x0) * k, (z1 - z0) * k);
  };
  rect(-ext, -ext, ext, ext, '#7d7a72');
  rect(-edge, -edge, edge, edge, '#3d3f44');
  for (const bl of blocks) {
    rect(bl.x0, bl.z0, bl.x1, bl.z1, '#8f8b82');
    const lotFill = { houses: '#52803a', park: '#4b7d33', apartment: '#6e7d5e', plaza: '#b8ad98', office: '#9c978c', shops: '#a39e92', gas: '#5a5a5a' }[bl.type];
    rect(bl.lot.x0, bl.lot.z0, bl.lot.x1, bl.lot.z1, lotFill);
    if (bl.fountain) {
      c2.fillStyle = '#4f8fb8';
      c2.beginPath();
      c2.arc(toMap(bl.fountain.x), toMap(bl.fountain.z), 3.4 * k, 0, Math.PI * 2);
      c2.fill();
    }
  }
  for (const b of buildings) {
    const v = Math.round(clamp(150 + b.h * 2.2, 150, 235));
    rect(b.x0, b.z0, b.x1, b.z1, `rgb(${v},${v - 6},${v - 16})`);
  }

  // ---------------------------------------------------------------- запросы
  function groundHeight(x, z) {
    if (x < -edge || x > edge || z < -edge || z > edge) return CURB;
    const u = (((x + half) % cell) + cell) % cell;
    const v = (((z + half) % cell) + cell) % cell;
    if (u < RD / 2 || u > cell - RD / 2 || v < RD / 2 || v > cell - RD / 2) return 0;
    return CURB;
  }

  function findRoadSpawn(x, z, yaw = 0) {
    const ix = clamp(Math.round((x + half) / cell), 0, N);
    const iz = clamp(Math.round((z + half) / cell), 0, N);
    const rx = roads[ix], rz = roads[iz];
    const lim = edge - 6;
    if (Math.abs(x - rx) <= Math.abs(z - rz)) {
      const fwd = Math.cos(yaw) >= 0;
      return { x: rx + (fwd ? -3.5 : 3.5), z: clamp(z, -lim, lim), yaw: fwd ? 0 : Math.PI };
    }
    const fwd = Math.sin(yaw) >= 0;
    return { x: clamp(x, -lim, lim), z: rz + (fwd ? 3.5 : -3.5), yaw: fwd ? Math.PI / 2 : -Math.PI / 2 };
  }

  return {
    world,
    nodes,
    blocks,
    buildings,
    props,
    roads,
    half,
    edge,
    outer,
    groundHeight,
    findRoadSpawn,
    spawn: { x: roads[3] - 3.5, z: roads[1] + RD / 2 + 12, yaw: 0 },
    minimap: { canvas: mm, ext, k },
  };
}
