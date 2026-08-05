// IndexedDB persistence for recorded videos: the blob survives page reloads
// and connection drops, so an interrupted upload can resume from the report
// screen (or the home screen's "interrupted uploads" list).
//
// Entries saved at record-stop start life under a client-generated
// `local-…` id with `registered: false` and the capture metadata attached;
// once the hash-timestamp POST lands they are re-keyed to the server
// capture id. Entries without the `registered` flag predate it and are
// treated as registered.

import type { CaptureCreateRequest } from "./types";

export interface PendingVideo {
  captureId: string;
  blob: Blob;
  mime: string;
  size: number;
  createdAt: string;
  source: "recorded" | "library";
  /** false until the hash-timestamp POST has landed (offline record-stop). */
  registered?: boolean;
  /** Capture metadata kept locally so registration can be replayed later. */
  meta?: CaptureCreateRequest;
}

const DB_NAME = "walkaround-inspector";
const STORE = "pending-videos";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "captureId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Resolves on TRANSACTION completion, not request success — a write whose
 * transaction later aborts (e.g. Safari hitting a storage quota) must
 * reject, or callers would believe unsaved data is safe. */
function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        let result: T;
        req.onsuccess = () => {
          result = req.result as T;
        };
        t.oncomplete = () => {
          db.close();
          resolve(result);
        };
        const fail = () => {
          db.close();
          reject(t.error ?? req.error ?? new Error("IndexedDB transaction failed"));
        };
        t.onerror = fail;
        t.onabort = fail;
      })
  );
}

export function savePendingVideo(v: PendingVideo): Promise<void> {
  return tx("readwrite", (s) => s.put(v)).then(() => undefined);
}

export function getPendingVideo(
  captureId: string
): Promise<PendingVideo | undefined> {
  return tx("readonly", (s) => s.get(captureId));
}

export function listPendingVideos(): Promise<PendingVideo[]> {
  return tx<PendingVideo[]>("readonly", (s) => s.getAll()).then((all) =>
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  );
}

export function deletePendingVideo(captureId: string): Promise<void> {
  return tx("readwrite", (s) => s.delete(captureId)).then(() => undefined);
}
