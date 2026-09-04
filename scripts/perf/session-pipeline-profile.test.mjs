import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

import {
  GUARD_REJECTION_PREFIX,
  aggregateTree,
  classifyBashCommand,
  classifyToolFamily,
  collectPreflight,
  collectServerJoins,
  collectTurnTiming,
  loadSessionTree,
  normalizeToolPart,
  openSessionDatabase,
  parseModelColumn,
  parseProfileArguments,
  percentile,
  profileSession,
  renderReport,
  summarizePreflightBody,
} from './session-pipeline-profile.mjs';

// ---------------------------------------------------------------------------
// Fixture: one orchestrator root with an explorer child and a designer child,
// plus an unrelated root that must never be walked.
// ---------------------------------------------------------------------------

const json = (value) => JSON.stringify(value);
const model = (providerID, id, variant = null) => json({ id, providerID, variant });

const session = (id, parent_id, agent, modelJson, time_created, time_updated, tokens = {}) => ({
  id,
  project_id: 'prj_1',
  parent_id,
  slug: id,
  directory: '/repo',
  title: `Title ${id}`,
  version: '1.18.27',
  agent,
  model: modelJson,
  cost: 0,
  tokens_input: tokens.input ?? 0,
  tokens_output: tokens.output ?? 0,
  tokens_reasoning: tokens.reasoning ?? 0,
  tokens_cache_read: tokens.cacheRead ?? 0,
  tokens_cache_write: tokens.cacheWrite ?? 0,
  time_created,
  time_updated,
});

const userMessage = (session_id, id, created, extra = {}) => ({
  id,
  session_id,
  time_created: created,
  time_updated: created,
  data: json({ role: 'user', time: { created }, agent: 'orchestrator', model: { providerID: 'openai', modelID: 'gpt-5.6-sol' }, ...extra }),
});

const assistantMessage = (session_id, id, { providerID, modelID, agent, created, completed, tokens = {}, mode }) => ({
  id,
  session_id,
  time_created: created,
  time_updated: completed,
  data: json({
    parentID: 'msg_parent',
    role: 'assistant',
    mode: mode ?? agent,
    agent,
    variant: 'medium',
    providerID,
    modelID,
    cost: 0,
    tokens: {
      total: (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0),
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cache: { read: tokens.cacheRead ?? 0, write: tokens.cacheWrite ?? 0 },
    },
    time: { created, completed },
    finish: 'stop',
  }),
});

let partCounter = 0;
const toolPart = (session_id, message_id, tool, { input = {}, output = '', status = 'completed', error, metadata, durationMs = 10, start = 10_000 }) => {
  partCounter += 1;
  const state = { status, input, output, title: tool, time: { start, end: start + durationMs } };
  if (metadata) state.metadata = metadata;
  if (error !== undefined) state.error = error;
  return {
    id: `prt_${String(partCounter).padStart(3, '0')}`,
    message_id,
    session_id,
    time_created: start,
    time_updated: start + durationMs,
    data: json({ type: 'tool', tool, callID: `call_${partCounter}`, state }),
  };
};
const skillPart = (session_id, message_id, name, { bytes = 6000, truncated = false, durationMs = 18 } = {}) => toolPart(session_id, message_id, 'skill', {
  input: { name },
  output: 'x'.repeat(bytes),
  metadata: { name, dir: `/skills/${name}`, truncated },
  durationMs,
});
const GUARD_TEXT = `${GUARD_REJECTION_PREFIX} Invalid input: read cannot load binary files with extension .png as text.`;

