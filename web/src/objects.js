import * as THREE from 'three';
import { textToGeometry, buildReliefGeometry, grayToB64 } from './shapegen.js';

export const PALETTE = [
  '#4fc3f7', '#66bb6a', '#ffb74d', '#e57373', '#ba68c8', '#f06292',
  '#4db6ac', '#fff176', '#a1887f', '#90a4ae', '#7986cb', '#e0e0e0',
];

// Acabamentos de material (aplicados sobre MeshPhysicalMaterial)
export const FINISHES = {
  padrao:    { label: 'Padrão',    roughness: 0.55, metalness: 0.05, clearcoat: 0,   iridescence: 0 },
  fosco:     { label: 'Fosco',     roughness: 0.95, metalness: 0.0,  clearcoat: 0,   iridescence: 0 },
  brilhante: { label: 'Brilhante', roughness: 0.12, metalness: 0.05, clearcoat: 0.7, iridescence: 0 },
  metalico:  { label: 'Metálico',  roughness: 0.28, metalness: 1.0,  clearcoat: 0,   iridescence: 0 },
  camaleao:  { label: 'Camaleão',  roughness: 0.3,  metalness: 0.75, clearcoat: 0.5, iridescence: 1 },
};

export function applyFinish(material, finish) {
  const f = FINISHES[finish] || FINISHES.padrao;
  material.roughness = f.roughness;
  material.metalness = f.metalness;
  if ('clearcoat' in material) {
    material.clearcoat = f.clearcoat;
    material.clearcoatRoughness = 0.15;
    material.iridescence = f.iridescence;
    material.iridescenceIOR = 1.9;
  }
  material.userData.finish = finish;
  material.needsUpdate = true;
}

const PRIM_NAMES = {
  box: 'Cubo', sphere: 'Esfera', cylinder: 'Cilindro', cone: 'Cone',
  torus: 'Anel', plate: 'Placa', wedge: 'Rampa',
  tube: 'Tubo', pyramid: 'Pirâmide', hexprism: 'Prisma 6', triprism: 'Prisma 3',
  star: 'Estrela', heart: 'Coração', dome: 'Cúpula', capsule: 'Cápsula',
  disc: 'Disco', washer: 'Arruela', gear: 'Engrenagem', lbracket: 'Cantoneira',
  extrude: 'Esboço', import: 'Modelo', text: 'Texto', image: 'Imagem',
  relief: 'Relevo', csg: 'Peça',
};

export class Objects {
  constructor(app) {
    this.app = app;
    this.list = [];
    this._counter = 0;
    this._palIdx = 0;
  }

  nextColor() {
    const c = PALETTE[this._palIdx % PALETTE.length];
    this._palIdx++;
    return c;
  }

