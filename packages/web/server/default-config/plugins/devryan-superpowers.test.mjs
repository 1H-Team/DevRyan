import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DevRyanSuperpowersPlugin } from './devryan-superpowers.mjs';

const originalConfigDirectory = process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR;
let temporaryRoot = null;

afterEach(() => {
  if (originalConfigDirectory === undefined) {
    delete process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR;
  } else {
    process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR = originalConfigDirectory;
  }
  if (temporaryRoot) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = null;
  }
});

describe('DevRyan Superpowers plugin', () => {
  it('disables itself with one warning when the optional bootstrap is missing', async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-superpowers-missing-'));
    process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR = temporaryRoot;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = await DevRyanSuperpowersPlugin();
    const second = await DevRyanSuperpowersPlugin();

    expect(first).toEqual({});
    expect(second).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[DevRyan] Superpowers skills are not installed; the optional adapter is disabled.',
    );
    warn.mockRestore();
  });

  it('registers only the installed curated directory and injects bootstrap once', async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-superpowers-installed-'));
    process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR = temporaryRoot;
    const skillPath = path.join(
      temporaryRoot,
      'skills',
      'superpowers',
      'using-superpowers',
      'SKILL.md',
    );
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, '---\nname: using-superpowers\n---\nUse installed skills.\n', 'utf8');

    const plugin = await DevRyanSuperpowersPlugin();
    const config = {};
    await plugin.config(config);
    expect(config.skills.paths).toEqual([
      path.join(temporaryRoot, 'skills', 'superpowers'),
    ]);

    const output = {
      messages: [{
        info: { role: 'user' },
        parts: [{ type: 'text', text: 'test request' }],
      }],
    };
    await plugin['experimental.chat.messages.transform']({}, output);
    await plugin['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts).toHaveLength(2);
    expect(output.messages[0].parts[0].text).toContain(
      "You have DevRyan's curated Superpowers skills installed locally.",
    );
    expect(output.messages[0].parts[0].text).toContain('Use installed skills.');
  });
});
