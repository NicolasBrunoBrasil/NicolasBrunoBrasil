import * as THREE from 'three';
import { PALETTE } from './objects.js';
import { rebuildExtrudeDepth } from './sketch.js';
import * as IO from './io.js';

const $ = (id) => document.getElementById(id);
const EYE_ON = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/></svg>';

export class UI {
  constructor(app) {
    this.app = app;
    this.modalOpen = false;
    this._toastTimer = null;

    this._buildSwatches();
    this._bindTopbar();
    this._bindToolbar();
    this._bindSketchbar();
    this._bindViewbar();
    this._bindPanel();
    this._bindKeyboard();

    app.on('selection-changed', () => this.refresh());
    app.on('objects-changed', () => { this.refreshList(); this.refresh(); });
    app.on('history-changed', () => this.refreshHistory());
    app.on('mode-changed', () => this.refreshModes());
    app.on('sketch-changed', () => this.refreshSketch());

    if (window.matchMedia('(max-width: 900px)').matches) {
      document.body.classList.add('panel-hidden');
    }
    this.refresh();
    this.refreshList();
    this.refreshHistory();
  }

  // ------------------------------------------------ ligações
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
    $('btnHelp').onclick = () => this._helpDialog();
    $('btnPanel').onclick = () => document.body.classList.toggle('panel-hidden');

