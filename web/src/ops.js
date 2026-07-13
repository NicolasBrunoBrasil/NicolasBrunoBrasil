import * as THREE from 'three';
import { csgOperation, flattenGeometry, meshTriangleCount } from './csg.js';
import { buildExtrudeGeometry } from './sketch.js';
import { subdivideSmooth } from './modify.js';

// Operações pesadas: recorte por esboço (subtração), mesclagem (união exata
// ou combinação rápida para malhas enormes), suavização, espelho e matrizes.
export class Ops {
  constructor(app) {
    this.app = app;
    this.csgLimit = 60000;   // até aqui, união/subtração booleana exata
  }

  _tooDenseForCSG(...objs) {
    let total = 0;
    for (const o of objs) total += this.app.objects.triangleCount(o);
    return total > this.csgLimit;
  }

  _localGeometry(obj) {
    if (obj.isMesh && obj.geometry) return obj.geometry;
    return flattenGeometry(obj);
  }

  _swapGeometry(target, newGeometry, label) {
    const objs = this.app.objects;
    if (target.isMesh) {
      const oldGeo = target.geometry;
      const wasExtrude = target.userData.extrude;
      const apply = (geo, extrude) => {
        target.geometry = geo;
        target.userData.extrude = extrude;
        target.userData.geomDirty = true;
        this.app.interact.refreshSelection();
        this.app.emit('selection-changed');
      };
      apply(newGeometry, undefined);
      this.app.history.push({
        label,
        undo: () => apply(oldGeo, wasExtrude),
        redo: () => apply(newGeometry, undefined),
      });
      return target;
    }
    const mat = objs.firstMaterial(target);
    const mesh = new THREE.Mesh(newGeometry, mat ? mat.clone() : objs.makeMaterial(objs.nextColor()));
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = target.name;
    mesh.userData.kind = 'csg';
    mesh.userData.isUserObject = true;
    mesh.userData.geomDirty = true;
    mesh.position.copy(target.position);
    mesh.quaternion.copy(target.quaternion);
    mesh.scale.copy(target.scale);

    const scene = this.app.viewport.scene;
    const list = objs.list;
    const doSwap = (out, inn) => {
      scene.remove(out);
      const i = list.indexOf(out);
      if (i >= 0) list.splice(i, 1, inn); else list.push(inn);
      scene.add(inn);
      this.app.interact.select(inn);
      this.app.emit('objects-changed');
    };
    doSwap(target, mesh);
    this.app.history.push({ label, undo: () => doSwap(mesh, target), redo: () => doSwap(target, mesh) });
    return mesh;
  }

  // ---------- recorte a partir do esboço ----------
  cutWithSpec(target, spec) {
    if (this._tooDenseForCSG(target)) {
      this.app.ui.toast(`Peça densa demais para recortar (${Math.round(this.app.objects.triangleCount(target)).toLocaleString('pt-BR')} triângulos)`);
      return;
    }
    this.app.ui.showLoading('Recortando…');
    setTimeout(() => {
      try {
        const box = this.app.objects.bounds(target);
        const height = Math.max(box.max.y - box.min.y, 1);
        const geo = buildExtrudeGeometry({ outers: spec.outers, depth: height + 6 });
        const cutter = new THREE.Mesh(geo.geometry);
        cutter.position.set(geo.center.x, box.min.y - 3, geo.center.z);
        cutter.updateMatrixWorld(true);
        target.updateMatrixWorld(true);
        const matBtoA = target.matrixWorld.clone().invert().multiply(cutter.matrixWorld);
        const result = csgOperation(this._localGeometry(target), cutter.geometry, matBtoA, 'subtract');
        geo.geometry.dispose();
        this._swapGeometry(target, result, 'recorte');
        this.app.ui.toast('Recorte aplicado');
      } catch (err) {
        console.error(err);
        this.app.ui.toast('Não consegui recortar esta peça');
      } finally {
        this.app.ui.hideLoading();
      }
    }, 30);
  }

  // furo cilíndrico vertical atravessando a peça no ponto (x,z)
  drillHole(target, x, z, diameterMM) {
    const spec = circleSpec(x, z, diameterMM / 2);
    this.cutWithSpec(target, spec);
  }

