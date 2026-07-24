"""Environment-backed configuration for the Wig AI server.

Values come from the `.env` file mounted by docker-compose. We do *not* default
the Supabase credentials -- the server should fail fast at startup if they are
missing rather than silently mis-write rows.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# Auto-load .env from the ai-server/ directory when running locally. In Docker
# the compose env_file directive injects these directly, so dotenv is a no-op.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass


def _required(key: str) -> str:
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(f"Required environment variable {key} is not set")
    return value


def _int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    return int(raw)


def _float(key: str, default: float) -> float:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    return float(raw)


def _bool(key: str, default: bool) -> bool:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    supabase_url: str
    supabase_service_role_key: str
    sources_bucket: str
    filters_bucket: str

    rembg_model: str
    clip_model: str
    local_models_only: bool
    max_upload_mb: int

    triposr_mc_resolution: int
    triposr_foreground_ratio: float
    triposr_render_resolution: int
    triposr_fp16: bool

    allowed_origins: tuple[str, ...]


def load_settings() -> Settings:
    return Settings(
        supabase_url=_required("SUPABASE_URL"),
        supabase_service_role_key=_required("SUPABASE_SERVICE_ROLE_KEY"),
        sources_bucket=os.environ.get("WIG_AI_SOURCES_BUCKET", "wig_ai_sources"),
        filters_bucket=os.environ.get("WIG_AI_FILTERS_BUCKET", "wig_ai_filters"),
        # BiRefNet General keeps fine hair strands while working well for both
        # mannequin and flat-lay product photos. It runs through ONNX locally.
        rembg_model=os.environ.get("REMBG_MODEL", "birefnet-general"),
        clip_model=os.environ.get("CLIP_MODEL", "openai/clip-vit-base-patch32"),
        # Set to 1 only after the model files have been downloaded once.
        local_models_only=_bool("LOCAL_MODELS_ONLY", False),
        max_upload_mb=_int("MAX_UPLOAD_MB", 15),
        triposr_mc_resolution=_int("TRIPOSR_MC_RESOLUTION", 192),
        triposr_foreground_ratio=_float("TRIPOSR_FOREGROUND_RATIO", 0.85),
        triposr_render_resolution=_int("TRIPOSR_RENDER_RESOLUTION", 512),
        triposr_fp16=_bool("TRIPOSR_FP16", True),
        allowed_origins=tuple(
            o.strip()
            for o in os.environ.get(
                "ALLOWED_ORIGINS", "http://localhost:3000"
            ).split(",")
            if o.strip()
        ),
    )


settings = load_settings()
