"""Gera as peças do dock de parede: verifica, posiciona na mesa e exporta.

    python3 build.py            -> out/DockParedeUniversal.3mf + STLs

Cada peça é conferida antes de exportar: malha fechada (sem arestas abertas
nem repetidas), normais para fora e volume positivo.
"""

import os

from kernel import check, extrude_region, heal, save_3mf, save_stl
import mount as M

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")

# nome, seções, quantidade, rotação em X antes de imprimir
PECAS = [
    ("01_espinha",           None,                    1,  0),
    ("02_berco",             M.berco,                 1,  0),
    ("03_grampo_superior",   M.grampo,                1,  0),
    ("04_garra_carregador",  M.garra_carregador,      2, -90),
    ("05_orelha_lateral",    M.orelha,                2,  0),
]

# posição do canto de cada peça na mesa (mm), pensada para a Creality K2
MESA = [(8, 6), (135, 6), (135, 50), (135, 90), (170, 90), (250, 6), (268, 6)]


def apoia(mesh):
    """Encosta a peça na mesa e leva o canto para a origem."""
    lo, _ = mesh.bounds()
    return mesh.translate(-lo[0], -lo[1], -lo[2])


def main():
    os.makedirs(OUT, exist_ok=True)
    pecas, falhas = [], []

    for nome, fn, qtd, rot in PECAS:
        malha = M.espinha() if fn is None else extrude_region(fn())
        malha = heal(malha)
        rel = check(malha, nome)
        if not rel["ok"]:
            falhas.append(rel)
        if rot:
            malha = malha.rotate_x(rot)
        malha = apoia(malha)
        save_stl(malha, os.path.join(OUT, nome + ".stl"))
        d = malha.size()
        print("%-22s %6.1f x %6.1f x %6.1f mm   %6.2f cm3  x%d  %s"
              % (nome, d[0], d[1], d[2], rel["volume_cm3"], qtd,
                 "OK" if rel["ok"] else "FALHOU"))
        for _ in range(qtd):
            pecas.append((nome, malha))

    if falhas:
        raise SystemExit("malhas inválidas: %s" % [f["nome"] for f in falhas])

    colocadas = []
    for (nome, malha), (x, y) in zip(pecas, MESA):
        colocadas.append((nome, malha, (x, y, 0.0)))

    alvo = os.path.join(OUT, "DockParedeUniversal.3mf")
    save_3mf(colocadas, alvo, title="Dock de parede universal para celular")
    largura = max(x + malha.size()[0] for _, malha, (x, y, _z) in colocadas)
    fundo = max(y + malha.size()[1] for _, malha, (x, y, _z) in colocadas)
    print("\n%d peças na mesa, ocupando %.0f x %.0f mm" % (len(colocadas), largura, fundo))
    print("3MF:", alvo)


if __name__ == "__main__":
    main()
