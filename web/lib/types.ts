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
  createdAt: string;
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
