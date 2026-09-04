#!/usr/bin/env node
// Session pipeline profiler: what one OpenCode session tree actually spent.
//
// Read-only by design. It opens ~/.local/share/opencode/opencode.db with
// { readonly: true, fileMustExist: true }, walks one root session plus every
// descendant (session.parent_id) and aggregates, per session and per tree:
// turns, assistant messages by provider/model, tokens by model, tool calls by
// name (count / errors / p50 / p95 ms / bytes), DEVRYAN_TOOL_INPUT_INVALID
// guard rejections by model, skill loads (including the same skill re-loaded
// across the children of one parent), MCP calls, classified bash commands and
// wall time. Output: .cache/perf/multi-session/<run>/pipeline/report.{md,json}.
//
//   node scripts/perf/session-pipeline-profile.mjs --session ses_x
//   node scripts/perf/session-pipeline-profile.mjs --session ses_x --run dozen --preflight --turn-timing
//
// --preflight joins GET /api/diagnostics/harness/preflight once per
// (agent, provider, model) seen in the tree (prompt + tool-catalog bytes) and
// --turn-timing joins GET /api/diagnostics/turn-timing/recent by assistant
// message id. Both ask the running DevRyan server (--server, default
// http://127.0.0.1:3000; --cookie or DEVRYAN_UI_SESSION_COOKIE for the
// oc_ui_session cookie) and are skipped silently when it is unreachable.
//
// better-sqlite3 is loaded from packages/web through createRequire; when its
// native binding was built for another Node ABI the built-in node:sqlite
// driver is used instead. Both open the database read-only.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const webPackageJson = path.join(repositoryRoot, 'packages/web/package.json');
const localRequire = createRequire(import.meta.url);

export const GUARD_REJECTION_PREFIX = 'DEVRYAN_TOOL_INPUT_INVALID:';
export const DEFAULT_DB_PATH = path.join(os.homedir(), '.local/share/opencode/opencode.db');
const COOKIE_NAME = 'oc_ui_session';
const GUARD_SAMPLE_LIMIT = 3;
const TURN_TIMING_PAGE = 500;

// OpenCode built-in tools (v1.18.x). Anything else with an underscore is an
// MCP tool (`<server>_<tool>`) unless it carries a DevRyan plugin prefix.
export const BUILTIN_TOOLS = new Set([
  'bash', 'shell', 'read', 'write', 'edit', 'multiedit', 'apply_patch', 'patch',
  'glob', 'grep', 'list', 'ls', 'stat', 'rm', 'mkdir', 'webfetch', 'websearch',
  'codesearch', 'todowrite', 'todoread', 'task', 'skill', 'question', 'lsp',
  'batch', 'invalid',
]);
const PLUGIN_TOOL_PREFIXES = ['devryan_', 'oc_'];
export const BASH_LIKE_TOOLS = new Set(['bash', 'shell', 'oc_bash']);
export const BASH_CLASSES = ['tsc', 'vitest', 'bun test', 'eslint', 'git', 'playwright', 'other'];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const parseJson = (value) => {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
};

const byteLength = (value) => {
  if (value == null) return 0;
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
};

export const percentile = (values, p) => {
  const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
};

