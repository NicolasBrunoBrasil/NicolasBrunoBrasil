import * as THREE from 'three';

// Escultura suave: o pincel desliza sobre a superfície e a acompanha.
// A chave para não criar "espinhos" é deslocar todos os vértices do pincel
// na MESMA direção (a normal média do pincel), com um falloff suave, e
// aplicar um leve relaxamento a cada passada. Nunca usamos a normal de cada
// vértice isoladamente (é isso que gerava pontas desordenadas).
export class Sculpt {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.mode = 'inflar';
    this.radius = 12;    // mm
    this.strength = 1.0; // mm por passada (suave)

    const geo = new THREE.RingGeometry(0.92, 1, 56);
    geo.rotateX(-Math.PI / 2);
    this.cursor = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x8de0ff, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide,
    }));
    this.cursor.renderOrder = 999;
    this.cursor.visible = false;
    app.viewport.scene.add(this.cursor);

    this._stroke = null;
    this._mesh = null;
    this._adj = null;
    this._adjGeo = null;
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
    this._lastWorld = hit.point.clone();
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
    const step = Math.min(this.strength, this.radius * 0.5) / avgScale;
    const rec = this._stroke;
    const remember = (i) => { if (!rec.old.has(i)) rec.old.set(i, [pos.getX(i), pos.getY(i), pos.getZ(i)]); };

    // 1) vértices afetados + pesos (falloff suave, cai a zero na borda)
    const idx = [], w = [];
    let nx = 0, ny = 0, nz = 0; // normal média do pincel (direção coerente)
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - local.x, dy = pos.getY(i) - local.y, dz = pos.getZ(i) - local.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const fall = smooth(1 - Math.sqrt(d2) / r);
      idx.push(i); w.push(fall);
      nx += nrm.getX(i) * fall; ny += nrm.getY(i) * fall; nz += nrm.getZ(i) * fall;
    }
    if (!idx.length) { this._after(hit, local); return; }
    const nlen = Math.hypot(nx, ny, nz) || 1;
    nx /= nlen; ny /= nlen; nz /= nlen;

    // 2) aplica o modo
    if (this.mode === 'suavizar') {
      this._relax(idx, w, 0.7, remember);
    } else if (this.mode === 'puxar') {
      const dLoc = local.clone().sub(this._lastLocal);
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k], f = w[k];
        remember(i);
        pos.setXYZ(i, pos.getX(i) + dLoc.x * f, pos.getY(i) + dLoc.y * f, pos.getZ(i) + dLoc.z * f);
      }
      this._relax(idx, w, 0.15, remember);
    } else {
      const sign = this.mode === 'afundar' ? -1 : 1;
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k], f = w[k] * step * sign;
        remember(i);
        pos.setXYZ(i, pos.getX(i) + nx * f, pos.getY(i) + ny * f, pos.getZ(i) + nz * f);
      }
      // relaxamento leve mantém a superfície fluida e sem pontas
      this._relax(idx, w, 0.18, remember);
    }

    pos.needsUpdate = true;
    g.computeVertexNormals(); // normais sempre atualizadas -> pincel segue o contorno
    this._after(hit, local);
  }

  _after(hit, local) {
    this._lastLocal = local.clone();
    this._lastWorld = hit.point.clone();
  }

  // relaxamento Laplaciano restrito aos vértices do pincel
  _relax(idx, weights, amount, remember) {
    const g = this._mesh.geometry;
    const pos = g.attributes.position;
    const adj = this._adjacency(g);
    const orig = new Map();
    for (const i of idx) orig.set(i, [pos.getX(i), pos.getY(i), pos.getZ(i)]);
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const nb = adj[i];
      if (!nb || nb.length < 2) continue;
      let sx = 0, sy = 0, sz = 0;
      for (const j of nb) {
        const o = orig.get(j);
        if (o) { sx += o[0]; sy += o[1]; sz += o[2]; }
        else { sx += pos.getX(j); sy += pos.getY(j); sz += pos.getZ(j); }
      }
      const inv = 1 / nb.length;
      const a = amount * weights[k];
      remember(i);
      pos.setXYZ(i,
        pos.getX(i) + (sx * inv - pos.getX(i)) * a,
        pos.getY(i) + (sy * inv - pos.getY(i)) * a,
        pos.getZ(i) + (sz * inv - pos.getZ(i)) * a);
    }
  }

  end() {
    const mesh = this._mesh;
    const rec = this._stroke;
    this._mesh = null;
    this._stroke = null;
    if (!mesh || !rec || !rec.old.size) return;
    const g = mesh.geometry;
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const pos = g.attributes.position;
    const neu = new Map();
    for (const i of rec.old.keys()) neu.set(i, [pos.getX(i), pos.getY(i), pos.getZ(i)]);
    const apply = (which) => {
      const src = which === 'old' ? rec.old : neu;
      for (const [i, p] of src) pos.setXYZ(i, p[0], p[1], p[2]);
      pos.needsUpdate = true;
      g.computeVertexNormals();
      g.computeBoundingSphere();
      this.app.interact.refreshSelection();
    };
    mesh.userData.geomDirty = true;
    this.app.history.push({ label: 'esculpir', undo: () => apply('old'), redo: () => apply('neu') });
    this.app.emit('selection-changed');
  }

  // ---------- preparo da malha ----------
  _makeSculptable(mesh) {
    const g = mesh.geometry;
    const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
    if (tris > 400000) { this.app.ui.toast('Peça densa demais para esculpir'); return false; }
    if (mesh.userData.sculptReady) {
      if (!g.index) g.setIndex(makeSeqIndex(g.attributes.position.count));
      return true;
    }
    let welded = weld(g);
    // subdivide malhas grosseiras para uma superfície bem lisa de esculpir
    let guard = 0;
    while ((welded.indices.length / 3) < 24000 && (welded.indices.length / 3) * 4 < 200000 && guard++ < 4) {
      welded = subdivide(welded.positions, welded.indices);
    }
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.BufferAttribute(new Float32Array(welded.positions), 3));
    ng.setIndex(welded.indices);
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
