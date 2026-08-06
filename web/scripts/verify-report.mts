// CLI verification harness (and tamper matrix for the acceptance test).
//
//   node --experimental-strip-types scripts/verify-report.mts report.pdf
//   node --experimental-strip-types scripts/verify-report.mts report.pdf --tamper
//
// --tamper flips single bytes at structurally distinct positions; every
// flip must FAIL verification and the untouched file must PASS.

import { readFileSync } from "node:fs";
import { verifyReport } from "../lib/verify-core.ts";

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error("usage: verify-report.mts <report.pdf> [--tamper]");
  process.exit(2);
}
const original = new Uint8Array(readFileSync(file));

function summarize(tag: string, result: Awaited<ReturnType<typeof verifyReport>>): boolean {
  const failed = result.checks.filter((c) => !c.pass && !c.advisory).map((c) => c.id);
  console.log(
    `${tag}: ${result.valid ? "PASS" : `FAIL (${failed.join(", ")})`}`
  );
  return result.valid;
}

const base = await verifyReport(original);
const baseOk = summarize("untampered", base);
for (const c of base.checks) {
  console.log(`  ${c.pass ? "✓" : "✗"} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
}

if (flag !== "--tamper") {
  process.exit(baseOk ? 0 : 1);
}
if (!baseOk) {
  console.error("tamper matrix requires a passing baseline");
  process.exit(1);
}

// Positions: early header, 25/50/75% marks (page content, images, xref
// territory), inside each window, the /VideoHash field, and the tail.
const latin1 = new TextDecoder("latin1").decode(original);
const positions: Array<[string, number]> = [
  ["header", 5],
  ["quarter", Math.floor(original.length * 0.25)],
  ["half", Math.floor(original.length * 0.5)],
  ["three-quarters", Math.floor(original.length * 0.75)],
  ["video-hash-field", latin1.indexOf("/VideoHash (") + 14],
  ["windows-field", latin1.indexOf("/WAIWindows (") + 15],
  ["window-A", latin1.indexOf("WAI-SIG-PAYLOAD") - 8000 > 0 ? latin1.indexOf("WAI-SIG-PAYLOAD") - 8000 : Math.floor(original.length * 0.6)],
  ["payload-sig", latin1.indexOf('"sig":"') + 10],
  ["near-eof", original.length - 4],
];

let allFailed = true;
for (const [name, pos] of positions) {
  if (pos < 0 || pos >= original.length) {
    console.log(`tamper@${name}: SKIP (position not found)`);
    continue;
  }
  const copy = original.slice();
  copy[pos] = copy[pos] ^ 0x01;
  const r = await verifyReport(copy);
  const failedAsExpected = !r.valid;
  allFailed &&= failedAsExpected;
  console.log(`tamper@${name} (byte ${pos}): ${failedAsExpected ? "correctly FAILED" : "!!! STILL PASSES"}`);
}

// Append-after-EOF must also fail.
const appended = new Uint8Array(original.length + 1);
appended.set(original);
appended[original.length] = 0x0a;
const rAppend = await verifyReport(appended);
allFailed &&= !rAppend.valid;
console.log(`tamper@append-after-eof: ${!rAppend.valid ? "correctly FAILED" : "!!! STILL PASSES"}`);

console.log(allFailed ? "TAMPER MATRIX: PASS" : "TAMPER MATRIX: FAIL");
process.exit(allFailed ? 0 : 1);
