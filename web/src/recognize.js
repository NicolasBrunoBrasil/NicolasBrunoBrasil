// "IA" de correção de esboço: reconhece a forma que o usuário quis desenhar
// (círculo, estrela, retângulo, triângulo, polígono regular…) e devolve a
// versão geometricamente perfeita. Puramente local, sem rede.

export function recognizeShape(rawPts) {
  if (!rawPts || rawPts.length < 8) return null;
  const pts = resample(rawPts, 180);
  const c = centroid(pts);
  const radii = pts.map(p => Math.hypot(p.x - c.x, p.y - c.y));
  const rMean = avg(radii);
  if (rMean < 2) return null;
  const rStd = Math.sqrt(avg(radii.map(r => (r - rMean) ** 2)));
  const size = 2 * rMean;

  // 1) círculo: raio quase constante
  if (rStd / rMean < 0.08) {
    return { label: 'círculo', pts: circle(c, rMean, 64) };
  }

  // 2) estrela: picos e vales alternados no perfil radial
  const star = detectStar(pts, c, radii, rMean);
  if (star) return star;

  // 3) formas de cantos retos
  const corners = rdpClosed(pts, 0.05 * size);
  const k = corners.length;

  if (k === 4) {
    const rect = fitRectangle(corners);
    if (rect) return rect;
    return { label: 'quadrilátero', pts: corners.map(p => ({ x: p.x, y: p.y })) };
  }
  if (k === 3) {
    return { label: 'triângulo', pts: corners.map(p => ({ x: p.x, y: p.y })) };
  }
  if (k >= 5 && k <= 9) {
    const cr = corners.map(p => Math.hypot(p.x - c.x, p.y - c.y));
    const crMean = avg(cr);
    const crStd = Math.sqrt(avg(cr.map(r => (r - crMean) ** 2)));
    if (crStd / crMean < 0.13) {
      const rot = Math.atan2(corners[0].y - c.y, corners[0].x - c.x);
      return { label: `polígono de ${k} lados`, pts: regularPolygon(c, crMean, k, rot) };
    }
    if (k <= 8) return { label: 'polígono', pts: corners.map(p => ({ x: p.x, y: p.y })) };
  }
  return null;
}

function detectStar(pts, c, radii, rMean) {
  const n = radii.length;
  // suaviza o perfil radial (circular)
  const sm = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = -3; d <= 3; d++) s += radii[(i + d + n) % n];
    sm[i] = s / 7;
  }
  const peaks = [], valleys = [];
  for (let i = 0; i < n; i++) {
    const prev = sm[(i + n - 1) % n], next = sm[(i + 1) % n];
    if (sm[i] > prev && sm[i] >= next && sm[i] > rMean) peaks.push(i);
    if (sm[i] < prev && sm[i] <= next && sm[i] < rMean) valleys.push(i);
  }
  const merged = (list) => {
    // junta detecções a menos de 12 amostras
    const out = [];
    for (const i of list) {
      if (!out.length || circDist(i, out[out.length - 1], n) > 12) out.push(i);
      else if (sm[i] > sm[out[out.length - 1]]) out[out.length - 1] = i;
    }
    if (out.length > 1 && circDist(out[0], out[out.length - 1], n) <= 12) out.pop();
    return out;
  };
  const P = merged(peaks), V = merged(valleys);
  if (P.length < 4 || P.length > 12) return null;
  if (Math.abs(P.length - V.length) > 1) return null;
  const rOut = avg(P.map(i => sm[i]));
  const rIn = avg(V.map(i => sm[i]));
  if ((rOut - rIn) / rOut < 0.2) return null;

  const nPts = P.length;
  const best = P.reduce((a, b) => (sm[a] >= sm[b] ? a : b));
  const rot = Math.atan2(pts[best].y - c.y, pts[best].x - c.x);
  const out = [];
  for (let i = 0; i < nPts * 2; i++) {
    const ang = rot + (i * Math.PI) / nPts;
    const r = i % 2 === 0 ? rOut : rIn;
    out.push({ x: c.x + Math.cos(ang) * r, y: c.y + Math.sin(ang) * r });
  }
  return { label: `estrela de ${nPts} pontas`, pts: out };
}

