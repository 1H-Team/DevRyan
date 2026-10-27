import { expect, test, vi } from 'vitest';
import { startStartupTiming, timeStartupPhase } from './startup-timing.js';

test('startup timing contains only its fixed phase, outcome and monotonic duration', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    startStartupTiming('bundle_preparation')();
    startStartupTiming('application_import')('failed');
    expect(log.mock.calls.map(([prefix, json]) => ({ prefix, ...JSON.parse(json) }))).toEqual([
      { prefix: '[runtime-bundle] startup phase', phase: 'bundle_preparation', outcome: 'completed', elapsedMs: expect.any(Number) },
      { prefix: '[runtime-bundle] startup phase', phase: 'application_import', outcome: 'failed', elapsedMs: expect.any(Number) },
    ]);
    expect(log.mock.calls.every(([, json]) => JSON.parse(json).elapsedMs >= 0)).toBe(true);
  } finally { log.mockRestore(); }
});

test('startup subphases preserve results and failures without recording operation payloads', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const result = { private: 'not diagnostic data' };
    expect(await timeStartupPhase('bundle_selection', async () => result)).toBe(result);
    const error = new Error('private failure');
    await expect(timeStartupPhase('bundle_database_checkpoint', async () => { throw error; })).rejects.toBe(error);
    const rows = log.mock.calls.map(([, value]) => JSON.parse(value));
    expect(rows).toEqual([
      { phase: 'bundle_selection', outcome: 'completed', elapsedMs: expect.any(Number) },
      { phase: 'bundle_database_checkpoint', outcome: 'failed', elapsedMs: expect.any(Number) },
    ]);
  } finally { log.mockRestore(); }
});
