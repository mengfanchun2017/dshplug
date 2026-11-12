
# -*- coding: utf-8 -*-
"""MANTA pixel IP - deterministic asset builder.

Geometry is authored on a 48x48 master grid and re-rasterised at each export
size (never resampled), so every size stays on its own pixel grid.

WARNING: this regenerates the whole family from the drawing in THIS FILE. The
shipped artwork has since been edited in the pixel editor, so running this
replaces the authored master with the drawing below. Regenerate the ladder
from the current master instead (tools/exports.py), which is byte-exact.
"""
from PIL import Image, ImageDraw
import os, json

ROOT = os.path.dirname(os.path.abspath(__file__))
A = os.path.join(ROOT, '..', 'assets')
for sub in ('mark', 'avatar', 'lockup', 'expression'):
    os.makedirs(os.path.join(A, sub), exist_ok=True)

PAL_HEX = {
    'O': '#071321',  # Ink
    'N': '#112A46',  # Deep water
    'D': '#1A4670',  # Mid water
    'M': '#2A6C9C',  # Manta blue (primary)
    'L': '#50A0C6',  # Shallow water
    'C': '#AAE9EE',  # Bubble
    'W': '#FAFDFF',  # Paper
    'K': '#071321',  # Ink (pupil / mouth)
    'P': '#FF8AA4',  # Coral
}
PAL = {k: tuple(int(v[i:i + 2], 16) for i in (1, 3, 5)) + (255,) for k, v in PAL_HEX.items()}

HW48 = {8: 6, 9: 10, 10: 13, 11: 15.5, 12: 18, 13: 20, 14: 21, 15: 21.5,
        16: 21, 17: 20, 18: 18.5, 19: 17, 20: 15.5, 21: 14, 22: 12.5,
        23: 11, 24: 9.5, 25: 8.2, 26: 7.0, 27: 5.8, 28: 4.6, 29: 3.4, 30: 2.4}
