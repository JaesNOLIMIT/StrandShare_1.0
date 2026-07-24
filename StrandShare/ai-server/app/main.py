"""FastAPI entry point for the Wig AI server.

Endpoints:
  POST /generate-filter   -- enqueue a generation job; returns immediately
  GET  /status/{filter_id} -- read current row from Wig_AI_Filters
  GET  /health             -- liveness probe used by docker-compose healthcheck

The frontend can either poll /status or subscribe to the Wig_AI_Filters row
directly via Supabase Realtime; both work because every state transition is
written to the DB by `supabase_client`.
"""

from __future__ import annotations

import json
import logging
import shutil
import tempfile
import time
import traceback
import uuid
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .analysis import analyze_wig, warm_up_analysis
from .config import settings
from .pipeline import PipelineInputs, WigSpec, run_pipeline, warm_up
from .supabase_client import get_gateway

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)
log = logging.getLogger("wig-ai-server")


app = FastAPI(title="Wig Catalog Studio - Local AI Server", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _on_startup() -> None:
    log.info("Warming up local background-removal model...")
    warm_up()
    try:
        warm_up_analysis()
    except Exception as exc:  # noqa: BLE001
        # Keep the health endpoint available so the UI can explain a missing
        # first-run model download. The first job retries and fails visibly if
        # the model is still unavailable.
        log.warning("CLIP warm-up deferred: %s", exc)
    log.info("AI server ready.")


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------
class GenerateFilterRequest(BaseModel):
    filter_id: int = Field(..., description="PK of the Wig_AI_Filters row")
    auth_user_id: str = Field(..., description="auth.uid() of the specialist who initiated the request")
    source_front_path: str
    source_side_path: str
    source_top_path: str | None = None
    source_back_path: str | None = None
    version: int = 1
    # Spec inputs from the wig creation form (informational, used for tinting etc.)
    hair_color: str | None = None
    hair_texture: str | None = None
    hair_density: str | None = None
    cap_size: str | None = None
    style: str | None = None
    hair_length: float | None = None


class GenerateFilterResponse(BaseModel):
    filter_id: int
    status: str
    message: str


class StatusResponse(BaseModel):
    filter_id: int
    status: str
    error_message: str | None
    thumbnail_path: str | None
    layer_full_wig_path: str | None
    layer_back_hair_path: str | None
    layer_front_bangs_path: str | None
    layer_hair_mask_path: str | None
    layer_face_mask_path: str | None
    ai_suggestions: dict[str, Any] | None = None
    duplicate_matches: list[dict[str, Any]] | None = None


class LocalAnalysisResponse(BaseModel):
    filter_id: int
    status: str
    message: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "mode": "local-only",
        "background_model": settings.rembg_model,
        "analysis_model": settings.clip_model,
    }


def _json_list(raw: str) -> list[dict[str, Any]]:
    try:
        value = json.loads(raw or "[]")
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid inventory JSON: {exc}") from exc
    if not isinstance(value, list):
        raise HTTPException(status_code=400, detail="Inventory JSON must be a list")
    return [item for item in value if isinstance(item, dict)]


def _json_object(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid attributes JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="Attributes JSON must be an object")
    return value


