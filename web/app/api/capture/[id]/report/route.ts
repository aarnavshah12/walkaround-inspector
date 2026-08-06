// GET /api/capture/[id]/report — the signed PDF. Generates on first request
// once the capture is fully settled (verified upload + analysis complete +
// capture timestamp granted); cached thereafter, regenerated if findings
// changed after the report was built.

import { promises as fs } from "fs";
import { NextRequest, NextResponse } from "next/server";
import { isValidCaptureId, readCapture } from "../../../../../lib/server/store";
import { findingsPath } from "../../../../../lib/server/analysis";
import {
  TsaUnavailableError,
  generateSignedReport,
  reportPath,
} from "../../../../../lib/server/report";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidCaptureId(id)) {
    return NextResponse.json({ error: "Invalid capture id" }, { status: 400 });
  }
  const capture = await readCapture(id);
  if (!capture) return NextResponse.json({ error: "Capture not found" }, { status: 404 });

  const blockers: string[] = [];
  if (capture.upload.status !== "complete" || capture.upload.verified !== true) {
    blockers.push("upload not complete and verified");
  }
  if (capture.analysis?.status !== "complete") blockers.push("analysis not complete");
  if (capture.tsa.status !== "granted") blockers.push("capture timestamp not yet granted");
  if (blockers.length > 0) {
    return NextResponse.json({ error: `Report not ready: ${blockers.join("; ")}` }, { status: 409 });
  }

  try {
    const target = reportPath(id);
    const [reportStat, findingsStat] = await Promise.all([
      fs.stat(target).catch(() => null),
      fs.stat(findingsPath(id)).catch(() => null),
    ]);
    const stale = !reportStat || (findingsStat && findingsStat.mtimeMs > reportStat.mtimeMs);
    const file = stale ? await generateSignedReport(id) : target;
    const bytes = await fs.readFile(file);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="walkaround-report-${id}.pdf"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof TsaUnavailableError) {
      return NextResponse.json(
        { error: `Timestamp authority unreachable (${err.message}) — retry shortly` },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
