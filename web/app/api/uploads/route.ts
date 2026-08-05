// POST /api/uploads — initialize (or resume) the chunked upload for a
// capture. Returns which chunks the server already has, so an interrupted
// upload only re-sends what's missing.

import { NextRequest, NextResponse } from "next/server";
import type { UploadInitRequest, UploadInitResponse } from "../../../lib/types";
import { isValidCaptureId, readCapture, updateCapture } from "../../../lib/server/store";
import { listReceivedChunks } from "../../../lib/server/storage";
import { MAX_CHUNK_BYTES, MAX_VIDEO_BYTES } from "../../../lib/server/config";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: UploadInitRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.captureId !== "string" || !isValidCaptureId(body.captureId)) {
    return NextResponse.json({ error: "Invalid captureId" }, { status: 400 });
  }
  const capture = await readCapture(body.captureId);
  if (!capture) {
    return NextResponse.json({ error: "Capture not found — POST /api/capture first" }, { status: 404 });
  }
  if (
    !Number.isInteger(body.size) ||
    body.size <= 0 ||
    body.size > MAX_VIDEO_BYTES ||
    !Number.isInteger(body.chunkSize) ||
    body.chunkSize <= 0 ||
    body.chunkSize > MAX_CHUNK_BYTES ||
    !Number.isInteger(body.totalChunks) ||
    body.totalChunks !== Math.ceil(body.size / body.chunkSize)
  ) {
    return NextResponse.json({ error: "Inconsistent size/chunkSize/totalChunks" }, { status: 400 });
  }

  if (capture.upload.status === "complete") {
    const done: UploadInitResponse = { received: [], complete: true };
    return NextResponse.json(done);
  }

  // Guard against a client re-initializing with different chunking after
  // some chunks were stored — indexes would no longer line up.
  if (
    capture.upload.status === "in_progress" &&
    (capture.upload.chunkSize !== body.chunkSize || capture.upload.totalChunks !== body.totalChunks)
  ) {
    return NextResponse.json(
      { error: "Upload already initialized with different chunking" },
      { status: 409 }
    );
  }

  await updateCapture(capture.id, (r) => ({
    ...r,
    sizeBytes: r.sizeBytes ?? body.size,
    upload: {
      ...r.upload,
      status: "in_progress",
      chunkSize: body.chunkSize,
      totalChunks: body.totalChunks,
      receivedChunks: r.upload.receivedChunks ?? 0,
    },
  }));

  const received = await listReceivedChunks(capture.id);
  const res: UploadInitResponse = { received, complete: false };
  return NextResponse.json(res);
}
