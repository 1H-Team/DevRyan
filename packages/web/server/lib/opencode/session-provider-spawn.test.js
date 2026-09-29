import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSessionWorkingDirectory } from './session-provider-spawn.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-session-directory-'));
  roots.push(root);
  return root;
};

describe('requesting session working directory', () => {
  it('uses the named existing directory, normalized', () => {
    const root = project();
    fs.mkdirSync(path.join(root, 'app'));
    const header = encodeURIComponent(`${root}/app/../app/`);
    for (const boundary of [true, false]) {
      expect(resolveSessionWorkingDirectory(header, { boundary }).resolution)
        .toEqual({ workingDirectory: path.join(root, 'app'), claimedWorkingDirectory: path.join(root, 'app'), fellBack: false });
    }
  });

  it('refuses a named directory that cannot be verified, with or without the boundary', () => {
    const root = project();
    fs.writeFileSync(path.join(root, 'file.txt'), '');
    for (const header of [encodeURIComponent(path.join(root, 'file.txt')), encodeURIComponent(path.join(root, 'gone')),
      encodeURIComponent('relative/app'), encodeURIComponent(`${root}\u0000`), '%E0%A4%A']) {
      for (const boundary of [true, false]) {
        expect(resolveSessionWorkingDirectory(header, { boundary })).toEqual({
          rejection: expect.stringMatching(/^session_directory_unavailable: /),
        });
      }
    }
  });

  it('requires the directory only inside the execution boundary', () => {
    for (const header of [undefined, '']) {
      expect(resolveSessionWorkingDirectory(header, { boundary: false })).toEqual({});
      expect(resolveSessionWorkingDirectory(header, { boundary: true }).rejection).toMatch(/^session_directory_unavailable: /);
    }
  });
});
