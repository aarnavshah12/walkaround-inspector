"""Temporal parallax filter — Custom Python Block for Workflow V.

Physics: real damage is paint-deep, so its box moves WITH the panel it sits
on; a reflection slides ACROSS the panel as the camera translates. For each
tracked box we estimate how the LOCAL background (an annulus of features
around the box) moved between consecutive sampled frames via sparse LK
optical flow + a RANSAC homography, project the previous box centre through
that motion, and measure how far the tracked box actually landed from the
prediction. Damage → small residual; reflection → large. A near-saturated
pixel ratio adds a glare vote. The block emits raw per-frame signals; the
runner applies the tracklet-level confirmation gate (two-pass is allowed —
the server has the whole video).

This file is the source of truth for the block code; build_workflow.py
embeds it into workflows/workflow-v.json. Custom Python Blocks execute on
self-hosted Inference only (Roboflow hosted API refuses dynamic code).
"""

INIT_FUNCTION = '''
def init_parallax() -> dict:
    # Per-video mutable state, keyed by video_identifier: previous grayscale
    # frame and previous per-track boxes.
    return {"videos": {}}
'''

RUN_FUNCTION = '''
def run_parallax(
    self,
    image,
    detections,
    annulus_scale,
    min_flow_points,
    saturation_value,
):
    import cv2
    import numpy as np

    frame = image.numpy_image
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]
    diagonal = float(np.hypot(w, h))

    metadata = getattr(image, "video_metadata", None)
    video_id = getattr(metadata, "video_identifier", None) or "default"
    frame_number = getattr(metadata, "frame_number", None)

    videos = self._init_results["videos"]
    state = videos.setdefault(video_id, {"prev_gray": None, "prev_boxes": {}})
    prev_gray = state["prev_gray"]
    prev_boxes = state["prev_boxes"]

    signals = []
    current_boxes = {}

    n = len(detections) if detections is not None else 0
    for i in range(n):
        x1, y1, x2, y2 = detections.xyxy[i].astype(float)
        tracker_id = (
            int(detections.tracker_id[i])
            if detections.tracker_id is not None
            else None
        )
        confidence = (
            float(detections.confidence[i])
            if detections.confidence is not None
            else None
        )
        class_name = str(detections.data.get("class_name", ["?"] * n)[i])

        # Glare vote: fraction of near-saturated pixels inside the box.
        bx1, by1 = max(0, int(x1)), max(0, int(y1))
        bx2, by2 = min(w, int(x2)), min(h, int(y2))
        patch = gray[by1:by2, bx1:bx2]
        saturation_ratio = (
            float((patch >= saturation_value).mean()) if patch.size else 0.0
        )

        residual_frac = None
        flow_points = 0
        if tracker_id is not None and prev_gray is not None and tracker_id in prev_boxes:
            px1, py1, px2, py2 = prev_boxes[tracker_id]
            bw, bh = px2 - px1, py2 - py1
            # Annulus around the PREVIOUS box: expanded box minus the box
            # itself, clipped to the frame — background features only.
            ex1 = max(0, int(px1 - bw * annulus_scale))
            ey1 = max(0, int(py1 - bh * annulus_scale))
            ex2 = min(w, int(px2 + bw * annulus_scale))
            ey2 = min(h, int(py2 + bh * annulus_scale))
            mask = np.zeros_like(prev_gray)
            mask[ey1:ey2, ex1:ex2] = 255
            mask[max(0, int(py1)):min(h, int(py2)), max(0, int(px1)):min(w, int(px2))] = 0

            corners = cv2.goodFeaturesToTrack(
                prev_gray, maxCorners=80, qualityLevel=0.01, minDistance=7, mask=mask
            )
            if corners is not None and len(corners) >= min_flow_points:
                nxt, status, _ = cv2.calcOpticalFlowPyrLK(
                    prev_gray, gray, corners, None,
                    winSize=(21, 21), maxLevel=3,
                )
                ok = status.reshape(-1) == 1
                src = corners.reshape(-1, 2)[ok]
                dst = nxt.reshape(-1, 2)[ok]
                if len(src) >= min_flow_points:
                    H, inliers = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
                    if H is not None and inliers is not None and inliers.sum() >= 4:
                        flow_points = int(inliers.sum())
                        prev_center = np.array(
                            [[(px1 + px2) / 2.0, (py1 + py2) / 2.0]], dtype=np.float64
                        ).reshape(-1, 1, 2)
                        predicted = cv2.perspectiveTransform(prev_center, H).reshape(2)
                        actual = np.array([(x1 + x2) / 2.0, (y1 + y2) / 2.0])
                        residual_frac = float(
                            np.linalg.norm(predicted - actual) / diagonal
                        )

        if tracker_id is not None:
            current_boxes[tracker_id] = (x1, y1, x2, y2)

        signals.append(
            {
                "tracker_id": tracker_id,
                "class_name": class_name,
                "confidence": confidence,
                "xyxy": [float(x1), float(y1), float(x2), float(y2)],
                "frame_number": frame_number,
                "residual_frac": residual_frac,
                "saturation_ratio": saturation_ratio,
                "flow_points": flow_points,
            }
        )

    state["prev_gray"] = gray
    state["prev_boxes"] = current_boxes

    return {"detections": detections, "signals": signals}
'''
