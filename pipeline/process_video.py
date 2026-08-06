"""Run Workflow V over a walkaround video and emit confirmed findings.

Usage:
    python3 process_video.py <capture-id>            # capture from web data dir
    python3 process_video.py --video path/to.mp4     # standalone (tuning runs)

The workflow (local JSON, same definition as aarnavs-space/walkaround-video-v)
runs on the self-hosted inference engine — Custom Python Blocks don't execute
on the hosted API. This runner owns the second pass the plan allows: the
whole-video tracklet confirmation gate, best-frame crop extraction, segment
localization, and findings.json assembly.

Requires ROBOFLOW_API_KEY in the environment (model weights download).
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import config
import enrich

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOW_PATH = REPO_ROOT / "workflows" / "workflow-v.json"
DATA_DIR = Path(os.environ.get("DATA_DIR", REPO_ROOT / "web" / "data"))


def load_capture(capture_id: str) -> dict:
    path = DATA_DIR / "captures" / f"{capture_id}.json"
    if not path.exists():
        sys.exit(f"No capture record at {path}")
    return json.loads(path.read_text())


def update_capture_analysis(capture_id: str, status: str, error: str | None = None) -> None:
    """Mirror analysis progress into the capture record the web API serves."""
    path = DATA_DIR / "captures" / f"{capture_id}.json"
    if not path.exists():
        return
    rec = json.loads(path.read_text())
    analysis = rec.get("analysis") or {}
    analysis["status"] = status
    now = datetime.now(timezone.utc).isoformat()
    if status == "running":
        analysis["startedAt"] = now
    if status in ("complete", "failed"):
        analysis["finishedAt"] = now
    if error:
        analysis["error"] = error
    rec["analysis"] = analysis
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(rec, indent=2))
    tmp.replace(path)


def capture_video_path(capture: dict) -> Path:
    ext = "mp4" if "mp4" in capture.get("mime", "") else "webm"
    path = DATA_DIR / "videos" / f"{capture['id']}.{ext}"
    if not path.exists():
        sys.exit(f"Video not uploaded yet: {path}")
    return path


def collect_signals(video_path: Path) -> tuple[list[dict], float]:
    """First pass: run Workflow V over sampled frames, gather parallax
    signals per frame. Returns (signals, source_fps)."""
    import cv2
    from inference import InferencePipeline

    probe = cv2.VideoCapture(str(video_path))
    source_fps = probe.get(cv2.CAP_PROP_FPS) or 30.0
    probe.release()

    spec = json.loads(WORKFLOW_PATH.read_text())

    collected: list[dict] = []

    def sink(predictions: dict, video_frame) -> None:
        signals = predictions.get("parallax_signals") or []
        frame_number = getattr(video_frame, "frame_id", None)
        for s in signals:
            if s.get("frame_number") is None:
                s["frame_number"] = frame_number
            collected.append(s)

    pipeline = InferencePipeline.init_with_workflow(
        video_reference=str(video_path),
        workflow_specification=spec,
        on_prediction=sink,
        max_fps=config.SAMPLE_FPS,
        workflows_parameters={
            "det_confidence": config.DET_CONFIDENCE,
            "track_activation_threshold": config.TRACK_ACTIVATION_THRESHOLD,
        },
    )
    pipeline.start()
    pipeline.join()
    return collected, source_fps


def confirm_tracklets(signals: list[dict], source_fps: float) -> tuple[list[dict], list[dict]]:
    """Second pass: group signals into tracklets and apply the gate from
    config.py. Returns (confirmed, rejected) tracklet summaries."""
    tracklets: dict[int, list[dict]] = {}
    for s in signals:
        tid = s.get("tracker_id")
        if tid is None:
            continue
        tracklets.setdefault(tid, []).append(s)

    confirmed, rejected = [], []
    for tid, entries in tracklets.items():
        entries.sort(key=lambda e: e.get("frame_number") or 0)
        residuals = [e["residual_frac"] for e in entries if e.get("residual_frac") is not None]
        confidences = [e["confidence"] for e in entries if e.get("confidence") is not None]
        saturations = [e["saturation_ratio"] for e in entries if e.get("saturation_ratio") is not None]
        classes = [e["class_name"] for e in entries]
        majority_class = max(set(classes), key=classes.count)

        stats = {
            "tracker_id": tid,
            "class": majority_class,
            "frames": len(entries),
            "residual_samples": len(residuals),
            "median_residual_frac": statistics.median(residuals) if residuals else None,
            "mean_confidence": statistics.fmean(confidences) if confidences else None,
            "max_confidence": max(confidences) if confidences else None,
            "median_saturation": statistics.median(saturations) if saturations else None,
        }

        reason = None
        if len(entries) < config.K_MIN_FRAMES:
            reason = f"tracklet too short ({len(entries)} < {config.K_MIN_FRAMES} frames)"
        elif not residuals:
            reason = "insufficient optical flow to verify against parallax"
        elif stats["median_residual_frac"] >= config.MEDIAN_REPROJ_ERR_FRAC:
            reason = (
                f"parallax reject: median residual {stats['median_residual_frac']:.4f} "
                f">= {config.MEDIAN_REPROJ_ERR_FRAC} (moves like a reflection)"
            )
        elif stats["mean_confidence"] is None or stats["mean_confidence"] < config.MEAN_CONF_MIN:
            reason = f"mean confidence {stats['mean_confidence']} < {config.MEAN_CONF_MIN}"
        elif stats["median_saturation"] is not None and stats["median_saturation"] > config.SATURATION_RATIO_MAX:
            reason = f"glare reject: median saturation {stats['median_saturation']:.2f}"

        if reason:
            rejected.append({**stats, "reason": reason})
            continue

        best = max(entries, key=lambda e: e.get("confidence") or 0)
        confirmed.append({**stats, "entries": entries, "best": best})

    return confirmed, rejected


def extract_crops(video_path: Path, confirmed: list[dict], out_dir: Path) -> None:
    import cv2

    out_dir.mkdir(parents=True, exist_ok=True)
    cap = cv2.VideoCapture(str(video_path))
    try:
        for finding in confirmed:
            best = finding["best"]
            frame_number = best.get("frame_number") or 0
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_number)
            ok, frame = cap.read()
            if not ok:
                continue
            h, w = frame.shape[:2]
            x1, y1, x2, y2 = best["xyxy"]
            mx, my = (x2 - x1) * 0.2, (y2 - y1) * 0.2
            cx1, cy1 = max(0, int(x1 - mx)), max(0, int(y1 - my))
            cx2, cy2 = min(w, int(x2 + mx)), min(h, int(y2 + my))
            tid = finding["tracker_id"]
            cv2.imwrite(str(out_dir / f"track-{tid}-crop.jpg"), frame[cy1:cy2, cx1:cx2])
            cv2.imwrite(str(out_dir / f"track-{tid}-full.jpg"), frame)
            finding["crop"] = f"crops/track-{tid}-crop.jpg"
            finding["full_frame"] = f"crops/track-{tid}-full.jpg"
    finally:
        cap.release()


def locate_segment(pts_ms: float, segments: list[dict] | None) -> dict | None:
    if not segments:
        return None
    current = None
    for seg in sorted(segments, key=lambda s: s["startMs"]):
        if seg["startMs"] <= pts_ms:
            current = seg
        else:
            break
    return {"id": current["id"], "label": current["label"]} if current else None


def wall_clock(pts_ms: float, capture: dict | None) -> str | None:
    """clientTime is wall-clock at record STOP; walk back by remaining video."""
    if not capture or not capture.get("durationMs"):
        return None
    stop = datetime.fromisoformat(capture["clientTime"].replace("Z", "+00:00"))
    at = stop - timedelta(milliseconds=capture["durationMs"] - pts_ms)
    return at.astimezone(timezone.utc).isoformat()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture_id", nargs="?", help="Capture id from the web app")
    parser.add_argument("--video", help="Standalone video path (tuning runs)")
    args = parser.parse_args()

    if not args.capture_id and not args.video:
        parser.error("Provide a capture id or --video")

    capture = load_capture(args.capture_id) if args.capture_id else None
    video_path = capture_video_path(capture) if capture else Path(args.video)
    out_dir = (
        DATA_DIR / "captures" / capture["id"] if capture
        else video_path.parent / (video_path.stem + "-findings")
    )

    if capture:
        update_capture_analysis(capture["id"], "running")
    try:
        run(capture, video_path, out_dir)
    except Exception as err:
        if capture:
            update_capture_analysis(capture["id"], "failed", error=str(err))
        raise
    if capture:
        update_capture_analysis(capture["id"], "complete")


def run(capture: dict | None, video_path: Path, out_dir: Path) -> None:
    print(f"workflow: {WORKFLOW_PATH.name} | video: {video_path} | sample {config.SAMPLE_FPS} fps")
    signals, source_fps = collect_signals(video_path)
    print(f"collected {len(signals)} per-frame signals (source {source_fps:.1f} fps)")

    confirmed, rejected = confirm_tracklets(signals, source_fps)
    extract_crops(video_path, confirmed, out_dir / "crops")

    findings = []
    for i, f in enumerate(confirmed, start=1):
        entries = f.pop("entries")
        best = f.pop("best")
        pts_ms = (best.get("frame_number") or 0) / source_fps * 1000
        findings.append(
            {
                "id": f"finding-{i}",
                "class": f["class"],
                "confidence": {"mean": f["mean_confidence"], "max": f["max_confidence"]},
                "tracklet": {
                    "tracker_id": f["tracker_id"],
                    "frames": f["frames"],
                    "first_pts_ms": (entries[0].get("frame_number") or 0) / source_fps * 1000,
                    "last_pts_ms": (entries[-1].get("frame_number") or 0) / source_fps * 1000,
                    "median_residual_frac": f["median_residual_frac"],
                    "median_saturation": f["median_saturation"],
                },
                "best_frame": {
                    "frame_number": best.get("frame_number"),
                    "pts_ms": pts_ms,
                    "wall_clock": wall_clock(pts_ms, capture),
                },
                "segment": locate_segment(pts_ms, capture.get("segments") if capture else None),
                "xyxy": best["xyxy"],
                "crop": f.get("crop"),
                "full_frame": f.get("full_frame"),
            }
        )

    # Enrichment (Workflows A & B, hosted, Roboflow-managed Gemini key).
    # Gemini annotates or vetoes findings — it never adds them. Failures are
    # non-fatal: findings ship un-enriched rather than not at all.
    enrichment: dict = {"status": "skipped"}
    vehicle = None
    if config.ENRICHMENT_ENABLED and os.environ.get("ROBOFLOW_API_KEY"):
        errors: list[str] = []
        for finding in findings:
            if not finding.get("crop"):
                continue
            try:
                assessment = enrich.assess_finding(out_dir / finding["crop"])
                if assessment:
                    finding["assessment"] = {**assessment, "ai_assessed": True}
                    if enrich.is_vetoed(assessment):
                        finding["veto"] = True
            except Exception as err:  # noqa: BLE001 — enrichment must not sink findings
                errors.append(f"{finding['id']}: {err}")
        try:
            vehicle = enrich.identify_vehicle(video_path)
        except Exception as err:  # noqa: BLE001
            errors.append(f"vehicle: {err}")
        enrichment = {"status": "complete" if not errors else "partial", "errors": errors}
        print(f"enrichment: {enrichment['status']} ({len(errors)} errors), vehicle={'yes' if vehicle else 'no'}")

    out_dir.mkdir(parents=True, exist_ok=True)
    result = {
        "capture_id": capture["id"] if capture else None,
        "video": str(video_path),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sample_fps": config.SAMPLE_FPS,
        "vehicle": vehicle,
        "enrichment": enrichment,
        "gate": {
            "k_min_frames": config.K_MIN_FRAMES,
            "median_reproj_err_frac": config.MEDIAN_REPROJ_ERR_FRAC,
            "mean_conf_min": config.MEAN_CONF_MIN,
            "saturation_ratio_max": config.SATURATION_RATIO_MAX,
        },
        "findings": findings,
        "rejected": rejected,
    }
    out_path = out_dir / "findings.json"
    out_path.write_text(json.dumps(result, indent=2) + "\n")
    print(f"{len(findings)} confirmed, {len(rejected)} rejected → {out_path}")


if __name__ == "__main__":
    main()
