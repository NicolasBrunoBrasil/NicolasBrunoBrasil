import * as THREE from 'three';

// Escultura: deforma a malha empurrando os vértices no raio de um pincel.
//  - inflar : puxa a superfície para fora (ao longo da normal)
//  - afundar: empurra para dentro
//  - suavizar: relaxa (Laplaciano) para alisar
//  - puxar  : arrasta os vértices na direção do movimento (modo "seta")
// Malhas muito grosseiras são subdivididas ao iniciar, para ter resolução.
export class Sculpt {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.mode = 'inflar';
    this.radius = 10;   // mm
    this.strength = 1.2; // mm por passada

    const geo = new THREE.RingGeometry(0.9, 1, 48);
    geo.rotateX(-Math.PI / 2);
    this.cursor = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x8de0ff, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide,
    }));
    this.cursor.renderOrder = 999;
    this.cursor.visible = false;
    app.viewport.scene.add(this.cursor);

    this._stroke = null;
    this._mesh = null;
  }

  setActive(on, mode) {
    this.active = on;
    if (mode) this.mode = mode;
    if (!on) { this.cursor.visible = false; this._mesh = null; }
    this.app.emit('sculpt-changed');
  }
  setMode(mode) { this.mode = mode; this.app.emit('sculpt-changed'); }
  setRadius(r) { this.radius = r; }
  setStrength(s) { this.strength = s; }

  showCursorAt(hit) {
    if (!hit) { this.cursor.visible = false; return; }
    this.cursor.visible = true;
    this.cursor.position.copy(hit.point);
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : new THREE.Vector3(0, 1, 0);
    this.cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    this.cursor.scale.setScalar(this.radius);
  }

  // ---------- ciclo de um traço ----------
  begin(hit) {
    const mesh = hit.object;
    if (!mesh.isMesh || !mesh.geometry || !mesh.geometry.attributes.position) return false;
    if (!this._makeSculptable(mesh)) return false;
    this._mesh = mesh;
    this._stroke = { old: new Map() };
    this._adj = null;
    this._lastLocal = mesh.worldToLocal(hit.point.clone());
    this.stroke(hit);
    return true;
  }

  stroke(hit) {
    const mesh = this._mesh;
    if (!mesh) return;
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const nrm = g.attributes.normal;
    const local = mesh.worldToLocal(hit.point.clone());
    const scl = new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld);
    const avgScale = Math.max((scl.x + scl.y + scl.z) / 3, 1e-6);
    const r = this.radius / avgScale;
    const r2 = r * r;
    const stepMM = this.strength / avgScale;
    const rec = this._stroke;

    const remember = (i) => {
      if (!rec.old.has(i)) rec.old.set(i, [pos.getX(i), pos.getY(i), pos.getZ(i)]);
    };

    if (this.mode === 'suavizar') {
      const adj = this._adjacency(g);
      const touched = [];
      for (let i = 0; i < pos.count; i++) {
        const dx = pos.getX(i) - local.x, dy = pos.getY(i) - local.y, dz = pos.getZ(i) - local.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        touched.push([i, 1 - Math.sqrt(d2) / r]);
      }
      const orig = new Map();
      for (const [i] of touched) orig.set(i, [pos.getX(i), pos.getY(i), pos.getZ(i)]);
      for (const [i, fall] of touched) {
        const nb = adj[i];
        if (!nb || !nb.length) continue;
        let sx = 0, sy = 0, sz = 0;
        for (const j of nb) { const o = orig.get(j) || [pos.getX(j), pos.getY(j), pos.getZ(j)]; sx += o[0]; sy += o[1]; sz += o[2]; }
        const inv = 1 / nb.length;
        remember(i);
        const w = 0.6 * fall;
        pos.setXYZ(i,
          pos.getX(i) + (sx * inv - pos.getX(i)) * w,
          pos.getY(i) + (sy * inv - pos.getY(i)) * w,
          pos.getZ(i) + (sz * inv - pos.getZ(i)) * w);
      }
    } else if (this.mode === 'puxar') {
      // desloca no plano da câmera, na direção do movimento do ponteiro
      const deltaWorld = hit.point.clone().sub(this._lastWorld || hit.point);
      const deltaLocal = local.clone().sub(this._lastLocal);
      for (let i = 0; i < pos.count; i++) {
        const dx = pos.getX(i) - this._lastLocal.x, dy = pos.getY(i) - this._lastLocal.y, dz = pos.getZ(i) - this._lastLocal.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const fall = smooth(1 - Math.sqrt(d2) / r);
        remember(i);
        pos.setXYZ(i, pos.getX(i) + deltaLocal.x * fall, pos.getY(i) + deltaLocal.y * fall, pos.getZ(i) + deltaLocal.z * fall);
      }
    } else {
      const sign = this.mode === 'afundar' ? -1 : 1;
      for (let i = 0; i < pos.count; i++) {
        const dx = pos.getX(i) - local.x, dy = pos.getY(i) - local.y, dz = pos.getZ(i) - local.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const fall = smooth(1 - Math.sqrt(d2) / r);
        remember(i);
        pos.setXYZ(i,
          pos.getX(i) + nrm.getX(i) * stepMM * fall * sign,
          pos.getY(i) + nrm.getY(i) * stepMM * fall * sign,
          pos.getZ(i) + nrm.getZ(i) * stepMM * fall * sign);
      }
    }
    pos.needsUpdate = true;
    this._lastLocal = local;
    this._lastWorld = hit.point.clone();
    this._dirtyNormals = true;
    // recomputa normais esparsamente para o pincel continuar seguindo a superfície
    if (this.mode !== 'puxar') { g.computeVertexNormals(); this._dirtyNormals = false; }
  }

  end() {
    const mesh = this._mesh;
    const rec = this._stroke;
    this._mesh = null;
    this._stroke = null;
    if (!mesh || !rec || !rec.old.size) return;
    const g = mesh.geometry;
    if (this._dirtyNormals) g.computeVertexNormals();

    const pos = g.attributes.position;
    const neu = new Map();
    for (const i of rec.old.keys()) neu.set(i, [pos.getX(i), pos.getY(i), pos.getZ(i)]);
    const apply = (which) => {
      const src = which === 'old' ? rec.old : neu;
      for (const [i, p] of src) pos.setXYZ(i, p[0], p[1], p[2]);
      pos.needsUpdate = true;
      g.computeVertexNormals();
      mesh.geometry.computeBoundingSphere();
      this.app.interact.refreshSelection();
    };
    mesh.userData.geomDirty = true;
    this.app.history.push({ label: 'esculpir', undo: () => apply('old'), redo: () => apply('neu') });
    this.app.emit('selection-changed');
  }

  // ---------- preparo da malha ----------
  _makeSculptable(mesh) {
    const g = mesh.geometry;
    let tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
    if (tris > 400000) { this.app.ui.toast('Peça densa demais para esculpir'); return false; }
    if (mesh.userData.sculptReady) {
      // garante posições não compartilhadas de forma incorreta: já soldada
      if (!g.index) g.setIndex(makeSeqIndex(g.attributes.position.count));
      return true;
    }
    // solda vértices (indexa) para não abrir fendas ao mover
    let welded = weld(g);
    // subdivide malhas grosseiras para ganhar resolução de escultura
    let guard = 0;
    while ((welded.indices.length / 3) < 6000 && (welded.indices.length / 3) * 4 < 120000 && guard++ < 3) {
      welded = subdivide(welded.positions, welded.indices);
    }
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.BufferAttribute(new Float32Array(welded.positions), 3));
    ng.setIndex(welded.indices.length > 65535 ? welded.indices : welded.indices);
    // preserva cores de vértice não é trivial após re-topologia: descarta a tinta
    ng.computeVertexNormals();
    mesh.geometry.dispose();
    mesh.geometry = ng;
    mesh.userData.sculptReady = true;
    mesh.userData.geomDirty = true;
    if (mesh.material && mesh.material.vertexColors) {
      mesh.material.vertexColors = false;
      mesh.material.needsUpdate = true;
    }
    return true;
  }

  _adjacency(g) {
    if (this._adj && this._adjGeo === g.uuid) return this._adj;
    const n = g.attributes.position.count;
    const adj = new Array(n);
    const idx = g.index;
    const push = (a, b) => { (adj[a] || (adj[a] = [])).push(b); };
    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
        push(a, b); push(b, a); push(b, c); push(c, b); push(c, a); push(a, c);
      }
    }
    this._adj = adj;
    this._adjGeo = g.uuid;
    return adj;
  }
}

