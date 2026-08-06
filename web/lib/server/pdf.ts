// Signed-report PDF layout (pdf-lib). Produces the complete document with
// three fixed-length PLACEHOLDER windows (QR pixels, signature text, machine
// payload) that report.ts fills in after signing — see lib/sig-format.ts for
// the byte contract. Everything else on these pages is static and therefore
// inside the signed region.

import { promises as fs } from "fs";
import path from "path";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import type { CaptureRecord, Finding, FindingsReport } from "../types";
import { parseTimeStampResp, toHex } from "../der";
import {
  QR_MODULES,
  SENTINEL_A,
  SENTINEL_B,
  SENTINEL_C,
  WINDOWS_FIELD_LEN,
  deriveWindowA,
  deriveWindowB,
  deriveWindowC,
  canonicalPayload,
  dummyInputs,
  isoSeconds,
} from "../sig-format";

const PAGE: [number, number] = [595, 842]; // A4
const MARGIN = 56;
const TEXT = rgb(0.12, 0.12, 0.16);
const MUTED = rgb(0.45, 0.45, 0.52);
const WARN = rgb(0.72, 0.5, 0.1);

function placeholder(sentinel: string, length: number, pad: number): Uint8Array {
  const bytes = new Uint8Array(length).fill(pad);
  bytes.set(new TextEncoder().encode(sentinel), 0);
  return bytes;
}

interface Ctx {
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}

function header(ctx: Ctx, page: PDFPage, title: string): number {
  page.drawText("Walkaround Inspector", { x: MARGIN, y: 800, size: 10, font: ctx.bold, color: MUTED });
  page.drawText(title, { x: MARGIN, y: 770, size: 20, font: ctx.bold, color: TEXT });
  return 740;
}

function line(ctx: Ctx, page: PDFPage, y: number, label: string, value: string, mono = false): number {
  page.drawText(label, { x: MARGIN, y, size: 9, font: ctx.font, color: MUTED });
  page.drawText(value, {
    x: MARGIN + 150,
    y,
    size: mono ? 8 : 9,
    font: mono ? ctx.mono : ctx.font,
    color: TEXT,
  });
  return y - 16;
}

export interface LayoutResult {
  bytes: Uint8Array;
  /** ISO-seconds capture time as printed/signed (verifier compares this). */
  captureTimeIso: string;
}

