import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeIdentityReader, DUPLICATE_OUTPUT_PROFILES, duplicatePolicyVector, qualifyDuplicateOutputs, readDuplicatePluginInventory, resolveDuplicateOutputPolicy } from './harness-duplicate-qualification.js';
import { createHarnessRunFingerprintReader } from './harness-run-fingerprint.js';
import { DUPLICATE_PROVIDER_ROUTES } from './duplicate-provider-route.js';
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
    const f = await fixture(); expect(DUPLICATE_OUTPUT_PROFILES).toHaveLength(6);
    expect(qualifyDuplicateOutputs({ ...f.input, profiles: undefined }).qualified).toBe(false);
    expect(qualifyDuplicateOutputs(f.input).qualified).toBe(true);
    // Companion 2.1.0 routes are qualified by build identity; the earlier
    // profiles stay on record as stale.
    expect(DUPLICATE_OUTPUT_PROFILES.filter((profile) => profile.stale).map((profile) => profile.id))
      .toEqual(['devryan-companion-2.0.0-openai-sol-medium', 'opencode-1.18.31-openai-sol-medium']);
    expect(DUPLICATE_OUTPUT_PROFILES.filter((profile) => profile.defaultEnabled && !profile.stale).map((profile) => profile.id))
      .toEqual(['devryan-companion-2.1.0-xai-grok-4.7-medium', 'devryan-companion-2.1.0-xai-grok-4.6-high',
        'devryan-companion-2.1.0-openai-gpt-6-astra-medium', 'devryan-companion-2.1.0-openai-gpt-5.6-sol-medium']);
    for (const profile of DUPLICATE_OUTPUT_PROFILES.filter((entry) => !entry.stale)) {
      expect(profile.runtimeIdentity, profile.id).toMatchObject({ kind: 'companion-build', upstreamVersion: '1.18.32' });
      expect(profile.policyVector, profile.id).toEqual({ waitAny: false, capabilityToolSchema: true });
    }
    expect(resolveDuplicateOutputPolicy({})).toBe(true);
    expect(resolveDuplicateOutputPolicy({}, DUPLICATE_OUTPUT_PROFILES.filter((profile) => profile.stale))).toBe(false);
    expect(resolveDuplicateOutputPolicy({}, [{ ...f.profile, defaultEnabled: true, stale: { reason: 'bytes changed', plugins: [] } }])).toBe(false);
    expect(qualifyDuplicateOutputs({ ...f.input, profiles: [{ ...f.profile, stale: { reason: 'bytes changed', plugins: [] } }] }))
      .toEqual({ qualified: false, reason: 'profile-stale' });
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
      // Every release profile names a transport the host can attest.
      expect(Object.values(DUPLICATE_PROVIDER_ROUTES), profile.id).toContain(profile.transport);
      expect(DUPLICATE_PROVIDER_ROUTES[profile.providerID], profile.id).toBe(profile.transport);
      expect(profile.providerScope).toBe('selected-route');
      expect(profile.evidence.livePairs).toBe(10);
      const audit = { 'opencode-1.18.31-openai-sol-medium': '2026-09-20-context-deduplication',
        'devryan-companion-2.0.0-openai-sol-medium': '2026-09-24-companion-requalification',
        'devryan-companion-2.1.0-xai-grok-4.7-medium': '2026-09-24-duplicate-routes/xai-47',
        'devryan-companion-2.1.0-xai-grok-4.6-high': '2026-09-24-duplicate-routes/xai-46',
        'devryan-companion-2.1.0-openai-gpt-6-astra-medium': '2026-09-24-duplicate-routes/openai-astra',
        'devryan-companion-2.1.0-openai-gpt-5.6-sol-medium': '2026-09-24-duplicate-routes/openai-sol' }[profile.id];
      expect(audit, profile.id).toBeTruthy();
      const report = await fs.readFile(new URL(`../../../../../docs/audits/${audit}/live-acceptance.json`, import.meta.url));
      expect(crypto.createHash('sha256').update(report).digest('hex')).toBe(profile.evidence.reportHash);
      expect(JSON.parse(report).qualified).toBe(true);
      // A stale profile must name exactly the bundled plugins whose bytes
      // changed; every other qualified plugin stays pinned.
      const stale = new Set(profile.stale?.plugins ?? []);
      if (profile.stale) expect(profile.stale.reason.length).toBeGreaterThan(20);
      for (const entry of profile.plugins) {
        if (!entry.name.endsWith('.mjs') && entry.name !== 'council-session.js') continue;
        const body = await fs.readFile(new URL(`../../default-config/plugins/${entry.name}`, import.meta.url));
        const actual = crypto.createHash('sha256').update(body).digest('hex');
        if (stale.has(entry.name)) expect(actual, entry.name).not.toBe(entry.contentHash);
        else expect(actual, entry.name).toBe(entry.contentHash);
      }
      for (const name of stale) expect(profile.plugins.some((entry) => entry.name === name)).toBe(true);
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

