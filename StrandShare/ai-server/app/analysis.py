"""Local-only wig attribute suggestions and duplicate detection.

The model is deliberately small enough for the project's RTX 3050 Laptop:
OpenAI CLIP ViT-B/32 runs in fp16 on CUDA and is loaded once. It is used only
for high-confidence suggestions and visual similarity. It never sends an image
to an external inference API.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from io import BytesIO
from typing import Any, Iterable

import httpx
import numpy as np
import torch
from PIL import Image
from transformers import CLIPModel, CLIPProcessor

from .config import settings

log = logging.getLogger(__name__)

AI_ANALYSIS_VERSION = "clip-vit-b32-wig-catalog-1.0"
DUPLICATE_WARNING_THRESHOLD = 0.78
MAX_REMOTE_CANDIDATES = 24
MAX_MATCHES_RETURNED = 8

_model: CLIPModel | None = None
_processor: CLIPProcessor | None = None
_device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
_load_lock = threading.Lock()
_text_feature_cache: dict[tuple[str, ...], torch.Tensor] = {}
_remote_embedding_cache: dict[str, np.ndarray] = {}


@dataclass(frozen=True)
class AttributeSpec:
    field: str
    values: tuple[str, ...]
    prompts: tuple[str, ...]
    minimum_probability: float
    minimum_margin: float


ATTRIBUTE_SPECS = (
    AttributeSpec(
        field="hairColor",
        values=("Black", "Dark Brown", "Light Brown", "Auburn", "Blonde", "Grey"),
        prompts=(
            "a product photo of a black hair wig",
            "a product photo of a dark brown hair wig",
            "a product photo of a light brown hair wig",
            "a product photo of an auburn red-brown hair wig",
            "a product photo of a blonde hair wig",
            "a product photo of a grey silver hair wig",
        ),
        minimum_probability=0.30,
        minimum_margin=0.045,
    ),
    AttributeSpec(
        field="hairTexture",
        values=("Straight", "Wavy", "Curly", "Coily"),
        prompts=(
            "a product photo of a straight hair wig",
            "a product photo of a wavy hair wig",
            "a product photo of a curly hair wig",
            "a product photo of a tightly coiled kinky hair wig",
        ),
        minimum_probability=0.40,
        minimum_margin=0.065,
    ),
    AttributeSpec(
        field="hairDensity",
        values=("Light", "Medium", "Heavy"),
        prompts=(
            "a product photo of a light density thin hair wig",
            "a product photo of a medium density hair wig",
            "a product photo of a heavy density very full hair wig",
        ),
        minimum_probability=0.44,
        minimum_margin=0.075,
    ),
    AttributeSpec(
        field="style",
        values=(
            "Bob",
            "Pixie",
            "Layered",
            "Afro",
            "Braided",
            "Bangs",
            "Side Part",
            "Center Part",
        ),
        prompts=(
            "a product photo of a bob cut wig",
            "a product photo of a short pixie cut wig",
            "a product photo of a layered haircut wig",
            "a product photo of an afro wig",
            "a product photo of a braided wig",
            "a product photo of a wig with bangs",
            "a product photo of a side part wig",
            "a product photo of a center part wig",
        ),
        minimum_probability=0.27,
        minimum_margin=0.035,
    ),
    AttributeSpec(
        field="hairLength",
        values=("8", "14", "20", "26"),
        prompts=(
            "a product photo of a short hair wig above the chin",
            "a product photo of a medium shoulder length hair wig",
            "a product photo of a long hair wig below the shoulders",
            "a product photo of an extra long hair wig",
        ),
        minimum_probability=0.37,
        minimum_margin=0.055,
    ),
)


def _load_model() -> tuple[CLIPModel, CLIPProcessor]:
    global _model, _processor
    if _model is not None and _processor is not None:
        return _model, _processor

    with _load_lock:
        if _model is not None and _processor is not None:
            return _model, _processor

        log.info("Loading local CLIP model %s on %s...", settings.clip_model, _device)
        dtype = torch.float16 if _device.type == "cuda" else torch.float32
        _processor = CLIPProcessor.from_pretrained(
            settings.clip_model,
            local_files_only=settings.local_models_only,
        )
        _model = CLIPModel.from_pretrained(
            settings.clip_model,
            torch_dtype=dtype,
            local_files_only=settings.local_models_only,
        ).to(_device)
        _model.eval()
        log.info("Local CLIP model ready.")
        return _model, _processor


def _opaque_for_clip(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    # Neutral light background prevents transparent pixels from becoming black
    # and biasing dark-color predictions.
    background = Image.new("RGBA", rgba.size, (242, 242, 240, 255))
    background.alpha_composite(rgba)
    return background.convert("RGB")


def _normalize_tensor(features: torch.Tensor) -> torch.Tensor:
    return features / features.norm(dim=-1, keepdim=True).clamp(min=1e-8)


def _encode_images(images: Iterable[Image.Image]) -> np.ndarray:
    model, processor = _load_model()
    prepared = [_opaque_for_clip(image) for image in images]
    inputs = processor(images=prepared, return_tensors="pt")
    pixel_values = inputs["pixel_values"].to(_device)
    if _device.type == "cuda":
        pixel_values = pixel_values.to(dtype=torch.float16)
    with torch.inference_mode():
        features = _normalize_tensor(model.get_image_features(pixel_values=pixel_values))
    return features.detach().float().cpu().numpy()


def _text_features(prompts: tuple[str, ...]) -> torch.Tensor:
    cached = _text_feature_cache.get(prompts)
    if cached is not None:
        return cached

    model, processor = _load_model()
    inputs = processor(text=list(prompts), padding=True, return_tensors="pt")
    text_inputs = {key: value.to(_device) for key, value in inputs.items()}
    with torch.inference_mode():
        features = _normalize_tensor(model.get_text_features(**text_inputs))
    _text_feature_cache[prompts] = features
    return features


def _classify(image_embedding: np.ndarray, spec: AttributeSpec) -> dict[str, Any] | None:
    image_tensor = torch.from_numpy(image_embedding).to(_device)
    if _device.type == "cuda":
        image_tensor = image_tensor.to(dtype=torch.float16)
    logits = 100.0 * image_tensor @ _text_features(spec.prompts).T
    probabilities = torch.softmax(logits.float(), dim=-1)
    top_values, top_indices = torch.topk(probabilities, k=min(2, len(spec.values)))
    top_probability = float(top_values[0].item())
    margin = top_probability - (float(top_values[1].item()) if len(top_values) > 1 else 0.0)
    if top_probability < spec.minimum_probability or margin < spec.minimum_margin:
        return None

    value = spec.values[int(top_indices[0].item())]
    return {
        "value": value,
        "confidence": round(top_probability, 4),
        "margin": round(margin, 4),
        "source": "local_ai",
    }


def _normalize_text(value: Any) -> str:
    return " ".join(str(value or "").strip().lower().replace("-", " ").split())


def _token_similarity(left: Any, right: Any) -> float:
    a = set(_normalize_text(left).split())
    b = set(_normalize_text(right).split())
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _attribute_similarity(candidate: dict[str, Any], attributes: dict[str, Any]) -> tuple[float, list[str]]:
    comparisons = (
        ("hairTexture", "hairTexture", 0.27, "texture"),
        ("hairColor", "hairColor", 0.19, "color"),
        ("hairDensity", "hairDensity", 0.14, "density"),
        ("capSize", "capSize", 0.13, "cap size"),
        ("style", "style", 0.20, "style"),
        ("hairLength", "hairLength", 0.07, "length"),
    )
    weighted_score = 0.0
    available_weight = 0.0
    same: list[str] = []

    candidate_attributes = candidate.get("attributes") or {}
    for candidate_key, current_key, weight, label in comparisons:
        current = attributes.get(current_key)
        existing = candidate_attributes.get(candidate_key)
        if current in (None, "") or existing in (None, ""):
            continue
        available_weight += weight
        if current_key == "style":
            score = _token_similarity(current, existing)
        elif current_key == "hairLength":
            try:
                delta = abs(float(current) - float(existing))
                score = max(0.0, 1.0 - (delta / 12.0))
            except (TypeError, ValueError):
                score = 0.0
        else:
            score = 1.0 if _normalize_text(current) == _normalize_text(existing) else 0.0
        weighted_score += weight * score
        if score >= 0.95:
            same.append(label)

    if available_weight <= 0:
        return 0.0, same
    return weighted_score / available_weight, same


def _safe_embedding(value: Any) -> np.ndarray | None:
    if not isinstance(value, list) or len(value) < 32:
        return None
    try:
        embedding = np.asarray(value, dtype=np.float32).reshape(-1)
    except (TypeError, ValueError):
        return None
    norm = float(np.linalg.norm(embedding))
    if not np.isfinite(norm) or norm <= 1e-8:
        return None
    return embedding / norm


def _download_candidate_image(url: str) -> Image.Image | None:
    try:
        response = httpx.get(url, timeout=7.0, follow_redirects=True)
        response.raise_for_status()
        if len(response.content) > 15 * 1024 * 1024:
            return None
        return Image.open(BytesIO(response.content)).convert("RGBA")
    except Exception as exc:  # noqa: BLE001
        log.debug("Could not load inventory candidate %s: %s", url, exc)
        return None


def _backfill_remote_embeddings(
    inventory: list[dict[str, Any]],
    attributes: dict[str, Any],
) -> None:
    missing: list[tuple[dict[str, Any], str, Image.Image]] = []
    ranked = sorted(
        inventory,
        key=lambda row: _attribute_similarity(row, attributes)[0],
        reverse=True,
    )
    for row in ranked:
        if _safe_embedding(row.get("embedding")) is not None:
            continue
        url = str(row.get("imageUrl") or "").strip()
        if not url:
            continue
        cached = _remote_embedding_cache.get(url)
        if cached is not None:
            row["embedding"] = cached.tolist()
            continue
        image = _download_candidate_image(url)
        if image is not None:
            missing.append((row, url, image))
        if len(missing) >= MAX_REMOTE_CANDIDATES:
            break

    if not missing:
        return

    embeddings = _encode_images(item[2] for item in missing)
    for (row, url, _), embedding in zip(missing, embeddings):
        normalized = embedding / max(float(np.linalg.norm(embedding)), 1e-8)
        _remote_embedding_cache[url] = normalized
        row["embedding"] = normalized.tolist()

    # A bounded in-memory cache keeps repeat checks fast without growing
    # forever on a long-running workstation.
    if len(_remote_embedding_cache) > 256:
        for old_key in list(_remote_embedding_cache)[:64]:
            _remote_embedding_cache.pop(old_key, None)


def _duplicate_matches(
    image_embedding: np.ndarray,
    inventory: list[dict[str, Any]],
    attributes: dict[str, Any],
) -> list[dict[str, Any]]:
    _backfill_remote_embeddings(inventory, attributes)
    matches: list[dict[str, Any]] = []

    for row in inventory:
        existing_embedding = _safe_embedding(row.get("embedding"))
        attribute_score, same_attributes = _attribute_similarity(row, attributes)
        raw_cosine: float | None = None
        visual_score: float | None = None
        if existing_embedding is not None and existing_embedding.shape == image_embedding.shape:
            raw_cosine = float(np.dot(image_embedding, existing_embedding))
            # CLIP similarities for unrelated product photos are already
            # positive. Re-map the useful 0.62..0.94 range to 0..1.
            visual_score = max(0.0, min(1.0, (raw_cosine - 0.62) / 0.32))

        if visual_score is None:
            combined = 0.55 * attribute_score
        else:
            combined = (0.72 * visual_score) + (0.28 * attribute_score)

        if combined < 0.48 and (raw_cosine is None or raw_cosine < 0.72):
            continue

        reason_parts: list[str] = []
        if raw_cosine is not None:
            reason_parts.append(f"{round(raw_cosine * 100)}% visual similarity")
        if same_attributes:
            reason_parts.append("same " + ", ".join(same_attributes[:3]))

        matches.append(
            {
                "wigId": row.get("wigId"),
                "wigName": row.get("wigName") or "Unnamed wig",
                "wigCode": row.get("wigCode"),
                "imageUrl": row.get("imageUrl"),
                "score": round(combined, 4),
                "visualSimilarity": round(raw_cosine, 4) if raw_cosine is not None else None,
                "attributeSimilarity": round(attribute_score, 4),
                "attributes": row.get("attributes") or {},
                "reason": "; ".join(reason_parts) or "similar entered attributes",
                "requiresConfirmation": combined >= DUPLICATE_WARNING_THRESHOLD,
            }
        )

    matches.sort(key=lambda item: item["score"], reverse=True)
    return matches[:MAX_MATCHES_RETURNED]


def _effective_attributes(
    entered: dict[str, Any],
    suggestions: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    out = dict(entered or {})
    for field, suggestion in suggestions.items():
        if field == "wigName":
            continue
        if out.get(field) in (None, "") and isinstance(suggestion, dict):
            out[field] = suggestion.get("value")
    return out


def _suggest_wig_name(suggestions: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    color = suggestions.get("hairColor")
    texture = suggestions.get("hairTexture")
    if not color or not texture:
        return None

    length_value = suggestions.get("hairLength", {}).get("value")
    try:
        inches = int(length_value)
    except (TypeError, ValueError):
        inches = 0
    length_word = "Short" if inches and inches <= 10 else "Medium" if inches <= 16 else "Long" if inches else ""
    style = suggestions.get("style", {}).get("value", "")
    parts = [length_word, style, texture["value"], color["value"]]
    name = " ".join(dict.fromkeys(part for part in parts if part))
    confidence = min(float(color["confidence"]), float(texture["confidence"]))
    return {
        "value": name,
        "confidence": round(confidence, 4),
        "source": "derived_from_local_ai",
    }


def analyze_wig(
    isolated_wig_path: str,
    *,
    inventory: list[dict[str, Any]] | None = None,
    entered_attributes: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return high-confidence suggestions, an embedding, and duplicate matches."""
    image = Image.open(isolated_wig_path).convert("RGBA")
    embedding = _encode_images([image])[0]
    embedding = embedding / max(float(np.linalg.norm(embedding)), 1e-8)

    suggestions: dict[str, dict[str, Any]] = {}
    for spec in ATTRIBUTE_SPECS:
        result = _classify(embedding, spec)
        if result is not None:
            suggestions[spec.field] = result

    name = _suggest_wig_name(suggestions)
    if name is not None:
        suggestions["wigName"] = name

    effective = _effective_attributes(entered_attributes or {}, suggestions)
    inventory_rows = [dict(row) for row in (inventory or []) if isinstance(row, dict)]
    matches = _duplicate_matches(embedding, inventory_rows, effective)

    return {
        "suggestions": suggestions,
        "embedding": [round(float(value), 6) for value in embedding.tolist()],
        "duplicateMatches": matches,
        "analysisModelVersion": AI_ANALYSIS_VERSION,
    }


def warm_up_analysis() -> None:
    """Load CLIP weights without making any network inference request."""
    _load_model()

