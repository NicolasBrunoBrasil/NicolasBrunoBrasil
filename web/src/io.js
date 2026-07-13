import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { buildExtrudeGeometry } from './sketch.js';
import { b64ToGray, buildReliefGeometry } from './shapegen.js';

let app = null;
const PRIM_KINDS = new Set(['box', 'sphere', 'cylinder', 'cone', 'torus', 'plate', 'wedge']);
const AUTOSAVE_KEY = 'estudio3d.autosave.v1';

export function init(a) {
  app = a;
  setInterval(autosave, 40000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosave();
  });
}

// ============================ IMPORTAÇÃO ============================

export async function importFiles(fileList) {
  for (const file of Array.from(fileList)) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    app.ui.showLoading(`Importando ${file.name}…`);
    await nextFrame();
    try {
      if (ext === 'e3d' || ext === 'json') {
        await openProjectFile(file);
        continue;
      }
      if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) {
        app.ui.hideLoading();
        await app.ui.imageDialog(file);
        continue;
      }
      const obj = await parseModelFile(file, ext);
      if (!obj) { app.ui.toast(`Formato não suportado: .${ext}`); continue; }

      obj.name = baseName(file.name);
      obj.userData.kind = 'import';
      app.objects.prepare(obj);
      obj.updateMatrixWorld(true);

      const box = new THREE.Box3().setFromObject(obj);
      if (!box.isEmpty()) {
        const size = box.getSize(new THREE.Vector3());
        const half = Math.max(size.x, size.z) / 2;
        const spot = app.objects.findFreeSpot(half);
        obj.position.set(spot.x - (box.min.x + box.max.x) / 2, -box.min.y, spot.z - (box.min.z + box.max.z) / 2);
      }
      app.objects.add(obj);
      app.viewport.frameBox(app.objects.bounds(obj));
      const tris = Math.round(app.objects.triangleCount(obj));
      app.ui.toast(`Importado: ${obj.name} (${tris.toLocaleString('pt-BR')} triângulos)`);
    } catch (err) {
      console.error(err);
      app.ui.toast(`Não consegui ler ${file.name}`);
    } finally {
      app.ui.hideLoading();
    }
  }
}

async function parseModelFile(file, ext) {
  const buf = await file.arrayBuffer();
  if (ext === 'stl') {
    const geometry = new STLLoader().parse(buf);
    geometry.rotateX(-Math.PI / 2); // STL de impressão costuma ser Z para cima
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    const material = app.objects.makeMaterial(app.objects.nextColor());
    if (geometry.hasColors) {
      material.vertexColors = true;
      material.color.set(0xffffff);
    }
    return new THREE.Mesh(geometry, material);
  }
  if (ext === 'obj') {
    const group = new OBJLoader().parse(new TextDecoder().decode(buf));
    convertMaterials(group);
    return group;
  }
  if (ext === '3mf') {
    const inner = new ThreeMFLoader().parse(buf);
    convertMaterials(inner);
    const wrap = new THREE.Group(); // 3MF é Z para cima
    wrap.rotation.x = -Math.PI / 2;
    wrap.add(inner);
    return wrap;
  }
  if (ext === 'glb' || ext === 'gltf') {
    const gltf = await new Promise((resolve, reject) =>
      new GLTFLoader().parse(buf, '', resolve, reject));
    const wrap = new THREE.Group();
    wrap.add(gltf.scene);
    return wrap;
  }
  return null;
}

function convertMaterials(root) {
  const palette = app.objects.nextColor();
  root.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const converted = mats.map(m => {
      const std = new THREE.MeshStandardMaterial({
        color: (m && m.color) ? m.color.clone() : new THREE.Color(palette),
        roughness: 0.6, metalness: 0.05,
        vertexColors: !!(m && m.vertexColors),
      });
      return std;
    });
    o.material = Array.isArray(o.material) ? converted : converted[0];
  });
}

// ============================ EXPORTAÇÃO ============================

