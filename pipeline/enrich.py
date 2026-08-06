"""Enrichment via hosted Workflows A & B (Gemini, Roboflow-managed key).

Workflow A assesses each confirmed finding's crop (annotate or veto — never
add findings); Workflow B identifies the vehicle from an early frame. Both
run on the serverless API with `rf_key:account`, so usage bills Roboflow
credits — no Google key involved. All failures are non-fatal: findings ship
without enrichment rather than not at all.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.request
from pathlib import Path

import config


def _run_workflow(workflow_ref: str, jpg_bytes: bytes, output_key: str) -> dict | None:
    workspace, workflow_id = workflow_ref.split("/", 1)
    body = json.dumps(
        {
            "api_key": os.environ["ROBOFLOW_API_KEY"],
            "inputs": {
                "image": {"type": "base64", "value": base64.b64encode(jpg_bytes).decode()}
            },
        }
    ).encode()
    req = urllib.request.Request(
        f"{config.SERVERLESS_URL}/infer/workflows/{workspace}/{workflow_id}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as res:
        out = json.load(res)["outputs"][0]

    parsed = out.get(output_key)
    if isinstance(parsed, dict) and not parsed.get("error_status", False):
        parsed.pop("error_status", None)
        return parsed
    # Parser missed (e.g. unexpected wrapping) — fall back to the raw string.
    raw = out.get("raw")
    if isinstance(raw, str):
        try:
            return json.loads(raw.strip().strip("`").removeprefix("json"))
        except (json.JSONDecodeError, AttributeError):
            return None
    return None


def assess_finding(crop_path: Path) -> dict | None:
    """Workflow A: structured damage assessment for one finding crop."""
    return _run_workflow(config.WORKFLOW_A, crop_path.read_bytes(), "assessment")


def identify_vehicle(video_path: Path) -> dict | None:
    """Workflow B: vehicle identification from an early frame of the video."""
    import cv2

    cap = cv2.VideoCapture(str(video_path))
    try:
        total = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(total * config.VEHICLE_ID_FRAME_FRAC))
        ok, frame = cap.read()
        if not ok:
            return None
    finally:
        cap.release()
    ok, jpg = cv2.imencode(".jpg", frame)
    if not ok:
        return None
    return _run_workflow(config.WORKFLOW_B, jpg.tobytes(), "vehicle")


def is_vetoed(assessment: dict) -> bool:
    v = assessment.get("is_false_positive")
    return v is True or str(v).strip().lower() == "true"
