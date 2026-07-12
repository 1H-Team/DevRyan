export function appendNonOverlappingDelta(existingValue: string | undefined, delta: string) {
  if (!existingValue || delta.length === 0) return (existingValue ?? "") + delta
  if (existingValue.endsWith(delta)) return existingValue

  const maxOverlap = Math.min(existingValue.length, delta.length)
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (existingValue.endsWith(delta.slice(0, overlap))) {
      return existingValue + delta.slice(overlap)
    }
  }

  return existingValue + delta
}

const MIN_FULL_FRAME_DUPLICATE_LENGTH = 32
const MAX_JAMMED_DUPLICATE_SCAN_LENGTH = 2_048

function isMeaningfulDuplicateCandidate(value: string): boolean {
  return value.trim().length >= MIN_FULL_FRAME_DUPLICATE_LENGTH
}

function splitLineRecords(value: string): Array<{ content: string; separator: string }> {
  const records: Array<{ content: string; separator: string }> = []
  let start = 0

  while (start < value.length) {
    const newline = value.indexOf("\n", start)
    if (newline === -1) {
      records.push({ content: value.slice(start), separator: "" })
      break
    }

    const separatorStart = newline > start && value[newline - 1] === "\r" ? newline - 1 : newline
    records.push({
      content: value.slice(start, separatorStart),
      separator: value.slice(separatorStart, newline + 1),
    })
    start = newline + 1
  }

  return records
}

function collapseLineRepeats(value: string): string {
  const records = splitLineRecords(value)
  const output: string[] = []

  for (let index = 0; index < records.length; index += 1) {
    const current = records[index]
    const next = records[index + 1]

    if (
      current
      && next
      && isMeaningfulDuplicateCandidate(current.content)
      && current.content.trim() === next.content.trim()
    ) {
      output.push(current.content, next.separator || current.separator)
      index += 1
      continue
    }

    if (current) {
      output.push(current.content, current.separator)
    }
  }

  return output.join("")
}

function collapseJammedRepeats(value: string): string {
  if (value.length > MAX_JAMMED_DUPLICATE_SCAN_LENGTH) {
    return value
  }

  let output = value
  let changed = true

  while (changed) {
    changed = false
    for (let start = 0; start < output.length; start += 1) {
      const maxLength = Math.floor((output.length - start) / 2)
      for (let length = maxLength; length >= MIN_FULL_FRAME_DUPLICATE_LENGTH; length -= 1) {
        const first = output.slice(start, start + length)
        if (!isMeaningfulDuplicateCandidate(first)) continue

        const secondStart = start + length
        const second = output.slice(secondStart, secondStart + length)
        if (first !== second) continue

        output = output.slice(0, secondStart) + output.slice(secondStart + length)
        changed = true
        break
      }

      if (changed) break
    }
  }

  return output
}

export function collapseExactAdjacentTextRepeats(value: string): string {
  if (value.length < MIN_FULL_FRAME_DUPLICATE_LENGTH * 2) {
    return value
  }

  return collapseJammedRepeats(collapseLineRepeats(value))
}

