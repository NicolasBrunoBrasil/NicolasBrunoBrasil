"""Núcleo de modelagem sólida em Python puro (sem dependências externas).

Fornece o mínimo necessário para gerar peças imprimíveis:
  * malhas fechadas por "loft" de seções (retângulos arredondados, círculos);
  * operações booleanas por árvore BSP (união, subtração, interseção);
  * solda de vértices, verificação de manifold e exportação STL/3MF.

Todas as medidas são em milímetros.
"""

import math
import struct

EPS = 1e-7


# --------------------------------------------------------------------------
# vetores
# --------------------------------------------------------------------------

def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def mul(a, k):
    return (a[0] * k, a[1] * k, a[2] * k)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def norm(a):
    return math.sqrt(dot(a, a))


def unit(a):
    n = norm(a)
    return (a[0] / n, a[1] / n, a[2] / n) if n > 0 else (0.0, 0.0, 0.0)


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t)


# --------------------------------------------------------------------------
# malha
# --------------------------------------------------------------------------

class Mesh:
    """Malha triangular fechada. `tris` é uma lista de triplas de pontos."""

    __slots__ = ("tris",)

    def __init__(self, tris=None):
        self.tris = list(tris or [])

    def copy(self):
        return Mesh(list(self.tris))

    def __add__(self, other):
        return Mesh(self.tris + other.tris)

    # -- transformações ----------------------------------------------------

    def map(self, fn):
        return Mesh([(fn(a), fn(b), fn(c)) for a, b, c in self.tris])

    def translate(self, dx=0.0, dy=0.0, dz=0.0):
        return self.map(lambda p: (p[0] + dx, p[1] + dy, p[2] + dz))

    def scale(self, sx=1.0, sy=None, sz=None):
        sy = sx if sy is None else sy
        sz = sx if sz is None else sz
        m = self.map(lambda p: (p[0] * sx, p[1] * sy, p[2] * sz))
        if sx * sy * sz < 0:                      # espelhamento inverte faces
            m.tris = [(c, b, a) for a, b, c in m.tris]
        return m

    def rotate_x(self, deg):
        c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
        return self.map(lambda p: (p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c))

    def rotate_y(self, deg):
        c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
        return self.map(lambda p: (p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c))

    def rotate_z(self, deg):
        c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
        return self.map(lambda p: (p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]))

    # -- medidas -----------------------------------------------------------

    def bounds(self):
        xs = [p[0] for t in self.tris for p in t]
        ys = [p[1] for t in self.tris for p in t]
        zs = [p[2] for t in self.tris for p in t]
        return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))

    def size(self):
        lo, hi = self.bounds()
        return (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])

    def volume(self):
        """Volume assinado (mm³) — positivo quando as normais apontam para fora."""
        v = 0.0
        for a, b, c in self.tris:
            v += dot(a, cross(b, c))
        return v / 6.0

    # -- booleanas ---------------------------------------------------------

    def union(self, other):
        return _csg(self, other, "union")

    def difference(self, other):
        return _csg(self, other, "difference")

    def intersection(self, other):
        return _csg(self, other, "intersection")


# --------------------------------------------------------------------------
# perfis 2D
# --------------------------------------------------------------------------

def rounded_rect(w, h, r, seg=8):
    """Retângulo arredondado centrado na origem, sentido anti-horário.

    Um offset uniforme de `d` para dentro equivale a rounded_rect(w-2d, h-2d, r-d),
    o que permite gerar chanfros e filetes apenas empilhando seções.
    """
    r = max(0.0, min(r, w / 2.0, h / 2.0))
    x, y = w / 2.0 - r, h / 2.0 - r
    if r <= EPS:
        return [(x, y), (-x, y), (-x, -y), (x, -y)]
    pts = []
    for cx, cy, a0 in ((x, y, 0.0), (-x, y, 90.0), (-x, -y, 180.0), (x, -y, 270.0)):
        for i in range(seg + 1):
            a = math.radians(a0 + 90.0 * i / seg)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return _dedup2(pts)


def circle(d, seg=48):
    r = d / 2.0
    return [(r * math.cos(2 * math.pi * i / seg), r * math.sin(2 * math.pi * i / seg))
            for i in range(seg)]


