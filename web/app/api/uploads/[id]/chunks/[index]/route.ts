// PUT /api/uploads/[id]/chunks/[index] — store one raw chunk. Idempotent:
// re-sending a chunk after a dropped connection just overwrites the same
// bytes. Chunk sizes are validated strictly so assembly can't silently
// produce a video whose hash won't match.

import { NextRequest, NextResponse } from "next/server";
import { isValidCaptureId, readCapture, updateCapture } from "../../../../../../lib/server/store";
import { listReceivedChunks, saveChunk } from "../../../../../../lib/server/storage";
import { MAX_CHUNK_BYTES } from "../../../../../../lib/server/config";

export const dynamic = "force-dynamic";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; index: string }> }
) {
  const { id, index: indexRaw } = await params;
  if (!isValidCaptureId(id) || !/^\d{1,6}$/.test(indexRaw)) {
    return NextResponse.json({ error: "Invalid capture id or chunk index" }, { status: 400 });
  }
  const index = Number(indexRaw);

  const capture = await readCapture(id);
  if (!capture) {
    return NextResponse.json({ error: "Capture not found" }, { status: 404 });
  }
  const { status, chunkSize, totalChunks } = capture.upload;
  if (status === "complete") {
    return NextResponse.json({ error: "Upload already complete" }, { status: 409 });
  }
  if (status !== "in_progress" || !chunkSize || !totalChunks || !capture.sizeBytes) {
    return NextResponse.json({ error: "Upload not initialized — POST /api/uploads first" }, { status: 409 });
  }
  if (index >= totalChunks) {
    return NextResponse.json({ error: `Chunk index out of range (total ${totalChunks})` }, { status: 400 });
  }

  const data = Buffer.from(await req.arrayBuffer());
  if (data.length > MAX_CHUNK_BYTES) {
    return NextResponse.json({ error: "Chunk too large" }, { status: 413 });
  }
  const expected =
    index === totalChunks - 1 ? capture.sizeBytes - (totalChunks - 1) * chunkSize : chunkSize;
  if (data.length !== expected) {
    return NextResponse.json(
      { error: `Chunk ${index} must be ${expected} bytes, got ${data.length}` },
      { status: 400 }
    );
  }

  await saveChunk(id, index, data);
  const received = await listReceivedChunks(id);
  await updateCapture(id, (r) => ({
    ...r,
    upload: { ...r.upload, receivedChunks: received.length },
  }));

  return NextResponse.json({ received: received.length, totalChunks });
}
