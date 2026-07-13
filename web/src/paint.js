import * as THREE from 'three';

// Pincel: pinta as faces da peça com a caneta usando cores por vértice.
// Cada traço vira um único comando de desfazer (guarda apenas o que mudou).
export class Paint {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.radius = 6; // mm
    this.color = new THREE.Color('#ff8a3d');
    this._stroke = null;

    const geo = new THREE.RingGeometry(0.85, 1, 40);
    geo.rotateX(-Math.PI / 2);
    this.cursor = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x4fc3f7, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide,
    }));
    this.cursor.renderOrder = 999;
    this.cursor.visible = false;
    app.viewport.scene.add(this.cursor);
  }

  setActive(on) {
    this.active = on;
    if (!on) this.cursor.visible = false;
    this.app.emit('paint-changed');
  }

  setColor(hex) { this.color.set(hex); }
  setRadius(r) { this.radius = r; }

  // chamado pelo Interact com o hit do raycast
  showCursorAt(hit) {
    if (!hit) { this.cursor.visible = false; return; }
    this.cursor.visible = true;
    this.cursor.position.copy(hit.point);
    const n = hit.face ? hit.face.normal.clone()
      .transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    this.cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    this.cursor.scale.setScalar(this.radius);
  }

  strokeBegin() { this._stroke = new Map(); } // mesh -> {indices Set, old: Map(i->[r,g,b])}

  strokeEnd() {
    const stroke = this._stroke;
    this._stroke = null;
    if (!stroke || !stroke.size) return;
    const entries = [];
    for (const [mesh, rec] of stroke) {
      entries.push({ mesh, old: rec.old, neu: new Map() });
    }
    for (const e of entries) {
      const attr = e.mesh.geometry.attributes.color;
      for (const i of e.old.keys()) {
        e.neu.set(i, [attr.getX(i), attr.getY(i), attr.getZ(i)]);
      }
    }
    const apply = (list, which) => {
      for (const e of list) {
        const attr = e.mesh.geometry.attributes.color;
        for (const [i, c] of (which === 'old' ? e.old : e.neu)) attr.setXYZ(i, c[0], c[1], c[2]);
        attr.needsUpdate = true;
      }
    };
    this.app.history.push({
      label: 'pintura',
      undo: () => apply(entries, 'old'),
      redo: () => apply(entries, 'neu'),
    });
  }

  paintAt(hit) {
    const mesh = hit.object;
    if (!mesh.isMesh || !mesh.geometry || !mesh.geometry.attributes.position) return;
    const tris = (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count) / 3;
    if (tris > 600000) { this.app.ui.toast('Peça densa demais para pintar'); return; }

    this._ensureVertexColors(mesh);
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const col = g.attributes.color;
    const index = g.index;
    const count = index ? index.count : pos.count;
    const get = (k) => index ? index.getX(k) : k;

    const local = mesh.worldToLocal(hit.point.clone());
    const scl = new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld);
    const r = this.radius / Math.max(scl.x, scl.y, scl.z, 1e-6);
    const r2 = r * r;

    let rec = this._stroke ? this._stroke.get(mesh) : null;
    if (this._stroke && !rec) this._stroke.set(mesh, rec = { old: new Map() });

    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    let changed = false;
    for (let i = 0; i < count; i += 3) {
      const i0 = get(i), i1 = get(i + 1), i2 = get(i + 2);
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      const cx = (a.x + b.x + c.x) / 3 - local.x;
      const cy = (a.y + b.y + c.y) / 3 - local.y;
      const cz = (a.z + b.z + c.z) / 3 - local.z;
      if (cx * cx + cy * cy + cz * cz > r2) continue;
      for (const vi of [i0, i1, i2]) {
        if (rec && !rec.old.has(vi)) rec.old.set(vi, [col.getX(vi), col.getY(vi), col.getZ(vi)]);
        col.setXYZ(vi, this.color.r, this.color.g, this.color.b);
      }
      changed = true;
    }
    if (changed) col.needsUpdate = true;
  }

  _ensureVertexColors(mesh) {
    const g = mesh.geometry;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!g.attributes.color) {
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      const base = (mat && mat.color) ? mat.color : new THREE.Color(0xffffff);
      for (let i = 0; i < n; i++) arr.set([base.r, base.g, base.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    if (mat && !mat.vertexColors) {
      mat.vertexColors = true;
      mat.color.set(0xffffff);
      mat.needsUpdate = true;
    }
    const root = this.app.objects.findRoot(mesh);
    if (root) root.userData.geomDirty = true; // será salvo como malha completa
  }
}
