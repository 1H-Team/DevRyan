import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { DevRyanOpenCursorPlugin } from './devryan-open-cursor.mjs';

const originalConfigDirectory = process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR;
const originalLocalTools = process.env.DEVRYAN_OPEN_CURSOR_LOCAL_TOOLS;
const originalBridge = process.env.CURSOR_ACP_MCP_BRIDGE;
const originalBridgeSwitch = process.env.DEVRYAN_OPEN_CURSOR_MCP_BRIDGE;
const testCache = fileURLToPath(new URL('../../../../../.cache/open-cursor-wrapper-tests/', import.meta.url));
let temporaryRoot = null;

// Mirrors open-cursor 2.5.8: a descriptor whose server factory returns local
// tool hooks (native names, oc_ aliases, shell), a namespaced MCP tool, and
// provider hooks.
const installOpenCursor = () => {
  fs.mkdirSync(testCache, { recursive: true });
  temporaryRoot = fs.mkdtempSync(path.join(testCache, 'installed-'));
  process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR = temporaryRoot;
  const packageRoot = path.join(temporaryRoot, 'node_modules', '@rama_nigg', 'open-cursor');
  fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@rama_nigg/open-cursor', version: '2.5.8', type: 'module' }));
  fs.writeFileSync(path.join(packageRoot, 'dist', 'plugin-entry.js'), `
    const local = ['bash', 'read', 'glob', 'ls', 'mkdir', 'rm', 'stat'];
    const entry = (name) => ({ description: name, args: {}, execute: async () => name });
    export default { id: 'open-cursor', setup: () => { throw new Error('setup must not run'); }, server: async (input) => ({
      tool: Object.fromEntries([...local, ...local.map((name) => 'oc_' + name), 'oc_edit', 'oc_write', 'shell', 'mcp__docs__search']
        .map((name) => [name, entry(name)])),
      auth: { provider: 'cursor-acp', directory: input.directory, bridge: process.env.CURSOR_ACP_MCP_BRIDGE ?? null },
      'chat.params': async () => {},
    }) };
  `);
};

afterEach(() => {
  for (const [key, value] of [['DEVRYAN_OPENCODE_USER_CONFIG_DIR', originalConfigDirectory], ['DEVRYAN_OPEN_CURSOR_LOCAL_TOOLS', originalLocalTools],
    ['CURSOR_ACP_MCP_BRIDGE', originalBridge], ['DEVRYAN_OPEN_CURSOR_MCP_BRIDGE', originalBridgeSwitch]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (temporaryRoot) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = null;
  }
});

describe('DevRyan Open Cursor wrapper', () => {
  it('drops local tools that shadow built-ins or bypass permission rules and keeps every other hook', async () => {
    installOpenCursor();
    const hooks = await DevRyanOpenCursorPlugin({ directory: '/project' });
    expect(Object.keys(hooks.tool)).toEqual(['mcp__docs__search']);
    expect(hooks.auth).toEqual({ provider: 'cursor-acp', directory: '/project', bridge: 'false' });
    expect(typeof hooks['chat.params']).toBe('function');
  });

  it('leaves the MCP bridge to an explicit user setting or the DevRyan switch', async () => {
    installOpenCursor();
    process.env.CURSOR_ACP_MCP_BRIDGE = 'true';
    expect((await DevRyanOpenCursorPlugin({ directory: '/project' })).auth.bridge).toBe('true');
    delete process.env.CURSOR_ACP_MCP_BRIDGE;
    process.env.DEVRYAN_OPEN_CURSOR_MCP_BRIDGE = '1';
    expect((await DevRyanOpenCursorPlugin({ directory: '/project' })).auth.bridge).toBeNull();
  });

  it('keeps the local tools when the kill switch restores them', async () => {
    installOpenCursor();
    process.env.DEVRYAN_OPEN_CURSOR_LOCAL_TOOLS = '1';
    const hooks = await DevRyanOpenCursorPlugin({ directory: '/project' });
    expect(Object.keys(hooks.tool)).toContain('read');
    expect(Object.keys(hooks.tool)).toContain('shell');
  });

  it('fails with a repair message when the installed package is missing', async () => {
    fs.mkdirSync(testCache, { recursive: true });
    temporaryRoot = fs.mkdtempSync(path.join(testCache, 'missing-'));
    process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR = temporaryRoot;
    await expect(DevRyanOpenCursorPlugin({})).rejects.toThrow('Installed Open Cursor entrypoint is missing');
  });
});
