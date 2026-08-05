// Capture records as JSON files under DATA_DIR/captures — dev-scale storage
// with atomic writes (tmp + rename). Swappable for a real DB behind the same
// four functions without touching route code.

import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { DATA_DIR } from "./config";
import type { CaptureRecord } from "../types";

const CAPTURES_DIR = path.join(DATA_DIR, "captures");

const ID_RE = /^[a-f0-9-]{8,64}$/i;

/** Reject anything that isn't a plain capture id — these ids become file
 * paths, so this is also the path-traversal guard. */
export function isValidCaptureId(id: string): boolean {
  return ID_RE.test(id);
}

export function newCaptureId(): string {
  return randomUUID();
}

function capturePath(id: string): string {
  if (!isValidCaptureId(id)) throw new Error(`Invalid capture id: ${id}`);
  return path.join(CAPTURES_DIR, `${id}.json`);
}

export async function readCapture(id: string): Promise<CaptureRecord | null> {
  try {
    const raw = await fs.readFile(capturePath(id), "utf8");
    return JSON.parse(raw) as CaptureRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeCapture(record: CaptureRecord): Promise<void> {
  const target = capturePath(record.id);
  await fs.mkdir(CAPTURES_DIR, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
  await fs.rename(tmp, target);
}

/** Read-modify-write helper so call sites can't forget the re-read. Not
 * concurrency-proof across processes — fine for the dev store. */
export async function updateCapture(
  id: string,
  mutate: (record: CaptureRecord) => CaptureRecord | Promise<CaptureRecord>
): Promise<CaptureRecord | null> {
  const current = await readCapture(id);
  if (!current) return null;
  const next = await mutate(current);
  await writeCapture(next);
  return next;
}
