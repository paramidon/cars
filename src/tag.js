import * as THREE from 'three';

/**
 * Табличка над машиной: имя и полоска корпуса. Без имени (машина игрока) — полоска с числом,
 * а под ней — готовность оружия (weapon = { name, p, ready, hot } задаёт игра; null — не стреляю).
 * Перерисовывается, только когда что-то из этого заметно меняется.
 */
export class CarTag {
  constructor(scene, car, name = null, color = '#ffffff') {
    this.car = car;
    this.name = name;
    this.color = color;
    this.weapon = null;
    this.wKey = '';
    const own = !name;
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = own ? 96 : 64;
    this.tex = new THREE.CanvasTexture(c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false }));
    this.sprite.scale.set(4.4, own ? 1.65 : 1.1, 1);
    this.lift = own ? 2.83 : 3.1; // своя табличка выше на строку оружия — полоска корпуса остаётся на месте
    this.sprite.renderOrder = 6;
    scene.add(this.sprite);
    this.hp = -1;
    this.draw();
  }

  draw() {
    const car = this.car;
    const g = this.tex.image.getContext('2d');
    const hp = Math.max(0, Math.round(car.health));
    const barCol = hp > 60 ? '#5fd35f' : hp > 30 ? '#f5b82e' : '#ff3b30';
    g.clearRect(0, 0, 256, this.tex.image.height);
    g.font = 'bold 26px "Russo One", "Arial Black", sans-serif';
    g.textAlign = 'center';
    g.lineWidth = 5;
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    if (this.name) {
      const label = car.wrecked ? `${this.name} — СХОД` : this.name;
      g.fillStyle = car.wrecked ? '#9a9a9a' : this.color;
      g.strokeText(label, 128, 28);
      g.fillStyle = car.wrecked ? '#cccccc' : '#ffffff';
      g.fillText(label, 128, 28);
      if (!car.wrecked) {
        g.fillStyle = 'rgba(0,0,0,0.6)';
        g.fillRect(48, 40, 160, 14);
        g.fillStyle = barCol;
        g.fillRect(50, 42, 156 * (hp / 100), 10);
      }
    } else if (!car.wrecked) {
      // своя машина: полоска потолще и число
      g.fillStyle = 'rgba(0,0,0,0.65)';
      g.fillRect(28, 34, 200, 26);
      g.fillStyle = barCol;
      g.fillRect(31, 37, 194 * (hp / 100), 20);
      g.font = 'bold 20px "Russo One", "Arial Black", sans-serif';
      g.lineWidth = 4;
      g.strokeText(String(hp), 128, 55);
      g.fillStyle = '#ffffff';
      g.fillText(String(hp), 128, 55);
      const w = this.weapon;
      if (w) {
        // оружие: у пушки полоска растёт до готовности, у пулемёта тает с нагревом
        g.fillStyle = 'rgba(0,0,0,0.65)';
        g.fillRect(48, 66, 160, 22);
        g.fillStyle = w.hot ? '#ff3b30' : w.ready ? '#ffd23f' : '#8a8a8a';
        g.fillRect(51, 69, 154 * w.p, 16);
        g.font = 'bold 15px "Russo One", "Arial Black", sans-serif';
        g.lineWidth = 3;
        const label = w.hot ? 'ПЕРЕГРЕВ' : w.name;
        g.strokeText(label, 128, 83);
        g.fillStyle = '#ffffff';
        g.fillText(label, 128, 83);
      }
    }
    this.tex.needsUpdate = true;
    this.hp = car.wrecked ? -2 : hp;
  }

  /** viewer — машина игрока: чужие таблички дальше 110 м не видны. */
  update(viewer) {
    const c = this.car;
    this.sprite.position.set(c.x, c.y + this.lift, c.z);
    this.sprite.visible = c === viewer ? !c.wrecked : Math.hypot(c.x - viewer.x, c.z - viewer.z) < 110;
    const hp = c.wrecked ? -2 : Math.max(0, Math.round(c.health));
    const w = this.weapon;
    const wKey = w ? `${w.name}${Math.round(w.p * 20)}${w.ready}${w.hot}` : '';
    if (hp !== this.hp || wKey !== this.wKey) {
      this.wKey = wKey;
      this.draw();
    }
  }
}
