import { EXECUTION_SERVER_EDITS, EXECUTION_EXECUTOR_EDITS, patchExecutionSource, normalizeExecutionSource } from './context-mode-execution-hotfix.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { WORKER_POOL_SOURCE, WORKER_SOURCE, WORKER_STATE_SOURCE, WORKER_STORAGE_SOURCE, WORKER_PROCESS_SOURCE, EXECUTION_SOURCE } from './context-mode-worker-sources.js';
import { prepareContextModeStorageHotfix } from './context-mode-storage-hotfix.js';

export const CONTEXT_MODE_PLUGIN_SHA256 = 'a625c55ce3700de382df6cdf0648b808b11fbcee7fea90c669903d4ae7a422f0';
export const CONTEXT_MODE_EXECUTOR_SHA256 = '24c503cd12bb11207744397d6a7da69bb2219a7c59fd64fcc49ae395e50df4f2';
const PLUGIN_IMPORT = 'import { executeContextModeTool } from "../../devryan-context-mode-worker-pool.js";\n';
export const NATIVE_EXECUTE_ORIGINAL = 'const result = await mod.withProjectDirOverride({ projectDir: project, sessionId: toolCtx.sessionID }, async () => registered.handler(parsedArgs));';
const NATIVE_EXECUTE_LEGACY = 'const result = await executeContextModeTool({ name: registered.name, args: parsedArgs, projectDir: project, sessionId: toolCtx.sessionID });';
const NATIVE_EXECUTE_PREVIOUS = 'const result = await executeContextModeTool({ name: registered.name, args: parsedArgs, projectDir: project, sessionId: toolCtx.sessionID, signal: toolCtx.abort });';
const NATIVE_EXECUTE_THREADED = 'const result = await executeContextModeTool({ name: registered.name, args: parsedArgs, projectDir: project, sessionId: toolCtx.sessionID, messageId: toolCtx.messageID, onStart: (id) => toolCtx.metadata?.({ metadata: { contextModeWorkerCallID: id } }), signal: toolCtx.abort });';
const NATIVE_EXECUTE_PATCHED = NATIVE_EXECUTE_THREADED.replace('signal: toolCtx.abort', 'signal: toolCtx.abort, runtime: mod.devryanWorkerRuntime()');
const SPAWN_ORIGINAL = '    async #spawn(cmd, cwd, sandboxTmpDir, timeout, background = false) {\n        return new Promise((res) => {';
const SPAWN_PATCHED = [
  '    async #spawn(cmd, cwd, sandboxTmpDir, timeout, background = false) {',
  '        const devryanCall = globalThis[Symbol.for("devryan.context-mode.call")]?.();',
  '        devryanCall?.signal.throwIfAborted();',
  '        if (devryanCall) {',
  '            const remaining = devryanCall.remainingMs();',
  '            if (remaining <= 0) throw new Error("Context Mode worker: TIMEOUT: batch execution budget exhausted; inspect state before retry");',
  '            timeout = Math.min(timeout ?? remaining, remaining);',
  '        }',
  '        return new Promise((res) => {',
].join('\n');
const TIMER_ORIGINAL = 'const timer = timeout === undefined ? undefined : setTimeout(() => {';
const TIMER_PATCHED = 'const timer = timeout === undefined ? undefined : (devryanCall ? ((callback, ms) => devryanCall.deadline(ms, callback)) : setTimeout)(() => {';
const CLEAR_TIMER_ORIGINAL = 'clearTimeout(timer);';
const CLEAR_TIMER_PATCHED = 'if (devryanCall) timer?.(); else clearTimeout(timer);';
const TIMED_OUT_ORIGINAL = '                timedOut = true;';
const TIMED_OUT_PATCHED = TIMED_OUT_ORIGINAL + '\n                if (!background) devryanCall?.onTimeout();';
const COMPILE_ORIGINAL = '        const binPath = srcPath.replace(/\\.rs$/, "") + binSuffix;';
const COMPILE_PATCHED = [
  COMPILE_ORIGINAL,
  '        if (globalThis[Symbol.for("devryan.context-mode.call")]?.()) {',
  '            const compiled = await this.#spawn(["rustc", srcPath, "-o", binPath], cwd, cwd, Math.min(timeout ?? 60000, 60000));',
  '            if (compiled.exitCode !== 0) return { ...compiled, stderr: "Compilation failed: " + compiled.stderr };',
  '            return this.#spawn([binPath], cwd, cwd, timeout);',
  '        }',
].join('\n');
const PROCESS_START_ORIGINAL = '            let timedOut = false;\n            let resolved = false;';
const PROCESS_START_PREVIOUS = [
  '            if (proc.pid) globalThis[Symbol.for("devryan.context-mode.process")]?.({ pid: proc.pid, running: true });',
  PROCESS_START_ORIGINAL,
].join('\n');
const PROCESS_START_PATCHED = [
  '            const devryanAbort = () => killTree(proc);',
  '            devryanCall?.signal.addEventListener("abort", devryanAbort, { once: true });',
  '            if (proc.pid) globalThis[Symbol.for("devryan.context-mode.process")]?.({ pid: proc.pid, id: devryanCall?.id, running: true });',
  PROCESS_START_ORIGINAL,
].join('\n');
const PROCESS_END_ORIGINAL = '            proc.on("close", (exitCode) => {\n                clearTimeout(timer);';
const PROCESS_END_PREVIOUS = [
  '            proc.on("close", (exitCode) => {',
  '                if (proc.pid) {',
  '                    this.#backgroundedPids.delete(proc.pid);',
  '                    globalThis[Symbol.for("devryan.context-mode.process")]?.({ pid: proc.pid, running: false });',
  '                }',
  '                clearTimeout(timer);',
].join('\n');
const PROCESS_END_PATCHED = [
  '            proc.on("close", (exitCode) => {',
  '                devryanCall?.signal.removeEventListener("abort", devryanAbort);',
  '                if (proc.pid) {',
  '                    this.#backgroundedPids.delete(proc.pid);',
  '                    globalThis[Symbol.for("devryan.context-mode.process")]?.({ pid: proc.pid, id: devryanCall?.id, running: false });',
  '                }',
  '                clearTimeout(timer);',
].join('\n');
// Preserve the prior thread-compatible preload identity when provisioning an
// installed revision. Process workers also have distinct PIDs.
const PRELOAD_ORIGINAL = '`cm-fs-preload-${process.pid}.js`';
const PRELOAD_PATCHED = '`cm-fs-preload-${process.pid}-${devryanThreadId}.js`';
const THREAD_IMPORT = 'import { threadId as devryanThreadId } from "node:worker_threads";\n';
const SERVER_APPEND_PREVIOUS = '\n// DevRyan worker lifecycle: persist existing databases; never delete indexes.\nexport function devryanCloseWorker() {\n    _lastStatsPersist = 0;\n    try { persistStats(); } catch {}\n    executor.cleanupBackgrounded();\n    if (_store) _store.close();\n    try { unlinkSync(CM_FS_PRELOAD); } catch {}\n}\n';
const SERVER_APPEND = SERVER_APPEND_PREVIOUS.replace('    executor.cleanupBackgrounded();', '    _devryanSessionDb?.close();\n    executor.cleanupBackgrounded();') + `
let _devryanSessionDb;
export function devryanWorkerPaths() {
    return { storagePaths: [getStorePath(), getSessionDbPath()], statsPath: getStatsFilePath() };
}
export function devryanWorkerRuntime() { return { executable: process.execPath, runtimes }; }
export function devryanPrepareWorkerSession() {
    _devryanSessionDb ??= new SessionDB({ dbPath: getSessionDbPath() });
    _devryanSessionDb.ensureSession(currentAttribution().sessionId, getProjectDir());
    return _devryanSessionDb;
}
export function devryanRestoreWorkerStats(stats) {
    Object.assign(sessionStats, structuredClone(stats));
    if (_store) _store.devryanRefreshSharedCache();
}
export function devryanWorkerStats() { return structuredClone(sessionStats); }
export function devryanStatsPrice() { return pricePerToken(); }
export function devryanStatsLifetime() { return _lifetimeCache?.tokens ?? null; }
function devryanGetLifetimeStats(options) {
    const lifetime = getLifetimeStats(options);
    if (globalThis[Symbol.for("devryan.context-mode.storage")]) {
        _lifetimeCache = { tokens: (lifetime?.totalEvents ?? 0) * TOKENS_PER_EVENT, computedAt: Date.now() };
    }
    return lifetime;
}
`;
const SERVER_CONCURRENCY_EDITS = [
  ['const runtimes = detectRuntimes();', 'const runtimes = globalThis[Symbol.for("devryan.context-mode.runtimes")] ?? detectRuntimes();'],
  ['function persistStats() {', 'function persistStats() {\n    if (globalThis[Symbol.for("devryan.context-mode.storage")]) return;'],
  ['function healCacheMidSession() {', 'function healCacheMidSession() {\n    if (globalThis[Symbol.for("devryan.context-mode.storage")]) return;'],
  ['    const raw = process.env.CLAUDE_SESSION_ID || `pid-${process.ppid}`;', '    const raw = (globalThis[Symbol.for("devryan.context-mode.storage")] ? currentAttribution()?.sessionId : null) || process.env.CLAUDE_SESSION_ID || `pid-${process.ppid}`;'],
  ['                    let sid = process.env.CLAUDE_SESSION_ID;', '                    let sid = (globalThis[Symbol.for("devryan.context-mode.storage")] ? currentAttribution()?.sessionId : null) || process.env.CLAUDE_SESSION_ID;'],
  ['            _store.cleanupStaleSources(14);', '            const coordination = globalThis[Symbol.for("devryan.context-mode.storage")]?.();\n            if (coordination) coordination.run(dbPath, () => _store.cleanupStaleSources(14), 2);\n            else _store.cleanupStaleSources(14);'],
  ['getLifetimeStats({ sessionsDir: getSessionDir() })', 'devryanGetLifetimeStats({ sessionsDir: getSessionDir() })'],
];