export const buildFixture = () => {
  partCounter = 0;
  const sessions = [
    session('ses_root', null, 'orchestrator', model('openai', 'gpt-5.6-sol', 'medium'), 1000, 100_000, { input: 350, output: 35, reasoning: 5, cacheRead: 50 }),
    session('ses_childA', 'ses_root', 'explorer', model('opencode', 'muse-spark', 'high'), 2000, 3000, { input: 300, output: 30 }),
    session('ses_childB', 'ses_root', 'designer', model('anthropic', 'claude-opus-4-8'), 4000, 50_000, { input: 450, output: 45, cacheRead: 1000 }),
    session('ses_other', null, 'build', model('openai', 'gpt-5.6-sol'), 100, 200, { input: 9999 }),
  ];
  const messages = [
    userMessage('ses_root', 'msg_u1', 1000),
    assistantMessage('ses_root', 'msg_a1', { providerID: 'openai', modelID: 'gpt-5.6-sol', agent: 'orchestrator', created: 1100, completed: 2100, tokens: { input: 100, output: 10, reasoning: 5, cacheRead: 50 } }),
    userMessage('ses_root', 'msg_u2', 5000),
    assistantMessage('ses_root', 'msg_a2', { providerID: 'openai', modelID: 'gpt-5.6-sol', agent: 'orchestrator', created: 5100, completed: 9100, tokens: { input: 200, output: 20 } }),
    assistantMessage('ses_root', 'msg_a3', { providerID: 'openai', modelID: 'gpt-5.6-sol', agent: 'compaction', mode: 'compaction', created: 9200, completed: 9300 }),
    userMessage('ses_root', 'msg_u3', 9400, { summary: true }),
    userMessage('ses_childA', 'msg_au', 2000),
    assistantMessage('ses_childA', 'msg_aa', { providerID: 'opencode', modelID: 'muse-spark', agent: 'explorer', created: 2100, completed: 2900, tokens: { input: 300, output: 30 } }),
    userMessage('ses_childB', 'msg_bu', 4000),
    assistantMessage('ses_childB', 'msg_ba1', { providerID: 'anthropic', modelID: 'claude-opus-4-8', agent: 'designer', created: 4100, completed: 8100, tokens: { input: 400, output: 40, cacheRead: 1000 } }),
    assistantMessage('ses_childB', 'msg_ba2', { providerID: 'openai', modelID: 'gpt-5.6-sol', agent: 'designer', created: 8200, completed: 9200, tokens: { input: 50, output: 5 } }),
    userMessage('ses_other', 'msg_ou', 100),
    assistantMessage('ses_other', 'msg_oa', { providerID: 'openai', modelID: 'gpt-5.6-sol', agent: 'build', created: 110, completed: 200, tokens: { input: 9999 } }),
  ];
  const parts = [
    skillPart('ses_root', 'msg_a1', 'Superpowers'),
    toolPart('ses_root', 'msg_a1', 'read', { input: { path: '/a' }, output: 'aaaa', durationMs: 10 }),
    toolPart('ses_root', 'msg_a1', 'read', { input: { path: '/b' }, output: 'bb', durationMs: 30 }),
    toolPart('ses_root', 'msg_a1', 'read', { input: { path: '/c' }, output: 'c', durationMs: 50 }),
    toolPart('ses_root', 'msg_a1', 'read', { input: { path: '/x.png' }, status: 'error', output: GUARD_TEXT, durationMs: 5 }),
    toolPart('ses_root', 'msg_a1', 'bash', { input: { command: 'git status' }, output: 'clean', durationMs: 100 }),
    toolPart('ses_root', 'msg_a1', 'bash', { input: { command: 'bun test packages/ui' }, output: 'ok', durationMs: 2000 }),
    toolPart('ses_root', 'msg_a1', 'ctx_execute', { input: { code: '1' }, output: '1', durationMs: 40 }),
    toolPart('ses_root', 'msg_a1', 'devryan_task', { input: { prompt: 'go' }, output: 'done', durationMs: 300 }),
    {
      id: 'prt_text', message_id: 'msg_a1', session_id: 'ses_root', time_created: 1100, time_updated: 1100,
      data: json({ type: 'text', text: 'not a tool part' }),
    },
    toolPart('ses_root', 'msg_a2', 'bash', { input: { command: 'npx vitest run src' }, status: 'error', output: 'FAIL', durationMs: 1500 }),
    toolPart('ses_root', 'msg_a2', 'bash', { input: { command: 'tsc --noEmit -p packages/ui' }, durationMs: 3000 }),
    toolPart('ses_root', 'msg_a2', 'bash', { input: { command: 'npx eslint .' }, durationMs: 700 }),
    toolPart('ses_root', 'msg_a2', 'bash', { input: { command: 'npx playwright test' }, durationMs: 4000 }),
    toolPart('ses_root', 'msg_a2', 'bash', { input: { command: 'ls -la' }, durationMs: 20 }),
    skillPart('ses_childA', 'msg_aa', 'Superpowers', { durationMs: 15 }),
    toolPart('ses_childA', 'msg_aa', 'grep', { input: { pattern: 'x' }, output: 'match', durationMs: 12 }),
    toolPart('ses_childA', 'msg_aa', 'ctx_search', { input: { queries: ['q'] }, status: 'error', output: 'boom', durationMs: 20 }),
    skillPart('ses_childB', 'msg_ba1', 'Superpowers'),
    skillPart('ses_childB', 'msg_ba1', 'Superpowers'),
    skillPart('ses_childB', 'msg_ba1', 'dataviz', { bytes: 2000, truncated: true }),
    toolPart('ses_childB', 'msg_ba1', 'edit', { input: { filePath: '/bad' }, status: 'error', error: `${GUARD_REJECTION_PREFIX} bad path`, durationMs: 3 }),
    toolPart('ses_childB', 'msg_ba1', 'edit', { input: { filePath: '/ok' }, output: 'edited', durationMs: 8 }),
    toolPart('ses_childB', 'msg_ba2', 'read', { input: { path: '/y.png' }, status: 'error', output: GUARD_TEXT, durationMs: 7 }),
    skillPart('ses_other', 'msg_oa', 'Superpowers'),
  ];
  return { sessions, messages, parts };
};

