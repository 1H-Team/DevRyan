import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  collectGapPaths,
  collectJournalPaths,
  formatJournalRows,
  formatSessionSummary,
  listJournalRows,
  parseShowFilters,
  parseSummaryOptions,
  readRecordsFromPaths,
  recordMatches,
  resolveJournalDirectory,
  sampleStats,
  summarizeSessionTree,
} from './journal.mjs';

const journalScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'journal.mjs');

const temporaryDirectories = [];

const temporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-journal-cli-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});
describe('journal CLI helpers', () => {
  test('resolves the configured data root and explicit journal override', () => {
    assert.equal(
      resolveJournalDirectory({ argv: [], env: { DEVRYAN_DATA_DIR: '/data' }, homeDir: '/home' }),
      path.join('/data', 'harness', 'journal'),
    );
    assert.equal(
      resolveJournalDirectory({ argv: ['list', '--dir', '/journal'], env: {}, homeDir: '/home' }),
      '/journal',
    );
  });

  test('lists session, runtime, and legacy rows from manifests', async () => {
    const directory = await temporaryDirectory();
    await fs.mkdir(path.join(directory, 'sessions/ses_1'), { recursive: true });
    await fs.writeFile(path.join(directory, 'sessions/ses_1/manifest.json'), JSON.stringify({
      sessionID: 'ses_1',
      title: 'Example',
      lastAt: 10,
      bytes: 1024,
      gapCount: 2,
      recordCounts: { prompt: 3 },
    }));
    await fs.mkdir(path.join(directory, 'runtime'), { recursive: true });
    await fs.writeFile(path.join(directory, 'runtime/manifest.json'), JSON.stringify({
      lastAt: 9,
      bytes: 10,
      recordCounts: { log: 1 },
    }));
    await fs.writeFile(path.join(directory, '8-000001.ndjson'), '{}\n');

    const rows = await listJournalRows(directory);
    assert.deepEqual(rows.map((row) => row.id), ['ses_1', 'runtime', 'legacy']);
    assert.match(formatJournalRows(rows), /Example/);
  });

  test('reads mixed gzip and open chunks and applies show filters', async () => {
    const directory = await temporaryDirectory();
    const bucket = path.join(directory, 'sessions/ses_1');
    await fs.mkdir(bucket, { recursive: true });
    await fs.writeFile(
      path.join(bucket, '000001.ndjson.gz'),
      gzipSync('{"type":"prompt","at":1,"sessionID":"ses_1"}\n'),
    );
    await fs.writeFile(
      path.join(bucket, '000002.ndjson.open'),
      '{"type":"open_code_event","at":2,"sessionID":"ses_1","payload":{"type":"session.updated"}}\n',
    );
    const paths = await collectJournalPaths(directory);
    const records = [];
    for await (const record of readRecordsFromPaths(paths)) records.push(record);
    assert.equal(records.length, 2);
    const filters = parseShowFilters(['--event', 'session.updated', '--since', '2', '--tail', '1']);
    assert.equal(recordMatches(records[0], filters), false);
    assert.equal(recordMatches(records[1], filters), true);
  });

  test('uses manifests to skip verified zero-gap buckets unless verification is requested', async () => {
    const directory = await temporaryDirectory();
    const zeroGapBucket = path.join(directory, 'sessions/zero');
    const positiveGapBucket = path.join(directory, 'sessions/positive');
    const unknownBucket = path.join(directory, 'sessions/unknown');
    const runtimeBucket = path.join(directory, 'runtime');
    await Promise.all([
      fs.mkdir(zeroGapBucket, { recursive: true }),
      fs.mkdir(positiveGapBucket, { recursive: true }),
      fs.mkdir(unknownBucket, { recursive: true }),
      fs.mkdir(runtimeBucket, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(zeroGapBucket, 'manifest.json'), JSON.stringify({ gapCount: 0 })),
      fs.writeFile(path.join(positiveGapBucket, 'manifest.json'), JSON.stringify({ gapCount: 1 })),
      fs.writeFile(path.join(runtimeBucket, 'manifest.json'), JSON.stringify({ gapCount: 0 })),
      fs.writeFile(path.join(zeroGapBucket, '000001.ndjson.open'), '{"type":"gap"}\n'),
      fs.writeFile(path.join(positiveGapBucket, '000001.ndjson.open'), '{"type":"gap"}\n'),
      fs.writeFile(path.join(unknownBucket, '000001.ndjson.open'), '{"type":"gap"}\n'),
      fs.writeFile(path.join(runtimeBucket, '000001.ndjson.open'), '{"type":"gap"}\n'),
      fs.writeFile(path.join(directory, '1-000001.ndjson'), '{"type":"gap"}\n'),
    ]);

    const fastPaths = (await collectGapPaths(directory)).map((filePath) => path.relative(directory, filePath));
    assert.deepEqual(fastPaths, [
      '1-000001.ndjson',
      path.join('sessions', 'positive', '000001.ndjson.open'),
      path.join('sessions', 'unknown', '000001.ndjson.open'),
    ]);

    const verifiedPaths = (await collectGapPaths(directory, { verify: true }))
      .map((filePath) => path.relative(directory, filePath));
    assert.deepEqual(verifiedPaths, [
      '1-000001.ndjson',
      path.join('sessions', 'positive', '000001.ndjson.open'),
      path.join('sessions', 'unknown', '000001.ndjson.open'),
      path.join('sessions', 'zero', '000001.ndjson.open'),
      path.join('runtime', '000001.ndjson.open'),
    ]);
  });
});

