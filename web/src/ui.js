import * as THREE from 'three';
import { FINISHES } from './objects.js';
import { rebuildExtrudeDepth } from './sketch.js';
import { imageToReliefData, imageToContourGeometry, buildReliefGeometry, b64ToGray } from './shapegen.js';
import * as IO from './io.js';

const $ = (id) => document.getElementById(id);
const EYE_ON = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/></svg>';
const RECENT_KEY = 'korx3d.recentColors';

export class UI {
  constructor(app) {
    this.app = app;
    this.modalOpen = false;
    this._toastTimer = null;
    this._lastErrToast = 0;

    this.picker = new ColorPicker(this);

    this._bindTopbar();
    this._bindToolbar();
    this._bindSketchbar();
    this._bindPaintbar();
    this._bindViewbar();
    this._bindPanel();
    this._bindKeyboard();

    app.on('selection-changed', () => this.refresh());
    app.on('objects-changed', () => { this.refreshList(); this.refresh(); });
    app.on('history-changed', () => this.refreshHistory());
    app.on('mode-changed', () => this.refreshModes());
    app.on('sketch-changed', () => this.refreshSketch());
    app.on('paint-changed', () => this.refreshPaint());

    window.addEventListener('error', (e) => {
      const now = Date.now();
      if (now - this._lastErrToast > 10000) {
        this._lastErrToast = now;
        this.toast('Ops, algo falhou: ' + (e.message || 'erro'));
      }
    });

    if (window.matchMedia('(max-width: 900px)').matches) {
      document.body.classList.add('panel-hidden');
    }
    this.refresh();
    this.refreshList();
    this.refreshHistory();
    this.refreshRecents();
  }

  // ------------------------------------------------ barra superior
  _bindTopbar() {
    $('btnUndo').onclick = () => this.app.history.undo();
    $('btnRedo').onclick = () => this.app.history.redo();
    $('btnSnap').onclick = () => {
      const on = !this.app.interact.snapping;
      this.app.interact.setSnapping(on);
      $('btnSnap').classList.toggle('on', on);
      this.toast(on ? 'Encaixe ligado (1 mm / 15°)' : 'Encaixe desligado');
    };
    $('btnImport').onclick = () => $('fileInput').click();
    $('fileInput').onchange = (e) => {
      if (e.target.files.length) IO.importFiles(e.target.files);
      e.target.value = '';
    };
    $('btnOpen').onclick = () => $('projInput').click();
    $('projInput').onchange = async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      this.showLoading('Abrindo projeto…');
      try { await IO.openProjectFile(f); }
      catch (err) { console.error(err); this.toast('Não consegui abrir este projeto'); }
      finally { this.hideLoading(); }
    };
    $('btnSave').onclick = () => this._saveDialog();
    $('btnExport').onclick = () => this._exportDialog();
    $('btnShare').onclick = () => {
      if (window.EstudioBridge && window.EstudioBridge.shareLast) {
        try { window.EstudioBridge.shareLast(); } catch { this.toast('Exporte um arquivo primeiro'); }
      } else {
        this.toast('Disponível no aplicativo do tablet após exportar');
      }
    };
    $('btnHelp').onclick = () => this._helpDialog();
    $('btnPanel').onclick = () => document.body.classList.toggle('panel-hidden');

