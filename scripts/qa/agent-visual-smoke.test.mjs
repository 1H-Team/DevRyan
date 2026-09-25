import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySmokeProcess, gradeSmokeTree, isSmokeTurnSettled, parseProcessTable, parseSmokeArgs, SMOKE_CASES, summarizeProcessTree } from './agent-visual-smoke.mjs';

const base = ['--origin', 'http://127.0.0.1:3241', '--directory', 'w', '--expect', 'e.json', '--out', 'o'];

test('accepts only loopback origins, known cases and bounded timings', () => {
  assert.equal(parseSmokeArgs(base).cases.length, SMOKE_CASES.length);
  assert.deepEqual(parseSmokeArgs([...base, '--cases', 'fixer,oracle']).cases, ['fixer', 'oracle']);
  assert.throws(() => parseSmokeArgs([...base.slice(2), '--origin', 'https://example.com']), /loopback/);
  assert.throws(() => parseSmokeArgs([...base.slice(2), '--origin', 'http://user:pw@127.0.0.1:1']), /loopback/);
  assert.throws(() => parseSmokeArgs([...base, '--cases', 'nope']), /--cases/);
  assert.throws(() => parseSmokeArgs([...base, '--timeout-ms', '5']), /--timeout-ms/);
  assert.throws(() => parseSmokeArgs(['--origin', 'http://127.0.0.1:1']), /required/);
});

test('grades the agent that actually answered against the expected model', () => {
  const tree = [
    { sessionId: 'root', parentSessionId: null, messages: [{ info: { role: 'assistant', agent: 'orchestrator', providerID: 'openai', modelID: 'gpt-6-astra',
      tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 100, write: 0 } }, cost: 0.01 }, parts: [{ type: 'tool', tool: 'devryan_task', state: { status: 'completed' } }] }] },
    { sessionId: 'child', parentSessionId: 'root', messages: [{ info: { role: 'assistant', agent: 'fixer', providerID: 'xai', modelID: 'grok-4.6',
      tokens: { input: 20, output: 7, cache: { read: 0, write: 0 } } }, parts: [{ type: 'tool', tool: 'bash', state: { status: 'error' } }] }] },
  ];
  const expected = { fixer: { model: 'xai/grok-4.6', variant: 'high' } };
  const passed = gradeSmokeTree({ expectAgent: 'fixer' }, tree, expected);
  assert.deepEqual(passed.failures, []);
  assert.equal(passed.usage.input, 30);
  assert.equal(passed.usage.cacheRead, 100);
  assert.equal(passed.tools.errors, 1);
  const wrongModel = gradeSmokeTree({ expectAgent: 'fixer' }, tree, { fixer: { model: 'openai/gpt-5.5' } });
  assert.match(wrongModel.failures[0], /instead of openai\/gpt-5\.5/);
  assert.match(gradeSmokeTree({ expectAgent: 'designer' }, tree, expected).failures[0], /did not answer/);
});

test('summarizes a host process tree by class and finds reparented orphans', () => {
  const rows = parseProcessTable([
    ' 10 1 1.0 204800 node isolated-host.mjs',
    ' 11 10 20.5 512000 /x/DevRyan-opencode-darwin-arm64 serve --port 1',
    ' 12 11 5.0 102400 /x/DevRyan-opencode-darwin-arm64 debug devryan-tool',
    ' 13 11 1.0 409600 node /q/node_modules/typescript-language-server/lib/cli.mjs --stdio',
    ' 14 1 0.0 1024 /x/DevRyan-execution-darwin-arm64 /qa/root/views/a',
    ' 15 1 0.0 1024 unrelated',
    ' 16 1 0.5 40960 node /repo/scripts/perf/multi-session-sampler.mjs --pid 10 --runtime-root /qa/root',
    ' 17 1 0.5 40960 node scripts/perf/multi-session-sampler.mjs --pid 10 --out /qa/root/sampler',
  ].join('\n'));
  const summary = summarizeProcessTree(rows, 10, '/qa/root');
  assert.equal(summary.count, 4);
  assert.equal(summary.classes['opencode-serve'].count, 1);
  assert.equal(summary.classes['companion-worker'].rssMiB, 100);
  assert.equal(summary.classes.lsp.rssMiB, 400);
  assert.deepEqual(summary.orphans, [{ pid: 14, class: 'execution-launcher' }]);
  assert.equal(classifySmokeProcess('anything', true), 'host');
  assert.equal(summarizeProcessTree(rows, 999).rootPresent, false);
});

test('a smoke turn settles only when nothing is active, tasks are terminal and the root replied', () => {
  const done = { info: { role: 'assistant', time: { completed: 2 } } };
  const tree = [{ sessionId: 'r', messages: [done] }, { sessionId: 'c', messages: [done] }];
  const base = { tree, rootSessionId: 'r', statuses: {}, tasks: [{ status: 'completed' }] };
  assert.equal(isSmokeTurnSettled(base), true);
  assert.equal(isSmokeTurnSettled({ ...base, statuses: { c: { type: 'retry' } } }), false);
  assert.equal(isSmokeTurnSettled({ ...base, tasks: [{ status: 'running' }] }), false);
  assert.equal(isSmokeTurnSettled({ ...base, tasks: [{ status: 'failed' }] }), true);
  assert.equal(isSmokeTurnSettled({ ...base, tree: [{ sessionId: 'r', messages: [{ info: { role: 'assistant', time: {} } }] }] }), false);
});

test('a backup-model recovery passes with a warning; an unrelated model fails', () => {
  const tree = [{ sessionId: 'c', parentSessionId: 'r', messages: [
    { info: { role: 'assistant', agent: 'explorer', providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' }, parts: [] },
    { info: { role: 'assistant', agent: 'explorer', providerID: 'opencode', modelID: 'deepseek-v4.1-flash' }, parts: [] }] }];
  const expected = { explorer: { model: 'opencode-go/deepseek-v4.1-flash' } };
  const recovered = gradeSmokeTree({ expectAgent: 'explorer' }, tree, expected, { explorer: { model: 'opencode/deepseek-v4.1-flash' } });
  assert.deepEqual(recovered.failures, []);
  assert.match(recovered.warnings[0], /recovered on its backup model/);
  assert.match(gradeSmokeTree({ expectAgent: 'explorer' }, tree, expected, {}).failures[0], /instead of/);
});
