import type { ToolPart } from '@opencode-ai/sdk/v2';

import { isRecord, readTrimmedString, type UnknownRecord } from './guards';

/**
 * A managed-task tool part (`devryan_task`), decoded once per part state. The
 * transcript projections read these on every streaming tick; the tool output is
 * JSON text, so it is parsed once for each state object, not once per read.
 */
export type ManagedTaskToolPartView = {
  /** `input.action`, trimmed. */
  readonly action: string;
  /** `state.status`, trimmed. */
  readonly status: string;
  readonly agent: string;
  readonly label: string;
  /** `input.task_id`, trimmed. */
  readonly inputTaskId: string;
  /** The output object (a JSON string is parsed); null when absent or not an object. */
  readonly output: UnknownRecord | null;
  /** `output.task`, when it is an object. */
  readonly outputTask: UnknownRecord | null;
  /** `output.followUpTask.task`, when it is an object. */
  readonly followUpTask: UnknownRecord | null;
  readonly error: unknown;
};

const views = new WeakMap<ToolPart, { state: unknown; view: ManagedTaskToolPartView }>();

const parseOutput = (output: unknown): UnknownRecord | null => {
  if (isRecord(output)) return output;
  if (typeof output !== 'string' || !output.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(output);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const decode = (state: unknown): ManagedTaskToolPartView => {
  const record = isRecord(state) ? state : {};
  const input = isRecord(record.input) ? record.input : {};
  const output = parseOutput(record.output);
  const followUp = output && isRecord(output.followUpTask) ? output.followUpTask : null;
  return {
    action: readTrimmedString(input.action),
    status: readTrimmedString(record.status),
    agent: readTrimmedString(input.agent),
    label: readTrimmedString(input.label),
    inputTaskId: readTrimmedString(input.task_id),
    output,
    outputTask: output && isRecord(output.task) ? output.task : null,
    followUpTask: followUp && isRecord(followUp.task) ? followUp.task : null,
    error: record.error,
  };
};

/** Decodes a managed-task tool part; cached by part identity and its state object. */
export const decodeManagedTaskToolPart = (part: ToolPart): ManagedTaskToolPartView => {
  const cached = views.get(part);
  if (cached && cached.state === part.state) return cached.view;
  const view = decode(part.state);
  views.set(part, { state: part.state, view });
  return view;
};
