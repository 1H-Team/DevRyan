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

test('a supervisor that ends before creating its receipt is settled as never started', async () => {
  const fs = await import('node:fs/promises'), path = await import('node:path'), os = await import('node:os');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-never-started-')));
  const viewDirectory = path.join(root, 'worktree'); await fs.mkdir(viewDirectory);
  const lease = { token: 'fixture', state: 'preparing', directory: '/fixture', scope: {}, viewDirectory };
  const settled = [];
  // `false` stands in for a launcher terminated before it opens the receipt.
  const owner = createSessionExecutionOwner({ launcher: '/usr/bin/false', verifyLauncher: async () => true,
    stopSessions: async () => { throw Error('No provider started'); },
    runtime: { reserve: async () => lease, prepare: async () => lease, claimLease: async () => { lease.executionKind = 'process'; },
      cancelUnstartedCall: async input => { settled.push(['cancelled-unstarted', input.token]); },
      cancelLease: async () => { settled.push(['cancelled']); }, finish: async () => { settled.push(['finished']); },
      cleanupLease: async input => { settled.push(['cleaned', input.token]); return true; } },
  });
  try {
    const handle = await owner.start({ directory: '/fixture', sessionID: 'ses_fixture', userMessageID: 'msg_user',
      messageID: 'msg_assistant', callID: 'call_fixture', command: '/usr/bin/true' });
    await expect(handle.result).rejects.toMatchObject({ code: 'mutation_termination_unconfirmed', neverStarted: true });
    expect(settled).toEqual([['cancelled-unstarted', 'fixture'], ['cleaned', 'fixture']]);
    // An unreadable receipt means the command may have run: it stays held.
    await fs.writeFile(path.join(root, 'termination.json'), '', { mode: 0o600 }); settled.length = 0; delete lease.executionKind;
    const started = await owner.start({ directory: '/fixture', sessionID: 'ses_fixture', userMessageID: 'msg_user',
      messageID: 'msg_assistant', callID: 'call_fixture', command: '/usr/bin/true' });
    const failure = await started.result.catch(cause => cause);
    expect(failure).toMatchObject({ code: 'mutation_termination_unconfirmed' }); expect(failure.neverStarted).toBeUndefined();
    expect(settled).toEqual([]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
