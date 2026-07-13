import * as THREE from 'three';
import { buildExtrudeGeometry } from './sketch.js';
import { csgOperation } from './csg.js';

// Codificação: executa código do próprio usuário para gerar objetos 3D.
// O código roda no dispositivo do usuário, com uma API de ajudantes (K.*).
// Deve chamar add(mesh|geometria) ou retornar uma malha/geometria.

export const CODE_EXAMPLES = {
  'Engrenagem': `// Engrenagem paramétrica
const dentes = 16, raio = 22, altura = 8;
const pts = [];
const passos = dentes * 4;
for (let i = 0; i < passos; i++) {
  const a = (i / passos) * Math.PI * 2;
  const dente = (Math.floor(i / 2) % 2 === 0) ? raio : raio - 4;
  pts.push([Math.cos(a) * dente, Math.sin(a) * dente]);
}
const eng = K.extrude(pts, altura);
const furo = K.cylinder(5, altura + 2);
add(K.subtract(eng, furo), '#b0bec5');`,

  'Vaso ondulado': `// Vaso com paredes onduladas (revolução aproximada)
const alturas = 60, voltas = 220;
const pts = [];
for (let i = 0; i <= voltas; i++) {
  const t = i / voltas;
  const y = t * alturas;
  const r = 18 + Math.sin(t * Math.PI * 6) * 4 + t * 6;
  const g = new K.THREE.Vector2(r, y);
  pts.push(g);
}
const geo = new K.THREE.LatheGeometry(pts, 64);
add(geo, '#4db6ac');`,

  'Torre de cubos': `// Pilha de cubos girando
for (let i = 0; i < 8; i++) {
  const c = K.box(20 - i, 6, 20 - i);
  c.position.y = i * 6 + 3;
  c.rotation.y = i * 0.35;
  add(c, K.hue(i / 8));
}`,

  'Parafuso (hélice)': `// Rosca aproximada por segmentos
const R = 8, passo = 3, voltas = 6, seg = 240;
const corpo = K.cylinder(R * 0.7, passo * voltas);
corpo.position.y = passo * voltas / 2;
add(corpo, '#90a4ae');
for (let i = 0; i < seg; i++) {
  const t = i / seg;
  const a = t * voltas * Math.PI * 2;
  const b = K.box(3, 1.4, 1.4);
  b.position.set(Math.cos(a) * R, t * passo * voltas, Math.sin(a) * R);
  b.rotation.y = -a;
  add(b, '#b0bec5');
}`,
};

export class CodeGen {
  constructor(app) { this.app = app; }

  // API disponível dentro do código do usuário
  _api() {
    const mk = (geo) => new THREE.Mesh(geo);
    return {
      THREE,
      box: (w = 20, h = 20, d = 20) => mk(new THREE.BoxGeometry(w, h, d)),
      cube: (s = 20) => mk(new THREE.BoxGeometry(s, s, s)),
      sphere: (r = 12, seg = 40) => mk(new THREE.SphereGeometry(r, seg, Math.max(8, seg / 2))),
      cylinder: (r = 10, h = 20, seg = 48) => mk(new THREE.CylinderGeometry(r, r, h, seg)),
      cone: (r = 10, h = 20, seg = 48) => mk(new THREE.ConeGeometry(r, h, seg)),
      torus: (R = 14, r = 4, seg = 48) => mk(new THREE.TorusGeometry(R, r, 20, seg)),
      extrude: (points, depth = 10) => {
        const pts = points.map(p => [p[0], -p[1]]); // (x,y) desenho -> chão
        const spec = { outers: [{ pts, holes: [] }], depth };
        const g = buildExtrudeGeometry(spec);
        const m = mk(g.geometry);
        m.position.copy(g.center);
        return m;
      },
      // operações booleanas entre malhas (para peças leves)
      subtract: (a, b) => booleanMesh(a, b, 'subtract'),
      union: (a, b) => booleanMesh(a, b, 'union'),
      hue: (t) => new THREE.Color().setHSL((t % 1 + 1) % 1, 0.6, 0.6).getStyle(),
      deg: (d) => THREE.MathUtils.degToRad(d),
    };
  }

  run(code) {
    const created = [];
    const K = this._api();
    const add = (obj, color) => {
      let mesh = obj;
      if (obj && obj.isBufferGeometry) mesh = new THREE.Mesh(obj);
      if (!mesh || !mesh.isMesh) throw new Error('add() precisa de uma malha ou geometria');
      mesh.updateMatrix();
      mesh.geometry.applyMatrix4(mesh.matrix);
      mesh.position.set(0, 0, 0); mesh.rotation.set(0, 0, 0); mesh.scale.set(1, 1, 1);
      if (!mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals();
      mesh.userData._color = color;
      created.push(mesh);
      return mesh;
    };
    // executa o código do usuário
    const fn = new Function('K', 'add', 'THREE', 'Math', `"use strict";\n${code}\n`);
    const ret = fn(K, add, THREE, Math);
    if (created.length === 0 && ret) add(ret);
    if (!created.length) throw new Error('nenhum objeto criado — use add(...) ou retorne uma malha');

    // combina tudo num objeto e assenta no chão
    const objs = this.app.objects;
    const group = created.length === 1 ? created[0] : new THREE.Group();
    if (created.length > 1) for (const m of created) group.add(m);
    // aplica cores
    for (const m of created) {
      const col = m.userData._color || objs.nextColor();
      m.material = objs.makeMaterial(col);
      m.castShadow = m.receiveShadow = true;
      delete m.userData._color;
    }
    group.name = objs.makeName('csg');
    group.userData.kind = 'codigo';
    if (created.length > 1) group.userData.geomDirty = true;
    else group.userData.geomDirty = true;
    objs.prepare(group);
    objs.dropToGround(group);
    const box = objs.bounds(group);
    const spot = objs.findFreeSpot(Math.max(box.getSize(new THREE.Vector3()).x, 20) / 2);
    group.position.x += spot.x; group.position.z += spot.z;
    objs.add(group);
    this.app.viewport.frameBox(objs.bounds(group));
    return group;
  }
}

function booleanMesh(a, b, op) {
  a.updateMatrix(); b.updateMatrix();
  const ga = a.geometry.clone().applyMatrix4(a.matrix);
  const gb = b.geometry.clone();
  const matBtoA = new THREE.Matrix4().copy(b.matrix);
  const res = csgOperation(ga, gb, matBtoA, op);
  return new THREE.Mesh(res);
}