    $('modalWrap').addEventListener('pointerdown', (e) => {
      if (e.target === $('modalWrap')) this.closeModal();
    });
  }

  // ------------------------------------------------ ferramentas
  _bindToolbar() {
    $('toolAdd').onclick = () => $('primShelf').classList.toggle('hidden');
    document.querySelectorAll('#primShelf .prim[data-prim]').forEach(btn => {
      btn.onclick = () => {
        $('primShelf').classList.add('hidden');
        const mesh = this.app.objects.createPrimitive(btn.dataset.prim);
        if (mesh) this.app.objects.add(mesh);
      };
    });
    $('primText').onclick = () => { $('primShelf').classList.add('hidden'); this._textDialog(); };
    $('primImage').onclick = () => {
      $('primShelf').classList.add('hidden');
      $('fileInput').click();
      this.toast('Escolha uma imagem (PNG/JPG) para virar 3D');
    };
    // fecha o menu apenas quando o toque é no próprio canvas
    this.app.viewport.container.addEventListener('pointerdown', (e) => {
      if (e.target === this.app.viewport.renderer.domElement) {
        $('primShelf').classList.add('hidden');
      }
    }, { capture: true });

    $('toolSketch').onclick = () => {
      this._stopModes();
      if (this.app.sketch.active) this.app.sketch.exit(true);
      else this.app.sketch.enter();
    };

    $('btnCut').onclick = () => {
      const sel = this.app.interact.selected;
      if (!sel) return;
      this._stopModes();
      this.app.sketch.enter({ mode: 'cut', target: sel });
    };

    $('toolPaint').onclick = () => {
      const on = !this.app.paint.active;
      if (on) this._stopModes();
      this.app.paint.setActive(on);
      this.app.interact.setMode(this.app.interact.mode); // re-avalia o gizmo
      if (on) this.toast('Pinte com a caneta · dedos movem a vista');
    };

    $('btnMerge').onclick = () => {
      const sel = this.app.interact.selected;
      if (!sel) return;
      this.toast('Toque na peça que será unida a "' + sel.name + '"', 'Cancelar', () => {
        this.app.interact.cancelPick();
      }, 8000);
      this.app.interact.startPick((other) => {
        if (other && other !== sel) this.app.ops.merge(sel, other);
        else this.toast('Mesclagem cancelada');
      });
    };

    $('modeTranslate').onclick = () => this._setMode('translate');
    $('modeRotate').onclick = () => this._setMode('rotate');
    $('modeScale').onclick = () => this._setMode('scale');

    $('btnDuplicate').onclick = () => this.app.interact.duplicateSelected();
    $('btnDelete').onclick = () => this.app.interact.deleteSelected();
  }

  _stopModes() {
    if (this.app.paint.active) {
      this.app.paint.setActive(false);
      this.app.interact.setMode(this.app.interact.mode);
    }
    this.app.interact.cancelPick();
  }

  _setMode(mode) {
    this._stopModes();
    const cur = this.app.interact.mode;
    this.app.interact.setMode(cur === mode && !this.app.paint.active ? 'none' : mode);
  }

  // ------------------------------------------------ esboço
  _bindSketchbar() {
    document.querySelectorAll('#sketchbar [data-stool]').forEach(btn => {
      btn.onclick = () => this.app.sketch.setTool(btn.dataset.stool);
    });
    $('sketchMagic').onclick = () => this.app.sketch.setMagic(!this.app.sketch.magic);
    $('sketchUndo').onclick = () => this.app.sketch.undoStroke();
    $('sketchDone').onclick = () => this.app.sketch.finish();
    $('sketchCancel').onclick = () => this.app.sketch.exit(true);
  }

  // ------------------------------------------------ pintura
  _bindPaintbar() {
    $('paintColor').style.background = '#ff8a3d';
    $('paintColor').onclick = () => {
      const cur = '#' + this.app.paint.color.getHexString();
      this.picker.open({
        color: cur,
        onLive: (hex) => {
          this.app.paint.setColor(hex);
          $('paintColor').style.background = hex;
        },
        onCommit: () => {},
      });
    };
    $('paintSize').addEventListener('input', () => {
      const v = Number($('paintSize').value);
      this.app.paint.setRadius(v);
      $('paintSizeVal').textContent = v + ' mm';
    });
    $('paintDone').onclick = () => {
      this.app.paint.setActive(false);
      this.app.interact.setMode(this.app.interact.mode);
    };
  }

  refreshPaint() {
    const on = this.app.paint.active;
    $('paintbar').classList.toggle('hidden', !on);
    $('toolPaint').classList.toggle('active', on);
  }

  // ------------------------------------------------ vistas
  _bindViewbar() {
    document.querySelectorAll('#viewbar [data-view]').forEach(btn => {
      btn.onclick = () => {
        const sel = this.app.interact.selected;
        const box = sel ? this.app.objects.bounds(sel) : this.app.objects.boundsAll();
        this.app.viewport.setView(btn.dataset.view, box);
      };
    });
    $('btnFrameAll').onclick = () => {
      const box = this.app.objects.boundsAll();
      if (box.isEmpty()) this.app.viewport.setView('iso', null);
      else this.app.viewport.frameBox(box);
    };
  }

  // ------------------------------------------------ painel de propriedades
  _bindPanel() {
    $('propName').addEventListener('change', () => {
      const sel = this.app.interact.selected;
      if (sel) { sel.name = $('propName').value.trim() || sel.name; this.refreshList(); }
    });

    // cor do objeto: abre o seletor completo
    $('propColor').onclick = () => {
      const sel = this.app.interact.selected;
      if (!sel) return;
      const m = this.app.objects.firstMaterial(sel);
      const before = m && m.color ? '#' + m.color.getHexString() : '#4fc3f7';
      const hadVertexColors = !!(m && m.vertexColors);
      const applyHex = (hex) => {
        this.app.objects.eachMaterial(sel, mm => {
          mm.color.set(hex);
          mm.vertexColors = false;
          mm.needsUpdate = true;
        });
        $('propColor').style.background = hex;
      };
      this.picker.open({
        color: before,
        onLive: applyHex,
        onCommit: (hex, changed) => {
          if (!changed) return;
          this.app.history.push({
            label: 'cor',
            undo: () => {
              this.app.objects.eachMaterial(sel, mm => {
                mm.color.set(before);
                mm.vertexColors = hadVertexColors;
                mm.needsUpdate = true;
              });
              this.refresh();
            },
            redo: () => { applyHex(hex); this.refresh(); },
          });
          this.refreshRecents();
          this.refreshList();
        },
        onCancel: () => { applyHex(before); },
      });
    };

    // chips de acabamento
    const chipsWrap = $('finishChips');
    for (const [key, f] of Object.entries(FINISHES)) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.finish = key;
      b.textContent = f.label;
      b.onclick = () => {
        const sel = this.app.interact.selected;
        if (!sel) return;
        const m = this.app.objects.firstMaterial(sel);
        const before = (m && m.userData.finish) || 'padrao';
        if (before === key) return;
        const apply = (fin) => { this.app.objects.setFinish(sel, fin); this.refresh(); };
        apply(key);
        this.app.history.push({ label: 'acabamento', undo: () => apply(before), redo: () => apply(key) });
      };
      chipsWrap.appendChild(b);
    }

    const matSliderStart = () => {
      const sel = this.app.interact.selected;
      const m = sel && this.app.objects.firstMaterial(sel);
      this._matBefore = m ? { roughness: m.roughness, metalness: m.metalness } : null;
    };
    const matSliderApply = () => {
      const sel = this.app.interact.selected;
      if (!sel) return;
      const rough = Number($('propRough').value) / 100;
      const metal = Number($('propMetal').value) / 100;
      this.app.objects.eachMaterial(sel, m => { m.roughness = rough; m.metalness = metal; });
    };
    for (const id of ['propMetal', 'propRough']) {
      $(id).addEventListener('pointerdown', matSliderStart);
      $(id).addEventListener('input', matSliderApply);
      $(id).addEventListener('change', () => {
        const sel = this.app.interact.selected, before = this._matBefore;
        if (!sel || !before) return;
        const after = { roughness: Number($('propRough').value) / 100, metalness: Number($('propMetal').value) / 100 };
        const apply = (v) => this.app.objects.eachMaterial(sel, m => { m.roughness = v.roughness; m.metalness = v.metalness; });
        this.app.history.push({ label: 'material', undo: () => apply(before), redo: () => apply(after) });
      });
    }

    // posição / rotação
    const xyzIds = ['posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ'];
    const num = (id, fallback) => {
      const v = parseFloat($(id).value);
      return isFinite(v) ? v : fallback;
    };
    for (const id of xyzIds) {
      $(id).addEventListener('focus', () => {
        const sel = this.app.interact.selected;
        this._xformBefore = sel ? this.app.interact.snapshotOf(sel) : null;
      });
      $(id).addEventListener('change', () => {
        const sel = this.app.interact.selected;
        if (!sel) return;
        sel.position.set(num('posX', sel.position.x), num('posY', sel.position.y), num('posZ', sel.position.z));
        sel.rotation.set(
          THREE.MathUtils.degToRad(num('rotX', 0)),
          THREE.MathUtils.degToRad(num('rotY', 0)),
          THREE.MathUtils.degToRad(num('rotZ', 0)));
        if (this._xformBefore) this.app.interact.pushTransformCmd(sel, this._xformBefore);
        this._xformBefore = this.app.interact.snapshotOf(sel);
        this.refresh();
      });
    }

    // escala uniforme (sem deformar) + campo em %
    $('scaleDown').onclick = () => { this.app.interact.scaleSelected(0.9); this.refresh(); };
    $('scaleUp').onclick = () => { this.app.interact.scaleSelected(1.1); this.refresh(); };
    $('scalePct').addEventListener('focus', () => {
      const sel = this.app.interact.selected;
      this._scaleBefore = sel ? this.app.interact.snapshotOf(sel) : null;
    });
    $('scalePct').addEventListener('change', () => {
      const sel = this.app.interact.selected;
      if (!sel) return;
      const pct = Math.max(1, num('scalePct', 100));
      sel.scale.setScalar(pct / 100);
      if (this._scaleBefore) this.app.interact.pushTransformCmd(sel, this._scaleBefore);
      this._scaleBefore = this.app.interact.snapshotOf(sel);
      this.refresh();
    });

    // altura da extrusão
    $('extrudeH').addEventListener('pointerdown', () => {
      const sel = this.app.interact.selected;
      this._extrudeBefore = sel && sel.userData.extrude ? sel.userData.extrude.depth : null;
    });
    $('extrudeH').addEventListener('input', () => {
      const sel = this.app.interact.selected;
      if (!sel || !sel.userData.extrude) return;
      const d = Number($('extrudeH').value);
      $('extrudeHVal').textContent = d;
      rebuildExtrudeDepth(sel, d);
      this.app.interact.refreshSelection();
    });
    $('extrudeH').addEventListener('change', () => {
      const sel = this.app.interact.selected, before = this._extrudeBefore;
      const after = Number($('extrudeH').value);
      if (!sel || before === null || before === after) return;
      this.app.history.push({
        label: 'altura',
        undo: () => { rebuildExtrudeDepth(sel, before); this.refresh(); },
        redo: () => { rebuildExtrudeDepth(sel, after); this.refresh(); },
      });
    });

    // relevo da imagem
    const rebuildRelief = (sel, mm) => {
      const r = sel.userData.relief;
      r.params.reliefMM = mm;
      const old = sel.geometry;
      sel.geometry = buildReliefGeometry(b64ToGray(r.gray), r.w, r.h, r.params);
      old.dispose();
      this.app.interact.refreshSelection();
    };
    $('reliefH').addEventListener('pointerdown', () => {
      const sel = this.app.interact.selected;
      this._reliefBefore = sel && sel.userData.relief ? sel.userData.relief.params.reliefMM : null;
    });
    $('reliefH').addEventListener('input', () => {
      const sel = this.app.interact.selected;
      if (!sel || !sel.userData.relief) return;
      const mm = Number($('reliefH').value);
      $('reliefHVal').textContent = mm;
      rebuildRelief(sel, mm);
    });
    $('reliefH').addEventListener('change', () => {
      const sel = this.app.interact.selected, before = this._reliefBefore;
      const after = Number($('reliefH').value);
      if (!sel || before === null || before === after) return;
      this.app.history.push({
        label: 'relevo',
        undo: () => { rebuildRelief(sel, before); this.refresh(); },
        redo: () => { rebuildRelief(sel, after); this.refresh(); },
      });
    });

    // suavização de faces
    $('smoothLvl').addEventListener('change', () => {
      const sel = this.app.interact.selected;
      if (!sel) return;
      const lvl = Number($('smoothLvl').value);
      $('smoothLvlVal').textContent = lvl;
      this.app.ops.smooth(sel, lvl);
    });
    $('smoothLvl').addEventListener('input', () => {
      $('smoothLvlVal').textContent = $('smoothLvl').value;
    });

    $('btnGround').onclick = () => {
      const sel = this.app.interact.selected;
      if (!sel) return;
      const before = this.app.interact.snapshotOf(sel);
      this.app.objects.dropToGround(sel);
      this.app.interact.pushTransformCmd(sel, before);
      this.refresh();
    };
    $('btnFrame').onclick = () => {
      const sel = this.app.interact.selected;
      if (sel) this.app.viewport.frameBox(this.app.objects.bounds(sel));
    };
  }

  refreshRecents() {
    const wrap = $('recentColors');
    wrap.innerHTML = '';
    for (const hex of this.picker.recents.slice(0, 8)) {
      const b = document.createElement('button');
      b.className = 'rc';
      b.style.background = hex;
      b.title = hex;
      b.onclick = () => {
        const sel = this.app.interact.selected;
        if (!sel) return;
        const m = this.app.objects.firstMaterial(sel);
        const before = m && m.color ? '#' + m.color.getHexString() : '#4fc3f7';
        const apply = (h) => this.app.objects.eachMaterial(sel, mm => {
          mm.color.set(h); mm.vertexColors = false; mm.needsUpdate = true;
        });
        apply(hex);
        this.app.history.push({ label: 'cor', undo: () => apply(before), redo: () => apply(hex) });
        this.refresh();
        this.refreshList();
      };
      wrap.appendChild(b);
    }
  }

  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      const tag = (document.activeElement || {}).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const it = this.app.interact;
      if (e.key === 'Delete' || e.key === 'Backspace') { it.deleteSelected(); }
      else if (e.key === 'Escape') {
        if (this.picker.isOpen) this.picker.close(false);
        else if (this.modalOpen) this.closeModal();
        else if (this.app.sketch.active) this.app.sketch.exit(true);
        else if (this.app.paint.active) { this.app.paint.setActive(false); it.setMode(it.mode); }
        else it.select(null);
      }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? this.app.history.redo() : this.app.history.undo();
      }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); this.app.history.redo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); it.duplicateSelected(); }
    });
  }

  // ------------------------------------------------ atualizações
  refresh() {
    const sel = this.app.interact.selected;
    $('btnDuplicate').disabled = !sel;
    $('btnDelete').disabled = !sel;
    $('btnCut').disabled = !sel;
    $('btnMerge').disabled = !sel || this.app.objects.list.length < 2;
    $('propsSection').classList.toggle('hidden', !sel);
    $('emptyHint').classList.toggle('hidden',
      this.app.objects.list.length > 0 || this.app.sketch.active || this.app.paint.active);

    document.querySelectorAll('#objList li').forEach(li => {
      li.classList.toggle('sel', li._obj === sel);
    });

    if (!sel) return;
    $('propName').value = sel.name;
    const m = this.app.objects.firstMaterial(sel);
    if (m) {
      $('propMetal').value = Math.round((m.metalness ?? 0) * 100);
      $('propRough').value = Math.round((m.roughness ?? 0.5) * 100);
      $('propColor').style.background = m.color ? '#' + m.color.getHexString() : '#888';
      const fin = m.userData.finish || 'padrao';
      document.querySelectorAll('#finishChips .chip').forEach(c => {
        c.classList.toggle('active', c.dataset.finish === fin);
      });
    }
    const f1 = (v) => (Math.round(v * 10) / 10);
    $('posX').value = f1(sel.position.x);
    $('posY').value = f1(sel.position.y);
    $('posZ').value = f1(sel.position.z);
    $('rotX').value = f1(THREE.MathUtils.radToDeg(sel.rotation.x));
    $('rotY').value = f1(THREE.MathUtils.radToDeg(sel.rotation.y));
    $('rotZ').value = f1(THREE.MathUtils.radToDeg(sel.rotation.z));
    $('scalePct').value = Math.round(sel.scale.x * 100);

    const isExtrude = !!sel.userData.extrude && !sel.userData.geomDirty;
    $('extrudeRow').classList.toggle('hidden', !isExtrude);
    if (isExtrude) {
      $('extrudeH').value = sel.userData.extrude.depth;
      $('extrudeHVal').textContent = sel.userData.extrude.depth;
    }
    const isRelief = !!sel.userData.relief;
    $('reliefRow').classList.toggle('hidden', !isRelief);
    if (isRelief) {
      $('reliefH').value = sel.userData.relief.params.reliefMM;
      $('reliefHVal').textContent = sel.userData.relief.params.reliefMM;
    }
    const canSmooth = !!sel.isMesh && !isRelief;
    $('smoothRow').classList.toggle('hidden', !canSmooth);
    if (canSmooth) {
      $('smoothLvl').value = sel.userData.smoothLevel || 0;
      $('smoothLvlVal').textContent = sel.userData.smoothLevel || 0;
    }

    const size = this.app.objects.bounds(sel).getSize(new THREE.Vector3());
    $('dims').textContent = `Tamanho: ${f1(size.x)} × ${f1(size.y)} × ${f1(size.z)} mm`;
  }

  refreshList() {
    const ul = $('objList');
    ul.innerHTML = '';
    const list = this.app.objects.list;
    $('objCount').textContent = list.length ? `(${list.length})` : '';
    for (const obj of list) {
      const li = document.createElement('li');
      li._obj = obj;
      if (obj === this.app.interact.selected) li.classList.add('sel');

      const dot = document.createElement('span');
      dot.className = 'dot';
      const m = this.app.objects.firstMaterial(obj);
      dot.style.background = m && m.color ? '#' + m.color.getHexString() : '#888';

      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = obj.name;

      const eye = document.createElement('button');
      eye.className = 'eye';
      eye.innerHTML = obj.visible ? EYE_ON : EYE_OFF;
      eye.onclick = (e) => {
        e.stopPropagation();
        obj.visible = !obj.visible;
        if (!obj.visible && this.app.interact.selected === obj) this.app.interact.select(null);
        eye.innerHTML = obj.visible ? EYE_ON : EYE_OFF;
      };

      li.append(dot, nm, eye);
      li.onclick = () => this.app.interact.select(obj);
      ul.appendChild(li);
    }
  }

  refreshHistory() {
    $('btnUndo').disabled = !this.app.history.canUndo;
    $('btnRedo').disabled = !this.app.history.canRedo;
  }

  refreshModes() {
    const mode = this.app.interact.mode;
    const paintOn = this.app.paint.active;
    $('modeTranslate').classList.toggle('active', mode === 'translate' && !paintOn);
    $('modeRotate').classList.toggle('active', mode === 'rotate' && !paintOn);
    $('modeScale').classList.toggle('active', mode === 'scale' && !paintOn);
  }

  refreshSketch() {
    const sk = this.app.sketch;
    $('sketchbar').classList.toggle('hidden', !sk.active);
    $('toolSketch').classList.toggle('active', sk.active && sk.mode === 'add');
    $('btnCut').classList.toggle('active', sk.active && sk.mode === 'cut');
    document.querySelectorAll('#sketchbar [data-stool]').forEach(b => {
      b.classList.toggle('active', b.dataset.stool === sk.tool);
    });
    $('sketchMagic').classList.toggle('active', sk.magic);
    $('sketchDone').disabled = !sk.strokes.length;
    $('sketchDoneLabel').textContent = sk.mode === 'cut' ? 'Cortar' : 'Extrudar';
    $('sketchHint').textContent = sk.mode === 'cut'
      ? 'Desenhe o recorte sobre a peça'
      : 'Desenhe com a caneta · dedos movem a vista';
    for (const id of ['toolAdd', 'toolPaint', 'btnMerge', 'modeTranslate', 'modeRotate', 'modeScale', 'btnDuplicate', 'btnDelete', 'btnCut']) {
      if (sk.active) $(id).setAttribute('disabled', '');
      else if (!['btnDuplicate', 'btnDelete', 'btnCut', 'btnMerge'].includes(id)) $(id).removeAttribute('disabled');
    }
    if (!sk.active) this.refresh();
    else $('emptyHint').classList.add('hidden');
  }

  // ------------------------------------------------ diálogos
  openModal(html) {
    $('modal').innerHTML = html;
    $('modalWrap').classList.remove('hidden');
    this.modalOpen = true;
  }

  closeModal() {
    $('modalWrap').classList.add('hidden');
    $('modal').innerHTML = '';
    this.modalOpen = false;
    if (this._modalClosed) { const f = this._modalClosed; this._modalClosed = null; f(); }
  }

  _exportDialog() {
    const hasSel = !!this.app.interact.selected;
    this.openModal(`
      <h2>Exportar modelo</h2>
      <div class="fmts">
        <button class="fmt active" data-fmt="stl"><b>STL</b><small>impressão 3D (binário)</small></button>
        <button class="fmt" data-fmt="3mf"><b>3MF</b><small>impressão 3D com cores</small></button>
        <button class="fmt" data-fmt="obj"><b>OBJ</b><small>editores 3D em geral</small></button>
        <button class="fmt" data-fmt="glb"><b>GLB</b><small>AR / visualizadores</small></button>
      </div>
      <div class="choices">
        <button class="choice active" data-scope="all">Tudo</button>
        <button class="choice" data-scope="selected" ${hasSel ? '' : 'disabled'}>Somente selecionado</button>
      </div>
      <input id="expName" class="txt" placeholder="nome do arquivo" value="modelo">
      <p>Depois de exportar, toque em <b>Enviar para impressora</b> no aviso para mandar
      o arquivo ao Bambu Handy, Creality Print, ou outro app da sua impressora.</p>
      <div class="mrow">
        <button class="mbtn" id="expCancel">Cancelar</button>
        <button class="mbtn primary" id="expGo">Exportar</button>
      </div>`);
    const modal = $('modal');
    modal.querySelectorAll('.fmt').forEach(b => b.onclick = () => {
      modal.querySelectorAll('.fmt').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    });
    modal.querySelectorAll('.choice').forEach(b => b.onclick = () => {
      modal.querySelectorAll('.choice').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    });
    $('expCancel').onclick = () => this.closeModal();
    $('expGo').onclick = () => {
      const format = modal.querySelector('.fmt.active').dataset.fmt;
      const scope = modal.querySelector('.choice.active').dataset.scope;
      const name = $('expName').value;
      this.closeModal();
      IO.exportModel({ format, scope, name });
    };
  }

  _saveDialog() {
    this.openModal(`
      <h2>Salvar projeto</h2>
      <p>Gera um arquivo <b>.e3d</b> que pode ser reaberto aqui com tudo editável.</p>
      <input id="projName" class="txt" placeholder="nome do projeto" value="projeto">
      <div class="mrow">
        <button class="mbtn" id="projCancel">Cancelar</button>
        <button class="mbtn primary" id="projGo">Salvar</button>
      </div>`);
    $('projCancel').onclick = () => this.closeModal();
    $('projGo').onclick = () => {
      const name = $('projName').value;
      this.closeModal();
      IO.saveProject(name);
    };
  }

  _textDialog() {
    this.openModal(`
      <h2>Texto 3D</h2>
      <input id="txtValue" class="txt" placeholder="escreva aqui…" maxlength="40" value="Korx">
      <div class="sliderrow"><label>Altura</label><input type="range" id="txtSize" min="8" max="60" step="1" value="22"><span id="txtSizeVal">22</span></div>
      <div class="sliderrow"><label>Espessura</label><input type="range" id="txtDepth" min="2" max="24" step="1" value="6"><span id="txtDepthVal">6</span></div>
      <p>Depois arraste o texto para cima da peça e use <b>Mesclar</b> para fixar os dois em uma peça única.</p>
      <div class="mrow">
        <button class="mbtn" id="txtCancel">Cancelar</button>
        <button class="mbtn primary" id="txtGo">Criar</button>
      </div>`);
    $('txtSize').oninput = () => $('txtSizeVal').textContent = $('txtSize').value;
    $('txtDepth').oninput = () => $('txtDepthVal').textContent = $('txtDepth').value;
    $('txtCancel').onclick = () => this.closeModal();
    $('txtGo').onclick = () => {
      const text = $('txtValue').value.trim();
      const sizeMM = Number($('txtSize').value);
      const depthMM = Number($('txtDepth').value);
      this.closeModal();
      if (!text) return;
      this.showLoading('Gerando texto 3D…');
      setTimeout(() => {
        try {
          const mesh = this.app.objects.createText(text, { sizeMM, depthMM });
          this.app.objects.add(mesh);
        } catch (err) {
          console.error(err);
          this.toast('Não consegui gerar este texto');
        } finally {
          this.hideLoading();
        }
      }, 30);
    };
  }

  // Diálogo de imagem: relevo (litofania) ou contorno extrudado.
  async imageDialog(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (err) {
      console.error(err);
      this.toast('Não consegui ler esta imagem');
      return;
    }
    return new Promise((resolve) => {
      this._modalClosed = resolve;
      this.openModal(`
        <h2>Imagem para 3D</h2>
        <div class="choices">
          <button class="choice active" data-imode="relief">Relevo (IA)</button>
          <button class="choice" data-imode="contour">Contorno sólido</button>
        </div>
        <p id="imodeHint">Transforma o claro/escuro da imagem em alto-relevo — perfeito para
        colocar uma foto ou logotipo sobre uma peça.</p>
        <div class="sliderrow"><label>Largura</label><input type="range" id="imgW" min="20" max="160" step="5" value="60"><span id="imgWVal">60</span></div>
        <div class="sliderrow" id="imgReliefRow"><label>Relevo</label><input type="range" id="imgRelief" min="0.5" max="8" step="0.5" value="2.5"><span id="imgReliefVal">2.5</span></div>
        <div class="sliderrow hidden" id="imgDepthRow"><label>Espessura</label><input type="range" id="imgDepth" min="2" max="24" step="1" value="6"><span id="imgDepthVal">6</span></div>
        <div class="sliderrow"><label>Inverter</label><input type="checkbox" id="imgInvert" style="width:22px;height:22px"></div>
        <div class="mrow">
          <button class="mbtn" id="imgCancel">Cancelar</button>
          <button class="mbtn primary" id="imgGo">Criar</button>
        </div>`);
      const modal = $('modal');
      let mode = 'relief';
      modal.querySelectorAll('[data-imode]').forEach(b => b.onclick = () => {
        modal.querySelectorAll('[data-imode]').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        mode = b.dataset.imode;
        $('imgReliefRow').classList.toggle('hidden', mode !== 'relief');
        $('imgDepthRow').classList.toggle('hidden', mode !== 'contour');
        $('imodeHint').textContent = mode === 'relief'
          ? 'Transforma o claro/escuro da imagem em alto-relevo — perfeito para colocar uma foto ou logotipo sobre uma peça.'
          : 'Vetoriza o desenho e extruda como peça sólida — ideal para logotipos e silhuetas.';
      });
      $('imgW').oninput = () => $('imgWVal').textContent = $('imgW').value;
      $('imgRelief').oninput = () => $('imgReliefVal').textContent = $('imgRelief').value;
      $('imgDepth').oninput = () => $('imgDepthVal').textContent = $('imgDepth').value;
      $('imgCancel').onclick = () => this.closeModal();
      $('imgGo').onclick = async () => {
        const widthMM = Number($('imgW').value);
        const reliefMM = Number($('imgRelief').value);
        const depthMM = Number($('imgDepth').value);
        const invert = $('imgInvert').checked;
        this.closeModal();
        this.showLoading('Convertendo imagem…');
        await new Promise(r => setTimeout(r, 30));
        try {
          if (mode === 'relief') {
            const { gray, w, h } = imageToReliefData(bitmap);
            const mesh = this.app.objects.createRelief(gray, w, h, { widthMM, reliefMM, baseMM: 2, invert });
            mesh.name = file.name.replace(/\.[^.]+$/, '') || mesh.name;
            this.app.objects.add(mesh);
            this.toast('Ajuste o “Relevo” no painel · arraste para cima da peça e use Mesclar');
          } else {
            const { geometry, spec } = await imageToContourGeometry(bitmap, { widthMM, depthMM, invert });
            const mesh = new THREE.Mesh(geometry, this.app.objects.makeMaterial(this.app.objects.nextColor()));
            mesh.castShadow = mesh.receiveShadow = true;
            mesh.name = file.name.replace(/\.[^.]+$/, '') || 'Imagem';
            mesh.userData.kind = 'image';
            mesh.userData.extrude = spec;
            this.app.objects.dropToGround(mesh);
            this.app.objects.add(mesh);
          }
        } catch (err) {
          console.error(err);
          this.toast('Não consegui converter esta imagem');
        } finally {
          this.hideLoading();
        }
      };
    });
  }

  _helpDialog() {
    this.openModal(`
      <h2>Como usar o Korx 3D</h2>
      <p><span class="klabel">Um dedo</span> gira a vista (até por baixo) · <span class="klabel">dois dedos</span> aproximam e deslocam.</p>
      <p><span class="klabel">S Pen:</span></p>
      <ul>
        <li>Toque seleciona · arrastar move a peça</li>
        <li><b>Esboço</b>: desenhe e extrude — com ✨ ligado, círculos, estrelas e retângulos tortos ficam perfeitos</li>
        <li><b>Recortar</b>: desenhe sobre a peça para remover material (furos e cortes)</li>
        <li><b>Pintar</b>: pinte as faces com qualquer cor</li>
        <li><b>Mesclar</b>: une duas peças em uma só</li>
      </ul>
      <p><span class="klabel">Cores:</span> toque no círculo de cor para abrir o seletor completo
      (gradiente, código hex, recentes) e escolha acabamentos: fosco, brilhante, metálico e camaleão.</p>
      <p><span class="klabel">Adicionar:</span> formas, <b>Texto 3D</b> e <b>Imagem</b> (relevo tipo litofania ou contorno sólido).</p>
      <p><span class="klabel">Exportar:</span> STL/3MF/OBJ/GLB em milímetros — e envie direto para o app da sua impressora.</p>
      <div class="mrow"><button class="mbtn primary" id="helpOk">Entendi</button></div>`);
    $('helpOk').onclick = () => this.closeModal();
  }

  // ------------------------------------------------ avisos
  toast(msg, actionLabel, actionFn, dur = 3800) {
    $('toastMsg').textContent = msg;
    const act = $('toastAction');
    if (actionLabel) {
      act.textContent = actionLabel;
      act.classList.remove('hidden');
      act.onclick = () => { $('toast').classList.add('hidden'); actionFn && actionFn(); };
    } else {
      act.classList.add('hidden');
    }
    $('toast').classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => $('toast').classList.add('hidden'), dur);
  }

  showLoading(msg) {
    $('loadingMsg').textContent = msg || 'Carregando…';
    $('loading').classList.remove('hidden');
  }

  hideLoading() { $('loading').classList.add('hidden'); }
}

