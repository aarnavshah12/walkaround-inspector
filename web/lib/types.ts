// Shared shapes between the PWA client and the thin API.

export type CaptureSource = "recorded" | "library";

export interface SegmentMark {
  id: string;
  label: string;
  /** Offset from recording start, in ms. */
  startMs: number;
}

export type TsaStatus = "granted" | "pending" | "failed";

export interface CaptureRecord {
  id: string;
  /** SHA-256 of the video blob, lowercase hex, computed client-side. */
  hash: string;
  /** Client wall-clock at record-stop (ISO 8601). */
  clientTime: string;
  /** Server wall-clock when the hash arrived (ISO 8601). */
  serverTime: string;
  source: CaptureSource;
  mime: string;
  durationMs?: number;
  sizeBytes?: number;
  segments?: SegmentMark[];
  quality?: { width?: number; height?: number; warnings: string[] };
  tsa: {
    status: TsaStatus;
    url?: string;
    grantedAt?: string;
    lastAttemptAt?: string;
    error?: string;
  };
  upload: {
    status: "none" | "in_progress" | "complete";
    chunkSize?: number;
    totalChunks?: number;
    receivedChunks?: number;
    /** Server-side re-hash matches the timestamped client hash. */
    verified?: boolean;
    completedAt?: string;
  };
  /** Workflow V run state; written by the API on trigger and by the Python
   * runner as it progresses. Absent until an upload completes verified. */
  analysis?: {
    status: "queued" | "running" | "complete" | "failed" | "unavailable";
    startedAt?: string;
    finishedAt?: string;
    error?: string;
  };
  createdAt: string;
}

export interface FindingAssessment {
  damage_type?: string | null;
  sub_type?: string | null;
  severity?: string | null;
  approx_size_cm?: number | string | null;
  affected_part?: string | null;
  paint_broken?: boolean | string | null;
  pre_existing_indicators?: string | null;
  is_false_positive?: boolean | string | null;
  confidence_note?: string | null;
  ai_assessed: true;
}

export interface VehicleId {
  make?: string | null;
  model?: string | null;
  body_style?: string | null;
  color?: string | null;
  model_year_range?: string | null;
  license_plate?: string | null;
  fuel_door_side?: string | null;
}

export interface Finding {
  id: string;
  class: string;
  confidence: { mean: number | null; max: number | null };
  tracklet: {
    tracker_id: number;
    frames: number;
    first_pts_ms: number;
    last_pts_ms: number;
    median_residual_frac: number | null;
    median_saturation: number | null;
  };
  best_frame: {
    frame_number: number | null;
    pts_ms: number;
    wall_clock: string | null;
  };
  segment: { id: string; label: string } | null;
  xyxy: number[];
  crop: string | null;
  full_frame: string | null;
  assessment?: FindingAssessment;
  /** AI judged this a false positive (reflection/glare/shadow); shown
   * de-emphasized, never silently dropped. */
  veto?: boolean;
}

export interface FindingsReport {
  capture_id: string | null;
  generated_at: string;
  sample_fps: number;
  vehicle?: VehicleId | null;
  enrichment?: { status: "complete" | "partial" | "skipped"; errors?: string[] };
  findings: Finding[];
  rejected: { reason: string; class: string; frames: number }[];
}

export interface CaptureCreateRequest {
  hash: string;
  clientTime: string;
  source: CaptureSource;
  mime: string;
  durationMs?: number;
  sizeBytes?: number;
  segments?: SegmentMark[];
  quality?: { width?: number; height?: number; warnings: string[] };
}

export interface UploadInitRequest {
  captureId: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  mime: string;
}

export interface UploadInitResponse {
  received: number[];
  complete: boolean;
}
