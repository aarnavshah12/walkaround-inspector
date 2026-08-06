// Minimal DER reader + RFC 3161 response parsing. Isomorphic (Uint8Array
// only — runs in the browser verifier and in Node): parses just the shapes
// this product produces and checks. Not a general ASN.1 library.

export interface Tlv {
  tag: number;
  length: number;
  /** Offset of the first content byte. */
  contentStart: number;
  /** Offset one past the last content byte. */
  end: number;
}

export function readTlv(bytes: Uint8Array, offset: number): Tlv | null {
  if (offset + 2 > bytes.length) return null;
  const tag = bytes[offset];
  let length = bytes[offset + 1];
  let contentStart = offset + 2;
  if (length & 0x80) {
    const numBytes = length & 0x7f;
    if (numBytes === 0 || numBytes > 4 || contentStart + numBytes > bytes.length) return null;
    length = 0;
    for (let i = 0; i < numBytes; i++) length = length * 256 + bytes[contentStart + i];
    contentStart += numBytes;
  }
  if (contentStart + length > bytes.length) return null;
  return { tag, length, contentStart, end: contentStart + length };
}

/** Direct children of a constructed TLV, in order. */
export function children(bytes: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let offset = parent.contentStart;
  while (offset < parent.end) {
    const child = readTlv(bytes, offset);
    if (!child || child.end > parent.end) break;
    out.push(child);
    offset = child.end;
  }
  return out;
}

export function oidToString(bytes: Uint8Array, tlv: Tlv): string {
  const parts: number[] = [];
  let value = 0;
  for (let i = tlv.contentStart; i < tlv.end; i++) {
    value = value * 128 + (bytes[i] & 0x7f);
    if ((bytes[i] & 0x80) === 0) {
      if (parts.length === 0) {
        parts.push(Math.floor(value / 40) > 2 ? 2 : Math.floor(value / 40));
        parts.push(value - parts[0] * 40);
      } else {
        parts.push(value);
      }
      value = 0;
    }
  }
  return parts.join(".");
}

export function toHex(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/** GeneralizedTime "YYYYMMDDHHMMSS[.fff]Z" → ISO 8601, or null. */
export function parseGeneralizedTime(text: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(text);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? "." + m[7] : ""}Z`;
}

const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const OID_TST_INFO = "1.2.840.113549.1.9.16.1.4";
export const OID_SHA256 = "2.16.840.1.101.3.4.2.1";

export interface TstInfo {
  policyOid: string;
  hashAlgorithmOid: string;
  /** messageImprint.hashedMessage, lowercase hex. */
  hashedMessageHex: string;
  serialHex: string;
  /** ISO 8601, or null if the GeneralizedTime didn't parse. */
  genTime: string | null;
}

export interface ParsedTimeStampResp {
  /** PKIStatus: 0 granted, 1 grantedWithMods, others = failure. */
  status: number;
  tstInfo: TstInfo | null;
}

/** Parse a raw RFC 3161 TimeStampResp: status + the TSTInfo the token
 * attests. Signature/cert-chain validation is intentionally out of scope
 * (surfaced to users as "verify independently with openssl"). */
export function parseTimeStampResp(bytes: Uint8Array): ParsedTimeStampResp | null {
  const outer = readTlv(bytes, 0);
  if (!outer || outer.tag !== 0x30) return null;
  const [statusInfo, contentInfo] = children(bytes, outer);
  if (!statusInfo || statusInfo.tag !== 0x30) return null;
  const statusInt = children(bytes, statusInfo)[0];
  if (!statusInt || statusInt.tag !== 0x02 || statusInt.length < 1) return null;
  const status = bytes[statusInt.contentStart];
  if (!contentInfo) return { status, tstInfo: null };
  return { status, tstInfo: parseTimeStampToken(bytes, contentInfo) };
}

/** Parse the TimeStampToken (CMS ContentInfo/SignedData) down to TSTInfo. */
export function parseTimeStampToken(bytes: Uint8Array, contentInfo: Tlv): TstInfo | null {
  if (contentInfo.tag !== 0x30) return null;
  const ciKids = children(bytes, contentInfo);
  if (ciKids.length < 2 || ciKids[0].tag !== 0x06) return null;
  if (oidToString(bytes, ciKids[0]) !== OID_SIGNED_DATA) return null;
  const explicit = ciKids[1];
  if (explicit.tag !== 0xa0) return null;
  const signedData = readTlv(bytes, explicit.contentStart);
  if (!signedData || signedData.tag !== 0x30) return null;
  // SignedData: version, digestAlgorithms SET, encapContentInfo, ...
  const sdKids = children(bytes, signedData);
  const encap = sdKids.find(
    (k, i) => k.tag === 0x30 && i >= 2 // encapContentInfo is the first SEQUENCE after version+SET
  );
  if (!encap) return null;
  const encapKids = children(bytes, encap);
  if (encapKids.length < 2 || oidToString(bytes, encapKids[0]) !== OID_TST_INFO) return null;
  if (encapKids[1].tag !== 0xa0) return null;
  const octet = readTlv(bytes, encapKids[1].contentStart);
  if (!octet || octet.tag !== 0x04) return null;
  const tstSeq = readTlv(bytes, octet.contentStart);
  if (!tstSeq || tstSeq.tag !== 0x30) return null;

  const kids = children(bytes, tstSeq);
  // TSTInfo: version INT, policy OID, messageImprint SEQ, serial INT, genTime
  if (kids.length < 5 || kids[1].tag !== 0x06 || kids[2].tag !== 0x30) return null;
  const imprintKids = children(bytes, kids[2]);
  const algSeq = imprintKids[0];
  const hashed = imprintKids[1];
  if (!algSeq || !hashed || hashed.tag !== 0x04) return null;
  const algOidTlv = children(bytes, algSeq)[0];
  const genTimeTlv = kids.find((k) => k.tag === 0x18);
  const genTimeText = genTimeTlv
    ? String.fromCharCode(...bytes.subarray(genTimeTlv.contentStart, genTimeTlv.end))
    : "";
  return {
    policyOid: oidToString(bytes, kids[1]),
    hashAlgorithmOid: algOidTlv ? oidToString(bytes, algOidTlv) : "",
    hashedMessageHex: toHex(bytes, hashed.contentStart, hashed.end),
    serialHex: toHex(bytes, kids[3].contentStart, kids[3].end),
    genTime: parseGeneralizedTime(genTimeText),
  };
}