    $('modalWrap').addEventListener('pointerdown', (e) => {
      if (e.target === $('modalWrap')) this.closeModal();
    });
  }

  _bindToolbar() {
    $('toolAdd').onclick = () => $('primShelf').classList.toggle('hidden');
    document.querySelectorAll('#primShelf .prim').forEach(btn => {
      btn.onclick = () => {
        $('primShelf').classList.add('hidden');
        const mesh = this.app.objects.createPrimitive(btn.dataset.prim);
        if (mesh) this.app.objects.add(mesh);
      };
    });
    this.app.viewport.container.addEventListener('pointerdown', () => {
      $('primShelf').classList.add('hidden');
    }, { capture: true });

    $('toolSketch').onclick = () => {
      if (this.app.sketch.active) this.app.sketch.exit(true);
      else this.app.sketch.enter();
    };

    $('modeTranslate').onclick = () => this._setMode('translate');
    $('modeRotate').onclick = () => this._setMode('rotate');
    $('modeScale').onclick = () => this._setMode('scale');

    $('btnDuplicate').onclick = () => this.app.interact.duplicateSelected();
    $('btnDelete').onclick = () => this.app.interact.deleteSelected();
  }

  _setMode(mode) {
    const cur = this.app.interact.mode;
    this.app.interact.setMode(cur === mode ? 'none' : mode);
  }

  _bindSketchbar() {
    document.querySelectorAll('#sketchbar [data-stool]').forEach(btn => {
      btn.onclick = () => this.app.sketch.setTool(btn.dataset.stool);
    });
    $('sketchUndo').onclick = () => this.app.sketch.undoStroke();
    $('sketchDone').onclick = () => this.app.sketch.finish();
    $('sketchCancel').onclick = () => this.app.sketch.exit(true);
  }

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

  _bindPanel() {
    $('propName').addEventListener('change', () => {
      const sel = this.app.interact.selected;
      if (sel) { sel.name = $('propName').value.trim() || sel.name; this.refreshList(); }
    });

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

    const xyzIds = ['posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ'];
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
    const num = (id, fallback) => {
      const v = parseFloat($(id).value);
      return isFinite(v) ? v : fallback;
    };

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

  _buildSwatches() {
    const wrap = $('swatches');
    for (const hex of PALETTE) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = hex;
      b.onclick = () => {
        const sel = this.app.interact.selected;
        if (!sel) return;
        const m = this.app.objects.firstMaterial(sel);
        const before = m && m.color ? '#' + m.color.getHexString() : '#4fc3f7';
        const apply = (c) => this.app.objects.eachMaterial(sel, mm => { mm.color.set(c); mm.vertexColors = false; mm.needsUpdate = true; });
        apply(hex);
        this.app.history.push({ label: 'cor', undo: () => apply(before), redo: () => apply(hex) });
        this._markSwatch(hex);
      };
      wrap.appendChild(b);
    }
  }

  _markSwatch(hex) {
    document.querySelectorAll('.swatch').forEach((s, i) => {
      s.classList.toggle('active', PALETTE[i].toLowerCase() === (hex || '').toLowerCase());
    });
  }

  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      const tag = (document.activeElement || {}).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const it = this.app.interact;
      if (e.key === 'Delete' || e.key === 'Backspace') { it.deleteSelected(); }
      else if (e.key === 'Escape') {
        if (this.modalOpen) this.closeModal();
        else if (this.app.sketch.active) this.app.sketch.exit(true);
        else it.select(null);
      }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? this.app.history.redo() : this.app.history.undo();
      }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); this.app.history.redo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); it.duplicateSelected(); }
      else if (e.key.toLowerCase() === 'm') it.setMode('translate');
      else if (e.key.toLowerCase() === 'r') it.setMode('rotate');
      else if (e.key.toLowerCase() === 't') it.setMode('scale');
    });
  }

  // ------------------------------------------------ atualizações
  refresh() {
    const sel = this.app.interact.selected;
    $('btnDuplicate').disabled = !sel;
    $('btnDelete').disabled = !sel;
    $('propsSection').classList.toggle('hidden', !sel);
    $('emptyHint').classList.toggle('hidden', this.app.objects.list.length > 0 || this.app.sketch.active);

    document.querySelectorAll('#objList li').forEach(li => {
      li.classList.toggle('sel', li._obj === sel);
    });

    if (!sel) return;
    $('propName').value = sel.name;
    const m = this.app.objects.firstMaterial(sel);
    if (m) {
      $('propMetal').value = Math.round((m.metalness ?? 0) * 100);
      $('propRough').value = Math.round((m.roughness ?? 0.5) * 100);
      this._markSwatch(m.color ? '#' + m.color.getHexString() : null);
    }
    const f1 = (v) => (Math.round(v * 10) / 10);
    $('posX').value = f1(sel.position.x);
    $('posY').value = f1(sel.position.y);
    $('posZ').value = f1(sel.position.z);
    $('rotX').value = f1(THREE.MathUtils.radToDeg(sel.rotation.x));
    $('rotY').value = f1(THREE.MathUtils.radToDeg(sel.rotation.y));
    $('rotZ').value = f1(THREE.MathUtils.radToDeg(sel.rotation.z));

    const isExtrude = !!sel.userData.extrude;
    $('extrudeRow').classList.toggle('hidden', !isExtrude);
    if (isExtrude) {
      $('extrudeH').value = sel.userData.extrude.depth;
      $('extrudeHVal').textContent = sel.userData.extrude.depth;
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
      li.onclick = () => this.app.interact.select(obj.visible ? obj : obj);
      ul.appendChild(li);
    }
  }

  refreshHistory() {
    $('btnUndo').disabled = !this.app.history.canUndo;
    $('btnRedo').disabled = !this.app.history.canRedo;
  }

  refreshModes() {
    const mode = this.app.interact.mode;
    $('modeTranslate').classList.toggle('active', mode === 'translate');
    $('modeRotate').classList.toggle('active', mode === 'rotate');
    $('modeScale').classList.toggle('active', mode === 'scale');
  }

  refreshSketch() {
    const sk = this.app.sketch;
    $('sketchbar').classList.toggle('hidden', !sk.active);
    $('toolSketch').classList.toggle('active', sk.active);
    document.querySelectorAll('#sketchbar [data-stool]').forEach(b => {
      b.classList.toggle('active', b.dataset.stool === sk.tool);
    });
    $('sketchDone').disabled = !sk.strokes.length;
    for (const id of ['toolAdd', 'modeTranslate', 'modeRotate', 'modeScale', 'btnDuplicate', 'btnDelete']) {
      if (sk.active) $(id).setAttribute('disabled', '');
      else if (id !== 'btnDuplicate' && id !== 'btnDelete') $(id).removeAttribute('disabled');
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
      <p>Gera um arquivo <b>.e3d</b> que pode ser reaberto aqui com todas as formas editáveis.</p>
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

  _helpDialog() {
    this.openModal(`
      <h2>Como usar</h2>
      <p><span class="klabel">Um dedo</span> gira a vista · <span class="klabel">dois dedos</span> aproximam e deslocam.</p>
      <p><span class="klabel">S Pen:</span></p>
      <ul>
        <li>Toque em um objeto para selecionar</li>
        <li>Arraste um objeto para movê-lo no plano</li>
        <li>Puxe as setas/anéis do gizmo para mover, girar e escalar com precisão</li>
        <li>No modo <b>Esboço</b>, desenhe contornos e toque em <b>Extrudar</b> — desenhos dentro de outros viram furos</li>
        <li>Botão lateral da caneta + arrastar = deslocar a vista</li>
      </ul>
      <p><span class="klabel">Ímã</span> (barra superior) encaixa em 1 mm e 15°. As medidas são em milímetros, prontas para impressão 3D.</p>
      <p><span class="klabel">Importar:</span> STL, 3MF, OBJ, GLB · <span class="klabel">Exportar:</span> STL, 3MF, OBJ, GLB.</p>
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
