/** SHA-256 of a Blob via WebCrypto, lowercase hex. Requires a secure context
 * (https or localhost) — same requirement as camera access. */
export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
