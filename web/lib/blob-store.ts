// IndexedDB persistence for recorded videos: the blob survives page reloads
// and connection drops, so an interrupted upload can resume from the report
// screen (or the home screen's "interrupted uploads" list).

export interface PendingVideo {
  captureId: string;
  blob: Blob;
  mime: string;
  size: number;
  createdAt: string;
  source: "recorded" | "library";
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

function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
        t.onabort = () => db.close();
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
