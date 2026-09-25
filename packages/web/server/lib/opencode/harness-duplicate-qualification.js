import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import profiles from './harness-duplicate-profiles.js';

// Release-owned evidence, never populated by running-app experiments.
// Environment opt-in cannot bypass this list.
export const DUPLICATE_OUTPUT_PROFILES = profiles;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,256}$/.test(value);
// Release identities travel with the managed files. Absolute installation paths
// remain in the two-sided runtime inventory check, but cannot identify a release
// across the private QA installation and the user's managed installation.
export const duplicatePluginReleaseIdentity = entries => Array.isArray(entries) && entries.length > 0
  && entries.every(entry => identity(entry?.name) && validHash(entry?.contentHash))
  ? entries.map(({ name, contentHash }) => ({ name, contentHash })) : null;
const accepted = evidence => validHash(evidence?.reportHash) && evidence.correctness === true
  && evidence.finalRequests === true && evidence.compactionLifecycle === true && evidence.nonIncreasingRequests === true
  && evidence.livePairs === 10 && evidence.skillPairs === 5 && evidence.managedPairs === 5
  && evidence.incompleteTrials === 0 && evidence.criticalFailures === 0 && evidence.repeatedMutations === 0
  && Number.isFinite(evidence.repeatCallDelta) && evidence.repeatCallDelta <= 0;

export const resolveDuplicateOutputPolicy = (environment = {}, profiles = DUPLICATE_OUTPUT_PROFILES) => {
  if (environment.DEVRYAN_DUPLICATE_OUTPUTS !== undefined) return environment.DEVRYAN_DUPLICATE_OUTPUTS === '1';
  // Without a qualifiable (non-stale) profile the default policy stays off, so
  // requests skip per-turn qualification work that could never succeed.
  return profiles.some(profile => profile.defaultEnabled === true && !profile.stale && accepted(profile.evidence));
};

export const createRuntimeDigestReader = (resolveBinary) => {
  let previous;
  return async () => {
    let file;
    try {
      const binary = resolveBinary?.();
      if (typeof binary !== 'string' || !path.isAbsolute(binary)) return null;
      file = await fs.open(binary, 'r');
      const before = await file.stat();
      if (!before.isFile() || before.size > 512 * 1024 * 1024) return null;
      const key = JSON.stringify([binary, before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]);
      if (previous?.key === key) return previous.hash;
      const hash = crypto.createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await file.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return null;
      previous = { key, hash: hash.digest('hex') }; return previous.hash;
    } catch { return null; }
    finally { await file?.close().catch(() => {}); }
  };
};

// The companion build identity, trusted only when companion.json (verified
// at host start against the artifact contract) describes this exact binary.
// Bun embeds absolute build paths, so builds from identical source and inputs
// on different machines differ byte-wise; this identity survives that.
export const createRuntimeIdentityReader = (resolveBinary, readDigest = createRuntimeDigestReader(resolveBinary)) => async () => {
  const runtimeHash = await readDigest();
  if (!validHash(runtimeHash)) return { runtimeHash: null, companion: null };
  try {
    const binary = resolveBinary?.();
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(binary), 'companion.json'), 'utf8'));
    const companion = { upstreamVersion: manifest.upstreamVersion, baseCommit: manifest.baseCommit,
      patchSha256: manifest.patchSha256, buildInputsSha256: manifest.buildInputsSha256 };
    const valid = manifest.sha256 === runtimeHash && manifest.acceptance === true
      && typeof companion.upstreamVersion === 'string' && /^[a-f0-9]{40}$/.test(companion.baseCommit ?? '')
      && validHash(companion.patchSha256) && validHash(companion.buildInputsSha256);
    return { runtimeHash, companion: valid ? companion : null };
  } catch { return { runtimeHash, companion: null }; }
};

// Request-shaping policies a qualification was measured under. The same
// plugin bytes build different tool schemas under different values.
export const duplicatePolicyVector = (environment = {}) => ({
  waitAny: environment.DEVRYAN_MANAGED_WAIT_ANY === '1',
  capabilityToolSchema: environment.DEVRYAN_CAPABILITY_TOOL_SCHEMA !== '0',
});

