import * as THREE from 'three';
import { csgOperation, flattenGeometry, meshTriangleCount } from './csg.js';
import { buildExtrudeGeometry } from './sketch.js';
import { subdivideSmooth } from './modify.js';

// Operações pesadas sobre peças: recorte por esboço (subtração), mesclagem
// (união) e suavização de faces — todas com desfazer.
export class Ops {
  constructor(app) {
    this.app = app;
    this.maxTris = 60000;
  }

  _tooDense(...objs) {
    let total = 0;
    for (const o of objs) total += this.app.objects.triangleCount(o);
    if (total > this.maxTris) {
      this.app.ui.toast(`Peça densa demais para esta operação (${Math.round(total).toLocaleString('pt-BR')} triângulos; máx. ${this.maxTris.toLocaleString('pt-BR')})`);
      return true;
    }
    return false;
  }

  // geometria "achatada" no espaço local da raiz (grupos viram malha única)
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
    // grupo: substitui por uma malha única equivalente
    const mat = this.app.objects.firstMaterial(target);
    const mesh = new THREE.Mesh(newGeometry,
      mat ? mat.clone() : objs.makeMaterial(objs.nextColor()));
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
    this.app.history.push({
      label,
      undo: () => doSwap(mesh, target),
      redo: () => doSwap(target, mesh),
    });
    return mesh;
  }

  // ---------- recorte a partir do esboço ----------
  cutWithSpec(target, spec) {
    if (this._tooDense(target)) return;
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

  // ---------- mesclagem (união) ----------
  merge(a, b) {
    if (a === b) return;
    if (this._tooDense(a, b)) return;
    this.app.ui.showLoading('Mesclando…');
    setTimeout(() => {
      try {
        a.updateMatrixWorld(true);
        b.updateMatrixWorld(true);
        const matBtoA = a.matrixWorld.clone().invert().multiply(b.matrixWorld);
        const result = csgOperation(this._localGeometry(a), this._localGeometry(b), matBtoA, 'union');

        const merged = this._swapGeometry(a, result, 'mesclar');
        merged.name = `${a.name} + ${b.name}`.slice(0, 40);
        // remove B como parte do mesmo gesto (dois comandos na pilha é aceitável,
        // mas melhor: um único comando composto)
        this.app.objects.remove(b, { history: true });
        this.app.interact.select(merged);
        this.app.emit('objects-changed');
        this.app.ui.toast('Peças mescladas — desfazer restaura as duas');
      } catch (err) {
        console.error(err);
        this.app.ui.toast('Não consegui mesclar estas peças');
      } finally {
        this.app.ui.hideLoading();
      }
    }, 30);
  }

  // ---------- suavização de faces ----------
  smooth(target, levels) {
    const mesh = target.isMesh ? target : null;
    if (!mesh) { this.app.ui.toast('Selecione uma peça simples para suavizar'); return; }
    if (!mesh.userData.smoothBase) {
      const base = mesh.geometry.clone();
      if (meshTriangleCount(base) > 8000) {
        this.app.ui.toast('Peça densa demais para suavizar');
        return;
      }
      mesh.userData.smoothBase = base;
    }
    this.app.ui.showLoading('Suavizando…');
    setTimeout(() => {
      try {
        const oldGeo = mesh.geometry;
        const oldLevel = mesh.userData.smoothLevel || 0;
        const neu = levels === 0
          ? mesh.userData.smoothBase.clone()
          : subdivideSmooth(mesh.userData.smoothBase, levels);
        const apply = (geo, lvl) => {
          mesh.geometry = geo;
          mesh.userData.smoothLevel = lvl;
          mesh.userData.geomDirty = lvl > 0;
          this.app.interact.refreshSelection();
          this.app.emit('selection-changed');
        };
        apply(neu, levels);
        this.app.history.push({
          label: 'suavizar',
          undo: () => apply(oldGeo, oldLevel),
          redo: () => apply(neu, levels),
        });
      } catch (err) {
        console.error(err);
        this.app.ui.toast('Falha ao suavizar');
      } finally {
        this.app.ui.hideLoading();
      }
    }, 30);
  }
}
