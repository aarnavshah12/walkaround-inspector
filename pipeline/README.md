# Workflow V pipeline

Server-side video analysis: RF-DETR damage detection → ByteTrack tracklets →
temporal parallax filter (rejects reflections) → confirmed findings.

- `config.py` — every tunable constant (the ONLY place thresholds live)
- `parallax_block.py` — Custom Python Block source (embedded into the
  workflow JSON by the generator; runs on self-hosted inference only)
- `build_workflow.py` — regenerates `../workflows/workflow-v.json`
- `process_video.py` — runs the workflow over a video, applies the tracklet
  confirmation gate, writes `findings.json` + best-frame crops

## Setup

```bash
python3.12 -m venv .venv          # 3.10+ required (see requirements.txt)
.venv/bin/pip install -r requirements.txt
export ROBOFLOW_API_KEY=...       # weights download; never committed

# process an uploaded capture
.venv/bin/python process_video.py <capture-id>

# standalone tuning run over a raw video
.venv/bin/python process_video.py --video walkaround.mp4
```

The workspace copy of the workflow is `aarnavs-space/walkaround-video-v`;
keep it in sync with the generated JSON (`updateWorkflow` REST endpoint,
POST body `{id, name, url, config: JSON.stringify({specification})}`).
