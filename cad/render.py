"""Renderiza pré-visualizações do dock montado (PNG, sem dependências).

    python3 render.py     -> out/preview_montado.png, out/preview_pecas.png
"""

import math
import os
import struct
import zlib

from kernel import Mesh, cross, dot, extrude_region, heal, norm, sub, unit
import mount as M

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")


# --------------------------------------------------------------------------
# PNG
# --------------------------------------------------------------------------

def save_png(path, w, h, pixels):
    raw = b"".join(b"\x00" + bytes(pixels[y * w * 3:(y + 1) * w * 3]) for y in range(h))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)
    return path


# --------------------------------------------------------------------------
# rasterizador com z-buffer e luz difusa
# --------------------------------------------------------------------------

def render(objetos, path, w=1000, h=1000, cam=(1.0, -1.6, 0.75), fundo=(250, 250, 251),
           zoom=0.92):
    fwd = unit(cam)
    up0 = (0.0, 0.0, 1.0)
    right = unit(cross(fwd, up0))
    up = cross(right, fwd)
    luz = unit((0.35, -0.8, 0.65))

    pts = []
    for _cor, malha in objetos:
        for t in malha.tris:
            pts.extend(t)
    us = [dot(p, right) for p in pts]
    vs = [dot(p, up) for p in pts]
    cu, cv = (min(us) + max(us)) / 2, (min(vs) + max(vs)) / 2
    esc = zoom * min(w / (max(us) - min(us)), h / (max(vs) - min(vs)))

    buf = bytearray()
    for _ in range(w * h):
        buf += bytes(fundo)
    zbuf = [1e18] * (w * h)

    for cor, malha in objetos:
        for tri in malha.tris:
            n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]))
            ln = norm(n)
            if ln < 1e-12:
                continue
            n = (n[0] / ln, n[1] / ln, n[2] / ln)
            lam = max(0.0, dot(n, luz))
            amb = 0.52 + 0.16 * max(0.0, n[2])
            k = min(1.0, amb + 0.50 * lam)
            spec = 0.0
            hv = unit((luz[0] - fwd[0], luz[1] - fwd[1], luz[2] - fwd[2]))
            s = max(0.0, dot(n, hv))
            spec = 0.30 * (s ** 24)
            rgb = tuple(min(255, int(c * k + 255 * spec)) for c in cor)

            scr = []
            for p in tri:
                x = (dot(p, right) - cu) * esc + w / 2
                y = h / 2 - (dot(p, up) - cv) * esc
                scr.append((x, y, dot(p, fwd)))
            (x0, y0, z0), (x1, y1, z1), (x2, y2, z2) = scr
            minx = max(0, int(min(x0, x1, x2)))
            maxx = min(w - 1, int(max(x0, x1, x2)) + 1)
            miny = max(0, int(min(y0, y1, y2)))
            maxy = min(h - 1, int(max(y0, y1, y2)) + 1)
            den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
            if abs(den) < 1e-12:
                continue
            for py in range(miny, maxy + 1):
                fy = py + 0.5
                for px in range(minx, maxx + 1):
                    fx = px + 0.5
                    a = ((y1 - y2) * (fx - x2) + (x2 - x1) * (fy - y2)) / den
                    if a < 0 or a > 1:
                        continue
                    b = ((y2 - y0) * (fx - x2) + (x0 - x2) * (fy - y2)) / den
                    if b < 0 or a + b > 1:
                        continue
                    c = 1 - a - b
                    z = a * z0 + b * z1 + c * z2
                    i = py * w + px
                    if z < zbuf[i]:
                        zbuf[i] = z
                        buf[i * 3:i * 3 + 3] = bytes(rgb)
    return save_png(path, w, h, buf)


# --------------------------------------------------------------------------
# montagem
# --------------------------------------------------------------------------

CINZA = (154, 162, 174)
GRAFITE = (96, 104, 118)
LARANJA = (232, 138, 58)
VIDRO = (36, 40, 48)
BRANCO = (222, 226, 232)

Z_BERCO = -30.0        # altura em que o berço está travado no trilho
Z_GRAMPO = 86.0


def pecas():
    esp = heal(M.espinha()).rotate_x(-90).scale(1, 1, -1).translate(0, -M.T, 0)
    ber = heal(extrude_region(M.berco())).translate(0, 0, Z_BERCO)
    gra = heal(extrude_region(M.grampo())).translate(0, 0, Z_GRAMPO)
    gc = heal(extrude_region(M.garra_carregador()))
    gcd = gc.translate(19, 0, M.GC_Y)
    gce = gc.scale(-1, 1, 1).translate(-19, 0, M.GC_Y)
    ore = heal(extrude_region(M.orelha()))
    z_pino = Z_BERCO + M.BE_ALT - 8.0
    ord_ = ore.translate(40, M.BE_PINO_Y, z_pino)
    ore_ = ore.scale(-1, 1, 1).translate(-40, M.BE_PINO_Y, z_pino)
    return esp, ber, gra, gcd, gce, ord_, ore_


def caixa(w, d, h, x, y, z, r=2.0):
    from kernel import rbox
    return rbox(w, d, h, r=r, fillet=0.8).translate(x, y, z)


def main():
    os.makedirs(OUT, exist_ok=True)
    esp, ber, gra, gcd, gce, ord_, ore_ = pecas()

    celular = caixa(75, 8.6, 160, 0, M.BE_PAR + 4.3, Z_BERCO + M.BE_PISO + 80, r=8)
    carregador = caixa(42, 30, 42, 0, -M.T + 15, M.JAN_Y, r=4)

    render([(VIDRO, celular), (BRANCO, carregador),
            (CINZA, esp), (GRAFITE, ber), (GRAFITE, gra),
            (LARANJA, gcd), (LARANJA, gce), (LARANJA, ord_), (LARANJA, ore_)],
           os.path.join(OUT, "preview_montado.png"))
    print("preview_montado.png")

    render([(CINZA, esp), (GRAFITE, ber), (GRAFITE, gra),
            (LARANJA, gcd), (LARANJA, gce), (LARANJA, ord_), (LARANJA, ore_)],
           os.path.join(OUT, "preview_pecas.png"), cam=(0.55, -1.8, 0.45))
    print("preview_pecas.png")


if __name__ == "__main__":
    main()
