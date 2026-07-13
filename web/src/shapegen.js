import * as THREE from 'three';
import { buildSpecFromPolys, buildExtrudeGeometry } from './sketch.js';

// Gera geometria a partir de bitmaps: texto 3D (desenhado em canvas e
// vetorizado), contorno de imagem extrudado e relevo/litofania regulável.

// ---------- vetorização: bitmap binário -> laços de contorno ----------
// Percorre as arestas entre pixels cheios e vazios mantendo o interior à
// esquerda; furos saem automaticamente com orientação oposta.
export function traceBinary(grid, w, h) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h) ? grid[y * w + x] : 0;
  const key = (x, y) => y * (w + 1) + x;
  const edges = new Map(); // ponto inicial -> [pontos finais]

  const addEdge = (x1, y1, x2, y2) => {
    const k = key(x1, y1);
    let list = edges.get(k);
    if (!list) edges.set(k, list = []);
    list.push(key(x2, y2));
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) addEdge(x + 1, y, x, y);         // topo: direita->esquerda
      if (!at(x, y + 1)) addEdge(x, y + 1, x + 1, y + 1); // base: esquerda->direita
      if (!at(x - 1, y)) addEdge(x, y, x, y + 1);         // esquerda: desce
      if (!at(x + 1, y)) addEdge(x + 1, y + 1, x + 1, y); // direita: sobe
    }
  }

  const loops = [];
  for (const [startKey, targets] of edges) {
    while (targets.length) {
      const loop = [];
      let cur = startKey;
      let next = targets.pop();
      loop.push(cur);
      let guard = 0;
      while (next !== startKey && guard++ < 2000000) {
        loop.push(next);
        const outs = edges.get(next);
        if (!outs || !outs.length) break;
        next = outs.pop();
      }
      if (next === startKey && loop.length >= 4) {
        const pts = loop.map(k => ({ x: k % (w + 1), y: Math.floor(k / (w + 1)) }));
        loops.push(collapseCollinear(pts));
      }
    }
  }
  return loops;
}

function collapseCollinear(pts) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
    if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) !== 0) out.push(b);
  }
  return out.length >= 3 ? out : pts;
}

function rdp(pts, eps) {
  if (pts.length < 4) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    const a = pts[s], b = pts[e];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    for (let i = s + 1; i < e; i++) {
      const p = pts[i];
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) { keep[idx] = true; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// bitmap binário -> geometria extrudada (mm). pxToMM converte pixel em mm.
function binaryToGeometry(grid, w, h, pxToMM, depthMM, smoothEps = 1.2) {
  let loops = traceBinary(grid, w, h);
  loops = loops.map(l => rdp(l, smoothEps)).filter(l => l.length >= 3);
  if (!loops.length) throw new Error('nenhum contorno encontrado');
  // pixels (y para baixo) -> forma (y para cima), centrado
  const polys = loops.map(l => l.map(p => ({
    x: (p.x - w / 2) * pxToMM,
    y: (h / 2 - p.y) * pxToMM,
  })));
  const spec = buildSpecFromPolys(polys, depthMM);
  if (!spec) throw new Error('contorno inválido');
  return { geometry: buildExtrudeGeometry(spec).geometry, spec };
}

// ---------- texto 3D ----------
export function textToGeometry(text, { sizeMM = 20, depthMM = 5, bold = true } = {}) {
  const px = 170;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const font = `${bold ? 'bold ' : ''}${px}px sans-serif`;
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const pad = 12;
  canvas.width = Math.ceil(metrics.width) + pad * 2;
  canvas.height = Math.ceil(px * 1.5) + pad * 2;
  const c2 = canvas.getContext('2d', { willReadFrequently: true });
  c2.fillStyle = '#000';
  c2.fillRect(0, 0, canvas.width, canvas.height);
  c2.fillStyle = '#fff';
  c2.font = font;
  c2.textBaseline = 'middle';
  c2.fillText(text, pad, canvas.height / 2);

  const img = c2.getImageData(0, 0, canvas.width, canvas.height);
  const w = canvas.width, h = canvas.height;
  const grid = new Uint8Array(w * h);
  let minY = h, maxY = 0;
  for (let i = 0; i < w * h; i++) {
    if (img.data[i * 4] > 128) {
      grid[i] = 1;
      const y = Math.floor(i / w);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxY <= minY) throw new Error('texto vazio');
  const pxToMM = sizeMM / (maxY - minY + 1); // altura do texto = sizeMM
  return binaryToGeometry(grid, w, h, pxToMM, depthMM, 1.15);
}

// ---------- imagem -> contorno extrudado ----------
export async function imageToContourGeometry(bitmap, { widthMM = 60, depthMM = 6, threshold = 0.55, invert = false } = {}) {
  const { data, w, h } = sampleImage(bitmap, 300);
  const grid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] / 255;
    const lum = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
    let solid = a > 0.4 && lum < threshold;
    if (invert) solid = a > 0.4 && lum >= threshold;
    grid[i] = solid ? 1 : 0;
  }
  return binaryToGeometry(grid, w, h, widthMM / w, depthMM, 1.4);
}

// ---------- imagem -> relevo (litofania) ----------
// Retorna também o mapa de cinza para o relevo poder ser reajustado depois.
export function imageToReliefData(bitmap, maxRes = 180) {
  const { data, w, h } = sampleImage(bitmap, maxRes);
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] / 255;
    const lum = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    gray[i] = Math.round(lum * a);
  }
  return { gray, w, h };
}

