// GET /api/capture/[id]/findings — Workflow V results once the runner has
// written them. Crop paths are rewritten to servable API URLs.

import { promises as fs } from "fs";
import { NextRequest, NextResponse } from "next/server";
import { isValidCaptureId } from "../../../../../lib/server/store";
import { findingsPath } from "../../../../../lib/server/analysis";
import type { FindingsReport } from "../../../../../lib/types";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidCaptureId(id)) {
    return NextResponse.json({ error: "Invalid capture id" }, { status: 400 });
  }
  let raw: string;
  try {
    raw = await fs.readFile(findingsPath(id), "utf8");
  } catch {
    return NextResponse.json({ error: "Findings not ready" }, { status: 404 });
  }
  const report = JSON.parse(raw) as FindingsReport;
  for (const f of report.findings) {
    if (f.crop) f.crop = `/api/capture/${id}/crops/${f.crop.replace(/^crops\//, "")}`;
    if (f.full_frame) f.full_frame = `/api/capture/${id}/crops/${f.full_frame.replace(/^crops\//, "")}`;
  }
  return NextResponse.json(report);
}
