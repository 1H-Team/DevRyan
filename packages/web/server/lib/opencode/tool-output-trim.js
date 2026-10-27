// ---------------------------------------------------------------------------
// Finished tool output trimming for history pages.
//
// A history page carries every finished tool's full output, and `read` alone
// is most of a long session's bytes. The UI renders that output only when a
// row is expanded, so a page requested with `?toolOutput=omit` replaces it with
// a marker and the UI re-reads the one message by id on expand.
//
// Only tools whose output nothing derives state from are trimmed. The UI
// derives state from these tools' output, so they always stay full:
//   * task/devryan_task: child session links and the subtask bridge;
//   * skill: the skill name shown in the row;
//   * todowrite: the todo summary;
//   * question: the parsed answers;
//   * grep/glob: the searched-file lists and counts of grouped activity rows;
//   * bash: the message preview link and the user-shell card.
// Edit-like tools keep their output too: their expandable rows render it.
// The trimmed tools render as static rows that never show output.
// Every server-side reader and the default response stay full.
// ---------------------------------------------------------------------------

export const OMITTABLE_TOOL_OUTPUT_TOOLS = Object.freeze(new Set([
  'read', 'list', 'ls', 'webfetch', 'websearch', 'codesearch',
]));

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

/** Read `?toolOutput`; only `omit` opts in, anything else but absence is refused. */
export const readToolOutputMode = (query) => {
  const value = query?.toolOutput;
  if (value === undefined) return 'full';
  if (value === 'omit') return 'omit';
  throw Object.assign(new Error('toolOutput must be omit'), { statusCode: 400, code: 'opencode_invalid_input' });
};

/**
 * Replace a completed display-only tool's output with `outputOmitted`/
 * `outputBytes`. `output` stays an empty string so the part keeps the SDK's
 * completed-state shape. Returns the same reference when nothing changed.
 */
export const omitToolPartOutput = (part) => {
  if (!isRecord(part) || part.type !== 'tool' || !OMITTABLE_TOOL_OUTPUT_TOOLS.has(part.tool)) return part;
  const state = part.state;
  if (!isRecord(state) || state.status !== 'completed' || typeof state.output !== 'string') return part;
  if (state.outputOmitted === true || state.output.length === 0) return part;
  return {
    ...part,
    state: { ...state, output: '', outputOmitted: true, outputBytes: Buffer.byteLength(state.output, 'utf8') },
  };
};

/** Apply {@link omitToolPartOutput} to one `{ info, parts }` record. */
export const omitMessageToolOutput = (record) => {
  if (!isRecord(record) || !Array.isArray(record.parts)) return record;
  const parts = record.parts.map(omitToolPartOutput);
  return parts.some((part, index) => part !== record.parts[index]) ? { ...record, parts } : record;
};