const SCHEMA = `
CREATE TABLE session (
  id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL,
  title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer, summary_deletions integer,
  summary_files integer, summary_diffs text, revert text, permission text, time_created integer NOT NULL,
  time_updated integer NOT NULL, time_compacting integer, time_archived integer, workspace_id text, path text,
  agent text, model text, cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL,
  tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL,
  tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL, metadata text
);
CREATE TABLE message (
  id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
);
CREATE TABLE part (
  id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL,
  time_updated integer NOT NULL, data text NOT NULL
);
CREATE INDEX session_parent_idx ON session (parent_id);
CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
CREATE INDEX part_session_idx ON part (session_id);
CREATE INDEX part_message_id_id_idx ON part (message_id, id);
`;

const writeFixtureDatabase = (file) => {
  const fixture = buildFixture();
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const insertSession = db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, agent, model, cost,
    tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of fixture.sessions) {
    insertSession.run(row.id, row.project_id, row.parent_id, row.slug, row.directory, row.title, row.version, row.agent, row.model, row.cost,
      row.tokens_input, row.tokens_output, row.tokens_reasoning, row.tokens_cache_read, row.tokens_cache_write, row.time_created, row.time_updated);
  }
  const insertMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
  for (const row of fixture.messages) insertMessage.run(row.id, row.session_id, row.time_created, row.time_updated, row.data);
  const insertPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)');
  for (const row of fixture.parts) insertPart.run(row.id, row.message_id, row.session_id, row.time_created, row.time_updated, row.data);
  db.close();
  return fixture;
};