const runtimeMatches = (candidate, runtimeHash, companion, environment) => {
  const identity = candidate.runtimeIdentity;
  // DEVRYAN_DUPLICATE_IDENTITY=binary restores exact binary pinning.
  if (!identity || environment.DEVRYAN_DUPLICATE_IDENTITY === 'binary') return validHash(candidate.runtimeHash) && candidate.runtimeHash === runtimeHash;
  return identity.kind === 'companion-build' && companion !== null
    && ['upstreamVersion', 'baseCommit', 'patchSha256', 'buildInputsSha256'].every(field => identity[field] === companion[field]);
};

export const readDuplicatePluginInventory = async (configuredPlugins, provider = {}) => {
  if (!Array.isArray(configuredPlugins) || !configuredPlugins.length || configuredPlugins.length > 128) return null;
  try {
    const entries = [];
    let bytes = 0;
    for (const spec of configuredPlugins) {
      if (typeof spec !== 'string') return null;
      const url = new URL(spec);
      if (url.protocol !== 'file:' || url.search || url.hash || !/\.(?:mjs|cjs|js|ts)$/.test(url.pathname)) return null;
      const file = await fs.open(url, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || (bytes += stat.size) > 32 * 1024 * 1024) return null;
        const body = await file.readFile();
        if (body.length > 8 * 1024 * 1024) return null;
        entries.push({ name: url.pathname.split('/').at(-1), sourceHash: digest(spec), contentHash: digest(body) });
      } finally { await file.close(); }
    }
    return { entries, providerHash: digest(JSON.stringify(stable(provider))), configurationHash: digest(JSON.stringify(configuredPlugins)), contentHash: digest(JSON.stringify(entries)) };
  } catch { return null; }
};

// An exact ordered configuration is a qualification input, not proof that all
// factories loaded. The release evidence must cover loading and later hooks at
// the provider boundary, including the runtime's built-in plugins/transport.
export const qualifyDuplicateOutputs = ({ managed, enabled, runtimeVersion, runtimeHash, companion = null, selection, inventory, callerInventory, providerRouteHash, providerRoute,
  policyVector = duplicatePolicyVector(), environment = {}, profiles = DUPLICATE_OUTPUT_PROFILES } = {}) => {
  const deny = reason => ({ qualified: false, reason });
  if (!managed) return deny('external-runtime');
  if (!enabled) return deny('policy-disabled');
  if (!validHash(runtimeHash)) return deny('runtime-identity-unavailable');
  if (!inventory || !callerInventory || !validHash(inventory.configurationHash) || !validHash(inventory.contentHash)
    || JSON.stringify(inventory) !== JSON.stringify(callerInventory)) return deny('inventory-unavailable-or-changed');
  if (!identity(selection?.providerID) || !identity(selection?.modelID)) return deny('selection-unavailable');
  const profile = profiles.find(candidate => candidate.runtimeVersion === runtimeVersion
    && runtimeMatches(candidate, runtimeHash, companion, environment)
    && candidate.transport === providerRoute
    && candidate.providerHash === (candidate.providerScope === 'selected-route' ? providerRouteHash : inventory.providerHash)
    && candidate.providerID === selection.providerID && candidate.modelID === selection.modelID
    && (candidate.variant ?? null) === (selection.variant ?? null)
    && duplicatePluginReleaseIdentity(candidate.plugins) !== null
    && JSON.stringify(duplicatePluginReleaseIdentity(candidate.plugins)) === JSON.stringify(duplicatePluginReleaseIdentity(inventory.entries)));
  if (!profile) return deny('profile-unqualified');
  if (profile.stale) return deny('profile-stale');
  if (profile.policyVector && JSON.stringify(stable(profile.policyVector)) !== JSON.stringify(stable(policyVector))) return deny('policy-vector-mismatch');
  if (!identity(profile.id) || !accepted(profile.evidence)) return deny('acceptance-incomplete');
  return { qualified: true, profileId: profile.id, runtimeVersion, runtimeHash, ...selection,
    variant: selection.variant ?? null, configurationHash: inventory.configurationHash, contentHash: inventory.contentHash };
};