export const classifyBashCommand = (command) => {
  const text = String(command ?? '').trim();
  if (!text) return 'other';
  if (/\bplaywright\b/.test(text)) return 'playwright';
  if (/\bvitest\b/.test(text)) return 'vitest';
  if (/\bbun\s+(?:run\s+)?test\b/.test(text)) return 'bun test';
  if (/\btsc\b/.test(text) || /\bbun\s+run\s+type-check\b/.test(text)) return 'tsc';
  if (/\beslint\b/.test(text) || /\bbun\s+run\s+lint\b/.test(text)) return 'eslint';
  if (/(?:^|[\s;&|(])git(?:\s|$)/.test(text)) return 'git';
  return 'other';
};

export const classifyToolFamily = (tool) => {
  const name = String(tool || '');
  if (BUILTIN_TOOLS.has(name)) return 'builtin';
  if (PLUGIN_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'plugin';
  if (name.includes('_')) return 'mcp';
  return 'builtin';
};

export const mcpServerName = (tool) => String(tool || '').split('_')[0] || 'unknown';

export const modelKey = (providerID, modelID) => `${providerID || '?'}/${modelID || '?'}`;

export const parseModelColumn = (value) => {
  const parsed = parseJson(value);
  if (parsed && typeof parsed === 'object') {
    return {
      providerID: parsed.providerID ?? null,
      modelID: parsed.id ?? parsed.modelID ?? null,
      variant: parsed.variant ?? null,
    };
  }
  if (typeof value === 'string' && value.includes('/')) {
    const [providerID, ...rest] = value.split('/');
    return { providerID, modelID: rest.join('/'), variant: null };
  }
  return { providerID: null, modelID: null, variant: null };
};

const normalizeTokens = (tokens) => ({
  input: toNumber(tokens?.input),
  output: toNumber(tokens?.output),
  reasoning: toNumber(tokens?.reasoning),
  cacheRead: toNumber(tokens?.cache?.read),
  cacheWrite: toNumber(tokens?.cache?.write),
  total: toNumber(tokens?.total),
});

export const normalizeSession = (row) => ({
  id: row.id,
  parentId: row.parent_id ?? row.parentId ?? null,
  depth: toNumber(row.depth),
  title: row.title ?? '',
  directory: row.directory ?? null,
  agent: row.agent ?? null,
  model: parseModelColumn(row.model),
  timeCreated: toNumber(row.time_created) || null,
  timeUpdated: toNumber(row.time_updated) || null,
  cost: toNumber(row.cost),
  tokens: {
    input: toNumber(row.tokens_input),
    output: toNumber(row.tokens_output),
    reasoning: toNumber(row.tokens_reasoning),
    cacheRead: toNumber(row.tokens_cache_read),
    cacheWrite: toNumber(row.tokens_cache_write),
  },
});

export const normalizeMessage = (row) => {
  const data = parseJson(row.data) || {};
  const model = data.model && typeof data.model === 'object' ? data.model : null;
  return {
    id: row.id,
    sessionId: row.session_id ?? row.sessionId ?? null,
    role: data.role || 'unknown',
    agent: data.agent ?? null,
    mode: data.mode ?? null,
    providerID: data.providerID ?? model?.providerID ?? null,
    modelID: data.modelID ?? model?.modelID ?? null,
    variant: data.variant ?? model?.variant ?? null,
    tokens: normalizeTokens(data.tokens),
    cost: toNumber(data.cost),
    timeCreated: toNumber(data.time?.created) || toNumber(row.time_created) || null,
    timeCompleted: toNumber(data.time?.completed) || null,
    finish: data.finish ?? null,
    summary: data.summary === true,
    parentID: data.parentID ?? null,
  };
};

export const normalizeToolPart = (row) => {
  const data = parseJson(row.data);
  if (!data || data.type !== 'tool') return null;
  const state = data.state && typeof data.state === 'object' ? data.state : {};
  const start = Number(state.time?.start);
  const end = Number(state.time?.end);
  const durationMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
  const isError = state.status === 'error';
  const errorText = [state.error, state.output]
    .find((value) => typeof value === 'string' && value.trimStart().startsWith(GUARD_REJECTION_PREFIX));
  const guardRejected = isError && typeof errorText === 'string';
  return {
    id: row.id,
    messageId: row.message_id ?? row.messageId ?? null,
    sessionId: row.session_id ?? row.sessionId ?? null,
    tool: data.tool || 'unknown',
    callId: data.callID ?? null,
    status: state.status ?? 'unknown',
    isError,
    guardRejected,
    guardMessage: guardRejected ? errorText.trim().slice(0, 200) : null,
    durationMs,
    inputBytes: byteLength(state.input),
    outputBytes: byteLength(state.output),
    input: state.input && typeof state.input === 'object' ? state.input : null,
    metadata: state.metadata && typeof state.metadata === 'object' ? state.metadata : null,
  };
};

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const createToolStats = () => ({ count: 0, errors: 0, guardRejections: 0, inputBytes: 0, outputBytes: 0, durations: [] });

const addToolCall = (stats, call) => {
  stats.count += 1;
  if (call.isError) stats.errors += 1;
  if (call.guardRejected) stats.guardRejections += 1;
  stats.inputBytes += call.inputBytes;
  stats.outputBytes += call.outputBytes;
  if (call.durationMs != null) stats.durations.push(call.durationMs);
};

const mergeToolStats = (into, from) => {
  into.count += from.count;
  into.errors += from.errors;
  into.guardRejections += from.guardRejections;
  into.inputBytes += from.inputBytes;
  into.outputBytes += from.outputBytes;
  into.durations.push(...from.durations);
};

const finalizeToolStats = (stats) => ({
  count: stats.count,
  errors: stats.errors,
  guardRejections: stats.guardRejections,
  inputBytes: stats.inputBytes,
  outputBytes: stats.outputBytes,
  timed: stats.durations.length,
  totalMs: stats.durations.reduce((total, value) => total + value, 0),
  p50Ms: percentile(stats.durations, 50),
  p95Ms: percentile(stats.durations, 95),
  maxMs: stats.durations.length ? Math.max(...stats.durations) : null,
});

const createRawAggregate = () => ({
  turns: 0,
  messages: { total: 0, user: 0, assistant: 0, compaction: 0, summaries: 0 },
  assistantMessageIds: [],
  assistantByModel: {},
  tokensByModel: {},
  toolCalls: { total: 0, errors: 0, guardRejections: 0, byName: {}, byFamily: {} },
  guardRejections: { total: 0, byModel: {} },
  skills: { loads: 0, bytes: 0, truncated: 0, byName: {} },
  mcp: { total: 0, errors: 0, byServer: {}, byTool: {} },
  bash: { total: 0, errors: 0, byClass: {} },
  parts: { byType: {} },
  wall: { startedAt: null, endedAt: null, wallMs: null, assistantActiveMs: 0, firstMessageAt: null, lastMessageAt: null },
});

const minTime = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
const maxTime = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));

const collectSession = (session, messages, toolCalls, partStats) => {
  const raw = createRawAggregate();
  const messagesById = new Map();
  for (const message of messages) {
    messagesById.set(message.id, message);
    raw.messages.total += 1;
    raw.wall.firstMessageAt = minTime(raw.wall.firstMessageAt, message.timeCreated);
    raw.wall.lastMessageAt = maxTime(raw.wall.lastMessageAt, message.timeCompleted ?? message.timeCreated);
    if (message.role === 'user') {
      raw.messages.user += 1;
      if (message.summary) raw.messages.summaries += 1;
      else raw.turns += 1;
      continue;
    }
    if (message.role !== 'assistant') continue;
    raw.messages.assistant += 1;
    raw.assistantMessageIds.push(message.id);
    if (message.agent === 'compaction' || message.mode === 'compaction') raw.messages.compaction += 1;
    const key = modelKey(message.providerID, message.modelID);
    const byModel = raw.assistantByModel[key] || (raw.assistantByModel[key] = {
      providerID: message.providerID, modelID: message.modelID, count: 0, agents: new Set(),
    });
    byModel.count += 1;
    if (message.agent) byModel.agents.add(message.agent);
    const tokens = raw.tokensByModel[key] || (raw.tokensByModel[key] = {
      messages: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0,
    });
    tokens.messages += 1;
    for (const field of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'total']) tokens[field] += message.tokens[field];
    if (message.timeCreated && message.timeCompleted && message.timeCompleted >= message.timeCreated) {
      raw.wall.assistantActiveMs += message.timeCompleted - message.timeCreated;
    }
  }

  for (const call of toolCalls) {
    const family = classifyToolFamily(call.tool);
    raw.toolCalls.total += 1;
    if (call.isError) raw.toolCalls.errors += 1;
    if (call.guardRejected) raw.toolCalls.guardRejections += 1;
    addToolCall(raw.toolCalls.byName[call.tool] || (raw.toolCalls.byName[call.tool] = createToolStats()), call);
    addToolCall(raw.toolCalls.byFamily[family] || (raw.toolCalls.byFamily[family] = createToolStats()), call);

    if (call.guardRejected) {
      const message = messagesById.get(call.messageId);
      const key = modelKey(message?.providerID, message?.modelID);
      const bucket = raw.guardRejections.byModel[key] || (raw.guardRejections.byModel[key] = { count: 0, byTool: {}, samples: [] });
      raw.guardRejections.total += 1;
      bucket.count += 1;
      bucket.byTool[call.tool] = (bucket.byTool[call.tool] || 0) + 1;
      if (bucket.samples.length < GUARD_SAMPLE_LIMIT) bucket.samples.push({ tool: call.tool, message: call.guardMessage });
    }

    if (call.tool === 'skill') {
      const name = call.input?.name || call.metadata?.name || 'unknown';
      const skill = raw.skills.byName[name] || (raw.skills.byName[name] = { count: 0, bytes: 0, truncated: 0, errors: 0, dir: null });
      raw.skills.loads += 1;
      raw.skills.bytes += call.outputBytes;
      skill.count += 1;
      skill.bytes += call.outputBytes;
      if (call.isError) skill.errors += 1;
      if (call.metadata?.truncated === true) { skill.truncated += 1; raw.skills.truncated += 1; }
      if (!skill.dir && typeof call.metadata?.dir === 'string') skill.dir = call.metadata.dir;
    }

    if (family === 'mcp') {
      const server = mcpServerName(call.tool);
      const bucket = raw.mcp.byServer[server] || (raw.mcp.byServer[server] = createToolStats());
      raw.mcp.total += 1;
      if (call.isError) raw.mcp.errors += 1;
      addToolCall(bucket, call);
      raw.mcp.byTool[call.tool] = (raw.mcp.byTool[call.tool] || 0) + 1;
    }

    if (BASH_LIKE_TOOLS.has(call.tool)) {
      const cls = classifyBashCommand(call.input?.command);
      raw.bash.total += 1;
      if (call.isError) raw.bash.errors += 1;
      addToolCall(raw.bash.byClass[cls] || (raw.bash.byClass[cls] = createToolStats()), call);
    }
  }

  for (const stat of partStats) {
    const type = stat.type || 'unknown';
    const bucket = raw.parts.byType[type] || (raw.parts.byType[type] = { count: 0, chars: 0 });
    bucket.count += toNumber(stat.count);
    bucket.chars += toNumber(stat.chars);
  }

  raw.wall.startedAt = session.timeCreated;
  raw.wall.endedAt = session.timeUpdated;
  raw.wall.wallMs = session.timeCreated && session.timeUpdated ? Math.max(0, session.timeUpdated - session.timeCreated) : null;
  return raw;
};

