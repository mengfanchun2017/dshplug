# -*- coding: utf-8 -*-
"""Round-trip bridge for dsh-pixel-studio.

Two directions:
  push  - compile the code-authored Manta PNGs into the plugin's works.json so
          they open inside the GUI editor (nudge pixels by hand, then export).
  pull  - read works.json back out and write the integer upscale ladder, so an
          edit made in the editor lands in assets/ without a manual step.

Usage:
  python pixel_studio_bridge.py push
  python pixel_studio_bridge.py pull
"""

import json, os, sys
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
A = os.path.join(ROOT, '..', 'assets')
HOME = os.path.expanduser('~')
PROFILE = os.path.join(HOME, '.dsh', 'profiles', 'desktop')

# The plugin resolves its store from DSH_PROFILE_DIR, falling back to ~/.dsh.
# Write to both so the works show up no matter which the host sets.
STORES = [
    os.path.join(PROFILE, 'pixel-studio', 'works.json'),
    os.path.join(HOME, '.dsh', 'pixel-studio', 'works.json'),
]

CHARS = '0123456789abcdefghijklmnopqrstuvwxyz'

WORKS = [
    ('manta-mark-48.png', 'MANTA 主标记 48', 'mantamark48'),
    ('manta-mark-32.png', 'MANTA 32 · 小尺寸重绘', 'mantamark32'),
    ('manta-mark-16.png', 'MANTA 16 · favicon 档', 'mantamark16'),
]


def palette_hex(path):
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    colors = []

    def walk(v):
        if isinstance(v, str) and v.startswith('#') and len(v) == 7:
            h = v.lower()
            if h not in colors:
                colors.append(h)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    walk(data)
    return colors


def nearest(colors, rgb):
    r, g, b = rgb
    best, bd = 0, 1 << 30
    for i, c in enumerate(colors):
        cr, cg, cb = int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16)
        d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
        if d < bd:
            bd, best = d, i
    return best


def png_to_rows(path, colors):
    img = Image.open(path).convert('RGBA')
    w, h = img.size
    px = img.load()
    rows = []
    for y in range(h):
        row = []
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 128:
                row.append('.')
                continue
            hx = '#%02x%02x%02x' % (r, g, b)
            slot = colors.index(hx) if hx in colors else nearest(colors, (r, g, b))
            row.append(CHARS[slot])
        rows.append(''.join(row))
    return w, h, rows


def read_store(path):
    if not os.path.exists(path):
        return {'version': 1, 'works': {}}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            old = json.load(f)
        if isinstance(old.get('works'), dict):
            return {'version': 1, 'works': old['works']}
    except Exception as e:
        print('  store unreadable, starting fresh:', e, file=sys.stderr)
    return {'version': 1, 'works': {}}


def push():
    colors = palette_hex(os.path.join(A, 'palette.json'))
    if len(colors) > 36:
        colors = colors[:36]
    print('palette slots:', len(colors))

    base = read_store(STORES[0])
    stamp = 1794278400000  # fixed, descending so the three Manta works stay on top
    for i, (fn, name, wid) in enumerate(WORKS):
        p = os.path.join(A, 'mark', fn)
        if not os.path.exists(p):
            print('  missing', p, file=sys.stderr)
            continue
        w, h, rows = png_to_rows(p, colors)
        base['works'][wid] = {
            'id': wid,
            'name': name,
            'w': w, 'h': h,
            'palette': colors,
            'filePath': None,
            'layers': [{'name': '墨线+明暗', 'visible': True, 'rows': rows}],
            'updatedAt': stamp - i * 1000,
        }
        print('  +', wid, '%dx%d' % (w, h))

    for path in STORES:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        store = read_store(path)
        store['works'].update(base['works'])
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(store, f, ensure_ascii=False)
        os.replace(tmp, path)
        print('  wrote', path)

    pal = {'format': 'dsh-pixel-studio-palette', 'version': 1,
           'name': 'Bubble Ocean', 'colors': colors}
    pp = os.path.join(A, 'palette.pixel-studio.json')
    with open(pp, 'w', encoding='utf-8') as f:
        json.dump(pal, f, ensure_ascii=False, indent=2)
    print('  wrote', pp)


def rows_to_png(work, out_path):
    colors = work['palette']
    w, h = work['w'], work['h']
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    px = img.load()
    for y, row in enumerate(work['layers'][0]['rows']):
        for x, ch in enumerate(row):
            if ch == '.':
                continue
            slot = CHARS.index(ch)
            c = colors[slot]
            px[x, y] = (int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16), 255)
    img.save(out_path)
    return img


def pull():
    store = read_store(STORES[0])
    if not store['works']:
        print('no works found — run push first', file=sys.stderr)
        return
    ladder = (2, 3, 4, 5, 6, 8, 10, 16, 21)
    for wid, work in store['works'].items():
        img = rows_to_png(work, os.path.join(A, 'mark', 'manta-edited-%s.png' % work['w']))
        if work['w'] == 48:
            for k in ladder:
                img.resize((48 * k, 48 * k), Image.NEAREST).save(
                    os.path.join(A, 'mark', 'manta-mark-%d.png' % (48 * k)))
        print('  pulled', wid, '%dx%d' % (work['w'], work['h']))


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'push'
    print('mode:', mode)
    push() if mode == 'push' else pull()
