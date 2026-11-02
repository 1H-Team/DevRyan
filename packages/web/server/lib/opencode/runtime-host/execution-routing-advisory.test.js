import { Effect, Schema } from 'effect';
import { expect, it } from 'vitest';
import { createExecutionRouting, appendRequiredCheckFailureHints } from './execution-routing.ts';

const invocation = { toolID: 'read', location: { directory: '/project' }, existingPermit: { token: 'permit' },
  nativeContext: { sessionID: 'ses_root', messageID: 'msg_plan', id: 'call_read', agent: 'orchestrator' },
  provenance: { kind: 'native', id: 'opencode.tool.read' }, input: { filePath: '/project/src/app.ts' }, recheckPermit: () => Effect.void };
const read = finished => {
  const routing = createExecutionRouting({ directory: '/project', bridge: {},
    rpc: async method => (method === 'execution.native.direct-admit' ? { token: 'direct', generation: 2 } : finished) });
  return Effect.runPromise(routing.withDirectRead(invocation, Effect.succeed({ content: 'file text', metadata: { lines: 1 } })));
};

it('appends a typed plan-mode advisory from direct-finish to the read result and drops a malformed one', async () => {
  const advisory = { code: 'plan_mode_reread_after_explorer', count: 4, message: 'Plan mode: 4 reads or greps after the Explorer report.' };
  expect(await read({ advisory })).toEqual({ content: `file text\n\n${advisory.message}`, metadata: { lines: 1, planReadAdvisory: advisory } });
  expect(await read({ advisory: { ...advisory, code: 'other' } })).toEqual({ content: 'file text', metadata: { lines: 1 } });
  expect(await read(null)).toEqual({ content: 'file text', metadata: { lines: 1 } });
});

it('accepts only typed evidence hints and appends a failed settlement without rewriting exit, code or deadline metadata', async () => {
  const { Tool } = await import('@opencode/core/tool');
  const { ExecutionBatch } = await import('./worker-protocol.ts');
  const hints = [{ name: 'visual check', code: 'required_check_evidence_incomplete', message: 'Visual evidence is missing or invalid.' }];
  const receipt = { terminated: true, confined: true, cancelled: true, exitCode: 137 };
  const deadline = { effectiveTimeoutMs: 1000, graceMs: 2000 };
  const event = { cursor: 1, type: 'settled', ok: false, receipt, requiredCheckHints: hints, error: { message: 'stopped', code: 'command_deadline_exceeded' } };
  const parsed = Schema.decodeUnknownSync(ExecutionBatch)({ cursor: 1, done: true, events: [event] });
  const original = new Tool.Error({ message: 'command_deadline_exceeded: stopped', metadata: { output: 'actual command output', exitCode: 137, code: 'command_deadline_exceeded', deadline } });
  const appended = appendRequiredCheckFailureHints(original, { requiredCheckHints: parsed.events[0].requiredCheckHints, receipt,
    code: 'command_deadline_exceeded', errorMetadata: deadline });
  expect(appended.message).toBe(`${original.message}\n\n${hints[0].message}`);
  expect(appended.metadata).toEqual({ ...original.metadata, receipt, requiredCheckHints: hints });
  expect(appendRequiredCheckFailureHints(original, {})).toBe(original);
  expect(() => Schema.decodeUnknownSync(ExecutionBatch)({ cursor: 1, done: true,
    events: [{ ...event, requiredCheckHints: [{ ...hints[0], code: 'untrusted_hint' }] }] })).toThrow();
});
