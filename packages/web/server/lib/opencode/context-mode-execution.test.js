import { isContextModeIoerrFailureText } from './context-mode-recovery.js';
import { describe, expect, it, vi } from 'vitest';
import { executionFailure, executeWithFailureCapture, wrapExecutionFailures, captureExecutionIndex, safeNodeHeapOption } from './context-mode-execution.js';

const aborted = { exitCode: 134, stderr: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n' + 'stack frame\n'.repeat(1000), stdout: '' };
describe('Context Mode execution failures', () => {
  it.each(['--max-old-space-size=256', '--max-old-space-size 256', ' --max-old-space-size\t0256 '])('canonicalizes an explicit heap setting: %s', (value) => {
    expect(safeNodeHeapOption(value)).toBe('--max-old-space-size=256');
  });
  it.each([undefined, '', '--inspect', '--max-old-space-size=0', '--max-old-space-size=-1', '--max-old-space-size=1.5', '--max-old-space-size=Infinity', '--max-old-space-size=9007199254740992', '--max-old-space-size=256 --require evil', '--require evil --max-old-space-size=256', '--max-old-space-size=256;echo bad', '--max-old-space-size=256\n--inspect'])('discards unsafe/malformed options: %s', (value) => {
    expect(safeNodeHeapOption(value)).toBe('');
  });
  it('requires explicit fatal evidence for OOM and preserves signals', () => {
    expect(executionFailure(aborted).failureCategory).toBe('node_heap_exhausted');
    expect(executionFailure({ ...aborted, stderr: 'stack frames' }).failureCategory).toBe('process_aborted');
    expect(executionFailure({ exitCode: null, signal: 'SIGSEGV' })).toMatchObject({ exitCode: null, signal: 'SIGSEGV', failureCategory: 'process_signal' });
    expect(executionFailure({ exitCode: 0 })).toBeNull();
    expect(executionFailure({ exitCode: 1, timedOut: true })).toBeNull();
  });
  it('keeps fatal summaries outside intent search, bounds output and never replays', async () => {
    const executor = { execute: vi.fn(async () => aborted) };
    const handler = wrapExecutionFailures(async () => {
      await executeWithFailureCapture(executor, {});
      return { content: [{ type: 'text', text: 'No sections matched unrelated intent' }] };
    });
    const result = await handler();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('node_heap_exhausted');
    expect(result.content[0].text).toContain('FATAL ERROR');
    expect(result.content[0].text.length).toBeLessThan(1200);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
  it('retains the command failure when indexing fails separately', async () => {
    const handler = wrapExecutionFailures(async () => {
      await executeWithFailureCapture({ execute: async () => aborted }, {});
      captureExecutionIndex(() => { throw new Error('fixture index failure'); });
    });
    const result = await handler();
    expect(result.content[0].text).toContain('node_heap_exhausted');
    expect(result.content[0].text).toContain('indexing/retrieval failed separately');
  });
  it('attributes parallel batch failures and isolates subsequent calls', async () => {
    const handler = wrapExecutionFailures(async (fail) => {
      if (fail) await Promise.all(['one', 'two'].map((devryanLabel) => executeWithFailureCapture({ execute: async () => aborted }, { devryanLabel })));
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const [failed, success] = await Promise.all([handler(true), handler(false)]);
    expect(failed.content[0].text).toContain('(one)');
    expect(failed.content[0].text).toContain('(two)');
    expect(success).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(await handler(false)).toEqual(success);
  });
  it('does not turn a child crash mentioning SQLite into host recovery', async () => {
    const command = { ...aborted, stderr: aborted.stderr + '\nSQLITE_IOERR disk I/O error' };
    const result = await wrapExecutionFailures(async () => {
      await executeWithFailureCapture({ execute: async () => command }, {});
      return { isError: true, content: [{ type: 'text', text: command.stderr }] };
    })();
    expect(isContextModeIoerrFailureText(result.content.map(part => part.text).join('\n'))).toBe(false);
    expect(isContextModeIoerrFailureText('Output indexing/retrieval failed separately; full output may be unavailable.\nSQLITE_IOERR')).toBe(true);
  });
  it('preserves ordinary soft-exit semantics while retaining compiler diagnostics', async () => {
    const result = await wrapExecutionFailures(async () => {
      await executeWithFailureCapture({ execute: async () => ({ exitCode: 1, stdout: 'TS2322: type mismatch', stderr: '' }) }, {});
      return { isError: false, content: [{ type: 'text', text: 'TS2322: type mismatch' }] };
    })();
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('Exit code: 1');
    expect(result.content[1].text).toContain('TS2322');
  });
});