const mergeCounters = (into, from) => {
  for (const [key, value] of Object.entries(from)) into[key] = (into[key] || 0) + value;
};

const mergeAggregates = (into, from) => {
  into.turns += from.turns;
  mergeCounters(into.messages, from.messages);
  into.assistantMessageIds.push(...from.assistantMessageIds);
  for (const [key, value] of Object.entries(from.assistantByModel)) {
    const bucket = into.assistantByModel[key] || (into.assistantByModel[key] = {
      providerID: value.providerID, modelID: value.modelID, count: 0, agents: new Set(),
    });
    bucket.count += value.count;
    for (const agent of value.agents) bucket.agents.add(agent);
  }
  for (const [key, value] of Object.entries(from.tokensByModel)) {
    const bucket = into.tokensByModel[key] || (into.tokensByModel[key] = {
      messages: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0,
    });
    mergeCounters(bucket, value);
  }
  into.toolCalls.total += from.toolCalls.total;
  into.toolCalls.errors += from.toolCalls.errors;
  into.toolCalls.guardRejections += from.toolCalls.guardRejections;
  for (const group of ['byName', 'byFamily']) {
    for (const [key, value] of Object.entries(from.toolCalls[group])) {
      mergeToolStats(into.toolCalls[group][key] || (into.toolCalls[group][key] = createToolStats()), value);
    }
  }
  into.guardRejections.total += from.guardRejections.total;
  for (const [key, value] of Object.entries(from.guardRejections.byModel)) {
    const bucket = into.guardRejections.byModel[key] || (into.guardRejections.byModel[key] = { count: 0, byTool: {}, samples: [] });
    bucket.count += value.count;
    mergeCounters(bucket.byTool, value.byTool);
    for (const sample of value.samples) if (bucket.samples.length < GUARD_SAMPLE_LIMIT) bucket.samples.push(sample);
  }
  into.skills.loads += from.skills.loads;
  into.skills.bytes += from.skills.bytes;
  into.skills.truncated += from.skills.truncated;
  for (const [name, value] of Object.entries(from.skills.byName)) {
    const bucket = into.skills.byName[name] || (into.skills.byName[name] = { count: 0, bytes: 0, truncated: 0, errors: 0, dir: null });
    bucket.count += value.count;
    bucket.bytes += value.bytes;
    bucket.truncated += value.truncated;
    bucket.errors += value.errors;
    if (!bucket.dir) bucket.dir = value.dir;
  }
  into.mcp.total += from.mcp.total;
  into.mcp.errors += from.mcp.errors;
  for (const [server, value] of Object.entries(from.mcp.byServer)) {
    mergeToolStats(into.mcp.byServer[server] || (into.mcp.byServer[server] = createToolStats()), value);
  }
  mergeCounters(into.mcp.byTool, from.mcp.byTool);
  into.bash.total += from.bash.total;
  into.bash.errors += from.bash.errors;
  for (const [cls, value] of Object.entries(from.bash.byClass)) {
    mergeToolStats(into.bash.byClass[cls] || (into.bash.byClass[cls] = createToolStats()), value);
  }
  for (const [type, value] of Object.entries(from.parts.byType)) {
    const bucket = into.parts.byType[type] || (into.parts.byType[type] = { count: 0, chars: 0 });
    bucket.count += value.count;
    bucket.chars += value.chars;
  }
  into.wall.startedAt = minTime(into.wall.startedAt, from.wall.startedAt);
  into.wall.endedAt = maxTime(into.wall.endedAt, from.wall.endedAt);
  into.wall.wallMs = into.wall.startedAt != null && into.wall.endedAt != null ? Math.max(0, into.wall.endedAt - into.wall.startedAt) : null;
  into.wall.assistantActiveMs += from.wall.assistantActiveMs;
  into.wall.firstMessageAt = minTime(into.wall.firstMessageAt, from.wall.firstMessageAt);
  into.wall.lastMessageAt = maxTime(into.wall.lastMessageAt, from.wall.lastMessageAt);
};

