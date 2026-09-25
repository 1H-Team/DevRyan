import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// DevRyan runs Cursor models through its own Cursor SDK runtime. open-cursor
// still supplies the cursor-acp provider, its auth loader and the proxy
// fallback, whose default "opencode" tool loop executes Cursor's tool calls
// with OpenCode's own tools. Its local-tool hooks, however, register read,
// glob, bash, shell, ls, mkdir, rm, stat and oc_* aliases for every agent. A
// plugin tool replaces the same-named built-in, and these never ask OpenCode
// for permission: they bypass path and command rules (.env files, external
// directories, bash patterns), and every read becomes a confined worker call
// instead of a native read. The wrapper drops them and keeps every other hook.
// DEVRYAN_OPEN_CURSOR_LOCAL_TOOLS=1 keeps them.
//
// open-cursor's MCP bridge also connects every enabled MCP server from the
// OpenCode config inside each instance's plugin start, with config headers
// only (not OpenCode's MCP OAuth), and registers mcp__<server>__<tool>
// duplicates of OpenCode's own MCP tools outside its MCP permissions. The
// proxy's OpenCode tool loop already sees OpenCode's MCP tools, so the bridge
// is off unless the user set CURSOR_ACP_MCP_BRIDGE or
// DEVRYAN_OPEN_CURSOR_MCP_BRIDGE=1.
const LOCAL_TOOLS = ['bash', 'read', 'glob', 'grep', 'edit', 'write', 'ls', 'mkdir', 'rm', 'stat'];
const LOCAL_TOOL_NAMES = new Set([...LOCAL_TOOLS, ...LOCAL_TOOLS.map((name) => `oc_${name}`), 'shell']);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const loadOpenCursorPlugin = async () => {
  const configuredRoot = typeof process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR === 'string'
    && process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR.trim()
    ? path.resolve(process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR.trim())
    : path.resolve(import.meta.dirname, '..');
  const pluginEntrypoint = path.join(configuredRoot, 'node_modules', '@rama_nigg', 'open-cursor', 'dist', 'plugin-entry.js');
  if (!fs.existsSync(pluginEntrypoint)) {
    throw new Error(
      `[DevRyan] Installed Open Cursor entrypoint is missing: ${pluginEntrypoint}. `
      + 'Repair the managed OpenCode profile before starting OpenCode.',
    );
  }
  const module = await import(pathToFileURL(pluginEntrypoint).href);
  const exported = module.default || module;
  // open-cursor 2.5.8 default-exports an OpenCode plugin descriptor; this
  // OpenCode version runs only its server factory.
  const plugin = isRecord(exported) ? exported.server : exported;
  if (typeof plugin !== 'function') {
    throw new Error(`[DevRyan] Installed Open Cursor entrypoint does not export a plugin: ${pluginEntrypoint}`);
  }
  return plugin;
};

export const DevRyanOpenCursorPlugin = async (input, options) => {
  const plugin = await loadOpenCursorPlugin();
  // open-cursor reads this while its server factory starts.
  if (process.env.DEVRYAN_OPEN_CURSOR_MCP_BRIDGE !== '1' && process.env.CURSOR_ACP_MCP_BRIDGE === undefined) {
    process.env.CURSOR_ACP_MCP_BRIDGE = 'false';
  }
  const hooks = await plugin(input, options);
  if (process.env.DEVRYAN_OPEN_CURSOR_LOCAL_TOOLS === '1' || !isRecord(hooks) || !isRecord(hooks.tool)) return hooks;
  return {
    ...hooks,
    tool: Object.fromEntries(Object.entries(hooks.tool).filter(([name]) => !LOCAL_TOOL_NAMES.has(name))),
  };
};

export default DevRyanOpenCursorPlugin;