describe('companion build identity', () => {
  const build = { upstreamVersion: '1.18.32', baseCommit: '5'.repeat(40), patchSha256: 'c'.repeat(64), buildInputsSha256: 'd'.repeat(64) };
  const identityProfile = (profile) => ({ ...profile, runtimeHash: 'e'.repeat(64), runtimeIdentity: { kind: 'companion-build', ...build },
    policyVector: duplicatePolicyVector({}) });

  it('qualifies a rebuild of identical source and inputs whose binary bytes differ, and nothing else', async () => {
    const f = await fixture();
    const profiles = [identityProfile(f.profile)];
    // A different binary hash (another machine's build) with the same build identity.
    expect(qualifyDuplicateOutputs({ ...f.input, companion: build, profiles })).toMatchObject({ qualified: true, profileId: 'fixture-only' });
    for (const field of Object.keys(build)) {
      expect(qualifyDuplicateOutputs({ ...f.input, companion: { ...build, [field]: field === 'upstreamVersion' ? '1.18.33' : field === 'baseCommit' ? '6'.repeat(40) : 'f'.repeat(64) }, profiles }))
        .toEqual({ qualified: false, reason: 'profile-unqualified' });
    }
    expect(qualifyDuplicateOutputs({ ...f.input, companion: null, profiles })).toEqual({ qualified: false, reason: 'profile-unqualified' });
    // The kill switch restores exact binary pinning.
    expect(qualifyDuplicateOutputs({ ...f.input, companion: build, profiles, environment: { DEVRYAN_DUPLICATE_IDENTITY: 'binary' } }))
      .toEqual({ qualified: false, reason: 'profile-unqualified' });
    expect(qualifyDuplicateOutputs({ ...f.input, runtimeHash: 'e'.repeat(64), companion: build, profiles, environment: { DEVRYAN_DUPLICATE_IDENTITY: 'binary' } }).qualified)
      .toBe(true);
  });

  it('denies a request-shaping policy vector other than the qualified one', async () => {
    const f = await fixture();
    const profiles = [identityProfile(f.profile)];
    expect(qualifyDuplicateOutputs({ ...f.input, companion: build, profiles, policyVector: duplicatePolicyVector({ DEVRYAN_MANAGED_WAIT_ANY: '1' }) }))
      .toEqual({ qualified: false, reason: 'policy-vector-mismatch' });
    expect(qualifyDuplicateOutputs({ ...f.input, companion: build, profiles, policyVector: duplicatePolicyVector({ DEVRYAN_CAPABILITY_TOOL_SCHEMA: '0' }) }))
      .toEqual({ qualified: false, reason: 'policy-vector-mismatch' });
  });

  it('trusts companion.json only when it describes the running binary', async () => {
    const f = await fixture();
    const binary = path.join(f.root, 'DevRyan-opencode-test');
    await fs.writeFile(binary, 'binary bytes');
    const sha256 = crypto.createHash('sha256').update('binary bytes').digest('hex');
    const write = (manifest) => fs.writeFile(path.join(f.root, 'companion.json'), JSON.stringify({ acceptance: true, ...build, sha256, ...manifest }));
    const read = createRuntimeIdentityReader(() => binary);
    await write({});
    expect(await read()).toEqual({ runtimeHash: sha256, companion: build });
    await write({ sha256: 'f'.repeat(64) });
    expect(await createRuntimeIdentityReader(() => binary)()).toEqual({ runtimeHash: sha256, companion: null });
    await write({ buildInputsSha256: undefined });
    expect((await createRuntimeIdentityReader(() => binary)()).companion).toBeNull();
    await fs.rm(path.join(f.root, 'companion.json'));
    expect((await createRuntimeIdentityReader(() => binary)()).companion).toBeNull();
  });
});
