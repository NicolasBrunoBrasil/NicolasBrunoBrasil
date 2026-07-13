import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// Interação com caneta/toque:
//  - dedo: 1 = orbitar, 2 = zoom/pan; toque curto = selecionar
//  - caneta (ou mouse): arrasta objeto diretamente no plano, toque curto = selecionar,
//    arrastar no vazio = orbitar; botão da caneta = pan
//  - gizmo (mover/girar/escalar) sempre tem prioridade
export class Interact {
  constructor(app) {
    this.app = app;
    const vp = app.viewport;

    this.selected = null;
    this.mode = 'translate';
    this.snapping = true;

    this.tc = new TransformControls(vp.camera, vp.renderer.domElement);
    this.tc.setSize(1.15);
    vp.scene.add(this.tc);
    this._applySnap();

    this.tc.addEventListener('dragging-changed', (e) => {
      vp.controls.enabled = !e.value;
    });
    this.tc.addEventListener('mouseDown', () => {
      if (this.tc.object) this._dragStart = this._snapshot(this.tc.object);
    });
    this.tc.addEventListener('mouseUp', () => {
      if (this.tc.object && this._dragStart) {
        this._pushTransform(this.tc.object, this._dragStart);
        this._dragStart = null;
      }
    });
    this.tc.addEventListener('objectChange', () => this._updateHelpers());

    // contornos de seleção e de hover
    this.selBox = new THREE.BoxHelper(new THREE.Object3D(), 0x4fc3f7);
    this.selBox.visible = false;
    this.selBox.material.transparent = true;
    this.selBox.material.opacity = 0.9;
    vp.scene.add(this.selBox);

    this.hoverBox = new THREE.BoxHelper(new THREE.Object3D(), 0x4fc3f7);
    this.hoverBox.visible = false;
    this.hoverBox.material.transparent = true;
    this.hoverBox.material.opacity = 0.28;
    vp.scene.add(this.hoverBox);
    this._hovered = null;
    this._lastHoverCheck = 0;

    this._planeDrag = null;
    this._taps = new Map();

    const el = vp.container;
    el.addEventListener('pointerdown', (e) => this._onDown(e), { capture: true });
    el.addEventListener('pointermove', (e) => this._onMove(e), { capture: true });
    el.addEventListener('pointerup', (e) => this._onUp(e), { capture: true });
    el.addEventListener('pointercancel', (e) => this._onCancel(e), { capture: true });
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    vp.onFrame(() => {
      if (this.selBox.visible && this.selected) this.selBox.update();
    });
  }

