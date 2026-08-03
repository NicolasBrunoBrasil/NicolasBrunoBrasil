"""Dock de parede universal para celular — modelo paramétrico.

Sistema modular preso à própria tomada, sem furar a parede:

    ESPINHA    placa de fundo: trilhos rabo-de-andorinha, janela do carregador,
               calha do cabo, rasgos para o parafuso do espelho e os entalhes
               laterais onde o fio é enrolado
    BERCO      bandeja inferior, desliza em altura; abertura no piso para o
               conector do carregador
    GRAMPO     garra superior, desliza em altura; abraça o canto superior
               ESQUERDO e cruza a frente com um lábio, deixando toda a lateral
               direita (botão power) livre
    ORELHA     apoio lateral (2x): entra num dos furos da parede da frente do
               berço e regula a largura de 56 a 96 mm
    GARRA_CAR  garra do carregador (2x): aperta a lateral do plugue e o lábio
               da frente é a trava que o mantém enfiado na tomada

Todas as peças são extrusões em Z de seção variável: imprimem sem nenhum
suporte, com as camadas no sentido certo para aguentar o peso.
"""
import math

from kernel import extrude_region, rounded_rect

# --------------------------------------------------------------------------
# parâmetros gerais (mm)
# --------------------------------------------------------------------------

NOZZLE = 0.4
FOLGA = 0.30           # folga de deslize entre rabo-de-andorinha e trilho
CH = 1.0               # chanfro das bordas

# --- espinha
W = 104.0
H = 268.0
T = 8.0
R_CANTO = 10.0

# --- trilho rabo-de-andorinha (cortado na espinha)
TR_X = 32.0            # distância do centro até o eixo de cada trilho
TR_LARGO = 14.0        # largura interna (dentro da placa)
TR_BOCA = 9.0          # largura da boca (na face frontal)
TR_Z0 = 2.6            # fundo do canal -> 2,6 mm de casca fechada nas costas
TR_Z1 = 5.1            # fim do trecho largo
TR_Y0 = -48.0
TR_Y1 = 100.0

# --- janela do carregador
JAN_W, JAN_H, JAN_R = 66.0, 54.0, 6.0
JAN_Y = -95.0

# --- trilho horizontal das garras do carregador
GC_Y = -58.0
GC_H = 12.0
GC_X = 46.0

# --- calha do cabo (rasgo cego na frente)
CAL_W = 14.0
CAL_Y0, CAL_Y1 = -46.0, 50.0
CAL_Z = 3.4            # fundo da calha

# --- rasgos opcionais para o parafuso do espelho da tomada (4x2 deitado)
PAR_X = 43.0
PAR_W, PAR_H = 5.5, 26.0

# --- chifres do enrola-cabo (entalhes nas laterais do topo)
CH_Y = 110.0
CH_R = 10.0


def _seg_arc(cx, cy, r, a0, a1, n):
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / n),
             cy + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]


def espinha_outline(off=0.0, seg=8, nseg=14):
    """Contorno da espinha: retângulo arredondado com dois entalhes laterais
    no topo, que formam os chifres onde o cabo é enrolado.

    `off` desloca todo o contorno para dentro (usado para gerar o chanfro).
    """
    hw, hh = W / 2.0 - off, H / 2.0 - off
    rc = max(0.5, R_CANTO - off)
    R = CH_R + off
    cx = W / 2.0                          # centro do entalhe fica na aresta original
    A = math.acos(max(-1.0, min(1.0, -off / R)))

    pts = []
    # canto inferior direito -> sobe pela direita
    pts += _seg_arc(hw - rc, -hh + rc, rc, math.radians(-90), 0.0, seg)
    pts += _seg_arc(cx, CH_Y, R, 2 * math.pi - A, A, nseg)      # entalhe direito
    pts += _seg_arc(hw - rc, hh - rc, rc, 0.0, math.radians(90), seg)
    # topo -> canto superior esquerdo -> desce pela esquerda
    pts += _seg_arc(-hw + rc, hh - rc, rc, math.radians(90), math.radians(180), seg)
    pts += _seg_arc(-cx, CH_Y, R, math.pi - A, math.pi - (2 * math.pi - A), nseg)
    pts += _seg_arc(-hw + rc, -hh + rc, rc, math.radians(180), math.radians(270), seg)
    return pts