const MALFORMED_TOOL_CALL_MARKER = 'Skipped malformed tool call "'
const TOOL_BLOCKED_DIAGNOSTIC = /\s*Tool "[^"]+" has been temporarily blocked after \d+ repeated validation failures\. Do not retry this tool\. Use a different approach to complete the task\./g
const TOOL_LOOP_GUARD_DIAGNOSTIC = /\s*Tool loop guard stopped repeated schema-invalid calls to "[^"]+" after \d+ attempts \(limit \d+\)\. Adjust tool arguments and retry\./g
const CURSOR_ASSISTANT_TOOL_WORKAROUND_PATTERNS = [
  /^The `?edit`? tool is blocked, so I['’]ll use `?Write`? and `?StrReplace`? to .*[.!?]$/,
  /^Continuing with `?Write`? and `?StrReplace`? since `?edit`? is blocked\.$/,
]

function stripMalformedToolCallDiagnostics(value: string): string {
  let output = ""
  let cursor = 0

  while (cursor < value.length) {
    const start = value.indexOf(MALFORMED_TOOL_CALL_MARKER, cursor)
    if (start === -1) {
      output += value.slice(cursor)
      break
    }

    output += value.slice(cursor, start)

    const searchStart = start + MALFORMED_TOOL_CALL_MARKER.length
    const nextMalformed = value.indexOf(MALFORMED_TOOL_CALL_MARKER, searchStart)
    const nextBlocked = value.indexOf('Tool "', searchStart)
    const nextLoopGuard = value.indexOf("Tool loop guard stopped repeated schema-invalid calls to \"", searchStart)
    const nextLine = value.indexOf("\n", searchStart)
    const candidates = [nextMalformed, nextBlocked, nextLoopGuard, nextLine >= 0 ? nextLine + 1 : -1]
      .filter((candidate) => candidate >= 0)

    cursor = candidates.length > 0 ? Math.min(...candidates) : value.length
  }

  return output
}

function cleanupDiagnosticWhitespace(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function stripInternalToolRunnerDiagnostics(value: string): string {
  if (
    !value.includes(MALFORMED_TOOL_CALL_MARKER)
    && !value.includes("has been temporarily blocked after")
    && !value.includes("Tool loop guard stopped repeated schema-invalid calls")
  ) {
    return value
  }

  const stripped = stripMalformedToolCallDiagnostics(value)
    .replace(TOOL_BLOCKED_DIAGNOSTIC, "")
    .replace(TOOL_LOOP_GUARD_DIAGNOSTIC, "")

  return stripped === value ? value : cleanupDiagnosticWhitespace(stripped)
}

function isCursorAssistantToolWorkaroundLine(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false

  return CURSOR_ASSISTANT_TOOL_WORKAROUND_PATTERNS.some((pattern) => pattern.test(trimmed))
}

function stripMatchingCursorAssistantLines(
  value: string,
  predicate: (line: string) => boolean,
  quickCheck: (value: string) => boolean,
): string {
  if (!quickCheck(value)) {
    return value
  }

  const records = splitLineRecords(value)
  let changed = false
  const output: string[] = []

  for (const record of records) {
    if (predicate(record.content)) {
      changed = true
      continue
    }

    output.push(record.content, record.separator)
  }

  return changed ? cleanupDiagnosticWhitespace(output.join("")) : value
}

function stripCursorAssistantToolWorkaroundLines(value: string): string {
  return stripMatchingCursorAssistantLines(
    value,
    isCursorAssistantToolWorkaroundLine,
    (candidate) => candidate.includes("edit") && candidate.includes("StrReplace"),
  )
}

export function normalizeAssistantVisibleText(value: string): string {
  return stripCursorAssistantToolWorkaroundLines(
    stripInternalToolRunnerDiagnostics(collapseExactAdjacentTextRepeats(value)),
  )
}

export function normalizeAssistantReasoningText(value: string): string {
  return stripInternalToolRunnerDiagnostics(collapseExactAdjacentTextRepeats(value))
}

export function normalizeAssistantPartText(value: string, partType: string | undefined): string {
  return partType === "reasoning"
    ? normalizeAssistantReasoningText(value)
    : normalizeAssistantVisibleText(value)
}

export function appendStreamingTextDelta(existingValue: string | undefined, delta: string) {
  const existing = existingValue ?? ""
  if (delta.length === 0) return existing
  if (existing.length === 0) return collapseExactAdjacentTextRepeats(delta)

  // Cursor ACP models can replay a complete text/output frame as the next delta.
  // Keep the guard long-frame-only so intentional short repeats like "haha"
  // remain valid assistant output.
  if (delta.length >= MIN_FULL_FRAME_DUPLICATE_LENGTH && existing.endsWith(delta)) {
    return existing
  }

  return collapseExactAdjacentTextRepeats(existing + delta)
}