def _dedup2(pts):
    out = []
    for p in pts:
        if not out or abs(p[0] - out[-1][0]) > 1e-9 or abs(p[1] - out[-1][1]) > 1e-9:
            out.append(p)
    if len(out) > 1 and abs(out[0][0] - out[-1][0]) < 1e-9 and abs(out[0][1] - out[-1][1]) < 1e-9:
        out.pop()
    return out


def _area2(poly):
    a = 0.0
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def _ccw(poly):
    return poly if _area2(poly) > 0 else poly[::-1]


# --------------------------------------------------------------------------
# triangulação (ear clipping) — polígonos simples
# --------------------------------------------------------------------------

def triangulate(poly, strict=False):
    poly = _ccw(list(poly))
    n = len(poly)
    if n < 3:
        return []
    idx = list(range(n))
    tris = []
    guard = 0
    while len(idx) > 3 and guard < 4 * n * n:
        guard += 1
        ear = False
        m = len(idx)
        for k in range(m):
            i0, i1, i2 = idx[(k - 1) % m], idx[k], idx[(k + 1) % m]
            a, b, c = poly[i0], poly[i1], poly[i2]
            cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if cr <= 1e-12:
                continue
            # a ponte dos furos duplica vértices: comparar por posição, não por
            # índice, senão nenhuma orelha é aceita e a triangulação degenera.
            blocked = False
            for j in idx:
                if j in (i0, i1, i2):
                    continue
                p = poly[j]
                if (_same2(p, a) or _same2(p, b) or _same2(p, c)):
                    continue
                if _in_tri(p, a, b, c):
                    blocked = True
                    break
            if blocked:
                continue
            tris.append((i0, i1, i2))
            idx.pop(k)
            ear = True
            break
        if not ear:
            if strict:
                return None
            for k in range(1, len(idx) - 1):       # último recurso: leque
                tris.append((idx[0], idx[k], idx[k + 1]))
            idx = []
            break
    if len(idx) == 3:
        tris.append((idx[0], idx[1], idx[2]))
    elif len(idx) > 3:
        if strict:
            return None
        for k in range(1, len(idx) - 1):
            tris.append((idx[0], idx[k], idx[k + 1]))
    return [(poly[a], poly[b], poly[c]) for a, b, c in tris]


def _in_tri(p, a, b, c):
    d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1])
    d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1])
    d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1])
    neg = (d1 < -1e-12) or (d2 < -1e-12) or (d3 < -1e-12)
    pos = (d1 > 1e-12) or (d2 > 1e-12) or (d3 > 1e-12)
    return not (neg and pos)


# --------------------------------------------------------------------------
# construção de sólidos
# --------------------------------------------------------------------------

def loft(sections):
    """Sólido fechado a partir de seções (z, polígono) com o mesmo nº de pontos.

    As seções vão de baixo para cima; polígonos em sentido anti-horário.
    """
    secs = [(z, _ccw(list(p))) for z, p in sections]
    n = len(secs[0][1])
    for _, p in secs:
        if len(p) != n:
            raise ValueError("todas as seções precisam do mesmo nº de pontos")
    tris = []
    # tampa inferior (normal -Z)
    z0, p0 = secs[0]
    for a, b, c in triangulate(p0):
        tris.append(((a[0], a[1], z0), (c[0], c[1], z0), (b[0], b[1], z0)))
    # tampa superior (normal +Z)
    z1, p1 = secs[-1]
    for a, b, c in triangulate(p1):
        tris.append(((a[0], a[1], z1), (b[0], b[1], z1), (c[0], c[1], z1)))
    # paredes
    for s in range(len(secs) - 1):
        za, pa = secs[s]
        zb, pb = secs[s + 1]
        for i in range(n):
            j = (i + 1) % n
            a = (pa[i][0], pa[i][1], za)
            b = (pa[j][0], pa[j][1], za)
            c = (pb[j][0], pb[j][1], zb)
            d = (pb[i][0], pb[i][1], zb)
            tris.append((a, b, c))
            tris.append((a, c, d))
    m = Mesh(tris)
    _drop_degenerate(m)
    return m


