import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { createExecutionRouting } from './execution-routing.ts';

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
