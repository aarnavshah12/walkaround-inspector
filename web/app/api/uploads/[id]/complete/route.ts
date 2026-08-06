// POST /api/uploads/[id]/complete — assemble chunks into the final video,
// re-hash it server-side, and compare against the client hash that was
// RFC 3161 timestamped at record-stop. `verified: true` means the exact
// bytes that existed at capture time are the bytes we now hold.

import { NextRequest, NextResponse } from "next/server";
import { isValidCaptureId, readCapture, updateCapture } from "../../../../../lib/server/store";
import { assembleVideo, deleteChunks, listReceivedChunks } from "../../../../../lib/server/storage";
import { triggerAnalysis } from "../../../../../lib/server/analysis";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidCaptureId(id)) {
    return NextResponse.json({ error: "Invalid capture id" }, { status: 400 });
  }
  const capture = await readCapture(id);
  if (!capture) {
    return NextResponse.json({ error: "Capture not found" }, { status: 404 });
  }
  if (capture.upload.status === "complete") {
    return NextResponse.json(capture); // idempotent
  }
  const { totalChunks } = capture.upload;
  if (capture.upload.status !== "in_progress" || !totalChunks) {
    return NextResponse.json({ error: "Upload not initialized" }, { status: 409 });
  }

  const received = await listReceivedChunks(id);
  if (received.length !== totalChunks) {
    return NextResponse.json(
      { error: `Missing chunks: have ${received.length} of ${totalChunks}` },
      { status: 409 }
    );
  }

  const assembled = await assembleVideo(id, totalChunks, capture.mime);
  const verified = assembled.sha256 === capture.hash;
  await deleteChunks(id);

  let updated = await updateCapture(id, (r) => ({
    ...r,
    sizeBytes: assembled.size,
    upload: {
      ...r.upload,
      status: "complete",
      receivedChunks: totalChunks,
      verified,
      completedAt: new Date().toISOString(),
    },
  }));

  // Upload-and-go: a verified upload starts Workflow V with no further user
  // action. Unverified videos are NOT analyzed — the bytes don't match the
  // timestamped hash, so any findings would be unattributable.
  if (verified) {
    await triggerAnalysis(id);
    updated = (await readCapture(id)) ?? updated;
  }

  return NextResponse.json(updated);
}
