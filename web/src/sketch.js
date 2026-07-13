import * as THREE from 'three';
import { recognizeShape } from './recognize.js';

// Modo esboço: desenha com a caneta no plano do chão (vista de topo).
// - modo 'add': extruda os traços para criar um sólido (furos automáticos)
// - modo 'cut': usa os traços como cortador e subtrai da peça alvo
// Correção mágica (✨): reconhece círculo/estrela/retângulo/… e endireita.
export class Sketch {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.stroking = false;
    this.tool = 'free';
    this.mode = 'add';
    this.cutTarget = null;
    this.magic = true;
    this.strokes = []; // cada traço: pontos {x,y} nas coords do chão (x,z)
    this.defaultDepth = 10;

    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._group = new THREE.Group();
    this._group.visible = false;
    app.viewport.scene.add(this._group);

    const tint = new THREE.Mesh(
      new THREE.PlaneGeometry(300, 300),
      new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.05, depthWrite: false })
    );
    tint.rotation.x = -Math.PI / 2;
    tint.position.y = 0.02;
    this._group.add(tint);
    this._tint = tint;

    this._lineMat = new THREE.LineBasicMaterial({ color: 0x4fc3f7 });
    this._cutMat = new THREE.LineBasicMaterial({ color: 0xff7043 });
    this._doneMat = new THREE.LineBasicMaterial({ color: 0x8de0ff, transparent: true, opacity: 0.85 });
    this._doneCutMat = new THREE.LineBasicMaterial({ color: 0xffab91, transparent: true, opacity: 0.9 });
    this._lines = [];
    this._live = null;
    this._livePts = [];
  }

  enter(opts = {}) {
    if (this.active) return;
    this.active = true;
    this.mode = opts.mode || 'add';
    this.cutTarget = opts.target || null;
    const vp = this.app.viewport;
    this._savedCam = { pos: vp.camera.position.clone(), tgt: vp.controls.target.clone() };

    let cx = 0, cz = 0, d = Math.max(vp.camera.position.distanceTo(vp.controls.target), 180);
    if (this.cutTarget) {
      const box = this.app.objects.bounds(this.cutTarget);
      const c = box.getCenter(new THREE.Vector3());
      cx = c.x; cz = c.z;
      d = Math.max(box.getSize(new THREE.Vector3()).length() * 1.8, 120);
      this._tint.material.color.set(0xff7043);
    } else {
      this._tint.material.color.set(0x4fc3f7);
    }
    vp.animateTo(new THREE.Vector3(cx, d, cz + 0.0001), new THREE.Vector3(cx, 0, cz));
    vp.controls.enableRotate = false;
    this._savedTouchOne = vp.controls.touches.ONE;
    vp.controls.touches.ONE = THREE.TOUCH.PAN;
    this._group.visible = true;
    if (this.mode === 'add') this.app.interact.select(null);
    this.app.emit('sketch-changed');
  }

  exit(cancelled = false) {
    if (!this.active) return;
    this.active = false;
    this.stroking = false;
    this.cutTarget = null;
    this._clearStrokes();
    const vp = this.app.viewport;
    vp.controls.enableRotate = true;
    vp.controls.touches.ONE = this._savedTouchOne ?? THREE.TOUCH.ROTATE;
    this._group.visible = false;
    if (cancelled && this._savedCam) vp.animateTo(this._savedCam.pos, this._savedCam.tgt);
    this.app.emit('sketch-changed');
  }

  setTool(t) { this.tool = t; this.app.emit('sketch-changed'); }
  setMagic(on) { this.magic = on; this.app.emit('sketch-changed'); }
  tap() { /* reservado */ }

  // ---------- entrada da caneta ----------
  pointerDown(e) {
    const p = this.app.viewport.planeHit(e, this._plane);
    if (!p) return;
    this.stroking = true;
    this._start = new THREE.Vector2(p.x, p.z);
    this._livePts = [this._start.clone()];
    this._ensureLive();
  }

  pointerMove(e) {
    if (!this.stroking) return;
    const p = this.app.viewport.planeHit(e, this._plane);
    if (!p) return;
    const cur = new THREE.Vector2(p.x, p.z);
    if (this.tool === 'free') {
      const last = this._livePts[this._livePts.length - 1];
      if (last.distanceTo(cur) >= 0.4) this._livePts.push(cur);
    } else if (this.tool === 'rect') {
      const a = this._start, b = cur;
      if (this.app.interact.snapping) { b.x = Math.round(b.x); b.y = Math.round(b.y); }
      this._livePts = [
        new THREE.Vector2(a.x, a.y), new THREE.Vector2(b.x, a.y),
        new THREE.Vector2(b.x, b.y), new THREE.Vector2(a.x, b.y),
      ];
    } else if (this.tool === 'circle') {
      let r = this._start.distanceTo(cur);
      if (this.app.interact.snapping) r = Math.max(1, Math.round(r));
      const n = 64;
      this._livePts = [];
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        this._livePts.push(new THREE.Vector2(
          this._start.x + Math.cos(t) * r, this._start.y + Math.sin(t) * r));
      }
    }
    this._updateLive();
  }

  pointerUp() {
    if (!this.stroking) return;
    this.stroking = false;
    let pts = this._livePts;
    this._livePts = [];
    this._removeLive();

    if (this.tool === 'free') {
      pts = smooth(pts);
      pts = simplify(pts, 0.7);
      if (pts.length >= 6 && this.magic) {
        const rec = recognizeShape(pts);
        if (rec) {
          pts = rec.pts.map(p => new THREE.Vector2(p.x, p.y));
          this.app.ui.toast(`✨ Corrigido: ${rec.label}`);
        }
      }
    }
    if (pts.length < 3 || Math.abs(area(pts)) < 4) { this.app.emit('sketch-changed'); return; }

    this.strokes.push(pts);
    this._addStrokeLine(pts);
    this.app.emit('sketch-changed');
  }

  pointerCancel() {
    this.stroking = false;
    this._livePts = [];
    this._removeLive();
  }

  undoStroke() {
    if (!this.strokes.length) return;
    this.strokes.pop();
    const line = this._lines.pop();
    if (line) { this._group.remove(line); line.geometry.dispose(); }
    this.app.emit('sketch-changed');
  }

  // ---------- conclusão ----------
  finish() {
    if (!this.strokes.length) { this.exit(true); return; }
    const polys = this.strokes.map(pts => pts.map(p => ({ x: p.x, y: -p.y }))); // chão -> forma
    const spec = buildSpecFromPolys(polys, this.defaultDepth);
    if (!spec) { this.exit(true); return; }

    if (this.mode === 'cut') {
      const target = this.cutTarget;
      this.exit(false);
      if (target) this.app.ops.cutWithSpec(target, spec);
      return null;
    }

    const geo = buildExtrudeGeometry(spec);
    const objs = this.app.objects;
    const mesh = new THREE.Mesh(geo.geometry, objs.makeMaterial(objs.nextColor()));
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = objs.makeName('extrude');
    mesh.userData.kind = 'extrude';
    mesh.userData.extrude = spec;
    mesh.position.copy(geo.center);

    this.exit(false);
    objs.add(mesh);
    this.app.ui.toast('Ajuste a “Altura” no painel de propriedades');
    return mesh;
  }

  // ---------- linhas de pré-visualização ----------
  _ensureLive() {
    this._removeLive();
    this._liveGeo = new THREE.BufferGeometry();
    this._live = new THREE.Line(this._liveGeo, this.mode === 'cut' ? this._cutMat : this._lineMat);
    this._live.position.y = 0.1;
    this._group.add(this._live);
    this._updateLive();
  }

  _updateLive() {
    if (!this._live) return;
    const pts = this._livePts.map(p => new THREE.Vector3(p.x, 0, p.y));
    if (pts.length > 1 && this.tool !== 'free') pts.push(pts[0].clone());
    this._liveGeo.setFromPoints(pts);
  }

  _removeLive() {
    if (this._live) {
      this._group.remove(this._live);
      this._liveGeo.dispose();
      this._live = null;
    }
  }

  _addStrokeLine(pts) {
    const v = pts.map(p => new THREE.Vector3(p.x, 0, p.y));
    v.push(v[0].clone());
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(v),
      this.mode === 'cut' ? this._doneCutMat : this._doneMat);
    line.position.y = 0.1;
    this._group.add(line);
    this._lines.push(line);
  }

  _clearStrokes() {
    this.strokes = [];
    for (const l of this._lines) { this._group.remove(l); l.geometry.dispose(); }
    this._lines = [];
    this._removeLive();
  }
}

