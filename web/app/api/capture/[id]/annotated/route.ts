// GET /api/capture/[id]/annotated — the annotated review video rendered by
// the runner. Supports single-range requests (Safari refuses to play video
// without them).

import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { isValidCaptureId } from "../../../../../lib/server/store";
import { DATA_DIR } from "../../../../../lib/server/config";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidCaptureId(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const file = path.join(DATA_DIR, "captures", id, "annotated.mp4");
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? parseInt(range[1], 10) : bytes.length - parseInt(range[2], 10);
    const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), bytes.length - 1) : bytes.length - 1;
    if (Number.isNaN(start) || start < 0 || start > end) {
      return new NextResponse(null, {
        status: 416,
        headers: { "content-range": `bytes */${bytes.length}` },
      });
    }
    return new NextResponse(new Uint8Array(bytes.subarray(start, end + 1)), {
      status: 206,
      headers: {
        "content-type": "video/mp4",
        "content-range": `bytes ${start}-${end}/${bytes.length}`,
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=3600",
      },
    });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "video/mp4",
      "content-length": String(bytes.length),
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
    },
  });
}