  // ---------- mesclagem ----------
  // Escolhe automaticamente: união booleana exata para peças leves; combinação
  // rápida (junta as malhas) para qualquer tamanho, inclusive milhões de faces.
  merge(a, b, opts = {}) {
    if (a === b) return;
    const total = this.app.objects.triangleCount(a) + this.app.objects.triangleCount(b);
    const exact = opts.mode ? opts.mode === 'exato' : total <= this.csgLimit;
    this.app.ui.showLoading(exact ? 'Mesclando (união exata)…' : 'Juntando peças…');
    setTimeout(() => {
      try {
        a.updateMatrixWorld(true);
        b.updateMatrixWorld(true);
        const matBtoA = a.matrixWorld.clone().invert().multiply(b.matrixWorld);
        let result;
        if (exact) {
          result = csgOperation(this._localGeometry(a), this._localGeometry(b), matBtoA, 'union');
        } else {
          result = this._combine(this._localGeometry(a), this._localGeometry(b), matBtoA);
        }
        const merged = this._swapGeometry(a, result, 'mesclar');
        merged.name = `${a.name} + ${b.name}`.slice(0, 40);
        this.app.objects.remove(b, { history: true });
        this.app.interact.select(merged);
        this.app.emit('objects-changed');
        const trisNow = Math.round(this.app.objects.triangleCount(merged)).toLocaleString('pt-BR');
        this.app.ui.toast(exact
          ? 'Peças mescladas (união) — desfazer restaura as duas'
          : `Peças unidas rapidamente (${trisNow} triângulos)`);
      } catch (err) {
        console.error(err);
        this.app.ui.toast('Não consegui mesclar estas peças');
      } finally {
        this.app.ui.hideLoading();
      }
    }, 30);
  }

