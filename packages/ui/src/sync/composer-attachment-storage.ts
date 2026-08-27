import type { AttachedFile } from "@/stores/types/sessionTypes"
import { getStoragePrincipal } from "@/stores/utils/safeStorage"

const DB_NAME = "openchamber-composer-attachments"
const STORE_NAME = "attachments"
const DB_VERSION = 1

export type PersistedComposerAttachment = {
  version: 1
  id: string
  dataUrl: string
  mimeType: string
  filename: string
  size: number
  source: AttachedFile["source"]
  serverPath?: string
  vscodePath?: string
  vscodeSource?: AttachedFile["vscodeSource"]
}

export type ComposerAttachmentPersistence = {
  read(key: string): Promise<unknown>
  write(key: string, records: PersistedComposerAttachment[]): Promise<void>
  remove(key: string): Promise<void>
}

const isBrowser = (): boolean => typeof window !== "undefined" && typeof indexedDB !== "undefined"

const openDatabase = (): Promise<IDBDatabase> => {
  if (!isBrowser()) return Promise.reject(new Error("IndexedDB is unavailable"))
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Failed to open composer attachment storage"))
  })
}

let databasePromise: Promise<IDBDatabase> | null = null

const getDatabase = (): Promise<IDBDatabase> => {
  if (!databasePromise) {
    databasePromise = openDatabase().then((database) => {
      database.onclose = () => { databasePromise = null }
      database.onversionchange = () => database.close()
      return database
    }).catch((error: unknown) => {
      databasePromise = null
      throw error
    })
  }
  return databasePromise
}

const runTransaction = async <T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
): Promise<T> => {
  const database = await getDatabase()
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const store = transaction.objectStore(STORE_NAME)
    action(store, resolve, reject)
    transaction.onerror = () => reject(transaction.error ?? new Error("Composer attachment storage transaction failed"))
    transaction.onabort = () => reject(transaction.error ?? new Error("Composer attachment storage transaction aborted"))
  })
}

const indexedDbPersistence: ComposerAttachmentPersistence = {
  read: (key) => runTransaction<unknown>("readonly", (store, resolve, reject) => {
    const request = store.get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Composer attachment read failed"))
  }),
  write: (key, records) => runTransaction<void>("readwrite", (store, resolve, reject) => {
    const transaction = store.transaction
    store.put(records, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error("Composer attachment write failed"))
  }),
  remove: (key) => runTransaction<void>("readwrite", (store, resolve, reject) => {
    const transaction = store.transaction
    store.delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error("Composer attachment removal failed"))
  }),
}

const nonBrowserPersistence: ComposerAttachmentPersistence = {
  read: async () => undefined,
  write: async () => {},
  remove: async () => {},
}

let persistenceOverride: ComposerAttachmentPersistence | null = null

const persistence = (): ComposerAttachmentPersistence => {
  if (persistenceOverride) return persistenceOverride
  return typeof window === "undefined" ? nonBrowserPersistence : indexedDbPersistence
}

export const setComposerAttachmentPersistenceForTests = (
  next: ComposerAttachmentPersistence | null,
): void => {
  persistenceOverride = next
}

export const getPersistedComposerAttachmentKey = (targetKey: string): string =>
  `${encodeURIComponent(getStoragePrincipal())}:${targetKey}`

export const serializeComposerAttachments = (
  attachments: readonly AttachedFile[],
): PersistedComposerAttachment[] => attachments.map((attachment) => ({
  version: 1,
  id: attachment.id,
  dataUrl: attachment.dataUrl,
  mimeType: attachment.mimeType,
  filename: attachment.filename,
  size: Math.max(0, Number.isFinite(attachment.size) ? attachment.size : 0),
  source: attachment.source,
  ...(attachment.serverPath ? { serverPath: attachment.serverPath } : {}),
  ...(attachment.vscodePath ? { vscodePath: attachment.vscodePath } : {}),
  ...(attachment.vscodeSource ? { vscodeSource: attachment.vscodeSource } : {}),
}))

const parseRecord = (value: unknown): PersistedComposerAttachment | null => {
  if (!value || typeof value !== "object") return null
  const record = value as Partial<PersistedComposerAttachment>
  if (record.version !== 1) return null
  if (typeof record.id !== "string" || !record.id) return null
  if (typeof record.dataUrl !== "string" || !record.dataUrl) return null
  if (typeof record.mimeType !== "string" || !record.mimeType) return null
  if (typeof record.filename !== "string" || !record.filename) return null
  if (record.source !== "local" && record.source !== "server" && record.source !== "vscode") return null
  return {
    version: 1,
    id: record.id,
    dataUrl: record.dataUrl,
    mimeType: record.mimeType,
    filename: record.filename,
    size: typeof record.size === "number" && Number.isFinite(record.size) && record.size >= 0 ? record.size : 0,
    source: record.source,
    ...(typeof record.serverPath === "string" && record.serverPath ? { serverPath: record.serverPath } : {}),
    ...(typeof record.vscodePath === "string" && record.vscodePath ? { vscodePath: record.vscodePath } : {}),
    ...(record.vscodeSource === "file" || record.vscodeSource === "selection"
      ? { vscodeSource: record.vscodeSource }
      : {}),
  }
}

export const deserializeComposerAttachments = (value: unknown): AttachedFile[] => {
  if (!Array.isArray(value)) return []
  const attachments: AttachedFile[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    const record = parseRecord(candidate)
    if (!record || seen.has(record.id)) continue
    seen.add(record.id)
    attachments.push({
      id: record.id,
      file: new File([], record.filename, { type: record.mimeType }),
      dataUrl: record.dataUrl,
      mimeType: record.mimeType,
      filename: record.filename,
      size: record.size,
      source: record.source,
      serverPath: record.serverPath,
      vscodePath: record.vscodePath,
      vscodeSource: record.vscodeSource,
    })
  }
  return attachments
}

export const readComposerAttachments = async (targetKey: string): Promise<AttachedFile[]> =>
  deserializeComposerAttachments(await persistence().read(getPersistedComposerAttachmentKey(targetKey)))

export const readComposerAttachmentsAtKey = async (storageKey: string): Promise<AttachedFile[]> =>
  deserializeComposerAttachments(await persistence().read(storageKey))

export const writeComposerAttachments = async (
  targetKey: string,
  attachments: readonly AttachedFile[],
): Promise<void> => {
  await writeComposerAttachmentsAtKey(getPersistedComposerAttachmentKey(targetKey), attachments)
}

export const writeComposerAttachmentsAtKey = async (
  storageKey: string,
  attachments: readonly AttachedFile[],
): Promise<void> => {
  if (attachments.length === 0) {
    await persistence().remove(storageKey)
    return
  }
  await persistence().write(storageKey, serializeComposerAttachments(attachments))
}

export const removeComposerAttachments = async (targetKey: string): Promise<void> =>
  persistence().remove(getPersistedComposerAttachmentKey(targetKey))

export const removeComposerAttachmentsAtKey = async (storageKey: string): Promise<void> =>
  persistence().remove(storageKey)
