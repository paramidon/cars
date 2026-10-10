import { sameTeam } from './car.js';
import { ST } from './pedestrians.js';
import { rand, wrapAngle } from './utils.js';

/** Бот-стрелок в башне (режим «экипаж»): сам выбирает цель, крутит башню, стреляет. Крутить здесь. */
export const GUNNER = {
  range: 70, // м — дальше машины не видит
  minRange: 7, // в упор не стреляет — заденет себя взрывом
  turn: 2.6, // рад/с — скорость поворота башни у бота
  cone: 0.05, // насколько точно ствол должен смотреть на цель, рад (плюс поправка на расстояние)
  pedRange: [18, 45], // дальность стрельбы по пешеходам: [при gore = 0, при gore = 1]
  retarget: 0.4, // с между выборами цели
  error: 0.07, // бот мажет: ошибка прицела до стольких рад (на 30 м — до 2 м), меняется раз в ~1 с
  pause: [1.0, 2.4], // с — после выстрела бот ещё «перезаряжается» сверх пушки
};

const shotFilter = (c) => c.kind !== 'breakable' && c.h >= 1.2;

/** Повернуть угол a к b не больше чем на step. */
function turnToward(a, b, step) {
  const d = wrapAngle(b - a);
  return Math.abs(d) <= step ? b : a + Math.sign(d) * step;
}

export class BotGunner {
  /** gore — тяга к пешеходам (0…1): насколько далеко бьёт по толпе, когда машин рядом нет. */
  constructor(car, world, gore = 0.3) {
    this.car = car;
    this.world = world;
    this.gore = gore;
    this.target = null; // машина или пешеход
    this.retarget = 0;
    this.err = 0;
    this.errT = 0;
    this.pause = rand(...GUNNER.pause);
  }

  _clear(x, z, d) {
    const car = this.car;
    return !this.world.raycast(car.x, car.z, (x - car.x) / d, (z - car.z) / d, d, shotFilter);
  }

  _pick(cars, peds) {
    const car = this.car;
    let best = null, bs = Infinity;
    for (const c of cars) {
      if (c === car || c.wrecked || sameTeam(c, car)) continue;
      const d = Math.hypot(c.x - car.x, c.z - car.z);
      if (d > GUNNER.range || d < GUNNER.minRange || d >= bs || !this._clear(c.x, c.z, d)) continue;
      bs = d;
      best = c;
    }
    if (best || !peds) return best;
    // машин рядом нет — по пешеходам (стоящим: лежачих снарядом не достать)
    const range = GUNNER.pedRange[0] + (GUNNER.pedRange[1] - GUNNER.pedRange[0]) * this.gore;
    for (const p of peds.peds) {
      if (!peds.isAlive(p)) continue;
      const d = Math.hypot(p.x - car.x, p.z - car.z);
      if (d > range || d < GUNNER.minRange + 3 || d >= bs || !this._clear(p.x, p.z, d)) continue;
      bs = d;
      best = p;
    }
    return best;
  }

  /** Каждый кадр: повернуть башню; true — пора стрелять. ctx: { cars, peds, shellSpeed } */
  update(dt, ctx) {
    const car = this.car;
    if (car.wrecked) return false;
    this.retarget -= dt;
    this.pause -= dt;
    this.errT -= dt;
    if (this.errT <= 0) {
      this.errT = rand(0.6, 1.4);
      this.err = rand(-GUNNER.error, GUNNER.error);
    }
    const t = this.target;
    const gone = t && (t.isCar ? t.wrecked : t.state === ST.FREE || t.state === ST.DEAD || t.state === ST.FLYING);
    if (this.retarget <= 0 || gone) {
      this.retarget = GUNNER.retarget;
      this.target = this._pick(ctx.cars, ctx.peds);
    }
    const T = this.target;
    // без цели — башня смотрит вперёд
    let want = car.yaw, d = 0;
    if (T) {
      d = Math.hypot(T.x - car.x, T.z - car.z) || 1;
      const lead = T.isCar ? d / ctx.shellSpeed : 0;
      const tx = T.x + (T.isCar ? T.vx : 0) * lead - car.x, tz = T.z + (T.isCar ? T.vz : 0) * lead - car.z;
      want = Math.atan2(tx, tz) + (T.isCar ? this.err : 0);
    }
    // the turret turns towards the angle that points the barrel at `want` (on a tilted car — Car.turretToward)
    car.turretYaw = turnToward(car.turretYaw, car.turretToward(want), GUNNER.turn * dt);
    if (!T || car.reload > 0 || this.pause > 0) return false;
    if (Math.abs(wrapAngle(want - car.aimYaw)) >= GUNNER.cone + 1 / d) return false;
    // a tilted car's barrel can point into the ground or over the target
    const ty = T.isCar ? T.y : car.city.groundHeight(T.x, T.z);
    if (!car.shotReaches(T.x, ty, T.z, T.isCar ? 1.7 : 1.8)) return false;
    this.pause = rand(...GUNNER.pause);
    return true;
  }
}