export async function exportModel({ format, scope, name }) {
  const sel = app.interact.selected;
  const list = (scope === 'selected' && sel) ? [sel] : app.objects.list.filter(o => o.visible);
  if (!list.length) { app.ui.toast('Nada para exportar'); return; }

  app.ui.showLoading(`Gerando ${format.toUpperCase()}…`);
  await nextFrame();
  try {
    const root = new THREE.Group();
    for (const o of list) root.add(o.clone(true));
    const fname = sanitize(name || 'modelo') + '.' + format;

    if (format === 'stl') {
      const zUp = wrapZUp(root);
      const data = new STLExporter().parse(zUp, { binary: true });
      await saveBlob(fname, new Blob([data], { type: 'model/stl' }));
    } else if (format === 'obj') {
      root.updateMatrixWorld(true);
      const text = new OBJExporter().parse(root);
      await saveBlob(fname, new Blob([text], { type: 'text/plain' }));
    } else if (format === '3mf') {
      const zUp = wrapZUp(root);
      const bytes = export3MF(zUp);
      await saveBlob(fname, new Blob([bytes], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' }));
    } else if (format === 'glb') {
      const buf = await new Promise((resolve, reject) =>
        new GLTFExporter().parse(root, resolve, reject, { binary: true }));
      await saveBlob(fname, new Blob([buf], { type: 'model/gltf-binary' }));
    }
  } catch (err) {
    console.error(err);
    app.ui.toast('Falha ao exportar: ' + (err.message || err));
  } finally {
    app.ui.hideLoading();
  }
}

function wrapZUp(root) {
  // three.js usa Y para cima; STL/3MF de impressão usam Z para cima
  const wrap = new THREE.Group();
  wrap.rotation.x = Math.PI / 2;
  wrap.add(root);
  wrap.updateMatrixWorld(true);
  return wrap;
}

function export3MF(root) {
  const meshes = [];
  root.traverse(o => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
  if (!meshes.length) throw new Error('sem malhas');

  const xml = [];
  xml.push('<?xml version="1.0" encoding="UTF-8"?>');
  xml.push('<model unit="millimeter" xml:lang="und" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">');
  xml.push(' <resources>');
  xml.push('  <basematerials id="1">');
  for (const m of meshes) {
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    const hex = (mat && mat.color) ? mat.color.getHexString().toUpperCase() : '4FC3F7';
    xml.push(`   <base name="${escXml(m.name || 'Objeto')}" displaycolor="#${hex}FF"/>`);
  }
  xml.push('  </basematerials>');

  const v = new THREE.Vector3();
  meshes.forEach((mesh, mi) => {
    const id = mi + 2;
    const g = mesh.geometry;
    const pos = g.attributes.position;
    xml.push(`  <object id="${id}" type="model" pid="1" pindex="${mi}" name="${escXml(mesh.name || 'Objeto')}">`);
    xml.push('   <mesh>');
    xml.push('    <vertices>');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      xml.push(`     <vertex x="${n3(v.x)}" y="${n3(v.y)}" z="${n3(v.z)}"/>`);
    }
    xml.push('    </vertices>');
    xml.push('    <triangles>');
    if (g.index) {
      const idx = g.index;
      for (let i = 0; i < idx.count; i += 3) {
        xml.push(`     <triangle v1="${idx.getX(i)}" v2="${idx.getX(i + 1)}" v3="${idx.getX(i + 2)}"/>`);
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        xml.push(`     <triangle v1="${i}" v2="${i + 1}" v3="${i + 2}"/>`);
      }
    }
    xml.push('    </triangles>');
    xml.push('   </mesh>');
    xml.push('  </object>');
  });

  xml.push(' </resources>');
  xml.push(' <build>');
  meshes.forEach((_, mi) => xml.push(`  <item objectid="${mi + 2}"/>`));
  xml.push(' </build>');
  xml.push('</model>');

  const contentTypes = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(xml.join('\n')),
  }, { level: 6 });
}