export async function layoutReportPdf(
  capture: CaptureRecord,
  report: FindingsReport,
  cropsDir: string,
  captureTsr: Uint8Array | null,
  publicKeyB64: string
): Promise<LayoutResult> {
  const doc = await PDFDocument.create();
  const ctx: Ctx = {
    doc,
    font: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const captureTimeIso = isoSeconds(capture.clientTime);

  // ---- cover ---------------------------------------------------------------
  const cover = doc.addPage(PAGE);
  let y = header(ctx, cover, "Vehicle inspection report");
  y = line(ctx, cover, y, "Capture id", capture.id, true);
  y = line(
    ctx,
    cover,
    y,
    capture.source === "recorded" ? "Recorded at" : "Received at",
    `${captureTimeIso} (UTC)`
  );
  y = line(ctx, cover, y, "Source", capture.source === "recorded" ? "Recorded in app (capture-time proof)" : "Uploaded video (receipt-time proof)");
  if (capture.durationMs) y = line(ctx, cover, y, "Video duration", `${Math.round(capture.durationMs / 1000)} s`);
  if (capture.segments?.length) y = line(ctx, cover, y, "Guided coverage", `${capture.segments.length} areas`);
  const vehicle = report.vehicle;
  if (vehicle && Object.values(vehicle).some((v) => v && v !== "unknown" && v !== "unreadable")) {
    y -= 8;
    cover.drawText("Vehicle (AI-assessed)", { x: MARGIN, y, size: 11, font: ctx.bold, color: TEXT });
    y -= 18;
    const desc = [vehicle.color, vehicle.make, vehicle.model, vehicle.model_year_range]
      .filter((v) => v && v !== "unknown")
      .join(" ");
    if (desc) y = line(ctx, cover, y, "Vehicle", desc);
    if (vehicle.license_plate && vehicle.license_plate !== "unreadable") {
      y = line(ctx, cover, y, "License plate", vehicle.license_plate);
    }
  }
  y -= 12;
  cover.drawText("Measured vs AI-assessed", { x: MARGIN, y, size: 11, font: ctx.bold, color: TEXT });
  y -= 16;
  for (const t of [
    "Measured: the video fingerprint (SHA-256), timestamp-authority tokens, and upload times",
    "are cryptographic facts. AI-assessed: detections, damage assessments, and vehicle identity",
    "are model outputs and may contain errors. This report is not legal advice.",
  ]) {
    cover.drawText(t, { x: MARGIN, y, size: 9, font: ctx.font, color: MUTED });
    y -= 13;
  }

  // ---- findings ------------------------------------------------------------
  const active = report.findings.filter((f) => !f.veto);
  const vetoed = report.findings.filter((f) => f.veto);
  let page = doc.addPage(PAGE);
  y = header(ctx, page, `Findings (${active.length})`);
  if (active.length === 0) {
    page.drawText("No confirmed damage was found in this walkaround.", { x: MARGIN, y, size: 11, font: ctx.font, color: TEXT });
    y -= 16;
  }
  for (const f of active) {
    if (y < 250) {
      page = doc.addPage(PAGE);
      y = header(ctx, page, "Findings (continued)");
    }
    y = await drawFinding(ctx, page, y, f, cropsDir);
  }
  if (vetoed.length > 0 || report.rejected.length > 0) {
    if (y < 120) {
      page = doc.addPage(PAGE);
      y = header(ctx, page, "Findings (continued)");
    }
    page.drawText(
      `${vetoed.length} detection(s) assessed by AI as likely false positives and ${report.rejected.length} candidate(s) ` +
        `rejected by the temporal parallax filter (reflections/glare) are excluded above.`,
      { x: MARGIN, y, size: 9, font: ctx.font, color: WARN }
    );
  }

  // ---- appendix ------------------------------------------------------------
  const appendix = doc.addPage(PAGE);
  y = header(ctx, appendix, "Evidence appendix");
  y = line(ctx, appendix, y, "Video SHA-256", capture.hash, true);
  y = line(ctx, appendix, y, "Client capture time", `${captureTimeIso} (UTC)`);
  y = line(ctx, appendix, y, "Server receipt time", `${isoSeconds(capture.serverTime)} (UTC)`);
  if (captureTsr) {
    const parsed = parseTimeStampResp(captureTsr);
    if (parsed?.tstInfo) {
      y -= 8;
      appendix.drawText("Capture timestamp token (RFC 3161)", { x: MARGIN, y, size: 11, font: ctx.bold, color: TEXT });
      y -= 18;
      y = line(ctx, appendix, y, "Token time", `${parsed.tstInfo.genTime ?? "unparsed"} (UTC)`);
      y = line(ctx, appendix, y, "Serial", parsed.tstInfo.serialHex, true);
      y = line(ctx, appendix, y, "Policy OID", parsed.tstInfo.policyOid, true);
      y = line(ctx, appendix, y, "Imprint (SHA-256)", parsed.tstInfo.hashedMessageHex, true);
    }
  }
  y -= 12;
  for (const t of [
    "The capture token proves the video's exact bytes existed no later than the token time.",
    capture.source === "library"
      ? "This video was uploaded from a library, so the token proves receipt time, not filming time."
      : "This video was recorded in-app; its fingerprint was timestamped at record-stop.",
    "Verify independently at the verifier page, or with openssl using the embedded tokens.",
  ]) {
    appendix.drawText(t, { x: MARGIN, y, size: 9, font: ctx.font, color: MUTED });
    y -= 13;
  }

  // ---- verification page (windows live here) -------------------------------
  const verify = doc.addPage(PAGE);
  y = header(ctx, verify, "Verification");
  for (const t of [
    "This report is signed with ECDSA P-256. The signature covers every byte of this file",
    "except three fixed windows (the QR pixels, the printed values below, and the machine",
    "payload), whose contents are deterministically derived from the signed values — any",
    "modification anywhere in the file invalidates verification.",
  ]) {
    verify.drawText(t, { x: MARGIN, y, size: 9, font: ctx.font, color: MUTED });
    y -= 13;
  }
  y = line(ctx, verify, y - 8, "Video SHA-256", capture.hash, true);
  y = line(ctx, verify, y, "Signing key (SHA-256 of public point)", "", false);
  verify.drawText(publicKeyB64, { x: MARGIN, y: y + 16 - 12, size: 7, font: ctx.mono, color: TEXT });
  y -= 10;

  // Static labels for the Window B value lines (values drawn by the window
  // stream at fixed positions: x=56, first baseline y=210, leading 11).
  verify.drawText("Signature (ECDSA P-256, base64url, two lines):", { x: MARGIN, y: 232, size: 9, font: ctx.font, color: MUTED });
  verify.drawText("Report digest (SHA-256 of signed bytes):", { x: MARGIN, y: 196, size: 9, font: ctx.font, color: MUTED });
  verify.drawText("Report timestamp (RFC 3161 token time):", { x: MARGIN, y: 174, size: 9, font: ctx.font, color: MUTED });

  const context = doc.context;
  const dummy = dummyInputs();

  // Window A — QR image XObject (raw grayscale pixels).
  const winALen = deriveWindowA(canonicalPayload(dummy)).length;
  const qrDict = context.obj({
    Type: "XObject",
    Subtype: "Image",
    Width: QR_MODULES,
    Height: QR_MODULES,
    ColorSpace: "DeviceGray",
    BitsPerComponent: 8,
    Length: winALen,
  });
  const qrRef = context.register(PDFRawStream.of(qrDict, placeholder(SENTINEL_A, winALen, 0xff)));
  const resources = verify.node.normalizedEntries().Resources;
  let xobjects = resources.lookup(PDFName.of("XObject"));
  if (!(xobjects instanceof PDFDict)) {
    xobjects = context.obj({});
    resources.set(PDFName.of("XObject"), xobjects as PDFDict);
  }
  (xobjects as PDFDict).set(PDFName.of("WAIQR"), qrRef);
  verify.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(170, 0, 0, 170, 370, 480),
    drawObject("WAIQR"),
    popGraphicsState()
  );
  verify.drawText("Scan for offline verification payload", { x: 370, y: 466, size: 8, font: ctx.font, color: MUTED });

  // Window B — dynamic text stream appended to this page's contents. Needs
  // the /WAIF font resource the stream references.
  let fonts = resources.lookup(PDFName.of("Font"));
  if (!(fonts instanceof PDFDict)) {
    fonts = context.obj({});
    resources.set(PDFName.of("Font"), fonts as PDFDict);
  }
  (fonts as PDFDict).set(PDFName.of("WAIF"), ctx.mono.ref);
  const winBLen = deriveWindowB(dummy).length;
  const winBRef = context.register(
    PDFRawStream.of(context.obj({ Length: winBLen }), placeholder(SENTINEL_B, winBLen, 0x20))
  );
  verify.node.normalize();
  const contents = verify.node.Contents();
  if (!(contents instanceof PDFArray)) throw new Error("Expected normalized Contents array");
  contents.push(winBRef);

  // Window C — machine payload stream, referenced from /WAIVerify.
  const winCLen = deriveWindowC(dummy, "").length;
  const winCRef = context.register(
    PDFRawStream.of(context.obj({ Length: winCLen }), placeholder(SENTINEL_C, winCLen, 0x20))
  );

  // /WAIVerify — machine-readable verification dict in the Catalog. All
  // values here are signature-independent and therefore fully signed.
  const verifyDict = context.obj({
    Type: "WAIVerify",
    V: 1,
    VideoHash: PDFString.of(capture.hash),
    PubKey: PDFString.of(publicKeyB64),
    CaptureId: PDFString.of(capture.id),
    CaptureTime: PDFString.of(captureTimeIso),
    ServerTime: PDFString.of(isoSeconds(capture.serverTime)),
    Source: PDFString.of(capture.source),
    CaptureTSR: captureTsr ? PDFHexString.of(toHex(captureTsr, 0, captureTsr.length)) : PDFString.of(""),
    WAIWindows: PDFString.of("0".repeat(10) + (" " + "0".repeat(10)).repeat(5)),
    SigPayload: winCRef,
  });
  if (verifyDict.get(PDFName.of("WAIWindows"))!.toString().length !== WINDOWS_FIELD_LEN + 2) {
    throw new Error("WAIWindows placeholder width mismatch");
  }
  doc.catalog.set(PDFName.of("WAIVerify"), context.register(verifyDict));

  doc.setTitle(`Walkaround inspection report ${capture.id}`);
  doc.setSubject(`video-sha256:${capture.hash}`);
  doc.setKeywords([capture.hash, publicKeyB64]);
  doc.setProducer("Walkaround Inspector");
  doc.setCreationDate(new Date(capture.serverTime));
  doc.setModificationDate(new Date(capture.serverTime));

  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return { bytes, captureTimeIso };
}

