"""Tiny orthographic box renderer that reproduces Minecraft's inventory view.

Boxes use Minecraft's cuboid UV layout (texOffs u,v + size w,h,d) and model space
(x right, y DOWN, z toward the back; the face of a head is the -z side). The camera is
Minecraft's GUI camera: 30 degrees down, 45 degrees around, faces shaded
top 1.0 / left 0.8 / right 0.6 - the same values the existing block renders use.
"""
import math
import numpy as np
from PIL import Image, ImageFilter

SHADE_TOP, SHADE_LEFT, SHADE_RIGHT, SHADE_BOTTOM = 1.0, 0.8, 0.6, 0.5


class Box:
    def __init__(self, tex, uv, origin, size, mirror=False, faces=None, tex_override=None):
        self.tex = tex            # RGBA numpy array (H, W, 4)
        self.u, self.v = uv
        self.x0, self.y0, self.z0 = origin
        self.w, self.h, self.d = size
        self.mirror = mirror
        self.faces = faces        # optional subset of face names
        self.tex_override = tex_override or {}  # face name -> RGBA array replacing the UV crop


def _crop(tex, x, y, w, h):
    return tex[y:y + h, x:x + w]


def box_quads(b):
    """Yield (origin, edge_u, edge_v, texture_tile, shade, normal) in world space.

    World space: X right, Y up, Z toward the viewer's front (the face).
    Model -> world: X = x, Y = -y, Z = -z.
    """
    u, v, w, h, d = b.u, b.v, b.w, b.h, b.d
    X0, X1 = b.x0, b.x0 + w
    Y1, Y0 = -b.y0, -(b.y0 + h)      # Y1 is the top
    Z1, Z0 = -b.z0, -(b.z0 + d)      # Z1 is the front
    T = b.tex
    faces = {
        # front (+Z): texture left edge at X0, top at Y1
        'front': ((X0, Y1, Z1), (w, 0, 0), (0, -h, 0), _crop(T, u + d, v + d, w, h), SHADE_LEFT, (0, 0, 1)),
        # viewer-right side (+X): texture u=0 at the front edge, running to the back
        'right': ((X1, Y1, Z1), (0, 0, -d), (0, -h, 0), _crop(T, u + d + w, v + d, d, h), SHADE_RIGHT, (1, 0, 0)),
        # viewer-left side (-X): texture u=0 at the back
        'left': ((X0, Y1, Z0), (0, 0, d), (0, -h, 0), _crop(T, u, v + d, d, h), SHADE_RIGHT, (-1, 0, 0)),
        # top (+Y): texture v=0 at the back, v=d at the front
        'top': ((X0, Y1, Z0), (w, 0, 0), (0, 0, d), _crop(T, u + d, v, w, d), SHADE_TOP, (0, 1, 0)),
        # back (-Z), seen from behind
        'back': ((X1, Y1, Z0), (-w, 0, 0), (0, -h, 0), _crop(T, u + d + w + d, v + d, w, h), SHADE_LEFT, (0, 0, -1)),
        'bottom': ((X0, Y0, Z1), (w, 0, 0), (0, 0, -d), _crop(T, u + d + w, v, w, d), SHADE_BOTTOM, (0, -1, 0)),
    }
    for name, (o, eu, ev, tile, shade, n) in faces.items():
        if b.faces and name not in b.faces:
            continue
        if name in b.tex_override:
            tile = b.tex_override[name]
        if tile.size == 0:
            continue
        if b.mirror and name in ('front', 'back', 'top', 'bottom'):
            tile = tile[:, ::-1]
        yield np.array(o, float), np.array(eu, float), np.array(ev, float), tile, shade, np.array(n, float)


class Camera:
    def __init__(self, pitch=30.0, yaw=45.0):
        p, y = math.radians(pitch), math.radians(yaw)
        # camera sits at front-right-above, looking toward -X -Z and down
        fwd = np.array([-math.sin(y) * math.cos(p), -math.sin(p), -math.cos(y) * math.cos(p)])
        right = np.cross(fwd, [0, 1, 0]); right /= np.linalg.norm(right)
        up = np.cross(right, fwd); up /= np.linalg.norm(up)
        self.fwd, self.right, self.up = fwd, right, up

    def project(self, P):
        P = np.asarray(P, float)
        return np.array([P @ self.right, -(P @ self.up)]), -(P @ self.fwd)


