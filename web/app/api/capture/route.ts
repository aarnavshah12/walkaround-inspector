// POST /api/capture — the hash-timestamp endpoint. Deliberately tiny: the
// client sends {hash, clientTime, ...} the moment recording stops, before the
// video itself uploads, so this must succeed on one bar of signal. The RFC
// 3161 request runs inline with a short timeout; on failure the token is
// marked pending and retried on later status reads.

import { NextRequest, NextResponse } from "next/server";
import type { CaptureCreateRequest, CaptureRecord } from "../../../lib/types";
import { newCaptureId, writeCapture, updateCapture } from "../../../lib/server/store";
import { requestTimestamp } from "../../../lib/server/tsa";
import { TSA_URL } from "../../../lib/server/config";

export const dynamic = "force-dynamic";

const HASH_RE = /^[a-f0-9]{64}$/;

export async function POST(req: NextRequest) {
  let body: CaptureCreateRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.hash !== "string" || !HASH_RE.test(body.hash)) {
    return NextResponse.json({ error: "hash must be 64 hex chars (SHA-256)" }, { status: 400 });
  }
  if (typeof body.clientTime !== "string" || Number.isNaN(Date.parse(body.clientTime))) {
    return NextResponse.json({ error: "clientTime must be an ISO date string" }, { status: 400 });
  }
  if (body.source !== "recorded" && body.source !== "library") {
    return NextResponse.json({ error: "source must be 'recorded' or 'library'" }, { status: 400 });
  }
  if (typeof body.mime !== "string" || !body.mime.startsWith("video/")) {
    return NextResponse.json({ error: "mime must be a video/* type" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const record: CaptureRecord = {
    id: newCaptureId(),
    hash: body.hash,
    clientTime: body.clientTime,
    serverTime: now,
    source: body.source,
    mime: body.mime,
    durationMs: typeof body.durationMs === "number" ? body.durationMs : undefined,
    sizeBytes: typeof body.sizeBytes === "number" ? body.sizeBytes : undefined,
    segments: Array.isArray(body.segments) ? body.segments : undefined,
    quality: body.quality,
    tsa: { status: "pending", url: TSA_URL },
    upload: { status: "none" },
    createdAt: now,
  };
  await writeCapture(record);

  // Inline TSA attempt — bounded by TSA_TIMEOUT_MS so the response stays
  // within the "2 s after record-stop" budget even when the TSA is down.
  const tsa = await requestTimestamp(record.id, record.hash);
  const updated = await updateCapture(record.id, (r) => ({
    ...r,
    tsa: tsa.ok
      ? { ...r.tsa, status: "granted", grantedAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString() }
      : { ...r.tsa, status: "pending", error: tsa.error, lastAttemptAt: new Date().toISOString() },
  }));

  return NextResponse.json(updated ?? record, { status: 201 });
}
