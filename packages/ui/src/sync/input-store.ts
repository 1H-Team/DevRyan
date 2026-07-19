/**
 * Input Store — pending input text, synthetic parts, and attached files.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"
import type { AttachedFile } from "@/stores/types/sessionTypes"

const FILE_URI_PREFIX = "file://"
const pendingVSCodeSelectionKeys = new Set<string>()
let attachmentReadGeneration = 0
const sessionComposerRevisions = new Map<string, number>()
let activeComposerSessionId: string | null = null

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
    claimActiveComposerEdit()
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const generation = attachmentReadGeneration
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.readAsDataURL(file)
    })
    if (generation !== attachmentReadGeneration) return
    const attached: AttachedFile = {
      id,
      file,
      dataUrl,
      mimeType: file.type,
      filename: file.name,
      size: file.size,
      source: "local",
    }
    set((s) => ({ attachedFiles: [...s.attachedFiles, attached] }))
  },

  addRestoredAttachment: (attachment) => {
    claimActiveComposerEdit()
    attachmentReadGeneration += 1
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
    set((s) => ({ attachedFiles: [...s.attachedFiles, attached] }))
  },

  removeAttachedFile: (id) => {
    claimActiveComposerEdit()
    set((s) => ({ attachedFiles: s.attachedFiles.filter((f) => f.id !== id) }))
  },

  setAttachedFiles: (files) => {
    claimActiveComposerEdit()
    attachmentReadGeneration += 1
    set({ attachedFiles: files })
  },

  clearAttachedFiles: () => {
    claimActiveComposerEdit()
    attachmentReadGeneration += 1
    set({ attachedFiles: [] })
  },

  addVSCodeFileAttachment: (path: string, name: string, fileSize: number | null) => {
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
    set((s) => ({ attachedFiles: [...s.attachedFiles, attached] }))
  },

  addVSCodeSelectionAttachment: async (path: string, file: File) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const generation = attachmentReadGeneration
    const selectionKey = getVSCodeSelectionKey(path, file.name)
    const isDuplicate = get().attachedFiles.some(
      (f) => f.source === 'vscode' && f.vscodeSource === 'selection' && f.filename === file.name && f.vscodePath === path
    )
    if (isDuplicate || pendingVSCodeSelectionKeys.has(selectionKey)) return
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
    if (generation !== attachmentReadGeneration) return
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
    set((s) => ({ attachedFiles: [...s.attachedFiles, attached] }))
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