HORN48 = [(17, 7), (18, 7), (16, 6), (17, 6), (16, 5), (15, 5), (15, 4), (14, 4)]
TAIL48 = [(23 + (i // 4), 31 + i) for i in range(10)] + [(24 + (i // 4), 31 + i) for i in range(10)]


def build(size, expr='default', detail=True):
    s = size / 48.0
    cx = (size - 1) / 2.0

    def S(v):
        return v * s

    body = set()
    for y in range(size):
        yy = (y + 0.5) / s - 0.5          # sample position back on the 48 grid
        ys = sorted(HW48)
        if yy < ys[0] or yy > ys[-1]:
            continue
        hw = None
        for i in range(len(ys) - 1):
            if ys[i] <= yy <= ys[i + 1]:
                f = (yy - ys[i]) / (ys[i + 1] - ys[i])
                hw = HW48[ys[i]] + (HW48[ys[i + 1]] - HW48[ys[i]]) * f
                break
        if hw is None:
            continue
        for x in range(size):
            if abs(x - cx) <= S(hw):
                body.add((x, y))

    horns, tail = set(), set()
    if detail:
        for (x, y) in HORN48:
            hx, hy = int(round(S(x))), int(round(S(y)))
            horns.add((hx, hy)); horns.add((size - 1 - hx, hy))
        for (x, y) in TAIL48:
            tail.add((int(round(S(x))), int(round(S(y)))))

    mask = body | horns | tail
    inside = lambda x, y: (x, y) in mask
    outline = {(x, y) for (x, y) in mask
               if any(not inside(x + dx, y + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))}

    top = {}
    for x in range(size):
        ys = [y for (xx, y) in body if xx == x]
        if ys:
            top[x] = min(ys)

    px = {}
    for (x, y) in mask:
        if (x, y) in horns:
            px[(x, y)] = 'L'
        elif (x, y) in tail:
            px[(x, y)] = 'D'
        else:
            d = y - top.get(x, y)
            lim = lambda v: max(1, int(round(S(v))))
            if d <= 0: px[(x, y)] = 'C'
            elif d <= lim(3): px[(x, y)] = 'L'
            elif d <= lim(8): px[(x, y)] = 'M'
            elif d <= lim(14): px[(x, y)] = 'D'
            else: px[(x, y)] = 'N'
    for (x, y) in outline:
        px[(x, y)] = 'O'

    def put(x, y, c):
        if (x, y) in px:
            px[(x, y)] = c

    # ---- face: 48-grid coordinates scaled, bespoke placements for small sizes
    if size >= 40:
        def fsc(x, y):
            return (int(round(x * s)), int(round(y * s)))

        k = max(1, int(round(s)))                     # pixel thickness of one 48-grid cell
        ex = [(fsc(17, 0)[0], fsc(19, 0)[0] - 1), (fsc(29, 0)[0], fsc(31, 0)[0] - 1)]
        ey0, ey1 = fsc(0, 13)[1], fsc(0, 15)[1]
        for (a, b) in ex:
            for y in range(ey0, ey1 + 1):
                for x in range(a, b + 1):
                    put(x, y, 'K')
            if expr in ('default', 'blink'):
                for y in range(ey0, ey1 - k + 1):
                    for x in range(a, b + 1):
                        put(x, y, 'W')
                put(a, ey1, 'W')
            if expr == 'default':
                put(b - k + 1, ey0 + k, 'K')
            if expr == 'blink':
                for y in range(ey0, ey0 + k):
                    for x in range(a, b + 1):
                        put(x, y, 'L')

        for gx in (13, 14, 33, 34):
            bx, by = fsc(gx, 17)
            for dx in range(k):
                if px.get((bx + dx, by)) in ('L', 'M', 'C', 'D'):
                    put(bx + dx, by, 'P')

        mc = fsc(23, 16)
        half = k
        for i in range(-half, half + 1):
            put(mc[0] + i, fsc(0, 17)[1], 'K')
        for (x, y) in ((22, 16), (24, 16)):
            for dy in range(k):
                put(fsc(x, 16)[0], fsc(0, 16)[1] + dy, 'K')
        if expr == 'happy':
            for i in range(-half, half + 1):
                put(mc[0] + i, fsc(0, 16)[1], 'K')
    elif size >= 30:
        eyes = ((11, 12), (19, 20)); ey = (8, 9)
        for (a, b) in eyes:
            for y in ey:
                put(a, y, 'W'); put(b, y, 'W')
            put(b, 9, 'K'); put(a, 9, 'K')
        for x in (8, 9, 22, 23):
            if px.get((x, 11)) in ('L', 'M', 'C'): put(x, 11, 'P')
        put(15, 11, 'K'); put(16, 11, 'K')
    elif size >= 22:
        eyes = ((7, 8), (15, 16))
        for (a, b) in eyes:
            put(a, 6, 'W'); put(b, 6, 'W')
            put(a, 7, 'K'); put(b, 7, 'K')
        put(11, 8, 'K'); put(12, 8, 'K')
    else:
        for (a, b) in ((4, 5), (10, 11)):
            put(a, 4, 'W'); put(b, 4, 'W')
            put(a, 5, 'K'); put(b, 5, 'K')

    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    p = img.load()
    for (x, y), c in px.items():
        p[x, y] = PAL[c]
    return img


FONT = {
    'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
}


def wordmark(text, scale, color):
    gap = 1
    w = (5 * len(text) + gap * (len(text) - 1)) * scale
    im = Image.new('RGBA', (w, 7 * scale), (0, 0, 0, 0))
    p = im.load()
    for i, ch in enumerate(text):
        for y, row in enumerate(FONT[ch]):
            for x, bit in enumerate(row):
                if bit == '1':
                    for dy in range(scale):
                        for dx in range(scale):
                            p[(i * (5 + gap) + x) * scale + dx, y * scale + dy] = color
    return im


# ---------------- exports
# The authored masters. 48 is the design source and is the ONLY file the
# integer ladder is derived from; 16 / 24 / 32 / 64 are drawn on their own
# grids because shrinking a 48 px mark destroys legibility (see docs/CONTRACT.md).
master = build(48)
for s in (16, 24, 32, 48, 64):
    build(s).save(os.path.join(A, 'mark', 'manta-mark-%d.png' % s))

build(16).save(os.path.join(A, 'mark', 'favicon.ico'),
               sizes=[(16, 16), (24, 24), (32, 32), (48, 48)])

for e in ('default', 'blink', 'happy'):
    build(96, e).save(os.path.join(A, 'expression', 'manta-face-%s.png' % e))
    build(48, e).save(os.path.join(A, 'expression', 'manta-face-%s@48.png' % e))

# Palette-perfect integer upscales only: the 48 grid is the single authored
# master, and every rung here is a whole multiple of it. 512 is deliberately
# absent -- it is a social canvas (480 centred on 512), not a rung.
for _k, _name in ((2, 96), (3, 144), (4, 192), (6, 288), (8, 384), (10, 480), (16, 768), (21, 1008)):
    master.resize((48 * _k, 48 * _k), Image.NEAREST).save(os.path.join(A, 'mark', 'manta-mark-%d.png' % _name))
M6 = master.resize((288, 288), Image.NEAREST)

av = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
d = ImageDraw.Draw(av)
d.ellipse([0, 0, 511, 511], fill=(14, 34, 58, 255))
d.ellipse([0, 0, 511, 320], fill=(18, 46, 78, 255))
av.alpha_composite(M6, (58, 60))
mm = Image.new('L', (512, 512), 0)
ImageDraw.Draw(mm).ellipse([0, 0, 511, 511], fill=255)
av.putalpha(mm)
av.save(os.path.join(A, 'avatar', 'manta-avatar-512.png'))

ic = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
di = ImageDraw.Draw(ic)
di.rounded_rectangle([0, 0, 511, 511], radius=112, fill=(14, 34, 58, 255))
di.ellipse([0, 0, 511, 300], fill=(18, 46, 78, 255))
ic.alpha_composite(M6, (68, 70))
ic.save(os.path.join(A, 'avatar', 'manta-appicon-512.png'))

wordmark('MANTA', 8, PAL['O']).save(os.path.join(A, 'lockup', 'manta-wordmark.png'))
wordmark('MANTA', 8, PAL['C']).save(os.path.join(A, 'lockup', 'manta-wordmark-light.png'))

mk = M6
wm = wordmark('MANTA', 26, PAL['O'])
lock = Image.new('RGBA', (256 + 56 + wm.width, 256), (0, 0, 0, 0))
lock.alpha_composite(mk, (0, 0))
lock.alpha_composite(wm, (256 + 56, (256 - wm.height) // 2))
lock.save(os.path.join(A, 'lockup', 'manta-lockup-horizontal.png'))
lockL = Image.new('RGBA', lock.size, (0, 0, 0, 0))
lockL.alpha_composite(mk, (0, 0))
lockL.alpha_composite(wordmark('MANTA', 26, PAL['C']), (256 + 56, (256 - wm.height) // 2))
lockL.save(os.path.join(A, 'lockup', 'manta-lockup-horizontal-light.png'))

json.dump([{'key': k, 'hex': v} for k, v in PAL_HEX.items()],
          open(os.path.join(A, 'palette.json'), 'w'), indent=2)
print('ok')
