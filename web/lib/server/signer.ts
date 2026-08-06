// Report signing key (P-256). The private key arrives ONLY via the
// REPORT_SIGNING_KEY env var as PKCS#8 PEM — never from a file in the repo.
// Generate one with:
//
//   openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt
//
// Signatures are raw r‖s (64 bytes) — WebCrypto's native ECDSA output —
// because their fixed length is what keeps the PDF signature windows
// constant-size. The verifier uses WebCrypto symmetric to this.

import { createHash, createPrivateKey, createPublicKey, webcrypto } from "crypto";
import { toB64url } from "../sig-format";

export interface SignerInfo {
  available: true;
  /** Uncompressed point (0x04 || X || Y), 65 bytes. */
  publicKeyRaw: Uint8Array;
  publicKeyB64: string;
  publicKeyPem: string;
  publicKeyJwk: JsonWebKey;
  /** SHA-256 of the 65-byte point, hex. */
  fingerprint: string;
}

export interface SignerUnavailable {
  available: false;
  reason: string;
}

let cached: (SignerInfo & { key: CryptoKey }) | SignerUnavailable | null = null;

async function load(): Promise<(SignerInfo & { key: CryptoKey }) | SignerUnavailable> {
  if (cached) return cached;
  const pem = process.env.REPORT_SIGNING_KEY;
  if (!pem) {
    cached = {
      available: false,
      reason:
        "REPORT_SIGNING_KEY is not set. Generate a P-256 key with: " +
        "openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt " +
        "and provide the PEM via the environment (never commit it).",
    };
    return cached;
  }
  try {
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "ec") throw new Error("not an EC key");
    const publicKey = createPublicKey(privateKey);
    const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
    if (jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new Error("not a P-256 key");
    const x = Buffer.from(jwk.x, "base64url");
    const y = Buffer.from(jwk.y, "base64url");
    const raw = new Uint8Array(65);
    raw[0] = 0x04;
    raw.set(x, 1);
    raw.set(y, 33);
    const key = await webcrypto.subtle.importKey(
      "pkcs8",
      new Uint8Array(privateKey.export({ format: "der", type: "pkcs8" })),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
    cached = {
      available: true,
      key,
      publicKeyRaw: raw,
      publicKeyB64: toB64url(raw),
      publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      publicKeyJwk: jwk,
      fingerprint: createHash("sha256").update(raw).digest("hex"),
    };
    return cached;
  } catch (err) {
    cached = { available: false, reason: `REPORT_SIGNING_KEY invalid: ${(err as Error).message}` };
    return cached;
  }
}

export async function getSignerInfo(): Promise<SignerInfo | SignerUnavailable> {
  const s = await load();
  if (!s.available) return s;
  const { key: _key, ...info } = s;
  return info;
}

/** Raw 64-byte r‖s ECDSA-SHA256 signature over `bytes`. */
export async function signBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const s = await load();
  if (!s.available) throw new Error(s.reason);
  const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, s.key, bytes);
  return new Uint8Array(sig);
}
