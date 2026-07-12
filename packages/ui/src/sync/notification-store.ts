// ---------------------------------------------------------------------------
// Notification store — session turn-complete and error tracking
//
// Tracks session turn-complete and error notifications with viewed/unviewed
// state. Replaces the old sessionAttentionStates polling system.
// ---------------------------------------------------------------------------

import { create } from "zustand"

import { isGitGenerationSession } from "@/lib/git/gitGenerationSessions"
import { getSafeStorage } from "@/stores/utils/safeStorage"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NotificationBase = {
  directory?: string
  session?: string
  messageId?: string
  time: number
  viewed: boolean
}

type TurnCompleteNotification = NotificationBase & {
  type: "turn-complete"
}

type ErrorNotification = NotificationBase & {
  type: "error"
  error?: { message?: string; code?: string }
}

type QuestionNotification = NotificationBase & {
  type: "question"
}

export type Notification = TurnCompleteNotification | ErrorNotification | QuestionNotification

type NotificationIndex = {
  session: {
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
    unseenHasCompletion: Record<string, boolean>
  }
  project: {
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
    unseenHasCompletion: Record<string, boolean>
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_NOTIFICATIONS = 500
const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days
const COMPLETION_NOTIFICATION_STORAGE_KEY = "openchamber:notification-completions:v1"
const notificationStorage = getSafeStorage()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pruneNotifications(list: Notification[]): Notification[] {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)
  if (pruned.length <= MAX_NOTIFICATIONS) return pruned
  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

function buildIndex(list: Notification[]): NotificationIndex {
  const index: NotificationIndex = {
    session: { unseenCount: {}, unseenHasError: {}, unseenHasCompletion: {} },
    project: { unseenCount: {}, unseenHasError: {}, unseenHasCompletion: {} },
  }

  for (const n of list) {
    if (n.viewed) continue

    if (n.session) {
      index.session.unseenCount[n.session] = (index.session.unseenCount[n.session] ?? 0) + 1
      if (n.type === "error") index.session.unseenHasError[n.session] = true
      if (n.type === "turn-complete") index.session.unseenHasCompletion[n.session] = true
    }
    if (n.directory) {
      index.project.unseenCount[n.directory] = (index.project.unseenCount[n.directory] ?? 0) + 1
      if (n.type === "error") index.project.unseenHasError[n.directory] = true
      if (n.type === "turn-complete") index.project.unseenHasCompletion[n.directory] = true
    }
  }

  return index
}

function readPersistedCompletionNotifications(): Notification[] {
  try {
    const raw = notificationStorage.getItem(COMPLETION_NOTIFICATION_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []

    const completions: Notification[] = []
    for (const value of parsed) {
      if (!value || typeof value !== "object") continue
      const candidate = value as Record<string, unknown>
      if (candidate.type !== "turn-complete") continue
      if (typeof candidate.session !== "string" || candidate.session.length === 0) continue
      if (typeof candidate.time !== "number" || !Number.isFinite(candidate.time)) continue
      if (typeof candidate.viewed !== "boolean") continue

      completions.push({
        type: "turn-complete",
        session: candidate.session,
        time: candidate.time,
        viewed: candidate.viewed,
        ...(typeof candidate.directory === "string" && candidate.directory.length > 0
          ? { directory: candidate.directory }
          : {}),
        ...(typeof candidate.messageId === "string" && candidate.messageId.length > 0
          ? { messageId: candidate.messageId }
          : {}),
      })
    }
    return pruneNotifications(completions)
  } catch {
    return []
  }
}

function persistCompletionNotifications(list: Notification[]): void {
  try {
    const completions = pruneNotifications(list.filter((notification) => notification.type === "turn-complete"))
    if (completions.length === 0) {
      notificationStorage.removeItem(COMPLETION_NOTIFICATION_STORAGE_KEY)
      return
    }
    notificationStorage.setItem(COMPLETION_NOTIFICATION_STORAGE_KEY, JSON.stringify(completions))
  } catch {
    // Completion indicators remain functional in memory when storage is unavailable.
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface NotificationStore {
  list: Notification[]
  index: NotificationIndex

  // Mutations
  append: (notification: Notification) => void
  markSessionViewed: (sessionId: string) => void
  markSessionsViewed: (sessionIds: string[]) => void
  markSessionCompletionsViewed: (sessionId: string) => void
  markProjectViewed: (directory: string) => void

  // Selectors
  sessionUnseenCount: (sessionId: string) => number
  sessionHasError: (sessionId: string) => boolean
  sessionHasCompletion: (sessionId: string) => boolean
  projectUnseenCount: (directory: string) => number
  projectHasError: (directory: string) => boolean
}

const initialNotifications = readPersistedCompletionNotifications()

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  list: initialNotifications,
  index: buildIndex(initialNotifications),

  append: (notification) => {
    if (notification.session && isGitGenerationSession(notification.session)) {
      return
    }
    const current = get().list
    if (notification.messageId && notification.session) {
      const duplicate = current.some((existing) => (
        existing.type === notification.type
        && existing.session === notification.session
        && existing.messageId === notification.messageId
      ))
      if (duplicate) return
    }
    const next = pruneNotifications([...current, notification])
    set({ list: next, index: buildIndex(next) })
    persistCompletionNotifications(next)
  },

  markSessionViewed: (sessionId) => {
    get().markSessionsViewed([sessionId])
  },

  markSessionsViewed: (sessionIds) => {
    const current = get()
    const ids = Array.from(new Set(sessionIds.filter(Boolean)))
    if (ids.length === 0) return

    const hasUnseen = ids.some((sessionId) => (current.index.session.unseenCount[sessionId] ?? 0) > 0)
    if (!hasUnseen) return

    const viewedSessionIds = new Set(ids)

    const next = current.list.map((n) =>
      n.session && viewedSessionIds.has(n.session) && !n.viewed ? { ...n, viewed: true } : n,
    )
    set({ list: next, index: buildIndex(next) })
    persistCompletionNotifications(next)
  },

  markSessionCompletionsViewed: (sessionId) => {
    const current = get()
    if (!sessionId || !current.index.session.unseenHasCompletion[sessionId]) return

    const next = current.list.map((n) =>
      n.session === sessionId && n.type === "turn-complete" && !n.viewed ? { ...n, viewed: true } : n,
    )
    set({ list: next, index: buildIndex(next) })
    persistCompletionNotifications(next)
  },

  markProjectViewed: (directory) => {
    const current = get()
    const count = current.index.project.unseenCount[directory] ?? 0
    if (count === 0) return

    const next = current.list.map((n) =>
      n.directory === directory && !n.viewed ? { ...n, viewed: true } : n,
    )
    set({ list: next, index: buildIndex(next) })
    persistCompletionNotifications(next)
  },

  sessionUnseenCount: (sessionId) => get().index.session.unseenCount[sessionId] ?? 0,
  sessionHasError: (sessionId) => get().index.session.unseenHasError[sessionId] ?? false,
  sessionHasCompletion: (sessionId) => get().index.session.unseenHasCompletion[sessionId] ?? false,
  projectUnseenCount: (directory) => get().index.project.unseenCount[directory] ?? 0,
  projectHasError: (directory) => get().index.project.unseenHasError[directory] ?? false,
}))

// ---------------------------------------------------------------------------
// Imperative API for non-React code (event handler in sync-context)
// ---------------------------------------------------------------------------

export function appendNotification(notification: Notification) {
  useNotificationStore.getState().append(notification)
}

export function markSessionViewed(sessionId: string) {
  useNotificationStore.getState().markSessionViewed(sessionId)
}

export function markSessionsViewed(sessionIds: string[]) {
  useNotificationStore.getState().markSessionsViewed(sessionIds)
}

export function markSessionCompletionsViewed(sessionId: string) {
  useNotificationStore.getState().markSessionCompletionsViewed(sessionId)
}

// ---------------------------------------------------------------------------
// React hooks for fine-grained subscriptions
// ---------------------------------------------------------------------------

export function useSessionUnseenCount(sessionId: string): number {
  return useNotificationStore((s) => s.index.session.unseenCount[sessionId] ?? 0)
}

export function useSessionHasError(sessionId: string): boolean {
  return useNotificationStore((s) => s.index.session.unseenHasError[sessionId] ?? false)
}

export function useSessionHasCompletion(sessionId: string): boolean {
  return useNotificationStore((s) => s.index.session.unseenHasCompletion[sessionId] ?? false)
}

export function useProjectUnseenCount(directory: string): number {
  return useNotificationStore((s) => s.index.project.unseenCount[directory] ?? 0)
}
