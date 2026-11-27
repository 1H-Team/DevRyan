// Test wrapper, never part of the product: calls the two argument-mutating exports of
// `session-cache.ts` and returns what they mutated with the result, so a port can be compared.
import type { Message, Part, PermissionRequest, QuestionRequest, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client"
import type { FileDiff } from "../../../../ui/src/sync/types"
import { dropSessionCaches, pickSessionCacheEvictions } from "../../../../ui/src/sync/session-cache"

type SessionCache = {
  session_status: Record<string, SessionStatus | undefined>
  session_diff: Record<string, FileDiff[] | undefined>
  todo: Record<string, Todo[] | undefined>
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
  permission: Record<string, PermissionRequest[] | undefined>
  question: Record<string, QuestionRequest[] | undefined>
}

export function dropSessionCachesReturningStore(store: SessionCache, sessionIDs: string[]): SessionCache {
  dropSessionCaches(store, sessionIDs)
  return store
}

export function pickSessionCacheEvictionsReturningSeen(input: { seen: string[]; keep: string; limit: number; preserve?: string[] }): { result: string[]; seen: string[] } {
  const seen = new Set(input.seen)
  const result = pickSessionCacheEvictions({ ...input, seen })
  return { result, seen: [...seen] }
}
