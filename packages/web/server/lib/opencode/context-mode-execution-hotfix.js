// Exact edits to the pinned sources. Native provisioning validates the normalized
// source hashes before any writes; reversing these edits supports upgrades.
const IMPORT = 'import { safeNodeHeapOption, executeWithFailureCapture, executeFileWithFailureCapture, wrapExecutionFailures, captureExecutionIndex } from "./context-mode-execution.js";\n';
export const EXECUTION_SERVER_EDITS = [
  ['const wrappedHandler = wrapToolHandler(name, handler);', 'const wrappedHandler = wrapToolHandler(name, wrapExecutionFailures(handler));'],
  ['await executor.executeFile({', 'await executeFileWithFailureCapture(executor, {'],
  ['await executor.execute({', 'await executeWithFailureCapture(executor, {'],
  ['code: `${nodeOptsPrefix}${cmd.command}`,', 'code: `${nodeOptsPrefix}${cmd.command}`,\n                devryanLabel: cmd.label,'],
  ['const option = `--require ${preloadPath}`;', 'const option = [safeNodeHeapOption(process.env.NODE_OPTIONS), `--require ${preloadPath}`].filter(Boolean).join(" ");'],
  ['function intentSearch(stdout, intent, source, maxResults = 5) {', 'function intentSearch(...args) { return captureExecutionIndex(() => devryanIntentSearch(...args)); }\nfunction devryanIntentSearch(stdout, intent, source, maxResults = 5) {'],
  ['const store = getStore();\n        const source = `batch:', 'const store = captureExecutionIndex(() => getStore());\n        const source = `batch:'],
  ['const indexed = store.index({ content: stdout, source, attribution: currentAttribution() });', 'const indexed = captureExecutionIndex(() => store.index({ content: stdout, source, attribution: currentAttribution() }));'],
  ['const queryResults = formatBatchQueryResults(store, queries, source, undefined, query_scope);', 'const queryResults = captureExecutionIndex(() => formatBatchQueryResults(store, queries, source, undefined, query_scope));'],
];
export const EXECUTION_EXECUTOR_EDITS = [
  ['proc.on("close", (exitCode) => {', 'proc.on("close", (exitCode, signal) => {'],
  ['exitCode: timedOut ? 1 : (exitCode ?? 1),', 'exitCode: timedOut ? 1 : exitCode,\n                    signal: signal ?? null,'],
  ['// Sandbox overrides — forced values for correct sandbox behavior', 'const devryanHeap = safeNodeHeapOption(process.env.NODE_OPTIONS);\n        if (devryanHeap) env["NODE_OPTIONS"] = devryanHeap;\n        // Sandbox overrides — forced values for correct sandbox behavior'],
];
export function patchExecutionSource(source, edits) {
  const position = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
  return source.slice(0, position) + IMPORT + edits.reduce((text, [before, after]) => text.replaceAll(before, after), source.slice(position));
}
export function normalizeExecutionSource(source, edits) {
  return [...edits].reverse().reduce((text, [before, after]) => text.replaceAll(after, before), source.replace(IMPORT, ''));
}
