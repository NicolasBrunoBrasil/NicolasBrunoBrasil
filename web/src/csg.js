import * as THREE from 'three';

// Operações booleanas (CSG) por árvore BSP — algoritmo clássico do csg.js,
// reescrito de forma iterativa para não estourar a pilha em malhas maiores.
// Trabalha no espaço local da malha A; o resultado mantém o transform de A.

const EPS = 1e-5;
const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;

class Vtx {
  constructor(pos, normal) { this.pos = pos; this.normal = normal; }
  clone() { return new Vtx(this.pos.clone(), this.normal.clone()); }
  flip() { this.normal.negate(); }
  interpolate(o, t) {
    return new Vtx(this.pos.clone().lerp(o.pos, t), this.normal.clone().lerp(o.normal, t).normalize());
  }
}

class Plane {
  constructor(normal, w) { this.normal = normal; this.w = w; }
  static fromPoints(a, b, c) {
    const n = new THREE.Vector3().subVectors(b, a)
      .cross(new THREE.Vector3().subVectors(c, a));
    const len = n.length();
    if (len < 1e-12) return null;
    n.divideScalar(len);
    return new Plane(n, n.dot(a));
  }
  clone() { return new Plane(this.normal.clone(), this.w); }
  flip() { this.normal.negate(); this.w = -this.w; }

  splitPolygon(polygon, coplanarFront, coplanarBack, front, back) {
    let polygonType = 0;
    const types = [];
    for (const v of polygon.vertices) {
      const t = this.normal.dot(v.pos) - this.w;
      const type = t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR;
      polygonType |= type;
      types.push(type);
    }
    switch (polygonType) {
      case COPLANAR:
        (this.normal.dot(polygon.plane.normal) > 0 ? coplanarFront : coplanarBack).push(polygon);
        break;
      case FRONT: front.push(polygon); break;
      case BACK: back.push(polygon); break;
      case SPANNING: {
        const f = [], b = [];
        const n = polygon.vertices.length;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ti = types[i], tj = types[j];
          const vi = polygon.vertices[i], vj = polygon.vertices[j];
          if (ti !== BACK) f.push(vi);
          if (ti !== FRONT) b.push(ti !== BACK ? vi.clone() : vi);
          if ((ti | tj) === SPANNING) {
            const denom = this.normal.dot(new THREE.Vector3().subVectors(vj.pos, vi.pos));
            const t = (this.w - this.normal.dot(vi.pos)) / denom;
            const v = vi.interpolate(vj, t);
            f.push(v);
            b.push(v.clone());
          }
        }
        if (f.length >= 3) { const p = Polygon.tryCreate(f, polygon.shared); if (p) front.push(p); }
        if (b.length >= 3) { const p = Polygon.tryCreate(b, polygon.shared); if (p) back.push(p); }
        break;
      }
    }
  }
}

class Polygon {
  constructor(vertices, plane, shared) {
    this.vertices = vertices;
    this.plane = plane;
    this.shared = shared;
  }
  static tryCreate(vertices, shared) {
    const plane = Plane.fromPoints(vertices[0].pos, vertices[1].pos, vertices[2].pos);
    return plane ? new Polygon(vertices, plane, shared) : null;
  }
  clone() { return new Polygon(this.vertices.map(v => v.clone()), this.plane.clone(), this.shared); }
  flip() {
    this.vertices.reverse();
    for (const v of this.vertices) v.flip();
    this.plane.flip();
  }
}

class Node {
  constructor(polygons) {
    this.plane = null; this.front = null; this.back = null; this.polygons = [];
    if (polygons && polygons.length) this.build(polygons);
  }