const sortEntries = (object, rank) => Object.fromEntries(Object.entries(object).sort((a, b) => rank(b[1]) - rank(a[1]) || a[0].localeCompare(b[0])));
const mapValues = (object, mapper) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, mapper(value)]));

const finalizeAggregate = (raw) => ({
  turns: raw.turns,
  messages: { ...raw.messages },
  assistantMessageIds: [...raw.assistantMessageIds],
  assistantByModel: sortEntries(mapValues(raw.assistantByModel, (value) => ({
    providerID: value.providerID, modelID: value.modelID, count: value.count, agents: [...value.agents].sort(),
  })), (value) => value.count),
  tokensByModel: sortEntries(mapValues(raw.tokensByModel, (value) => ({ ...value })), (value) => value.input + value.cacheRead),
  toolCalls: {
    total: raw.toolCalls.total,
    errors: raw.toolCalls.errors,
    guardRejections: raw.toolCalls.guardRejections,
    byName: sortEntries(mapValues(raw.toolCalls.byName, finalizeToolStats), (value) => value.count),
    byFamily: sortEntries(mapValues(raw.toolCalls.byFamily, finalizeToolStats), (value) => value.count),
  },
  guardRejections: {
    total: raw.guardRejections.total,
    byModel: sortEntries(mapValues(raw.guardRejections.byModel, (value) => ({
      count: value.count, byTool: { ...value.byTool }, samples: value.samples.map((sample) => ({ ...sample })),
    })), (value) => value.count),
  },
  skills: {
    loads: raw.skills.loads,
    bytes: raw.skills.bytes,
    truncated: raw.skills.truncated,
    byName: sortEntries(mapValues(raw.skills.byName, (value) => ({ ...value })), (value) => value.count),
    repeated: Object.entries(raw.skills.byName)
      .filter(([, value]) => value.count >= 2)
      .map(([name, value]) => ({ name, count: value.count, bytes: value.bytes }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  },
  mcp: {
    total: raw.mcp.total,
    errors: raw.mcp.errors,
    byServer: sortEntries(mapValues(raw.mcp.byServer, finalizeToolStats), (value) => value.count),
    byTool: sortEntries({ ...raw.mcp.byTool }, (value) => value),
  },
  bash: {
    total: raw.bash.total,
    errors: raw.bash.errors,
    byClass: Object.fromEntries(BASH_CLASSES
      .filter((cls) => raw.bash.byClass[cls])
      .map((cls) => [cls, finalizeToolStats(raw.bash.byClass[cls])])),
  },
  parts: { byType: sortEntries(mapValues(raw.parts.byType, (value) => ({ ...value })), (value) => value.chars) },
  wall: { ...raw.wall },
});

const groupBy = (rows, keyOf) => {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
};

// `rows` are plain session/message/part records as read from the OpenCode
// database (data may be JSON text or already-parsed objects). Only tool parts
// matter; other part rows are ignored. partStats is optional:
// [{ session_id, type, count, chars }].
export const aggregateTree = ({ sessions, messages, parts, partStats = [] }) => {
  const normalizedSessions = sessions.map(normalizeSession)
    .sort((a, b) => a.depth - b.depth || (a.timeCreated ?? 0) - (b.timeCreated ?? 0) || a.id.localeCompare(b.id));
  if (normalizedSessions.length === 0) throw new Error('aggregateTree needs at least one session');
  const messagesBySession = groupBy(messages.map(normalizeMessage), (message) => message.sessionId);
  const callsBySession = groupBy(parts.map(normalizeToolPart).filter(Boolean), (call) => call.sessionId);
  const statsBySession = groupBy(partStats, (stat) => stat.session_id ?? stat.sessionId);

  const perSession = normalizedSessions.map((session) => ({
    session,
    raw: collectSession(
      session,
      (messagesBySession.get(session.id) || []).sort((a, b) => (a.timeCreated ?? 0) - (b.timeCreated ?? 0) || a.id.localeCompare(b.id)),
      callsBySession.get(session.id) || [],
      statsBySession.get(session.id) || [],
    ),
  }));

  const totals = createRawAggregate();
  for (const entry of perSession) mergeAggregates(totals, entry.raw);

  const skillReloads = [];
  for (const parent of perSession) {
    const children = perSession.filter((entry) => entry.session.parentId === parent.session.id);
    if (children.length === 0) continue;
    const names = new Set();
    for (const entry of [parent, ...children]) for (const name of Object.keys(entry.raw.skills.byName)) names.add(name);
    for (const name of [...names].sort()) {
      const bySession = {};
      let totalLoads = 0;
      let bytes = 0;
      let childLoads = 0;
      for (const entry of [parent, ...children]) {
        const skill = entry.raw.skills.byName[name];
        if (!skill) continue;
        bySession[entry.session.id] = skill.count;
        totalLoads += skill.count;
        bytes += skill.bytes;
        if (entry !== parent) childLoads += skill.count;
      }
      if (totalLoads >= 2) skillReloads.push({ name, parentId: parent.session.id, totalLoads, childLoads, bytes, bySession });
    }
  }
  skillReloads.sort((a, b) => b.totalLoads - a.totalLoads || a.name.localeCompare(b.name));

  return {
    rootId: normalizedSessions[0].id,
    sessionCount: normalizedSessions.length,
    maxDepth: Math.max(...normalizedSessions.map((session) => session.depth)),
    sessions: perSession.map(({ session, raw }) => ({
      id: session.id,
      parentId: session.parentId,
      depth: session.depth,
      title: session.title,
      directory: session.directory,
      agent: session.agent,
      model: modelKey(session.model.providerID, session.model.modelID),
      variant: session.model.variant,
      cost: session.cost,
      tokensRollup: { ...session.tokens },
      ...finalizeAggregate(raw),
    })),
    totals: finalizeAggregate(totals),
    skillReloads,
  };
};

// ---------------------------------------------------------------------------
// Database access (read-only)
// ---------------------------------------------------------------------------

const wrapDriver = (driver, db) => ({
  driver,
  all: (sql, params = []) => db.prepare(sql).all(...params),
  get: (sql, params = []) => db.prepare(sql).get(...params),
  close: () => db.close(),
});

export const openSessionDatabase = (dbPath, { requireBetterSqlite = () => createRequire(webPackageJson)('better-sqlite3') } = {}) => {
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  const notes = [];
  try {
    const Database = requireBetterSqlite();
    return { ...wrapDriver('better-sqlite3', new Database(dbPath, { readonly: true, fileMustExist: true })), notes };
  } catch (error) {
    notes.push(`better-sqlite3 unavailable: ${String(error?.message || error).split('\n')[0]}`);
  }
  try {
    const { DatabaseSync } = localRequire('node:sqlite');
    return { ...wrapDriver('node:sqlite', new DatabaseSync(dbPath, { readOnly: true })), notes };
  } catch (error) {
    notes.push(`node:sqlite unavailable: ${String(error?.message || error).split('\n')[0]}`);
  }
  throw new Error(`No SQLite driver could open ${dbPath} read-only (${notes.join('; ')})`);
};

export const TREE_QUERY = `
  WITH RECURSIVE tree(id, depth) AS (
    SELECT id, 0 FROM session WHERE id = ?
    UNION ALL
    SELECT s.id, tree.depth + 1 FROM session s JOIN tree ON s.parent_id = tree.id
  )
  SELECT s.id, s.parent_id, s.title, s.directory, s.agent, s.model, s.cost,
         s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write,
         s.time_created, s.time_updated, tree.depth
  FROM tree JOIN session s ON s.id = tree.id
  ORDER BY tree.depth, s.time_created, s.id`;

const MESSAGES_QUERY = 'SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created, id';
const TOOL_PARTS_QUERY = "SELECT id, message_id, session_id, data FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' ORDER BY time_created, id";
const PART_STATS_QUERY = "SELECT session_id, json_extract(data, '$.type') AS type, COUNT(*) AS count, SUM(LENGTH(data)) AS chars FROM part WHERE session_id = ? GROUP BY 1, 2";

export const loadSessionTree = (db, rootId) => {
  const sessions = db.all(TREE_QUERY, [rootId]);
  if (sessions.length === 0) throw new Error(`Session ${rootId} not found`);
  const messages = [];
  const parts = [];
  const partStats = [];
  for (const session of sessions) {
    messages.push(...db.all(MESSAGES_QUERY, [session.id]));
    parts.push(...db.all(TOOL_PARTS_QUERY, [session.id]));
    partStats.push(...db.all(PART_STATS_QUERY, [session.id]));
  }
  return { sessions, messages, parts, partStats };
};

// ---------------------------------------------------------------------------
// Optional DevRyan server joins
// ---------------------------------------------------------------------------

export const fetchJson = async (url, { cookie = null, timeoutMs = 8000 } = {}) => {
  const headers = { accept: 'application/json' };
  if (cookie) headers.cookie = `${COOKIE_NAME}=${cookie}`;
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: error?.name || 'fetch_failed' };
  }
};

