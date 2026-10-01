"""Build the item icons that used to be vector drawings.

  python build.py <client.jar> <out-dir> [preview.png]

Needs Pillow and numpy. client.jar is the vanilla client for the current release
(launchermeta version manifest -> version JSON -> downloads.client.url).

Real Minecraft items get their vanilla texture (flat 16x16 sprites as crisp <rect> SVG,
heads as a 3D inventory render). Items that do not exist in Minecraft get the
hand-drawn textures in sprites.py. File names stay .svg so catalogue rows that already
point at them keep working.
"""
import base64
import io
import os
import sys
import zipfile

import numpy as np
from PIL import Image

import iso
import sprites

JAR, OUT = sys.argv[1], sys.argv[2]
PREVIEW = sys.argv[3] if len(sys.argv) > 3 else None
os.makedirs(OUT, exist_ok=True)
_zip = zipfile.ZipFile(JAR)


def tex(path):
    data = _zip.read(f'assets/minecraft/textures/{path}.png')
    return Image.open(io.BytesIO(data)).convert('RGBA')


def arr(img):
    return np.asarray(img).copy()


# ── writers ─────────────────────────────────────────────────────────────────

def hexcol(c):
    return '#%02x%02x%02x' % tuple(c[:3])


def rect_svg(label, pixels, note, view=(0, 0, 16, 16)):
    """pixels: 16 rows of 16 colour strings or None. One <rect> per horizontal run.

    view crops the 16x16 grid, which zooms a sprite that only fills a corner of it.
    """
    by_colour = {}
    for y, row in enumerate(pixels):
        x = 0
        while x < 16:
            c = row[x]
            if c is None:
                x += 1
                continue
            x2 = x
            while x2 + 1 < 16 and row[x2 + 1] == c:
                x2 += 1
            by_colour.setdefault(c, []).append((x, y, x2 - x + 1))
            x = x2 + 1
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="%d %d %d %d" width="64" height="64"' % view
        + f' shape-rendering="crispEdges" role="img" aria-label="{label}">',
        f'  <!-- {note} -->',
    ]
    for c, runs in by_colour.items():
        body = ''.join(f'<rect x="{x}" y="{y}" width="{w}" height="1"/>' for x, y, w in runs)
        lines.append(f'  <g fill="{c}">{body}</g>')
    lines.append('</svg>')
    return '\n'.join(lines) + '\n'


def raster_svg(label, img, note):
    buf = io.BytesIO()
    # 256-colour palette with alpha, like the existing block renders: a third of the RGBA size
    img.quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).save(buf, 'PNG', optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode()
    w, h = img.size
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="64" height="64"'
        f' role="img" aria-label="{label}">\n'
        f'  <!-- {note} -->\n'
        f'  <image width="{w}" height="{h}" href="data:image/png;base64,{b64}"/>\n'
        '</svg>\n'
    )


previews = {}


