from PIL import Image
import os, glob

# Derive the whole integer ladder from the CURRENT authored master.
#
# This is the safe way to re-export: it never redraws anything, so it cannot
# disagree with what the pixel editor shows. Run tools/asset_build.py only when
# you intend to replace the artwork itself.
A = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
master = Image.open(f'{A}/mark/manta-mark-48.png').convert('RGBA')

# integer-only ladder from the 48 master (no resampling artifacts)
for k in (2, 3, 4, 5, 6, 8, 10, 16, 21):
    master.resize((48*k, 48*k), Image.NEAREST).save(f'{A}/mark/manta-mark-{48*k}.png')

# social canvas 512 = 10x art centred (a canvas, not a rung)
c = Image.new('RGBA', (512, 512), (0,0,0,0))
c.alpha_composite(master.resize((480,480), Image.NEAREST), (16,16))
c.save(f'{A}/mark/manta-mark-512.png')

# drop non-integer sizes that collide with the upscale family
for f in (128, 256, 1024):
    p = f'{A}/mark/manta-mark-{f}.png'
    if os.path.exists(p): os.remove(p)

print(sorted(os.path.basename(x) for x in glob.glob(f'{A}/mark/*')))
