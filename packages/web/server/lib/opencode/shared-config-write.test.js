import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { removeConfigKeyPaths, writeConfig, writeMdFile } from './shared.js';

const OLD_CONFIG = '{\n  "a": 1\n}';

describe('OpenCode config files are replaced atomically', () => {
  let directory;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-config-write-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const fixture = (name, content) => {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };

  it('writes a sibling temporary file and renames it over the target', () => {
    const file = fixture('opencode.json', OLD_CONFIG);
    const inodeBefore = fs.statSync(file).ino;
    const rename = fs.renameSync;
    const seen = [];
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      // At the swap the target still holds the complete old file and the
      // temporary file the complete new one.
      seen.push({ from, to, target: fs.readFileSync(to, 'utf8'), temporary: fs.readFileSync(from, 'utf8') });
      return rename(from, to);
    });

    writeConfig({ a: 2 }, file);

    expect(seen).toHaveLength(1);
    expect(path.dirname(seen[0].from)).toBe(fs.realpathSync(directory));
    expect(seen[0].to).toBe(fs.realpathSync(file));
    expect(seen[0].target).toBe(OLD_CONFIG);
    expect(JSON.parse(seen[0].temporary)).toEqual({ a: 2 });
    expect(fs.statSync(file).ino).not.toBe(inodeBefore);
    expect(fs.readdirSync(directory).sort()).toEqual(['opencode.json', 'opencode.json.devryan.backup']);
  });

  it('leaves the original intact and removes the temporary file when the write fails', () => {
    const file = fixture('opencode.json', OLD_CONFIG);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });

    expect(() => writeConfig({ a: 2 }, file)).toThrow('Failed to write OpenCode configuration');

    expect(fs.readFileSync(file, 'utf8')).toBe(OLD_CONFIG);
    expect(fs.readdirSync(directory).sort()).toEqual(['opencode.json', 'opencode.json.devryan.backup']);
  });

  it.skipIf(process.platform === 'win32')('keeps the mode of the existing file and refuses a read-only one', () => {
    const file = fixture('opencode.json', OLD_CONFIG);
    fs.chmodSync(file, 0o640);
    writeConfig({ a: 2 }, file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);

    fs.chmodSync(file, 0o444);
    if (process.getuid?.() !== 0) {
      expect(() => writeConfig({ a: 3 }, file)).toThrow('Failed to write OpenCode configuration');
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 2 });
    }
  });

  it.skipIf(process.platform === 'win32')('writes through a symlinked config, dangling or not, and keeps the link', () => {
    const real = fixture('dotfiles/opencode.json', OLD_CONFIG);
    const link = path.join(directory, 'opencode.json');
    fs.symlinkSync(real, link);
    writeConfig({ a: 2 }, link);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf8'))).toEqual({ a: 2 });

    const missing = path.join(directory, 'elsewhere', 'opencode.json');
    const danglingLink = path.join(directory, 'dangling.json');
    fs.symlinkSync(missing, danglingLink);
    writeConfig({ b: 1 }, danglingLink);
    expect(fs.lstatSync(danglingLink).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(missing, 'utf8'))).toEqual({ b: 1 });
  });

  it('removes key paths and rewrites agent markdown through the atomic replace', () => {
    const config = fixture('opencode.jsonc', '{\n  // keep\n  "a": 1,\n  "b": 2\n}\n');
    const agent = fixture('agents/reviewer.md', '---\nmode: subagent\n---\n\nOld\n');
    const renameSpy = vi.spyOn(fs, 'renameSync');

    expect(removeConfigKeyPaths(config, [['b']])).toBe(true);
    writeMdFile(agent, { mode: 'primary' }, 'New');

    expect(renameSpy.mock.calls.map(([, to]) => to)).toEqual([fs.realpathSync(config), fs.realpathSync(agent)]);
    expect(fs.readFileSync(config, 'utf8')).toContain('// keep');
    expect(fs.readFileSync(agent, 'utf8')).toBe('---\nmode: primary\n---\n\nNew');
    expect(fs.readdirSync(path.dirname(agent))).toEqual(['reviewer.md']);
  });
});
