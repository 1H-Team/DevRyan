import { expect, test } from 'bun:test';
import { createUsageCollector } from './usage.js';
import { createDiagnosticSanitizer } from './sanitizer.js';
import { createDiagnosticJournal } from './journal.js';
import { createDiagnosticsExport } from './export.js';
import { normalizeUsageObservation } from '../../shared-runtime/lib/usage-observation.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const event = (type, entry, at = 100) => ({ type: 'open_code_event', at, sessionID: 's1', payload: { type,
  properties: type === 'message.updated' ? { info: { role: 'assistant', time: { completed: at }, ...entry } } : { part: entry } } });
const tokens = { input: 10, output: 3, reasoning: 2, cache: { read: 20, write: 0 } };
const wire = (id, overrides = {}) => ({ type: 'lifecycle', event: 'usage_observed', sessionID: 's1', at: 100,
  usageObservation: normalizeUsageObservation({ source: 'provider_request', observationID: id, attemptID: id, sessionID: 's1',
    observedAt: 100, raw: { input: 100, cacheRead: 50, cacheWrite: 0, output: 10, reasoning: 2 },
    semantics: { input: 'inclusive', output: 'inclusive' }, ...overrides }) });

test('deduplicates steps and replaces message fallback without adding overlapping provider evidence', () => {
  const c = createUsageCollector();
  c.add(event('message.updated', { id: 'm1', modelID: 'sol', tokens }));
  const step = event('message.part.updated', { id: 'p1', messageID: 'm1', type: 'step-finish', tokens });
  c.add(step); c.add(step); c.add(event('message.part.updated', { id: 'p2', messageID: 'm1', type: 'step-finish', tokens }));
  c.add(wire('a1')); c.add(wire('a1'));
  const root = c.finish().roots[0];
  expect(root.runtime.all.tokens.totalInput.total).toBe(60);
  expect(root.runtime.all.requestHitRate).toBeNull();
  expect(root.provider.all).toMatchObject({ tokens: { totalInput: { total: 100 } }, requestHitRate: 1 });
});
test('reports failures, aborts, missing usage, warm cohorts and model drift honestly', () => {
  const c = createUsageCollector();
  c.add(wire('a1', { use: 'first', requestedModel: 'opus-5', responseModel: 'opus-4.8' }));
  c.add(wire('a2', { use: 'warm', status: 'failed', raw: {} }));
  c.add(wire('a3', { use: 'warm', status: 'aborted', raw: { input: 100, cacheRead: 0 } }));
  const result = c.finish().roots[0].provider;
  expect(result.all).toMatchObject({ requestHitRate: 0.5, requests: { observed: 3, knownCacheUsage: 2, unknownCacheUsage: 1 }, modelMismatches: 1 });
  expect(result.byUse.warm.requestHitRate).toBe(0);
});
test('differences cumulative native counters and never interprets snapshots as requests', () => {
  const c = createUsageCollector();
  c.add(wire('a1', { counterMode: 'cumulative', counterScopeID: 'native1', sequence: 1 }));
  c.add(wire('a2', { counterMode: 'cumulative', counterScopeID: 'native1', sequence: 2,
    raw: { input: 150, cacheRead: 70, cacheWrite: 0 } }));
  const result = c.finish();
  expect(result.incomplete).toBe(true);
  expect(result.roots[0].provider.all.tokens.totalInput).toMatchObject({ total: 50, unknown: 1 });
  expect(result.roots[0].provider.all.requestHitRate).toBeNull();
});
test('survives journal round trip and includes deleted title helpers in task export', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-usage-'));
  const sanitizer = createDiagnosticSanitizer();
  const journal = createDiagnosticJournal({ directory: dir, sanitizer });
  try {
    journal.enqueue({ type: 'lifecycle', event: 'session_title_generation', sessionID: 's1', at: 100, payload: { helperSessionID: 'title1', stage: 'helper_created' } });
    journal.enqueue({ ...event('message.updated', { id: 'titlem1', parentID: 'title-user-message', tokens }), sessionID: 'title1' });
    journal.enqueue({ type: 'open_code_event', at: 200, payload: { type: 'session.deleted', properties: { info: { id: 'title1', tokens } } } });
    journal.enqueue({ ...wire('a1'), usageObservation: { ...wire('a1').usageObservation, secret: 'private', prompt: 'private' } });
    await journal.flush();
    expect((await journal.listSessionManifests()).find(row => row.sessionID === 's1').parentID).toBeNull();
    expect((await journal.listSessionManifests()).find(row => row.sessionID === 'title1').parentID).toBeNull();
    const exported = await createDiagnosticsExport({ journal, sanitizer, scope: { scope: 'task', sessionID: 's1' } });
    const report = JSON.parse(exported.files.find(file => file.name === 'DevRyan-usage.json').data);
    expect(report.roots).toHaveLength(1);
    expect(report.roots[0].runtime.byPurpose.title.tokens.totalInput.total).toBe(30);
    expect(report.roots[0].provider.all.tokens.totalInput.total).toBe(100);
    expect(JSON.stringify(report)).not.toContain('private');
  } finally { await journal.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('bounds records and marks retention gaps rather than claiming complete totals', () => {
  const c = createUsageCollector({ maxObservations: 1, maxBytes: 4096 });
  c.add(wire('a1')); c.add(wire('a2')); c.add({ type: 'gap' });
  expect(c.finish()).toMatchObject({ incomplete: true, coverage: { retained: 1, omitted: 1, journalGaps: 1 } });
});
test('resumed turn fingerprints and compaction purpose stay scoped to their exact message', () => {
  const c = createUsageCollector();
  c.add({ type: 'lifecycle', event: 'harness_run_start', sessionID: 's1', userMessageID: 'user1', payload: { fingerprint: { runtimeVersion: '1.18.31' } } });
  c.add(event('message.updated', { id: 'm1', parentID: 'user1', agent: 'compaction', summary: true, tokens }));
  c.add(event('message.part.updated', { id: 'p1', messageID: 'm1', type: 'step-finish', tokens }));
  c.add(event('message.updated', { id: 'm2', parentID: 'user2', agent: 'builder', tokens }));
  const result = c.finish();
  expect(result.observations.find(row => row.stepID === 'p1')).toMatchObject({ runtimeVersion: '1.18.31', purpose: 'compaction' });
  expect(result.observations.find(row => row.messageID === 'm2').runtimeVersion).toBeNull();
  expect(result.roots[0].runtime.byPurpose.compaction.tokens.totalInput.total).toBe(30);
});
test('native response copies across resumed sessions count once with unknown ownership', () => {
  const c = createUsageCollector();
  c.add(wire('native1', { attemptID: null, responseID: 'response1', status: 'complete', provider: 'anthropic' }));
  c.add(wire('native-copy', { attemptID: null, responseID: 'response1', sessionID: 'fork', status: 'complete', provider: 'anthropic' }));
  const report = c.finish();
  expect(report.coverage).toMatchObject({ retained: 1, duplicates: 1, attributionConflicts: 1 });
  expect(report.roots[0]).toMatchObject({ rootSessionID: 'unknown', provider: { all: { tokens: { totalInput: { total: 100 } } } } });
});
test('missing cumulative costs and resets never restart a from-zero baseline', () => {
  for (const amounts of [[1, null, 3], [3, 1, 2]]) {
    const c = createUsageCollector();
    for (const [index, amount] of amounts.entries()) c.add(wire(`cost-${index}`, {
      counterMode: 'cumulative', counterScopeID: 'cost-counter', cumulativeFromZero: true, sequence: index + 1,
      status: 'complete', raw: { input: (index + 1) * 100, cacheRead: 0, cacheWrite: 0 },
      cost: { amount, currency: 'USD', provenance: 'runtime_reported' },
    }));
    const report = c.finish();
    expect(report.incomplete).toBe(true);
    expect(report.coverage.cumulativeGaps).toBe(1);
    expect(report.observations.map(row => row.cost.amount)).toEqual(amounts[0] === 1 ? [1, null, null] : [3, null, 1]);
  }
});
test('copied responses resolve shared roots after late relations and preserve ambiguity in any order', () => {
  for (const order of [[0, 1, 2], [2, 1, 0]]) {
    const c = createUsageCollector();
    const copies = ['child-a', 'child-b', 'child-c'].map((sessionID, index) => wire(`copy-${index}`, {
      attemptID: null, responseID: 'copied-response', provider: 'anthropic', sessionID, observedAt: index, status: 'complete',
    }));
    for (const index of order.slice(0, 2)) c.add(copies[index]);
    for (const sessionID of ['child-a', 'child-b', 'child-c']) c.add({ type: 'open_code_event', payload: {
      type: 'session.updated', properties: { info: { id: sessionID, parentID: 'shared-root' } },
    } });
    expect(c.finish().roots[0].rootSessionID).toBe('shared-root');
    c.add(copies[order[2]]);
    expect(c.finish().roots[0].rootSessionID).toBe('shared-root');
    c.add(wire('unrelated-copy', { attemptID: null, responseID: 'copied-response', provider: 'anthropic', sessionID: 'other', observedAt: 0, status: 'complete' }));
    const report = c.finish();
    expect(report.roots[0].rootSessionID).toBe('unknown');
    expect(report.roots[0].provider.all.observations).toBe(1);
    expect(report.observations[0].sessionID).toBeNull();
  }
});