export const summarizePreflightBody = (body, agent) => {
  const budget = body?.contextBudget && typeof body.contextBudget === 'object' ? body.contextBudget : {};
  const promptItem = (budget.packagedAgentPrompts?.items || []).find((item) => item?.name === agent) || null;
  const tools = budget.tools || {};
  return {
    ok: body?.ok === true,
    findings: Array.isArray(body?.findings) ? body.findings.length : null,
    agentPromptBytes: promptItem?.byteCount ?? null,
    agentPromptSource: promptItem?.source ?? null,
    packagedPromptBytes: budget.packagedAgentPrompts?.byteCount ?? null,
    skillCatalog: { items: budget.visibleSkillCatalogMetadata?.itemCount ?? null, bytes: budget.visibleSkillCatalogMetadata?.byteCount ?? null },
    skillBodies: { items: budget.visibleOnDemandSkillBodies?.itemCount ?? null, bytes: budget.visibleOnDemandSkillBodies?.byteCount ?? null },
    tools: {
      mode: tools.mode ?? null,
      ids: tools.ids?.itemCount ?? null,
      unique: tools.uniqueItemCount ?? null,
      idBytes: tools.ids?.byteCount ?? null,
      descriptionBytes: tools.descriptions?.byteCount ?? null,
      parameterBytes: tools.parameters?.byteCount ?? null,
      duplicateBytes: tools.duplicateOccurrenceByteCount ?? null,
    },
    anthropicFixedPrefixBytes: budget.anthropic?.fixedPrefix?.transformedBytes ?? null,
  };
};

export const collectPreflight = async ({ server, cookie, tree, fetchJson: fetchJsonImpl = fetchJson }) => {
  const combos = new Map();
  for (const session of tree.sessions) {
    for (const entry of Object.values(session.assistantByModel)) {
      for (const agent of entry.agents.length ? entry.agents : [session.agent || 'unknown']) {
        const key = `${agent}|${modelKey(entry.providerID, entry.modelID)}`;
        if (!combos.has(key)) {
          combos.set(key, { agent, providerID: entry.providerID, modelID: entry.modelID, sessionId: session.id, directory: session.directory });
        }
      }
    }
  }
  const results = {};
  for (const [key, combo] of combos) {
    const query = new URLSearchParams();
    query.set('agent', combo.agent);
    if (combo.providerID && combo.modelID) { query.set('providerID', combo.providerID); query.set('modelID', combo.modelID); }
    if (combo.directory) query.set('directory', combo.directory);
    query.set('sessionID', combo.sessionId);
    const response = await fetchJsonImpl(`${server}/api/diagnostics/harness/preflight?${query}`, { cookie, timeoutMs: 20_000 });
    results[key] = response.ok
      ? { ...combo, available: true, status: response.status, ...summarizePreflightBody(response.body, combo.agent) }
      : { ...combo, available: false, status: response.status, error: response.error ?? null };
  }
  return results;
};