  // ---------- seleção ----------
  select(obj) {
    if (obj === this.selected) { this.app.emit('selection-changed'); return; }
    this.selected = obj;
    if (obj && this.mode !== 'none') {
      this.tc.attach(obj);
      this.tc.visible = true;
      this.tc.enabled = true;
    } else {
      this.tc.detach();
      this.tc.visible = false;
      this.tc.enabled = false;
    }
    this._updateHelpers();
    this._setHover(null);
    this.app.emit('selection-changed');
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === 'none') {
      this.tc.detach(); this.tc.visible = false; this.tc.enabled = false;
    } else {
      this.tc.setMode(mode);
      if (this.selected) { this.tc.attach(this.selected); this.tc.visible = true; this.tc.enabled = true; }
    }
    this.app.emit('mode-changed');
  }

  setSnapping(on) {
    this.snapping = on;
    this._applySnap();
  }

  _applySnap() {
    this.tc.setTranslationSnap(this.snapping ? 1 : null);
    this.tc.setRotationSnap(this.snapping ? THREE.MathUtils.degToRad(15) : null);
    this.tc.setScaleSnap(this.snapping ? 0.1 : null);
  }

  _updateHelpers() {
    if (this.selected) {
      this.selBox.setFromObject(this.selected);
      this.selBox.visible = true;
    } else {
      this.selBox.visible = false;
    }
  }

  _snapshot(obj) {
    return {
      position: obj.position.clone(),
      quaternion: obj.quaternion.clone(),
      scale: obj.scale.clone(),
    };
  }

  _restore(obj, snap) {
    obj.position.copy(snap.position);
    obj.quaternion.copy(snap.quaternion);
    obj.scale.copy(snap.scale);
    this._updateHelpers();
    this.app.emit('selection-changed');
  }

  _pushTransform(obj, before) {
    const after = this._snapshot(obj);
    if (before.position.equals(after.position) &&
        before.quaternion.equals(after.quaternion) &&
        before.scale.equals(after.scale)) return;
    this.app.history.push({
      label: 'transformar',
      undo: () => this._restore(obj, before),
      redo: () => this._restore(obj, after),
    });
    this.app.emit('selection-changed');
  }

  pushTransformCmd(obj, before) { this._pushTransform(obj, before); }
  snapshotOf(obj) { return this._snapshot(obj); }

  // ---------- ponteiros ----------
  _isPrecise(e) { return e.pointerType === 'pen' || e.pointerType === 'mouse'; }

  _hitGizmo(e) {
    if (!this.tc.object || !this.tc.visible) return false;
    try {
      return this.app.viewport.raycastObject(e, this.tc).length > 0;
    } catch { return false; }
  }

  _hitUserObject(e) {
    const vp = this.app.viewport;
    const visible = this.app.objects.list.filter(o => o.visible);
    if (!visible.length) return null;
    const hits = vp.raycastFrom(e, visible, true);
    for (const h of hits) {
      const root = this.app.objects.findRoot(h.object);
      if (root && root.visible) return { root, point: h.point };
    }
    return null;
  }

  _onDown(e) {
    if (this.app.ui && this.app.ui.modalOpen) return;
    this._taps.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), moved: false });

    if (this.app.sketch.active) {
      if (this._isPrecise(e) && e.button === 0) {
        e.stopPropagation();
        this.app.viewport.container.setPointerCapture(e.pointerId);
        this.app.sketch.pointerDown(e);
      }
      return; // dedos continuam orbitando/pan
    }

    if (!this._isPrecise(e) || e.button !== 0) return;
    if (this._hitGizmo(e)) return; // TransformControls assume o arrasto

    const hit = this._hitUserObject(e);
    if (!hit) return; // arrastar no vazio = orbitar

    e.stopPropagation();
    if (this.selected !== hit.root) this.select(hit.root);

    // arrasto direto no plano horizontal que passa pelo ponto tocado
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y);
    this._planeDrag = {
      pointerId: e.pointerId,
      obj: hit.root,
      plane,
      offset: hit.root.position.clone().sub(hit.point),
      before: this._snapshot(hit.root),
      moved: false,
    };
    this.app.viewport.container.setPointerCapture(e.pointerId);
  }

  _onMove(e) {
    const tap = this._taps.get(e.pointerId);
    if (tap && (Math.abs(e.clientX - tap.x) > 8 || Math.abs(e.clientY - tap.y) > 8)) tap.moved = true;

    if (this.app.sketch.active) {
      if (this.app.sketch.stroking) { e.stopPropagation(); this.app.sketch.pointerMove(e); }
      return;
    }

    if (this._planeDrag && e.pointerId === this._planeDrag.pointerId) {
      e.stopPropagation();
      const d = this._planeDrag;
      const p = this.app.viewport.planeHit(e, d.plane);
      if (p) {
        d.moved = true;
        const np = p.clone().add(d.offset);
        if (this.snapping) { np.x = Math.round(np.x); np.z = Math.round(np.z); }
        d.obj.position.x = np.x;
        d.obj.position.z = np.z;
        this._updateHelpers();
      }
      return;
    }

    // realce ao passar a caneta (hover da S Pen) — limitado por desempenho
    if (this._isPrecise(e) && e.buttons === 0 && !this.tc.dragging) {
      const now = performance.now();
      if (now - this._lastHoverCheck > 70) {
        this._lastHoverCheck = now;
        if (this.app.objects.totalTriangles() < 400000) {
          const hit = this._hitUserObject(e);
          this._setHover(hit && hit.root !== this.selected ? hit.root : null);
        }
      }
    }
  }

  _onUp(e) {
    const tap = this._taps.get(e.pointerId);
    this._taps.delete(e.pointerId);

    if (this.app.sketch.active) {
      if (this.app.sketch.stroking) { e.stopPropagation(); this.app.sketch.pointerUp(e); }
      else if (tap && !tap.moved && this._isPrecise(e)) this.app.sketch.tap(e);
      return;
    }

    if (this._planeDrag && e.pointerId === this._planeDrag.pointerId) {
      e.stopPropagation();
      const d = this._planeDrag;
      this._planeDrag = null;
      if (d.moved) this._pushTransform(d.obj, d.before);
      return;
    }

    // toque curto: selecionar / limpar seleção
    if (tap && !tap.moved && performance.now() - tap.t < 500) {
      if (this._hitGizmo(e)) return;
      const hit = this._hitUserObject(e);
      this.select(hit ? hit.root : null);
    }
  }

  _onCancel(e) {
    this._taps.delete(e.pointerId);
    if (this._planeDrag && e.pointerId === this._planeDrag.pointerId) {
      this._restore(this._planeDrag.obj, this._planeDrag.before);
      this._planeDrag = null;
    }
    if (this.app.sketch.active && this.app.sketch.stroking) this.app.sketch.pointerCancel(e);
  }

  _setHover(obj) {
    if (obj === this._hovered) return;
    this._hovered = obj;
    if (obj) {
      this.hoverBox.setFromObject(obj);
      this.hoverBox.visible = true;
    } else {
      this.hoverBox.visible = false;
    }
  }

  deleteSelected() {
    if (!this.selected) return;
    this.app.objects.remove(this.selected);
  }

  duplicateSelected() {
    if (!this.selected) return;
    this.app.objects.duplicate(this.selected);
  }
}
