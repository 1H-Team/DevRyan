import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DUPLICATE_OUTPUT_PROFILES, qualifyDuplicateOutputs, readDuplicatePluginInventory, resolveDuplicateOutputPolicy } from './harness-duplicate-qualification.js';
import { createHarnessRunFingerprintReader } from './harness-run-fingerprint.js';
import { __test } from '../../default-config/plugins/devryan-harness-context.mjs';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const fixture = async () => {
  const base = path.resolve('../../.cache/qa'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'duplicate-qualification-')); roots.push(root);
  const file = path.join(root, 'owner.mjs'); await fs.writeFile(file, 'export default () => ({});');
  const config = { plugin: [pathToFileURL(file).href], provider: { fixture: { options: { baseURL: 'http://127.0.0.1:12345' } } } };
  const inventory = await readDuplicatePluginInventory(config.plugin, config.provider);
  const runtimeHash = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const selection = { providerID: 'fixture', modelID: 'model', variant: null };
  const profile = { id: 'fixture-only', runtimeVersion: '1.18.31', runtimeHash, ...selection, providerHash: inventory.providerHash,
    plugins: inventory.entries, evidence: { reportHash: 'a'.repeat(64),
      correctness: true, finalRequests: true, compactionLifecycle: true, nonIncreasingRequests: true,
      livePairs: 10, skillPairs: 5, managedPairs: 5, incompleteTrials: 0, criticalFailures: 0, repeatedMutations: 0, repeatCallDelta: 0 } };
  return { root, file, config, profile, input: { managed: true, enabled: true, runtimeVersion: '1.18.31', runtimeHash, selection,
    inventory, callerInventory: inventory, profiles: [profile] } };
};
describe('duplicate output release qualification', () => {
  it('ships only evidence-backed profiles and requires full live acceptance even with environment opt-in', async () => {
    const f = await fixture(); expect(DUPLICATE_OUTPUT_PROFILES).toHaveLength(1);
    expect(qualifyDuplicateOutputs({ ...f.input, profiles: undefined }).qualified).toBe(false);
    expect(qualifyDuplicateOutputs(f.input).qualified).toBe(true);
    expect(resolveDuplicateOutputPolicy({})).toBe(true);
    expect(resolveDuplicateOutputPolicy({ DEVRYAN_DUPLICATE_OUTPUTS: '0' })).toBe(false);
    const promoted = [{ ...f.profile, defaultEnabled: true }];
    expect(resolveDuplicateOutputPolicy({}, promoted)).toBe(true);
    expect(resolveDuplicateOutputPolicy({ DEVRYAN_DUPLICATE_OUTPUTS: '0' }, promoted)).toBe(false);
    expect(resolveDuplicateOutputPolicy({}, [{ ...promoted[0], evidence: {} }])).toBe(false);
    for (const field of ['correctness', 'finalRequests', 'compactionLifecycle', 'nonIncreasingRequests', 'reportHash', 'livePairs', 'skillPairs', 'managedPairs']) {
      const profile = structuredClone(f.profile); delete profile.evidence[field];
      expect(qualifyDuplicateOutputs({ ...f.input, profiles: [profile] }).qualified).toBe(false);
    }
    for (const field of ['criticalFailures', 'incompleteTrials', 'repeatedMutations', 'repeatCallDelta']) {
      const profile = structuredClone(f.profile); profile.evidence[field] = 1;
      expect(qualifyDuplicateOutputs({ ...f.input, profiles: [profile] }).qualified).toBe(false);
    }
  });
  it('keeps each bundled plugin in the promoted ordered inventory tied to its verified bytes', async () => {
    for (const profile of DUPLICATE_OUTPUT_PROFILES) {
      expect(profile.transport).toBe('openai-chatgpt-managed-responses-v1');
      expect(profile.providerScope).toBe('selected-route');
      expect(profile.evidence.livePairs).toBe(10);
      const report = await fs.readFile(new URL('../../../../../docs/audits/2026-09-20-context-deduplication/live-acceptance.json', import.meta.url));
      expect(crypto.createHash('sha256').update(report).digest('hex')).toBe(profile.evidence.reportHash);
      expect(JSON.parse(report).qualified).toBe(true);
      for (const entry of profile.plugins) {
        if (!entry.name.endsWith('.mjs') && entry.name !== 'council-session.js') continue;
        const body = await fs.readFile(new URL(`../../default-config/plugins/${entry.name}`, import.meta.url));
        expect(crypto.createHash('sha256').update(body).digest('hex'), entry.name).toBe(entry.contentHash);
      }
    }
  });
  it('matches plugin/native inventories exactly and rejects custom, reordered, changed, external or unqualified routes', async () => {
    const f = await fixture(); expect(__test().pluginInventory(f.config)).toEqual(f.input.inventory);
    for (const change of [{ managed: false }, { enabled: false }, { runtimeVersion: '1.18.32' }, { runtimeHash: null }, { runtimeHash: 'f'.repeat(64) },
      { selection: { ...f.input.selection, modelID: 'other' } }, { selection: {} }, { inventory: null },
      { callerInventory: { ...f.input.inventory, entries: [] } },
      { inventory: { ...f.input.inventory, providerHash: 'b'.repeat(64) } }]) {
      expect(qualifyDuplicateOutputs({ ...f.input, ...change }).qualified).toBe(false);
    }
    const later = path.join(f.root, 'later.mjs'); await fs.writeFile(later, 'export default () => ({ event() {} });');
    const ordered = await readDuplicatePluginInventory([...f.config.plugin, pathToFileURL(later).href], f.config.provider);
    const profile = { ...f.profile, plugins: ordered.entries };
    expect(qualifyDuplicateOutputs({ ...f.input, inventory: ordered, callerInventory: ordered, profiles: [profile] }).qualified).toBe(true);
    const reversed = await readDuplicatePluginInventory([pathToFileURL(later).href, ...f.config.plugin], f.config.provider);
    expect(qualifyDuplicateOutputs({ ...f.input, inventory: reversed, callerInventory: reversed, profiles: [profile] }).qualified).toBe(false);
    await fs.writeFile(f.file, 'export default () => ({ event() {} });');
    const inventory = await readDuplicatePluginInventory(f.config.plugin, f.config.provider);
    expect(qualifyDuplicateOutputs({ ...f.input, inventory, callerInventory: inventory }).qualified).toBe(false);
    expect(await readDuplicatePluginInventory(['unresolved@latest'])).toBeNull();
    expect(await readDuplicatePluginInventory([[f.config.plugin[0], { unknown: true }]])).toBeNull();
  });
  it('negotiates from authoritative host configuration and never labels hook measurements as final wire evidence', async () => {
    const f = await fixture(), records = [];
    const reader = createHarnessRunFingerprintReader({ isManaged: () => true, environment: { DEVRYAN_DUPLICATE_OUTPUTS: '1' },
      getRuntimeBinary: () => f.file, duplicateProfiles: [f.profile], buildOpenCodeUrl: route => `http://127.0.0.1:12345${route}`,
      fetchImpl: async url => Response.json(new URL(url).pathname === '/config' ? f.config : { version: '1.18.31' }),
      recordDiagnostic: record => records.push(record) });
    expect((await reader.qualifyDuplicates({ directory: f.root, ...f.input.selection, inventory: f.input.inventory })).qualified).toBe(true);
    expect((await reader.read({ directory: f.root, ...f.input.selection })).plugins.inventory).toEqual(f.input.inventory);
    f.config.plugin.push('custom@latest');
    expect((await reader.read({ directory: f.root, ...f.input.selection })).plugins.inventory).toBeNull();
    reader.observeContext({ directory: f.root, sessionID: 'ses_fixture', phase: 'hook-applied', plannedReductions: 2,
      appliedReductions: 2, finalRequestBytes: 100, reason: 'raw private text' });
    expect(records[0].payload).toMatchObject({ phase: 'hook-applied', appliedReductions: 2, finalRequestBytes: null, reason: null });
  });
  it('qualifies relocated identical managed files while retaining the host/caller path agreement', async () => {
    const f = await fixture();
    const relocated = path.join(f.root, 'relocated'); await fs.mkdir(relocated);
    const copy = path.join(relocated, 'owner.mjs'); await fs.copyFile(f.file, copy);
    const inventory = await readDuplicatePluginInventory([pathToFileURL(copy).href], f.config.provider);
    expect(inventory.configurationHash).not.toEqual(f.input.inventory.configurationHash);
    expect(qualifyDuplicateOutputs({ ...f.input, inventory, callerInventory: inventory }).qualified).toBe(true);
    expect(qualifyDuplicateOutputs({ ...f.input, inventory }).qualified).toBe(false);
    await fs.writeFile(copy, 'export default () => ({ config() {} });');
    const changed = await readDuplicatePluginInventory([pathToFileURL(copy).href], f.config.provider);
    expect(qualifyDuplicateOutputs({ ...f.input, inventory: changed, callerInventory: changed }).qualified).toBe(false);
  });
  it('uses the authoritative selected-provider configuration for portable route profiles', async () => {
    const f = await fixture();
    const profile = { ...f.profile, providerScope: 'selected-route', transport: 'fixture-oauth' };
    let providerRoute = 'fixture-oauth';
    const originalRouteHash = f.input.inventory.providerHash;
    f.config.provider.unrelated = { options: { baseURL: 'http://127.0.0.1:54321' } };
    const inventory = await readDuplicatePluginInventory(f.config.plugin, f.config.provider);
    const reader = createHarnessRunFingerprintReader({ isManaged: () => true, environment: { DEVRYAN_DUPLICATE_OUTPUTS: '1' },
      getDuplicateProviderRoute: () => providerRoute,
      getRuntimeBinary: () => f.file, duplicateProfiles: [profile], buildOpenCodeUrl: route => `http://127.0.0.1:12345${route}`,
      fetchImpl: async url => Response.json(new URL(url).pathname === '/config' ? f.config : { version: '1.18.31' }) });
    const context = { directory: f.root, ...f.input.selection, inventory };
    expect((await reader.qualifyDuplicates(context)).qualified).toBe(true);
    providerRoute = 'fixture-api';
    expect((await reader.qualifyDuplicates({ ...context, providerRoute: 'fixture-oauth' })).qualified).toBe(false);
    providerRoute = 'fixture-oauth';
    f.config.provider.fixture.options.baseURL = 'http://127.0.0.1:22222';
    context.inventory = await readDuplicatePluginInventory(f.config.plugin, f.config.provider);
    expect((await reader.qualifyDuplicates({ ...context, providerRouteHash: originalRouteHash })).qualified).toBe(false);
  });
});