// ---------- construção de sólidos a partir de polígonos 2D ----------

// polys: lista de laços [{x,y},…] em coords de forma (y para cima).
// Classifica por paridade de contenção: nível par = contorno, ímpar = furo.
export function buildSpecFromPolys(polys, depth) {
  const sorted = polys
    .map(pts => pts.map(p => new THREE.Vector2(p.x, p.y)))
    .filter(pts => pts.length >= 3 && Math.abs(area(pts)) > 1)
    .sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
  if (!sorted.length) return null;

  const entries = sorted.map(pts => ({ pts, depth: 0, parent: null }));
  for (let i = 0; i < entries.length; i++) {
    for (let j = 0; j < i; j++) {
      if (pointInPoly(entries[i].pts[0], entries[j].pts)) {
        entries[i].depth++;
        if (entries[i].parent === null || entries[j].depth >= entries[entries[i].parent].depth) {
          entries[i].parent = j;
        }
      }
    }
  }

  const outers = [];
  entries.forEach((e) => {
    if (e.depth % 2 === 0) {
      e.outerIndex = outers.length;
      outers.push({ pts: ensureWinding(e.pts, true), holes: [] });
    }
  });
  entries.forEach((e) => {
    if (e.depth % 2 === 1 && e.parent !== null && entries[e.parent].outerIndex !== undefined) {
      outers[entries[e.parent].outerIndex].holes.push(ensureWinding(e.pts, false));
    }
  });
  if (!outers.length) return null;

  return {
    outers: outers.map(o => ({
      pts: o.pts.map(p => [round3(p.x), round3(p.y)]),
      holes: o.holes.map(h => h.map(p => [round3(p.x), round3(p.y)])),
    })),
    depth,
  };
}