def _raster(quads, cam, scale, off, S):
    color = np.zeros((S, S, 4), float)
    depth = np.full((S, S), -1e9)
    for o, eu, ev, tile, shade in quads:
        (po, zo), (pu, zu), (pv, zv) = cam.project(o), cam.project(eu), cam.project(ev)
        po = po * scale + off
        pu = pu * scale
        pv = pv * scale
        M = np.array([[pu[0], pv[0]], [pu[1], pv[1]]])
        if abs(np.linalg.det(M)) < 1e-9:
            continue
        Minv = np.linalg.inv(M)
        corners = np.array([po, po + pu, po + pv, po + pu + pv])
        x0, y0 = np.floor(corners.min(0)).astype(int)
        x1, y1 = np.ceil(corners.max(0)).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, S), min(y1, S)
        if x1 <= x0 or y1 <= y0:
            continue
        ys, xs = np.mgrid[y0:y1, x0:x1]
        px = xs + 0.5 - po[0]
        py = ys + 0.5 - po[1]
        s = Minv[0, 0] * px + Minv[0, 1] * py
        t = Minv[1, 0] * px + Minv[1, 1] * py
        inside = (s >= 0) & (s < 1) & (t >= 0) & (t < 1)
        th, tw = tile.shape[:2]
        ti = np.clip((t * th).astype(int), 0, th - 1)
        si = np.clip((s * tw).astype(int), 0, tw - 1)
        texel = tile[ti, si].astype(float)
        opaque = inside & (texel[..., 3] > 0)
        z = zo + s * zu + t * zv
        sub_d = depth[y0:y1, x0:x1]
        win = opaque & (z > sub_d)
        sub_c = color[y0:y1, x0:x1]
        sub_c[win, :3] = texel[..., :3][win] * shade
        sub_c[win, 3] = 255
        sub_d[win] = z[win]
    return color


def render(boxes, size=300, fit=268, ss=4, cam=None, extra_quads=()):
    """Render boxes into a size x size RGBA image whose VISIBLE pixels fill a fit x fit box."""
    cam = cam or Camera()
    quads = []
    for b in boxes:
        for o, eu, ev, tile, shade, n in box_quads(b):
            if n @ (-cam.fwd) <= 1e-6:
                continue  # back face
            quads.append((o, eu, ev, tile, shade))
    quads.extend(extra_quads)
    pts = np.array([cam.project(c)[0] for o, eu, ev, _, _ in quads
                    for c in (o, o + eu, o + ev, o + eu + ev)])
    mn, mx = pts.min(0), pts.max(0)
    # pass 1: fit the geometry, then measure where the opaque texels actually landed
    S1 = 600
    scale1 = S1 * 0.9 / max(mx - mn)
    off1 = np.array([S1 / 2, S1 / 2]) - (mn + mx) / 2 * scale1
    a = _raster(quads, cam, scale1, off1, S1)[..., 3] > 0
    ys, xs = np.nonzero(a)
    vis_mn = (np.array([xs.min(), ys.min()]) - off1) / scale1
    vis_mx = (np.array([xs.max() + 1, ys.max() + 1]) - off1) / scale1
    # pass 2: final supersampled render fitted to the visible extent
    S = size * ss
    scale = fit * ss / max(vis_mx - vis_mn)
    off = np.array([S / 2, S / 2]) - (vis_mn + vis_mx) / 2 * scale
    color = _raster(quads, cam, scale, off, S)
    # premultiplied box downsample so edges do not pick up dark fringes
    alpha = color[..., 3:4] / 255
    pm = np.concatenate([color[..., :3] * alpha, color[..., 3:4]], -1)
    pm = pm.reshape(size, ss, size, ss, 4).mean((1, 3))
    a = pm[..., 3:4]
    rgb = np.where(a > 0, pm[..., :3] / np.maximum(a / 255, 1e-6), 0)
    out = np.concatenate([rgb, a], -1)
    return Image.fromarray(np.clip(out, 0, 255).round().astype(np.uint8), 'RGBA')


def glow(img, rgb, radius=10, strength=0.9):
    """Soft colored aura behind an RGBA render."""
    a = img.split()[3].filter(ImageFilter.GaussianBlur(radius))
    a = a.point(lambda v: int(min(255, v * strength)))
    aura = Image.new('RGBA', img.size, rgb + (0,))
    aura.putalpha(a)
    return Image.alpha_composite(aura, img)