@app.post("/analyze-wig", response_model=LocalAnalysisResponse)
async def analyze_local_wig(
    background: BackgroundTasks,
    wig_photo: UploadFile = File(...),
    filter_id: int = Form(...),
    auth_user_id: str = Form(...),
    version: int = Form(1),
    inventory_json: str = Form("[]"),
    attributes_json: str = Form("{}"),
) -> LocalAnalysisResponse:
    """Queue local processing without uploading the raw source photograph."""
    if not wig_photo.content_type or not wig_photo.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="wig_photo must be an image")

    content = await wig_photo.read()
    max_bytes = settings.max_upload_mb * 1024 * 1024
    if not content:
        raise HTTPException(status_code=400, detail="The wig photo is empty")
    if len(content) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"The wig photo exceeds the {settings.max_upload_mb} MB limit",
        )

    gateway = get_gateway()
    row = gateway.fetch_filter_row(filter_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Filter_ID {filter_id} not found")

    inventory = _json_list(inventory_json)
    entered_attributes = _json_object(attributes_json)

    job_id = uuid.uuid4().hex
    work_dir = Path(tempfile.gettempdir()) / "wig-catalog-jobs" / job_id
    work_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(wig_photo.filename or "").suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
        suffix = ".png"
    source_path = work_dir / f"wig-source{suffix}"
    source_path.write_bytes(content)

    gateway.mark_processing(filter_id)
    background.add_task(
        _run_local_job_safely,
        filter_id,
        auth_user_id,
        max(1, version),
        source_path,
        work_dir,
        inventory,
        entered_attributes,
    )

    return LocalAnalysisResponse(
        filter_id=filter_id,
        status="processing",
        message="Local analysis queued. The raw photo remains on this computer.",
    )


@app.post("/generate-filter", response_model=GenerateFilterResponse)
def generate_filter(req: GenerateFilterRequest, background: BackgroundTasks) -> GenerateFilterResponse:
    gateway = get_gateway()

    # Confirm the row exists so we fail fast on a bad ID instead of running
    # the pipeline only to UPDATE 0 rows at the end.
    row = gateway.fetch_filter_row(req.filter_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Filter_ID {req.filter_id} not found")

    gateway.mark_processing(req.filter_id)

    background.add_task(_run_job_safely, req)
    return GenerateFilterResponse(
        filter_id=req.filter_id,
        status="processing",
        message="Pipeline queued. Poll /status or subscribe to the Wig_AI_Filters row.",
    )


@app.get("/status/{filter_id}", response_model=StatusResponse)
def get_status(filter_id: int) -> StatusResponse:
    gateway = get_gateway()
    row = gateway.fetch_filter_row(filter_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Filter_ID {filter_id} not found")
    return StatusResponse(
        filter_id=filter_id,
        status=row.get("Status") or "unknown",
        error_message=row.get("Error_Message"),
        thumbnail_path=row.get("Thumbnail_Path"),
        layer_full_wig_path=row.get("Layer_Full_Wig_Path"),
        layer_back_hair_path=row.get("Layer_Back_Hair_Path"),
        layer_front_bangs_path=row.get("Layer_Front_Bangs_Path"),
        layer_hair_mask_path=row.get("Layer_Hair_Mask_Path"),
        layer_face_mask_path=row.get("Layer_Face_Mask_Path"),
        ai_suggestions=row.get("AI_Suggestions") or {},
        duplicate_matches=row.get("Duplicate_Matches") or [],
    )


# ---------------------------------------------------------------------------
# Background job
# ---------------------------------------------------------------------------
def _run_job_safely(req: GenerateFilterRequest) -> None:
    """Wrapper so a crash inside the pipeline always lands as Status=failed."""
    gateway = get_gateway()
    try:
        _run_job(req, gateway)
    except Exception as exc:  # noqa: BLE001
        log.exception("Pipeline failed for Filter_ID=%s", req.filter_id)
        tb = traceback.format_exc(limit=4)
        gateway.mark_failed(req.filter_id, f"{exc}\n{tb}")


def _run_local_job_safely(
    filter_id: int,
    auth_user_id: str,
    version: int,
    source_path: Path,
    work_dir: Path,
    inventory: list[dict[str, Any]],
    entered_attributes: dict[str, Any],
) -> None:
    gateway = get_gateway()
    try:
        started_at = time.perf_counter()
        outputs = run_pipeline(
            PipelineInputs(front_path=source_path),
            work_dir=work_dir,
        )
        full_wig_path = outputs.layers["full_wig"]
        analysis = analyze_wig(
            str(full_wig_path),
            inventory=inventory,
            entered_attributes=entered_attributes,
        )

        remote_folder = (
            f"{auth_user_id}/wig-ai-filters/filter-{filter_id}/v{version}"
        )
        uploaded_paths: dict[str, str] = {}
        for layer_key, local_path in outputs.layers.items():
            remote_path = f"{remote_folder}/{layer_key}.png"
            gateway.upload_artifact(local_path, remote_path, content_type="image/png")
            uploaded_paths[layer_key] = remote_path

        suggestions = dict(analysis.get("suggestions") or {})
        suggestions["_meta"] = {
            "runsLocally": True,
            "processingSeconds": round(time.perf_counter() - started_at, 2),
            "backgroundModel": outputs.ai_model_version,
            "analysisModel": analysis.get("analysisModelVersion"),
        }
        model_version = (
            f"{outputs.ai_model_version}+{analysis.get('analysisModelVersion', 'clip')}"
        )[:120]
        gateway.mark_completed(
            filter_id,
            layer_paths=uploaded_paths,
            thumbnail_path=uploaded_paths.get("full_wig"),
            ai_model_version=model_version,
            ai_suggestions=suggestions,
            duplicate_matches=analysis.get("duplicateMatches") or [],
            visual_embedding=analysis.get("embedding"),
        )
        log.info(
            "Filter_ID=%s locally analyzed in %.2fs",
            filter_id,
            time.perf_counter() - started_at,
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("Local pipeline failed for Filter_ID=%s", filter_id)
        tb = traceback.format_exc(limit=4)
        gateway.mark_failed(filter_id, f"{exc}\n{tb}")
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def _run_job(req: GenerateFilterRequest, gateway) -> None:
    job_id = uuid.uuid4().hex
    work_dir = Path(tempfile.gettempdir()) / "wig-ai-jobs" / job_id
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
        # 1. Download source images.
        front_local = gateway.download_source(
            req.source_front_path, work_dir / "front.png"
        )
        side_local = gateway.download_source(
            req.source_side_path, work_dir / "side.png"
        )
        top_local = (
            gateway.download_source(req.source_top_path, work_dir / "top.png")
            if req.source_top_path else None
        )
        back_local = (
            gateway.download_source(req.source_back_path, work_dir / "back.png")
            if req.source_back_path else None
        )

        # 2. Run pipeline -> 5 layer PNGs.
        outputs = run_pipeline(
            PipelineInputs(
                front_path=front_local,
                side_path=side_local,
                top_path=top_local,
                back_path=back_local,
                spec=WigSpec(
                    hair_color=req.hair_color,
                    hair_texture=req.hair_texture,
                    hair_density=req.hair_density,
                    cap_size=req.cap_size,
                    style=req.style,
                    hair_length=req.hair_length,
                ),
            ),
            work_dir=work_dir,
        )

        # 3. Upload each layer + use full_wig as the thumbnail.
        remote_folder = f"{req.auth_user_id}/wig-ai-filters/filter-{req.filter_id}/v{req.version}"
        uploaded_paths: dict[str, str] = {}
        for layer_key, local_path in outputs.layers.items():
            remote_path = f"{remote_folder}/{layer_key}.png"
            gateway.upload_artifact(local_path, remote_path, content_type="image/png")
            uploaded_paths[layer_key] = remote_path

        thumb_remote = uploaded_paths.get("full_wig")

        # 4. Mark complete.
        gateway.mark_completed(
            req.filter_id,
            layer_paths=uploaded_paths,
            thumbnail_path=thumb_remote,
            ai_model_version=outputs.ai_model_version,
        )
        log.info("Filter_ID=%s ready (%d layers)", req.filter_id, len(uploaded_paths))

    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
