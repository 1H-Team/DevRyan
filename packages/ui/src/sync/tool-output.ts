import type { Part, ToolPart, ToolStateCompleted } from "@opencode-ai/sdk/v2/client"

/**
 * History pages request `toolOutput=omit`: the server replaces a finished
 * display-only tool's output with these markers and leaves `output` empty.
 * The full output is re-read by message id when the row is expanded.
 */
export type OmittedToolOutputState = ToolStateCompleted & {
  outputOmitted?: true
  outputBytes?: number
}

export type OmittedToolPart = ToolPart & { state: OmittedToolOutputState & { outputOmitted: true } }

// Live and fixture parts can arrive before their state, so `state` is checked.
export const isToolOutputOmitted = (part: Part | undefined): part is OmittedToolPart => (
  part?.type === "tool"
  && part.state?.status === "completed"
  && "outputOmitted" in part.state
  && part.state.outputOmitted === true
)

export const getOmittedToolOutputBytes = (part: OmittedToolPart): number | undefined => {
  const bytes = part.state.outputBytes
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined
}

const hasFullCompletedOutput = (part: Part | undefined): part is ToolPart & { state: ToolStateCompleted } => (
  part?.type === "tool" && part.state?.status === "completed" && !isToolOutputOmitted(part)
)

/**
 * A trimmed page snapshot never replaces a full part that live events or an
 * expand already delivered: the full part is kept, with any other field the
 * snapshot changed (compaction time, title) taken from the snapshot.
 */
export const keepFullToolOutput = (existing: Part | undefined, next: Part): Part => {
  if (!isToolOutputOmitted(next) || !hasFullCompletedOutput(existing) || existing.id !== next.id) return next
  const { outputOmitted: _outputOmitted, outputBytes: _outputBytes, ...state } = next.state
  const restored: ToolPart = {
    ...next,
    state: { ...state, output: existing.state.output, metadata: existing.state.metadata },
  }
  return JSON.stringify(restored) === JSON.stringify(existing) ? existing : restored
}

/**
 * Replace omitted parts in `current` with the same parts from a full message
 * read. Every other part keeps its reference, and `current` itself is
 * returned when nothing was restored.
 */
export const mergeLoadedToolOutput = (current: Part[], full: readonly Part[]): Part[] => {
  const byID = new Map(full.map((part) => [part.id, part] as const))
  let merged: Part[] | null = null
  for (let index = 0; index < current.length; index += 1) {
    const part = current[index]
    if (!isToolOutputOmitted(part)) continue
    const loaded = byID.get(part.id)
    if (!hasFullCompletedOutput(loaded)) continue
    merged ??= [...current]
    merged[index] = loaded
  }
  return merged ?? current
}