def rr(w, h, r, dx=0.0, dy=0.0, seg=8):
    return [(x + dx, y + dy) for x, y in rounded_rect(w, h, r, seg)]


def slot_y(w, y0, y1, x=0.0, off=0.0, seg=8):
    """Rasgo vertical (ao longo de Y) de largura `w`, crescido de `off`."""
    return rr(w + 2 * off, (y1 - y0) + 2 * off, (w + 2 * off) / 2.0,
              x, (y0 + y1) / 2.0, seg)


def slot_x(h, x0, x1, y=0.0, off=0.0, seg=8):
    """Rasgo horizontal (ao longo de X) de altura `h`, crescido de `off`."""
    return rr((x1 - x0) + 2 * off, h + 2 * off, (h + 2 * off) / 2.0,
              (x0 + x1) / 2.0, y, seg)


GC_BOCA = 8.0          # boca do trilho horizontal


def _taper(z, wide, boca):
    """Largura do canal em z, no trecho que estreita de TR_Z1 até a face."""
    return wide + (boca - wide) * (z - TR_Z1) / (T - TR_Z1)


def espinha():
    """Placa de fundo. Impressa deitada: Z = espessura (8 mm).

    O canal é largo por dentro e estreito na boca (rabo-de-andorinha), com a
    transição a ~49° — imprime sem suporte e prende as peças deslizantes.
    """

    def sec(z, off, g, trilho, gcar, calha):
        """off: recuo do contorno; g: folga extra dos furos passantes (chanfro)."""
        holes = [
            rr(JAN_W + 2 * g, JAN_H + 2 * g, JAN_R + g, 0, JAN_Y),
            rr(PAR_W + 2 * g, PAR_H + 2 * g, (PAR_W + 2 * g) / 2, PAR_X, JAN_Y),
            rr(PAR_W + 2 * g, PAR_H + 2 * g, (PAR_W + 2 * g) / 2, -PAR_X, JAN_Y),
            None if trilho is None else slot_y(trilho, TR_Y0, TR_Y1, TR_X),
            None if trilho is None else slot_y(trilho, TR_Y0, TR_Y1, -TR_X),
            None if gcar is None else slot_x(gcar, -GC_X, GC_X, GC_Y),
            None if calha is None else slot_y(calha, CAL_Y0, CAL_Y1, 0.0),
        ]
        return (z, espinha_outline(off), holes)

    return extrude_region([
        sec(0.0,    CH,  CH,  None,     None,    None),   # chanfro das costas
        sec(CH,     0.0, 0.0, None,     None,    None),
        sec(TR_Z0,  0.0, 0.0, None,     None,    None),   # 2,6 mm de casca fechada
        sec(TR_Z0,  0.0, 0.0, TR_LARGO, GC_H,    None),   # abre os canais largos
        sec(CAL_Z,  0.0, 0.0, TR_LARGO, GC_H,    None),
        sec(CAL_Z,  0.0, 0.0, TR_LARGO, GC_H,    CAL_W),  # abre a calha do cabo
        sec(TR_Z1,  0.0, 0.0, TR_LARGO, GC_H,    CAL_W),
        sec(T - CH, 0.0, 0.0, _taper(T - CH, TR_LARGO, TR_BOCA),
            _taper(T - CH, GC_H, GC_BOCA), CAL_W),
        sec(T,      CH,  CH,  TR_BOCA + 2 * CH, GC_BOCA + 2 * CH, CAL_W + 2 * CH),
    ])



# --------------------------------------------------------------------------
# encaixe rabo-de-andorinha das peças deslizantes
# --------------------------------------------------------------------------

RB_PROF = 5.2          # profundidade do rabo (canal tem 5,4)
RB_NECK = 2.9          # trecho do pescoço, igual à boca do canal


def rabo(cx, boca=TR_BOCA, largo=TR_LARGO, prof=RB_PROF, neck=RB_NECK):
    """Meia-cauda de andorinha saindo da face Y=0 para -Y, centrada em `cx`.

    Devolve os pontos no sentido de X- para X+, para serem costurados no
    contorno da peça (que anda no sentido anti-horário).
    """
    a = (boca - FOLGA) / 2.0
    b = (largo - FOLGA) / 2.0
    return [(cx - a, 0.0), (cx - b, -neck), (cx - b, -prof),
            (cx + b, -prof), (cx + b, -neck), (cx + a, 0.0)]


