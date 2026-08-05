import path from "path";

/** SINGLE SOURCE OF TRUTH for the trained detection model (owner-trained,
 * live). Workflow definitions each pin this same ID in their model block. */
export const MODEL_ID =
  "aarnavs-space/car-damage-detection-5ioys-rigvq-1-rfdetr-small-t1";

/** Runtime storage root (captures, chunks, videos, TSA tokens). Dev default
 * is <cwd>/data (gitignored); deployments point DATA_DIR at a volume. */
export const DATA_DIR =
  process.env.DATA_DIR ?? path.join(process.cwd(), "data");

/** RFC 3161 timestamp authority. */
export const TSA_URL = process.env.TSA_URL ?? "https://freetsa.org/tsr";

/** Give the TSA this long before marking the token pending for retry. */
export const TSA_TIMEOUT_MS = 5000;

/** Don't re-attempt a pending TSA token more often than this. */
export const TSA_RETRY_MIN_INTERVAL_MS = 30_000;

/** Upload chunk uploads larger than this are rejected. */
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

/** Whole-video ceiling (10 min of 1080p leaves huge headroom over the ~90 s
 * walkaround this is designed for). */
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
