// GET /api/capture/[id] — capture status for the report screen. Doubles as
// the opportunistic RFC 3161 retry path: if the token is still pending
// (e.g. the TSA was unreachable at record-stop), each poll may retry it,
// throttled to one attempt per TSA_RETRY_MIN_INTERVAL_MS.

import { NextRequest, NextResponse } from "next/server";
import { isValidCaptureId, readCapture, updateCapture } from "../../../../lib/server/store";
import { requestTimestamp } from "../../../../lib/server/tsa";
import { TSA_RETRY_MIN_INTERVAL_MS } from "../../../../lib/server/config";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidCaptureId(id)) {
    return NextResponse.json({ error: "Invalid capture id" }, { status: 400 });
  }
  let record = await readCapture(id);
  if (!record) {
    return NextResponse.json({ error: "Capture not found" }, { status: 404 });
  }

  if (record.tsa.status !== "granted") {
    const last = record.tsa.lastAttemptAt ? Date.parse(record.tsa.lastAttemptAt) : 0;
    if (Date.now() - last >= TSA_RETRY_MIN_INTERVAL_MS) {
      const tsa = await requestTimestamp(record.id, record.hash);
      record =
        (await updateCapture(record.id, (r) => ({
          ...r,
          tsa: tsa.ok
            ? { ...r.tsa, status: "granted", grantedAt: new Date().toISOString(), error: undefined, lastAttemptAt: new Date().toISOString() }
            : { ...r.tsa, status: "pending", error: tsa.error, lastAttemptAt: new Date().toISOString() },
        }))) ?? record;
    }
  }

  return NextResponse.json(record);
}
