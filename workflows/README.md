# Roboflow Workflow definitions

Versioned JSON definitions for the server-side vision pipeline. The web
client and API stay thin; all vision/AI logic lives here and is referenced
by `workspace/workflow_id`.

| Workflow | Purpose |
| --- | --- |
| V | Video analysis: frame sampling → RF-DETR → tracklets → temporal parallax filter (rejects reflections) → confirmed findings |
| A | Finding enrichment: crops → VLM structured assessment (annotate/veto only — never adds findings) |
| B | Vehicle identification from the walkaround's opening frame |
| C | Dev/QA single-image inference for spot checks |
| D | Dataset flywheel: auto-labeling of hard negatives for retrains |
| F | Model eval harness: golden-set gate before promoting a model version |

All model blocks pin the model ID defined in `web/lib/server/config.ts`.
