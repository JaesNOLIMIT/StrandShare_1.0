"""Thin Supabase wrapper for the AI server.

Two responsibilities:
  1. Download source images from the private `wig_ai_sources` bucket.
  2. Upload generated filter layer PNGs to the public `wig_ai_filters` bucket,
     and update the matching `Wig_AI_Filters` row.

Uses the service-role key, so RLS is bypassed -- which is fine because the
server only mutates rows whose `Filter_ID` is passed in via the queued job.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from supabase import Client, create_client

from .config import settings

log = logging.getLogger(__name__)

WIG_AI_FILTERS_TABLE = "Wig_AI_Filters"


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat()


class SupabaseGateway:
    def __init__(self) -> None:
        self._client: Client = create_client(
            settings.supabase_url,
            settings.supabase_service_role_key,
        )

    # ------------------------------------------------------------------
    # Storage
    # ------------------------------------------------------------------
    def download_source(self, path: str, dest: Path) -> Path:
        """Download a private source image to `dest` and return the path."""
        data: bytes = self._client.storage.from_(settings.sources_bucket).download(path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return dest

    def upload_artifact(self, local_path: Path, remote_path: str, content_type: str) -> str:
        """Upload a generated artifact to the public filters bucket.

        Overwrites if the path already exists (the row is versioned, so a
        retry on the same Filter_ID legitimately overwrites the artifact).
        """
        with local_path.open("rb") as fh:
            self._client.storage.from_(settings.filters_bucket).upload(
                path=remote_path,
                file=fh,
                file_options={
                    "content-type": content_type,
                    "upsert": "true",
                },
            )
        return remote_path

    # ------------------------------------------------------------------
    # Row updates
    # ------------------------------------------------------------------
    def mark_processing(self, filter_id: int) -> None:
        self._client.table(WIG_AI_FILTERS_TABLE).update(
            {
                "Status": "processing",
                "Processing_Started_At": _now_iso(),
                "Error_Message": None,
            }
        ).eq("Filter_ID", filter_id).execute()

    def mark_completed(
        self,
        filter_id: int,
        *,
        layer_paths: dict[str, str],
        thumbnail_path: str | None,
        ai_model_version: str,
    ) -> None:
        """Persist generated layer paths and flip the row to pending_review.

        layer_paths keys must match the LAYER_DEFS in WigAiStudioPage.jsx:
            full_wig, back_hair, front_bangs, hair_mask, face_mask
        """
        column_for = {
            "full_wig":    "Layer_Full_Wig_Path",
            "back_hair":   "Layer_Back_Hair_Path",
            "front_bangs": "Layer_Front_Bangs_Path",
            "hair_mask":   "Layer_Hair_Mask_Path",
            "face_mask":   "Layer_Face_Mask_Path",
        }
        payload: dict[str, Any] = {
            "Status": "pending_review",
            "AI_Model_Version": ai_model_version,
            "Processing_Completed_At": _now_iso(),
            "Error_Message": None,
        }
        for layer_key, column in column_for.items():
            payload[column] = layer_paths.get(layer_key)
        if thumbnail_path is not None:
            payload["Thumbnail_Path"] = thumbnail_path
        self._client.table(WIG_AI_FILTERS_TABLE).update(payload).eq(
            "Filter_ID", filter_id
        ).execute()

    def mark_failed(self, filter_id: int, message: str) -> None:
        self._client.table(WIG_AI_FILTERS_TABLE).update(
            {
                "Status": "failed",
                "Error_Message": message[:2000],
                "Processing_Completed_At": _now_iso(),
            }
        ).eq("Filter_ID", filter_id).execute()

    def fetch_filter_row(self, filter_id: int) -> dict[str, Any] | None:
        result = (
            self._client.table(WIG_AI_FILTERS_TABLE)
            .select("*")
            .eq("Filter_ID", filter_id)
            .limit(1)
            .execute()
        )
        rows = result.data or []
        return rows[0] if rows else None


_gateway: SupabaseGateway | None = None


def get_gateway() -> SupabaseGateway:
    global _gateway
    if _gateway is None:
        _gateway = SupabaseGateway()
    return _gateway