function fitRectangle(corners) {
  // ângulos internos próximos de 90°?
  for (let i = 0; i < 4; i++) {
    const a = corners[(i + 3) % 4], b = corners[i], d = corners[(i + 1) % 4];
    const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: d.x - b.x, y: d.y - b.y };
    const dot = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
    if (Math.abs(dot) > 0.42) return null; // > ~65°/ < ~115°
  }
  // orienta pelo lado mais longo
  let bi = 0, bl = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const l = Math.hypot(corners[j].x - corners[i].x, corners[j].y - corners[i].y);
    if (l > bl) { bl = l; bi = i; }
  }
  const th = Math.atan2(corners[(bi + 1) % 4].y - corners[bi].y, corners[(bi + 1) % 4].x - corners[bi].x);
  const cos = Math.cos(-th), sin = Math.sin(-th);
  const loc = corners.map(p => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
  const minX = Math.min(...loc.map(p => p.x)), maxX = Math.max(...loc.map(p => p.x));
  const minY = Math.min(...loc.map(p => p.y)), maxY = Math.max(...loc.map(p => p.y));
  const rect = [
    { x: minX, y: minY }, { x: maxX, y: minY },
    { x: maxX, y: maxY }, { x: minX, y: maxY },
  ];
  const cosB = Math.cos(th), sinB = Math.sin(th);
  const sq = Math.abs((maxX - minX) - (maxY - minY)) < 0.12 * Math.max(maxX - minX, maxY - minY);
  return {
    label: sq ? 'quadrado' : 'retângulo',
    pts: rect.map(p => ({ x: p.x * cosB - p.y * sinB, y: p.x * sinB + p.y * cosB })),
  };
}

// ---------- utilidades ----------
function resample(pts, n) {
  const closed = [...pts, pts[0]];
  const lens = [0];
  for (let i = 1; i < closed.length; i++) {
    lens.push(lens[i - 1] + Math.hypot(closed[i].x - closed[i - 1].x, closed[i].y - closed[i - 1].y));
  }
  const total = lens[lens.length - 1] || 1;
  const out = [];
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const target = (i / n) * total;
    while (seg < lens.length - 2 && lens[seg + 1] < target) seg++;
    const t = (target - lens[seg]) / ((lens[seg + 1] - lens[seg]) || 1);
    out.push({
      x: closed[seg].x + (closed[seg + 1].x - closed[seg].x) * t,
      y: closed[seg].y + (closed[seg + 1].y - closed[seg].y) * t,
    });
  }
  return out;
}

function rdpClosed(pts, eps) {
  // ancora no ponto mais distante do centroide para fechar bem o laço
  const c = centroid(pts);
  let start = 0, best = 0;
  pts.forEach((p, i) => {
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d > best) { best = d; start = i; }
  });
  const rot = [...pts.slice(start), ...pts.slice(0, start)];
  rot.push(rot[0]);
  const keep = new Array(rot.length).fill(false);
  keep[0] = keep[rot.length - 1] = true;
  const stack = [[0, rot.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    const a = rot[s], b = rot[e];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    for (let i = s + 1; i < e; i++) {
      let t = ((rot[i].x - a.x) * dx + (rot[i].y - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(rot[i].x - (a.x + t * dx), rot[i].y - (a.y + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) { keep[idx] = true; stack.push([s, idx], [idx, e]); }
  }
  const out = [];
  for (let i = 0; i < rot.length - 1; i++) if (keep[i]) out.push(rot[i]);
  return out;
}

function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}
function avg(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
function circDist(a, b, n) { const d = Math.abs(a - b); return Math.min(d, n - d); }
function circle(c, r, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push({ x: c.x + Math.cos(t) * r, y: c.y + Math.sin(t) * r });
  }
  return out;
}
function regularPolygon(c, r, k, rot) {
  const out = [];
  for (let i = 0; i < k; i++) {
    const t = rot + (i / k) * Math.PI * 2;
    out.push({ x: c.x + Math.cos(t) * r, y: c.y + Math.sin(t) * r });
  }
  return out;
}