const assertFixtureTree = (tree) => {
  assert.equal(tree.rootId, 'ses_root');
  assert.equal(tree.sessionCount, 3);
  assert.equal(tree.maxDepth, 1);
  assert.deepEqual(tree.sessions.map((entry) => entry.id), ['ses_root', 'ses_childA', 'ses_childB']);
  assert.deepEqual(tree.sessions.map((entry) => entry.depth), [0, 1, 1]);

  const { totals } = tree;
  assert.equal(totals.turns, 4);
  assert.deepEqual(totals.messages, { total: 11, user: 5, assistant: 6, compaction: 1, summaries: 1 });
  assert.deepEqual(Object.keys(totals.tokensByModel), ['anthropic/claude-opus-4-8', 'openai/gpt-5.6-sol', 'opencode/muse-spark']);
  assert.deepEqual(totals.tokensByModel['openai/gpt-5.6-sol'], { messages: 4, input: 350, output: 35, reasoning: 5, cacheRead: 50, cacheWrite: 0, total: 390 });
  assert.deepEqual(totals.tokensByModel['anthropic/claude-opus-4-8'], { messages: 1, input: 400, output: 40, reasoning: 0, cacheRead: 1000, cacheWrite: 0, total: 440 });
  assert.deepEqual(totals.tokensByModel['opencode/muse-spark'], { messages: 1, input: 300, output: 30, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 330 });
  assert.deepEqual(totals.assistantByModel['openai/gpt-5.6-sol'], {
    providerID: 'openai', modelID: 'gpt-5.6-sol', count: 4, agents: ['compaction', 'designer', 'orchestrator'],
  });

  assert.equal(totals.toolCalls.total, 23);
  assert.equal(totals.toolCalls.errors, 5);
  assert.equal(totals.toolCalls.guardRejections, 3);
  assert.equal(Object.keys(totals.toolCalls.byName)[0], 'bash');
  const read = totals.toolCalls.byName.read;
  assert.equal(read.count, 5);
  assert.equal(read.errors, 2);
  assert.equal(read.guardRejections, 2);
  assert.equal(read.timed, 5);
  assert.equal(read.p50Ms, 10);
  assert.equal(read.p95Ms, 50);
  assert.equal(read.totalMs, 102);
  assert.equal(read.maxMs, 50);
  assert.equal(read.outputBytes, 7 + GUARD_TEXT.length * 2);
  assert.equal(totals.toolCalls.byName.skill.count, 5);
  assert.equal(totals.toolCalls.byName.bash.count, 7);
  assert.deepEqual(
    Object.fromEntries(Object.entries(totals.toolCalls.byFamily).map(([family, stats]) => [family, stats.count])),
    { builtin: 20, mcp: 2, plugin: 1 },
  );

  assert.equal(totals.guardRejections.total, 3);
  assert.deepEqual(Object.keys(totals.guardRejections.byModel), ['openai/gpt-5.6-sol', 'anthropic/claude-opus-4-8']);
  assert.equal(totals.guardRejections.byModel['openai/gpt-5.6-sol'].count, 2);
  assert.deepEqual(totals.guardRejections.byModel['openai/gpt-5.6-sol'].byTool, { read: 2 });
  assert.deepEqual(totals.guardRejections.byModel['anthropic/claude-opus-4-8'].byTool, { edit: 1 });
  assert.ok(totals.guardRejections.byModel['anthropic/claude-opus-4-8'].samples[0].message.startsWith(GUARD_REJECTION_PREFIX));

  assert.equal(totals.skills.loads, 5);
  assert.equal(totals.skills.bytes, 26_000);
  assert.equal(totals.skills.truncated, 1);
  assert.deepEqual(totals.skills.byName.Superpowers, { count: 4, bytes: 24_000, truncated: 0, errors: 0, dir: '/skills/Superpowers' });
  assert.deepEqual(totals.skills.byName.dataviz, { count: 1, bytes: 2000, truncated: 1, errors: 0, dir: '/skills/dataviz' });
  assert.deepEqual(tree.skillReloads, [{
    name: 'Superpowers',
    parentId: 'ses_root',
    totalLoads: 4,
    childLoads: 3,
    bytes: 24_000,
    bySession: { ses_root: 1, ses_childA: 1, ses_childB: 2 },
  }]);

  assert.equal(totals.mcp.total, 2);
  assert.equal(totals.mcp.errors, 1);
  assert.equal(totals.mcp.byServer.ctx.count, 2);
  assert.equal(totals.mcp.byServer.ctx.errors, 1);
  assert.deepEqual(totals.mcp.byTool, { ctx_execute: 1, ctx_search: 1 });

  assert.equal(totals.bash.total, 7);
  assert.equal(totals.bash.errors, 1);
  assert.deepEqual(Object.keys(totals.bash.byClass), ['tsc', 'vitest', 'bun test', 'eslint', 'git', 'playwright', 'other']);
  assert.equal(totals.bash.byClass.vitest.errors, 1);
  assert.equal(totals.bash.byClass.playwright.p50Ms, 4000);

  assert.equal(totals.wall.startedAt, 1000);
  assert.equal(totals.wall.endedAt, 100_000);
  assert.equal(totals.wall.wallMs, 99_000);
  assert.equal(totals.wall.assistantActiveMs, 10_900);

  const [root, childA, childB] = tree.sessions;
  assert.equal(root.agent, 'orchestrator');
  assert.equal(root.model, 'openai/gpt-5.6-sol');
  assert.equal(root.variant, 'medium');
  assert.equal(root.turns, 2);
  assert.equal(root.messages.assistant, 3);
  assert.deepEqual(root.assistantMessageIds, ['msg_a1', 'msg_a2', 'msg_a3']);
  assert.equal(root.wall.wallMs, 99_000);
  assert.equal(root.wall.assistantActiveMs, 5100);
  assert.deepEqual(root.tokensRollup, { input: 350, output: 35, reasoning: 5, cacheRead: 50, cacheWrite: 0 });
  assert.equal(root.toolCalls.total, 14);
  assert.equal(root.bash.total, 7);
  assert.equal(childA.parentId, 'ses_root');
  assert.equal(childA.model, 'opencode/muse-spark');
  assert.equal(childA.mcp.errors, 1);
  assert.deepEqual(childA.skills.repeated, []);
  assert.equal(childB.guardRejections.total, 2);
  assert.deepEqual(childB.skills.repeated, [{ name: 'Superpowers', count: 2, bytes: 12_000 }]);
  assert.equal(childB.wall.assistantActiveMs, 5000);
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('classifyBashCommand', () => {
  it('maps the plan classes and falls back to other', () => {
    assert.equal(classifyBashCommand('git status'), 'git');
    assert.equal(classifyBashCommand('cd /repo && git diff --stat'), 'git');
    assert.equal(classifyBashCommand('GIT_PAGER=cat git log -3'), 'git');
    assert.equal(classifyBashCommand('cat .gitignore'), 'other');
    assert.equal(classifyBashCommand('bun test packages/ui'), 'bun test');
    assert.equal(classifyBashCommand('bun run test:scripts'), 'bun test');
    assert.equal(classifyBashCommand('cd packages/web && npx vitest run src'), 'vitest');
    assert.equal(classifyBashCommand('tsc --noEmit -p packages/ui'), 'tsc');
    assert.equal(classifyBashCommand('bun run type-check:affected'), 'tsc');
    assert.equal(classifyBashCommand('npx eslint . --max-warnings 0'), 'eslint');
    assert.equal(classifyBashCommand('bun run lint'), 'eslint');
    assert.equal(classifyBashCommand('npx playwright test tests/e2e'), 'playwright');
    assert.equal(classifyBashCommand('ls -la'), 'other');
    assert.equal(classifyBashCommand(''), 'other');
    assert.equal(classifyBashCommand(undefined), 'other');
  });

  it('prefers the specific tool over a leading git in a chained command', () => {
    assert.equal(classifyBashCommand('git stash && bun test && git stash pop'), 'bun test');
    assert.equal(classifyBashCommand('git pull && npx playwright test'), 'playwright');
  });
});

describe('classifyToolFamily and model parsing', () => {
  it('separates built-ins, DevRyan plugin tools and MCP tools', () => {
    assert.equal(classifyToolFamily('read'), 'builtin');
    assert.equal(classifyToolFamily('apply_patch'), 'builtin');
    assert.equal(classifyToolFamily('devryan_task'), 'plugin');
    assert.equal(classifyToolFamily('oc_bash'), 'plugin');
    assert.equal(classifyToolFamily('ctx_execute'), 'mcp');
    assert.equal(classifyToolFamily('context7_resolve-library-id'), 'mcp');
    assert.equal(classifyToolFamily('question'), 'builtin');
  });

  it('parses the session.model JSON column and provider/model strings', () => {
    assert.deepEqual(parseModelColumn('{"id":"gpt-5.6-sol","providerID":"openai","variant":"medium"}'), { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'medium' });
    assert.deepEqual(parseModelColumn('anthropic/claude-opus-4-8'), { providerID: 'anthropic', modelID: 'claude-opus-4-8', variant: null });
    assert.deepEqual(parseModelColumn(null), { providerID: null, modelID: null, variant: null });
  });
});

describe('percentile', () => {
  it('uses nearest-rank and ignores non-numbers', () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([5], 50), 5);
    assert.equal(percentile([4, 1, 3, 2], 50), 2);
    assert.equal(percentile([4, 1, 3, 2], 95), 4);
    assert.equal(percentile([1, null, 'x', 3], 50), 1);
  });
});