def write(name, svg, preview):
    with open(os.path.join(OUT, name + '.svg'), 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(svg)
    previews[name] = preview


def sprite_pixels(img):
    img = img.crop((0, 0, 16, 16))
    return [[hexcol(img.getpixel((x, y))) if img.getpixel((x, y))[3] > 0 else None
             for x in range(16)] for y in range(16)]


def pixels_to_img(pixels):
    im = Image.new('RGBA', (16, 16))
    for y, row in enumerate(pixels):
        for x, c in enumerate(row):
            if c:
                im.putpixel((x, y), tuple(int(c[i:i + 2], 16) for i in (1, 3, 5)) + (255,))
    return im


# ── 1. real Minecraft items, flat sprites ───────────────────────────────────

FLAT = {
    # The vanilla tear is 6x8 pixels in the middle of its 16x16 sheet: crop to 10x10 so it
    # reads at the same size as the diamond beside it.
    'ghast_tear': ('Ghast Tear', 'item/ghast_tear', (3, 3, 10, 10)),
    'end_crystal': ('End Crystal', 'item/end_crystal'),
    'soul_lantern': ('Soul Lantern', 'item/soul_lantern'),
    'blaze_rod': ('Blaze Rod', 'item/blaze_rod'),
    'diamond_sword': ('Diamond Sword', 'item/diamond_sword'),
    'diamond_pickaxe': ('Diamond Pickaxe', 'item/diamond_pickaxe'),
    'diamond_helmet': ('Diamond Helmet', 'item/diamond_helmet'),
    'mace': ('Mace', 'item/mace'),
}
for name, (label, path, *view) in FLAT.items():
    px = sprite_pixels(tex(path))
    write(name, rect_svg(label, px, f'Vanilla {path}.png, one rect per pixel run.', *view), pixels_to_img(px))

# ── 2. custom items, flat sprites ───────────────────────────────────────────

CUSTOM_LABELS = {
    'golden_crown': 'Golden Crown',
    'netherite_crown': 'Netherite Crown',
    'magma_core': 'Magma Core',
    'nether_sigil': 'Lava Sea Relic',
    'obsidian_shard': 'Obsidian Shard',
    'sculk_reliquary': 'Sculk Reliquary',
}
for name, label in CUSTOM_LABELS.items():
    palette, rows = sprites.grid(name)
    px = [[palette[ch] if ch != '.' else None for ch in row] for row in rows]
    write(name, rect_svg(label, px, 'Custom 16x16 texture in vanilla palettes; not a Minecraft item.'),
          pixels_to_img(px))

# ── 3. heads and blocks, 3D inventory renders ───────────────────────────────

ISO_NOTE_REAL = 'Inventory render of the vanilla {} texture.'
ISO_NOTE_CUSTOM = 'Custom texture, rendered the way Minecraft draws blocks in an inventory.'


def head(texture, uv=(0, 0)):
    return iso.Box(arr(texture), uv, (-4, -8, -4), (8, 8, 8))


skeleton = tex('entity/skeleton/skeleton')
img = iso.render([head(skeleton)])
write('skeleton_skull', raster_svg('Skeleton Skull', img, ISO_NOTE_REAL.format('entity/skeleton/skeleton.png')), img)

wither_skel = tex('entity/skeleton/wither_skeleton')
img = iso.render([head(wither_skel)])
write('wither_skull', raster_svg('Wither Skull', img,
                                 ISO_NOTE_REAL.format('entity/skeleton/wither_skeleton.png')), img)

# Herobrine: Steve with the eyes burnt white. Hat layer drawn half a pixel proud, like vanilla.
steve = tex('entity/player/wide/steve')
sa = arr(steve)
face = sa[8:16, 8:16]
for (x, y) in [(1, 4), (2, 4), (5, 4), (6, 4)]:
    face[y, x] = (255, 255, 255, 255)
hero_boxes = [head(Image.fromarray(sa))]
hat = iso.Box(sa, (32, 0), (-4.5, -8.5, -4.5), (9, 9, 9))
# the hat layer is 8x8 per face in the texture even though the box is 9 units: crop by hand
hat.tex_override = {
    'front': sa[8:16, 40:48], 'right': sa[8:16, 48:56], 'top': sa[0:8, 40:48],
}
hero_boxes.append(hat)
img = iso.render(hero_boxes)
write('herobrine_head', raster_svg('Herobrine Head', img,
                                   'Custom texture: vanilla Steve head with the eyes burnt white.'), img)

# Dragon head: vanilla DragonHeadModel geometry and entity/enderdragon/dragon.png.
dragon = arr(tex('entity/enderdragon/dragon'))
dragon_boxes = [
    iso.Box(dragon, (176, 44), (-6, -1, -24), (12, 5, 16)),   # upper lip
    iso.Box(dragon, (112, 30), (-8, -8, -10), (16, 16, 16)),  # upper head
    iso.Box(dragon, (0, 0), (-5, -12, -4), (2, 4, 6), mirror=True),   # scale
    iso.Box(dragon, (112, 0), (-5, -3, -22), (2, 2, 4), mirror=True),  # nostril
    iso.Box(dragon, (0, 0), (3, -12, -4), (2, 4, 6)),
    iso.Box(dragon, (112, 0), (3, -3, -22), (2, 2, 4)),
    iso.Box(dragon, (176, 65), (-6, 4, -24), (12, 4, 16)),    # jaw
]
img = iso.render(dragon_boxes)
write('ender_dragon_head', raster_svg('Ender Dragon Skull', img, ISO_NOTE_REAL.format('entity/enderdragon/dragon.png')), img)


def tiled(texture, w, h, ox=0, oy=0):
    t = arr(texture)
    th, tw = t.shape[:2]
    ys = (np.arange(h) + oy) % th
    xs = (np.arange(w) + ox) % tw
    return t[ys][:, xs]


# Warden Trophy: vanilla warden head and tendrils (with the glow layer) on a gold plinth.
warden = Image.alpha_composite(tex('entity/warden/warden'), tex('entity/warden/warden_bioluminescent_layer'))
wa = arr(warden)
gold = tex('block/gold_block')
blackstone = tex('block/polished_blackstone')
plinth_gold = iso.Box(wa, (0, 0), (-10, 0, -7), (20, 3, 14), faces=['front', 'right', 'top'])
plinth_gold.tex_override = {'front': tiled(gold, 20, 3), 'right': tiled(gold, 14, 3), 'top': tiled(gold, 20, 14)}
plinth_base = iso.Box(wa, (0, 0), (-11, 3, -8), (22, 4, 16), faces=['front', 'right', 'top'])
plinth_base.tex_override = {'front': tiled(blackstone, 22, 4), 'right': tiled(blackstone, 16, 4),
                            'top': tiled(blackstone, 22, 16)}
warden_boxes = [
    iso.Box(wa, (0, 32), (-8, -16, -5), (16, 16, 10)),                        # head
    iso.Box(wa, (52, 32), (-24, -25, 0), (16, 16, 0), faces=['front']),      # right tendril
    iso.Box(wa, (58, 0), (8, -25, 0), (16, 16, 0), faces=['front']),         # left tendril
    plinth_gold, plinth_base,
]
img = iso.render(warden_boxes, fit=272)
write('warden_trophy', raster_svg('Warden Trophy', img,
                                  'Custom: vanilla warden head on a gold and blackstone plinth.'), img)

# Ancient City Vault: reinforced deepslate shell, custom sculk-lock door on the front.
rd_side = arr(tex('block/reinforced_deepslate_side'))
rd_top = arr(tex('block/reinforced_deepslate_top'))
door_pal = {
    'd': '#2d2d2d', 'D': '#3d3d43', 'e': '#515151', 'E': '#646464',
    'k': '#0d1217', 's': '#052a32', 'S': '#034150', 'g': '#009295', 'G': '#29dfeb', 'W': '#cffdff',
}
DOOR = """
..eEEEEEEe..
.eEddddddDe.
eEdkkkkkkdDe
EdkssSSsskDe
Edks.gg.skDe
EdkSgGGgSkDe
EdkSgWWgSkDe
Edks.gg.skDd
EdkssSSsskDd
eDdkkkkkkdDd
.eDDDDDDDDd.
..eddddddd..
"""
front = rd_side.copy()
for y, row in enumerate(DOOR.strip('\n').split('\n')):
    for x, ch in enumerate(row):
        if ch == '.':
            continue
        c = door_pal[ch]
        front[2 + y, 2 + x] = [int(c[i:i + 2], 16) for i in (1, 3, 5)] + [255]
vault = iso.Box(rd_side, (0, 0), (-8, -16, -8), (16, 16, 16))
vault.tex_override = {'front': front, 'right': rd_side, 'top': rd_top}
img = iso.render([vault])
write('ancient_city_vault', raster_svg('Ancient City Vault', img, ISO_NOTE_CUSTOM), img)

# Wither Storm: the vanilla wither's upper body, eyes turned command-block purple, in a purple haze.
wither = arr(tex('entity/wither/wither'))
for (u, v, s) in [(0, 0, 8), (32, 0, 6)]:
    region = wither[v + s:v + 2 * s, u + s:u + 2 * s]
    luma = region[..., :3].astype(float) @ [0.299, 0.587, 0.114]
    bright = (luma > 120) & (region[..., 3] > 0)
    region[bright] = [131, 8, 228, 255]
    region[bright & (luma > 170)] = [207, 160, 243, 255]
storm_boxes = [
    iso.Box(wither, (0, 16), (-10, 3.9, -0.5), (20, 3, 3)),   # shoulders
    iso.Box(wither, (0, 22), (-2, 6.9, -0.5), (3, 10, 3)),    # spine
    iso.Box(wither, (24, 22), (-6, 8.4, 0), (11, 2, 2)),      # ribs
    iso.Box(wither, (24, 22), (-6, 10.9, 0), (11, 2, 2)),
    iso.Box(wither, (0, 0), (-4, -4, -4), (8, 8, 8)),         # centre head
    iso.Box(wither, (32, 0), (-12, 0, -4), (6, 6, 6)),        # right head
    iso.Box(wither, (32, 0), (6, 0, -4), (6, 6, 6)),          # left head
]
img = iso.render(storm_boxes, fit=244)
img = iso.glow(img, (131, 8, 228), radius=12, strength=1.1)
write('wither_storm', raster_svg('Wither Storm', img,
                                 'Custom: vanilla wither body with purple eyes and a purple haze.'), img)

# ── preview sheet ───────────────────────────────────────────────────────────
print('wrote', len(previews), 'icons')
if not PREVIEW:
    sys.exit(0)
cell = 112
names = list(previews)
cols = 6
sheet = Image.new('RGBA', (cols * cell, ((len(names) + cols - 1) // cols) * cell), (38, 40, 51, 255))
for i, n in enumerate(names):
    p = previews[n]
    p = p.resize((96, 96), Image.NEAREST if p.size[0] == 16 else Image.LANCZOS)
    sheet.alpha_composite(p, ((i % cols) * cell + 8, (i // cols) * cell + 8))
sheet.save(PREVIEW)
