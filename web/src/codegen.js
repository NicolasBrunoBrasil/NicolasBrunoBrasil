import * as THREE from 'three';
import { buildExtrudeGeometry } from './sketch.js';
import { csgOperation } from './csg.js';

// Codificação: executa código do próprio usuário para gerar objetos 3D.
// As peças criadas por K.* são "encadeáveis": .translate(x,y,z),
// .moveTo(x,y,z), .rotateDeg(x,y,z), .scaleBy(s), .color('#hex').
// O código deve chamar add(peça) (ou retornar uma peça).

export const CODE_EXAMPLES = {
  'Jipe modular': `// Jipe modular montado por peças transformadas.
// Cada peça é posicionada com .translate / .rotateDeg / .color.
const azul = '#3f7fd6', preto = '#20262e', vidro = '#8fd8ff', prata = '#c7ced6';

// chassi e carroceria
add(K.box(80, 10, 44).translate(0, 14, 0).color(azul));
add(K.box(80, 4, 44).translate(0, 8, 0).color(preto));           // para-choque baixo
add(K.box(46, 16, 40).translate(-4, 26, 0).color(azul));          // cabine
add(K.box(30, 14, 36).translate(30, 22, 0).color(azul));          // capô

// vidros
add(K.box(2, 12, 34).translate(13, 27, 0).color(vidro));          // para-brisa
add(K.box(20, 10, 2).translate(-4, 27, 19).color(vidro));         // janela lateral
add(K.box(20, 10, 2).translate(-4, 27, -19).color(vidro));

// para-lamas / estribos
add(K.box(84, 3, 6).translate(0, 12, 24).color(preto));
add(K.box(84, 3, 6).translate(0, 12, -24).color(preto));

// faróis
add(K.cylinder(3, 3).rotateDeg(0, 0, 90).translate(45, 20, 14).color('#fff59d'));
add(K.cylinder(3, 3).rotateDeg(0, 0, 90).translate(45, 20, -14).color('#fff59d'));

// 4 rodas (pneu + calota)
function roda(x, z) {
  add(K.cylinder(11, 8).rotateDeg(90, 0, 0).translate(x, 11, z).color(preto));
  add(K.cylinder(5, 9).rotateDeg(90, 0, 0).translate(x, 11, z).color(prata));
}
roda(26, 26); roda(26, -26); roda(-30, 26); roda(-30, -26);

// estepe atrás
add(K.cylinder(10, 7).rotateDeg(90, 0, 0).translate(-44, 22, 0).color(preto));`,

  'Engrenagem': `// Engrenagem paramétrica (perfil + furo central)
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
add(K.subtract(eng, furo).color('#b0bec5'));`,

  'Vaso ondulado': `// Vaso por revolução (perfil onduladо)
const alturas = 60, voltas = 220;
const pts = [];
for (let i = 0; i <= voltas; i++) {
  const t = i / voltas;
  const r = 18 + Math.sin(t * Math.PI * 6) * 4 + t * 6;
  pts.push(new K.THREE.Vector2(r, t * alturas));
}
add(new K.THREE.LatheGeometry(pts, 64), '#4db6ac');`,

  'Torre de cubos': `// Pilha de cubos girando
for (let i = 0; i < 8; i++) {
  add(K.box(20 - i, 6, 20 - i)
    .translate(0, i * 6 + 3, 0)
    .rotateDeg(0, i * 20, 0)
    .color(K.hue(i / 8)));
}`,

  'Diagnóstico da API': `// Cole isto e execute: mostra os métodos disponíveis no console.
const m = K.box(10, 10, 10);
console.log('métodos da peça:', Object.keys(m).filter(k => typeof m[k] === 'function'));
console.log('helpers K:', Object.keys(K));
add(m.translate(0, 5, 0).color('#4fc3f7'));`,
};

export class CodeGen {
  constructor(app) { this.app = app; }

