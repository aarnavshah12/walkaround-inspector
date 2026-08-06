// GET /api/public-key — the published report-signing public key, for
// independent verification. The fingerprint should also be published
// out-of-band (repo README) so trust doesn't depend on this server.

import { NextResponse } from "next/server";
import { getSignerInfo } from "../../../lib/server/signer";

export const dynamic = "force-dynamic";

export async function GET() {
  const info = await getSignerInfo();
  if (!info.available) {
    return NextResponse.json({ error: info.reason }, { status: 500 });
  }
  return NextResponse.json({
    pem: info.publicKeyPem,
    jwk: info.publicKeyJwk,
    raw_b64url: info.publicKeyB64,
    fingerprint_sha256: info.fingerprint,
  });
}
