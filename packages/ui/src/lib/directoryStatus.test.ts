import { describe, expect, test } from 'bun:test';
import { probeDirectoryAvailability } from './directoryStatus';

const statusError = (status: number, message = 'request failed') => Object.assign(new Error(message), { status });

describe('directory availability', () => {
  test('prefers a successful local listing', async () => {
    let fallbackCalls = 0;
    const result = await probeDirectoryAvailability('/project', {
      listLocalDirectory: async () => [],
      probeDirectory: async () => {
        fallbackCalls += 1;
        return false;
      },
    });
    expect(result).toBe('exists');
    expect(fallbackCalls).toBe(0);
  });

  test('classifies only definitive missing responses as missing', async () => {
    const missing = await probeDirectoryAvailability('/gone', {
      listLocalDirectory: async () => { throw statusError(404); },
      probeDirectory: async () => false,
    });
    const transient = await probeDirectoryAvailability('/starting', {
      listLocalDirectory: async () => { throw statusError(503); },
      probeDirectory: async () => { throw statusError(503); },
    });
    const unauthorized = await probeDirectoryAvailability('/private', {
      listLocalDirectory: async () => { throw statusError(403); },
      probeDirectory: async () => { throw statusError(403); },
    });
    expect(missing).toBe('missing');
    expect(transient).toBe('unknown');
    expect(unauthorized).toBe('unknown');
  });

  test('retains SDK-worktree missing behavior after a negative fallback probe', async () => {
    expect(await probeDirectoryAvailability('/tmp/opencode/worktree/session-a', {
      listLocalDirectory: async () => { throw new Error('unavailable'); },
      probeDirectory: async () => false,
    })).toBe('missing');
  });
});