// Reconstrói a geometria extrudada a partir da especificação salva.
export function buildExtrudeGeometry(spec) {
  const shapes = spec.outers.map(o => {
    const shape = new THREE.Shape(o.pts.map(p => new THREE.Vector2(p[0], p[1])));
    for (const h of o.holes) {
      shape.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p[0], p[1]))));
    }
    return shape;
  });
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth: spec.depth, bevelEnabled: false, curveSegments: 12,
  });
  geometry.rotateX(-Math.PI / 2); // forma XY -> chão XZ, extrusão para +Y
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
  geometry.translate(-cx, 0, -cz);
  return { geometry, center: new THREE.Vector3(cx, 0, cz) };
}

export function rebuildExtrudeDepth(mesh, depth) {
  const spec = mesh.userData.extrude;
  if (!spec) return;
  spec.depth = depth;
  const old = mesh.geometry;
  mesh.geometry = buildExtrudeGeometry({ outers: spec.outers, depth }).geometry;
  old.dispose();
}

// ---------- utilidades geométricas ----------
function area(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function ensureWinding(pts, ccw) {
  const a = area(pts);
  if ((ccw && a < 0) || (!ccw && a > 0)) return [...pts].reverse();
  return pts;
}

function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function smooth(pts) {
  if (pts.length < 5) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    out.push(new THREE.Vector2(
      (pts[i - 1].x + pts[i].x * 2 + pts[i + 1].x) / 4,
      (pts[i - 1].y + pts[i].y * 2 + pts[i + 1].y) / 4));
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(pts[i], pts[s], pts[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function round3(v) { return Math.round(v * 1000) / 1000; }
