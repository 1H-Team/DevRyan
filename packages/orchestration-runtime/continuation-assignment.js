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