export const normalizeNativeServerSource = (source) => [...SERVER_CONCURRENCY_EDITS].reverse()
  .reduce((text, [original, patched]) => text.replaceAll(patched, original), normalizeExecutionSource(source, EXECUTION_SERVER_EDITS).replace(THREAD_IMPORT, '')
    .replace(PRELOAD_PATCHED, PRELOAD_ORIGINAL).replace(SERVER_APPEND, '').replace(SERVER_APPEND_PREVIOUS, ''));
export const patchNativeServerSource = (source) => {
  // Preserve the executable shebang in the standalone MCP entrypoint.
  const position = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
  const patched = SERVER_CONCURRENCY_EDITS.reduce((text, [original, replacement]) => text.replaceAll(original, replacement), source);
  return patchExecutionSource(patched.slice(0, position) + THREAD_IMPORT + patched.slice(position).replace(PRELOAD_ORIGINAL, PRELOAD_PATCHED) + SERVER_APPEND, EXECUTION_SERVER_EDITS);
};

const replaceOnce = (source, original, replacement) => {
  if (source.split(original).length !== 2) throw new Error('Context-mode native worker anchor mismatch');
  return source.replace(original, replacement);
};
const sha256 = (source) => crypto.createHash('sha256').update(source).digest('hex');

export function prepareNativeContextModeHotfix({ packageRoot, fsApi = fs,
  expectedPluginSha256 = CONTEXT_MODE_PLUGIN_SHA256, expectedExecutorSha256 = CONTEXT_MODE_EXECUTOR_SHA256, expectedStorageSha256 }) {
  const pluginPath = `${packageRoot}/build/adapters/opencode/plugin.js`;
  const executorPath = `${packageRoot}/build/executor.js`;
  const plugin = fsApi.readFileSync(pluginPath, 'utf8').replace(PLUGIN_IMPORT, '')
    .replace(NATIVE_EXECUTE_PATCHED, NATIVE_EXECUTE_ORIGINAL).replace(NATIVE_EXECUTE_THREADED, NATIVE_EXECUTE_ORIGINAL).replace(NATIVE_EXECUTE_PREVIOUS, NATIVE_EXECUTE_ORIGINAL).replace(NATIVE_EXECUTE_LEGACY, NATIVE_EXECUTE_ORIGINAL);
  const executor = normalizeExecutionSource(fsApi.readFileSync(executorPath, 'utf8'), EXECUTION_EXECUTOR_EDITS).replaceAll(CLEAR_TIMER_PATCHED, CLEAR_TIMER_ORIGINAL)
    .replace(PROCESS_START_PATCHED, PROCESS_START_ORIGINAL).replace(PROCESS_START_PREVIOUS, PROCESS_START_ORIGINAL)
    .replace(PROCESS_END_PATCHED, PROCESS_END_ORIGINAL).replace(PROCESS_END_PREVIOUS, PROCESS_END_ORIGINAL)
    .replace(SPAWN_PATCHED, SPAWN_ORIGINAL).replace(TIMER_PATCHED, TIMER_ORIGINAL)
    .replace(TIMED_OUT_PATCHED, TIMED_OUT_ORIGINAL).replace(COMPILE_PATCHED, COMPILE_ORIGINAL)
    .replaceAll(CLEAR_TIMER_PATCHED, CLEAR_TIMER_ORIGINAL);
  if (sha256(plugin) !== expectedPluginSha256 || sha256(executor) !== expectedExecutorSha256) {
    throw new Error('Context-mode native plugin/executor source hash is incompatible');
  }
  const patchedExecutor = replaceOnce(replaceOnce(replaceOnce(executor, SPAWN_ORIGINAL, SPAWN_PATCHED),
    PROCESS_START_ORIGINAL, PROCESS_START_PATCHED), PROCESS_END_ORIGINAL, PROCESS_END_PATCHED);
  return [
    [pluginPath, PLUGIN_IMPORT + replaceOnce(plugin, NATIVE_EXECUTE_ORIGINAL, NATIVE_EXECUTE_PATCHED)],
    [executorPath, patchExecutionSource(replaceOnce(replaceOnce(replaceOnce(patchedExecutor, TIMER_ORIGINAL, TIMER_PATCHED),
      TIMED_OUT_ORIGINAL, TIMED_OUT_PATCHED), COMPILE_ORIGINAL, COMPILE_PATCHED).replaceAll(CLEAR_TIMER_ORIGINAL, CLEAR_TIMER_PATCHED), EXECUTION_EXECUTOR_EDITS)],
    [`${packageRoot}/build/devryan-context-mode-worker-pool.js`, WORKER_POOL_SOURCE],
    [`${packageRoot}/build/devryan-context-mode-worker.js`, WORKER_SOURCE],
    [`${packageRoot}/build/context-mode-worker-state.js`, WORKER_STATE_SOURCE],
    [`${packageRoot}/build/context-mode-worker-storage.js`, WORKER_STORAGE_SOURCE],
    [`${packageRoot}/build/context-mode-worker-process.js`, WORKER_PROCESS_SOURCE],
    [`${packageRoot}/build/context-mode-execution.js`, EXECUTION_SOURCE],
    ...prepareContextModeStorageHotfix({ packageRoot, fsApi, expectedStorageSha256 }),
  ];
}
