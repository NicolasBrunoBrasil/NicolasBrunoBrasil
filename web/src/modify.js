import * as THREE from 'three';

// Suavização de faces: subdivide os triângulos e relaxa os vértices
// (Laplaciano). Com níveis maiores, um cubo vai virando esfera.

export function subdivideSmooth(baseGeometry, levels) {
  let { positions, indices } = weld(baseGeometry);
  const maxTris = 500000;
  for (let l = 0; l < levels; l++) {
    if ((indices.length / 3) * 4 > maxTris) break;
    ({ positions, indices } = subdivide(positions, indices));
    smoothLaplacian(positions, indices, 2, 0.52);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  g.setIndex(indices.length < 65535 ? indices : Array.from(indices));
  g.computeVertexNormals();
  return g;
}

// solda vértices por posição (indexa a malha para ter adjacência real)
function weld(geometry) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const count = index ? index.count : pos.count;
  const get = (k) => index ? index.getX(k) : k;

  const map = new Map();
  const positions = [];
  const remap = new Array(pos.count);
  const key = (x, y, z) =>
    `${Math.round(x * 5000)}_${Math.round(y * 5000)}_${Math.round(z * 5000)}`;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = key(x, y, z);
    let vi = map.get(k);
    if (vi === undefined) {
      vi = positions.length / 3;
      positions.push(x, y, z);
      map.set(k, vi);
    }
    remap[i] = vi;
  }
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

function smoothLaplacian(positions, indices, passes, lambda) {
  const n = positions.length / 3;
  const neighbors = new Array(n);
  for (let i = 0; i < indices.length; i += 3) {
    for (const [a, b] of [[indices[i], indices[i + 1]], [indices[i + 1], indices[i + 2]], [indices[i + 2], indices[i]]]) {
      (neighbors[a] || (neighbors[a] = new Set())).add(b);
      (neighbors[b] || (neighbors[b] = new Set())).add(a);
    }
  }
  const tmp = new Float64Array(positions.length);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      const nb = neighbors[i];
      if (!nb || nb.size < 3) {
        tmp[i * 3] = positions[i * 3]; tmp[i * 3 + 1] = positions[i * 3 + 1]; tmp[i * 3 + 2] = positions[i * 3 + 2];
        continue;
      }
      let x = 0, y = 0, z = 0;
      for (const j of nb) { x += positions[j * 3]; y += positions[j * 3 + 1]; z += positions[j * 3 + 2]; }
      const inv = 1 / nb.size;
      tmp[i * 3] = positions[i * 3] + lambda * (x * inv - positions[i * 3]);
      tmp[i * 3 + 1] = positions[i * 3 + 1] + lambda * (y * inv - positions[i * 3 + 1]);
      tmp[i * 3 + 2] = positions[i * 3 + 2] + lambda * (z * inv - positions[i * 3 + 2]);
    }
    for (let i = 0; i < positions.length; i++) positions[i] = tmp[i];
  }
}
