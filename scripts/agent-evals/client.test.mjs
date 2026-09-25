import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  EvaluationHttpError,
  EvaluationTimeoutError,
  abortSessionTree,
  buildOwnedTestEvidenceCommand,
  collectOracleReviewEvidence,
  collectSanitizedTools,
  createEvaluationClient,
  fetchSessionTree,
  runSessionTurn,
} from './client.mjs';

const servers = new Set();

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve) => {
    server.close(resolve);
    // Deadline tests abort in-flight loopback requests; do not wait for their
    // keep-alive sockets to expire before the next test.
    server.closeAllConnections();
  })));
  servers.clear();
});

const startServer = async (handler) => {
  const server = createServer(handler);
  servers.add(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

const readJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
};

const sendJson = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

// Success-path turn budgets are hang guards, not assertions: every fixture
// below answers terminally on its first polls, so a loaded host must never be
// able to reach the deadline before the asserted outcome.
const UNREACHABLE_TURN_BUDGET_MS = 30_000;
// Cleanup budgets for tests that assert a complete abort tree; cleanup returns
// as soon as the loopback abort requests answer.
const UNREACHABLE_CLEANUP_BUDGET_MS = 30_000;

// Manual stand-in for runSessionTurn's deadline timer. Timeout tests fire it
// from the fixture once the session exists, so the deadline is the only
// possible outcome and it can never land during session creation.
const createManualDeadline = () => {
  let callback = null;
  return {
    timers: {
      setTimeout(onDeadline) {
        callback = onDeadline;
        return 'manual-turn-deadline';
      },
      clearTimeout() {
        callback = null;
      },
    },
    fire() {
      assert.ok(callback, 'turn deadline is not armed');
      callback();
    },
  };
};

const flushPendingCallbacks = () => new Promise((resolve) => setImmediate(resolve));

describe('DevRyan loopback evaluation client', () => {
  test('uses the host Cursor catalog and SDK auth status for pinned model availability', async () => {
    const selection = { providerId: 'cursor-acp', modelId: 'composer-2.5', agent: 'builder', variant: null };
    for (const [sdkAuthConfigured, models, expected] of [
      [true, { 'composer-2.5': { variants: { high: {} } } }, { available: true, variantAvailable: true }],
      [false, { 'composer-2.5': {} }, { available: false, variantAvailable: true }],
      [true, {}, { available: false, variantAvailable: true }],
      [undefined, { 'composer-2.5': {} }, { available: null, variantAvailable: null }],
    ]) {
      const requests = [];
      const client = createEvaluationClient({ baseUrl: 'http://127.0.0.1:3000', fetchImpl: async (url) => {
        requests.push(new URL(url).pathname);
        return Response.json(url.includes('/config/providers')
          ? { providers: [{ id: 'cursor-acp', models }] }
          : { sdkAuthConfigured });
      } });
      assert.deepEqual(await client.getAdvertisedAvailability('/fixture', selection), expected);
      assert.deepEqual(requests.sort(), ['/api/config/providers', '/api/provider/cursor-acp/runtime-status']);
      if (sdkAuthConfigured === true && models['composer-2.5']) {
        assert.deepEqual(await client.getAdvertisedAvailability('/fixture', { ...selection, variant: 'missing' }),
          { available: true, variantAvailable: false });
      }
    }
  });

  test('extracts only whitelisted Oracle finding signals from root assistant text', () => {
    const evidence = collectOracleReviewEvidence([
      {
        sessionId: 'ses_root',
        messages: [
          {
            info: { role: 'user' },
            parts: [{
              type: 'text',
              text: 'authorization bypass stale revision idempotency reserve webhook regression SECRET_PROMPT',
            }],
          },
          {
            info: { role: 'assistant' },
            parts: [{
              type: 'text',
              text: [
                'High: Authorization check verifies only that the actor exists, so a user can bypass profile ownership.',
                '`src/devryan-eval-review.ts:2` must require the owner or an administrator.',
                'High: expectedRevision is ignored, allowing concurrent stale writes and lost updates.',
                '<status>complete</status>',
              ].join('\n'),
            }],
          },
        ],
      },
      {
        sessionId: 'ses_child',
        messages: [{
          info: { role: 'assistant' },
          parts: [{
            type: 'text',
            text: 'Idempotency must reserve before the gateway; webhook events can regress terminal state.',
          }],
        }],
      },
    ], {
      rootSessionId: 'ses_root',
      runFiles: {
        sourceRelativePath: 'src/devryan-eval-review.ts',
        testRelativePath: 'src/devryan-eval-review.test.mjs',
      },
    });

    assert.deepEqual(evidence, {
      signals: ['authorization_boundary', 'stale_write'],
      pathLineEvidence: true,
      declaredFindingCount: null,
      terminalComplete: true,
    });
    const serialized = JSON.stringify(evidence);
    assert.equal(serialized.includes('SECRET'), false);
    assert.equal(serialized.includes('devryan-eval-review'), false);
  });

  test('reads one declared Oracle finding count from root assistant text only', () => {
    const tree = (assistantText) => [
      { sessionId: 'ses_root', messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'State <findings>N</findings>. <findings>7</findings>' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: assistantText }] },
      ] },
      { sessionId: 'ses_child', messages: [
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: '<findings>4</findings>' }] },
      ] },
    ];
    const collect = (text) => collectOracleReviewEvidence(tree(text), { rootSessionId: 'ses_root' });

    const clean = collect('No blocker: owner, administrator, and revision checks hold.\n<findings>0</findings>\n<status>complete</status>');
    assert.equal(clean.declaredFindingCount, 0);
    assert.equal(clean.terminalComplete, true);
    assert.equal(collect('<findings>2</findings>\n<status>complete</status>').declaredFindingCount, 2);
    assert.equal(collect('No findings.\n<status>complete</status>').declaredFindingCount, null);
    assert.equal(collect('<findings>0</findings> <findings>1</findings>').declaredFindingCount, null);
  });

  test('builds a canonical owned-test wrapper that emits its marker under zsh', () => {
    const command = buildOwnedTestEvidenceCommand('src/devryan-eval-portable.test.mjs');
    assert.equal(
      command,
      'devryan_eval_test_exit=0; node --test src/devryan-eval-portable.test.mjs || devryan_eval_test_exit=$?; printf \'\\nDEVRYAN_EVAL_TEST_EXIT_CODE=%s\\n\' "$devryan_eval_test_exit"',
    );
    if (process.platform !== 'darwin') return;

    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'devryan-eval-zsh-'));
    mkdirSync(path.join(fixtureRoot, 'src'));
    writeFileSync(
      path.join(fixtureRoot, 'src', 'devryan-eval-portable.test.mjs'),
      "import assert from 'node:assert/strict'; import test from 'node:test'; test('red', () => assert.fail('expected'));\n",
    );
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const result = spawnSync('/bin/zsh', ['-c', command], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: childEnvironment,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DEVRYAN_EVAL_TEST_EXIT_CODE=1\n$/);
  });

  test('keeps the canonical owned-test wrapper observable under shell errexit', () => {
    if (process.platform !== 'darwin') return;
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'devryan-eval-zsh-errexit-'));
    mkdirSync(path.join(fixtureRoot, 'src'));
    writeFileSync(
      path.join(fixtureRoot, 'src', 'devryan-eval-portable.test.mjs'),
      "import assert from 'node:assert/strict'; import test from 'node:test'; test('red', () => assert.fail('expected'));\n",
    );
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const result = spawnSync('/bin/zsh', [
      '-e',
      '-c',
      buildOwnedTestEvidenceCommand('src/devryan-eval-portable.test.mjs'),
    ], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: childEnvironment,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DEVRYAN_EVAL_TEST_EXIT_CODE=1\n$/);
  });

  test('derives only private owned-test outcomes and withholds ordinals until grading', () => {
    const tools = collectSanitizedTools([{
      sessionId: 'ses_parent_SECRET',
      messages: [{ parts: [
        {
          type: 'tool',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'node --test src/devryan-eval-run.test.mjs' },
            output: 'SECRET ASSERTION OUTPUT',
            metadata: { exitCode: 1, private: 'SECRET METADATA' },
            time: { start: 10, end: 20 },
          },
        },
        {
          type: 'tool',
          tool: 'apply_patch',
          state: {
            status: 'completed',
            input: { patch: 'SECRET PATCH' },
            output: 'SECRET OUTPUT',
            time: { start: 21, end: 30 },
          },
        },
        {
          type: 'tool',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'node --test src/devryan-eval-run.test.mjs' },
            output: 'SECRET PASS OUTPUT',
            metadata: { exitCode: 0 },
            time: { start: 31, end: 40 },
          },
        },
      ] }],
    }], {
      rootSessionId: 'ses_parent_SECRET',
      ownedTestRelativePath: 'src/devryan-eval-run.test.mjs',
    });

    assert.deepEqual(tools, [
      {
        tool: 'bash', status: 'completed', final: true, sessionScope: 'root', ownedTestOutcome: 'failed',
      },
      {
        tool: 'apply_patch', status: 'completed', final: true, sessionScope: 'root',
      },
      {
        tool: 'bash', status: 'completed', final: true, sessionScope: 'root', ownedTestOutcome: 'passed',
      },
    ]);
    const serialized = JSON.stringify(tools);
    assert.equal(serialized.includes('SECRET'), false);
    assert.equal(serialized.includes('devryan-eval-run'), false);
    assert.equal(serialized.includes('command'), false);
    assert.equal(serialized.includes('exitCode'), false);
    assert.equal(serialized.includes('time'), false);
    assert.equal(serialized.includes('sessionId'), false);
  });

  test('fails closed without exit evidence and never treats a transport error as test RED', () => {
    const tools = collectSanitizedTools([{
      sessionId: 'ses_parent',
      messages: [{ parts: [
        {
          type: 'tool',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'node --test src/devryan-eval-run.test.mjs' },
            output: 'opaque output',
            time: { start: 1, end: 2 },
          },
        },
        {
          type: 'tool',
          tool: 'bash',
          state: {
            status: 'error',
            input: { command: 'node --test src/devryan-eval-run.test.mjs' },
            error: 'transport failure',
            metadata: { exitCode: 1 },
            time: { start: 3, end: 4 },
          },
        },
      ] }],
    }], {
      rootSessionId: 'ses_parent',
      ownedTestRelativePath: 'src/devryan-eval-run.test.mjs',
    });

    assert.deepEqual(tools, [
      { tool: 'bash', status: 'completed', final: true, sessionScope: 'root' },
      { tool: 'bash', status: 'error', final: true, sessionScope: 'root' },
    ]);
  });

  test('accepts an exact owned test after changing to the known fixture directory only', () => {
    const workingDirectory = '/fixture with spaces';
    const ownedTestRelativePath = 'src/devryan-eval-run.test.mjs';
    const wrapper = buildOwnedTestEvidenceCommand(ownedTestRelativePath);
    const samples = [
      ["cd '/fixture with spaces' && " + wrapper, 'completed', 'failed'],
      ['cd "/fixture with spaces" && ' + wrapper, 'completed', 'failed'],
      ["cd '/other fixture' && " + wrapper, 'completed', null],
      ["cd '/fixture with spaces' && echo hidden; " + wrapper, 'completed', null],
      ["cd '/fixture with spaces' && " + wrapper + '; true', 'completed', null],
      ["cd '/fixture with spaces' && " + wrapper, 'error', null],
      ["cd '/fixture with spaces' || " + wrapper, 'completed', null],
    ];
    const tree = [{ sessionId: 'ses_parent', messages: [{ parts: samples.map(([command, status]) => ({
      type: 'tool', tool: 'shell', state: { status, input: { command }, metadata: { exit: 0 },
        output: 'Test failed\nDEVRYAN_EVAL_TEST_EXIT_CODE=1\n' },
    })) }] }];
    const tools = collectSanitizedTools(tree, { rootSessionId: 'ses_parent', ownedTestRelativePath, workingDirectory });
    assert.deepEqual(tools.map(event => event.ownedTestOutcome ?? null), samples.map(sample => sample[2]));
    assert.ok(collectSanitizedTools(tree, { rootSessionId: 'ses_parent', ownedTestRelativePath })
      .every(event => event.ownedTestOutcome === undefined));
  });

  test('accepts native OpenCode exit metadata only when all reported exit channels agree', () => {
    const ownedTestRelativePath = 'src/devryan-eval-run.test.mjs';
    const direct = `node --test ${ownedTestRelativePath}`;
    const wrapper = buildOwnedTestEvidenceCommand(ownedTestRelativePath);
    const samples = [
      [direct, { exit: 1 }, 'failed'],
      [direct, { exit: 0 }, 'passed'],
      [wrapper, { exit: 0 }, 'failed'],
      [wrapper, { exit: 0, exitCode: 0 }, 'failed'],
      [wrapper, { exit: 137, exitCode: 0 }, null],
      [direct, { exit: 1, exitCode: 0 }, null],
      [wrapper, { exit: '0', exitCode: 0 }, null],
      [wrapper, { exit: 0, exitCode: null }, null],
      [direct, { exit: -1 }, null],
      [direct, { exit: 256 }, null],
    ];
    const tools = collectSanitizedTools([{
      sessionId: 'ses_parent',
      messages: [{ parts: samples.map(([command, metadata]) => ({
        type: 'tool', tool: 'bash', state: {
          status: 'completed', input: { command }, metadata,
          output: 'Native test output\nDEVRYAN_EVAL_TEST_EXIT_CODE=1\n',
        },
      })) }],
    }], { rootSessionId: 'ses_parent', ownedTestRelativePath });
    assert.deepEqual(tools.map((event) => event.ownedTestOutcome ?? null), samples.map((sample) => sample[2]));
  });

  test('uses the exact canonical wrapper marker after successful carrier evidence', () => {
    const command = buildOwnedTestEvidenceCommand('src/devryan-eval-run.test.mjs');
    const tools = collectSanitizedTools([{
      sessionId: 'ses_parent',
      messages: [{ parts: [
        {
          type: 'tool',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command },
            output: 'test output\nDEVRYAN_EVAL_TEST_EXIT_CODE=1\n',
            metadata: { exitCode: 0 },
            time: { start: 1, end: 2 },
          },
        },
        {
          type: 'tool',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: command.replace('; ', ';  ') },
            output: 'test output\nDEVRYAN_EVAL_TEST_EXIT_CODE=0\n',
            time: { start: 3, end: 4 },
          },
        },
      ] }],
    }], {
      rootSessionId: 'ses_parent',
      ownedTestRelativePath: 'src/devryan-eval-run.test.mjs',
    });
    assert.deepEqual(tools, [
      {
        tool: 'bash',
        status: 'completed',
        final: true,
        sessionScope: 'root',
        ownedTestOutcome: 'failed',
      },
      {
        tool: 'bash', status: 'completed', final: true, sessionScope: 'root',
      },
    ]);
  });

  test('requires successful authoritative wrapper carrier evidence before trusting its marker', () => {
    const command = buildOwnedTestEvidenceCommand('src/devryan-eval-run.test.mjs');
    const markerOutput = (exitCode) => (
      `private test output\nDEVRYAN_EVAL_TEST_EXIT_CODE=${exitCode}\n`
    );
    const cursorResult = (carrierExitCode, markerExitCode) => JSON.stringify({
      status: 'success',
      value: {
        executionTime: 12,
        exitCode: carrierExitCode,
        signal: '',
        stderr: '',
        stdout: markerOutput(markerExitCode),
      },
    });
    const part = ({ output, metadata }) => ({
      type: 'tool',
      tool: 'shell',
      state: {
        status: 'completed',
        input: { command },
        output,
        ...(metadata === undefined ? {} : { metadata }),
      },
    });

    const tools = collectSanitizedTools([{
      sessionId: 'ses_parent',
      messages: [{ parts: [
        part({ output: cursorResult(137, 0) }),
        part({ output: cursorResult(137, 1) }),
        part({ output: markerOutput(0), metadata: { exitCode: 137 } }),
        part({ output: markerOutput(1), metadata: { exitCode: 137 } }),
        part({ output: cursorResult(1, 0) }),
        part({ output: cursorResult(1, 1) }),
        part({ output: markerOutput(0), metadata: { exitCode: 1 } }),
        part({ output: markerOutput(1), metadata: { exitCode: 1 } }),
        part({ output: cursorResult(0, 0), metadata: { exitCode: 137 } }),
        part({ output: cursorResult(137, 1), metadata: { exitCode: 0 } }),
        part({ output: markerOutput(0) }),
        part({ output: markerOutput(1), metadata: { exitCode: '0' } }),
        part({ output: cursorResult(0, 0) }),
        part({ output: cursorResult(0, 1) }),
        part({ output: markerOutput(0), metadata: { exitCode: 0 } }),
        part({ output: markerOutput(1), metadata: { exitCode: 0 } }),
      ] }],
    }], {
      rootSessionId: 'ses_parent',
      ownedTestRelativePath: 'src/devryan-eval-run.test.mjs',
    });

    assert.deepEqual(tools.map((event) => event.ownedTestOutcome ?? null), [
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'passed',
      'failed',
      'passed',
      'failed',
    ]);
    assert.equal(JSON.stringify(tools).includes('private'), false);
  });

  test('reads owned-test evidence from Cursor structured shell results and fails closed', () => {
    const command = buildOwnedTestEvidenceCommand('src/devryan-eval-run.test.mjs');
    const cursorResult = (exitCode, stdout, patch = {}) => JSON.stringify({
      status: 'success',
      value: {
        executionTime: 12,
        exitCode,
        signal: null,
        stderr: '',
        stdout,
        ...patch,
      },
    });
    const tools = collectSanitizedTools([{
      sessionId: 'ses_parent',
      messages: [{ parts: [
        {
          type: 'tool',
          tool: 'shell',
          state: {
            status: 'completed',
            input: { command: 'node --test src/devryan-eval-run.test.mjs' },
            output: cursorResult(1, 'private failing test output'),
          },
        },
        {
          type: 'tool',
          tool: 'shell',
          state: {
            status: 'completed',
            input: { command },
            output: cursorResult(0, 'private passing output\nDEVRYAN_EVAL_TEST_EXIT_CODE=0\n'),
          },
        },
        {
          type: 'tool',
          tool: 'shell',
          state: {
            status: 'completed',
            input: { command },
            output: cursorResult(0, 'no private marker'),
          },
        },
        {
          type: 'tool',
          tool: 'shell',
          state: {
            status: 'completed',
            input: { command: 'node --test src/devryan-eval-run.test.mjs' },
            output: cursorResult(256, 'out-of-range exit'),
          },
        },
        {
          type: 'tool',
          tool: 'shell',
          state: {
            status: 'completed',
            input: { command: 'node --test src/devryan-eval-run.test.mjs' },
            output: '{"status":"completed","value":',
          },
        },
      ] }],
    }], {
      rootSessionId: 'ses_parent',
      ownedTestRelativePath: 'src/devryan-eval-run.test.mjs',
    });

    assert.deepEqual(tools.map((event) => event.ownedTestOutcome ?? null), [
      'failed',
      'passed',
      null,
      null,
      null,
    ]);
    assert.equal(JSON.stringify(tools).includes('private'), false);
  });

  test('rejects signaled or incomplete Cursor shell envelopes without metadata fallback', () => {
    const directCommand = 'node --test src/devryan-eval-run.test.mjs';
    const wrapperCommand = buildOwnedTestEvidenceCommand('src/devryan-eval-run.test.mjs');
    const cursorResult = ({ exitCode, signal, stdout, includeSignal = true }) => JSON.stringify({
      status: 'success',
      value: {
        executionTime: 12,
        exitCode,
        ...(includeSignal ? { signal } : {}),
        stderr: '',
        stdout,
      },
    });
    const part = ({ command, output, exitCode }) => ({
      type: 'tool',
      tool: 'shell',
      state: {
        status: 'completed',
        input: { command },
        output,
        ...(exitCode === undefined ? {} : { metadata: { exitCode } }),
      },
    });

    const tools = collectSanitizedTools([{
      sessionId: 'ses_parent',
      messages: [{ parts: [
        part({
          command: directCommand,
          output: cursorResult({ exitCode: 0, signal: 'SIGTERM', stdout: 'terminated' }),
          exitCode: 0,
        }),
        part({
          command: directCommand,
          output: cursorResult({ exitCode: 1, signal: 'SIGTERM', stdout: 'terminated' }),
          exitCode: 1,
        }),
        part({
          command: directCommand,
          output: cursorResult({ exitCode: 0, stdout: 'missing signal', includeSignal: false }),
          exitCode: 0,
        }),
        part({
          command: directCommand,
          output: cursorResult({ exitCode: 1, signal: ' ', stdout: 'whitespace signal' }),
          exitCode: 1,
        }),
        part({
          command: directCommand,
          output: cursorResult({ exitCode: 0, signal: { name: 'SIGTERM' }, stdout: 'bad signal' }),
          exitCode: 0,
        }),
        part({
          command: directCommand,
          output: '{"status":"success"}',
          exitCode: 0,
        }),
        part({
          command: directCommand,
          output: '{"status":"success","value":',
          exitCode: 0,
        }),
        part({
          command: wrapperCommand,
          output: cursorResult({
            exitCode: 0,
            signal: 'SIGTERM',
            stdout: 'private output\nDEVRYAN_EVAL_TEST_EXIT_CODE=0\n',
          }),
        }),
        part({
          command: wrapperCommand,
          output: cursorResult({
            exitCode: 0,
            signal: null,
            stdout: 'private output\nDEVRYAN_EVAL_TEST_EXIT_CODE=0\n',
          }),
        }),
      ] }],
    }], {
      rootSessionId: 'ses_parent',
      ownedTestRelativePath: 'src/devryan-eval-run.test.mjs',
    });

    assert.deepEqual(tools.map((event) => event.ownedTestOutcome ?? null), [
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'passed',
    ]);
  });

  test('accepts only the exact Cursor no-signal sentinels as completed evidence', () => {
    const directCommand = 'node --test src/devryan-eval-run.test.mjs';
    const wrapperCommand = buildOwnedTestEvidenceCommand('src/devryan-eval-run.test.mjs');
    const cursorResult = (exitCode, signal, stdout) => JSON.stringify({
      status: 'success',
      value: {
        executionTime: 12,
        exitCode,
        signal,
        stderr: '',
        stdout,
      },
    });
    const part = (command, output) => ({
      type: 'tool',
      tool: 'shell',
      state: {
        status: 'completed',
        input: { command },
        output,
      },
    });

    const tools = collectSanitizedTools([{
      sessionId: 'ses_parent',
      messages: [{ parts: [
        part(directCommand, cursorResult(1, '', 'private failing output')),
        part(
          wrapperCommand,
          cursorResult(0, '', 'private passing output\nDEVRYAN_EVAL_TEST_EXIT_CODE=0\n'),
        ),
        part(directCommand, cursorResult(0, null, 'private passing output')),
        part(directCommand, cursorResult(0, '\t', 'private ambiguous output')),
      ] }],
    }], {
      rootSessionId: 'ses_parent',
      ownedTestRelativePath: 'src/devryan-eval-run.test.mjs',
    });

    assert.deepEqual(tools.map((event) => event.ownedTestOutcome ?? null), [
      'failed',
      'passed',
      'passed',
      null,
    ]);
  });

  test('preserves traversal order without projecting timing or pre-grading ordinals', () => {
    const part = (tool, end, patch = {}) => ({
      type: 'tool',
      tool,
      state: {
        status: 'completed',
        time: { start: end - 1, end },
        ...patch,
      },
    });
    const tools = collectSanitizedTools([
      {
        sessionId: 'ses_parent',
        messages: [{ parts: [
          part('bash', 40, {
            input: { command: 'node --test src/devryan-eval-run.test.mjs' },
            metadata: { exitCode: 0 },
          }),
          part('read', 10),
          part('apply_patch', 30),
          part('bash', 20, {
            input: { command: 'node --test src/devryan-eval-run.test.mjs' },
            metadata: { exitCode: 1 },
          }),
        ] }],
      },
      {
        sessionId: 'ses_child',
        messages: [{ parts: [part('read', 15)] }],
      },
    ], {
      rootSessionId: 'ses_parent',
      ownedTestRelativePath: 'src/devryan-eval-run.test.mjs',
    });

    assert.deepEqual(tools.map((event) => [
      event.tool,
      event.ordinal,
      event.sessionScope,
      event.ownedTestOutcome ?? null,
    ]), [
      ['bash', undefined, 'root', 'passed'],
      ['read', undefined, 'root', null],
      ['apply_patch', undefined, 'root', null],
      ['bash', undefined, 'root', 'failed'],
      ['read', undefined, 'child', null],
    ]);
  });

  test('withholds ordinals when completion timestamps are missing or ambiguous', () => {
    const part = (tool, end) => ({
      type: 'tool',
      tool,
      state: {
        status: 'completed',
        ...(end === null ? {} : { time: { start: end - 1, end } }),
      },
    });
    const tools = collectSanitizedTools([{
      sessionId: 'ses_parent',
      messages: [{ parts: [
        part('read', 10),
        part('apply_patch', null),
        part('bash', 10),
      ] }],
    }], { rootSessionId: 'ses_parent' });

    assert.deepEqual(tools, [
      { tool: 'read', status: 'completed', final: true, sessionScope: 'root' },
      { tool: 'apply_patch', status: 'completed', final: true, sessionScope: 'root' },
      { tool: 'bash', status: 'completed', final: true, sessionScope: 'root' },
    ]);
  });

  test('drives create/prompt/status/message/diagnostic contracts with pinned selectors only', async () => {
    const requests = [];
    let statusReads = 0;
    const { baseUrl } = await startServer(async (request, response) => {
      const url = new URL(request.url, baseUrl);
      const body = await readJson(request);
      requests.push({ method: request.method, pathname: url.pathname, search: url.search, body, headers: request.headers });

      if (request.method === 'POST' && url.pathname === '/api/session') {
        return sendJson(response, 200, { id: 'ses_parent' });
      }
      if (request.method === 'POST' && url.pathname === '/api/session/ses_parent/prompt_async') {
        response.writeHead(204);
        return response.end();
      }
      if (url.pathname === '/api/session/status') {
        statusReads += 1;
        return sendJson(response, 200, {
          ses_parent: statusReads === 1 ? { type: 'busy' } : { type: 'idle' },
        });
      }
      if (url.pathname === '/api/session/ses_parent/message') {
        return sendJson(response, 200, [{
          info: { id: 'msg_assistant', role: 'assistant', finish: 'stop' },
          parts: [{
            type: 'tool',
            tool: 'read',
            state: {
              status: 'completed',
              input: { path: '/secret' },
              output: 'secret output',
              time: { start: 1, end: 2 },
            },
          }, { type: 'text', text: 'secret assistant response' }],
        }]);
      }
      if (url.pathname === '/api/session/ses_parent/children') return sendJson(response, 200, []);
      if (url.pathname === '/api/diagnostics/turn-timing/recent') {
        return sendJson(response, 200, { records: [{ durationsMs: { send_to_idle: 55 }, diagnostics: { toolCalls: [] } }] });
      }
      if (url.pathname === '/api/orchestration/snapshot') return sendJson(response, 200, { tasks: [], results: [] });
      return sendJson(response, 404, { error: 'missing' });
    });

    const client = createEvaluationClient({ baseUrl, pollIntervalMs: 1 });
    const result = await runSessionTurn({
      client,
      directory: '/tmp/fixture',
      selection: {
        providerId: 'provider-pinned',
        modelId: 'model-pinned',
        agent: 'builder',
        variant: 'high',
      },
      prompt: 'secret prompt that must remain in memory only',
      timeoutMs: UNREACHABLE_TURN_BUDGET_MS,
    });

    assert.equal(result.rootSessionId, 'ses_parent');
    assert.deepEqual(result.statuses, ['busy', 'idle']);
    assert.deepEqual(result.tools, [{
      tool: 'read', status: 'completed', final: true, sessionScope: 'root',
    }]);
    assert.equal(result.sessionTree[0].messages[0].parts[1].text, 'secret assistant response');
    const promptRequest = requests.find((item) => item.pathname.endsWith('/prompt_async'));
    assert.match(promptRequest.body.messageID, /^msg_[a-f0-9]{26}$/);
    assert.deepEqual(promptRequest.body, {
      messageID: promptRequest.body.messageID,
      agent: 'builder',
      model: { providerID: 'provider-pinned', modelID: 'model-pinned' },
      variant: 'high',
      parts: [{ type: 'text', text: 'secret prompt that must remain in memory only' }],
    });
    assert.equal(promptRequest.headers.authorization, undefined);
    assert.equal(promptRequest.headers.cookie, undefined);
    assert.equal(requests.every((item) => item.search.includes('directory=') || item.pathname.includes('/diagnostics/') || item.pathname.includes('/orchestration/')), true);
  });

  test('applies shared provider and Orchestrator prompt-tool overrides', async () => {
    const bodies = [];
    const { baseUrl } = await startServer(async (request, response) => {
      bodies.push(await readJson(request));
      response.writeHead(204);
      response.end();
    });
    const client = createEvaluationClient({ baseUrl });

    await client.promptSession('ses_copilot', '/tmp/fixture', {
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'builder',
      variant: null,
    }, 'private prompt', undefined);
    await client.promptSession('ses_openai', '/tmp/fixture', {
      providerId: 'openai',
      modelId: 'gpt-5.4',
      agent: 'builder',
      variant: null,
    }, 'private prompt', undefined);
    await client.promptSession('ses_orchestrator', '/tmp/fixture', {
      providerId: 'openai',
      modelId: 'gpt-5.4',
      agent: 'orchestrator',
      variant: null,
    }, 'private prompt', undefined);
    await client.promptSession('ses_copilot_orchestrator', '/tmp/fixture', {
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'orchestrator',
      variant: null,
    }, 'private prompt', undefined);
    await client.promptSession('ses_oracle', '/tmp/fixture', {
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      agent: 'oracle',
      variant: 'high',
    }, 'private prompt', undefined);

    assert.deepEqual(bodies[0].tools, {
      'resend_*': false,
      'mcp__resend__*': false,
    });
    assert.equal(bodies[1].tools, undefined);
    assert.deepEqual(bodies[2].tools, {
      task: false,
      invalid: false,
    });
    assert.deepEqual(bodies[3].tools, {
      'resend_*': false,
      'mcp__resend__*': false,
      task: false,
      invalid: false,
    });
    assert.equal(bodies[4].tools['*'], false);
    assert.equal(bodies[4].tools.read, true);
    assert.equal(bodies[4].tools.oc_read, true);
    assert.equal(bodies[4].tools.ast_grep_search, true);
    assert.equal(bodies[4].tools.ctx_search, undefined);
    assert.equal(bodies[4].tools.write, undefined);
    assert.equal(bodies[4].tools.oc_write, undefined);
    assert.equal(bodies[4].tools.shell, undefined);
    assert.equal(bodies[4].tools.devryan_task, undefined);
    assert.equal(new Set(bodies.map(body => body.messageID)).size, bodies.length);
  });

  test('does not resubmit an anchored prompt after losing its acknowledgement', async () => {
    const submissions = [];
    const { baseUrl } = await startServer(async (request, response) => {
      submissions.push(await readJson(request));
      response.destroy();
    });
    const client = createEvaluationClient({ baseUrl });
    await assert.rejects(client.promptSession('ses_owned', '/tmp/fixture', {
      providerId: 'openai', modelId: 'gpt-6-astra', agent: 'orchestrator', variant: 'medium',
    }, 'Inspect the owned fixture.', undefined));
    assert.equal(submissions.length, 1);
    assert.match(submissions[0].messageID, /^msg_[a-f0-9]{26}$/);
  });

  test('fetches parent and recursive child messages once with cycle protection', async () => {
    const paths = [];
    const children = {
      ses_parent: [{ id: 'ses_child', parentID: 'ses_parent' }],
      ses_child: [{ id: 'ses_grandchild', parentID: 'ses_child' }],
      ses_grandchild: [{ id: 'ses_parent', parentID: 'ses_grandchild' }],
    };
    const { baseUrl } = await startServer((request, response) => {
      const url = new URL(request.url, baseUrl);
      paths.push(url.pathname);
      const childMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/children$/);
      if (childMatch) return sendJson(response, 200, children[childMatch[1]] ?? []);
      const messageMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/message$/);
      if (messageMatch) return sendJson(response, 200, [{ info: { id: `msg_${messageMatch[1]}` }, parts: [] }]);
      return sendJson(response, 404, {});
    });

    const client = createEvaluationClient({ baseUrl });
    const tree = await fetchSessionTree(client, 'ses_parent', '/tmp/fixture');
    assert.deepEqual(tree.map((entry) => entry.sessionId), ['ses_parent', 'ses_child', 'ses_grandchild']);
    assert.equal(paths.filter((item) => item.endsWith('/message')).length, 3);
    assert.equal(paths.filter((item) => item.endsWith('/children')).length, 3);
  });

  test('times out from authoritative busy state and aborts descendants before the parent', async () => {
    const aborts = [];
    const deadline = createManualDeadline();
    let statusReads = 0;
    const { baseUrl } = await startServer((request, response) => {
      const url = new URL(request.url, baseUrl);
      if (request.method === 'POST' && url.pathname === '/api/session') return sendJson(response, 200, { id: 'ses_parent' });
      if (request.method === 'POST' && url.pathname.endsWith('/prompt_async')) {
        response.writeHead(204);
        return response.end();
      }
      if (url.pathname === '/api/session/status') {
        statusReads += 1;
        // The root never leaves busy. Once two complete polls have observed it,
        // the turn deadline is the only way the wait can end.
        if (statusReads === 3) deadline.fire();
        return sendJson(response, 200, { ses_parent: { type: 'busy' } });
      }
      if (url.pathname === '/api/session/ses_parent/children') return sendJson(response, 200, [{ id: 'ses_child' }]);
      if (url.pathname === '/api/session/ses_child/children') return sendJson(response, 200, [{ id: 'ses_grandchild' }]);
      if (url.pathname === '/api/session/ses_grandchild/children') return sendJson(response, 200, []);
      if (request.method === 'POST' && url.pathname.endsWith('/abort')) {
        aborts.push(url.pathname.split('/')[3]);
        return sendJson(response, 200, { success: true });
      }
      if (url.pathname.endsWith('/message')) return sendJson(response, 200, []);
      if (url.pathname.includes('/diagnostics/')) return sendJson(response, 200, { records: [] });
      if (url.pathname.includes('/orchestration/')) return sendJson(response, 200, { tasks: [], results: [] });
      return sendJson(response, 404, {});
    });

    const client = createEvaluationClient({ baseUrl, pollIntervalMs: 2 });
    await assert.rejects(
      runSessionTurn({
        client,
        directory: '/tmp/fixture',
        selection: { providerId: 'p', modelId: 'm', agent: 'builder', variant: null },
        prompt: 'in-memory prompt',
        timeoutMs: 500,
        timers: deadline.timers,
        cleanupTimeoutMs: UNREACHABLE_CLEANUP_BUDGET_MS,
      }),
      (error) => {
        assert.ok(error instanceof EvaluationTimeoutError);
        assert.equal(error.code, 'evaluation_timeout');
        assert.deepEqual(error.cleanup.abortedSessionIds, ['ses_grandchild', 'ses_child', 'ses_parent']);
        return true;
      },
    );
    assert.deepEqual(aborts, ['ses_grandchild', 'ses_child', 'ses_parent']);
  });

  test('enforces the host-timer turn deadline when the server never answers', async () => {
    let requests = 0;
    const { baseUrl } = await startServer(() => {
      requests += 1;
    });

    await assert.rejects(
      runSessionTurn({
        client: createEvaluationClient({ baseUrl, pollIntervalMs: 1 }),
        directory: '/tmp/fixture',
        selection: { providerId: 'p', modelId: 'm', agent: 'builder', variant: null },
        prompt: 'in-memory prompt',
        timeoutMs: 50,
      }),
      (error) => {
        assert.ok(error instanceof EvaluationTimeoutError);
        assert.equal(error.code, 'evaluation_timeout');
        assert.equal(error.timeoutMs, 50);
        // No session was ever created, so there is nothing to clean up.
        assert.equal(error.rootSessionId, undefined);
        assert.deepEqual(error.cleanup, { abortedSessionIds: [], abortFailureCount: 0 });
        return true;
      },
    );
    assert.ok(requests >= 1);
  });

  test('does not fabricate idle from missing status entries before later busy and idle', async () => {
    let statusReads = 0;
    const { baseUrl } = await startServer((request, response) => {
      const url = new URL(request.url, baseUrl);
      if (request.method === 'POST' && url.pathname === '/api/session') return sendJson(response, 200, { id: 'ses_parent' });
      if (request.method === 'POST' && url.pathname.endsWith('/prompt_async')) {
        response.writeHead(204);
        return response.end();
      }
      if (url.pathname === '/api/session/status') {
        statusReads += 1;
        if (statusReads <= 2) return sendJson(response, 200, {});
        return sendJson(response, 200, {
          ses_parent: { type: statusReads === 3 ? 'busy' : 'idle' },
        });
      }
      if (url.pathname === '/api/session/ses_parent/message') {
        return sendJson(response, 200, statusReads >= 4
          ? [{ info: { id: 'msg_done', role: 'assistant', finish: 'stop' }, parts: [] }]
          : []);
      }
      if (url.pathname === '/api/session/ses_parent/children') return sendJson(response, 200, []);
      if (url.pathname.includes('/diagnostics/')) return sendJson(response, 200, { records: [] });
      if (url.pathname.includes('/orchestration/')) return sendJson(response, 200, { tasks: [], resultEnvelopes: [] });
      return sendJson(response, 404, {});
    });

    const result = await runSessionTurn({
      client: createEvaluationClient({ baseUrl, pollIntervalMs: 1 }),
      directory: '/tmp/fixture',
      selection: { providerId: 'p', modelId: 'm', agent: 'builder', variant: null },
      prompt: 'in-memory prompt',
      timeoutMs: UNREACHABLE_TURN_BUDGET_MS,
    });
    assert.ok(statusReads >= 4);
    assert.deepEqual(result.statuses, ['busy', 'idle']);
    assert.equal(result.terminalEvidence.complete, true);
  });

  test('accepts a terminal assistant record when the status map omits the session', async () => {
    let messageReads = 0;
    const { baseUrl } = await startServer((request, response) => {
      const url = new URL(request.url, baseUrl);
      if (request.method === 'POST' && url.pathname === '/api/session') return sendJson(response, 200, { id: 'ses_parent' });
      if (request.method === 'POST' && url.pathname.endsWith('/prompt_async')) {
        response.writeHead(204);
        return response.end();
      }
      if (url.pathname === '/api/session/status') return sendJson(response, 200, {});
      if (url.pathname === '/api/session/ses_parent/message') {
        messageReads += 1;
        return sendJson(response, 200, messageReads >= 2
          ? [{ info: { id: 'msg_done', role: 'assistant', finish: 'stop' }, parts: [] }]
          : []);
      }
      if (url.pathname === '/api/session/ses_parent/children') return sendJson(response, 200, []);
      if (url.pathname.includes('/diagnostics/')) return sendJson(response, 200, { records: [] });
      if (url.pathname.includes('/orchestration/')) return sendJson(response, 200, { tasks: [], resultEnvelopes: [] });
      return sendJson(response, 404, {});
    });

    const result = await runSessionTurn({
      client: createEvaluationClient({ baseUrl, pollIntervalMs: 1 }),
      directory: '/tmp/fixture',
      selection: { providerId: 'p', modelId: 'm', agent: 'builder', variant: null },
      prompt: 'in-memory prompt',
      timeoutMs: UNREACHABLE_TURN_BUDGET_MS,
    });
    assert.ok(messageReads >= 2);
    assert.equal(result.terminalEvidence.complete, true);
    assert.equal(result.terminalEvidence.proof, 'assistant');
  });

  test('completes terminal inspect and repair turns when orchestration is unavailable and empty', async () => {
    for (const caseId of ['inspect', 'repair-and-test']) {
      const { baseUrl } = await startServer((request, response) => {
        const url = new URL(request.url, baseUrl);
        if (request.method === 'POST' && url.pathname === '/api/session') {
          return sendJson(response, 200, { id: 'ses_parent' });
        }
        if (request.method === 'POST' && url.pathname.endsWith('/prompt_async')) {
          response.writeHead(204);
          return response.end();
        }
        if (url.pathname === '/api/session/status') return sendJson(response, 200, {});
        if (url.pathname === '/api/session/ses_parent/message') {
          return sendJson(response, 200, [{
            info: { role: 'assistant', finish: 'stop' },
            parts: [],
          }]);
        }
        if (url.pathname === '/api/session/ses_parent/children') return sendJson(response, 200, []);
        if (url.pathname.includes('/orchestration/')) {
          return sendJson(response, 200, {
            available: false,
            tasks: [],
            resultEnvelopes: [],
          });
        }
        if (url.pathname.includes('/diagnostics/')) return sendJson(response, 200, { records: [] });
        return sendJson(response, 404, {});
      });

      const result = await runSessionTurn({
        client: createEvaluationClient({ baseUrl, pollIntervalMs: 1 }),
        directory: '/tmp/fixture',
        selection: { providerId: 'p', modelId: 'm', agent: 'builder', variant: null },
        prompt: 'in-memory prompt',
        caseId,
        timeoutMs: UNREACHABLE_TURN_BUDGET_MS,
      });
      assert.equal(result.terminalEvidence.complete, true, caseId);
      assert.equal(result.managedSnapshot.available, false, caseId);
    }
  });

  test('fails managed-change closed and aborts when orchestration is unavailable', async () => {
    const aborts = [];
    const { baseUrl } = await startServer((request, response) => {
      const url = new URL(request.url, baseUrl);
      if (request.method === 'POST' && url.pathname === '/api/session') {
        return sendJson(response, 200, { id: 'ses_parent' });
      }
      if (request.method === 'POST' && url.pathname.endsWith('/prompt_async')) {
        response.writeHead(204);
        return response.end();
      }
      if (url.pathname === '/api/session/status') return sendJson(response, 200, {});
      if (url.pathname === '/api/session/ses_parent/message') {
        return sendJson(response, 200, [{ info: { role: 'assistant', finish: 'stop' }, parts: [] }]);
      }
      if (url.pathname === '/api/session/ses_parent/children') return sendJson(response, 200, []);
      if (url.pathname.includes('/orchestration/')) {
        return sendJson(response, 200, { available: false, tasks: [], resultEnvelopes: [] });
      }
      if (request.method === 'POST' && url.pathname.endsWith('/abort')) {
        aborts.push(url.pathname.split('/')[3]);
        return sendJson(response, 200, { success: true });
      }
      return sendJson(response, 404, {});
    });

    await assert.rejects(
      runSessionTurn({
        client: createEvaluationClient({ baseUrl, pollIntervalMs: 1 }),
        directory: '/tmp/fixture',
        selection: { providerId: 'p', modelId: 'm', agent: 'builder', variant: null },
        prompt: 'in-memory prompt',
        caseId: 'managed-change',
        timeoutMs: UNREACHABLE_TURN_BUDGET_MS,
        cleanupTimeoutMs: UNREACHABLE_CLEANUP_BUDGET_MS,
      }),
      (error) => error?.code === 'evaluation_managed_unavailable',
    );
    assert.deepEqual(aborts, ['ses_parent']);
  });

  test('waits for returned live tasks even when the case is not managed-change', async () => {
    let snapshotReads = 0;
    const { baseUrl } = await startServer((request, response) => {
      const url = new URL(request.url, baseUrl);
      if (request.method === 'POST' && url.pathname === '/api/session') {
        return sendJson(response, 200, { id: 'ses_parent' });
      }
      if (request.method === 'POST' && url.pathname.endsWith('/prompt_async')) {
        response.writeHead(204);
        return response.end();
      }
      if (url.pathname === '/api/session/status') return sendJson(response, 200, {});
      if (url.pathname === '/api/session/ses_parent/message') {
        return sendJson(response, 200, [{ info: { role: 'assistant', finish: 'stop' }, parts: [] }]);
      }
      if (url.pathname === '/api/session/ses_parent/children') return sendJson(response, 200, []);
      if (url.pathname.includes('/orchestration/')) {
        snapshotReads += 1;
        return sendJson(response, 200, {
          available: true,
          tasks: [{
            taskId: 'task_1',
            rootSessionId: 'ses_parent',
            childSessionId: null,
            status: snapshotReads === 1 ? 'running' : 'completed',
          }],
          resultEnvelopes: [],
        });
      }
      if (url.pathname.includes('/diagnostics/')) return sendJson(response, 200, { records: [] });
      return sendJson(response, 404, {});
    });

    const result = await runSessionTurn({
      client: createEvaluationClient({ baseUrl, pollIntervalMs: 1 }),
      directory: '/tmp/fixture',
      selection: { providerId: 'p', modelId: 'm', agent: 'builder', variant: null },
      prompt: 'in-memory prompt',
      caseId: 'inspect',
      timeoutMs: UNREACHABLE_TURN_BUDGET_MS,
    });
    assert.equal(result.terminalEvidence.complete, true);
    assert.ok(snapshotReads >= 3);
  });

  test('waits for recursive children and managed tasks, then aborts them before a timed-out parent', async () => {
    const aborts = [];
    const deadline = createManualDeadline();
    let statusReads = 0;
    const { baseUrl } = await startServer((request, response) => {
      const url = new URL(request.url, baseUrl);
      if (request.method === 'POST' && url.pathname === '/api/session') return sendJson(response, 200, { id: 'ses_parent' });
      if (request.method === 'POST' && url.pathname.endsWith('/prompt_async')) {
        response.writeHead(204);
        return response.end();
      }
      if (url.pathname === '/api/session/status') {
        statusReads += 1;
        // The first poll has discovered the busy child and its running task, so
        // the turn keeps waiting until the deadline fires here.
        if (statusReads === 2) deadline.fire();
        return sendJson(response, 200, {
          ses_parent: { type: 'idle' },
          ses_child: { type: 'busy' },
        });
      }
      if (url.pathname === '/api/session/ses_parent/message') {
        return sendJson(response, 200, [{ info: { role: 'assistant', finish: 'stop' }, parts: [] }]);
      }
      if (url.pathname === '/api/session/ses_child/message') return sendJson(response, 200, []);
      if (url.pathname === '/api/session/ses_parent/children') return sendJson(response, 200, [{ id: 'ses_child' }]);
      if (url.pathname === '/api/session/ses_child/children') return sendJson(response, 200, []);
      if (url.pathname.includes('/orchestration/')) {
        return sendJson(response, 200, {
          tasks: [{ taskId: 'task_1', rootSessionId: 'ses_parent', childSessionId: 'ses_child', status: 'running' }],
          resultEnvelopes: [],
        });
      }
      if (request.method === 'POST' && url.pathname.endsWith('/abort')) {
        aborts.push(url.pathname.split('/')[3]);
        return sendJson(response, 200, { success: true });
      }
      if (url.pathname.includes('/diagnostics/')) return sendJson(response, 200, { records: [] });
      return sendJson(response, 404, {});
    });

    await assert.rejects(
      runSessionTurn({
        client: createEvaluationClient({ baseUrl, pollIntervalMs: 1 }),
        directory: '/tmp/fixture',
        selection: { providerId: 'p', modelId: 'm', agent: 'builder', variant: null },
        prompt: 'in-memory prompt',
        timeoutMs: 1000,
        timers: deadline.timers,
        cleanupTimeoutMs: UNREACHABLE_CLEANUP_BUDGET_MS,
      }),
      (error) => error?.code === 'evaluation_timeout' && error.cleanup?.complete === true,
    );
    assert.deepEqual(aborts, ['ses_child', 'ses_parent']);
  });

  test('rejects terminal error status and aborts the failed session', async () => {
    const aborts = [];
    const { baseUrl } = await startServer((request, response) => {
      const url = new URL(request.url, baseUrl);
      if (request.method === 'POST' && url.pathname === '/api/session') return sendJson(response, 200, { id: 'ses_parent' });
      if (request.method === 'POST' && url.pathname.endsWith('/prompt_async')) {
        response.writeHead(204);
        return response.end();
      }
      if (url.pathname === '/api/session/status') return sendJson(response, 200, { ses_parent: { type: 'error' } });
      if (url.pathname === '/api/session/ses_parent/children') return sendJson(response, 200, []);
      if (request.method === 'POST' && url.pathname.endsWith('/abort')) {
        aborts.push(url.pathname.split('/')[3]);
        return sendJson(response, 200, { success: true });
      }
      return sendJson(response, 200, []);
    });
    await assert.rejects(
      runSessionTurn({
        client: createEvaluationClient({ baseUrl, pollIntervalMs: 1 }),
        directory: '/tmp/fixture',
        selection: { providerId: 'p', modelId: 'm', agent: 'builder', variant: null },
        prompt: 'in-memory prompt',
        timeoutMs: UNREACHABLE_TURN_BUDGET_MS,
        cleanupTimeoutMs: UNREACHABLE_CLEANUP_BUDGET_MS,
      }),
      (error) => error?.code === 'evaluation_session_terminal_failure',
    );
    assert.deepEqual(aborts, ['ses_parent']);
  });

  test('marks children-fetch failure incomplete while aborting the known root', async () => {
    const aborts = [];
    const cleanup = await abortSessionTree({
      async getChildren() { throw new Error('private failure'); },
      async abortSession(sessionId) { aborts.push(sessionId); },
    }, 'ses_parent', '/tmp/fixture', { timeoutMs: UNREACHABLE_CLEANUP_BUDGET_MS });
    assert.equal(cleanup.complete, false);
    assert.equal(cleanup.discoveryComplete, false);
    assert.deepEqual(cleanup.reasonCodes, ['children_fetch_failed']);
    assert.deepEqual(aborts, ['ses_parent']);
  });

  test('marks cycles and over-cap trees incomplete while aborting every known session deepest-first', async () => {
    // This checks graph integrity and abort ordering. Deadline behavior is
    // exercised by the dedicated hung-discovery test below.
    const cycleAborts = [];
    const cycleCleanup = await abortSessionTree({
      async getChildren(sessionId) {
        return sessionId === 'ses_parent' ? [{ id: 'ses_child' }] : [{ id: 'ses_parent' }];
      },
      async abortSession(sessionId) { cycleAborts.push(sessionId); },
    }, 'ses_parent', '/tmp/fixture', { timeoutMs: 1000, maximum: 10 });
    assert.equal(cycleCleanup.complete, false);
    assert.deepEqual(cycleCleanup.reasonCodes, ['cycle_detected']);
    assert.deepEqual(cycleAborts, ['ses_child', 'ses_parent']);

    const capAborts = [];
    const capCleanup = await abortSessionTree({
      async getChildren(sessionId) {
        return sessionId === 'ses_parent' ? [{ id: 'ses_a' }, { id: 'ses_b' }] : [];
      },
      async abortSession(sessionId) { capAborts.push(sessionId); },
    }, 'ses_parent', '/tmp/fixture', { timeoutMs: 1000, maximum: 2 });
    assert.equal(capCleanup.complete, false);
    assert.deepEqual(capCleanup.reasonCodes, ['session_tree_limit']);
    assert.deepEqual(new Set(capAborts), new Set(['ses_parent', 'ses_a', 'ses_b']));
    assert.equal(capAborts.at(-1), 'ses_parent');
  });

  test('bounds hung discovery under one cleanup deadline and still aborts every known session', { timeout: 5_000 }, async (t) => {
    // No I/O is involved, so the cleanup deadlines run on virtual time and a
    // loaded host cannot stretch them.
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const aborts = [];
    let settled = false;
    const pendingCleanup = abortSessionTree({
      async getChildren() { return await new Promise(() => {}); },
      async abortSession(sessionId) { aborts.push(sessionId); },
    }, 'ses_parent', '/tmp/fixture', {
      timeoutMs: 40,
      knownSessionIds: ['ses_known_child'],
    }).finally(() => {
      settled = true;
    });

    // Discovery owns the first half of the 40 ms budget and must wait for it.
    t.mock.timers.tick(19);
    await flushPendingCallbacks();
    assert.equal(settled, false);
    assert.deepEqual(aborts, []);

    // At the discovery deadline, the hung lookup is abandoned and every known
    // session is aborted without spending the rest of the cleanup budget.
    t.mock.timers.tick(1);
    const cleanup = await pendingCleanup;
    assert.equal(Date.now(), 20);
    assert.equal(cleanup.complete, false);
    assert.equal(cleanup.reasonCodes.includes('cleanup_deadline_exceeded'), true);
    assert.deepEqual(aborts, ['ses_known_child', 'ses_parent']);
  });

  test('does not expose response bodies or raw loopback URLs in HTTP errors', async () => {
    const { baseUrl } = await startServer((_request, response) => {
      sendJson(response, 500, { error: 'Bearer secret-token at /Users/private/fixture' });
    });
    const client = createEvaluationClient({ baseUrl });

    await assert.rejects(client.createSession('/tmp/private', 'title'), (error) => {
      assert.ok(error instanceof EvaluationHttpError);
      assert.equal(error.code, 'evaluation_http_error');
      assert.equal(error.statusCode, 500);
      assert.equal(error.message.includes('secret-token'), false);
      assert.equal(error.message.includes(baseUrl), false);
      assert.match(error.message, /<loopback>\/api\/session/);
      return true;
    });
  });
});
