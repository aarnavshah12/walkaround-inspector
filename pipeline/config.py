"""Workflow V tunables — the single place Phase 4 constants live.

Tuning happens ONLY against the real model on the owner's recorded
walkaround videos (plan §Phase 4); the values below are the plan's starting
points. Anything the workflow itself consumes is passed in as workflow
parameters by the runner, so editing this file re-tunes the whole pipeline.
"""

# ---- frame sampling -------------------------------------------------------
SAMPLE_FPS = 3  # plan: 3–5 fps; start low, raise if recall lags

# ---- detection (RF-DETR block) -------------------------------------------
# Deliberately low: the tracker + confirmation gate own precision. The
# model id itself lives in workflows/workflow-v.json (per-workflow
# definition) and web/lib/server/config.ts (server config) — plan rule.
DET_CONFIDENCE = 0.2
DET_IOU_THRESHOLD = 0.3

# ---- tracking (ByteTrack block) ------------------------------------------
TRACK_ACTIVATION_THRESHOLD = 0.3
TRACK_HIGH_CONF_THRESHOLD = 0.4
TRACK_MIN_IOU = 0.1
TRACK_MIN_CONSECUTIVE = 2
TRACK_LOST_BUFFER = 15  # frames at SAMPLE_FPS => 5 s of occlusion tolerance

# ---- parallax filter (Custom Python Block) --------------------------------
# Annulus of background features around each box, as a fraction of box size.
ANNULUS_SCALE = 0.6
# Minimum LK flow correspondences to attempt a local homography.
MIN_FLOW_POINTS = 8
# Grayscale value above which a pixel counts as near-saturated (reflection vote).
SATURATION_VALUE = 240

# ---- enrichment (hosted Workflows A & B, Roboflow-managed Gemini key) -----
ENRICHMENT_ENABLED = True
WORKFLOW_A = "aarnavs-space/walkaround-enrich-a"
WORKFLOW_B = "aarnavs-space/walkaround-vehicle-b"
SERVERLESS_URL = "https://serverless.roboflow.com"
# Vehicle-ID still comes from this fraction into the video (walkarounds open
# with a whole-car framing).
VEHICLE_ID_FRAME_FRAC = 0.05

# ---- confirmation gate (runner, two-pass over the whole video) ------------
# Tracklet must survive >= K sampled frames…
K_MIN_FRAMES = 5
# …with median reprojection error under this fraction of the frame diagonal…
MEDIAN_REPROJ_ERR_FRAC = 0.015
# …mean detection confidence at least…
MEAN_CONF_MIN = 0.5
# …and not look like pure glare: median near-saturated pixel ratio below.
SATURATION_RATIO_MAX = 0.5
