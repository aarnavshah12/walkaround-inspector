"""Annotated-video rendering — a human-checkable view of what the pipeline
saw. Boxes are color-coded by each tracklet's fate: red = confirmed finding,
amber = AI-vetoed, gray = rejected by the gate. Additive output only; never
affects analysis results.
"""

from __future__ import annotations

from pathlib import Path

CONFIRMED = (60, 60, 230)  # BGR red
VETOED = (0, 165, 255)  # amber
REJECTED = (160, 160, 160)  # gray


def render_annotated(
    video_path: Path,
    signals: list[dict],
    statuses: dict[int, tuple[str, str]],
    out_path: Path,
) -> bool:
    """statuses: tracker_id -> (kind, label) with kind in confirmed|vetoed|rejected.
    Returns True when a video was written. Prefers H.264 (browser-playable),
    falls back to mp4v (downloadable)."""
    import cv2

    by_frame: dict[int, list[dict]] = {}
    for s in signals:
        if s.get("frame_number") is None or s.get("tracker_id") is None:
            continue
        by_frame.setdefault(int(s["frame_number"]), []).append(s)

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return False
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    writer = None
    for fourcc in ("avc1", "mp4v"):
        writer = cv2.VideoWriter(str(out_path), cv2.VideoWriter_fourcc(*fourcc), fps, (w, h))
        if writer.isOpened():
            print(f"annotated video codec: {fourcc}")
            break
        writer.release()
        writer = None
    if writer is None:
        cap.release()
        return False

    colors = {"confirmed": CONFIRMED, "vetoed": VETOED, "rejected": REJECTED}
    frame_idx = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            for s in by_frame.get(frame_idx, []):
                kind, label = statuses.get(int(s["tracker_id"]), ("rejected", ""))
                color = colors[kind]
                x1, y1, x2, y2 = (int(v) for v in s["xyxy"])
                thickness = 3 if kind == "confirmed" else 2
                cv2.rectangle(frame, (x1, y1), (x2, y2), color, thickness)
                conf = s.get("confidence")
                text = f"{label or s.get('class_name', '?')}{f' {conf:.0%}' if conf else ''}"
                (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
                ty = max(th + 8, y1 - 6)
                cv2.rectangle(frame, (x1, ty - th - 6), (x1 + tw + 8, ty + 4), color, -1)
                cv2.putText(frame, text, (x1 + 4, ty), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2)
            secs = frame_idx / fps
            stamp = f"Walkaround Inspector  {int(secs // 60)}:{secs % 60:04.1f}"
            cv2.putText(frame, stamp, (16, h - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 4)
            cv2.putText(frame, stamp, (16, h - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            writer.write(frame)
            frame_idx += 1
    finally:
        cap.release()
        writer.release()
    return frame_idx > 0
