import { createStore, type StoreApi } from "zustand/vanilla"
import type { Event } from "@opencode-ai/sdk/v2/client"
import type { DirectoryStore } from "./child-store"
import type { State } from "./types"

export function createEventDraft(current: State, payload: Event, ownedParts?: State["part"]): State {
  const draft = { ...current }
  const parts = () => ownedParts === current.part ? ownedParts : { ...current.part }
  switch (payload.type) {
    case "session.created":
    case "session.updated":
      draft.session = [...current.session]
      draft.revert_transaction = { ...current.revert_transaction }
      draft.permission = { ...current.permission }
      draft.todo = { ...current.todo }
      draft.part = parts()
      break
    case "session.diff":
      draft.session_diff = { ...current.session_diff }
      draft.session = [...current.session]
      break
    case "session.status":
    case "session.idle":
    case "session.error":
      draft.session_status = { ...current.session_status }
      break
    case "todo.updated": draft.todo = { ...current.todo }; break
    case "message.updated": draft.message = { ...current.message }; break
    case "message.removed":
    case "message.part.updated":
      draft.message = { ...current.message }
      draft.part = parts()
      break
    case "message.part.removed":
    case "message.part.delta": draft.part = parts(); break
    case "permission.asked":
    case "permission.replied": draft.permission = { ...current.permission }; break
    case "question.asked":
    case "question.replied":
    case "question.rejected": draft.question = { ...current.question }; break
    case "lsp.updated": draft.lsp = [...current.lsp]; break
  }
  return draft
}

/** Only canonical, already materialized text deltas on busy sessions can share
 * a commit. Everything else is a barrier handled by the ordinary event path. */
export function canBatchStreamingDelta(state: State, event: Event, sessionID?: string): boolean {
  if (event.type !== "message.part.delta" || !sessionID || state.session_status[sessionID]?.type !== "busy") return false
  const { messageID, partID, field } = event.properties
  if (field !== "text" || state.revert_transaction[sessionID]?.status === "pending") return false
  const part = state.part[messageID]?.find((entry) => entry.id === partID)
  return Boolean(part && part.sessionID === sessionID && (part.type === "text" || part.type === "reasoning"))
}

export class StreamingEventBatch {
  readonly staged: StoreApi<DirectoryStore>
  private ownedParts?: State["part"]
  private readonly initial: DirectoryStore

  constructor(readonly source: StoreApi<DirectoryStore>) {
    this.initial = source.getState()
    this.staged = createStore<DirectoryStore>(() => this.initial)
  }

  draft(current: State, payload: Event): State {
    const draft = createEventDraft(current, payload, this.ownedParts)
    this.ownedParts = draft.part
    return draft
  }

  commit() {
    const next = this.staged.getState()
    // Eligible events can only change parts. Keep intervening unrelated writes.
    if (next !== this.initial) this.source.setState({ part: next.part })
    // A retained continuation must read live state after the synchronous batch.
    this.staged.getState = this.source.getState
    this.staged.setState = this.source.setState
    this.ownedParts = undefined
  }
}

export function applyStreamingEventBatch(input: {
  events: readonly Event[]
  resolveStore: (event: Event) => StoreApi<DirectoryStore> | undefined
  resolveSession: (event: Event) => string | undefined
  apply: (event: Event, batch?: StreamingEventBatch) => void
}) {
  let batch: StreamingEventBatch | undefined
  const commit = () => { batch?.commit(); batch = undefined }
  try {
    for (const event of input.events) {
      const source = input.resolveStore(event)
      const state = source && (source === batch?.source ? batch.staged.getState() : source.getState())
      if (!source || !state || !canBatchStreamingDelta(state, event, input.resolveSession(event))) {
        commit()
        input.apply(event)
        continue
      }
      if (batch?.source !== source) {
        commit()
        batch = new StreamingEventBatch(source)
      }
      input.apply(event, batch)
    }
  } finally {
    commit()
  }
}
