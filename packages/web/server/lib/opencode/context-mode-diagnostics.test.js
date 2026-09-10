import { describe, expect, it, vi } from 'vitest';
import { recordContextModeDiagnostic } from './context-mode-diagnostics.js';

const event = { phase: 'queued', sessionID: 'ses_a', callID: 'call_a', messageID: 'msg_a', workerCallID: 'worker_a',
  tool: 'ctx_index', sequence: 1, sourceAt: 1, elapsedMs: 0, budgetMs: 120_000, droppedEvents: 0 };
describe('Context Mode private journal bridge', () => {
  it('records only bounded execution failure fields', () => {
    const record = vi.fn();
    const failure = { ...event, phase: 'execution_failed', failureCategory: 'node_heap_exhausted', exitCode: 134, signal: null };
    recordContextModeDiagnostic({ ...failure, stderr: 'private', NODE_OPTIONS: 'private' }, record);
    expect(record.mock.calls[0][0].payload).toMatchObject({ failureCategory: 'node_heap_exhausted', exitCode: 134, signal: null });
    expect(JSON.stringify(record.mock.calls)).not.toContain('private');
    for (const invalid of [{ failureCategory: 'private' }, { exitCode: -1 }, { signal: 'private' }]) {
      expect(() => recordContextModeDiagnostic({ ...failure, ...invalid }, record)).toThrow('Invalid Context Mode execution failure');
    }
  });
  it('records correlated phases and strips all arbitrary payload fields', () => {
    const record = vi.fn();
    recordContextModeDiagnostic({ ...event, args: { path: '/private/file' }, error: 'private error' }, record);
    expect(record).toHaveBeenCalledWith({ type: 'lifecycle', event: 'context_mode.queued', sessionID: 'ses_a',
      payload: { phase: 'queued', callID: 'call_a', messageID: 'msg_a', workerCallID: 'worker_a', tool: 'ctx_index', sequence: 1, sourceAt: 1, elapsedMs: 0, budgetMs: 120_000 } });
    expect(JSON.stringify(record.mock.calls)).not.toContain('private');
  });
  it('qualifies gaps after diagnostic delivery failures', () => {
    const record = vi.fn();
    recordContextModeDiagnostic({ ...event, droppedEvents: 3 }, record);
    expect(record.mock.calls[0][0]).toMatchObject({ type: 'gap', event: 'context_mode.diagnostics_gap', payload: { droppedEvents: 3 } });
  });
  it.each([{ phase: 'anything' }, { sessionID: 'bad\nvalue' }, { workerCallID: '' }, { elapsedMs: -1 },
    { callID: 'x'.repeat(161) }, { budgetMs: Infinity }, { tool: 'bash' }])('rejects invalid correlation data %j', (invalid) => {
    const record = vi.fn();
    expect(() => recordContextModeDiagnostic({ ...event, ...invalid }, record)).toThrow('Invalid Context Mode diagnostic');
    expect(record).not.toHaveBeenCalled();
  });
});
