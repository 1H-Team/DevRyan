import { MANAGED_RESULT_PAGE_MAX_BYTES, MANAGED_RESULT_V2_PAGE_MAX_BYTES } from './managed-result-projection.js';
import { MANAGED_RESULT_COMPACTED_FIELDS } from './codec-primitives.js';

// OpenCode applies one global tool_output limit to every tool, devryan_task included:
// a truncated managed reply fails native publication. Managed replies therefore fit
// managedToolOutputBudget(limits) (42 KiB at these defaults), never the 48 KiB ceiling.
// 44 KiB is the smallest default that still settles an 8-child wave in 3 Steps.
// Native devryan_task emits minified JSON (one line), so max_lines never binds it.
export const NATIVE_TOOL_OUTPUT_DEFAULTS = Object.freeze({ max_bytes: 45_056, max_lines: 1_000 });
export const MANAGED_TOOL_OUTPUT_MAX_BYTES = 48 * 1024;
const fail = code => Object.assign(new Error(code), { code, statusCode: 409 });
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function nativeToolOutputLimits(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['max_bytes', 'max_lines'].includes(key))) throw fail('native_tool_output_limits_invalid');
  const limits = { ...NATIVE_TOOL_OUTPUT_DEFAULTS, ...value };
  if (Object.values(limits).some(limit => !Number.isSafeInteger(limit) || limit <= 0)) throw fail('native_tool_output_limits_invalid');
  return limits;
}

export function managedToolOutputBudget(limits = NATIVE_TOOL_OUTPUT_DEFAULTS) {
  const bytes = Math.min(MANAGED_TOOL_OUTPUT_MAX_BYTES, nativeToolOutputLimits(limits).max_bytes - 2 * 1024);
  if (bytes < 1024) throw fail('managed_tool_output_capacity_unavailable');
  return bytes;
}

// v1 permits suppressing only copies of the same retained envelope fields.
export function compactManagedTaskToolResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  let result = value;
  const patch = (field, next) => { if (result === value) result = { ...value }; result[field] = next; };
  if (value.task?.taskId && value.task.taskId === value.resultEnvelope?.taskId) {
    let task = value.task;
    for (const field of MANAGED_RESULT_COMPACTED_FIELDS) {
      if (!Object.hasOwn(task, field) || !Object.hasOwn(value.resultEnvelope, field)
        || JSON.stringify(task[field]) !== JSON.stringify(value.resultEnvelope[field])) continue;
      if (task === value.task) task = { ...task };
      delete task[field];
    }
    if (task !== value.task) patch('task', task);
  }
  for (const field of ['tasks', 'results']) if (Array.isArray(value[field])) {
    const next = value[field].map(compactManagedTaskToolResult);
    if (next.some((entry, index) => entry !== value[field][index])) patch(field, next);
  }
  if (value.followUpTask) {
    const next = compactManagedTaskToolResult(value.followUpTask);
    if (next !== value.followUpTask) patch('followUpTask', next);
  }
  return result;
}

export function assertManagedToolOutputSize(value, maxBytes = MANAGED_TOOL_OUTPUT_MAX_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > MANAGED_TOOL_OUTPUT_MAX_BYTES) throw fail('managed_tool_output_capacity_invalid');
  if (bytes(value) > maxBytes) throw fail('managed_tool_output_metadata_too_large');
  return value;
}

// The factory uses existing cursors and code-point page boundaries. Account for escaped JSON, not raw report bytes.
export function fitManagedToolOutput(factory, maxBytes = MANAGED_TOOL_OUTPUT_MAX_BYTES, maxPageBytes = MANAGED_RESULT_PAGE_MAX_BYTES) {
  assertManagedToolOutputSize({}, maxBytes);
  if (!Number.isSafeInteger(maxPageBytes) || maxPageBytes < 4 || maxPageBytes > MANAGED_RESULT_V2_PAGE_MAX_BYTES) throw fail('managed_tool_output_capacity_invalid');
  let low = 4, high = maxPageBytes, fitted;
  while (low <= high) {
    const pageBytes = high === maxPageBytes ? high : Math.floor((low + high) / 2);
    const value = compactManagedTaskToolResult(factory(pageBytes));
    if (bytes(value) <= maxBytes) {
      fitted = value; low = pageBytes + 1;
    } else high = pageBytes - 1;
  }
  if (!fitted) throw fail('managed_tool_output_metadata_too_large');
  return assertManagedToolOutputSize(fitted, maxBytes);
}