export const collectTurnTiming = async ({ server, cookie, tree, fetchJson: fetchJsonImpl = fetchJson }) => {
  const records = new Map();
  let sessionsAnswered = 0;
  for (const session of tree.sessions) {
    const query = new URLSearchParams({ sessionId: session.id, limit: String(TURN_TIMING_PAGE) });
    const response = await fetchJsonImpl(`${server}/api/diagnostics/turn-timing/recent?${query}`, { cookie });
    if (!response.ok) continue;
    sessionsAnswered += 1;
    for (const record of Array.isArray(response.body?.records) ? response.body.records : []) {
      if (record?.assistantMessageId) records.set(record.assistantMessageId, record);
    }
  }
  const durations = {};
  let joined = 0;
  let unjoined = 0;
  const bySession = {};
  for (const session of tree.sessions) {
    let sessionJoined = 0;
    for (const messageId of session.assistantMessageIds) {
      const record = records.get(messageId);
      if (!record) { unjoined += 1; continue; }
      joined += 1;
      sessionJoined += 1;
      for (const [name, value] of Object.entries(record.durationsMs || {})) {
        if (typeof value === 'number' && Number.isFinite(value)) (durations[name] || (durations[name] = [])).push(value);
      }
    }
    bySession[session.id] = { assistantMessages: session.assistantMessageIds.length, joined: sessionJoined };
  }
  return {
    sessionsQueried: tree.sessions.length,
    sessionsAnswered,
    recordsSeen: records.size,
    joined,
    unjoined,
    bySession,
    durations: sortEntries(mapValues(durations, (values) => ({
      n: values.length, p50Ms: percentile(values, 50), p95Ms: percentile(values, 95), maxMs: Math.max(...values),
    })), (value) => value.n),
  };
};

export const collectServerJoins = async (options, tree, { fetchJson: fetchJsonImpl = fetchJson } = {}) => {
  if (!options.preflight && !options.turnTiming) return null;
  const health = await fetchJsonImpl(`${options.server}/api/health`, { timeoutMs: 4000 });
  if (!health.ok) return { server: options.server, reachable: false, status: health.status, preflight: null, turnTiming: null };
  const shared = { server: options.server, cookie: options.cookie, tree, fetchJson: fetchJsonImpl };
  return {
    server: options.server,
    reachable: true,
    status: health.status,
    opencodeVersion: health.body?.openCodeVersion ?? null,
    preflight: options.preflight ? await collectPreflight(shared) : null,
    turnTiming: options.turnTiming ? await collectTurnTiming(shared) : null,
  };
};

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