def corpo_com_rabos(x0, x1, y0, y1, r=3.0, rabos=(-TR_X, TR_X), seg=6):
    """Contorno anti-horário de um bloco x0..x1 / y0..y1 com caudas em -Y."""
    pts = []
    pts += _seg_arc(x1 - r, y0 + r, r, math.radians(-90), 0.0, seg)      # dir/baixo
    pts += _seg_arc(x1 - r, y1 - r, r, 0.0, math.radians(90), seg)       # dir/cima
    pts += _seg_arc(x0 + r, y1 - r, r, math.radians(90), math.radians(180), seg)
    pts += _seg_arc(x0 + r, y0 + r, r, math.radians(180), math.radians(270), seg)
    # a aresta de trás (y0) é a de fechamento, percorrida de X- para X+:
    # as caudas entram aí, em ordem crescente de X.
    tail = []
    for cx in sorted(rabos):
        tail += [(p[0], y0 + p[1]) for p in rabo(cx)]
    return pts + tail


# --------------------------------------------------------------------------
# BERCO — bandeja inferior
# --------------------------------------------------------------------------

BE_W = 100.0           # largura externa
BE_Y1 = 32.0           # profundidade total (a partir da face da espinha)
BE_PAR = 8.0           # espessura da parede de trás
BE_FRE = 24.0          # face interna da parede da frente
BE_PISO = 6.0          # espessura do piso
BE_ALT = 20.0          # altura das paredes
BE_BOL = 4.0           # espessura das paredes laterais
BE_ABE_W, BE_ABE_Y0, BE_ABE_Y1 = 34.0, 8.5, 23.0     # abertura do conector
BE_PINO_D = 5.0        # furos de regulagem das orelhas
BE_PINO_Y = 28.0
BE_PINO_X = [float(x) for x in range(-44, 45, 8)]   # 12 posições


def berco():
    """Bandeja que segura a base do celular. Impressa em pé, como monta."""

    def outer(off=0.0):
        return corpo_com_rabos(-BE_W / 2 + off, BE_W / 2 - off,
                               0.0, BE_Y1 - off, max(0.5, 3.0 - off))

    def bolso(off=0.0):
        return rr(BE_W - 2 * BE_BOL + 2 * off, BE_FRE - BE_PAR + 2 * off,
                  3.0 + off, 0.0, (BE_PAR + BE_FRE) / 2)

    def abertura(off=0.0):
        return rr(BE_ABE_W + 2 * off, BE_ABE_Y1 - BE_ABE_Y0 + 2 * off, 4.0 + off,
                  0.0, (BE_ABE_Y0 + BE_ABE_Y1) / 2)

    def pinos(d):
        return [None if d is None else rr(d, d, d / 2 - 0.4, x, BE_PINO_Y)
                for x in BE_PINO_X]

    def sec(z, off, cav, pino):
        return (z, outer(off), [cav] + pinos(pino))

    return [
        sec(0.0,       CH,  abertura(CH), None),          # chanfro da base
        sec(CH,        0.0, abertura(),   None),
        sec(BE_PISO,   0.0, abertura(),   None),
        sec(BE_PISO,   0.0, bolso(),      None),          # abre o bolso do celular
        sec(BE_ALT - 8, 0.0, bolso(),     None),
        sec(BE_ALT - 8, 0.0, bolso(),     BE_PINO_D),     # furos das orelhas
        sec(BE_ALT - CH, 0.0, bolso(),    BE_PINO_D),
        sec(BE_ALT,    CH,  bolso(CH),    BE_PINO_D + 2 * CH),
    ]


# --------------------------------------------------------------------------
# GRAMPO — garra superior (impressa de cabeça para baixo)
# --------------------------------------------------------------------------

GR_W = 100.0
GR_PLACA = 6.0         # espessura da placa de trás
GR_H = 16.0            # altura (espessura impressa)
GR_HX0, GR_HX1 = -42.0, 6.0    # vão do gancho: recuado à esquerda, deixando
GR_HY = 24.0                   # toda a lateral direita (botão power) livre
GR_LIP = 20.0          # face interna do lábio da frente
GR_PONTE = 5.0         # altura da ponte sobre o topo do celular
GR_GAMA = 13.0         # até onde desce o lábio