def prism(poly, h, z=0.0):
    return loft([(z, poly), (z + h, poly)])


def box(w, d, h, center=False):
    m = prism(rounded_rect(w, d, 0.0), h)
    return m.translate(0, 0, -h / 2.0) if center else m


def rbox(w, d, h, r=2.0, fillet=0.0, fillet_top=None, fillet_bottom=None, seg=8, fseg=4):
    """Caixa com cantos verticais de raio `r` e filete horizontal em topo/base."""
    ft = fillet if fillet_top is None else fillet_top
    fb = fillet if fillet_bottom is None else fillet_bottom
    ft = min(ft, h / 2.0, r if r > 0 else ft, w / 2.0, d / 2.0)
    fb = min(fb, h / 2.0, r if r > 0 else fb, w / 2.0, d / 2.0)
    secs = []
    if fb > EPS:
        for i in range(fseg + 1):
            a = math.radians(90.0 * i / fseg)
            off = fb * (1 - math.sin(a))
            secs.append((fb * (1 - math.cos(a)),
                         rounded_rect(w - 2 * off, d - 2 * off, r - off, seg)))
    else:
        secs.append((0.0, rounded_rect(w, d, r, seg)))
    if ft > EPS:
        for i in range(fseg + 1):
            a = math.radians(90.0 * i / fseg)
            off = ft * (1 - math.cos(a))
            secs.append((h - ft + ft * math.sin(a),
                         rounded_rect(w - 2 * off, d - 2 * off, r - off, seg)))
    else:
        secs.append((h, rounded_rect(w, d, r, seg)))
    # remove seções com z repetido
    clean = []
    for z, p in secs:
        if clean and abs(z - clean[-1][0]) < 1e-9:
            continue
        clean.append((z, p))
    return loft(clean)


def cyl(d, h, seg=48, d2=None):
    p = circle(d, seg)
    if d2 is None or abs(d2 - d) < EPS:
        return prism(p, h)
    return loft([(0.0, p), (h, circle(d2, seg))])


def _drop_degenerate(mesh):
    out = []
    for t in mesh.tris:
        n = cross(sub(t[1], t[0]), sub(t[2], t[0]))
        if norm(n) > 1e-12:
            out.append(t)
    mesh.tris = out


# --------------------------------------------------------------------------
# CSG por árvore BSP
# --------------------------------------------------------------------------

class _Poly:
    __slots__ = ("v", "n", "w")

    def __init__(self, v, n=None, w=None):
        self.v = v
        if n is None:
            n = unit(cross(sub(v[1], v[0]), sub(v[2], v[0])))
            w = dot(n, v[0])
        self.n = n
        self.w = w

    def flip(self):
        return _Poly(self.v[::-1], mul(self.n, -1), -self.w)


_PEPS = 1e-6


def _split(pl, poly, cf, cb, front, back):
    types = []
    kind = 0
    for p in poly.v:
        t = dot(pl.n, p) - pl.w
        k = 2 if t < -_PEPS else (1 if t > _PEPS else 0)
        kind |= k
        types.append(k)
    if kind == 0:
        (cf if dot(pl.n, poly.n) > 0 else cb).append(poly)
    elif kind == 1:
        front.append(poly)
    elif kind == 2:
        back.append(poly)
    else:
        f, b = [], []
        m = len(poly.v)
        for i in range(m):
            j = (i + 1) % m
            ti, tj = types[i], types[j]
            vi, vj = poly.v[i], poly.v[j]
            if ti != 2:
                f.append(vi)
            if ti != 1:
                b.append(vi)
            if (ti | tj) == 3:
                den = dot(pl.n, sub(vj, vi))
                t = (pl.w - dot(pl.n, vi)) / den if abs(den) > 1e-15 else 0.0
                v = lerp(vi, vj, t)
                f.append(v)
                b.append(v)
        if len(f) >= 3:
            front.append(_Poly(f, poly.n, poly.w))
        if len(b) >= 3:
            back.append(_Poly(b, poly.n, poly.w))