export function buildReliefGeometry(gray, w, h, { widthMM = 60, reliefMM = 3, baseMM = 2, invert = false } = {}) {
  const scale = widthMM / w;
  const depthMMz = h * scale;
  const gAt = (x, y) => gray[Math.min(h - 1, y) * w + Math.min(w - 1, x)] / 255;

  const positions = [];
  const cols = w, rows = h;
  // topo: grade (rows x cols)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let v = gAt(x, y);
      if (invert) v = 1 - v;
      positions.push(
        (x - (cols - 1) / 2) * scale,
        baseMM + v * reliefMM,
        (y - (rows - 1) / 2) * scale
      );
    }
  }
  const idx = [];
  const top = (x, y) => y * cols + x;
  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < cols - 1; x++) {
      const a = top(x, y), b = top(x + 1, y), c = top(x + 1, y + 1), d = top(x, y + 1);
      idx.push(a, c, b, a, d, c); // topo visto de cima (+y)
    }
  }
  // base: 4 cantos no y=0
  const baseStart = positions.length / 3;
  const hw = (cols - 1) / 2 * scale, hd = (rows - 1) / 2 * scale;
  positions.push(-hw, 0, -hd, hw, 0, -hd, hw, 0, hd, -hw, 0, hd);
  idx.push(baseStart, baseStart + 1, baseStart + 2, baseStart, baseStart + 2, baseStart + 3);

  // paredes: perímetro do topo ligado à base
  const perim = [];
  for (let x = 0; x < cols; x++) perim.push(top(x, 0));
  for (let y = 1; y < rows; y++) perim.push(top(cols - 1, y));
  for (let x = cols - 2; x >= 0; x--) perim.push(top(x, rows - 1));
  for (let y = rows - 2; y >= 1; y--) perim.push(top(0, y));
  const bottomStart = positions.length / 3;
  for (const pi of perim) {
    positions.push(positions[pi * 3], 0, positions[pi * 3 + 2]);
  }
  const np = perim.length;
  for (let i = 0; i < np; i++) {
    const j = (i + 1) % np;
    const t1 = perim[i], t2 = perim[j];
    const b1 = bottomStart + i, b2 = bottomStart + j;
    idx.push(t1, t2, b2, t1, b2, b1);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------- utilidades ----------
function sampleImage(bitmap, maxDim) {
  const ratio = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(2, Math.round(bitmap.width * ratio));
  const h = Math.max(2, Math.round(bitmap.height * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

export function grayToB64(gray) {
  let bin = '';
  for (let i = 0; i < gray.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, gray.subarray(i, Math.min(i + 0x8000, gray.length)));
  }
  return btoa(bin);
}
export function b64ToGray(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
