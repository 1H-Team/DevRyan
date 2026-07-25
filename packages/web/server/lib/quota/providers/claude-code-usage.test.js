import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';

import { fetchClaudeCodeUsage, parseClaudeCodeUsageOutput } from './claude-code-usage.js';

const createChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
};

describe('Claude Code /usage fallback', () => {
  it('parses overall and model-specific weekly usage', () => {
    const result = parseClaudeCodeUsageOutput(JSON.stringify({
      is_error: false,
      result: [
        'Current session: 31% used · resets Jul 24 at 7:39pm (Africa/Casablanca)',
        'Current week (all models): 3% used · resets Jul 29 at 10:59pm (Africa/Casablanca)',
        'Current week (Fable): 1% used · resets Jul 29 at 10:59pm (Africa/Casablanca)',
      ].join('\n'),
    }), new Date('2026-07-24T16:00:00+01:00').getTime());

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(31);
    expect(result.usage.windows['7d'].usedPercent).toBe(3);
    expect(result.usage.windows['7d-fable'].usedPercent).toBe(1);
  });

  it('runs the local slash command without persistence or model turns', async () => {
    const child = createChild();
    const calls = [];
    const spawnImpl = (command, args, options) => {
      calls.push({ command, args, options });
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({
          is_error: false,
          result: 'Current session: 1% used · resets Jul 24 at 7:39pm\nCurrent week (all models): 2% used · resets Jul 29 at 10:59pm',
        }));
        child.emit('close', 0);
      });
      return child;
    };

    const result = await fetchClaudeCodeUsage({ spawnImpl, now: () => new Date('2026-07-24T16:00:00+01:00').getTime() });

    expect(result.ok).toBe(true);
    expect(calls[0].command).toBe('claude');
    expect(calls[0].args).toEqual([
      '-p',
      '/usage',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--max-turns',
      '1',
    ]);
  });

  it('reports missing and unexpected CLI output', async () => {
    expect(parseClaudeCodeUsageOutput('{}').ok).toBe(false);
    expect(parseClaudeCodeUsageOutput('not-json').ok).toBe(false);
  });

  it('reports unavailable and signed-out CLI failures without throwing', async () => {
    const missingChild = createChild();
    const missing = fetchClaudeCodeUsage({
      spawnImpl: () => {
        queueMicrotask(() => missingChild.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
        return missingChild;
      },
    });
    await expect(missing).resolves.toMatchObject({ ok: false, error: expect.stringContaining('not found') });

    const signedOutChild = createChild();
    const signedOut = fetchClaudeCodeUsage({
      spawnImpl: () => {
        queueMicrotask(() => {
          signedOutChild.stderr.emit('data', 'Claude Code is not signed in');
          signedOutChild.emit('close', 1);
        });
        return signedOutChild;
      },
    });
    await expect(signedOut).resolves.toMatchObject({ ok: false, error: 'Claude Code is not signed in' });
  });
});