// ============================ PROJETO ============================

export function serializeProject() {
  const objs = app.objects;
  return {
    app: 'estudio3d',
    version: 1,
    objects: objs.list.map(o => {
      o.updateMatrix();
      const rec = {
        name: o.name,
        kind: o.userData.kind || 'import',
        visible: o.visible,
        matrix: o.matrix.toArray(),
      };
      const mat = objs.firstMaterial(o);
      if (mat && mat.color) {
        rec.material = {
          color: '#' + mat.color.getHexString(),
          roughness: mat.roughness ?? 0.55,
          metalness: mat.metalness ?? 0.05,
          finish: mat.userData.finish || 'padrao',
        };
      }
      if (o.userData.geomDirty) rec.meshes = collectMeshData(o); // pintura/CSG/suavização
      else if (o.userData.relief) rec.relief = o.userData.relief;
      else if (o.userData.extrude) rec.extrude = o.userData.extrude;
      else if (!PRIM_KINDS.has(rec.kind)) rec.meshes = collectMeshData(o);
      return rec;
    }),
  };
}

function collectMeshData(root) {
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();
  const out = [];
  root.traverse(m => {
    if (!m.isMesh || !m.geometry || !m.geometry.attributes.position) return;
    const rel = rootInv.clone().multiply(m.matrixWorld);
    const g = m.geometry;
    const pos = bakePositions(g.attributes.position, rel);
    const rec = { pos: f32ToB64(pos) };
    if (g.attributes.normal) {
      const nrm = bakeNormals(g.attributes.normal, rel);
      rec.norm = f32ToB64(nrm);
    }
    if (g.attributes.color) {
      rec.col = f32ToB64(new Float32Array(g.attributes.color.array));
    }
    if (g.index) rec.idx = u32ToB64(new Uint32Array(g.index.array));
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    if (mat && mat.color) rec.color = '#' + mat.color.getHexString();
    out.push(rec);
  });
  return out;
}

function bakePositions(attr, matrix) {
  const arr = new Float32Array(attr.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < attr.count; i++) {
    v.fromBufferAttribute(attr, i).applyMatrix4(matrix);
    arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
  }
  return arr;
}

function bakeNormals(attr, matrix) {
  const nm = new THREE.Matrix3().getNormalMatrix(matrix);
  const arr = new Float32Array(attr.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < attr.count; i++) {
    v.fromBufferAttribute(attr, i).applyMatrix3(nm).normalize();
    arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
  }
  return arr;
}

export function loadProjectJSON(data) {
  if (!data || data.app !== 'estudio3d' || !Array.isArray(data.objects)) {
    throw new Error('arquivo de projeto inválido');
  }
  const objs = app.objects;
  app.interact.select(null);
  objs.removeAll();
  app.history.clear();

  for (const rec of data.objects) {
    let obj = null;
    const finish = rec.material ? rec.material.finish || 'padrao' : 'padrao';
    const mat = objs.makeMaterial(rec.material ? rec.material.color : '#4fc3f7', finish);
    if (rec.meshes) {
      obj = new THREE.Group();
      let dirty = false;
      for (const md of rec.meshes) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(b64ToF32(md.pos), 3));
        if (md.norm) g.setAttribute('normal', new THREE.BufferAttribute(b64ToF32(md.norm), 3));
        else g.computeVertexNormals();
        if (md.idx) g.setIndex(new THREE.BufferAttribute(b64ToU32(md.idx), 1));
        const mmat = objs.makeMaterial(md.color || '#90a4ae', finish);
        if (md.col) {
          g.setAttribute('color', new THREE.BufferAttribute(b64ToF32(md.col), 3));
          mmat.vertexColors = true;
          mmat.color.set(0xffffff);
          dirty = true;
        }
        obj.add(new THREE.Mesh(g, mmat));
      }
      if (dirty || rec.kind === 'csg') obj.userData.geomDirty = true;
      // grupo com uma única malha vira a própria malha (mais leve de manipular)
      if (obj.children.length === 1) {
        const only = obj.children[0];
        only.userData.geomDirty = obj.userData.geomDirty;
        obj = only;
      }
    } else if (rec.relief) {
      const gray = b64ToGray(rec.relief.gray);
      obj = new THREE.Mesh(buildReliefGeometry(gray, rec.relief.w, rec.relief.h, rec.relief.params), mat);
      obj.userData.relief = rec.relief;
    } else if (rec.extrude) {
      const geo = buildExtrudeGeometry(rec.extrude);
      obj = new THREE.Mesh(geo.geometry, mat);
      obj.userData.extrude = rec.extrude;
    } else if (PRIM_KINDS.has(rec.kind)) {
      obj = new THREE.Mesh(objs.geometryFor(rec.kind), mat);
    }
    if (!obj) continue;
    obj.name = rec.name || 'Objeto';
    obj.userData.kind = rec.kind;
    obj.visible = rec.visible !== false;
    const m = new THREE.Matrix4().fromArray(rec.matrix);
    m.decompose(obj.position, obj.quaternion, obj.scale);
    objs.add(obj, { history: false, select: false });
  }
  app.viewport.frameBox(objs.boundsAll());
  app.emit('objects-changed');
}

