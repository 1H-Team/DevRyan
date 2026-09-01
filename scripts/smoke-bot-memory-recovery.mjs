#!/usr/bin/env node

import process from 'node:process';
import { fileURLToPath } from 'node:url';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const requiredValue = (value, flag) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${flag} requires a value`);
  return value.trim();
};

export const parseBotMemorySmokeArguments = (argv) => {
  const options = { baseUrl: null, botId: null, runIds: [], timeoutMs: 120_000 };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = requiredValue(argv[index + 1], flag || 'argument');
    if (flag === '--base-url') options.baseUrl = new URL(value).origin;
    else if (flag === '--bot-id') options.botId = value;
    else if (flag === '--run-id') options.runIds.push(value);
    else if (flag === '--timeout-ms') options.timeoutMs = Number(value);
    else throw new Error(`Unknown Bot memory smoke flag: ${flag}`);
  }
  if (!options.baseUrl) throw new Error('--base-url is required');
  if (!UUID_PATTERN.test(options.botId || '')) throw new Error('--bot-id must be a UUID');
  if (options.runIds.length < 2 || options.runIds.some((id) => !UUID_PATTERN.test(id))) {
    throw new Error('Pass at least two --run-id UUIDs from concurrently completed recoverable runs');
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error('--timeout-ms must be an integer of at least 1000');
  }
  return Object.freeze({ ...options, runIds: Object.freeze([...new Set(options.runIds)]) });
};

export const evaluateBotMemoryRecoverySnapshot = ({ auditLogs, memoryDetails, runIds }) => {
  const successfulRuns = new Set(auditLogs
    .filter((log) => log.action === 'bot.memory.extract' && log.result === 'success')
    .map((log) => log.target?.id));
  const resolvedRuns = new Set(auditLogs
    .filter((log) => log.action === 'bot.memory.extract'
      && ['failure', 'partial', 'unknown'].includes(log.result)
      && log.resolvedAt && log.resolvedByEventId)
    .map((log) => log.target?.id));
  const sourcesByRunAndKey = new Map();
  for (const detail of memoryDetails) {
    for (const source of detail.sources || []) {
      if (!source.runId) continue;
      const identity = `${source.runId}\0${detail.memory?.logicalKey || ''}`;
      sourcesByRunAndKey.set(identity, (sourcesByRunAndKey.get(identity) || 0) + 1);
    }
  }
  const persistedRuns = new Set([...sourcesByRunAndKey.keys()].map((key) => key.split('\0')[0]));
  return Object.freeze({
    complete: runIds.every((runId) => successfulRuns.has(runId)
      && resolvedRuns.has(runId)
      && persistedRuns.has(runId))
      && [...sourcesByRunAndKey.values()].every((count) => count === 1),
    successfulRuns: Object.freeze([...successfulRuns]),
    resolvedRuns: Object.freeze([...resolvedRuns]),
    persistedRuns: Object.freeze([...persistedRuns]),
    duplicateSourceCount: [...sourcesByRunAndKey.values()].filter((count) => count !== 1).length,
  });
};

const cookieFrom = (response) => {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  return values.map((value) => value.split(';', 1)[0]).join('; ');
};

const requestJson = async (baseUrl, pathname, cookie, options = {}) => {
  const response = await fetch(new URL(pathname, baseUrl), {
    ...options,
    headers: { ...(options.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} failed with ${response.status} (${body?.code || 'unknown'})`);
  return body;
};

const login = async (baseUrl) => {
  const response = await fetch(new URL('/auth/agent-test-session', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
    body: JSON.stringify({ email: 'admin@1health.ae' }),
  });
  if (!response.ok) throw new Error(`agent-test login failed with ${response.status}`);
  const cookie = cookieFrom(response);
  if (!cookie) throw new Error('agent-test login did not return a session cookie');
  return cookie;
};

const loadSnapshot = async (options, cookie) => {
  const auditLogs = [];
  for (const runId of options.runIds) {
    const payload = await requestJson(
      options.baseUrl,
      `/api/bot-audit?result=all&q=${encodeURIComponent(runId)}&limit=200`,
      cookie,
    );
    auditLogs.push(...(payload.logs || []).filter((log) => log.target?.id === runId));
  }
  const memoryDetails = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const page = await requestJson(
      options.baseUrl,
      `/api/bots/${options.botId}/memories?${query}`,
      cookie,
    );
    for (const memory of page.memories || []) {
      memoryDetails.push(await requestJson(
        options.baseUrl,
        `/api/bots/${options.botId}/memories/${memory.id}`,
        cookie,
      ));
    }
    cursor = page.nextCursor || null;
  } while (cursor);
  return { auditLogs, memoryDetails, runIds: options.runIds };
};

export const runBotMemoryRecoverySmoke = async (options) => {
  const cookie = await login(options.baseUrl);
  const deadline = Date.now() + options.timeoutMs;
  let result;
  do {
    result = evaluateBotMemoryRecoverySnapshot(await loadSnapshot(options, cookie));
    if (result.complete) return result;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);
  throw new Error(`Bot memory recovery did not converge: ${JSON.stringify(result)}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runBotMemoryRecoverySmoke(parseBotMemorySmokeArguments(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`[bots] memory recovery smoke failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
