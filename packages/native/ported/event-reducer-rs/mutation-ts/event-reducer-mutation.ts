// Test wrapper, never part of the product: calls the exports of `event-reducer.ts` and returns
// the draft `applyDirectoryEvent` mutates with its result, so a port can be compared.
// Nothing here registers an abort guard, so the guard the reducer consults stays empty.
import type { Event, Project } from "@opencode-ai/sdk/v2/client"
import type { GlobalState, State } from "../../../../ui/src/sync/types"
import { applyDirectoryEvent, applyGlobalProject, reduceGlobalEvent, type DirectoryEventResult, type GlobalEventResult } from "../../../../ui/src/sync/event-reducer"

export function reduceGlobalEventOf(event: Event): GlobalEventResult {
  return reduceGlobalEvent(event)
}

export function applyGlobalProjectOf(state: GlobalState, project: Project): GlobalState {
  return applyGlobalProject(state, project)
}

export function applyDirectoryEventReturningDraft(draft: State, event: Event): { result: DirectoryEventResult; draft: State } {
  const result = applyDirectoryEvent(draft, event)
  return { result, draft }
}
