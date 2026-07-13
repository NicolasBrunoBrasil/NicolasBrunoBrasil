#!/usr/bin/env python3
"""Gera o logo do Korx 3D em alta resolução, sem dependências externas.

Cubo isométrico futurista com arestas neon (ciano) e nervuras internas em
laranja, brilho radial, nós luminosos nos vértices e o texto "KORX 3D"
(KORX em azul-claro, 3D em laranja) em letras geométricas angulares.
Renderiza em 1024px com anti-aliasing por reamostragem e exporta todos os
tamanhos de ícone (PWA + mipmaps Android).
"""
import math
import os
import struct
import zlib

SIZE = 1024
CX, CY, R = 512.0, 356.0, 232.0
COS30 = math.cos(math.pi / 6)

# ---------------- geometria do cubo ----------------
def cube_points():
    t = (CX, CY - R)
    ur = (CX + R * COS30, CY - R * 0.5)
    lr = (CX + R * COS30, CY + R * 0.5)
    bo = (CX, CY + R)
    ll = (CX - R * COS30, CY + R * 0.5)
    ul = (CX - R * COS30, CY - R * 0.5)
    c = (CX, CY)
    return t, ur, lr, bo, ll, ul, c

T, UR, LR, BO, LL, UL, C = cube_points()
FACE_TOP = [T, UR, C, UL]
FACE_LEFT = [UL, C, BO, LL]
FACE_RIGHT = [UR, C, BO, LR]

EDGES_CYAN = [  # contorno externo
    (T, UR), (UR, LR), (LR, BO), (BO, LL), (LL, UL), (UL, T),
]
EDGES_ORANGE = [  # nervuras internas até o vértice central
    (T, C), (UR, C), (UL, C), (C, BO),
]
NODES = [T, UR, LR, BO, LL, UL, C]

# ---------------- letras geométricas ----------------
# glifos em caixa unitária (y para baixo): lista de segmentos (x1,y1,x2,y2)
GLYPHS = {
    'K': [(0.10, 0.0, 0.10, 1.0), (0.13, 0.56, 0.88, 0.0), (0.40, 0.44, 0.92, 1.0)],
    'O': [(0.30, 0.05, 0.70, 0.05), (0.70, 0.05, 0.90, 0.32), (0.90, 0.32, 0.90, 0.68),
          (0.90, 0.68, 0.70, 0.95), (0.70, 0.95, 0.30, 0.95), (0.30, 0.95, 0.10, 0.68),
          (0.10, 0.68, 0.10, 0.32), (0.10, 0.32, 0.30, 0.05)],
    'R': [(0.10, 0.0, 0.10, 1.0), (0.10, 0.05, 0.70, 0.05), (0.70, 0.05, 0.88, 0.20),
          (0.88, 0.20, 0.88, 0.36), (0.88, 0.36, 0.70, 0.50), (0.70, 0.50, 0.10, 0.50),
          (0.52, 0.50, 0.92, 1.0)],
    'X': [(0.08, 0.0, 0.92, 1.0), (0.92, 0.0, 0.08, 1.0)],
    '3': [(0.10, 0.05, 0.84, 0.05), (0.88, 0.10, 0.88, 0.42), (0.42, 0.48, 0.88, 0.48),
          (0.88, 0.54, 0.88, 0.90), (0.10, 0.95, 0.84, 0.95)],
    'D': [(0.10, 0.0, 0.10, 1.0), (0.10, 0.05, 0.62, 0.05), (0.62, 0.05, 0.90, 0.32),
          (0.90, 0.32, 0.90, 0.68), (0.90, 0.68, 0.62, 0.95), (0.62, 0.95, 0.10, 0.95)],
}

TEXT_Y0, TEXT_H = 700.0, 128.0
LETTERS = []  # (glyph, x0, width, color_top, color_bottom)
CYAN_T, CYAN_B = (150, 226, 255), (47, 167, 224)
ORAN_T, ORAN_B = (255, 176, 108), (255, 118, 34)

def layout_text():
    widths = {'K': 96, 'O': 104, 'R': 98, 'X': 96, '3': 92, 'D': 104}
    gap, space = 24, 44
    seq = [('K', 'c'), ('O', 'c'), ('R', 'c'), ('X', 'c'), (' ', None), ('3', 'o'), ('D', 'o')]
    total = sum(space if g == ' ' else widths[g] for g, _ in seq) + gap * (len([s for s in seq if s[0] != ' ']) - 2)
    x = (SIZE - total) / 2
    for g, col in seq:
        if g == ' ':
            x += space
            continue
        ct, cb = (CYAN_T, CYAN_B) if col == 'c' else (ORAN_T, ORAN_B)
        LETTERS.append((g, x, widths[g], ct, cb))
        x += widths[g] + gap

