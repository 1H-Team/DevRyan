import { expect, test } from 'bun:test';
import { createSessionExecutionOwner } from './session-execution-owner.js';
import { executionSignal } from './execution-admission.js';

test('stop during preparation cancels before launch and waits for cleanup without the preparation deadline', async () => {
  const preparing = Promise.withResolvers(), cleaning = Promise.withResolvers(), cleanup = Promise.withResolvers();
  const controller = new AbortController(), diagnostics = [];
  let claims = 0, completed = false;
  const lease = { token: 'fixture', state: 'preparing', directory: '/fixture', scope: { sessionID: 'ses_fixture' } };
  const owner = createSessionExecutionOwner({ launcher: '/fixture/launcher', verifyLauncher: async () => true,
    stopSessions: async () => { throw Error('No provider started'); }, onDiagnostic: event => diagnostics.push(event),
    runtime: {
      reserve: async () => lease,
      prepare: async () => {
        const signal = executionSignal(); preparing.resolve();
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        signal.throwIfAborted();
      },
      claimLease: async () => { claims++; },
      cancelUnstartedCall: async () => { cleaning.resolve(); await cleanup.promise; },
      cleanupLease: async () => true,
    },
  });
  const started = owner.start({ directory: '/fixture', sessionID: 'ses_fixture', userMessageID: 'msg_user',
    messageID: 'msg_assistant', callID: 'call_fixture', command: '/fixture/command', signal: controller.signal,
  }).finally(() => { completed = true; });
  void started.catch(() => {});
  try {
    await preparing.promise;
    controller.abort(Object.assign(Error('execution_cancelled'), { code: 'execution_cancelled' }));
    await cleaning.promise;
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(claims).toBe(0);
    cleanup.resolve();
    await expect(started).rejects.toMatchObject({ code: 'execution_cancelled' });
    expect(diagnostics.some(event => event.phase === 'preparation' && event.state === 'failed')).toBe(true);
    expect((await owner.drain()).every(result => result.status === 'fulfilled')).toBe(true);
  } finally { cleanup.resolve(); await started.catch(() => {}); }
});