const T0 = Date.UTC(2026, 9, 22, 10, 0, 0);
const event = (at, sessionID, type, properties) => ({
  type: 'open_code_event', at, runtime: 'test', sessionID, payload: { type, properties: { sessionID, ...properties } },
});
const assistant = (at, sessionID, id, { agent, providerID, modelID, tokens, cost, created, completed }) => event(at, sessionID, 'message.updated', {
  info: { id, sessionID, role: 'assistant', agent, providerID, modelID, tokens, cost, time: { created, completed } },
});
const toolPart = (at, sessionID, callID, tool, state) => event(at, sessionID, 'message.part.updated', {
  part: { id: `prt_${callID}`, sessionID, messageID: 'msg_x', type: 'tool', callID, tool, state },
});

// Root → child (manifest relation) → grandchild (no manifest: relation read from
// session.created), plus an unrelated session that must stay out of the summary.
const writeSummaryFixture = async (directory) => {
  const bucket = async (name, manifest, records, { gzip = false } = {}) => {
    const bucketDirectory = path.join(directory, 'sessions', name);
    await fs.mkdir(bucketDirectory, { recursive: true });
    if (manifest) await fs.writeFile(path.join(bucketDirectory, 'manifest.json'), JSON.stringify(manifest));
    const body = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
    if (gzip) await fs.writeFile(path.join(bucketDirectory, '000001.ndjson.gz'), gzipSync(body));
    else await fs.writeFile(path.join(bucketDirectory, '000001.ndjson.open'), body);
  };
  await bucket('ses_root', { sessionID: 'ses_root', parentID: null, title: 'Root task', firstAt: T0, gapCount: 1 }, [
    event(T0, 'ses_root', 'session.created', { info: { id: 'ses_root', title: 'Root task', time: { created: T0 } } }),
    event(T0 + 100, 'ses_root', 'message.updated', {
      info: { id: 'msg_user', sessionID: 'ses_root', role: 'user', agent: 'orchestrator', model: { providerID: 'openai', modelID: 'gpt-x' } },
    }),
    assistant(T0 + 5_000, 'ses_root', 'msg_a1', { agent: 'orchestrator', providerID: 'openai', modelID: 'gpt-x',
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 0 } }, cost: 0.01, created: T0 + 1_000, completed: T0 + 5_000 }),
    // Last write wins for a coalesced message.
    assistant(T0 + 9_000, 'ses_root', 'msg_a1', { agent: 'orchestrator', providerID: 'openai', modelID: 'gpt-x',
      tokens: { input: 200, output: 40, reasoning: 10, cache: { read: 600, write: 200 } }, cost: 0.02, created: T0 + 1_000, completed: T0 + 9_000 }),
    toolPart(T0 + 2_000, 'ses_root', 'call_1', 'read', { status: 'running', time: { start: T0 + 1_500 } }),
    toolPart(T0 + 3_000, 'ses_root', 'call_1', 'read', { status: 'completed', time: { start: T0 + 1_500, end: T0 + 2_500 } }),
    toolPart(T0 + 3_100, 'ses_root', 'call_1', 'read', { status: 'completed', time: { start: T0 + 1_500, end: T0 + 2_500 } }),
    toolPart(T0 + 4_000, 'ses_root', 'call_2', 'read', { status: 'completed', time: { start: T0 + 3_000, end: T0 + 6_000 } }),
    toolPart(T0 + 4_500, 'ses_root', 'call_3', 'bash', { status: 'error', error: 'Tool execution\ninterrupted', time: { start: T0 + 4_000, end: T0 + 4_400 } }),
    toolPart(T0 + 4_600, 'ses_root', 'call_4', 'bash', { status: 'running', time: { start: T0 + 4_600 } }),
    { type: 'lifecycle', at: T0 + 1_200, runtime: 'test', event: 'session_execution', sessionID: 'ses_root',
      payload: { phase: 'ledger_lock', state: 'completed', elapsedMs: 300, action: 'reserve', slow: true } },
    { type: 'lifecycle', at: T0 + 1_300, runtime: 'test', event: 'session_execution', sessionID: 'ses_root',
      payload: { phase: 'ledger_lock', state: 'completed', elapsedMs: 500, action: 'reserve' } },
    { type: 'lifecycle', at: T0 + 1_350, runtime: 'test', event: 'session_execution', sessionID: 'ses_root',
      payload: { phase: 'admission', state: 'started' } },
    // Native shell/writer records carry their tier, so no row is labelled `?`.
    { type: 'lifecycle', at: T0 + 1_400, runtime: 'test', event: 'session_execution', sessionID: 'ses_root',
      payload: { phase: 'preparation', state: 'completed', elapsedMs: 200, executionTier: 'process', steps: 'ledger_commit:2/70' } },
    { type: 'lifecycle', at: T0 + 1_450, runtime: 'test', event: 'session_execution', sessionID: 'ses_root',
      payload: { phase: 'finish', state: 'completed', elapsedMs: 100, executionTier: 'process' } },
    { type: 'lifecycle', at: T0 + 1_460, runtime: 'test', event: 'session_execution', sessionID: 'ses_root',
      payload: { phase: 'lease_cleanup', state: 'completed', elapsedMs: 50, executionTier: 'process', deferred: true } },
    { type: 'control', at: T0 + 10_000, runtime: 'test', sessionID: 'ses_root', action: 'abort',
      payload: { method: 'POST', body: { text: 'private prompt body' }, source: 'stop_button' } },
    event(T0 + 10_100, 'ses_root', 'session.error', { error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } }),
    event(T0 + 10_200, 'ses_root', 'session.status', { status: { type: 'idle' } }),
    { type: 'gap', at: T0 + 10_300, runtime: 'test', sessionID: 'ses_root', reason: 'queue_overflow', count: 1 },
  ], { gzip: true });
  await bucket('ses_child', { sessionID: 'ses_child', parentID: 'ses_root', title: 'Child task', firstAt: T0 + 2_000, gapCount: 0 }, [
    assistant(T0 + 8_000, 'ses_child', 'msg_c1', { agent: 'fixer', providerID: 'anthropic', modelID: 'claude-x',
      tokens: { input: 10, output: 30, reasoning: 0, cache: { read: 0, write: 990 } }, cost: 0.5, created: T0 + 3_000, completed: T0 + 8_000 }),
    toolPart(T0 + 7_000, 'ses_child', 'call_1', 'read', { status: 'completed', time: { start: T0 + 6_000, end: T0 + 6_500 } }),
    event(T0 + 7_100, 'ses_child', 'session.status', { status: { type: 'retry', attempt: 2, message: 'Rate limited' } }),
    event(T0 + 7_200, 'ses_child', 'permission.asked', { id: 'per_1', permission: 'bash', patterns: ['rm *'] }),
    event(T0 + 7_300, 'ses_child', 'permission.replied', { requestID: 'per_1', reply: 'once' }),
    event(T0 + 7_400, 'ses_child', 'question.asked', { id: 'que_1', questions: [{ question: 'Pick one?' }] }),
    event(T0 + 7_500, 'ses_child', 'question.replied', { requestID: 'que_1', answers: [['secret answer']] }),
    { type: 'lifecycle', at: T0 + 7_600, runtime: 'test', event: 'provider_recovery_control', sessionID: 'ses_child',
      payload: { action: 'stop', providerID: 'anthropic', modelID: 'claude-x' } },
    event(T0 + 9_000, 'ses_child', 'session.status', { status: { type: 'busy' } }),
  ]);
  await bucket('ses_grand', null, [
    event(T0 + 8_500, 'ses_grand', 'session.created', {
      info: { id: 'ses_grand', parentID: 'ses_child', title: 'Grandchild', time: { created: T0 + 8_500 } },
    }),
    assistant(T0 + 9_500, 'ses_grand', 'msg_g1', { agent: 'explorer', providerID: 'openai', modelID: 'gpt-x',
      tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 50, write: 0 } }, cost: 0, created: T0 + 8_600, completed: T0 + 9_500 }),
    event(T0 + 9_600, 'ses_grand', 'session.deleted', { info: { id: 'ses_grand' } }),
  ]);
  await bucket('ses_other', { sessionID: 'ses_other', parentID: null, title: 'Unrelated', firstAt: T0 }, [
    assistant(T0 + 1_000, 'ses_other', 'msg_o1', { agent: 'orchestrator', providerID: 'openai', modelID: 'gpt-x',
      tokens: { input: 9999, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 9, created: T0, completed: T0 + 1_000 }),
  ]);
};