describe('normalizeToolPart', () => {
  it('detects guard rejections through state.error or state.output only when the call errored', () => {
    const base = { id: 'p', message_id: 'm', session_id: 's' };
    const errored = normalizeToolPart({ ...base, data: json({ type: 'tool', tool: 'read', state: { status: 'error', error: `${GUARD_REJECTION_PREFIX} nope`, input: { path: '/x' } } }) });
    assert.equal(errored.guardRejected, true);
    assert.equal(errored.guardMessage, `${GUARD_REJECTION_PREFIX} nope`);
    assert.equal(errored.durationMs, null);
    const viaOutput = normalizeToolPart({ ...base, data: json({ type: 'tool', tool: 'edit', state: { status: 'error', output: `  ${GUARD_REJECTION_PREFIX} bad`, time: { start: 5, end: 9 } } }) });
    assert.equal(viaOutput.guardRejected, true);
    assert.equal(viaOutput.durationMs, 4);
    const completed = normalizeToolPart({ ...base, data: json({ type: 'tool', tool: 'read', state: { status: 'completed', output: `${GUARD_REJECTION_PREFIX} quoted in a file` } }) });
    assert.equal(completed.guardRejected, false);
    assert.equal(completed.isError, false);
    assert.equal(normalizeToolPart({ ...base, data: json({ type: 'text', text: 'hi' }) }), null);
    assert.equal(normalizeToolPart({ ...base, data: '{not json' }), null);
  });
});

