import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Primary recovery answers a primary session's abort locally without calling
// next(). The control journal (and its observer: aborted turns, managed Stop)
// must therefore run first, in the same mount, and exactly once.
const APPLICATION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../application.js');

describe('server control journal mount order', () => {
  it('journals session controls once, before primary recovery can answer them', () => {
    const source = fs.readFileSync(APPLICATION, 'utf8');
    const mounts = source.split('harnessRuntime.controlJournalMiddleware').length - 1;
    expect(mounts).toBe(1);
    const journal = source.indexOf('harnessRuntime.controlJournalMiddleware');
    const recovery = source.indexOf('primaryRecoveryRuntime.middleware');
    expect(recovery).toBeGreaterThan(journal);
    const mount = source.lastIndexOf("app.use('/api/session/:sessionID'", journal);
    expect(mount).toBeGreaterThanOrEqual(0);
    // Same app.use(...) call: no statement boundary between the two middlewares.
    expect(source.slice(mount, recovery)).not.toContain(');');
  });
});