class _Node:
    __slots__ = ("plane", "front", "back", "polys")

    def __init__(self, polys=None):
        self.plane = None
        self.front = None
        self.back = None
        self.polys = []
        if polys:
            self.build(polys)

    def build(self, polys):
        stack = [(self, polys)]
        while stack:
            node, ps = stack.pop()
            if not ps:
                continue
            if node.plane is None:
                node.plane = ps[len(ps) // 2]
            f, b = [], []
            for p in ps:
                _split(node.plane, p, node.polys, node.polys, f, b)
            if f:
                if node.front is None:
                    node.front = _Node()
                stack.append((node.front, f))
            if b:
                if node.back is None:
                    node.back = _Node()
                stack.append((node.back, b))

    def invert(self):
        stack = [self]
        while stack:
            n = stack.pop()
            n.polys = [p.flip() for p in n.polys]
            if n.plane is not None:
                n.plane = n.plane.flip()
            n.front, n.back = n.back, n.front
            if n.front:
                stack.append(n.front)
            if n.back:
                stack.append(n.back)

    def clip_polys(self, polys):
        out = []
        stack = [(self, polys)]
        while stack:
            node, ps = stack.pop()
            if node.plane is None:
                out.extend(ps)
                continue
            f, b = [], []
            for p in ps:
                _split(node.plane, p, f, b, f, b)
            if node.front:
                stack.append((node.front, f))
            else:
                out.extend(f)
            if node.back:
                stack.append((node.back, b))
        return out

    def clip_to(self, other):
        stack = [self]
        while stack:
            n = stack.pop()
            n.polys = other.clip_polys(n.polys)
            if n.front:
                stack.append(n.front)
            if n.back:
                stack.append(n.back)

    def all_polys(self):
        out = []
        stack = [self]
        while stack:
            n = stack.pop()
            out.extend(n.polys)
            if n.front:
                stack.append(n.front)
            if n.back:
                stack.append(n.back)
        return out


def _to_polys(mesh):
    out = []
    for t in mesh.tris:
        n = cross(sub(t[1], t[0]), sub(t[2], t[0]))
        if norm(n) < 1e-12:
            continue
        n = unit(n)
        out.append(_Poly(list(t), n, dot(n, t[0])))
    return out


def _to_mesh(polys):
    tris = []
    for p in polys:
        for i in range(2, len(p.v)):
            tris.append((p.v[0], p.v[i - 1], p.v[i]))
    m = Mesh(tris)
    _drop_degenerate(m)
    return m


def _csg(ma, mb, op):
    a = _Node(_to_polys(ma))
    b = _Node(_to_polys(mb))
    if op == "union":
        a.clip_to(b)
        b.clip_to(a)
        b.invert()
        b.clip_to(a)
        b.invert()
        a.build(b.all_polys())
    elif op == "difference":
        a.invert()
        a.clip_to(b)
        b.clip_to(a)
        b.invert()
        b.clip_to(a)
        b.invert()
        a.build(b.all_polys())
        a.invert()
    elif op == "intersection":
        a.invert()
        b.clip_to(a)
        b.invert()
        a.clip_to(b)
        b.clip_to(a)
        a.build(b.all_polys())
        a.invert()
    else:
        raise ValueError(op)
    return _to_mesh(a.all_polys())


# --------------------------------------------------------------------------
# limpeza e verificação
# --------------------------------------------------------------------------

def weld(mesh, grid=1e-5):
    """Solda vértices coincidentes e devolve (vértices, faces)."""
    lut = {}
    verts = []
    faces = []
    for t in mesh.tris:
        idx = []
        for p in t:
            key = (round(p[0] / grid), round(p[1] / grid), round(p[2] / grid))
            i = lut.get(key)
            if i is None:
                i = len(verts)
                lut[key] = i
                verts.append((key[0] * grid, key[1] * grid, key[2] * grid))
            idx.append(i)
        if idx[0] == idx[1] or idx[1] == idx[2] or idx[0] == idx[2]:
            continue
        faces.append(tuple(idx))
    # remove faces duplicadas exatas
    seen = set()
    uniq = []
    for f in faces:
        key = tuple(sorted(f))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(f)
    return verts, uniq


def check(mesh, name=""):
    """Relatório de sanidade: manifold, orientação e volume."""
    verts, faces = weld(mesh)
    edges = {}
    for f in faces:
        for i in range(3):
            a, b = f[i], f[(i + 1) % 3]
            edges[(a, b)] = edges.get((a, b), 0) + 1
    bad_dir = sum(1 for e, c in edges.items() if c > 1)
    open_edges = sum(1 for (a, b) in edges if (b, a) not in edges)
    vol = mesh.volume() / 1000.0
    return {
        "nome": name,
        "vertices": len(verts),
        "faces": len(faces),
        "arestas_abertas": open_edges,
        "arestas_repetidas": bad_dir,
        "volume_cm3": round(vol, 2),
        "ok": open_edges == 0 and bad_dir == 0 and vol > 0,
    }


# --------------------------------------------------------------------------
# exportação
# --------------------------------------------------------------------------

def save_stl(mesh, path):
    tris = mesh.tris
    with open(path, "wb") as fh:
        fh.write(b"Korx 3D - suporte de parede parametrico".ljust(80, b"\0"))
        fh.write(struct.pack("<I", len(tris)))
        for a, b, c in tris:
            n = unit(cross(sub(b, a), sub(c, a)))
            fh.write(struct.pack("<12fH", n[0], n[1], n[2],
                                 a[0], a[1], a[2], b[0], b[1], b[2],
                                 c[0], c[1], c[2], 0))
    return path


# --------------------------------------------------------------------------
# reparo de T-junctions (vértices no meio de arestas vizinhas)
# --------------------------------------------------------------------------

def _grid_index(verts, cell):
    g = {}
    for i, p in enumerate(verts):
        key = (int(math.floor(p[0] / cell)), int(math.floor(p[1] / cell)),
               int(math.floor(p[2] / cell)))
        g.setdefault(key, []).append(i)
    return g


def _candidates(g, cell, a, b):
    """Vértices perto do segmento a-b: caminha pelas células ao longo da
    aresta em vez de varrer a caixa inteira (arestas longas ficam baratas)."""
    out = set()
    d = sub(b, a)
    steps = max(1, int(norm(d) / (cell * 0.5)) + 1)
    seen = set()
    for s in range(steps + 1):
        p = lerp(a, b, s / steps)
        base = (int(math.floor(p[0] / cell)), int(math.floor(p[1] / cell)),
                int(math.floor(p[2] / cell)))
        if base in seen:
            continue
        seen.add(base)
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                for k in (-1, 0, 1):
                    out.update(g.get((base[0] + i, base[1] + j, base[2] + k), ()))
    return out


def _open_edges(faces):
    used = {}
    for f in faces:
        for k in range(3):
            used[(f[k], f[(k + 1) % 3])] = 1
    return {e for e in used if (e[1], e[0]) not in used}


def _fan(verts, loop, corners):
    """Re-triangula um triângulo que ganhou vértices no meio das arestas.

    O leque precisa sair de um canto que não esteja sobre a aresta dividida,
    senão os triângulos saem degenerados e a aresta longa continua lá.
    """
    n = len(loop)
    for c in corners:
        out = []
        ok = True
        for k in range(1, n - 1):
            tri = (loop[c], loop[(c + k) % n], loop[(c + k + 1) % n])
            a, b, d = verts[tri[0]], verts[tri[1]], verts[tri[2]]
            cr = cross(sub(b, a), sub(d, a))
            if dot(cr, cr) <= 1e-16:
                ok = False
                break
            out.append(tri)
        if ok:
            return out
    return [(loop[0], loop[k], loop[k + 1]) for k in range(1, n - 1)]


def heal(mesh, tol=2e-4, rounds=8):
    """Insere os vértices que caem sobre arestas alheias, fechando a malha.

    Só as arestas sem par (e os vértices que participam delas) são analisadas,
    que é onde as T-junctions da árvore BSP aparecem.
    """
    verts, faces = weld(mesh)
    cell = 3.0
    for _ in range(rounds):
        opened = _open_edges(faces)
        if not opened:
            break
        g = _grid_index(verts, cell)
        new_faces = []
        changed = False
        for f in faces:
            if not any((f[k], f[(k + 1) % 3]) in opened for k in range(3)):
                new_faces.append(f)
                continue
            loop = []
            corners = []
            for k in range(3):
                a_i, b_i = f[k], f[(k + 1) % 3]
                corners.append(len(loop))
                loop.append(a_i)
                if (a_i, b_i) not in opened:
                    continue
                a, b = verts[a_i], verts[b_i]
                ab = sub(b, a)
                L2 = dot(ab, ab)
                if L2 < 1e-12:
                    continue
                hits = []
                for c_i in _candidates(g, cell, a, b):
                    if c_i == a_i or c_i == b_i:
                        continue
                    c = verts[c_i]
                    t = dot(sub(c, a), ab) / L2
                    if t <= 1e-6 or t >= 1 - 1e-6:
                        continue
                    d = sub(c, lerp(a, b, t))
                    if dot(d, d) <= tol * tol:
                        hits.append((t, c_i))
                if hits:
                    hits.sort()
                    loop.extend(i for _, i in hits)
                    changed = True
            if len(loop) == 3:
                new_faces.append(tuple(loop))
            else:
                new_faces.extend(_fan(verts, loop, corners))
        faces = new_faces
        if not changed:
            break
    out = Mesh([(verts[a], verts[b], verts[c]) for a, b, c in faces])
    _drop_degenerate(out)
    return out


# --------------------------------------------------------------------------
# regiões com furos: triangulação por "ponte" (keyhole) e extrusão
# --------------------------------------------------------------------------

def _cw(poly):
    return poly if _area2(poly) < 0 else poly[::-1]


def _bridge(hole, outer):
    """Ponte do furo para o contorno: raio +X a partir do ponto mais à direita
    do furo até o primeiro cruzamento. Devolve (i_furo, i_aresta, ponto) — o
    ponto é inserido na aresta atingida, o que é sempre visível e mantém o
    polígono simples."""
    hi = max(range(len(hole)), key=lambda i: hole[i][0])
    m = hole[hi]
    best = None
    n = len(outer)
    for i in range(n):
        a, b = outer[i], outer[(i + 1) % n]
        if (a[1] > m[1]) == (b[1] > m[1]):
            continue
        t = (m[1] - a[1]) / (b[1] - a[1])
        x = a[0] + t * (b[0] - a[0])
        if x >= m[0] - 1e-9 and (best is None or x < best[0]):
            best = (x, i)
    if best is None:                       # não deveria ocorrer em região válida
        return hi, max(range(n), key=lambda i: outer[i][0]), None
    x, i = best
    p = (x, m[1])
    for k in (i, (i + 1) % n):             # já existe um vértice ali?
        if _same2(outer[k], p, 1e-7):
            return hi, k, None
    return hi, i, p


def triangulate_region(outer, holes=()):
    """Triangula um contorno externo (CCW) com furos (CW), usando só os
    vértices dados — o resultado casa exatamente com as paredes da extrusão."""
    base = list(_ccw(list(outer)))
    hs = sorted((list(_cw(list(h))) for h in holes),
                key=lambda h: -max(p[0] for p in h))
    last = None
    for attempt in range(len(hs) + 1):
        order = hs[attempt:] + hs[:attempt]        # gira a ordem das pontes
        poly = list(base)
        for h in order:
            hi, oi, p = _bridge(h, poly)
            chain = h[hi:] + h[:hi] + [h[hi]]
            if p is None:
                poly = poly[:oi + 1] + chain + poly[oi:]
            else:
                poly = poly[:oi + 1] + [p] + chain + [p] + poly[oi + 1:]
        got = triangulate(poly, strict=True)
        if got is not None:
            return got
        last = poly
    return triangulate(last)


def extrude_region(sections):
    """Sólido fechado a partir de seções `(z, contorno, [furos])`.

    Cada furo pode ser `None` numa seção: ali ele simplesmente não existe, o que
    permite bolsos cegos e canais em T (rasgo largo por dentro, estreito na
    boca) sem nenhuma operação booleana. Quando presente em duas seções
    vizinhas, o furo precisa ter o mesmo nº de pontos nas duas.
    """
    secs = []
    for z, outer, holes in sections:
        secs.append((z, _ccw(list(outer)),
                     [None if h is None else _cw(list(h)) for h in holes]))
    nh = len(secs[0][2])
    for _, _, hs in secs:
        if len(hs) != nh:
            raise ValueError("todas as seções precisam da mesma lista de furos")
    tris = []

    def face(z, outer, holes, up):
        for a, b, c in triangulate_region(outer, [h for h in holes if h]):
            t = ((a[0], a[1], z), (b[0], b[1], z), (c[0], c[1], z))
            tris.append(t if up else (t[0], t[2], t[1]))

    face(secs[0][0], secs[0][1], secs[0][2], False)          # tampa de baixo
    face(secs[-1][0], secs[-1][1], secs[-1][2], True)        # tampa de cima

    def wall(za, pa, zb, pb):
        n = len(pa)
        if len(pb) != n:
            raise ValueError("seções vizinhas com nº de pontos diferente")
        for i in range(n):
            j = (i + 1) % n
            a = (pa[i][0], pa[i][1], za)
            b = (pa[j][0], pa[j][1], za)
            c = (pb[j][0], pb[j][1], zb)
            d = (pb[i][0], pb[i][1], zb)
            tris.append((a, b, c))
            tris.append((a, c, d))

    for s in range(len(secs) - 1):
        za, oa, ha = secs[s]
        zb, ob, hb = secs[s + 1]
        wall(za, oa, zb, ob)
        for k in range(nh):
            lo, hi = ha[k], hb[k]
            if lo and hi:
                wall(za, lo, zb, hi)
            elif lo:                     # o furo termina: teto do bolso (-Z)
                for a, b, c in triangulate(lo):
                    tris.append(((a[0], a[1], zb), (c[0], c[1], zb), (b[0], b[1], zb)))
            elif hi:                     # o furo começa: fundo do bolso (+Z)
                for a, b, c in triangulate(hi):
                    tris.append(((a[0], a[1], za), (b[0], b[1], za), (c[0], c[1], za)))
    m = Mesh(tris)
    _drop_degenerate(m)
    return m


def _same2(p, q, tol=1e-9):
    return abs(p[0] - q[0]) < tol and abs(p[1] - q[1]) < tol


def _xml_escape(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;"))


def save_3mf(parts, path, title="modelo", designer=""):
    """Grava um 3MF com várias peças posicionadas na mesa.

    `parts` é uma lista de (nome, malha, (tx, ty, tz)).
    """
    import zipfile

    objs, items = [], []
    for i, (name, mesh, pos) in enumerate(parts, start=1):
        verts, faces = weld(mesh)
        v = "".join('<vertex x="%.5f" y="%.5f" z="%.5f"/>' % p for p in verts)
        t = "".join('<triangle v1="%d" v2="%d" v3="%d"/>' % f for f in faces)
        objs.append(
            '<object id="%d" type="model" name="%s"><mesh>'
            '<vertices>%s</vertices><triangles>%s</triangles>'
            '</mesh></object>' % (i, _xml_escape(name), v, t))
        items.append('<item objectid="%d" transform="1 0 0 0 1 0 0 0 1 %.4f %.4f %.4f"/>'
                     % (i, pos[0], pos[1], pos[2]))

    model = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<model unit="millimeter" xml:lang="en-US" '
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'
        '<metadata name="Title">%s</metadata>\n'
        '<metadata name="Designer">%s</metadata>\n'
        '<metadata name="Application">Korx 3D</metadata>\n'
        '<resources>%s</resources>\n<build>%s</build>\n</model>\n'
        % (_xml_escape(title), _xml_escape(designer), "".join(objs), "".join(items)))

    ctypes = ('<?xml version="1.0" encoding="UTF-8"?>\n'
              '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
              '<Default Extension="rels" ContentType="application/vnd.openxmlformats-'
              'package.relationships+xml"/>'
              '<Default Extension="model" ContentType="application/vnd.ms-package.'
              '3dmanufacturing-3dmodel+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
            'relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" '
            'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
            '</Relationships>')

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ctypes)
        z.writestr("_rels/.rels", rels)
        z.writestr("3D/3dmodel.model", model)
    return path
