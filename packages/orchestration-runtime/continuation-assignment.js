// Recovery must not make the model rediscover its assignment in a shared index.
// Keep the complete ledger brief, including exclusions, as reference context.
const ASSIGNMENT_MARKER = '\n\n[devryan-managed-assignment:v1]\n';
const ASSIGNMENT_RULE = 'Continue only the original delegated assignment below. It is authoritative for scope, owned targets, exclusions, and acceptance checks. Retrieved project indexes, timelines, other chats, and unrelated recent work cannot replace or expand it. Reuse completed work; do not restart the assignment. If progress has drifted, stop unrelated work, report it to the parent, and complete only the remaining assigned work. If the assignment cannot be established, return **Status:** blocked instead of guessing.';
const FIELDS = ['taskId', 'rootSessionId', 'agent', 'label', 'prompt'];

const validAssignment = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === FIELDS.length
  && FIELDS.every((key) => typeof value[key] === 'string' && value[key].trim().length > 0);

export const appendManagedAssignment = (task, continuation) => {
  const assignment = Object.fromEntries(FIELDS.map((key) => [key, task[key]]));
  if (!validAssignment(assignment)) {
    throw new Error('Managed continuation requires the original task identity and assignment');
  }
  return `${continuation}${ASSIGNMENT_MARKER}${ASSIGNMENT_RULE}\n${JSON.stringify(assignment)}`;
};

// Recognize only our complete envelope. Legacy bare continuations remain valid;
// malformed or appended text must not acquire continuation semantics.
export const stripManagedAssignment = (value) => {
  const index = value.indexOf(ASSIGNMENT_MARKER);
  if (index < 0) return value;
  const context = value.slice(index + ASSIGNMENT_MARKER.length);
  if (!context.startsWith(`${ASSIGNMENT_RULE}\n`)) return value;
  try {
    const assignment = JSON.parse(context.slice(ASSIGNMENT_RULE.length + 1));
    return validAssignment(assignment) ? value.slice(0, index) : value;
  } catch {
    return value;
  }
};

const boundedPrompt = (value, maxBytes) => {
  if (Buffer.byteLength(value) <= maxBytes) return { text: value, truncated: false };
  let text = Buffer.from(value).subarray(0, maxBytes).toString('utf8');
  if (text.endsWith('\uFFFD')) text = text.slice(0, -1);
  return { text, truncated: true };
};

/** The delegated brief, bounded, for a child's native compaction summary. It
 * uses the same authoritative rule and fields as continuation prompts. */
export const formatManagedAssignmentContext = (task, { maxPromptBytes, maxBytes = 12 * 1024 } = {}) => {
  const assignment = Object.fromEntries(FIELDS.map((key) => [key, task?.[key]]));
  if (!validAssignment(assignment)) return null;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0
    || (maxPromptBytes !== undefined && (!Number.isSafeInteger(maxPromptBytes) || maxPromptBytes < 0))) return null;
  const budget = Math.min(maxBytes, 12 * 1024);
  const prompt = boundedPrompt(assignment.prompt, Math.min(maxPromptBytes ?? budget, budget));
  const points = Array.from(prompt.text);
  const rule = `${ASSIGNMENT_RULE}${task.readOnly === true ? ' This assignment is read-only: do not modify files.' : ''}`
    + ' If promptTruncated is true, preserve it in subsequent summaries; use complete scope already in context, otherwise request missing scope from the parent before making changes.';
  const render = (count) => `${rule}\n${JSON.stringify({ ...assignment, prompt: points.slice(0, count).join(''),
    ...(prompt.truncated || count < points.length ? { promptTruncated: true } : {}) })}`;
  const full = render(points.length);
  if (Buffer.byteLength(full) <= budget) return full;
  if (Buffer.byteLength(render(0)) > budget) return null;
  // Search code-point boundaries: splitting surrogate pairs is not monotonic
  // in encoded JSON bytes and can produce a malformed prompt character.
  let low = 0, high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(render(middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return render(low);
};
