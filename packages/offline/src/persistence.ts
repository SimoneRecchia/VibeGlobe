/** The browser's answer to a persistent-storage request (F276). */
export type PersistenceResult =
  | { readonly status: 'granted' | 'denied'; readonly persisted: boolean }
  /** The Storage API is missing (an old browser, an insecure context). */
  | { readonly status: 'unsupported'; readonly persisted: false };

/** The parts of `navigator.storage` the engine uses. */
export interface StorageManagerLike {
  persist?(): Promise<boolean>;
  persisted?(): Promise<boolean>;
  estimate?(): Promise<{ usage?: number; quota?: number }>;
}

function storageManager(): StorageManagerLike | undefined {
  return (globalThis as { navigator?: { storage?: StorageManagerLike } }).navigator?.storage;
}

/**
 * Asks the browser to keep the engine's storage under storage pressure with `navigator.storage.persist()`, and reports
 * the answer and the persisted state; safe where the Storage API is missing.
 */
export async function requestPersistence(storage = storageManager()): Promise<PersistenceResult> {
  if (!storage?.persist) return { status: 'unsupported', persisted: false };
  try {
    const granted = await storage.persist();
    const persisted = storage.persisted ? await storage.persisted() : granted;
    return { status: granted ? 'granted' : 'denied', persisted };
  } catch {
    return { status: 'denied', persisted: false };
  }
}

/** Whether the origin's storage is persisted (false where unknown). */
export async function isPersisted(storage = storageManager()): Promise<boolean> {
  try {
    return storage?.persisted ? await storage.persisted() : false;
  } catch {
    return false;
  }
}

/** The browser's quota for the origin, when it reports one. */
export async function browserQuotaBytes(storage = storageManager()): Promise<number | undefined> {
  try {
    return (await storage?.estimate?.())?.quota;
  } catch {
    return undefined;
  }
}
