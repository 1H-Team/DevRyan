// ---------------------------------------------------------------------------
// Payload sanitization — strip oversized diff snapshot fields client-side.
//
// OpenCode attaches a git diff snapshot to session/message records. Every entry
// carries its full patch text, so a workspace with a large untracked tree can
// produce a snapshot far bigger than the conversation: one observed user message
// held 10,345 entries totalling ~87MB, making a single session load ~92MB. The
// UI only renders the per-entry counts, never the bodies, so the bodies are pure
// browser memory cost and can wedge or crash the tab on large sessions.
//
// `patch` is the field current OpenCode populates. The legacy before/after and
// from/to shapes are still stripped so mixed-version payloads stay covered —
// stripping only those four silently did nothing on current payloads.
//
// Applied at two points:
// 1. Event reducer — session.created/session.updated events
// 2. Message loading — fetchMessages response
// ---------------------------------------------------------------------------

import type { Session, Message } from "@opencode-ai/sdk/v2/client"

type DiffEntry = {
  file?: string
  status?: string
  additions?: number
  deletions?: number
  patch?: string
  before?: string
  after?: string
  from?: string
  to?: string
}

type SessionSummary = {
  diffs?: DiffEntry[]
  [key: string]: unknown
}

const DIFF_CONTENT_FIELDS = ["patch", "before", "after", "from", "to"] as const

/**
 * Drop patch bodies from a summary while preserving entry metadata
 * (file/status/additions/deletions), which the diff badges still read.
 * Returns the original reference when nothing needed stripping.
 */
function stripDiffSummary<T extends { summary?: SessionSummary }>(target: T): T {
  const summary = target.summary
  if (!summary?.diffs || !Array.isArray(summary.diffs)) return target

  let changed = false
  const stripped = summary.diffs.map((entry) => {
    if (!entry) return entry
    let next = entry
    for (const field of DIFF_CONTENT_FIELDS) {
      if (typeof entry[field] !== "string") continue
      if (next === entry) next = { ...entry }
      delete next[field]
      changed = true
    }
    return next
  })

  if (!changed) return target
  return { ...target, summary: { ...summary, diffs: stripped } }
}

/** Strip oversized snapshot fields from summary.diffs on a session object */
export function stripSessionDiffSnapshots(session: Session): Session {
  return stripDiffSummary(session as Session & { summary?: SessionSummary }) as Session
}

/** Strip oversized snapshot fields from summary.diffs on a message object */
export function stripMessageDiffSnapshots(message: Message): Message {
  return stripDiffSummary(message as Message & { summary?: SessionSummary }) as Message
}
