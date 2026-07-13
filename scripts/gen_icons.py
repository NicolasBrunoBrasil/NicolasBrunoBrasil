#!/usr/bin/env python3
"""Gera os ícones do Estúdio 3D (PNG) sem dependências externas.

Desenha um cubo isométrico sobre fundo escuro, com anti-aliasing por
superamostragem 3x3, e grava PNGs RGBA usando apenas zlib/struct.
"""
import os
import struct
import zlib

BG = (16, 21, 28)
TOP = (142, 220, 255)
LEFT = (47, 154, 209)
RIGHT = (27, 111, 160)
EDGE = (10, 14, 19)

# polígonos definidos num espaço de 512
CUBE = {
    'top':   [(256, 116), (392, 194), (256, 272), (120, 194)],
    'left':  [(120, 194), (256, 272), (256, 428), (120, 350)],
    'right': [(392, 194), (256, 272), (256, 428), (392, 350)],
}


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


def color_at(x, y):
    for name in ('top', 'left', 'right'):
        if point_in_poly(x, y, CUBE[name]):
            return {'top': TOP, 'left': LEFT, 'right': RIGHT}[name]
    return BG


def render(size):
    scale = 512.0 / size
    sub = 3
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = 0
            for sy in range(sub):
                for sx in range(sub):
                    x = (px + (sx + 0.5) / sub) * scale
                    y = (py + (sy + 0.5) / sub) * scale
                    c = color_at(x, y)
                    r += c[0]; g += c[1]; b += c[2]
            n = sub * sub
            row += bytes((r // n, g // n, b // n, 255))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    def chunk(tag, data):
        payload = tag + data
        return struct.pack('>I', len(data)) + payload + struct.pack('>I', zlib.crc32(payload) & 0xFFFFFFFF)

    raw = b''.join(b'\x00' + r for r in rows)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(png)
    print(f'{path} ({size}x{size})')


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    targets = [
        (os.path.join(root, 'web/icons/icon-512.png'), 512),
        (os.path.join(root, 'web/icons/icon-192.png'), 192),
        (os.path.join(root, 'android/res/mipmap-mdpi/ic_launcher.png'), 48),
        (os.path.join(root, 'android/res/mipmap-hdpi/ic_launcher.png'), 72),
        (os.path.join(root, 'android/res/mipmap-xhdpi/ic_launcher.png'), 96),
        (os.path.join(root, 'android/res/mipmap-xxhdpi/ic_launcher.png'), 144),
        (os.path.join(root, 'android/res/mipmap-xxxhdpi/ic_launcher.png'), 192),
    ]
    for path, size in targets:
        write_png(path, size, render(size))


if __name__ == '__main__':
    main()
