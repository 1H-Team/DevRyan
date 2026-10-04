import { Effect, Schema } from 'effect';
import { Plugin } from '@opencode/plugin/effect';
import { Tool } from '@opencode/schema/tool';
import type { ExecuteOwned } from './native-admission-contract.js';
import type { RegistrationOrigin } from './registration-origin.js';
import type { ExecutionRpc } from './worker-protocol.js';

export const MANAGED_TASK_PLUGIN_ID = 'devryan.managed-task';
export const managedTaskInputSchema = Schema.Union([
  Schema.Struct({ action: Schema.Literal('start'), agent: Schema.String, prompt: Schema.String,
    label: Schema.optional(Schema.String), timeout_seconds: Schema.optional(Schema.Int), allow_duplicate: Schema.optional(Schema.Boolean),
    required_checks: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, command: Schema.String, paths: Schema.Array(Schema.String) }))) }),
  Schema.Struct({ action: Schema.Literals(['status', 'wait']), task_id: Schema.String }),
  Schema.Struct({ action: Schema.Literal('wait_any'), task_ids: Schema.Array(Schema.String), after_cursor: Schema.optional(Schema.String) }),
  Schema.Struct({ action: Schema.Literal('read_result'), task_id: Schema.String, result_cursor: Schema.String }),
  Schema.Struct({ action: Schema.Literal('cancel'), task_id: Schema.String,
    reason: Schema.optional(Schema.String), cascade: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ action: Schema.Literals(['continue', 'abandon']), task_id: Schema.String }),
  Schema.Struct({ action: Schema.Literals(['retry', 'resume']), task_id: Schema.String, agent: Schema.optional(Schema.String),
    prompt: Schema.optional(Schema.String), label: Schema.optional(Schema.String), timeout_seconds: Schema.optional(Schema.Int) }),
  Schema.Struct({ action: Schema.Literal('plan_read') }),
  Schema.Struct({ action: Schema.Literal('plan_update'), expected_version: Schema.String, text: Schema.String }),
  Schema.Struct({ action: Schema.Literals(['checkpoint', 'decisions']), query: Schema.optional(Schema.String) }),
  Schema.Struct({ action: Schema.Literal('remember_decision'), decision: Schema.String, source_message_id: Schema.String,
    decision_paths: Schema.optional(Schema.Array(Schema.String)), valid_until: Schema.optional(Schema.Number), supersedes: Schema.optional(Schema.String) }),
]);

// The native registration describes the tool; the mandatory host dispatcher
// supplies its authority and sends it to the existing managed scheduler.
export const managedTaskPlugin = Plugin.define({ id: MANAGED_TASK_PLUGIN_ID,
  effect: ({ tool }) => tool.transform(editor => editor.add({ name: 'devryan_task', input: managedTaskInputSchema,
    description: 'Manage saved-model specialists, sourced project decisions and the selected Implement plan. Start independent work without an artificial concurrency cap. wait/wait_any stay attached through bounded host slices; status is nonblocking. Collect a terminal result before disposition. read_result uses each next cursor in order; required retained detail must be read before continue/retry/resume/abandon. Completed results accept only continue. Manual or scheduled Model Recovery stays unacknowledged. Required checks need real current content and exit receipts; collection never implies verification. Builder can only read or update its selected saved plan using plan_read/plan_update with expected_version and full text.',
    options: { codemode: false }, execute: () => Effect.fail(new Tool.Error({ message: 'managed_task_host_required' })) })),
});

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const liveStatuses = new Set(['queued', 'starting', 'running']);
const terminalStatuses = new Set(['completed', 'failed', 'aborted', 'interrupted']);

// Host responses are already checked against the canonical scheduler scope.
// Validate the transport decision too: malformed slices must never spin or
// become model-visible live results from an attached wait.
function waitFinished(input: Schema.Schema.Type<typeof managedTaskInputSchema>, result: unknown, sessionID: string, directory: string): boolean {
  if (input.action !== 'wait' && input.action !== 'wait_any') return true;
  if (!record(result)) throw new Error('native_task_wait_response_invalid');
  if (input.action === 'wait') {
    if (result.state === 'stale_task_reference' || result.state === 'already_dispositioned') return true;
    const task = result.task;
    if (!record(task) || task.taskId !== input.task_id || task.rootSessionId !== sessionID || task.directory !== directory
      || typeof task.status !== 'string') throw new Error('native_task_wait_response_invalid');
    if (terminalStatuses.has(task.status)) return true;
    if (liveStatuses.has(task.status)) return false;
    throw new Error('native_task_wait_response_invalid');
  }
  if (result.rootSessionId !== sessionID || typeof result.cursor !== 'string' || typeof result.settled !== 'boolean'
    || !Array.isArray(result.readyTaskIds) || !Array.isArray(result.attention) || !Array.isArray(result.pendingTaskIds)
    || result.settled !== (result.pendingTaskIds.length === 0)
    || result.schemaVersion === 2 && !Array.isArray(result.changedTaskIds)) throw new Error('native_task_wait_response_invalid');
  return result.settled || (result.schemaVersion === 2
    ? Array.isArray(result.changedTaskIds) && result.changedTaskIds.length > 0
    : result.readyTaskIds.length > 0 || result.attention.length > 0);
}

export function withManagedTaskExecution(options: { readonly origin: RegistrationOrigin; readonly directory: string;
  readonly rpc: ExecutionRpc; readonly executeOwned: ExecuteOwned }): ExecuteOwned {
  if (options.origin.kind !== 'plugin' || options.origin.id !== MANAGED_TASK_PLUGIN_ID
    || !options.origin.capabilities.includes('managed-task')) throw new Error('Reviewed managed-task origin required');
  return invocation => {
    if (invocation.provenance.id !== MANAGED_TASK_PLUGIN_ID) return options.executeOwned(invocation);
    if (invocation.toolID !== 'devryan_task' || invocation.provenance.kind !== 'plugin'
      || invocation.provenance.manifestDigest !== options.origin.manifestDigest
      || JSON.stringify(invocation.provenance.capabilities) !== JSON.stringify(options.origin.capabilities)) {
      return Effect.fail(new Tool.Error({ message: 'managed_task_origin_mismatch' }));
    }
    return Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(managedTaskInputSchema)(invocation.input, { onExcessProperty: 'error' })
        .pipe(Effect.mapError(error => new Tool.Error({ message: String(error) })));
      const authorization = { operation: 'tool.execute', sessionID: invocation.nativeContext.sessionID,
        messageID: invocation.nativeContext.messageID, input: { toolID: invocation.toolID, callID: invocation.nativeContext.id,
          provenance: invocation.provenance, input: invocation.input } };
      for (;;) {
        yield* invocation.recheckPermit();
        const result = yield* Effect.tryPromise({ try: signal => options.rpc('native.managed-task', {
          directory: invocation.location.directory, sessionID: invocation.nativeContext.sessionID, messageID: invocation.nativeContext.messageID,
          callID: invocation.nativeContext.id, tool: invocation.toolID, input, permit: invocation.existingPermit, authorization,
        }, { signal }), catch: error => new Tool.Error({ message: error instanceof Error ? error.message : 'managed_task_failed' }) });
        yield* invocation.recheckPermit();
        const finished = yield* Effect.try({ try: () => waitFinished(input, result, invocation.nativeContext.sessionID, invocation.location.directory),
          catch: error => new Tool.Error({ message: error instanceof Error ? error.message : 'native_task_wait_response_invalid' }) });
        if (finished) return { content: JSON.stringify(result) };
      }
    });
  };
}