  // junta duas geometrias numa só (espaço local de A) sem custo pesado — O(n)
  _combine(geomA, geomB, matBtoA) {
    const a = ensurePosNorm(geomA, null);
    const b = ensurePosNorm(geomB, matBtoA);
    const total = a.pos.length + b.pos.length;
    const pos = new Float32Array(total);
    pos.set(a.pos, 0); pos.set(b.pos, a.pos.length);
    const nrm = new Float32Array(total);
    nrm.set(a.nrm, 0); nrm.set(b.nrm, a.nrm.length);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  // ---------- espelhar ----------
  mirror(obj, axis) {
    const objs = this.app.objects;
    const clone = obj.clone(true);
    clone.traverse(o => {
      if (o.isMesh && o.geometry) {
        o.geometry = mirrorGeometry(o.geometry, axis);
        o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : (o.material ? o.material.clone() : o.material);
      }
    });
    clone.name = obj.name + ' (espelho)';
    clone.userData = { ...obj.userData, isUserObject: true };
    delete clone.userData.extrude;   // geometria já foi espelhada em malha crua
    delete clone.userData.relief;
    delete clone.userData.smoothBase;
    clone.userData.kind = 'csg';
    clone.userData.geomDirty = true; // salva a malha espelhada tal como está
    // reflete a posição em relação ao centro da peça original
    const box = objs.bounds(obj);
    const c = box.getCenter(new THREE.Vector3());
    if (axis === 'x') clone.position.x = 2 * c.x - obj.position.x;
    else if (axis === 'y') clone.position.y = 2 * c.y - obj.position.y;
    else clone.position.z = 2 * c.z - obj.position.z;
    objs.add(clone);
    this.app.ui.toast('Espelho criado');
    return clone;
  }

  // ---------- matrizes (padrões) ----------
  arrayLinear(obj, count, spacingMM, axis = 'x') {
    count = Math.max(2, Math.min(200, Math.round(count)));
    const objs = this.app.objects;
    const created = [];
    for (let i = 1; i < count; i++) {
      const clone = cloneObject(obj);
      if (axis === 'x') clone.position.x += spacingMM * i;
      else if (axis === 'y') clone.position.y += spacingMM * i;
      else clone.position.z += spacingMM * i;
      clone.name = `${obj.name} ${i + 1}`;
      created.push(clone);
    }
    this._addMany(created, 'matriz linear');
    return created;
  }

  arrayCircular(obj, count, radiusMM) {
    count = Math.max(2, Math.min(120, Math.round(count)));
    const objs = this.app.objects;
    const c = objs.bounds(obj).getCenter(new THREE.Vector3());
    const cx = c.x - radiusMM, cz = c.z; // centro do círculo à esquerda da peça
    const created = [];
    for (let i = 1; i < count; i++) {
      const ang = (i / count) * Math.PI * 2;
      const clone = cloneObject(obj);
      const dx = obj.position.x - cx, dz = obj.position.z - cz;
      clone.position.x = cx + dx * Math.cos(ang) - dz * Math.sin(ang);
      clone.position.z = cz + dx * Math.sin(ang) + dz * Math.cos(ang);
      clone.rotateY(ang);
      clone.name = `${obj.name} ${i + 1}`;
      created.push(clone);
    }
    this._addMany(created, 'matriz circular');
    return created;
  }

  _addMany(created, label) {
    const objs = this.app.objects;
    const scene = this.app.viewport.scene;
    for (const o of created) { objs.prepare(o); scene.add(o); objs.list.push(o); }
    this.app.emit('objects-changed');
    this.app.history.push({
      label,
      undo: () => { for (const o of created) objs._detach(o); },
      redo: () => { for (const o of created) objs._attach(o); },
    });
    this.app.ui.toast(`${created.length + 1} cópias no padrão`);
  }

  // ---------- suavização de faces ----------
  smooth(target, levels) {
    const mesh = target.isMesh ? target : null;
    if (!mesh) { this.app.ui.toast('Selecione uma peça simples para suavizar'); return; }
    if (!mesh.userData.smoothBase) {
      const base = mesh.geometry.clone();
      if (meshTriangleCount(base) > 8000) { this.app.ui.toast('Peça densa demais para suavizar'); return; }
      mesh.userData.smoothBase = base;
    }
    this.app.ui.showLoading('Suavizando…');
    setTimeout(() => {
      try {
        const oldGeo = mesh.geometry;
        const oldLevel = mesh.userData.smoothLevel || 0;
        const neu = levels === 0 ? mesh.userData.smoothBase.clone() : subdivideSmooth(mesh.userData.smoothBase, levels);
        const apply = (geo, lvl) => {
          mesh.geometry = geo;
          mesh.userData.smoothLevel = lvl;
          mesh.userData.geomDirty = lvl > 0;
          this.app.interact.refreshSelection();
          this.app.emit('selection-changed');
        };
        apply(neu, levels);
        this.app.history.push({ label: 'suavizar', undo: () => apply(oldGeo, oldLevel), redo: () => apply(neu, levels) });
      } catch (err) {
        console.error(err);
        this.app.ui.toast('Falha ao suavizar');
      } finally {
        this.app.ui.hideLoading();
      }
    }, 30);
  }
}

// ---------- utilidades ----------
function ensurePosNorm(geometry, matrix) {
  const src = geometry.index ? geometry.toNonIndexed() : geometry;
  const posAttr = src.attributes.position;
  let pos = new Float32Array(posAttr.array);
  let nrm;
  if (src.attributes.normal) nrm = new Float32Array(src.attributes.normal.array);
  else { src.computeVertexNormals(); nrm = new Float32Array(src.attributes.normal.array); }
  if (matrix) {
    const v = new THREE.Vector3();
    const nm = new THREE.Matrix3().getNormalMatrix(matrix);
    for (let i = 0; i < pos.length; i += 3) {
      v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(matrix);
      pos[i] = v.x; pos[i + 1] = v.y; pos[i + 2] = v.z;
      v.set(nrm[i], nrm[i + 1], nrm[i + 2]).applyMatrix3(nm).normalize();
      nrm[i] = v.x; nrm[i + 1] = v.y; nrm[i + 2] = v.z;
    }
  }
  return { pos, nrm };
}

function mirrorGeometry(geometry, axis) {
  const g = (geometry.index ? geometry.toNonIndexed() : geometry).clone();
  const pos = g.attributes.position;
  const comp = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  for (let i = 0; i < pos.count; i++) pos.setComponent(i, comp, -pos.getComponent(i, comp));
  // inverte a ordem dos vértices de cada triângulo para as faces não ficarem do avesso
  const arr = pos.array;
  for (let i = 0; i < pos.count; i += 3) {
    for (let k = 0; k < 3; k++) {
      const t = arr[(i + 1) * 3 + k]; arr[(i + 1) * 3 + k] = arr[(i + 2) * 3 + k]; arr[(i + 2) * 3 + k] = t;
    }
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

function cloneObject(obj) {
  const clone = obj.clone(true);
  clone.traverse(o => {
    if (o.isMesh && o.material) {
      o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone();
    }
  });
  clone.userData = { ...obj.userData, isUserObject: true };
  return clone;
}

function circleSpec(cx, cz, r) {
  const n = 48;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(t) * r, -(cz + Math.sin(t) * r)]); // chão -> forma
  }
  return { outers: [{ pts, holes: [] }], depth: 10 };
}
