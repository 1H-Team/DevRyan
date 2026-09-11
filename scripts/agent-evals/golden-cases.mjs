import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const bun = (file, pattern) => ({ runner: 'bun', file, pattern });
const web = (file, pattern) => ({ runner: 'web', file: `packages/web/${file}`, pattern });
const ui = (file, pattern) => ({ runner: 'ui', file: `packages/ui/${file}`, pattern });
const node = (file, pattern) => ({ runner: 'node', file, pattern });
const waits = 'packages/orchestration-runtime/scheduler.wait-any.test.js';
const recovery = 'packages/harness-runtime/lib/provider-recovery.test.js';
const context = 'packages/harness-runtime/lib/task-context.test.js';
const managed = 'server/default-config/plugins/devryan-managed-orchestration.test.mjs';
const guard = 'server/default-config/plugins/devryan-tool-input-guard.test.mjs';
const graders = 'scripts/agent-evals/graders.test.mjs';

// Sanitized production failure classes, backed by executable outcome and
// trajectory contracts. These are deterministic fixtures, not model samples.
// Keep them in the existing evaluation runner so failures and omissions share
// its strict report and CLI behavior. The named selectors must run >0 tests.
export const GOLDEN_CASES = Object.freeze([
  { id: 'golden-bounded-lookup', area: 'tools', specs: [node(graders, 'bounded lookup control')] },
  { id: 'golden-broad-retrieval', area: 'tools', specs: [node(graders, 'Context Mode for broad')] },
  { id: 'golden-image-inspection', area: 'tools', specs: [web(guard, 'native image attachment|raw PNG bytes')] },
  { id: 'golden-skill-resolution', area: 'tools', specs: [web('server/default-config/plugins/devryan-skill-context.test.mjs', 'directory slug|aliases collide|unknown name')] },
  { id: 'golden-ambiguous-edit', area: 'tools', specs: [web('server/default-config/agents/tool-recovery-guidance.test.js', 'patch-context recovery|refresh every direct patch')] },
  { id: 'golden-slow-command', area: 'tools', specs: [web(guard, 'explicit shell deadline|small shell deadline'), node('scripts/agent-evals/client.test.mjs', 'exit evidence|structured shell results')] },
  { id: 'golden-single-agent', area: 'orchestration', specs: [node(graders, 'no mutation for inspect|filesystem and test outcomes')] },
  { id: 'golden-independent-children', area: 'orchestration', specs: [bun('packages/orchestration-runtime/scheduler.barrier.test.js', 'concurrent work')] },
  { id: 'golden-sequential-dependency', area: 'orchestration', specs: [bun('packages/orchestration-runtime/scheduler.barrier.test.js', 'one active child|new wave for the first start')] },
  { id: 'golden-thirty-children', area: 'orchestration', specs: [bun(waits, 'admits thirty children')] },
  { id: 'golden-early-result', area: 'orchestration', specs: [bun(waits, 'next result without waiting for the slow child')] },
  { id: 'golden-before-wait', area: 'waits', specs: [bun(waits, 'already committed result')] },
  { id: 'golden-during-wait', area: 'waits', specs: [bun(waits, 'envelope is still being persisted'), bun('packages/orchestration-runtime/scheduler.wait.test.js', 'terminal first')] },
  { id: 'golden-lost-wake', area: 'waits', specs: [bun(waits, 'late durable commit')] },
  { id: 'golden-busy-parent', area: 'waits', specs: [web(managed, 'late-commit wake window')] },
  { id: 'golden-restarted-cursor', area: 'waits', specs: [bun(waits, 'cursor identity through restart')] },
  { id: 'golden-waiter-cleanup', area: 'waits', specs: [bun(waits, 'aborted waits remove their subscriptions')] },
  { id: 'golden-transport-interruption', area: 'recovery', specs: [bun(recovery, 'Claude message-only terminal error|unresolved tool on a finalized')] },
  { id: 'golden-failure-causes', area: 'recovery', specs: [bun('packages/orchestration-runtime/provider-retry-policy.test.js', 'authentication|model availability|classifyProviderRetryFailure|provider queue failures')] },
  { id: 'golden-unknown-delivery', area: 'recovery', specs: [bun(recovery, 'ambiguous POST is never retried')] },
  { id: 'golden-invalid-action-cycle', area: 'recovery', specs: [bun(recovery, 'exact rejected-input cycles')] },
  { id: 'golden-long-useful-work', area: 'recovery', specs: [bun(recovery, 'long useful work|text alone')] },
  { id: 'golden-compaction', area: 'context', specs: [bun(context, 'across two'), web('server/default-config/plugins/devryan-harness-context.test.mjs', 'compaction')] },
  { id: 'golden-older-decision', area: 'context', specs: [bun(context, 'relevant older sourced decision')] },
  { id: 'golden-stale-context', area: 'context', specs: [bun(context, 'expiry and supersession|old pass into current verification')] },
  { id: 'golden-critical-result', area: 'context', specs: [web('server/lib/orchestration/runtime.test.js', 'negotiates compact headers')] },
  { id: 'golden-scope-isolation', area: 'context', specs: [bun(waits, 'cross-root'), bun(context, 'another task claim the source|foreign message')] },
  { id: 'golden-check-evidence', area: 'evidence', specs: [web('server/lib/orchestration/required-check-observer.test.js', 'invalidates a pass|unmatched checks|actual failures')] },
  { id: 'golden-restoration-cards', area: 'evidence', specs: [ui('src/sync/message-pagination-store.test.ts', '.'), ui('src/sync/session-message-loader.plan-selection.test.ts', '.'), ui('src/components/chat/ManagedTaskRow.test.tsx', 'connection recovery|historical failed dispatch')] },
  { id: 'golden-overlap-freshness', area: 'evidence', specs: [web('server/lib/orchestration/parent-read-freshness.test.js', '.'), web(managed, 'host-owned read overlap')] },
].map((entry) => Object.freeze({ ...entry, specs: Object.freeze(entry.specs.map(Object.freeze)) })));

