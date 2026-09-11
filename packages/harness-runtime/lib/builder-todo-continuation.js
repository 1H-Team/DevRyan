import crypto from 'node:crypto';
import { validateBuilderTodoGuard } from './objective-progress.js';

// Tool output can vary only because of timestamps or test durations. It remains
// reportable evidence, but cannot refill the Builder's stagnation allowance.
const progressKinds = ['child-completed', 'artifact-changed', 'required-check'];
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = value => typeof value === 'string' ? value.trim() : '';
const todoView = todos => Array.isArray(todos) && todos.every(todo => todo && typeof todo.content === 'string' && typeof todo.status === 'string')
  ? todos.map(todo => ({ content: normalized(todo.content), status: normalized(todo.status).toLowerCase().replaceAll(' ', '_'),
    priority: normalized(todo.priority).toLowerCase().replaceAll(' ', '_') })) : null;

// TODO state and the successful write that established it must both belong to
// this real-user objective. Text summaries and plugin-supplied hashes cannot
// establish the prerequisite or reset this durable, narrowly scoped guard.
export const planBuilderTodoContinuation = (record, observation) => {
  const todos = todoView(observation.todos);
  if (!todos) return { allowed: false, reason: 'managed_builder_todos_unavailable' };
  if (!todos.some(todo => ['pending', 'in_progress'].includes(todo.status))) return { allowed: false, reason: 'managed_builder_todos_complete' };
  const anchor = observation.messages.findIndex(message => message.info?.id === record.anchorID && message.info.role === 'user');
  let written = null;
  for (let index = observation.messages.length - 1; index > anchor && anchor >= 0; index--) {
    const message = observation.messages[index];
    if (message.info?.role !== 'assistant' || (message.info.sessionID && message.info.sessionID !== record.sessionID)) continue;
    const part = [...(message.parts ?? [])].reverse().find(part => part.type === 'tool' && part.tool === 'todowrite' && part.state?.status === 'completed'
      && (!part.sessionID || part.sessionID === record.sessionID) && (!part.messageID || part.messageID === message.info.id));
    if (part) { written = todoView(part.state.input?.todos); break; }
  }
  if (!written) return { allowed: false, reason: 'managed_builder_todo_not_updated' };
  if (hash(todos) !== hash(written)) return { allowed: false, reason: 'managed_builder_todos_changed' };
  const previous = record.builderTodoGuard;
  validateBuilderTodoGuard(previous);
  const taskSetHash = hash(todos.map(({ content, priority }) => ({ content, priority })));
  const progressHash = hash(todos.map(({ content, status }) => ({ content, status })));
  const progressCounts = Object.fromEntries(progressKinds.map(kind => [kind, record.progress?.counts[kind] ?? 0]));
  const newEvidence = previous && progressKinds.some(kind => progressCounts[kind] > (previous.progressCounts[kind] ?? 0));
  const stagnantCount = previous?.taskSetHash === taskSetHash && previous.progressHash === progressHash && !newEvidence
    ? previous.stagnantCount + 1 : 0;
  if (stagnantCount >= 2) return { allowed: false, reason: 'managed_builder_todo_stagnant' };
  return { allowed: true, guard: { taskSetHash, progressHash, stagnantCount, progressCounts } };
};
