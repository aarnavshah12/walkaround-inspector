// GET /api/capture/[id]/crops/[file] — best-frame crop JPEGs written by the
// runner. Filenames are strictly validated; nothing else under data/ is
// reachable through this route.

import { promises as fs } from "fs";
import { NextRequest, NextResponse } from "next/server";
import { isValidCaptureId } from "../../../../../../lib/server/store";
import { cropPath } from "../../../../../../lib/server/analysis";

export const dynamic = "force-dynamic";

const FILE_RE = /^track-\d+-(crop|full)\.jpg$/;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; file: string }> }
) {
  const { id, file } = await params;
  if (!isValidCaptureId(id) || !FILE_RE.test(file)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const data = await fs.readFile(cropPath(id, file));
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