export async function saveProject(name) {
  const json = JSON.stringify(serializeProject());
  await saveBlob(sanitize(name || 'projeto') + '.e3d', new Blob([json], { type: 'application/json' }));
}

export async function openProjectFile(file) {
  const text = await file.text();
  loadProjectJSON(JSON.parse(text));
  app.ui.toast(`Projeto aberto: ${baseName(file.name)}`);
}

// ---------- restauração automática ----------

function autosave() {
  try {
    if (!app.objects.list.length) return;
    const json = JSON.stringify(serializeProject());
    if (json.length < 4000000) localStorage.setItem(AUTOSAVE_KEY, json);
  } catch { /* sem espaço: ignora */ }
}

export function tryOfferRestore() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data.objects || !data.objects.length) return;
    app.ui.toast('Há um trabalho não salvo da última sessão', 'Restaurar', () => {
      try { loadProjectJSON(data); } catch (e) { console.error(e); }
    }, 9000);
  } catch { /* ignora */ }
}

// ============================ SALVAR ARQUIVO ============================

export async function saveBlob(name, blob) {
  if (window.EstudioBridge && window.EstudioBridge.saveFile) {
    try {
      const b64 = await blobToB64(blob);
      window.EstudioBridge.saveFile(name, blob.type || 'application/octet-stream', b64);
      // o Android confirma com um toast próprio; aqui oferecemos o envio
      // direto para o app da impressora (Bambu Handy, Creality, etc.)
      app.ui.toast(`Salvo em Downloads: ${name}`, 'Enviar para impressora', () => {
        try { window.EstudioBridge.shareLast(); }
        catch (e) { app.ui.toast('Não consegui abrir o compartilhamento'); }
      }, 8000);
      return;
    } catch (err) {
      console.error('bridge falhou, tentando download', err);
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  app.ui.toast(`Arquivo gerado: ${name}`);
}

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// ============================ utilidades ============================

function nextFrame() { return new Promise(r => requestAnimationFrame(() => setTimeout(r, 16))); }
function baseName(n) { return n.replace(/\.[^.]+$/, ''); }
function sanitize(n) { return n.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'modelo'; }
function escXml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}
function n3(v) { return String(Math.round(v * 1000) / 1000); }

function bufToB64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
  }
  return btoa(bin);
}
function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function f32ToB64(arr) { return bufToB64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)); }
function u32ToB64(arr) { return bufToB64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)); }
function b64ToF32(b64) { const b = b64ToBuf(b64); return new Float32Array(b.buffer, 0, b.byteLength / 4); }
function b64ToU32(b64) { const b = b64ToBuf(b64); return new Uint32Array(b.buffer, 0, b.byteLength / 4); }