describe('journal summary', () => {
  test('computes median, nearest-rank p90, max and total', () => {
    assert.deepEqual(sampleStats([]), { count: 0, p50: 0, p90: 0, max: 0, total: 0 });
    assert.deepEqual(sampleStats([4, 1, 3, 2]), { count: 4, p50: 2.5, p90: 4, max: 4, total: 10 });
    assert.equal(sampleStats(Array.from({ length: 10 }, (_, index) => index + 1)).p90, 9);
  });

  test('parses summary options and rejects unknown ones', () => {
    assert.deepEqual(parseSummaryOptions(['--since', '5', '--json']), { since: 5, until: null, json: true });
    assert.throws(() => parseSummaryOptions(['--tail', '3']), /Unknown summary option: --tail/);
  });

  test('summarizes the session tree, tokens, tools, phases, errors and controls', async () => {
    const directory = await temporaryDirectory();
    await writeSummaryFixture(directory);
    const summary = await summarizeSessionTree(directory, 'ses_root');

    assert.deepEqual(summary.sessions.map(({ id, parentID, depth }) => ({ id, parentID, depth })), [
      { id: 'ses_root', parentID: null, depth: 0 },
      { id: 'ses_child', parentID: 'ses_root', depth: 1 },
      { id: 'ses_grand', parentID: 'ses_child', depth: 2 },
    ]);
    const [root, child, grand] = summary.sessions;
    assert.deepEqual([root.agents, root.models, root.status], [['orchestrator'], ['openai/gpt-x'], 'idle']);
    assert.deepEqual([child.agents, child.status, grand.status, grand.title], [['fixer'], 'busy', 'deleted', 'Grandchild']);
    assert.equal(root.busyMs, 8_000);
    assert.equal(root.aborts, 1);
    assert.equal(summary.gaps, 1);

    const orchestrator = summary.tokens.byAgentModel.find((row) => row.agent === 'orchestrator');
    assert.deepEqual(
      [orchestrator.messages, orchestrator.input, orchestrator.output, orchestrator.reasoning, orchestrator.cacheRead, orchestrator.cacheWrite, orchestrator.cost],
      [1, 200, 40, 10, 600, 200, 0.02],
    );
    assert.equal(orchestrator.cacheHitRatio, 600 / 1000);
    const openai = summary.tokens.byModel.find((row) => row.model === 'openai/gpt-x');
    assert.deepEqual([openai.messages, openai.input, openai.cacheRead], [2, 250, 650]);
    assert.deepEqual([summary.tokens.total.messages, summary.tokens.total.input, summary.tokens.total.cost], [3, 260, 0.52]);

    const read = summary.tools.find((tool) => tool.tool === 'read');
    assert.deepEqual([read.calls, read.timed, read.p50Ms, read.p90Ms, read.maxMs, read.totalMs, read.errors],
      [3, 3, 1_000, 3_000, 3_000, 4_500, 0]);
    const bash = summary.tools.find((tool) => tool.tool === 'bash');
    assert.deepEqual([bash.calls, bash.errors, bash.unfinished], [1, 1, 1]);

    assert.deepEqual(summary.phases.map(({ tier, phase, count, p50Ms, totalMs, slow }) => ({ tier, phase, count, p50Ms, totalMs, slow })), [
      { tier: 'reserve', phase: 'ledger_lock', count: 2, p50Ms: 400, totalMs: 800, slow: 1 },
      { tier: 'process', phase: 'preparation', count: 1, p50Ms: 200, totalMs: 200, slow: 0 },
      { tier: 'process', phase: 'finish', count: 1, p50Ms: 100, totalMs: 100, slow: 0 },
      { tier: 'process', phase: 'lease_cleanup', count: 1, p50Ms: 50, totalMs: 50, slow: 0 },
    ]);

    assert.deepEqual(summary.errors.map(({ sessionID, kind, detail }) => ({ sessionID, kind, detail })), [
      { sessionID: 'ses_root', kind: 'tool', detail: 'bash: Tool execution interrupted' },
      { sessionID: 'ses_root', kind: 'session', detail: '{"name":"MessageAbortedError","data":{"message":"Aborted"}}' },
    ]);
    assert.deepEqual(summary.controls.map(({ kind, action, source, detail }) => [kind, action, source, detail]), [
      ['retry', 'attempt 2', null, 'Rate limited'],
      ['permission.asked', null, null, 'bash'],
      ['permission.replied', null, null, 'once'],
      ['question.asked', null, null, '1 question(s)'],
      ['question.replied', null, null, null],
      ['provider_recovery', 'stop', null, 'anthropic/claude-x'],
      ['control', 'abort', 'stop_button', 'POST'],
    ]);
    assert.deepEqual(summary.counts, { aborts: 1, otherControls: 0, retries: 1, providerRecoveries: 1, permissionAsked: 1,
      permissionReplied: 1, questionAsked: 1, questionReplied: 1, questionRejected: 0 });

    const text = formatSessionSummary(summary);
    assert.match(text, /^root=ses_root sessions=3 /);
    assert.match(text, /\n {4}└ ses_child fixer anthropic\/claude-x busy /);
    assert.match(text, /\n {6}└ ses_grand explorer openai\/gpt-x deleted /);
    assert.match(text, /read +n=3 +p50= +1\.00 p90= +3\.00 max= +3\.00/);
    for (const forbidden of ['ses_other', 'private prompt body', 'secret answer', 'Pick one?']) {
      assert.equal(text.includes(forbidden), false, forbidden);
      assert.equal(JSON.stringify(summary).includes(forbidden), false, forbidden);
    }
  });

  test('applies --since/--until to records but keeps the tree', async () => {
    const directory = await temporaryDirectory();
    await writeSummaryFixture(directory);
    const summary = await summarizeSessionTree(directory, 'ses_root', { since: T0 + 8_000, until: T0 + 9_500 });
    assert.deepEqual(summary.sessions.map((session) => session.id), ['ses_root', 'ses_child', 'ses_grand']);
    assert.deepEqual(summary.tokens.byAgent.map((row) => row.agent).sort(), ['explorer', 'fixer', 'orchestrator']);
    assert.equal(summary.tools.length, 0);
    assert.equal(summary.span.firstAt, T0 + 8_000);
  });

  test('runs as a CLI subcommand in text and JSON modes', async () => {
    const directory = await temporaryDirectory();
    await writeSummaryFixture(directory);
    const run = (...args) => spawnSync(process.execPath, [journalScript, '--dir', directory, 'summary', ...args], { encoding: 'utf8' });

    const text = run('ses_root');
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /TOOLS \(calls, p50 s, p90 s, max s, total s, errors, unfinished\):/);
    const json = run('ses_root', '--json');
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).sessions.length, 3);

    const missing = run('ses_missing');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No journal records for session ses_missing/);
    const unknown = run('ses_root', '--verify');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown summary option: --verify/);
  });
});