layout_text()

# ---------------- utilidades ----------------
def seg_dist(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    l2 = dx * dx + dy * dy
    if l2 == 0:
        return math.hypot(px - x1, py - y1)
    t = ((px - x1) * dx + (py - y1) * dy) / l2
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))

def point_in_poly(x, y, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        ax, ay = poly[i]
        bx, by = poly[j]
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            inside = not inside
        j = i
    return inside

# ---------------- render ----------------
def render():
    n = SIZE * SIZE
    buf = [0.0] * (n * 3)

    # fundo: gradiente vertical + brilho radial ciano + vinheta
    for y in range(SIZE):
        ty = y / SIZE
        br = 10 + 8 * ty
        bg = 14 + 13 * ty
        bb = 21 + 20 * ty
        row = y * SIZE
        for x in range(SIZE):
            dx, dy = x - CX, y - CY - 20
            d = math.hypot(dx, dy)
            glow = math.exp(-d / 300.0) * 0.9
            vin = 1.0 - 0.35 * max(0.0, (math.hypot(x - 512, y - 512) - 380) / 380)
            i = (row + x) * 3
            buf[i] = (br + 18 * glow) * vin
            buf[i + 1] = (bg + 42 * glow) * vin
            buf[i + 2] = (bb + 64 * glow) * vin

    # faces do cubo com gradiente
    faces = [
        (FACE_TOP, (188, 240, 255), (116, 208, 248)),
        (FACE_LEFT, (44, 148, 210), (16, 88, 148)),
        (FACE_RIGHT, (16, 84, 132), (8, 44, 78)),
    ]
    min_x = int(CX - R * COS30) - 2
    max_x = int(CX + R * COS30) + 3
    min_y = int(CY - R) - 2
    max_y = int(CY + R) + 3
    for poly, c_top, c_bot in faces:
        ys = [p[1] for p in poly]
        y0, y1 = max(min_y, int(min(ys)) - 1), min(max_y, int(max(ys)) + 2)
        xs = [p[0] for p in poly]
        x0, x1 = max(min_x, int(min(xs)) - 1), min(max_x, int(max(xs)) + 2)
        span = max(1.0, max(ys) - min(ys))
        for y in range(y0, y1):
            t = (y - min(ys)) / span
            cr = c_top[0] + (c_bot[0] - c_top[0]) * t
            cg = c_top[1] + (c_bot[1] - c_top[1]) * t
            cb = c_top[2] + (c_bot[2] - c_top[2]) * t
            row = y * SIZE
            for x in range(x0, x1):
                if point_in_poly(x + 0.5, y + 0.5, poly):
                    i = (row + x) * 3
                    buf[i] = cr
                    buf[i + 1] = cg
                    buf[i + 2] = cb

    # arestas neon com halo
    def neon(segs, color, core_w, glow_w, glow_gain):
        for (x1, y1), (x2, y2) in segs:
            bx0 = int(min(x1, x2) - glow_w) ; bx1 = int(max(x1, x2) + glow_w) + 1
            by0 = int(min(y1, y2) - glow_w) ; by1 = int(max(y1, y2) + glow_w) + 1
            for y in range(max(0, by0), min(SIZE, by1)):
                row = y * SIZE
                for x in range(max(0, bx0), min(SIZE, bx1)):
                    d = seg_dist(x + 0.5, y + 0.5, x1, y1, x2, y2)
                    if d > glow_w:
                        continue
                    i = (row + x) * 3
                    if d <= core_w:
                        a = 1.0
                        buf[i] = buf[i] * (1 - a) + (200 + color[0] * 0.25) * a
                        buf[i + 1] = buf[i + 1] * (1 - a) + (200 + color[1] * 0.25) * a
                        buf[i + 2] = buf[i + 2] * (1 - a) + (200 + color[2] * 0.25) * a
                    else:
                        g = math.exp(-(d - core_w) / (glow_w * 0.24)) * glow_gain
                        buf[i] = min(255.0, buf[i] + color[0] * g)
                        buf[i + 1] = min(255.0, buf[i + 1] + color[1] * g)
                        buf[i + 2] = min(255.0, buf[i + 2] + color[2] * g)

    neon(EDGES_ORANGE, (255, 130, 50), 3.2, 20.0, 0.55)
    neon(EDGES_CYAN, (110, 225, 255), 4.2, 26.0, 0.7)

    # nós luminosos nos vértices
    for (nx, ny) in NODES:
        rr = 26
        for y in range(int(ny - rr), int(ny + rr) + 1):
            row = y * SIZE
            for x in range(int(nx - rr), int(nx + rr) + 1):
                d = math.hypot(x + 0.5 - nx, y + 0.5 - ny)
                if d > rr:
                    continue
                i = (row + x) * 3
                if d <= 6.5:
                    buf[i] = buf[i + 1] = buf[i + 2] = 255.0
                else:
                    g = math.exp(-(d - 6.5) / 7.0) * 0.8
                    buf[i] = min(255.0, buf[i] + 130 * g)
                    buf[i + 1] = min(255.0, buf[i + 1] + 210 * g)
                    buf[i + 2] = min(255.0, buf[i + 2] + 255 * g)

    # texto KORX 3D
    lw = 15.0  # meia-largura do traço
    glow_w = 30.0
    for glyph, gx, gw, c_top, c_bot in LETTERS:
        segs = [(gx + s[0] * gw, TEXT_Y0 + s[1] * TEXT_H,
                 gx + s[2] * gw, TEXT_Y0 + s[3] * TEXT_H) for s in GLYPHS[glyph]]
        bx0 = int(gx - glow_w); bx1 = int(gx + gw + glow_w) + 1
        by0 = int(TEXT_Y0 - glow_w); by1 = int(TEXT_Y0 + TEXT_H + glow_w) + 1
        for y in range(max(0, by0), min(SIZE, by1)):
            t = min(1.0, max(0.0, (y - TEXT_Y0) / TEXT_H))
            cr = c_top[0] + (c_bot[0] - c_top[0]) * t
            cg = c_top[1] + (c_bot[1] - c_top[1]) * t
            cb = c_top[2] + (c_bot[2] - c_top[2]) * t
            row = y * SIZE
            for x in range(max(0, bx0), min(SIZE, bx1)):
                d = min(seg_dist(x + 0.5, y + 0.5, *s) for s in segs)
                if d > glow_w:
                    continue
                i = (row + x) * 3
                if d <= lw:
                    # borda suave (anti-alias no limite do traço)
                    a = 1.0 if d < lw - 1.5 else (lw - d) / 1.5
                    a = max(0.0, min(1.0, a))
                    buf[i] = buf[i] * (1 - a) + cr * a
                    buf[i + 1] = buf[i + 1] * (1 - a) + cg * a
                    buf[i + 2] = buf[i + 2] * (1 - a) + cb * a
                else:
                    g = math.exp(-(d - lw) / 9.0) * 0.32
                    buf[i] = min(255.0, buf[i] + cr * g)
                    buf[i + 1] = min(255.0, buf[i + 1] + cg * g)
                    buf[i + 2] = min(255.0, buf[i + 2] + cb * g)

    return buf

# ---------------- reamostragem e PNG ----------------
def downsample(buf, size):
    out = bytearray()
    scale = SIZE / size
    sub = 3
    for y in range(size):
        for x in range(size):
            r = g = b = 0.0
            for sy in range(sub):
                for sx in range(sub):
                    px = min(SIZE - 1, int((x + (sx + 0.5) / sub) * scale))
                    py = min(SIZE - 1, int((y + (sy + 0.5) / sub) * scale))
                    i = (py * SIZE + px) * 3
                    r += buf[i]; g += buf[i + 1]; b += buf[i + 2]
            k = sub * sub
            out += bytes((min(255, int(r / k)), min(255, int(g / k)), min(255, int(b / k)), 255))
    return bytes(out)

def write_png(path, size, rgba):
    def chunk(tag, data):
        payload = tag + data
        return struct.pack('>I', len(data)) + payload + struct.pack('>I', zlib.crc32(payload) & 0xFFFFFFFF)
    raw = b''.join(b'\x00' + rgba[y * size * 4:(y + 1) * size * 4] for y in range(size))
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(png)
    print(f'{path} ({size}x{size})')

def main():
    print('renderizando logo Korx 3D em 1024px…')
    buf = render()
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    targets = [
        (os.path.join(root, 'web/icons/icon-512.png'), 512),
        (os.path.join(root, 'web/icons/icon-192.png'), 192),
        (os.path.join(root, 'android/res/mipmap-mdpi/ic_launcher.png'), 48),
        (os.path.join(root, 'android/res/mipmap-hdpi/ic_launcher.png'), 72),
        (os.path.join(root, 'android/res/mipmap-xhdpi/ic_launcher.png'), 96),
        (os.path.join(root, 'android/res/mipmap-xxhdpi/ic_launcher.png'), 144),
        (os.path.join(root, 'android/res/mipmap-xxxhdpi/ic_launcher.png'), 192),
        (os.path.join(root, 'docs/logo-1024.png'), 1024),
    ]
    for path, size in targets:
        write_png(path, size, downsample(buf, size))

if __name__ == '__main__':
    main()
