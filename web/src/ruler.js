import * as THREE from 'three';

// Régua/escala: desenha uma barra graduada em mm e cm no canto do viewport,
// calculada a partir da distância real (mm) que cabe em cada pixel na
// profundidade do alvo. Também mostra as cotas da peça selecionada.
export class Ruler {
  constructor(app) {
    this.app = app;
    this.visible = false;
    this.canvas = document.getElementById('rulerCanvas');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this._p0 = new THREE.Vector3();
    this._p1 = new THREE.Vector3();
    app.viewport.onFrame(() => { if (this.visible) this._draw(); });
  }

  setVisible(on) {
    this.visible = on;
    if (this.canvas) this.canvas.style.display = on ? 'block' : 'none';
    if (on) this._draw();
    this.app.emit('ruler-changed');
  }

  // mm por pixel na profundidade do ponto de foco
  _mmPerPixel() {
    const vp = this.app.viewport;
    const target = vp.controls.target;
    this._p0.copy(target);
    this._p1.copy(target).add(new THREE.Vector3(1, 0, 0)); // 1 mm no mundo
    const a = this._project(this._p0), b = this._project(this._p1);
    const px = Math.hypot(a.x - b.x, a.y - b.y);
    return px > 1e-4 ? 1 / px : 0.1;
  }

  _project(v) {
    const vp = this.app.viewport;
    const p = v.clone().project(vp.camera);
    const r = vp.renderer.domElement.getBoundingClientRect();
    return { x: (p.x * 0.5 + 0.5) * r.width, y: (-p.y * 0.5 + 0.5) * r.height };
  }

  _niceLength(mmForBar) {
    // arredonda para 1,2,5 × 10^n mm
    const pow = Math.pow(10, Math.floor(Math.log10(mmForBar)));
    for (const m of [1, 2, 5, 10]) if (m * pow >= mmForBar) return m * pow;
    return 10 * pow;
  }

  _draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const vp = this.app.viewport;
    const r = vp.renderer.domElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(r.width * dpr) || this.canvas.height !== Math.round(r.height * dpr)) {
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);

    const mmPerPx = this._mmPerPixel();
    if (!isFinite(mmPerPx) || mmPerPx <= 0) return;
    const targetPx = 150;
    const mmBar = this._niceLength(mmPerPx * targetPx);
    const barPx = mmBar / mmPerPx;

    const x0 = 20, y0 = r.height - 42;
    ctx.strokeStyle = 'rgba(230,237,243,0.9)';
    ctx.fillStyle = 'rgba(230,237,243,0.95)';
    ctx.lineWidth = 2;
    ctx.font = '12px system-ui, sans-serif';

    // barra principal
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x0 + barPx, y0);
    ctx.stroke();

    // sub-traços a cada 1/10 (mm ou cm dependendo da escala)
    const divs = 10;
    for (let i = 0; i <= divs; i++) {
      const x = x0 + (barPx * i) / divs;
      const big = (i % 5 === 0);
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 - (big ? 12 : 6));
      ctx.stroke();
    }
    const label = mmBar >= 10 ? `${mmBar} mm  (${(mmBar / 10).toLocaleString('pt-BR')} cm)` : `${mmBar} mm`;
    ctx.fillText(label, x0, y0 + 18);

    // cotas da peça selecionada
    const sel = this.app.interact.selected;
    if (sel) {
      const size = this.app.objects.bounds(sel).getSize(new THREE.Vector3());
      const f = (v) => (Math.round(v * 10) / 10);
      ctx.fillText(`◧ ${f(size.x)} × ${f(size.y)} × ${f(size.z)} mm`, x0, y0 - 22);
    }
  }
}