  makeMaterial(color, finish = 'padrao') {
    const m = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color),
      envMapIntensity: 0.85,
    });
    applyFinish(m, finish);
    return m;
  }

  setFinish(obj, finish) {
    this.eachMaterial(obj, m => applyFinish(m, finish));
  }

  createText(text, { sizeMM = 20, depthMM = 5 } = {}) {
    const { geometry, spec } = textToGeometry(text, { sizeMM, depthMM });
    const mesh = new THREE.Mesh(geometry, this.makeMaterial(this.nextColor()));
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = text.slice(0, 24) || this.makeName('text');
    mesh.userData.kind = 'text';
    mesh.userData.extrude = spec; // altura editável como qualquer extrusão
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const half = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2;
    const spot = this.findFreeSpot(half);
    mesh.position.set(spot.x, -bb.min.y, spot.z);
    return mesh;
  }

  createRelief(gray, w, h, params) {
    const geometry = buildReliefGeometry(gray, w, h, params);
    const mesh = new THREE.Mesh(geometry, this.makeMaterial(this.nextColor()));
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = this.makeName('relief');
    mesh.userData.kind = 'relief';
    mesh.userData.relief = { gray: grayToB64(gray), w, h, params: { ...params } };
    const half = Math.max(params.widthMM, params.widthMM * h / w) / 2;
    const spot = this.findFreeSpot(half);
    mesh.position.set(spot.x, 0, spot.z);
    return mesh;
  }

  makeName(kind) {
    this._counter++;
    return `${PRIM_NAMES[kind] || 'Objeto'} ${this._counter}`;
  }

  geometryFor(kind) {
    switch (kind) {
      case 'box': return new THREE.BoxGeometry(20, 20, 20);
      case 'sphere': return new THREE.SphereGeometry(12, 48, 32);
      case 'cylinder': return new THREE.CylinderGeometry(10, 10, 20, 48);
      case 'cone': return new THREE.ConeGeometry(10, 20, 48);
      case 'torus': {
        const g = new THREE.TorusGeometry(12, 4, 20, 64);
        g.rotateX(-Math.PI / 2);
        return g;
      }
      case 'plate': return new THREE.BoxGeometry(40, 2, 40);
      case 'wedge': {
        const sh = new THREE.Shape([
          new THREE.Vector2(-10, 0), new THREE.Vector2(10, 0), new THREE.Vector2(-10, 20),
        ]);
        const g = new THREE.ExtrudeGeometry(sh, { depth: 20, bevelEnabled: false });
        g.rotateX(-Math.PI / 2);
        g.center();
        return g;
      }
      case 'pyramid': {
        const g = new THREE.ConeGeometry(15, 22, 4);
        g.rotateY(Math.PI / 4);
        return g;
      }
      case 'hexprism': return new THREE.CylinderGeometry(13, 13, 20, 6);
      case 'triprism': return new THREE.CylinderGeometry(13, 13, 20, 3);
      case 'capsule': return new THREE.CapsuleGeometry(8, 16, 8, 24);
      case 'disc': return new THREE.CylinderGeometry(16, 16, 4, 56);
      case 'dome': return new THREE.SphereGeometry(14, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2);
      case 'tube': return extrudeUp(ringShape(12, 7), 20);
      case 'washer': return extrudeUp(ringShape(15, 7), 4);
      case 'star': return extrudeUp(starShape(5, 16, 7), 8);
      case 'heart': return extrudeUp(heartShape(1.0), 8);
      case 'gear': return extrudeUp(gearShape(16, 15, 12, 5), 8);
      case 'lbracket': return extrudeUp(lShape(28, 28, 9), 16);
      default: return null;
    }
  }

  createPrimitive(kind) {
    const geo = this.geometryFor(kind);
    if (!geo) return null;
    const mesh = new THREE.Mesh(geo, this.makeMaterial(this.nextColor()));
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = this.makeName(kind);
    mesh.userData.kind = kind;
    mesh.userData.isUserObject = true;

    // apoia no chão e procura um lugar livre
    geo.computeBoundingBox();
    mesh.position.y = -geo.boundingBox.min.y;
    const half = Math.max(
      geo.boundingBox.max.x - geo.boundingBox.min.x,
      geo.boundingBox.max.z - geo.boundingBox.min.z) / 2;
    const spot = this.findFreeSpot(half);
    mesh.position.x = spot.x;
    mesh.position.z = spot.z;
    return mesh;
  }

  findFreeSpot(half) {
    const boxes = this.list.map(o => new THREE.Box3().setFromObject(o));
    const step = Math.max(30, half * 2 + 8);
    const candidates = [[0, 0]];
    for (let r = 1; r <= 5; r++) {
      for (let i = -r; i <= r; i++) {
        candidates.push([i * step, -r * step], [i * step, r * step]);
        if (Math.abs(i) < r) candidates.push([-r * step, i * step], [r * step, i * step]);
      }
    }
    for (const [x, z] of candidates) {
      const test = new THREE.Box3(
        new THREE.Vector3(x - half - 2, -1, z - half - 2),
        new THREE.Vector3(x + half + 2, 1000, z + half + 2));
      if (!boxes.some(b => b.intersectsBox(test))) return new THREE.Vector3(x, 0, z);
    }
    return new THREE.Vector3(0, 0, 0);
  }

  prepare(obj) {
    obj.traverse(o => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    obj.userData.isUserObject = true;
    return obj;
  }

  add(obj, { history = true, select = true } = {}) {
    this.prepare(obj);
    this.app.viewport.scene.add(obj);
    this.list.push(obj);
    this.app.emit('objects-changed');
    if (select) this.app.interact.select(obj);
    if (history) {
      this.app.history.push({
        label: 'adicionar',
        undo: () => this._detach(obj),
        redo: () => this._attach(obj),
      });
    }
    return obj;
  }

  remove(obj, { history = true } = {}) {
    this._detach(obj);
    if (history) {
      this.app.history.push({
        label: 'excluir',
        undo: () => this._attach(obj),
        redo: () => this._detach(obj),
      });
    } else {
      this.dispose(obj);
    }
  }

  _attach(obj) {
    this.app.viewport.scene.add(obj);
    if (!this.list.includes(obj)) this.list.push(obj);
    this.app.emit('objects-changed');
  }

  _detach(obj) {
    if (this.app.interact.selected === obj) this.app.interact.select(null);
    this.app.viewport.scene.remove(obj);
    const i = this.list.indexOf(obj);
    if (i >= 0) this.list.splice(i, 1);
    this.app.emit('objects-changed');
  }

  removeAll() {
    for (const obj of [...this.list]) { this._detach(obj); this.dispose(obj); }
    this._counter = 0;
    this._palIdx = 0;
  }

  duplicate(obj) {
    const clone = obj.clone(true);
    clone.traverse(o => {
      if (o.isMesh && o.material) {
        o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone();
      }
    });
    clone.name = obj.name.replace(/ \(cópia\)$/, '') + ' (cópia)';
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    clone.position.x += Math.max(size.x, 12) + 6;
    return this.add(clone);
  }

  dropToGround(obj) {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return;
    obj.position.y -= box.min.y;
  }

  // posiciona 'obj' apoiado sobre o topo de 'target' (centralizado ou em atPoint)
  placeOnTop(obj, target, atPoint) {
    obj.updateMatrixWorld(true);
    const tbox = this.bounds(target);
    const obox = this.bounds(obj);
    const cx = atPoint ? atPoint.x : (tbox.min.x + tbox.max.x) / 2;
    const cz = atPoint ? atPoint.z : (tbox.min.z + tbox.max.z) / 2;
    const topY = atPoint ? atPoint.y : tbox.max.y;
    obj.position.x += cx - (obox.min.x + obox.max.x) / 2;
    obj.position.z += cz - (obox.min.z + obox.max.z) / 2;
    obj.position.y += topY - obox.min.y;
  }

  // "drapeia" a malha sobre a superfície de 'target' seguindo o contorno/ondulado.
  // Cada vértice desce até tocar o alvo (campo de altura) mantendo a espessura.
  drapeOnSurface(obj, target, { lift = 0.4 } = {}) {
    const mesh = obj.isMesh ? obj : this.firstMeshOf(obj);
    if (!mesh) return false;
    target.updateMatrixWorld(true);
    mesh.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const tbox = this.bounds(target);
    const top = tbox.max.y + 100;
    const pos = mesh.geometry.attributes.position;
    const cache = new Map();
    const wx0 = mesh.position.x, wz0 = mesh.position.z;
    let any = false;
    for (let i = 0; i < pos.count; i++) {
      const wx = wx0 + pos.getX(i), wz = wz0 + pos.getZ(i);
      const key = Math.round(wx * 4) + '_' + Math.round(wz * 4);
      let sy = cache.get(key);
      if (sy === undefined) {
        ray.set(new THREE.Vector3(wx, top, wz), down);
        const hit = ray.intersectObject(target, true);
        sy = hit.length ? hit[0].point.y : null;
        cache.set(key, sy);
      }
      if (sy !== null) { pos.setY(i, pos.getY(i) + (sy - mesh.position.y) + lift); any = true; }
    }
    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    mesh.geometry.computeBoundingBox();
    mesh.userData.geomDirty = true;
    return any;
  }

  firstMeshOf(obj) {
    let m = null;
    obj.traverse(o => { if (!m && o.isMesh) m = o; });
    return m;
  }

  bounds(obj) { return new THREE.Box3().setFromObject(obj); }

  boundsAll() {
    const box = new THREE.Box3();
    for (const o of this.list) if (o.visible) box.expandByObject(o);
    return box;
  }

  findRoot(node) {
    let n = node;
    while (n) {
      if (n.userData && n.userData.isUserObject) return this.list.includes(n) ? n : null;
      n = n.parent;
    }
    return null;
  }

  firstMaterial(obj) {
    let mat = null;
    obj.traverse(o => {
      if (!mat && o.isMesh && o.material) mat = Array.isArray(o.material) ? o.material[0] : o.material;
    });
    return mat;
  }

  eachMaterial(obj, fn) {
    obj.traverse(o => {
      if (o.isMesh && o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(fn);
      }
    });
  }

  triangleCount(obj) {
    let n = 0;
    obj.traverse(o => {
      if (o.isMesh && o.geometry) {
        const g = o.geometry;
        n += (g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0)) / 3;
      }
    });
    return n;
  }

  totalTriangles() {
    return this.list.reduce((s, o) => s + this.triangleCount(o), 0);
  }

  dispose(obj) {
    obj.traverse(o => {
      if (o.isMesh) {
        o.geometry && o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m && m.dispose());
      }
    });
  }
}

// ---------- geradores de forma (extrusão em pé, base no chão) ----------
function extrudeUp(shape, depth) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 24 });
  g.rotateX(-Math.PI / 2); // forma XY -> chão XZ, extrusão para +Y
  g.computeBoundingBox();
  const bb = g.boundingBox;
  g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  g.computeVertexNormals();
  return g;
}

function ringShape(outer, inner) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  return shape;
}

function starShape(spikes, outer, inner) {
  const shape = new THREE.Shape();
  const n = spikes * 2;
  for (let i = 0; i < n; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

function heartShape(scale) {
  const shape = new THREE.Shape();
  const n = 90;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    const px = x * scale, py = y * scale;
    if (i === 0) shape.moveTo(px, py); else shape.lineTo(px, py);
  }
  shape.closePath();
  return shape;
}

function gearShape(teeth, outer, root, holeR) {
  const shape = new THREE.Shape();
  const steps = teeth * 4;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const r = (Math.floor(i / 2) % 2 === 0) ? outer : root;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, holeR, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  return shape;
}

function lShape(w, h, t) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(w, 0);
  shape.lineTo(w, t);
  shape.lineTo(t, t);
  shape.lineTo(t, h);
  shape.lineTo(0, h);
  shape.closePath();
  return shape;
}
