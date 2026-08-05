import { createSHA256 } from "hash-wasm";

/** WebCrypto needs the whole payload in one ArrayBuffer; above this size we
 * stream slices through hash-wasm instead so multi-GB library videos don't
 * OOM the mobile tab. Both paths produce the same SHA-256. */
const WEBCRYPTO_MAX_BYTES = 128 * 1024 * 1024;
const SLICE_BYTES = 8 * 1024 * 1024;

/** SHA-256 of a Blob, lowercase hex. Requires a secure context (https or
 * localhost) — same requirement as camera access. */
export async function sha256Hex(blob: Blob): Promise<string> {
  if (blob.size <= WEBCRYPTO_MAX_BYTES) {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return toHex(new Uint8Array(digest));
  }
  const hasher = await createSHA256();
  hasher.init();
  for (let offset = 0; offset < blob.size; offset += SLICE_BYTES) {
    const slice = blob.slice(offset, Math.min(blob.size, offset + SLICE_BYTES));
    hasher.update(new Uint8Array(await slice.arrayBuffer()));
  }
  return hasher.digest("hex");
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