function smooth(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

function makeSeqIndex(count) {
  const arr = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i++) arr[i] = i;
  return new THREE.BufferAttribute(arr, 1);
}

function weld(geometry) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const map = new Map();
  const positions = [];
  const remap = new Array(pos.count);
  const key = (x, y, z) => `${Math.round(x * 2000)}_${Math.round(y * 2000)}_${Math.round(z * 2000)}`;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = key(x, y, z);
    let vi = map.get(k);
    if (vi === undefined) { vi = positions.length / 3; positions.push(x, y, z); map.set(k, vi); }
    remap[i] = vi;
  }
  const count = index ? index.count : pos.count;
  const get = (k) => index ? index.getX(k) : k;
  const indices = [];
  for (let i = 0; i < count; i += 3) {
    const a = remap[get(i)], b = remap[get(i + 1)], c = remap[get(i + 2)];
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  }
  return { positions, indices };
}

function subdivide(positions, indices) {
  const newPos = positions.slice();
  const midCache = new Map();
  const mid = (a, b) => {
    const k = a < b ? a * 10000000 + b : b * 10000000 + a;
    let m = midCache.get(k);
    if (m === undefined) {
      m = newPos.length / 3;
      newPos.push(
        (positions[a * 3] + positions[b * 3]) / 2,
        (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2,
        (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2);
      midCache.set(k, m);
    }
    return m;
  };
  const out = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    out.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return { positions: newPos, indices: out };
}