export const GOLDEN_CASE_IDS = Object.freeze(GOLDEN_CASES.map((entry) => entry.id));
const command = (spec) => {
  if (spec.runner === 'node') return { executable: process.execPath, args: ['--test', '--test-reporter=tap', `--test-name-pattern=${spec.pattern}`, spec.file] };
  if (spec.runner === 'bun') return { executable: 'bun', args: ['test', spec.file, '-t', spec.pattern] };
  if (spec.runner === 'ui') return { executable: 'bun', cwd: path.join(repoRoot, 'packages/ui'), args: ['test', spec.file.slice('packages/ui/'.length), '-t', spec.pattern] };
  const directory = `packages/${spec.runner}`;
  return { executable: 'bun', args: ['run', '--cwd', directory, 'test', spec.file.slice(directory.length + 1), '-t', spec.pattern] };
};

const runContract = (spec, timeoutMs) => new Promise((resolve) => {
  const invocation = command(spec);
  const child = spawn(invocation.executable, invocation.args, { cwd: invocation.cwd ?? repoRoot, shell: false, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  let output = '', overflow = false, timedOut = false, killTimer;
  const stop = (signal) => {
    try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
  };
  const timer = setTimeout(() => { timedOut = true; stop('SIGTERM'); killTimer = setTimeout(() => stop('SIGKILL'), 1000); }, timeoutMs);
  const capture = (chunk) => {
    if (output.length + chunk.length > 512 * 1024) { overflow = true; stop('SIGTERM'); return; }
    output += chunk.toString();
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  child.on('error', () => { clearTimeout(timer); clearTimeout(killTimer); resolve({ passed: false, selected: 0, reason: 'contract_start_failed' }); });
  child.on('close', (code) => {
    clearTimeout(timer); clearTimeout(killTimer);
    const clean = output.replace(/\u001b\[[0-9;]*m/g, '');
    const selected = Number((spec.runner === 'node' ? clean.match(/^# pass (\d+)/m)
      : ['bun', 'ui'].includes(spec.runner) ? clean.match(/^\s*(\d+) pass$/m)
        : clean.match(/Tests\s+(\d+) passed/))?.[1] ?? 0);
    resolve({ passed: code === 0 && selected > 0 && !overflow && !timedOut, selected,
      reason: timedOut ? 'contract_timeout' : overflow ? 'contract_output_limit' : code !== 0 ? 'contract_failed' : selected === 0 ? 'contract_selector_empty' : null });
  });
});

export const executeGoldenCase = async ({ caseId, repetition, timeoutMs }, dependencies = {}) => {
  const definition = GOLDEN_CASES.find((entry) => entry.id === caseId);
  if (!definition) throw Object.assign(new Error('Unknown golden case'), { code: 'evaluation_unknown_golden_case' });
  const startedAt = Date.now(), results = [];
  const sourceHash = createHash('sha256');
  for (const spec of definition.specs) {
    sourceHash.update(JSON.stringify(spec)).update(readFileSync(path.join(repoRoot, spec.file)));
    results.push(await (dependencies.runContract ?? runContract)(spec, Math.max(1000, timeoutMs - (Date.now() - startedAt))));
  }
  const passed = results.every((result) => result.passed);
  return { caseId, repetition, status: passed ? 'passed' : 'failed', durationMs: Date.now() - startedAt,
    errorCode: passed ? undefined : results.find((result) => !result.passed)?.reason,
    contractEvidence: { sourceHash: sourceHash.digest('hex'), selected: results.reduce((sum, entry) => sum + entry.selected, 0), mode: 'deterministic' },
    graders: results.map((result, index) => ({ id: `${caseId}.contract-${index + 1}`, passed: result.passed })),
    tools: [], sessionIds: [], managedSnapshot: { tasks: [], resultEnvelopes: [] },
    cleanup: { restored: true, manifestMatch: true, deletedOwnedFileCount: 0, deletionFailureCount: 0, sessionComplete: true, sessionDiscoveryComplete: true, sessionAbortFailureCount: 0 } };
};