def grampo_poly():
    """Perfil em "Γ" da garra superior, percorrido no sentido anti-horário.

    Envolve o canto superior esquerdo do celular e cruza a frente com um lábio;
    toda a lateral direita fica aberta, deixando o botão power livre.
    """
    pts = [(GR_W / 2, 0.0), (GR_W / 2, GR_PLACA),
           (GR_HX0 + 8.0, GR_PLACA),          # face interna da parede esquerda
           (GR_HX0 + 8.0, GR_LIP),            # sobe até o lábio
           (GR_HX1, GR_LIP),                  # lábio atravessa a frente
           (GR_HX1, GR_HY),
           (GR_HX0, GR_HY),
           (GR_HX0, GR_PLACA),
           (-GR_W / 2, GR_PLACA), (-GR_W / 2, 0.0)]
    for cx in sorted((-TR_X, TR_X)):
        pts += rabo(cx)
    return pts


def grampo():
    """Garra superior: perfil constante em Z — imprime deitada, sem suporte,
    com as camadas paralelas ao esforço do lábio."""
    p = grampo_poly()
    return [(0.0, p, []), (GR_H, p, [])]


# --------------------------------------------------------------------------
# ORELHA — apoio lateral do celular (2x), regula a largura
# --------------------------------------------------------------------------

OR_PINO = BE_PINO_D - 0.4
OR_W, OR_D, OR_H = 8.0, 9.0, 26.0
OR_REC = 2.5           # recuo do corpo em -Y: avança sobre a frente do celular


def orelha():
    """Apoio lateral: pino que entra num dos furos da parede da frente do berço.

    Encosta na lateral do celular (centraliza) e o corpo avança 3 mm sobre a
    face da frente, segurando o canto. O alargamento do pino para o corpo é
    feito em 6 mm de altura (~52°), então imprime sem suporte.
    """
    def s(z, w, d, r, dy=0.0):
        return (z, rr(w, d, r, 0.0, dy), [])
    return [s(0.0, OR_PINO - 1.2, OR_PINO - 1.2, 0.8),
            s(0.6, OR_PINO, OR_PINO, 1.4),
            s(7.0, OR_PINO, OR_PINO, 1.4),
            s(13.0, OR_W, OR_D, 2.0, -OR_REC),
            s(OR_H - 2.0, OR_W, OR_D, 2.0, -OR_REC),
            s(OR_H, OR_W - 4.0, OR_D - 4.0, 1.0, -OR_REC)]


# --------------------------------------------------------------------------
# GARRA do carregador (2x) — aperta a lateral e trava o plugue na tomada
# --------------------------------------------------------------------------

GA_X = 14.0            # comprimento no trilho
GA_Y = 17.0            # profundidade (avança sobre o carregador)
GA_LAB = 9.0           # quanto o lábio da trava avança para dentro
GA_LAB_Y = 12.0        # onde o lábio começa
GA_CAB = (GC_H - FOLGA) / 2.0        # meia-altura da cabeça
GA_PES = (GC_BOCA - FOLGA) / 2.0     # meia-altura do pescoço


def _garra_poly(y_tras, com_corpo=True):
    if not com_corpo:                       # só a cabeça do rabo-de-andorinha
        return [(GA_X, y_tras), (GA_X, -RB_NECK), (0.0, -RB_NECK), (0.0, y_tras)]
    return [(GA_X, y_tras), (GA_X, GA_Y), (-GA_LAB, GA_Y), (-GA_LAB, GA_LAB_Y),
            (0.0, GA_LAB_Y), (0.0, y_tras)]


def garra_carregador():
    cheia = _garra_poly(-RB_PROF)
    cabeca = [(GA_X, -RB_PROF), (GA_X, -RB_NECK), (-GA_LAB, -RB_NECK),
              (-GA_LAB, -RB_NECK), (0.0, -RB_NECK), (0.0, -RB_PROF)]
    return [(-GA_CAB, cabeca, []), (-GA_PES, cheia, []),
            (GA_PES, cheia, []), (GA_CAB, cabeca, [])]