async function drawFinding(ctx: Ctx, page: PDFPage, y: number, f: Finding, cropsDir: string): Promise<number> {
  const top = y;
  let imgH = 0;
  if (f.crop) {
    try {
      const jpg = await ctx.doc.embedJpg(await fs.readFile(path.join(cropsDir, path.basename(f.crop))));
      const scale = Math.min(200 / jpg.width, 140 / jpg.height, 1);
      imgH = jpg.height * scale;
      page.drawImage(jpg, { x: MARGIN, y: top - imgH, width: jpg.width * scale, height: imgH });
    } catch {
      /* crop unreadable — text-only row */
    }
  }
  const tx = MARGIN + 220;
  let ty = top - 12;
  const title = f.assessment?.damage_type && f.assessment.damage_type !== "none" ? f.assessment.damage_type : f.class;
  page.drawText(`${f.id}: ${title}`, { x: tx, y: ty, size: 11, font: ctx.bold, color: TEXT });
  ty -= 15;
  const rows: string[] = [
    `Detector confidence: ${f.confidence.max != null ? Math.round(f.confidence.max * 100) + "%" : "n/a"} · tracked ${f.tracklet.frames} frames`,
    `Video time ${formatPts(f.best_frame.pts_ms)}${f.segment ? ` · ${f.segment.label}` : ""}${f.best_frame.wall_clock ? ` · ${isoSeconds(f.best_frame.wall_clock)}` : ""}`,
  ];
  const a = f.assessment;
  if (a) {
    rows.push(
      `AI-assessed: ${[a.severity, a.sub_type, a.affected_part, a.approx_size_cm ? `~${a.approx_size_cm} cm` : null]
        .filter(Boolean)
        .join(" · ")}`
    );
    if (a.pre_existing_indicators && a.pre_existing_indicators !== "none") {
      rows.push(`Pre-existing signs: ${a.pre_existing_indicators}`);
    }
  }
  for (const r of rows) {
    page.drawText(r.slice(0, 78), { x: tx, y: ty, size: 8.5, font: ctx.font, color: MUTED });
    ty -= 12;
  }
  return Math.min(ty, top - imgH) - 22;
}

function formatPts(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
