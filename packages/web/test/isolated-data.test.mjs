import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveDevRyanDataRoot } from '@devryan/shared-runtime/node/data-root.js';

const guard = globalThis[Symbol.for('devryan.test.realDataGuard')];
const realConfig = path.join(os.homedir(), '.config');
// Never created: the guard refuses before the file system is reached.
const probe = (name) => path.join(realConfig, name, `devryan-isolation-probe-${process.pid}`, 'file.json');

// Each refusal below is expected; drop it so this file's own check stays green.
const expectRefused = async (action) => {
  const before = guard.violations.length;
  await expect(Promise.resolve().then(action)).rejects.toMatchObject({ code: 'EDEVRYANTESTISOLATION' });
  expect(guard.violations.length).toBe(before + 1);
  guard.violations.splice(before);
};

describe('web test isolation', () => {
  it('gives the test file its own empty data folder in the OS temp dir', () => {
    const dataRoot = resolveDevRyanDataRoot();
    expect(dataRoot.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    expect(dataRoot.startsWith(realConfig)).toBe(false);
    expect(fs.readdirSync(dataRoot)).toEqual([]);
  });

  it('refuses writes into the real DevRyan, OpenChamber and OpenCode config folders', async () => {
    await expectRefused(() => fs.writeFileSync(probe('devryan'), '{}'));
    await expectRefused(() => writeFileSync(probe('opencode'), '{}'));
    await expectRefused(() => mkdirSync(path.dirname(probe('openchamber')), { recursive: true }));
    await expectRefused(() => fsPromises.writeFile(probe('opencode'), '{}'));
    await expectRefused(() => fs.renameSync(path.join(os.tmpdir(), 'missing'), probe('devryan')));
    await expectRefused(() => fs.openSync(probe('opencode'), 'w'));
    expect(fs.existsSync(path.dirname(probe('devryan')))).toBe(false);
    expect(fs.existsSync(path.dirname(probe('opencode')))).toBe(false);
  });

  it('still lets tests read and write their own temporary folders', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-isolation-'));
    try {
      fs.writeFileSync(path.join(directory, 'file.json'), '{}');
      expect(fs.readFileSync(path.join(directory, 'file.json'), 'utf8')).toBe('{}');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
