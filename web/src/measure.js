import * as THREE from 'three';

// Medição estilo CAD: toque em dois pontos (na peça ou no chão) e veja a
// distância real em mm/cm. Um terceiro toque reinicia.
export class Measure {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.points = [];

    this.group = new THREE.Group();
    this.group.visible = false;
    app.viewport.scene.add(this.group);

    this.lineMat = new THREE.LineBasicMaterial({ color: 0xffca28, depthTest: false, transparent: true });
    this.line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), this.lineMat);
    this.line.renderOrder = 998;
    this.group.add(this.line);

    const dotGeo = new THREE.SphereGeometry(1.4, 16, 12);
    this.dotMat = new THREE.MeshBasicMaterial({ color: 0xffca28, depthTest: false });
    this.dots = [new THREE.Mesh(dotGeo, this.dotMat), new THREE.Mesh(dotGeo, this.dotMat)];
    this.dots.forEach(d => { d.renderOrder = 999; d.visible = false; this.group.add(d); });

    this.label = document.getElementById('measureLabel');
    app.viewport.onFrame(() => { if (this.active && this.points.length === 2) this._updateLabel(); });
  }

  setActive(on) {
    this.active = on;
    this.group.visible = on;
    this.points = [];
    this.dots.forEach(d => d.visible = false);
    if (this.label) this.label.style.display = 'none';
    this.app.emit('measure-changed');
  }

  tap(point) {
    if (!point) return;
    if (this.points.length >= 2) { this.points = []; this.dots.forEach(d => d.visible = false); if (this.label) this.label.style.display = 'none'; }
    this.points.push(point.clone());
    const d = this.dots[this.points.length - 1];
    d.position.copy(point); d.visible = true;
    if (this.points.length === 2) {
      this.line.geometry.setFromPoints(this.points);
      this._updateLabel();
      const mm = this.points[0].distanceTo(this.points[1]);
      this.app.ui.toast(`Distância: ${(Math.round(mm * 100) / 100).toLocaleString('pt-BR')} mm (${(Math.round(mm) / 10).toLocaleString('pt-BR')} cm)`);
    }
  }

  _updateLabel() {
    if (!this.label || this.points.length < 2) return;
    const mid = this.points[0].clone().add(this.points[1]).multiplyScalar(0.5);
    const p = mid.clone().project(this.app.viewport.camera);
    const r = this.app.viewport.renderer.domElement.getBoundingClientRect();
    const x = (p.x * 0.5 + 0.5) * r.width;
    const y = (-p.y * 0.5 + 0.5) * r.height;
    const mm = this.points[0].distanceTo(this.points[1]);
    this.label.textContent = `${(Math.round(mm * 100) / 100).toLocaleString('pt-BR')} mm`;
    this.label.style.display = 'block';
    this.label.style.left = x + 'px';
    this.label.style.top = y + 'px';
  }
}
