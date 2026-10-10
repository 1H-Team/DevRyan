import { expect, test, vi } from 'vitest';
import { startStartupTiming } from './startup-timing.js';

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