const fmtInt = (value) => (value == null ? '–' : Math.round(value).toLocaleString('en-US'));
const fmtMs = (ms) => {
  if (ms == null) return '–';
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(2)} h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
};
export const formatBytes = (bytes) => {
  if (bytes == null) return '–';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${Math.round(bytes)} B`;
};
const fmtTime = (ms) => (ms == null ? '–' : new Date(ms).toISOString());
const escapeCell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const table = (headers, rows) => {
  if (rows.length === 0) return ['_none_', ''];
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
    '',
  ];
};

const toolRows = (byName, { limit = Infinity, family = false } = {}) => Object.entries(byName).slice(0, limit).map(([name, stats]) => [
  family ? `${name} (${classifyToolFamily(name)})` : name,
  fmtInt(stats.count), fmtInt(stats.errors), fmtInt(stats.guardRejections),
  fmtMs(stats.p50Ms), fmtMs(stats.p95Ms), fmtMs(stats.totalMs),
  formatBytes(stats.inputBytes), formatBytes(stats.outputBytes),
]);
const TOOL_HEADERS = ['tool', 'calls', 'errors', 'guard', 'p50', 'p95', 'total', 'input', 'output'];

const tokenRows = (tokensByModel) => Object.entries(tokensByModel).map(([key, value]) => [
  key, fmtInt(value.messages), fmtInt(value.input), fmtInt(value.output), fmtInt(value.reasoning),
  fmtInt(value.cacheRead), fmtInt(value.cacheWrite), fmtInt(value.input + value.output + value.reasoning + value.cacheRead + value.cacheWrite),
]);
const TOKEN_HEADERS = ['provider/model', 'messages', 'input', 'output', 'reasoning', 'cache read', 'cache write', 'sum'];

const renderAggregateSections = (aggregate, { heading, toolLimit, summed = false }) => {
  const lines = [];
  lines.push(`${heading} Messages and tokens`, '');
  lines.push(`- turns (user prompts): ${fmtInt(aggregate.turns)}; assistant messages: ${fmtInt(aggregate.messages.assistant)} (compaction ${fmtInt(aggregate.messages.compaction)}); summary prompts: ${fmtInt(aggregate.messages.summaries)}`);
  lines.push(`- wall ${fmtMs(aggregate.wall.wallMs)} (${fmtTime(aggregate.wall.startedAt)} → ${fmtTime(aggregate.wall.endedAt)}); assistant active ${fmtMs(aggregate.wall.assistantActiveMs)}${summed ? ' (summed over sessions; concurrent children overlap, so it can exceed wall)' : ''}`);
  lines.push('');
  lines.push(...table(['provider/model', 'assistant messages', 'agents'], Object.entries(aggregate.assistantByModel)
    .map(([key, value]) => [key, fmtInt(value.count), value.agents.join(', ')])));
  lines.push(...table(TOKEN_HEADERS, tokenRows(aggregate.tokensByModel)));
  lines.push(`${heading} Tool calls`, '');
  lines.push(`- ${fmtInt(aggregate.toolCalls.total)} calls, ${fmtInt(aggregate.toolCalls.errors)} errors, ${fmtInt(aggregate.toolCalls.guardRejections)} guard rejections; by family: ${Object.entries(aggregate.toolCalls.byFamily).map(([family, stats]) => `${family} ${fmtInt(stats.count)}`).join(', ') || 'none'}`);
  lines.push('');
  lines.push(...table(TOOL_HEADERS, toolRows(aggregate.toolCalls.byName, { limit: toolLimit })));
  lines.push(`${heading} Guard rejections (${GUARD_REJECTION_PREFIX.slice(0, -1)})`, '');
  lines.push(...table(['provider/model', 'rejections', 'by tool', 'sample'], Object.entries(aggregate.guardRejections.byModel)
    .map(([key, value]) => [
      key, fmtInt(value.count),
      Object.entries(value.byTool).map(([tool, count]) => `${tool}×${count}`).join(', '),
      value.samples[0] ? value.samples[0].message : '',
    ])));
  lines.push(`${heading} Skill loads`, '');
  lines.push(`- ${fmtInt(aggregate.skills.loads)} loads, ${formatBytes(aggregate.skills.bytes)} of SKILL.md text returned to the model, ${fmtInt(aggregate.skills.truncated)} truncated`);
  lines.push('');
  lines.push(...table(['skill', 'loads', 'bytes', 'truncated', 'errors', 'dir'], Object.entries(aggregate.skills.byName)
    .map(([name, value]) => [name, fmtInt(value.count), formatBytes(value.bytes), fmtInt(value.truncated), fmtInt(value.errors), value.dir || ''])));
  lines.push(`${heading} MCP calls`, '');
  lines.push(...table(['server', 'calls', 'errors', 'p50', 'p95', 'total', 'tools'], Object.entries(aggregate.mcp.byServer)
    .map(([server, stats]) => [
      server, fmtInt(stats.count), fmtInt(stats.errors), fmtMs(stats.p50Ms), fmtMs(stats.p95Ms), fmtMs(stats.totalMs),
      Object.entries(aggregate.mcp.byTool).filter(([tool]) => mcpServerName(tool) === server).map(([tool, count]) => `${tool}×${count}`).join(', '),
    ])));
  lines.push(`${heading} Bash by class`, '');
  lines.push(...table(['class', 'calls', 'errors', 'p50', 'p95', 'total'], Object.entries(aggregate.bash.byClass)
    .map(([cls, stats]) => [cls, fmtInt(stats.count), fmtInt(stats.errors), fmtMs(stats.p50Ms), fmtMs(stats.p95Ms), fmtMs(stats.totalMs)])));
  return lines;
};

export const renderReport = (profile) => {
  const { tree } = profile;
  const root = tree.sessions[0];
  const lines = [];
  lines.push(`# Session pipeline profile — ${root.title || root.id}`, '');
  lines.push(`- root session: \`${root.id}\` (${root.agent || '?'} · ${root.model}); ${fmtInt(tree.sessionCount)} sessions, max depth ${tree.maxDepth}`);
  lines.push(`- database: ${profile.db.path} (driver ${profile.db.driver}${profile.db.notes.length ? `; ${profile.db.notes.join('; ')}` : ''})`);
  lines.push(`- generated ${profile.generatedAt} in ${fmtMs(profile.elapsedMs)}; run \`${profile.run}\``);
  if (profile.server) {
    lines.push(profile.server.reachable
      ? `- server ${profile.server.server}: reachable (opencode ${profile.server.opencodeVersion ?? '?'})`
      : `- server ${profile.server.server}: unreachable (status ${profile.server.status}); preflight/turn-timing joins skipped`);
  }
  lines.push('');
  lines.push('## Tree totals', '');
  lines.push(...renderAggregateSections(tree.totals, { heading: '###', toolLimit: Infinity, summed: true }));
  lines.push('### Repeated skill loads across one parent and its children', '');
  lines.push(...table(['skill', 'parent', 'loads', 'in children', 'bytes', 'by session'], tree.skillReloads.map((entry) => [
    entry.name, entry.parentId, fmtInt(entry.totalLoads), fmtInt(entry.childLoads), formatBytes(entry.bytes),
    Object.entries(entry.bySession).map(([id, count]) => `${id}×${count}`).join(', '),
  ])));
  lines.push('### Part rows by type', '');
  lines.push(...table(['type', 'rows', 'chars'], Object.entries(tree.totals.parts.byType)
    .map(([type, value]) => [type, fmtInt(value.count), fmtInt(value.chars)])));

  lines.push('## Sessions', '');
  lines.push(...table(['depth', 'session', 'agent', 'model', 'turns', 'assistant msgs', 'tool calls', 'errors', 'guard', 'skills', 'wall', 'active'],
    tree.sessions.map((session) => [
      session.depth, `${session.id} ${session.title}`, session.agent || '', session.model, fmtInt(session.turns),
      fmtInt(session.messages.assistant), fmtInt(session.toolCalls.total), fmtInt(session.toolCalls.errors),
      fmtInt(session.guardRejections.total), fmtInt(session.skills.loads), fmtMs(session.wall.wallMs), fmtMs(session.wall.assistantActiveMs),
    ])));
  for (const session of tree.sessions) {
    lines.push(`### ${'  '.repeat(session.depth)}${session.agent || '?'} · ${session.model} · ${session.title || session.id}`, '');
    lines.push(`- id \`${session.id}\`${session.parentId ? `, parent \`${session.parentId}\`` : ''}, depth ${session.depth}, variant ${session.variant || '–'}`);
    lines.push(`- session rollup: input ${fmtInt(session.tokensRollup.input)}, output ${fmtInt(session.tokensRollup.output)}, reasoning ${fmtInt(session.tokensRollup.reasoning)}, cache read ${fmtInt(session.tokensRollup.cacheRead)}, cache write ${fmtInt(session.tokensRollup.cacheWrite)}, cost ${session.cost}`);
    lines.push('');
    lines.push(...renderAggregateSections(session, { heading: '####', toolLimit: 15 }));
  }

  if (profile.server?.preflight) {
    lines.push('## Preflight join (/api/diagnostics/harness/preflight)', '');
    lines.push(...table(['agent', 'provider/model', 'status', 'agent prompt', 'skill catalog', 'skill bodies', 'tool ids', 'tool descriptions', 'tool params', 'findings'],
      Object.values(profile.server.preflight).map((entry) => (entry.available
        ? [entry.agent, modelKey(entry.providerID, entry.modelID), String(entry.status), formatBytes(entry.agentPromptBytes),
          `${fmtInt(entry.skillCatalog.items)} / ${formatBytes(entry.skillCatalog.bytes)}`, `${fmtInt(entry.skillBodies.items)} / ${formatBytes(entry.skillBodies.bytes)}`,
          `${fmtInt(entry.tools.ids)} (${fmtInt(entry.tools.unique)} unique) / ${formatBytes(entry.tools.idBytes)}`,
          formatBytes(entry.tools.descriptionBytes), formatBytes(entry.tools.parameterBytes), fmtInt(entry.findings)]
        : [entry.agent, modelKey(entry.providerID, entry.modelID), `unavailable (${entry.status}${entry.error ? ` ${entry.error}` : ''})`, '', '', '', '', '', '', '']))));
  }
  if (profile.server?.turnTiming) {
    const timing = profile.server.turnTiming;
    lines.push('## Turn timing join (/api/diagnostics/turn-timing/recent)', '');
    lines.push(`- sessions answered ${fmtInt(timing.sessionsAnswered)}/${fmtInt(timing.sessionsQueried)}; records ${fmtInt(timing.recordsSeen)}; assistant messages joined ${fmtInt(timing.joined)}, unjoined ${fmtInt(timing.unjoined)}`);
    lines.push('');
    lines.push(...table(['duration', 'n', 'p50', 'p95', 'max'], Object.entries(timing.durations)
      .map(([name, value]) => [name, fmtInt(value.n), fmtMs(value.p50Ms), fmtMs(value.p95Ms), fmtMs(value.maxMs)])));
  }
  return `${lines.join('\n').trimEnd()}\n`;
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const parseProfileArguments = (argv, env = process.env) => {
  const options = {
    sessionId: null,
    dbPath: env.OPENCODE_DB_PATH || DEFAULT_DB_PATH,
    run: new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
    outRoot: path.join(repositoryRoot, '.cache/perf/multi-session'),
    server: 'http://127.0.0.1:3000',
    cookie: env.DEVRYAN_UI_SESSION_COOKIE || null,
    preflight: false,
    turnTiming: false,
    quiet: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };
    switch (flag) {
      case '--session': options.sessionId = takeValue(); break;
      case '--db': options.dbPath = path.resolve(takeValue().replace(/^~(?=$|\/)/, os.homedir())); break;
      case '--run': case '--label': options.run = takeValue(); break;
      case '--out': options.outRoot = path.resolve(takeValue()); break;
      case '--server': options.server = takeValue().replace(/\/+$/, ''); break;
      case '--cookie': options.cookie = takeValue(); break;
      case '--preflight': options.preflight = true; break;
      case '--turn-timing': options.turnTiming = true; break;
      case '--quiet': options.quiet = true; break;
      case '--help': case '-h': options.help = true; break;
      default: throw new Error(`Unknown flag ${flag}`);
    }
  }
  if (!/^[A-Za-z0-9._-]+$/.test(options.run)) throw new Error('--run may only contain letters, digits, ., _ and -');
  if (!options.help && !options.sessionId) throw new Error('--session <ses_id> is required');
  return options;
};

const HELP = `Usage: node scripts/perf/session-pipeline-profile.mjs --session <ses_id> [options]

  --session <id>     root session to profile (its descendants are included)
  --db <path>        OpenCode database (default ~/.local/share/opencode/opencode.db, or OPENCODE_DB_PATH)
  --run <label>      run directory name under .cache/perf/multi-session (default: timestamp)
  --out <dir>        output root (default .cache/perf/multi-session)
  --preflight        join /api/diagnostics/harness/preflight once per (agent, provider, model)
  --turn-timing      join /api/diagnostics/turn-timing/recent by assistant message id
  --server <origin>  DevRyan web server origin for the joins (default http://127.0.0.1:3000)
  --cookie <value>   ${COOKIE_NAME} cookie value for the joins (or DEVRYAN_UI_SESSION_COOKIE)
  --quiet            no console summary

Output: <out>/<run>/pipeline/report.md and report.json. The database is opened
read-only; the server joins are skipped silently when the server is unreachable.
`;

export const profileSession = async (options, deps = {}) => {
  const startedAt = performance.now();
  const db = openSessionDatabase(options.dbPath, deps.database);
  let rows;
  try {
    rows = loadSessionTree(db, options.sessionId);
  } finally {
    db.close();
  }
  const tree = aggregateTree(rows);
  const server = await collectServerJoins(options, tree, deps);
  const profile = {
    generatedAt: new Date().toISOString(),
    run: options.run,
    db: { path: options.dbPath, driver: db.driver, notes: db.notes },
    elapsedMs: Math.round(performance.now() - startedAt),
    tree,
    server,
  };
  const dir = path.join(options.outRoot, options.run, 'pipeline');
  await fsp.mkdir(dir, { recursive: true });
  const paths = { dir, json: path.join(dir, 'report.json'), markdown: path.join(dir, 'report.md') };
  await fsp.writeFile(paths.json, `${JSON.stringify(profile, null, 2)}\n`);
  await fsp.writeFile(paths.markdown, renderReport(profile));
  return { profile, paths };
};

const printSummary = ({ profile, paths }) => {
  const { totals, skillReloads } = profile.tree;
  const relative = (target) => path.relative(process.cwd(), target) || target;
  console.log(`[pipeline] ${profile.tree.sessionCount} sessions (depth ${profile.tree.maxDepth}) via ${profile.db.driver} in ${fmtMs(profile.elapsedMs)}`);
  console.log(`[pipeline] turns ${totals.turns}, assistant messages ${totals.messages.assistant}, wall ${fmtMs(totals.wall.wallMs)}, assistant active ${fmtMs(totals.wall.assistantActiveMs)}`);
  for (const [key, value] of Object.entries(totals.tokensByModel)) {
    console.log(`[pipeline] tokens ${key}: ${value.messages} msgs, input ${fmtInt(value.input)}, output ${fmtInt(value.output)}, reasoning ${fmtInt(value.reasoning)}, cache read ${fmtInt(value.cacheRead)}, cache write ${fmtInt(value.cacheWrite)}`);
  }
  console.log(`[pipeline] tool calls ${totals.toolCalls.total} (${totals.toolCalls.errors} errors, ${totals.toolCalls.guardRejections} guard rejections): ${Object.entries(totals.toolCalls.byName).slice(0, 12).map(([name, stats]) => `${name}×${stats.count}`).join(', ')}`);
  console.log(`[pipeline] skills ${totals.skills.loads} loads / ${formatBytes(totals.skills.bytes)}; reloads across children: ${skillReloads.map((entry) => `${entry.name}×${entry.totalLoads}`).join(', ') || 'none'}`);
  console.log(`[pipeline] mcp ${totals.mcp.total} calls (${totals.mcp.errors} errors); bash ${totals.bash.total}: ${Object.entries(totals.bash.byClass).map(([cls, stats]) => `${cls} ${stats.count}`).join(', ') || 'none'}`);
  if (profile.server) console.log(`[pipeline] server ${profile.server.server}: ${profile.server.reachable ? 'joined' : 'unreachable, joins skipped'}`);
  console.log(`[pipeline] report: ${relative(paths.markdown)} (+ report.json)`);
};

const main = async () => {
  const options = parseProfileArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const result = await profileSession(options);
  if (!options.quiet) printSummary(result);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