// ================================================================
// Seletor de cores completo: gradiente SV + matiz + hex + recentes
// ================================================================
class ColorPicker {
  constructor(ui) {
    this.ui = ui;
    this.isOpen = false;
    this.h = 200; this.s = 0.7; this.v = 0.9;
    this.recents = this._loadRecents();
    this._cb = null;

    const cv = $('pickerSV');
    this._ctx = cv.getContext('2d');
    const pick = (e) => {
      const r = cv.getBoundingClientRect();
      this.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      this.v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      this._update();
    };
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      this._dragging = true;
      pick(e);
    });
    cv.addEventListener('pointermove', (e) => { if (this._dragging) pick(e); });
    cv.addEventListener('pointerup', () => { this._dragging = false; });

    $('pickerHue').addEventListener('input', () => {
      this.h = Number($('pickerHue').value);
      this._update();
    });
    $('pickerHex').addEventListener('change', () => {
      const v = $('pickerHex').value.trim();
      const hex = v.startsWith('#') ? v : '#' + v;
      if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
        this.setHex(hex);
        this._update();
      } else {
        $('pickerHex').value = this.hex();
      }
    });
    $('pickerOk').onclick = () => this.close(true);
    $('pickerCancel').onclick = () => this.close(false);
    $('pickerWrap').addEventListener('pointerdown', (e) => {
      if (e.target === $('pickerWrap')) this.close(true);
    });
  }

  open({ color, onLive, onCommit, onCancel }) {
    this._cb = { onLive, onCommit, onCancel };
    this._original = color;
    this.setHex(color);
    this._changed = false;
    this.isOpen = true;
    $('pickerWrap').classList.remove('hidden');
    this._renderRecents();
    this._update(false);
  }

  close(commit) {
    if (!this.isOpen) return;
    this.isOpen = false;
    $('pickerWrap').classList.add('hidden');
    const cb = this._cb;
    this._cb = null;
    if (!cb) return;
    if (commit) {
      const hex = this.hex();
      if (this._changed) this.addRecent(hex);
      cb.onCommit && cb.onCommit(hex, this._changed);
    } else {
      cb.onCancel ? cb.onCancel(this._original) : (cb.onLive && cb.onLive(this._original));
    }
    this.ui.refreshRecents();
  }

  setHex(hex) {
    const { r, g, b } = hexToRgb(hex);
    const { h, s, v } = rgbToHsv(r, g, b);
    if (s > 0.001 && v > 0.001) this.h = h; // preserva matiz em tons de cinza
    this.s = s; this.v = v;
    $('pickerHue').value = Math.round(this.h);
  }

  hex() {
    const { r, g, b } = hsvToRgb(this.h, this.s, this.v);
    return rgbToHex(r, g, b);
  }

  _update(live = true) {
    this._draw();
    const hex = this.hex();
    $('pickerPreview').style.background = hex;
    $('pickerHex').value = hex;
    if (live) {
      this._changed = true;
      this._cb && this._cb.onLive && this._cb.onLive(hex);
    }
  }

  _draw() {
    const ctx = this._ctx;
    const w = ctx.canvas.width, h = ctx.canvas.height;
    const base = hsvToRgb(this.h, 1, 1);
    ctx.fillStyle = `rgb(${base.r},${base.g},${base.b})`;
    ctx.fillRect(0, 0, w, h);
    let grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    // mira
    const x = this.s * w, y = (1 - this.v) * h;
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 9.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  _renderRecents() {
    const wrap = $('pickerRecents');
    wrap.innerHTML = '';
    for (const hex of this.recents) {
      const b = document.createElement('button');
      b.className = 'rc';
      b.style.background = hex;
      b.onclick = () => { this.setHex(hex); this._update(); };
      wrap.appendChild(b);
    }
  }

  addRecent(hex) {
    this.recents = [hex, ...this.recents.filter(c => c !== hex)].slice(0, 12);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(this.recents)); } catch { }
  }

  _loadRecents() {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      if (Array.isArray(v) && v.length) return v.filter(c => /^#[0-9a-fA-F]{6}$/.test(c));
    } catch { }
    return ['#4fc3f7', '#ff8a3d', '#66bb6a', '#e57373', '#ba68c8', '#fff176', '#90a4ae', '#e0e0e0'];
  }
}

// ---------- conversões de cor ----------
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex(r, g, b) {
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}
function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
