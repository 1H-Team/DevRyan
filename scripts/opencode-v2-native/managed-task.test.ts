import { expect, test } from 'bun:test';
import { Location } from '@opencode/core/location';
import { Effect, Schema } from 'effect';
import { Session } from '@opencode/schema/session';
import { SessionMessage } from '@opencode/schema/session-message';
import { Agent } from '@opencode/schema/agent';
import { Tool } from '@opencode/schema/tool';
import { withManagedTaskExecution } from '../../packages/web/server/lib/opencode/runtime-host/managed-task.ts';
import type { OwnedToolInvocation } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.ts';
import {evaluate} from '@opencode/core/permission';
import {translateNativeConfiguration} from '../../packages/web/server/lib/opencode/runtime-host/native-configuration-data.js';

test('managed tool dispatch seals native call identity and refuses spoofed registrations', async () => {
  const requests: unknown[] = [];
  const origin = { kind: 'plugin' as const, id: 'devryan.managed-task', manifestDigest: 'a'.repeat(64), capabilities: ['managed-task'] as const };
  const call: OwnedToolInvocation = { toolID: 'devryan_task', provenance: origin,
    input: { action: 'start', agent: 'fixer', prompt: 'Inspect the regression' },
    location: Schema.decodeUnknownSync(Location.Info)({ directory: '/project', project: {id:'global',directory:'/project',canonical:'/project'} }), nativeContext: { sessionID: Session.ID.make('ses_root'), messageID: SessionMessage.ID.make('msg_assistant'),
      agent: Agent.ID.make('orchestrator'), id: Tool.CallID.make('call_1'), progress: () => Effect.void },
    existingPermit: { token: 'b'.repeat(64), sessionID: 'ses_root', revision: 1 },
    recheckPermit: () => Effect.void, nativePermissionAssert: () => Effect.void,
    executeNative: () => Effect.die(new Error('unowned execution')) };
  const execute = withManagedTaskExecution({ origin, directory: '/project', rpc: async (method, input) => {
    requests.push({ method, input }); return { task: { taskId: 'task_1' } };
  }, executeOwned: () => Effect.die(new Error('unexpected native tool')) });
  expect(await Effect.runPromise(execute(call))).toEqual({ content: '{"task":{"taskId":"task_1"}}' });
  expect(requests[0]).toMatchObject({ method: 'native.managed-task', input: { sessionID: 'ses_root', callID: 'call_1',
    authorization: { operation: 'tool.execute', input: { provenance: origin, input: call.input } } } });
  await expect(Effect.runPromise(execute({ ...call, provenance: { ...origin, manifestDigest: 'c'.repeat(64) } }))).rejects.toThrow('managed_task_origin_mismatch');
  await expect(Effect.runPromise(execute({ ...call, input: { action: 'start', agent: 'fixer', prompt: 'Inspect', readOnly: false } }))).rejects.toThrow();
  expect(requests).toHaveLength(1);
});

test('pinned native permission evaluation preserves boolean tool restrictions and explicit precedence',()=>{
 const configuration=translateNativeConfiguration({legacy:{tools:{bash:false,write:false,task:false},permission:{bash:{'git *':'allow'}}},
  agents:{reader:{tools:{bash:false,edit:false},permission:{bash:{'git status':'allow'}}}}});
 const rules=Schema.decodeUnknownSync(Schema.Array(Schema.Struct({action:Schema.String,resource:Schema.String,effect:Schema.Literals(['allow','deny','ask'])})))(configuration.permissions);
 expect(evaluate('shell','rm file',rules).effect).toBe('deny');
 expect(evaluate('shell','git status',rules).effect).toBe('allow');
 expect(evaluate('edit','file',rules).effect).toBe('deny');expect(evaluate('subagent','explorer',rules).effect).toBe('deny');
 const agent=configuration.agents;
 if(!agent||typeof agent!=='object'||!('reader' in agent)||!agent.reader||typeof agent.reader!=='object'||!('permissions' in agent.reader))throw Error('Missing reader permissions');
 const agentRules=Schema.decodeUnknownSync(Schema.Array(Schema.Struct({action:Schema.String,resource:Schema.String,effect:Schema.Literals(['allow','deny','ask'])})))(agent.reader.permissions);
 expect(evaluate('shell','git status',rules,agentRules).effect).toBe('allow');
 expect(evaluate('shell','git diff',agentRules).effect).toBe('ask');
 expect(evaluate('edit','file',rules,agentRules).effect).toBe('deny');
});
