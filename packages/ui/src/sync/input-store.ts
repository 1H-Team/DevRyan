/**
 * Input Store — pending input text, synthetic parts, and attached files.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"
import type { AttachedFile } from "@/stores/types/sessionTypes"
import { getStoragePrincipal } from "@/stores/utils/safeStorage"
import {
  getSessionComposerTargetKey,
  isPersistableComposerTargetKey,
} from "./composer-target"
import {
  getPersistedComposerAttachmentKey,
  readComposerAttachmentsAtKey,
  removeComposerAttachmentsAtKey,
  writeComposerAttachmentsAtKey,
} from "./composer-attachment-storage"
import { subscribePersistedSessionInputRemoval } from "./session-draft-storage"

const FILE_URI_PREFIX = "file://"
const pendingVSCodeSelectionKeys = new Set<string>()
let attachmentReadGeneration = 0
const sessionComposerRevisions = new Map<string, number>()
let activeComposerSessionId: string | null = null
const ATTACHMENT_CACHE_MAX_TARGETS = 40
const ATTACHMENT_CACHE_MAX_BYTES = 100 * 1024 * 1024

type AttachmentCacheEntry = {
  files: AttachedFile[]
  bytes: number
}

const attachmentCache = new Map<string, AttachmentCacheEntry>()
const attachmentInvalidationGenerations = new Map<string, number>()
const attachmentMutationRevisions = new Map<string, number>()
const attachmentPersistenceQueues = new Map<string, Promise<void>>()
let activeAttachmentTargetKey: string | null = null
let attachmentTargetActivation = 0
let attachmentPersistenceWarningReported = false
let attachmentRuntimePrincipal = getStoragePrincipal()

const ensureAttachmentRuntimePrincipal = (): string => {
  const principal = getStoragePrincipal()
  if (principal === attachmentRuntimePrincipal) return principal
  attachmentRuntimePrincipal = principal
  activeAttachmentTargetKey = null
  attachmentTargetActivation += 1
  attachmentReadGeneration += 1
  attachmentCache.clear()
  attachmentInvalidationGenerations.clear()
  attachmentMutationRevisions.clear()
  attachmentPersistenceWarningReported = false
  useInputStore.setState({
    activeAttachmentTargetKey: null,
    activeAttachmentsHydrated: true,
    attachmentPersistenceError: null,
    attachedFiles: [],
  })
  return principal
}

const attachmentBytes = (files: readonly AttachedFile[]): number =>
  files.reduce((total, file) => total + Math.max(0, Number.isFinite(file.size) ? file.size : 0), 0)

const touchAttachmentCache = (targetKey: string, files: readonly AttachedFile[]): void => {
  attachmentCache.delete(targetKey)
  attachmentCache.set(targetKey, {
    files: [...files],
    bytes: attachmentBytes(files),
  })
}

const trimAttachmentCache = (): void => {
  let totalBytes = 0
  for (const entry of attachmentCache.values()) totalBytes += entry.bytes
  if (attachmentCache.size <= ATTACHMENT_CACHE_MAX_TARGETS && totalBytes <= ATTACHMENT_CACHE_MAX_BYTES) return

  for (const [targetKey, entry] of attachmentCache) {
    if (attachmentCache.size <= ATTACHMENT_CACHE_MAX_TARGETS && totalBytes <= ATTACHMENT_CACHE_MAX_BYTES) break
    if (targetKey === activeAttachmentTargetKey || attachmentPersistenceQueues.has(targetKey)) continue
    attachmentCache.delete(targetKey)
    totalBytes -= entry.bytes
  }
}

const getAttachmentInvalidationGeneration = (targetKey: string): number =>
  attachmentInvalidationGenerations.get(targetKey) ?? 0

const invalidatePendingAttachmentReads = (targetKey: string): void => {
  attachmentInvalidationGenerations.set(targetKey, getAttachmentInvalidationGeneration(targetKey) + 1)
}

export const getAttachmentMutationRevision = (targetKey: string): number =>
  attachmentMutationRevisions.get(targetKey) ?? 0

const markAttachmentMutation = (targetKey: string): void => {
  attachmentMutationRevisions.set(targetKey, getAttachmentMutationRevision(targetKey) + 1)
}

const reportAttachmentPersistenceError = (
  message: string,
  setError: (message: string) => void,
): void => {
  if (attachmentPersistenceWarningReported) return
  attachmentPersistenceWarningReported = true
  setError(message)
}

const enqueueAttachmentPersistence = (
  targetKey: string,
  operation: () => Promise<void>,
  onError: (message: string) => void,
): void => {
  const previous = attachmentPersistenceQueues.get(targetKey) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(operation)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Failed to persist composer attachments"
      onError(message)
    })
    .finally(() => {
      if (attachmentPersistenceQueues.get(targetKey) === next) {
        attachmentPersistenceQueues.delete(targetKey)
        trimAttachmentCache()
      }
    })
  attachmentPersistenceQueues.set(targetKey, next)
}

const persistTargetAttachments = (
  targetKey: string,
  files: readonly AttachedFile[],
  onError: (message: string) => void,
): void => {
  const storageKey = getPersistedComposerAttachmentKey(targetKey)
  enqueueAttachmentPersistence(
    targetKey,
    () => writeComposerAttachmentsAtKey(storageKey, files),
    onError,
  )
}

const removeTargetAttachments = (
  targetKey: string,
  onError: (message: string) => void,
): void => {
  const storageKey = getPersistedComposerAttachmentKey(targetKey)
  enqueueAttachmentPersistence(
    targetKey,
    () => removeComposerAttachmentsAtKey(storageKey),
    onError,
  )
}

export type RestoredAttachment = {
  url: string
  mimeType: string
  filename: string
}

export type PendingRestoredInput = {
  sessionId: string
  text: string
  attachments: RestoredAttachment[]
  expectedComposerRevision: number
}

export const getSessionComposerRevision = (sessionId: string): number =>
  sessionComposerRevisions.get(sessionId) ?? 0

export const markSessionComposerEdited = (sessionId: string): number => {
  const revision = getSessionComposerRevision(sessionId) + 1
  sessionComposerRevisions.set(sessionId, revision)
  return revision
}

export const setActiveComposerSession = (sessionId: string | null): void => {
  activeComposerSessionId = sessionId
}

const claimActiveComposerEdit = (): void => {
  if (activeComposerSessionId) markSessionComposerEdited(activeComposerSessionId)
}

const encodeFilePath = (filepath: string): string => {
  let normalized = filepath.replace(/\\/g, "/")
  if (/^[A-Za-z]:/.test(normalized)) {
    normalized = `/${normalized}`
  }
  return normalized
    .split("/")
    .map((segment, index) => {
      if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment
      return encodeURIComponent(segment)
    })
    .join("/")
}

const toFileUrl = (filepath: string): string => {
  const normalized = filepath.replace(/\\/g, "/").trim()
  if (normalized.toLowerCase().startsWith(FILE_URI_PREFIX)) {
    return normalized
  }
  return `${FILE_URI_PREFIX}${encodeFilePath(normalized)}`
}

const getDataUrlDecodedSize = (url: string): number => {
  if (!url.startsWith("data:")) return 0
  const commaIndex = url.indexOf(",")
  if (commaIndex < 0) return 0

  const metadata = url.slice(5, commaIndex).toLowerCase()
  const payload = url.slice(commaIndex + 1)
  if (metadata.split(";").includes("base64")) {
    const encoded = payload.replace(/\s/g, "")
    if (!encoded) return 0
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
    return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding)
  }

  try {
    return new TextEncoder().encode(decodeURIComponent(payload)).length
  } catch {
    return new TextEncoder().encode(payload).length
  }
}

const getVSCodeSelectionKey = (path: string, filename: string): string => `${path}\u0000${filename}`

const isSameVSCodeActiveEditorFile = (a: VSCodeActiveEditorFile | null, b: VSCodeActiveEditorFile | null): boolean => {
  if (a === b) return true
  if (!a || !b) return false
  return a.filePath === b.filePath
    && a.fileName === b.fileName
    && a.relativePath === b.relativePath
    && a.fileSize === b.fileSize
    && a.selection?.startLine === b.selection?.startLine
    && a.selection?.endLine === b.selection?.endLine
    && a.selection?.text === b.selection?.text
}

export type SyntheticContextPart = {
  text: string
  attachments?: AttachedFile[]
  synthetic?: boolean
}

export type PendingInputMode = "replace" | "append" | "append-inline"

export type PendingInputPayload = {
  text: string
  mode: PendingInputMode
  selection?: { start: number; end: number }
  source?: "voice" | "action"
  preserveFocus?: boolean
}

export type VSCodeActiveEditorFile = {
  filePath: string
  fileName: string
  relativePath: string
  fileSize: number | null
  selection: { startLine: number; endLine: number; text: string } | null
}

export type InputState = {
  pendingInputText: string | null
  pendingInputMode: PendingInputMode
  pendingInputPayload: PendingInputPayload | null
  pendingSyntheticParts: SyntheticContextPart[] | null
  attachedFiles: AttachedFile[]
  activeAttachmentTargetKey: string | null
  activeAttachmentsHydrated: boolean
  attachmentPersistenceError: string | null
  activeEditorFile: VSCodeActiveEditorFile | null
  pendingRestoredInputs: ReadonlyMap<string, PendingRestoredInput>

  setPendingInputText: (text: string | null, mode?: PendingInputMode, payload?: Partial<Omit<PendingInputPayload, "text" | "mode">>) => void
  consumePendingInputText: () => PendingInputPayload | null
  setPendingSyntheticParts: (parts: SyntheticContextPart[] | null) => void
  consumePendingSyntheticParts: () => SyntheticContextPart[] | null
  addAttachedFile: (file: File) => Promise<void>
  addRestoredAttachment: (attachment: RestoredAttachment) => void
  removeAttachedFile: (id: string) => void
  setAttachedFiles: (files: AttachedFile[]) => void
  clearAttachedFiles: () => void
  activateAttachedFilesTarget: (targetKey: string | null) => Promise<void>
  replaceAttachedFilesForTarget: (targetKey: string, files: AttachedFile[]) => void
  replaceRestoredAttachmentsForTarget: (targetKey: string, attachments: RestoredAttachment[]) => void
  mergeAttachedFilesForTarget: (targetKey: string, files: AttachedFile[]) => void
  removeAttachedFilesTarget: (targetKey: string) => void
  clearAttachmentPersistenceError: () => void
  addVSCodeFileAttachment: (path: string, name: string, fileSize: number | null) => void
  addVSCodeSelectionAttachment: (path: string, file: File) => Promise<void>
  setActiveEditorFile: (file: VSCodeActiveEditorFile | null) => void
  queueRestoredInput: (input: PendingRestoredInput) => void
  consumeRestoredInput: (sessionId: string, composerRevision: number) => PendingRestoredInput | null
}

export const useInputStore = create<InputState>()((set, get) => ({
  pendingInputText: null,
  pendingInputMode: "replace",
  pendingInputPayload: null,
  pendingSyntheticParts: null,
  attachedFiles: [],
  activeAttachmentTargetKey: null,
  activeAttachmentsHydrated: true,
  attachmentPersistenceError: null,
  activeEditorFile: null,
  pendingRestoredInputs: new Map(),

  setPendingInputText: (text, mode = "replace", payload) =>
    set({
      pendingInputText: text,
      pendingInputMode: mode,
      pendingInputPayload: text === null ? null : { text, mode, ...payload },
    }),

  consumePendingInputText: () => {
    const { pendingInputText, pendingInputMode, pendingInputPayload } = get()
    if (pendingInputText === null) return null
    set({ pendingInputText: null, pendingInputMode: "replace", pendingInputPayload: null })
    return pendingInputPayload ?? { text: pendingInputText, mode: pendingInputMode }
  },

  setPendingSyntheticParts: (parts) => set({ pendingSyntheticParts: parts }),

  consumePendingSyntheticParts: () => {
    const { pendingSyntheticParts } = get()
    if (pendingSyntheticParts !== null) {
      set({ pendingSyntheticParts: null })
    }
    return pendingSyntheticParts
  },

  addAttachedFile: async (file: File) => {
    const principal = ensureAttachmentRuntimePrincipal()
    claimActiveComposerEdit()
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const targetKey = activeAttachmentTargetKey
    if (targetKey) markAttachmentMutation(targetKey)
    const generation = targetKey
      ? getAttachmentInvalidationGeneration(targetKey)
      : attachmentReadGeneration
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.readAsDataURL(file)
    })
    if (principal !== getStoragePrincipal()) return
    if (targetKey) {
      if (generation !== getAttachmentInvalidationGeneration(targetKey)) return
    } else if (generation !== attachmentReadGeneration) {
      return
    }
    const attached: AttachedFile = {
      id,
      file,
      dataUrl,
      mimeType: file.type,
      filename: file.name,
      size: file.size,
      source: "local",
    }
    if (!targetKey) {
      set((s) => ({ attachedFiles: [...s.attachedFiles, attached] }))
      return
    }
    const currentFiles = targetKey === activeAttachmentTargetKey
      ? get().attachedFiles
      : attachmentCache.get(targetKey)?.files ?? []
    const files = [...currentFiles, attached]
    markAttachmentMutation(targetKey)
    touchAttachmentCache(targetKey, files)
    persistTargetAttachments(targetKey, files, (message) => {
      reportAttachmentPersistenceError(message, (next) => set({ attachmentPersistenceError: next }))
    })
    if (targetKey === activeAttachmentTargetKey) {
      set({ attachedFiles: files, activeAttachmentsHydrated: true })
    }
    trimAttachmentCache()
  },

  addRestoredAttachment: (attachment) => {
    ensureAttachmentRuntimePrincipal()
    claimActiveComposerEdit()
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const attached: AttachedFile = {
      id,
      file: new File([], attachment.filename, { type: attachment.mimeType }),
      dataUrl: attachment.url,
      mimeType: attachment.mimeType,
      filename: attachment.filename,
      size: getDataUrlDecodedSize(attachment.url),
      source: "server",
    }
    const targetKey = activeAttachmentTargetKey
    if (!targetKey) {
      set((s) => ({ attachedFiles: [...s.attachedFiles, attached] }))
      return
    }
    const files = [...get().attachedFiles, attached]
    markAttachmentMutation(targetKey)
    touchAttachmentCache(targetKey, files)
    persistTargetAttachments(targetKey, files, (message) => {
      reportAttachmentPersistenceError(message, (next) => set({ attachmentPersistenceError: next }))
    })
    set({ attachedFiles: files, activeAttachmentsHydrated: true })
    trimAttachmentCache()
  },

  removeAttachedFile: (id) => {
    ensureAttachmentRuntimePrincipal()
    claimActiveComposerEdit()
    const files = get().attachedFiles.filter((file) => file.id !== id)
    const targetKey = activeAttachmentTargetKey
    if (targetKey) {
      invalidatePendingAttachmentReads(targetKey)
      markAttachmentMutation(targetKey)
      touchAttachmentCache(targetKey, files)
      persistTargetAttachments(targetKey, files, (message) => {
        reportAttachmentPersistenceError(message, (next) => set({ attachmentPersistenceError: next }))
      })
    }
    set({ attachedFiles: files, activeAttachmentsHydrated: true })
    trimAttachmentCache()
  },

  setAttachedFiles: (files) => {
    ensureAttachmentRuntimePrincipal()
    claimActiveComposerEdit()
    const targetKey = activeAttachmentTargetKey
    if (targetKey) {
      invalidatePendingAttachmentReads(targetKey)
      markAttachmentMutation(targetKey)
      touchAttachmentCache(targetKey, files)
      persistTargetAttachments(targetKey, files, (message) => {
        reportAttachmentPersistenceError(message, (next) => set({ attachmentPersistenceError: next }))
      })
    } else {
      attachmentReadGeneration += 1
    }
    set({ attachedFiles: files, activeAttachmentsHydrated: true })
    trimAttachmentCache()
  },

  clearAttachedFiles: () => {
    ensureAttachmentRuntimePrincipal()
    claimActiveComposerEdit()
    const targetKey = activeAttachmentTargetKey
    if (targetKey) {
      invalidatePendingAttachmentReads(targetKey)
      markAttachmentMutation(targetKey)
      touchAttachmentCache(targetKey, [])
      removeTargetAttachments(targetKey, (message) => {
        reportAttachmentPersistenceError(message, (next) => set({ attachmentPersistenceError: next }))
      })
    } else {
      attachmentReadGeneration += 1
    }
    set({ attachedFiles: [], activeAttachmentsHydrated: true })
    trimAttachmentCache()
  },

  activateAttachedFilesTarget: async (targetKey) => {
    const principal = ensureAttachmentRuntimePrincipal()
    const normalizedTargetKey = isPersistableComposerTargetKey(targetKey) ? targetKey : null
    activeAttachmentTargetKey = normalizedTargetKey
    attachmentTargetActivation += 1
    const activation = attachmentTargetActivation

    if (!normalizedTargetKey) {
      attachmentReadGeneration += 1
      set({
        activeAttachmentTargetKey: null,
        activeAttachmentsHydrated: true,
        attachedFiles: [],
      })
      return
    }

    const cached = attachmentCache.get(normalizedTargetKey)
    if (cached) {
      touchAttachmentCache(normalizedTargetKey, cached.files)
      set({
        activeAttachmentTargetKey: normalizedTargetKey,
        activeAttachmentsHydrated: true,
        attachedFiles: cached.files,
      })
      trimAttachmentCache()
      return
    }

    const mutationRevision = getAttachmentMutationRevision(normalizedTargetKey)
    set({
      activeAttachmentTargetKey: normalizedTargetKey,
      activeAttachmentsHydrated: false,
      attachedFiles: [],
    })
    try {
      const storageKey = getPersistedComposerAttachmentKey(normalizedTargetKey)
      const files = await readComposerAttachmentsAtKey(storageKey)
      if (principal !== getStoragePrincipal()) return
      if (mutationRevision !== getAttachmentMutationRevision(normalizedTargetKey)) return
      touchAttachmentCache(normalizedTargetKey, files)
      if (activation === attachmentTargetActivation && activeAttachmentTargetKey === normalizedTargetKey) {
        set({ attachedFiles: files, activeAttachmentsHydrated: true })
      }
      trimAttachmentCache()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to restore composer attachments"
      if (activation === attachmentTargetActivation && activeAttachmentTargetKey === normalizedTargetKey) {
        reportAttachmentPersistenceError(message, (next) => set({ attachmentPersistenceError: next }))
      }
    }
  },

  replaceAttachedFilesForTarget: (targetKey, files) => {
    ensureAttachmentRuntimePrincipal()
    if (!isPersistableComposerTargetKey(targetKey)) return
    invalidatePendingAttachmentReads(targetKey)
    markAttachmentMutation(targetKey)
    touchAttachmentCache(targetKey, files)
    persistTargetAttachments(targetKey, files, (message) => {
      reportAttachmentPersistenceError(message, (next) => set({ attachmentPersistenceError: next }))
    })
    if (targetKey === activeAttachmentTargetKey) {
      set({ attachedFiles: files, activeAttachmentsHydrated: true })
    }
    trimAttachmentCache()
  },

  replaceRestoredAttachmentsForTarget: (targetKey, attachments) => {
    if (!isPersistableComposerTargetKey(targetKey)) return
    const files = attachments.map((attachment) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file: new File([], attachment.filename, { type: attachment.mimeType }),
      dataUrl: attachment.url,
      mimeType: attachment.mimeType,
      filename: attachment.filename,
      size: getDataUrlDecodedSize(attachment.url),
      source: "server" as const,
    }))
    get().replaceAttachedFilesForTarget(targetKey, files)
  },

  mergeAttachedFilesForTarget: (targetKey, files) => {
    ensureAttachmentRuntimePrincipal()
    if (!isPersistableComposerTargetKey(targetKey)) return
    const currentFiles = targetKey === activeAttachmentTargetKey
      ? get().attachedFiles
      : attachmentCache.get(targetKey)?.files ?? []
    const merged: AttachedFile[] = []
    const seen = new Set<string>()
    for (const file of [...files, ...currentFiles]) {
      if (seen.has(file.id)) continue
      seen.add(file.id)
      merged.push(file)
    }
    invalidatePendingAttachmentReads(targetKey)
    markAttachmentMutation(targetKey)
    touchAttachmentCache(targetKey, merged)
    persistTargetAttachments(targetKey, merged, (message) => {
      reportAttachmentPersistenceError(message, (next) => set({ attachmentPersistenceError: next }))
    })
    if (targetKey === activeAttachmentTargetKey) {
      set({ attachedFiles: merged, activeAttachmentsHydrated: true })
    }
    trimAttachmentCache()
  },

  removeAttachedFilesTarget: (targetKey) => {
    ensureAttachmentRuntimePrincipal()
    if (!isPersistableComposerTargetKey(targetKey)) return
    invalidatePendingAttachmentReads(targetKey)
    markAttachmentMutation(targetKey)
    attachmentCache.delete(targetKey)
    removeTargetAttachments(targetKey, (message) => {
      reportAttachmentPersistenceError(message, (next) => set({ attachmentPersistenceError: next }))
    })
    if (targetKey === activeAttachmentTargetKey) {
      activeAttachmentTargetKey = null
      attachmentTargetActivation += 1
      set({
        activeAttachmentTargetKey: null,
        attachedFiles: [],
        activeAttachmentsHydrated: true,
      })
    }
  },

  clearAttachmentPersistenceError: () => set({ attachmentPersistenceError: null }),

  addVSCodeFileAttachment: (path: string, name: string, fileSize: number | null) => {
    ensureAttachmentRuntimePrincipal()
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const isDuplicate = get().attachedFiles.some(
      (f) => f.source === 'vscode' && f.vscodeSource === 'file' && (f.vscodePath || '') === path
    )
    if (isDuplicate) return
    claimActiveComposerEdit()
    const dataUrl = toFileUrl(path)
    // `file://` URLs are the same contract used by server-source attachments.
    // The submission path passes `dataUrl` as `url` directly to the OpenCode
    // server, which resolves `file://` paths natively. No base64 encoding needed.
    const attached: AttachedFile = {
      id,
      file: new File([], name, { type: 'text/plain' }),
      dataUrl,
      mimeType: 'text/plain',
      filename: name,
      size: fileSize || 0,
      source: 'vscode',
      vscodePath: path,
      vscodeSource: 'file',
    }
    const targetKey = activeAttachmentTargetKey
    const files = [...get().attachedFiles, attached]
    if (targetKey) {
      markAttachmentMutation(targetKey)
      touchAttachmentCache(targetKey, files)
      persistTargetAttachments(targetKey, files, (message) => {
        reportAttachmentPersistenceError(message, (next) => set({ attachmentPersistenceError: next }))
      })
    }
    set({ attachedFiles: files, activeAttachmentsHydrated: true })
    trimAttachmentCache()
  },

  addVSCodeSelectionAttachment: async (path: string, file: File) => {
    const principal = ensureAttachmentRuntimePrincipal()
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const targetKey = activeAttachmentTargetKey
    const generation = targetKey
      ? getAttachmentInvalidationGeneration(targetKey)
      : attachmentReadGeneration
    const selectionKey = getVSCodeSelectionKey(path, file.name)
    const isDuplicate = get().attachedFiles.some(
      (f) => f.source === 'vscode' && f.vscodeSource === 'selection' && f.filename === file.name && f.vscodePath === path
    )
    if (isDuplicate || pendingVSCodeSelectionKeys.has(selectionKey)) return
    if (targetKey) markAttachmentMutation(targetKey)
    claimActiveComposerEdit()
    pendingVSCodeSelectionKeys.add(selectionKey)
    let dataUrl: string
    try {
      dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.readAsDataURL(file)
      })
    } finally {
      pendingVSCodeSelectionKeys.delete(selectionKey)
    }
    if (principal !== getStoragePrincipal()) return
    if (targetKey) {
      if (generation !== getAttachmentInvalidationGeneration(targetKey)) return
    } else if (generation !== attachmentReadGeneration) {
      return
    }
    const attached: AttachedFile = {
      id,
      file,
      dataUrl,
      mimeType: file.type,
      filename: file.name,
      size: file.size,
      source: 'vscode',
      vscodePath: path,
      vscodeSource: 'selection',
    }
    if (!targetKey) {
      set((s) => ({ attachedFiles: [...s.attachedFiles, attached] }))
      return
    }
    const currentFiles = targetKey === activeAttachmentTargetKey
      ? get().attachedFiles
      : attachmentCache.get(targetKey)?.files ?? []
    const files = [...currentFiles, attached]
    markAttachmentMutation(targetKey)
    touchAttachmentCache(targetKey, files)
    persistTargetAttachments(targetKey, files, (message) => {
      reportAttachmentPersistenceError(message, (next) => set({ attachmentPersistenceError: next }))
    })
    if (targetKey === activeAttachmentTargetKey) {
      set({ attachedFiles: files, activeAttachmentsHydrated: true })
    }
    trimAttachmentCache()
  },

  setActiveEditorFile: (file) => {
    if (isSameVSCodeActiveEditorFile(get().activeEditorFile, file)) return
    set({ activeEditorFile: file })
  },

  queueRestoredInput: (input) => {
    set((state) => {
      const pendingRestoredInputs = new Map(state.pendingRestoredInputs)
      pendingRestoredInputs.set(input.sessionId, input)
      return { pendingRestoredInputs }
    })
  },

  consumeRestoredInput: (sessionId, composerRevision) => {
    const pending = get().pendingRestoredInputs.get(sessionId)
    if (!pending) return null
    set((state) => {
      if (!state.pendingRestoredInputs.has(sessionId)) return state
      const pendingRestoredInputs = new Map(state.pendingRestoredInputs)
      pendingRestoredInputs.delete(sessionId)
      return { pendingRestoredInputs }
    })
    return pending.expectedComposerRevision === composerRevision ? pending : null
  },
}))

export const waitForComposerAttachmentPersistenceForTests = async (): Promise<void> => {
  await Promise.all([...attachmentPersistenceQueues.values()])
}

export const resetComposerAttachmentRuntimeForTests = (): void => {
  activeAttachmentTargetKey = null
  activeComposerSessionId = null
  attachmentTargetActivation += 1
  attachmentReadGeneration += 1
  attachmentCache.clear()
  attachmentInvalidationGenerations.clear()
  attachmentMutationRevisions.clear()
  attachmentPersistenceWarningReported = false
  attachmentRuntimePrincipal = getStoragePrincipal()
  useInputStore.setState({
    activeAttachmentTargetKey: null,
    activeAttachmentsHydrated: true,
    attachmentPersistenceError: null,
    attachedFiles: [],
  })
}

subscribePersistedSessionInputRemoval((sessionId) => {
  useInputStore.getState().removeAttachedFilesTarget(getSessionComposerTargetKey(sessionId))
})
