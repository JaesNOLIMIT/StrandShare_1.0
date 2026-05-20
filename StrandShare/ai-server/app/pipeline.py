"""Wig AI Studio pipeline -- 2D layered output.

We no longer generate a 3D mesh. Instead, from the uploaded reference photo(s)
plus the wig specs, we produce 5 PNG layers that the editor composites on top
of the user's webcam feed:

    full_wig     -- entire wig with background removed
    back_hair    -- back / nape hair (from the back photo when supplied,
                    otherwise the lower portion of the front photo)
    front_bangs  -- bangs / forehead region (upper portion of full_wig)
    hair_mask    -- white-on-black silhouette of the hair area
    face_mask    -- a face oval used for occlusion (so back_hair sits behind
                    the user's face in the final composite)

Models used: rembg / U2Net for background removal. Everything else is plain
numpy + Pillow. This runs comfortably on a 4 GB GPU or even CPU.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from .config import settings

log = logging.getLogger(__name__)

AI_MODEL_VERSION = "rembg-layered-1.4-mannequin-color-pass"

# Reasonable output size for the layers. Bigger = sharper but heavier to
# stream to mobile. 1024 is a good sweet spot.
OUTPUT_MAX_SIDE = 1024           # cap any axis at this many pixels
INPUT_REMBG_MAX_SIDE = 768       # downscale source photos to this before rembg (RAM-bound)
BANGS_TOP_FRACTION = 0.42        # top 42% of the wig becomes the front bangs layer
BACK_HAIR_FRACTION = 0.65        # bottom 65% becomes back hair (when no back photo)
SIDE_BLEND_STRENGTH = 0.62       # contribution of side photo into full_wig
HAIR_MASK_BLUR_RADIUS = 6
TIGHT_CROP_PADDING = 12          # px of transparent padding kept around the wig
ALPHA_THRESHOLD = 24             # anything below this alpha is treated as empty
HARD_ALPHA_KEEP = 178            # final hard cutoff -- ghost pixels below this go to 0
HARD_ALPHA_FULL = 224            # anything above becomes fully opaque
MANNEQUIN_LUM_MIN = 142          # pixels brighter than this in central band are candidates
MANNEQUIN_CHROMA_MAX = 42        # AND closer to neutral than this (grey/beige plastic is low chroma)

_rembg_session = None

# MediaPipe is optional. When installed, we use it to detect any face left in
# the rembg output and zero its alpha (removes mannequin head from wig product
# shots). If it's missing the pipeline still runs; the user just has to upload
# cleaner photos.
try:
    import mediapipe as mp  # type: ignore
    _MP_FACE_DETECTION = mp.solutions.face_detection
except Exception:  # pragma: no cover
    _MP_FACE_DETECTION = None


# ---------------------------------------------------------------------------
# Inputs / outputs
# ---------------------------------------------------------------------------
@dataclass
class WigSpec:
    hair_color: Optional[str] = None
    hair_texture: Optional[str] = None
    hair_density: Optional[str] = None
    cap_size: Optional[str] = None
    style: Optional[str] = None
    hair_length: Optional[float] = None


@dataclass
class PipelineInputs:
    front_path: Path
    side_path: Path
    top_path: Optional[Path] = None
    back_path: Optional[Path] = None
    spec: WigSpec = field(default_factory=WigSpec)


@dataclass
class PipelineOutputs:
    layers: Dict[str, Path]   # layer_key -> local PNG path
    ai_model_version: str = AI_MODEL_VERSION


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _load_rembg_session():
    global _rembg_session
    if _rembg_session is not None:
        return _rembg_session
    from rembg import new_session
    model_name = settings.rembg_model
    log.info("Loading rembg weights (model=%s)...", model_name)
    try:
        _rembg_session = new_session(model_name)
    except Exception as exc:  # noqa: BLE001
        log.warning("rembg model %s failed (%s); falling back to u2net.", model_name, exc)
        _rembg_session = new_session("u2net")
    return _rembg_session


def _remove_background(image: Image.Image) -> Image.Image:
    """Return an RGBA image with the wig isolated on a transparent background.

    Downscales the input to INPUT_REMBG_MAX_SIDE before rembg so the model
    fits in RAM (a 4000 px photo would OOM the model on a 16 GB machine).

    Alpha matting is intentionally DISABLED: pymatting's closed-form solver
    builds a sparse Laplacian whose index arrays explode to >1 GB even at
    ~900 px and OOMs. BiRefNet already produces clean alpha edges natively,
    and `_hard_threshold_alpha` downstream removes any remaining ghost pixels,
    so matting buys us nothing here but crashes.
    """
    from rembg import remove
    session = _load_rembg_session()
    work = _downscale_max(image.convert("RGBA"), INPUT_REMBG_MAX_SIDE)
    rgba = remove(work, session=session, alpha_matting=False)
    if rgba.mode != "RGBA":
        rgba = rgba.convert("RGBA")
    return rgba


def _tight_crop_rgba(rgba: Image.Image) -> Image.Image:
    """Crop the image to the bounding box of its non-transparent pixels.

    Critical for correct on-face scaling: the frontend scales the layer to a
    factor of the user's face width, so if the PNG has lots of empty padding
    the visible wig ends up far smaller than intended.
    """
    alpha = np.array(rgba.split()[3])
    mask = alpha > ALPHA_THRESHOLD
    if not mask.any():
        return rgba
    ys, xs = np.where(mask)
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0 = max(0, y0 - TIGHT_CROP_PADDING)
    y1 = min(rgba.height, y1 + TIGHT_CROP_PADDING)
    x0 = max(0, x0 - TIGHT_CROP_PADDING)
    x1 = min(rgba.width, x1 + TIGHT_CROP_PADDING)
    return rgba.crop((x0, y0, x1, y1))


def _downscale_max(rgba: Image.Image, max_side: int = OUTPUT_MAX_SIDE) -> Image.Image:
    """Downscale so the longest side is `max_side`; smaller images unchanged."""
    longest = max(rgba.width, rgba.height)
    if longest <= max_side:
        return rgba
    scale = max_side / longest
    new_w = max(1, int(rgba.width * scale))
    new_h = max(1, int(rgba.height * scale))
    return rgba.resize((new_w, new_h), Image.LANCZOS)


def _detect_faces(rgb: np.ndarray):
    """Run MediaPipe face detection with both close-range and full-range
    models, deduplicating overlapping detections. Returns a list of relative
    bounding boxes (xmin, ymin, width, height) in [0, 1]."""
    if _MP_FACE_DETECTION is None:
        return []
    all_boxes = []
    for model_selection in (0, 1):  # short range + full range
        try:
            with _MP_FACE_DETECTION.FaceDetection(
                model_selection=model_selection,
                min_detection_confidence=0.15,
            ) as fd:
                results = fd.process(rgb)
        except Exception as exc:  # noqa: BLE001
            log.warning("face detection skipped (model=%s): %s", model_selection, exc)
            continue
        for det in getattr(results, "detections", None) or []:
            b = det.location_data.relative_bounding_box
            all_boxes.append((b.xmin, b.ymin, b.width, b.height))

    # Deduplicate: if two boxes overlap > 60%, keep the larger.
    kept = []
    for box in sorted(all_boxes, key=lambda b: -(b[2] * b[3])):
        x1a, y1a, wa, ha = box
        x2a, y2a = x1a + wa, y1a + ha
        overlapping = False
        for keep in kept:
            x1b, y1b, wb, hb = keep
            x2b, y2b = x1b + wb, y1b + hb
            ix = max(0.0, min(x2a, x2b) - max(x1a, x1b))
            iy = max(0.0, min(y2a, y2b) - max(y1a, y1b))
            inter = ix * iy
            union = wa * ha + wb * hb - inter
            if union > 0 and inter / union > 0.5:
                overlapping = True
                break
        if not overlapping:
            kept.append(box)
    return kept


def _remove_mannequin_face(rgba: Image.Image) -> Image.Image:
    """Detect any face still left in the image and zero out its alpha.

    Wig product photos typically show a mannequin head wearing the wig. After
    background removal, the mannequin's plastic face/neck is still part of
    the foreground. We detect any face and erase it (plus a margin downward
    to cover the neck/shoulders) so only the hair survives.

    No-op when MediaPipe isn't installed.
    """
    if _MP_FACE_DETECTION is None:
        return rgba

    rgb = np.array(rgba.convert("RGB"))
    h, w = rgb.shape[:2]
    boxes = _detect_faces(rgb)
    if not boxes:
        return rgba

    out = np.array(rgba)
    for (xmin, ymin, bw_rel, bh_rel) in boxes:
        x = int(max(0, xmin * w))
        y = int(max(0, ymin * h))
        bw = int(bw_rel * w)
        bh = int(bh_rel * h)
        # Generous padding: covers ears sideways, chin/neck/shoulders below,
        # and any forehead skin above. Aggressive on purpose -- a few extra
        # transparent pixels in the bang area look much better than leaving
        # a dark ghost of the mannequin in the middle of the user's face.
        x_pad = int(bw * 0.28)
        y_pad_top = int(bh * 0.18)
        y_pad_bot = int(bh * 0.95)
        x0 = max(0, x - x_pad)
        y0 = max(0, y - y_pad_top)
        x1 = min(w, x + bw + x_pad)
        y1 = min(h, y + bh + y_pad_bot)

        # Soft edge so the bangs above don't get a hard horizontal cut.
        feather = max(4, int(bh * 0.08))
        block = np.ones((y1 - y0, x1 - x0), dtype=np.float32)
        # Vertical fade at the top of the block (smooth into bangs)
        if feather > 0 and feather < block.shape[0]:
            ramp = np.linspace(0.0, 1.0, feather).reshape(-1, 1)
            block[:feather] *= ramp
        # Horizontal fade on both sides
        if feather > 0 and 2 * feather < block.shape[1]:
            xr = np.linspace(0.0, 1.0, feather).reshape(1, -1)
            block[:, :feather] *= xr
            block[:, -feather:] *= xr[:, ::-1]

        existing = out[y0:y1, x0:x1, 3].astype(np.float32)
        keep_factor = 1.0 - block  # 0 inside the block, 1 outside
        out[y0:y1, x0:x1, 3] = np.clip(existing * keep_factor, 0, 255).astype(np.uint8)

    log.info("[pipeline] removed %d face region(s) from foreground", len(boxes))
    return Image.fromarray(out, mode="RGBA")


def _remove_mannequin_skin(rgba: Image.Image) -> Image.Image:
    """Color-based mannequin / skin removal.

    Catches the kind of mannequin face that MediaPipe missed because it has
    no features (smooth white / beige plastic head). Looks for pixels that:
      - are bright (luminance >= MANNEQUIN_LUM_MIN)
      - have low chroma (close to neutral / grey / pastel beige)
      - are currently foreground (alpha > 100)
      - sit in the central vertical band of the image (where a face would be)
    and erases them.

    Aggressive on purpose -- the user can always paint hair back in with the
    Layer Eraser if it goes too far, but a mannequin face visible through the
    wig is worse than a slightly over-eroded edge.
    """
    arr = np.array(rgba).copy()
    rgb = arr[..., :3].astype(np.float32)
    alpha = arr[..., 3]
    if alpha.max() < 100:
        return rgba

    lum = (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2])
    chroma = rgb.max(axis=-1) - rgb.min(axis=-1)

    bright_neutral = (lum >= MANNEQUIN_LUM_MIN) & (chroma <= MANNEQUIN_CHROMA_MAX)
    foreground = alpha > 100
    mask_full = bright_neutral & foreground

    h, w = arr.shape[:2]
    # Restrict to the central band where a mannequin face / neck / stand sits.
    # Full height downward so we also catch the neck base / display stand that
    # hangs below the chin (the grey block users were seeing under the wig).
    band_top = int(h * 0.08)
    band_bot = h
    band_lft = int(w * 0.12)
    band_rgt = int(w * 0.88)
    band_mask = np.zeros_like(mask_full, dtype=bool)
    band_mask[band_top:band_bot, band_lft:band_rgt] = True
    mask = mask_full & band_mask

    pixel_count = int(mask.sum())
    if pixel_count < (h * w * 0.0015):
        # Not enough connected bright-neutral pixels -- nothing to do (avoids
        # eating into legitimate hair highlights on, e.g., blonde wigs).
        return rgba

    # Smooth the mask edges so we feather into the surrounding hair instead of
    # leaving a sharp transparent cut-out.
    mask_img = Image.fromarray((mask * 255).astype(np.uint8), mode="L")
    mask_img = mask_img.filter(ImageFilter.GaussianBlur(radius=4))
    mask_f = np.array(mask_img, dtype=np.float32) / 255.0

    new_alpha = alpha.astype(np.float32) * (1.0 - mask_f)
    arr[..., 3] = np.clip(new_alpha, 0, 255).astype(np.uint8)

    log.info("[pipeline] mannequin-skin color pass cleared ~%d px", pixel_count)
    return Image.fromarray(arr, mode="RGBA")


def _hard_threshold_alpha(rgba: Image.Image) -> Image.Image:
    """Drop ghost / semi-transparent pixels.

    Anything below HARD_ALPHA_KEEP becomes fully transparent; anything above
    HARD_ALPHA_FULL becomes fully opaque; the band between is rescaled. This
    removes the dark halos that appear in the center of the face when rembg
    leaves low-opacity wig pixels covering skin.
    """
    arr = np.array(rgba, dtype=np.uint8)
    alpha = arr[..., 3].astype(np.float32)
    span = max(1.0, float(HARD_ALPHA_FULL - HARD_ALPHA_KEEP))
    rescaled = np.clip((alpha - HARD_ALPHA_KEEP) / span * 255.0, 0.0, 255.0)
    arr[..., 3] = rescaled.astype(np.uint8)
    return Image.fromarray(arr, mode="RGBA")


def _crop_horizontal_band(rgba: Image.Image, top_frac: float, bottom_frac: float) -> Image.Image:
    """Return a copy with everything outside [top_frac, bottom_frac] alpha-cleared."""
    w, h = rgba.size
    mask = Image.new("L", (w, h), 0)
    y0 = int(h * top_frac)
    y1 = int(h * bottom_frac)
    draw = ImageDraw.Draw(mask)
    draw.rectangle((0, y0, w, y1), fill=255)
    # Soft transition so the slice doesn't have a hard edge.
    mask = mask.filter(ImageFilter.GaussianBlur(radius=12))

    out = rgba.copy()
    r, g, b, a = out.split()
    a = Image.fromarray(np.minimum(np.array(a), np.array(mask)).astype(np.uint8))
    out = Image.merge("RGBA", (r, g, b, a))
    return out


def _scale_alpha(rgba: Image.Image, factor: float) -> Image.Image:
    """Multiply image alpha by factor in [0..1]."""
    f = float(max(0.0, min(1.0, factor)))
    if f == 1.0:
        return rgba
    arr = np.array(rgba, dtype=np.uint8)
    alpha = arr[..., 3].astype(np.float32) * f
    arr[..., 3] = np.clip(alpha, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, mode="RGBA")


def _inject_side_volume(full_wig: Image.Image, side_rgba: Optional[Image.Image]) -> Image.Image:
    """Blend side-photo texture into outer edges of full_wig.

    This gives the frontend more side information when the user turns their
    head, without changing the schema (still one full_wig PNG layer).
    """
    if side_rgba is None:
        return full_wig
    if side_rgba.width < 4 or side_rgba.height < 4:
        return full_wig

    base = full_wig.convert("RGBA")
    target_h = max(1, int(base.height * 0.92))
    scale = target_h / max(1, side_rgba.height)
    target_w = max(1, int(side_rgba.width * scale))
    side = side_rgba.resize((target_w, target_h), Image.LANCZOS)

    # Keep mostly mid/lower hair from the side capture.
    side = _crop_horizontal_band(side, 0.08, 0.98)

    # Create an alpha gradient that keeps only the outward edge of the side
    # asset (helps avoid center-face contamination when composited).
    arr = np.array(side, dtype=np.uint8)
    h, w = arr.shape[:2]
    x = np.linspace(0.0, 1.0, w, dtype=np.float32)
    keep = np.clip((x - 0.35) / 0.65, 0.0, 1.0) ** 0.85
    grad = np.tile((keep * 255.0).astype(np.uint8), (h, 1))
    arr[..., 3] = np.minimum(arr[..., 3], grad)
    right_band = Image.fromarray(arr, mode="RGBA")
    left_band = right_band.transpose(Image.FLIP_LEFT_RIGHT)

    y = max(0, int((base.height - target_h) * 0.52))
    left_x = -int(base.width * 0.02)
    right_x = base.width - target_w + int(base.width * 0.02)

    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    overlay.alpha_composite(left_band, (left_x, y))
    overlay.alpha_composite(right_band, (right_x, y))
    overlay = _scale_alpha(overlay, SIDE_BLEND_STRENGTH)
    return Image.alpha_composite(base, overlay)


def _alpha_to_mask_png(rgba: Image.Image) -> Image.Image:
    """White-on-black mask from the RGBA alpha channel, lightly blurred."""
    alpha = rgba.split()[3]
    arr = np.array(alpha, dtype=np.uint8)
    # Threshold then blur for clean silhouette edges.
    arr = (arr > 32).astype(np.uint8) * 255
    mask_img = Image.fromarray(arr, mode="L")
    mask_img = mask_img.filter(ImageFilter.GaussianBlur(radius=HAIR_MASK_BLUR_RADIUS))
    # Composite to RGBA: white where mask, transparent elsewhere.
    out = Image.new("RGBA", mask_img.size, (255, 255, 255, 0))
    out.putalpha(mask_img)
    # Re-fill RGB to white so the mask renders as a solid white silhouette.
    r = Image.new("L", mask_img.size, 255)
    out = Image.merge("RGBA", (r, r, r, mask_img))
    return out


def _generic_face_mask(side: int = OUTPUT_MAX_SIDE) -> Image.Image:
    """A reusable face-oval mask centred on a square canvas.

    The mobile/editor client positions this layer using the user's actual face
    landmarks at render time -- the asset just needs to be a generic oval.
    """
    img = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx, cy = side // 2, side // 2
    rx, ry = int(side * 0.27), int(side * 0.36)
    draw.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=(255, 255, 255, 255))
    img = img.filter(ImageFilter.GaussianBlur(radius=18))
    return img


def _tint_by_color_name(rgba: Image.Image, color_name: Optional[str]) -> Image.Image:
    """Optional: apply a subtle tint based on the user-entered hair color."""
    if not color_name:
        return rgba
    tint_map = {
        "black":       (24, 22, 22),
        "dark brown":  (60, 36, 25),
        "light brown": (120, 84, 56),
        "auburn":      (148, 70, 36),
        "blonde":      (212, 178, 122),
        "grey":        (164, 164, 164),
    }
    target = tint_map.get(color_name.strip().lower())
    if target is None:
        return rgba

    arr = np.array(rgba).astype(np.float32)
    rgb = arr[..., :3]
    alpha = arr[..., 3:4] / 255.0
    # Convert to luminance and multiply by target tint so the texture survives.
    lum = (0.299 * rgb[..., 0:1] + 0.587 * rgb[..., 1:2] + 0.114 * rgb[..., 2:3]) / 255.0
    tinted = lum * np.array(target, dtype=np.float32).reshape(1, 1, 3)
    blended = rgb * (1.0 - 0.55) + tinted * 0.55  # 55% tint blend
    out = np.concatenate([blended, alpha * 255.0], axis=-1)
    out = np.clip(out, 0, 255).astype(np.uint8)
    return Image.fromarray(out, mode="RGBA")


# ---------------------------------------------------------------------------
# Pipeline entry point
# ---------------------------------------------------------------------------
def run_pipeline(inputs: PipelineInputs, work_dir: Path) -> PipelineOutputs:
    work_dir.mkdir(parents=True, exist_ok=True)

    log.info("[pipeline] reading front image %s", inputs.front_path)
    front = Image.open(inputs.front_path).convert("RGBA")

    log.info("[pipeline] background removal (front)")
    front_rgba = _remove_background(front)
    front_rgba = _remove_mannequin_face(front_rgba)
    front_rgba = _remove_mannequin_skin(front_rgba)
    front_rgba = _hard_threshold_alpha(front_rgba)
    front_rgba = _tint_by_color_name(front_rgba, inputs.spec.hair_color)
    full_wig = _downscale_max(_tight_crop_rgba(front_rgba))

    # NOTE: side-photo volume injection was removed -- it composited the side
    # photo (mannequin + background) at partial opacity onto the wig edges,
    # which showed up as a grey halo around the wig. We now keep only the
    # cleanly-extracted front wig.

    log.info("[pipeline] cutting front_bangs from upper portion")
    front_bangs = _tight_crop_rgba(
        _crop_horizontal_band(full_wig, 0.0, BANGS_TOP_FRACTION)
    )

    log.info("[pipeline] preparing back_hair")
    if inputs.back_path and inputs.back_path.exists():
        back_raw = Image.open(inputs.back_path).convert("RGBA")
        back_rgba = _remove_background(back_raw)
        back_rgba = _remove_mannequin_face(back_rgba)
        back_rgba = _remove_mannequin_skin(back_rgba)
        back_rgba = _hard_threshold_alpha(back_rgba)
        back_rgba = _tint_by_color_name(back_rgba, inputs.spec.hair_color)
        back_hair = _downscale_max(_tight_crop_rgba(back_rgba))
    else:
        # Use the lower portion of the front wig WITHOUT a horizontal flip --
        # the mirror flip looked wrong when the user turned sideways because
        # the runtime renderer already mirrors the camera feed; flipping the
        # source on top of that double-mirrored the layer.
        back_hair = _tight_crop_rgba(
            _crop_horizontal_band(full_wig, 1.0 - BACK_HAIR_FRACTION, 1.0)
        )

    log.info("[pipeline] building hair_mask + face_mask")
    hair_mask = _alpha_to_mask_png(full_wig)
    face_mask = _generic_face_mask()

    log.info("[pipeline] writing PNGs")
    layer_files = {
        "full_wig":    work_dir / "full_wig.png",
        "back_hair":   work_dir / "back_hair.png",
        "front_bangs": work_dir / "front_bangs.png",
        "hair_mask":   work_dir / "hair_mask.png",
        "face_mask":   work_dir / "face_mask.png",
    }
    full_wig.save(layer_files["full_wig"],       "PNG", optimize=True)
    back_hair.save(layer_files["back_hair"],     "PNG", optimize=True)
    front_bangs.save(layer_files["front_bangs"], "PNG", optimize=True)
    hair_mask.save(layer_files["hair_mask"],     "PNG", optimize=True)
    face_mask.save(layer_files["face_mask"],     "PNG", optimize=True)

    return PipelineOutputs(layers=layer_files)


def warm_up() -> None:
    """Pre-load rembg so the first request isn't slow."""
    try:
        _load_rembg_session()
    except Exception as exc:  # noqa: BLE001
        log.warning("rembg warm-up failed (will retry on first request): %s", exc)