  invert() {
    const stack = [this];
    while (stack.length) {
      const n = stack.pop();
      for (const p of n.polygons) p.flip();
      if (n.plane) n.plane.flip();
      const t = n.front; n.front = n.back; n.back = t;
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
  }

  clipPolygons(polygons) {
    let result = [];
    const stack = [{ node: this, polys: polygons }];
    while (stack.length) {
      const { node, polys } = stack.pop();
      if (!node.plane) { result = result.concat(polys); continue; }
      const front = [], back = [];
      for (const p of polys) node.plane.splitPolygon(p, front, back, front, back);
      if (node.front) stack.push({ node: node.front, polys: front });
      else result = result.concat(front);
      if (node.back) stack.push({ node: node.back, polys: back });
      // sem nó atrás: polígonos de trás são descartados (dentro do sólido)
    }
    return result;
  }

  clipTo(bsp) {
    const stack = [this];
    while (stack.length) {
      const n = stack.pop();
      n.polygons = bsp.clipPolygons(n.polygons);
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
  }

  allPolygons() {
    let out = [];
    const stack = [this];
    while (stack.length) {
      const n = stack.pop();
      out = out.concat(n.polygons);
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
    return out;
  }

  build(polygons) {
    const stack = [{ node: this, polys: polygons }];
    while (stack.length) {
      const { node, polys } = stack.pop();
      if (!polys.length) continue;
      if (!node.plane) node.plane = polys[0].plane.clone();
      const front = [], back = [];
      for (const p of polys) {
        node.plane.splitPolygon(p, node.polygons, node.polygons, front, back);
      }
      if (front.length) {
        if (!node.front) node.front = new Node();
        stack.push({ node: node.front, polys: front });
      }
      if (back.length) {
        if (!node.back) node.back = new Node();
        stack.push({ node: node.back, polys: back });
      }
    }
  }
}

// ---------- conversões malha <-> polígonos ----------

function geometryToPolygons(geometry, matrix) {
  const normalMatrix = matrix ? new THREE.Matrix3().getNormalMatrix(matrix) : null;
  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;
  const index = geometry.index;
  const count = index ? index.count : pos.count;
  const polys = [];
  const get = (k) => index ? index.getX(k) : k;
  for (let i = 0; i < count; i += 3) {
    const verts = [];
    let ok = true;
    for (let j = 0; j < 3; j++) {
      const vi = get(i + j);
      const p = new THREE.Vector3().fromBufferAttribute(pos, vi);
      const n = nrm ? new THREE.Vector3().fromBufferAttribute(nrm, vi) : new THREE.Vector3(0, 1, 0);
      if (matrix) { p.applyMatrix4(matrix); n.applyMatrix3(normalMatrix).normalize(); }
      if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) { ok = false; break; }
      verts.push(new Vtx(p, n));
    }
    if (!ok) continue;
    const poly = Polygon.tryCreate(verts, 0);
    if (poly) polys.push(poly);
  }
  return polys;
}

function polygonsToGeometry(polygons) {
  const positions = [], normals = [];
  for (const poly of polygons) {
    const vs = poly.vertices;
    for (let i = 2; i < vs.length; i++) {
      for (const v of [vs[0], vs[i - 1], vs[i]]) {
        positions.push(v.pos.x, v.pos.y, v.pos.z);
        normals.push(v.normal.x, v.normal.y, v.normal.z);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  return g;
}

export function meshTriangleCount(geometry) {
  return (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
}

// Funde todas as malhas-filhas de um objeto numa única geometria no espaço
// local da raiz (necessário para operar em grupos importados).
export function flattenGeometry(root) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const positions = [], normals = [];
  root.traverse(m => {
    if (!m.isMesh || !m.geometry || !m.geometry.attributes.position) return;
    const rel = inv.clone().multiply(m.matrixWorld);
    const nm = new THREE.Matrix3().getNormalMatrix(rel);
    const pos = m.geometry.attributes.position;
    const nrm = m.geometry.attributes.normal;
    const index = m.geometry.index;
    const count = index ? index.count : pos.count;
    const get = (k) => index ? index.getX(k) : k;
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const vi = get(i);
      p.fromBufferAttribute(pos, vi).applyMatrix4(rel);
      positions.push(p.x, p.y, p.z);
      if (nrm) { n.fromBufferAttribute(nrm, vi).applyMatrix3(nm).normalize(); normals.push(n.x, n.y, n.z); }
      else normals.push(0, 1, 0);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  return g;
}

// op: 'subtract' | 'union'  — geometrias no espaço local de A;
// matBtoA leva o espaço local de B para o espaço local de A.
export function csgOperation(geomA, geomB, matBtoA, op) {
  const polysA = geometryToPolygons(geomA, null);
  const polysB = geometryToPolygons(geomB, matBtoA);
  if (!polysA.length) throw new Error('malha A vazia');
  if (!polysB.length) throw new Error('malha B vazia');

  const a = new Node(polysA);
  const b = new Node(polysB);

  if (op === 'subtract') {
    a.invert();
    a.clipTo(b);
    b.clipTo(a);
    b.invert();
    b.clipTo(a);
    b.invert();
    a.build(b.allPolygons());
    a.invert();
  } else { // union
    a.clipTo(b);
    b.clipTo(a);
    b.invert();
    b.clipTo(a);
    b.invert();
    a.build(b.allPolygons());
  }
  const g = polygonsToGeometry(a.allPolygons());
  if (!g.attributes.position.count) throw new Error('resultado vazio');
  return g;
}
