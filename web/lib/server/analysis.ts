// Kicks off Workflow V for a verified upload — the "and go" half of
// upload-and-go. Dev implementation: spawn the Python runner detached with
// its output logged under DATA_DIR; the runner updates the capture record's
// analysis status itself and writes findings.json when done. Production
// swaps this for a job queue / self-hosted inference deployment without
// touching the routes.

import { spawn } from "child_process";
import { openSync } from "fs";
import { promises as fs } from "fs";
import path from "path";
import { DATA_DIR } from "./config";
import { updateCapture } from "./store";

const PIPELINE_DIR =
  process.env.PIPELINE_DIR ?? path.join(process.cwd(), "..", "pipeline");
const PYTHON =
  process.env.PIPELINE_PYTHON ?? path.join(PIPELINE_DIR, ".venv", "bin", "python");
const SCRIPT = path.join(PIPELINE_DIR, "process_video.py");

export async function triggerAnalysis(captureId: string): Promise<void> {
  try {
    const logsDir = path.join(DATA_DIR, "logs");
    await fs.mkdir(logsDir, { recursive: true });
    const log = openSync(path.join(logsDir, `analysis-${captureId}.log`), "a");
    const child = spawn(PYTHON, [SCRIPT, captureId], {
      cwd: PIPELINE_DIR,
      env: { ...process.env, DATA_DIR },
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    await updateCapture(captureId, (r) => ({
      ...r,
      analysis: { status: "queued", startedAt: new Date().toISOString() },
    }));
  } catch (err) {
    await updateCapture(captureId, (r) => ({
      ...r,
      analysis: {
        status: "unavailable",
        error: `Could not start analysis: ${(err as Error).message}`,
      },
    }));
  }
}

export function findingsPath(captureId: string): string {
  return path.join(DATA_DIR, "captures", captureId, "findings.json");
}

export function cropPath(captureId: string, file: string): string {
  return path.join(DATA_DIR, "captures", captureId, "crops", file);
}