  _api() {
    const mk = (geo) => wrap(new THREE.Mesh(geo));
    return {
      THREE,
      box: (w = 20, h = 20, d = 20) => mk(new THREE.BoxGeometry(w, h, d)),
      cube: (s = 20) => mk(new THREE.BoxGeometry(s, s, s)),
      sphere: (r = 12, seg = 40) => mk(new THREE.SphereGeometry(r, seg, Math.max(8, seg / 2))),
      cylinder: (r = 10, h = 20, seg = 48) => mk(new THREE.CylinderGeometry(r, r, h, seg)),
      cone: (r = 10, h = 20, seg = 48) => mk(new THREE.ConeGeometry(r, h, seg)),
      torus: (R = 14, r = 4, seg = 48) => mk(new THREE.TorusGeometry(R, r, 20, seg)),
      extrude: (points, depth = 10) => {
        const spec = { outers: [{ pts: points.map(p => [p[0], -p[1]]), holes: [] }], depth };
        const g = buildExtrudeGeometry(spec);
        return wrap(new THREE.Mesh(g.geometry)).translate(g.center.x, g.center.y, g.center.z);
      },
      subtract: (a, b) => wrap(booleanMesh(a, b, 'subtract')),
      union: (a, b) => wrap(booleanMesh(a, b, 'union')),
      // transformações também na forma de função (K.translate(peça, x,y,z))
      translate: (o, x, y, z) => o.translate(x, y, z),
      rotate: (o, x, y, z) => o.rotateDeg(x, y, z),
      group: (...meshes) => { const g = new THREE.Group(); for (const m of meshes) g.add(m); return g; },
      hue: (t) => new THREE.Color().setHSL((t % 1 + 1) % 1, 0.6, 0.6).getStyle(),
      deg: (d) => THREE.MathUtils.degToRad(d),
    };
  }

  run(code) {
    const created = [];
    const K = this._api();
    const bake = (mesh, color) => {
      mesh.updateMatrix();
      mesh.geometry.applyMatrix4(mesh.matrix);
      mesh.position.set(0, 0, 0); mesh.rotation.set(0, 0, 0); mesh.scale.set(1, 1, 1);
      if (!mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals();
      if (color != null) mesh.userData._color = color;
      created.push(mesh);
    };
    const add = (obj, color) => {
      if (obj && obj.isBufferGeometry) obj = new THREE.Mesh(obj);
      if (obj && obj.isGroup) {
        obj.updateMatrixWorld(true);
        const meshes = [];
        obj.traverse(o => { if (o.isMesh) meshes.push(o); });
        for (const m of meshes) {
          const world = m.matrixWorld.clone();
          m.geometry = m.geometry.clone().applyMatrix4(world);
          m.position.set(0, 0, 0); m.rotation.set(0, 0, 0); m.scale.set(1, 1, 1);
          if (!m.geometry.attributes.normal) m.geometry.computeVertexNormals();
          if (color != null && m.userData._color == null) m.userData._color = color;
          created.push(m);
        }
        return obj;
      }
      if (!obj || !obj.isMesh) throw new Error('add() precisa de uma peça (malha) ou geometria');
      bake(obj, color);
      return obj;
    };

    const fn = new Function('K', 'add', 'THREE', 'Math', 'console', `"use strict";\n${code}\n`);
    const ret = fn(K, add, THREE, Math, window.console);
    if (created.length === 0 && ret) add(ret);
    if (!created.length) throw new Error('nenhum objeto criado — use add(...) ou retorne uma peça');

    const objs = this.app.objects;
    for (const m of created) {
      m.material = objs.makeMaterial(m.userData._color || objs.nextColor());
      m.castShadow = m.receiveShadow = true;
      delete m.userData._color;
    }
    const group = created.length === 1 ? created[0] : new THREE.Group();
    if (created.length > 1) for (const m of created) group.add(m);
    group.name = objs.makeName('csg');
    group.userData.kind = 'codigo';
    group.userData.geomDirty = true;
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

// adiciona métodos de transformação encadeáveis a uma malha
function wrap(mesh) {
  mesh.translate = function (x = 0, y = 0, z = 0) { this.position.x += x; this.position.y += y; this.position.z += z; return this; };
  mesh.moveTo = function (x = 0, y = 0, z = 0) { this.position.set(x, y, z); return this; };
  mesh.rotate = function (x = 0, y = 0, z = 0) { this.rotation.x += x; this.rotation.y += y; this.rotation.z += z; return this; };
  mesh.rotateDeg = function (x = 0, y = 0, z = 0) { const d = Math.PI / 180; this.rotation.x += x * d; this.rotation.y += y * d; this.rotation.z += z * d; return this; };
  mesh.scaleBy = function (sx = 1, sy, sz) { if (sy === undefined) { sy = sx; sz = sx; } this.scale.set(this.scale.x * sx, this.scale.y * sy, this.scale.z * sz); return this; };
  mesh.color = function (c) { this.userData._color = c; return this; };
  return mesh;
}

function booleanMesh(a, b, op) {
  a.updateMatrix(); b.updateMatrix();
  const ga = a.geometry.clone().applyMatrix4(a.matrix);
  const gb = b.geometry.clone();
  const matBtoA = new THREE.Matrix4().copy(b.matrix);
  const res = csgOperation(ga, gb, matBtoA, op);
  return new THREE.Mesh(res);
}
