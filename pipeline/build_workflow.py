"""Generate workflows/workflow-v.json from the block source + tunables.

Run after editing parallax_block.py or config.py:

    python3 pipeline/build_workflow.py
"""

import json
from pathlib import Path

import config
from parallax_block import INIT_FUNCTION, RUN_FUNCTION

# Per-workflow model pin (plan rule: defined once per workflow, and once in
# web/lib/server/config.ts as server config). Canonical full id:
# aarnavs-space/car-damage-detection-5ioys-rigvq-1-rfdetr-small-t1
MODEL_ID = "aarnavs-space/car-damage-detection-5ioys-rigvq-1-rfdetr-small-t1"

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = REPO_ROOT / "workflows" / "workflow-v.json"


def build() -> dict:
    return {
        "version": "1.0",
        "inputs": [
            {"type": "WorkflowImage", "name": "image"},
            {
                "type": "WorkflowParameter",
                "name": "det_confidence",
                "default_value": config.DET_CONFIDENCE,
            },
            {
                "type": "WorkflowParameter",
                "name": "track_activation_threshold",
                "default_value": config.TRACK_ACTIVATION_THRESHOLD,
            },
        ],
        "dynamic_blocks_definitions": [
            {
                "type": "DynamicBlockDefinition",
                "manifest": {
                    "type": "ManifestDescription",
                    "block_type": "ParallaxFilter",
                    "description": (
                        "Temporal parallax filter: rejects reflections by "
                        "comparing tracked-box motion against local "
                        "background motion (LK flow + RANSAC homography). "
                        "Emits per-frame signals; the runner applies the "
                        "tracklet confirmation gate."
                    ),
                    "inputs": {
                        "image": {
                            "type": "DynamicInputDefinition",
                            "selector_types": ["input_image", "step_output_image"],
                        },
                        "detections": {
                            "type": "DynamicInputDefinition",
                            "selector_types": ["step_output"],
                        },
                        "annulus_scale": {
                            "type": "DynamicInputDefinition",
                            "value_types": ["float"],
                            "default_value": config.ANNULUS_SCALE,
                        },
                        "min_flow_points": {
                            "type": "DynamicInputDefinition",
                            "value_types": ["integer"],
                            "default_value": config.MIN_FLOW_POINTS,
                        },
                        "saturation_value": {
                            "type": "DynamicInputDefinition",
                            "value_types": ["integer"],
                            "default_value": config.SATURATION_VALUE,
                        },
                    },
                    "outputs": {
                        "detections": {
                            "type": "DynamicOutputDefinition",
                            "kind": ["object_detection_prediction"],
                        },
                        "signals": {"type": "DynamicOutputDefinition", "kind": []},
                    },
                },
                "code": {
                    "type": "PythonCode",
                    "init_function_code": INIT_FUNCTION,
                    "init_function_name": "init_parallax",
                    "run_function_code": RUN_FUNCTION,
                    "run_function_name": "run_parallax",
                },
            }
        ],
        "steps": [
            {
                "type": "roboflow_core/roboflow_object_detection_model@v3",
                "name": "damage_detector",
                "images": "$inputs.image",
                "model_id": MODEL_ID,
                "confidence_mode": "custom",
                "custom_confidence": "$inputs.det_confidence",
                "iou_threshold": config.DET_IOU_THRESHOLD,
            },
            {
                "type": "roboflow_core/trackers_bytetrack@v1",
                "name": "tracker",
                "image": "$inputs.image",
                "detections": "$steps.damage_detector.predictions",
                "minimum_iou_threshold": config.TRACK_MIN_IOU,
                "minimum_consecutive_frames": config.TRACK_MIN_CONSECUTIVE,
                "lost_track_buffer": config.TRACK_LOST_BUFFER,
                "track_activation_threshold": "$inputs.track_activation_threshold",
                "high_conf_det_threshold": config.TRACK_HIGH_CONF_THRESHOLD,
            },
            {
                "type": "ParallaxFilter",
                "name": "parallax",
                "image": "$inputs.image",
                "detections": "$steps.tracker.tracked_detections",
                "annulus_scale": config.ANNULUS_SCALE,
                "min_flow_points": config.MIN_FLOW_POINTS,
                "saturation_value": config.SATURATION_VALUE,
            },
        ],
        "outputs": [
            {
                "type": "JsonField",
                "name": "tracked_detections",
                "selector": "$steps.tracker.tracked_detections",
            },
            {
                "type": "JsonField",
                "name": "parallax_signals",
                "selector": "$steps.parallax.signals",
            },
        ],
    }


if __name__ == "__main__":
    spec = build()
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(spec, indent=2) + "\n")
    print(f"wrote {OUT_PATH}")
