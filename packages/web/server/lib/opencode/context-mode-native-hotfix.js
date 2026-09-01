import fs from 'node:fs';
import crypto from 'node:crypto';
import { WORKER_POOL_SOURCE, WORKER_SOURCE } from './context-mode-worker-sources.js';

export const CONTEXT_MODE_PLUGIN_SHA256 = 'a625c55ce3700de382df6cdf0648b808b11fbcee7fea90c669903d4ae7a422f0';
export const CONTEXT_MODE_EXECUTOR_SHA256 = '24c503cd12bb11207744397d6a7da69bb2219a7c59fd64fcc49ae395e50df4f2';
const PLUGIN_IMPORT = 'import { executeContextModeTool } from "../../devryan-context-mode-worker-pool.js";\n';
export const NATIVE_EXECUTE_ORIGINAL = 'const result = await mod.withProjectDirOverride({ projectDir: project, sessionId: toolCtx.sessionID }, async () => registered.handler(parsedArgs));';
const NATIVE_EXECUTE_LEGACY = 'const result = await executeContextModeTool({ name: registered.name, args: parsedArgs, projectDir: project, sessionId: toolCtx.sessionID });';
const NATIVE_EXECUTE_PATCHED = 'const result = await executeContextModeTool({ name: registered.name, args: parsedArgs, projectDir: project, sessionId: toolCtx.sessionID, signal: toolCtx.abort });';
const PROCESS_START_ORIGINAL = '            let timedOut = false;\n            let resolved = false;';
const PROCESS_START_PATCHED = [
  '            if (proc.pid) globalThis[Symbol.for("devryan.context-mode.process")]?.({ pid: proc.pid, running: true });',
  PROCESS_START_ORIGINAL,
].join('\n');
const PROCESS_END_ORIGINAL = '            proc.on("close", (exitCode) => {\n                clearTimeout(timer);';
const PROCESS_END_PATCHED = [
  '            proc.on("close", (exitCode) => {',
  '                if (proc.pid) {',
  '                    this.#backgroundedPids.delete(proc.pid);',
  '                    globalThis[Symbol.for("devryan.context-mode.process")]?.({ pid: proc.pid, running: false });',
  '                }',
  '                clearTimeout(timer);',
].join('\n');
// Workers share a PID; give each its own preload file so retiring one worker
// cannot remove a file still in use by another project's background command.
const PRELOAD_ORIGINAL = '`cm-fs-preload-${process.pid}.js`';
const PRELOAD_PATCHED = '`cm-fs-preload-${process.pid}-${devryanThreadId}.js`';
const THREAD_IMPORT = 'import { threadId as devryanThreadId } from "node:worker_threads";\n';
const SERVER_APPEND = '\n// DevRyan worker lifecycle: persist existing databases; never delete indexes.\nexport function devryanCloseWorker() {\n    _lastStatsPersist = 0;\n    try { persistStats(); } catch {}\n    executor.cleanupBackgrounded();\n    if (_store) _store.close();\n    try { unlinkSync(CM_FS_PRELOAD); } catch {}\n}\n';

export const normalizeNativeServerSource = (source) => source.replace(THREAD_IMPORT, '')
  .replace(PRELOAD_PATCHED, PRELOAD_ORIGINAL).replace(SERVER_APPEND, '');
export const patchNativeServerSource = (source) => {
  // Preserve the executable shebang in the standalone MCP entrypoint.
  const position = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
  return source.slice(0, position) + THREAD_IMPORT + source.slice(position).replace(PRELOAD_ORIGINAL, PRELOAD_PATCHED) + SERVER_APPEND;
};

const replaceOnce = (source, original, replacement) => {
  if (source.split(original).length !== 2) throw new Error('Context-mode native worker anchor mismatch');
  return source.replace(original, replacement);
};
const sha256 = (source) => crypto.createHash('sha256').update(source).digest('hex');

export function prepareNativeContextModeHotfix({ packageRoot, fsApi = fs,
  expectedPluginSha256 = CONTEXT_MODE_PLUGIN_SHA256, expectedExecutorSha256 = CONTEXT_MODE_EXECUTOR_SHA256 }) {
  const pluginPath = `${packageRoot}/build/adapters/opencode/plugin.js`;
  const executorPath = `${packageRoot}/build/executor.js`;
  const plugin = fsApi.readFileSync(pluginPath, 'utf8').replace(PLUGIN_IMPORT, '')
    .replace(NATIVE_EXECUTE_PATCHED, NATIVE_EXECUTE_ORIGINAL).replace(NATIVE_EXECUTE_LEGACY, NATIVE_EXECUTE_ORIGINAL);
  const executor = fsApi.readFileSync(executorPath, 'utf8')
    .replace(PROCESS_START_PATCHED, PROCESS_START_ORIGINAL).replace(PROCESS_END_PATCHED, PROCESS_END_ORIGINAL);
  if (sha256(plugin) !== expectedPluginSha256 || sha256(executor) !== expectedExecutorSha256) {
    throw new Error('Context-mode native plugin/executor source hash is incompatible');
  }
  return [
    [pluginPath, PLUGIN_IMPORT + replaceOnce(plugin, NATIVE_EXECUTE_ORIGINAL, NATIVE_EXECUTE_PATCHED)],
    [executorPath, replaceOnce(replaceOnce(executor, PROCESS_START_ORIGINAL, PROCESS_START_PATCHED), PROCESS_END_ORIGINAL, PROCESS_END_PATCHED)],
    [`${packageRoot}/build/devryan-context-mode-worker-pool.js`, WORKER_POOL_SOURCE],
    [`${packageRoot}/build/devryan-context-mode-worker.js`, WORKER_SOURCE],
  ];
}