describe('parseProfileArguments', () => {
  it('requires --session and applies defaults', () => {
    assert.throws(() => parseProfileArguments([], {}), /--session/);
    const options = parseProfileArguments(['--session', 'ses_x'], {});
    assert.equal(options.sessionId, 'ses_x');
    assert.ok(options.dbPath.endsWith(path.join('.local', 'share', 'opencode', 'opencode.db')));
    assert.equal(options.server, 'http://127.0.0.1:3000');
    assert.equal(options.cookie, null);
    assert.equal(options.preflight, false);
    assert.equal(options.turnTiming, false);
    assert.match(options.run, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });

  it('reads flags and the environment', () => {
    const options = parseProfileArguments(
      ['--session', 'ses_x', '--db', '~/db.sqlite', '--run', 'dozen', '--out', '/tmp/out', '--server', 'http://127.0.0.1:4000/', '--cookie', 'abc', '--preflight', '--turn-timing', '--quiet'],
      { DEVRYAN_UI_SESSION_COOKIE: 'ignored' },
    );
    assert.equal(options.dbPath, path.join(os.homedir(), 'db.sqlite'));
    assert.equal(options.run, 'dozen');
    assert.equal(options.outRoot, '/tmp/out');
    assert.equal(options.server, 'http://127.0.0.1:4000');
    assert.equal(options.cookie, 'abc');
    assert.equal(options.preflight, true);
    assert.equal(options.turnTiming, true);
    assert.equal(options.quiet, true);
    assert.equal(parseProfileArguments(['--session', 'ses_x'], { DEVRYAN_UI_SESSION_COOKIE: 'env', OPENCODE_DB_PATH: '/x/opencode.db' }).cookie, 'env');
    assert.equal(parseProfileArguments(['--session', 'ses_x'], { OPENCODE_DB_PATH: '/x/opencode.db' }).dbPath, '/x/opencode.db');
    assert.equal(parseProfileArguments(['--help'], {}).help, true);
  });

  it('rejects unknown flags and unsafe run labels', () => {
    assert.throws(() => parseProfileArguments(['--session', 'ses_x', '--bogus'], {}), /Unknown flag/);
    assert.throws(() => parseProfileArguments(['--session', 'ses_x', '--run', '../x'], {}), /--run/);
    assert.throws(() => parseProfileArguments(['--session'], {}), /requires a value/);
  });
});

// ---------------------------------------------------------------------------
// Aggregation on plain rows
// ---------------------------------------------------------------------------

describe('aggregateTree', () => {
  it('aggregates one root and two children from plain rows and ignores unrelated sessions', () => {
    const fixture = buildFixture();
    const tree = aggregateTree({
      sessions: fixture.sessions.filter((row) => row.id !== 'ses_other').map((row) => ({ ...row, depth: row.parent_id ? 1 : 0 })),
      messages: fixture.messages,
      parts: fixture.parts,
    });
    assertFixtureTree(tree);
    assert.deepEqual(tree.totals.parts.byType, {});
  });

  it('accepts already-parsed data objects', () => {
    const fixture = buildFixture();
    const parse = (rows) => rows.map((row) => ({ ...row, data: JSON.parse(row.data) }));
    const tree = aggregateTree({
      sessions: fixture.sessions.filter((row) => row.id !== 'ses_other').map((row) => ({ ...row, depth: row.parent_id ? 1 : 0 })),
      messages: parse(fixture.messages),
      parts: parse(fixture.parts),
    });
    assertFixtureTree(tree);
  });

  it('refuses an empty tree', () => {
    assert.throws(() => aggregateTree({ sessions: [], messages: [], parts: [] }), /at least one session/);
  });
});

// ---------------------------------------------------------------------------
// Database round trip
// ---------------------------------------------------------------------------

describe('database round trip', () => {
  let dir;
  let file;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-pipeline-'));
    file = path.join(dir, 'opencode.db');
    writeFixtureDatabase(file);
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('opens read-only, walks the recursive tree and returns only tool parts', () => {
    const db = openSessionDatabase(file);
    try {
      assert.ok(['better-sqlite3', 'node:sqlite'].includes(db.driver), db.driver);
      assert.throws(() => db.all("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_new', 'p', 's', '/', 't', 'v', 1, 1)"));
      const rows = loadSessionTree(db, 'ses_root');
      assert.deepEqual(rows.sessions.map((row) => [row.id, row.depth]), [['ses_root', 0], ['ses_childA', 1], ['ses_childB', 1]]);
      assert.equal(rows.messages.length, 11);
      assert.equal(rows.parts.length, 23);
      assert.ok(rows.parts.every((row) => JSON.parse(row.data).type === 'tool'));
      assertFixtureTree(aggregateTree(rows));
      const tree = aggregateTree(rows);
      assert.deepEqual(tree.totals.parts.byType.tool, { count: 23, chars: rows.parts.reduce((total, row) => total + row.data.length, 0) });
      assert.equal(tree.totals.parts.byType.text.count, 1);
      assert.throws(() => loadSessionTree(db, 'ses_missing'), /not found/);
    } finally {
      db.close();
    }
    const check = new DatabaseSync(file, { readOnly: true });
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM session').get().n, 4);
    check.close();
  });

  it('falls back to node:sqlite when better-sqlite3 cannot be loaded and reports the reason', () => {
    const db = openSessionDatabase(file, { requireBetterSqlite: () => { throw new Error('NODE_MODULE_VERSION mismatch'); } });
    try {
      assert.equal(db.driver, 'node:sqlite');
      assert.match(db.notes[0], /NODE_MODULE_VERSION mismatch/);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM part WHERE session_id = ?', ['ses_root']).n, 15);
    } finally {
      db.close();
    }
    assert.throws(() => openSessionDatabase(path.join(dir, 'missing.db')), /Database not found/);
  });

  it('profileSession writes report.md and report.json under <out>/<run>/pipeline', async () => {
    const options = parseProfileArguments(['--session', 'ses_root', '--db', file, '--run', 'fixture', '--out', path.join(dir, 'out')], {});
    const { profile, paths } = await profileSession(options);
    assert.equal(paths.dir, path.join(dir, 'out', 'fixture', 'pipeline'));
    const written = JSON.parse(fs.readFileSync(paths.json, 'utf8'));
    assert.equal(written.tree.totals.turns, 4);
    assert.equal(written.server, null);
    assert.equal(written.db.path, file);
    assertFixtureTree(profile.tree);
    const markdown = fs.readFileSync(paths.markdown, 'utf8');
    assert.match(markdown, /^# Session pipeline profile — Title ses_root/);
    assert.match(markdown, /\| Superpowers \| ses_root \| 4 \| 3 \| 23\.4 KiB \| ses_root×1, ses_childA×1, ses_childB×2 \|/);
    assert.match(markdown, /\| openai\/gpt-5\.6-sol \| 2 \| read×2 \|/);
    assert.match(markdown, /\| read \| 5 \| 2 \| 2 \| 10 ms \| 50 ms \|/);
    assert.match(markdown, /\| playwright \| 1 \| 0 \| 4\.00 s \|/);
    assert.ok(!markdown.includes('ses_other'));
  });
});

// ---------------------------------------------------------------------------
// Server joins (fake fetch)
// ---------------------------------------------------------------------------

const fixtureTree = () => {
  const fixture = buildFixture();
  return aggregateTree({
    sessions: fixture.sessions.filter((row) => row.id !== 'ses_other').map((row) => ({ ...row, depth: row.parent_id ? 1 : 0 })),
    messages: fixture.messages,
    parts: fixture.parts,
  });
};

const preflightBody = (agentName) => ({
  ok: true,
  findings: [{ severity: 'warning' }],
  contextBudget: {
    packagedAgentPrompts: { itemCount: 2, byteCount: 5000, items: [{ name: agentName, byteCount: 1234, source: 'packaged' }, { name: 'other', byteCount: 3766 }] },
    visibleSkillCatalogMetadata: { itemCount: 12, byteCount: 2400 },
    visibleOnDemandSkillBodies: { itemCount: 12, byteCount: 90_000 },
    tools: { mode: 'providerModel', rawItemCount: 40, uniqueItemCount: 38, duplicateOccurrenceByteCount: 800, ids: { itemCount: 40, byteCount: 600 }, descriptions: { byteCount: 20_000 }, parameters: { byteCount: 30_000 } },
    anthropic: { fixedPrefix: { originalBytes: 5000, transformedBytes: 4000 } },
  },
});

describe('preflight join', () => {
  it('summarizes the context budget for the requested agent', () => {
    const summary = summarizePreflightBody(preflightBody('orchestrator'), 'orchestrator');
    assert.equal(summary.ok, true);
    assert.equal(summary.findings, 1);
    assert.equal(summary.agentPromptBytes, 1234);
    assert.equal(summary.agentPromptSource, 'packaged');
    assert.deepEqual(summary.skillCatalog, { items: 12, bytes: 2400 });
    assert.deepEqual(summary.tools, { mode: 'providerModel', ids: 40, unique: 38, idBytes: 600, descriptionBytes: 20_000, parameterBytes: 30_000, duplicateBytes: 800 });
    assert.equal(summary.anthropicFixedPrefixBytes, 4000);
    assert.equal(summarizePreflightBody(null, 'x').agentPromptBytes, null);
  });

  it('asks once per (agent, provider, model) and records unavailable combos', async () => {
    const urls = [];
    const fetchJson = async (url) => {
      urls.push(url);
      const query = new URL(url).searchParams;
      if (query.get('agent') === 'compaction') return { ok: false, status: 500, body: null };
      return { ok: true, status: 200, body: preflightBody(query.get('agent')) };
    };
    const result = await collectPreflight({ server: 'http://127.0.0.1:3000', cookie: 'c', tree: fixtureTree(), fetchJson });
    assert.deepEqual(Object.keys(result).sort(), [
      'compaction|openai/gpt-5.6-sol',
      'designer|anthropic/claude-opus-4-8',
      'designer|openai/gpt-5.6-sol',
      'explorer|opencode/muse-spark',
      'orchestrator|openai/gpt-5.6-sol',
    ]);
    assert.equal(urls.length, 5);
    const orchestrator = new URL(urls.find((url) => url.includes('agent=orchestrator')));
    assert.equal(orchestrator.pathname, '/api/diagnostics/harness/preflight');
    assert.equal(orchestrator.searchParams.get('providerID'), 'openai');
    assert.equal(orchestrator.searchParams.get('modelID'), 'gpt-5.6-sol');
    assert.equal(orchestrator.searchParams.get('directory'), '/repo');
    assert.equal(orchestrator.searchParams.get('sessionID'), 'ses_root');
    assert.equal(result['orchestrator|openai/gpt-5.6-sol'].agentPromptBytes, 1234);
    assert.equal(result['designer|anthropic/claude-opus-4-8'].sessionId, 'ses_childB');
    assert.deepEqual(result['compaction|openai/gpt-5.6-sol'].available, false);
    assert.equal(result['compaction|openai/gpt-5.6-sol'].status, 500);
  });
});

describe('turn timing join', () => {
  it('joins recent records by assistant message id and summarizes durations', async () => {
    const fetchJson = async (url) => {
      const query = new URL(url).searchParams;
      assert.equal(new URL(url).pathname, '/api/diagnostics/turn-timing/recent');
      const records = {
        ses_root: [
          { sessionId: 'ses_root', assistantMessageId: 'msg_a1', durationsMs: { send_started_to_prompt_accepted: 120, prompt_accepted_to_first_text_delta: 800 } },
          { sessionId: 'ses_root', assistantMessageId: null, durationsMs: { send_started_to_prompt_accepted: 99_999 } },
        ],
        ses_childB: [
          { sessionId: 'ses_childB', assistantMessageId: 'msg_ba1', durationsMs: { send_started_to_prompt_accepted: 240 } },
          { sessionId: 'ses_childB', assistantMessageId: 'msg_unknown', durationsMs: { send_started_to_prompt_accepted: 5 } },
        ],
      }[query.get('sessionId')];
      if (!records) return { ok: false, status: 401, body: null };
      return { ok: true, status: 200, body: { records } };
    };
    const result = await collectTurnTiming({ server: 'http://127.0.0.1:3000', cookie: null, tree: fixtureTree(), fetchJson });
    assert.equal(result.sessionsQueried, 3);
    assert.equal(result.sessionsAnswered, 2);
    assert.equal(result.recordsSeen, 3);
    assert.equal(result.joined, 2);
    assert.equal(result.unjoined, 4);
    assert.deepEqual(result.bySession.ses_root, { assistantMessages: 3, joined: 1 });
    assert.deepEqual(result.durations.send_started_to_prompt_accepted, { n: 2, p50Ms: 120, p95Ms: 240, maxMs: 240 });
    assert.deepEqual(result.durations.prompt_accepted_to_first_text_delta, { n: 1, p50Ms: 800, p95Ms: 800, maxMs: 800 });
  });
});

describe('collectServerJoins', () => {
  const base = { server: 'http://127.0.0.1:3000', cookie: null };

  it('does nothing without a join flag', async () => {
    assert.equal(await collectServerJoins({ ...base, preflight: false, turnTiming: false }, fixtureTree(), { fetchJson: async () => { throw new Error('must not be called'); } }), null);
  });

  it('skips silently when the server is unreachable', async () => {
    const result = await collectServerJoins({ ...base, preflight: true, turnTiming: true }, fixtureTree(), { fetchJson: async () => ({ ok: false, status: 0, body: null, error: 'fetch_failed' }) });
    assert.deepEqual(result, { server: base.server, reachable: false, status: 0, preflight: null, turnTiming: null });
    const markdown = renderReport({
      generatedAt: 'now', run: 'r', db: { path: '/db', driver: 'node:sqlite', notes: [] }, elapsedMs: 1, tree: fixtureTree(), server: result,
    });
    assert.match(markdown, /unreachable \(status 0\); preflight\/turn-timing joins skipped/);
  });

  it('runs the requested joins when /api/health answers', async () => {
    const fetchJson = async (url) => {
      const { pathname, searchParams } = new URL(url);
      if (pathname === '/api/health') return { ok: true, status: 200, body: { openCodeVersion: '1.18.27' } };
      if (pathname === '/api/diagnostics/harness/preflight') return { ok: true, status: 200, body: preflightBody(searchParams.get('agent')) };
      if (pathname === '/api/diagnostics/turn-timing/recent') return { ok: true, status: 200, body: { records: [] } };
      throw new Error(`unexpected ${url}`);
    };
    const result = await collectServerJoins({ ...base, preflight: true, turnTiming: true }, fixtureTree(), { fetchJson });
    assert.equal(result.reachable, true);
    assert.equal(result.opencodeVersion, '1.18.27');
    assert.equal(Object.keys(result.preflight).length, 5);
    assert.equal(result.turnTiming.joined, 0);
    assert.equal(result.turnTiming.unjoined, 6);
    const markdown = renderReport({
      generatedAt: 'now', run: 'r', db: { path: '/db', driver: 'node:sqlite', notes: [] }, elapsedMs: 1, tree: fixtureTree(), server: result,
    });
    assert.match(markdown, /## Preflight join/);
    assert.match(markdown, /\| orchestrator \| openai\/gpt-5\.6-sol \| 200 \| 1\.2 KiB \| 12 \/ 2\.3 KiB \|/);
    assert.match(markdown, /## Turn timing join/);
  });
});
