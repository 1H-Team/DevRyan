import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { reservePort, startOwnedProcess } from './process.mjs';
import { createDuplicateWireProxy, resolveDuplicateWireRoute } from './duplicate-wire-proxy.mjs';
import { duplicateLiveFixture, seedDuplicateLiveFixture, gradeDuplicateLiveReply } from './duplicate-live-fixture.mjs';
import { gradeDuplicateBehaviorPairs } from './duplicate-behavior.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const repository = fileURLToPath(new URL('../../', import.meta.url));

// The proposal's provider selects the only wire route the proxy will forward,
// and the proposal must be admitted under that route's host-attested transport,
// or its candidate arm could never qualify. Fails before any output exists.
export function resolveDuplicateLiveRoute(proposal) {
  const profile = proposal?.profile;
  if (!profile || typeof profile !== 'object') throw new Error('invalid-proposal');
  const route = resolveDuplicateWireRoute(profile.providerID);
  if (profile.transport !== route.transportIdentity) throw new Error(`proposal-transport-mismatch:${route.transportIdentity}`);
  if (typeof profile.modelID !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,200}$/.test(profile.modelID)) throw new Error('invalid-proposal-model');
  return route;
}

// This explicit live runner accepts only an already prepared, repository-owned
// profile. Candidate admission is staged in that private source copy, never in
// the release allowlist. Completing this runner does not itself promote it.
export async function runDuplicateLive({ base, bootstrap, pilot = false, verifyDefault = false }) {
  base = await fs.realpath(base);
  if (!base.startsWith(path.join(repository, '.cache/qa/'))) throw new Error('Owned repository QA profile required');
  const launch = JSON.parse(await fs.readFile(path.join(base, 'launch.json'), 'utf8'));
  for (const directory of [launch.workspace, launch.source, launch.env?.DEVRYAN_QA_HOME, launch.env?.HOME,
    launch.env?.OPENCHAMBER_DATA_DIR, launch.env?.XDG_CONFIG_HOME, launch.env?.XDG_DATA_HOME,
    launch.env?.XDG_STATE_HOME, launch.env?.XDG_CACHE_HOME]) {
    if (typeof directory !== 'string' || !path.resolve(directory).startsWith(base + path.sep)
      || !(await fs.realpath(directory)).startsWith(base + path.sep)) throw new Error('Prepared profile escaped its owned root');
  }
  bootstrap = await fs.realpath(bootstrap);
  if (!bootstrap.startsWith(path.join(repository, '.cache/qa/'))) throw new Error('Reviewed repository QA bootstrap required');
  if (launch.base !== base || await fs.readFile(path.join(launch.env.DEVRYAN_QA_HOME, '.devryan-qa-home'), 'utf8') !== 'owned QA home\n') throw new Error('QA ownership mismatch');
  const proposal = JSON.parse(await fs.readFile(path.join(base, 'proposal.json'), 'utf8'));
  const wireRoute = resolveDuplicateLiveRoute(proposal);
  const output = await fs.mkdtemp(path.join(base, pilot ? 'pilot-' : 'acceptance-'));
  let current = { arm: 'none', index: null, phase: 'bootstrap' };
  const wire = await createDuplicateWireProxy({ root: output, context: () => current, providerID: wireRoute.provider,
    model: proposal.profile.modelID, maximumRequests: pilot ? 12 : 64 });
  const pairs = Array.from({ length: pilot ? 2 : 10 }, (_, n) => { const index = pilot ? n * 5 : n; return { index, kind: duplicateLiveFixture(index).kind }; });
  const cleanups = [], failures = [];
  const selection = { providerID: proposal.profile.providerID, modelID: proposal.profile.modelID };
  const identity = { fixtureHash: null, environmentHash: hash({ runtimeHash: proposal.profile.runtimeHash, platform: process.platform, architecture: process.arch }),
    configurationHash: hash(proposal.profile) };
  try {
    for (const arm of ['baseline', 'candidate']) {
      const port = await reservePort();
      await fs.rm(path.join(base, 'ready.json'), { force: true });
      const childEnvironment = { ...launch.env, DEVRYAN_DUPLICATE_QA_BASE: base, OPENCHAMBER_PORT: String(port),
          DEVRYAN_DUPLICATE_OUTPUTS: arm === 'candidate' ? '1' : '0', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
          HTTPS_PROXY: wire.origin, https_proxy: wire.origin, NODE_EXTRA_CA_CERTS: wire.cert };
      if (verifyDefault && arm === 'candidate') delete childEnvironment.DEVRYAN_DUPLICATE_OUTPUTS;
      const child = startOwnedProcess('bun', [bootstrap], { cwd: repository, env: childEnvironment });
      const sessions = [];
      let request;
      try {
        const deadline = Date.now() + 180000; let ready;
        while (!ready) {
          child.check();
          try { ready = JSON.parse(await fs.readFile(path.join(base, 'ready.json'), 'utf8')); }
          catch { if (Date.now() > deadline) throw new Error('host-readiness-timeout'); await new Promise(resolve => setTimeout(resolve, 250)); }
        }
        request = async (route, method = 'GET', body) => {
          const url = new URL('/api' + route, ready.origin); url.searchParams.set('directory', launch.workspace);
          const response = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-devryan-csrf': '1' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180000) });
          if (!response.ok) throw new Error(`native-http-${response.status}`);
          const text = await response.text(); return text ? JSON.parse(text) : null;
        };
        const send = (id, prompt) => request(`/session/${id}/message`, 'POST', { model: selection, variant: proposal.profile.variant,
          agent: 'builder', parts: [{ type: 'text', text: prompt }] });
        current = { arm, index: null, phase: 'warmup' };
        const warm = await request('/session', 'POST', { title: 'Duplicate qualification control' }); sessions.push(warm.id);
        await send(warm.id, 'Reply with exactly READY. Do not use tools.');
        for (const pair of pairs) {
          current = { arm, index: pair.index, phase: 'continuity' };
          const fixture = duplicateLiveFixture(pair.index);
          const session = await request('/session', 'POST', { title: `Duplicate continuity ${pair.index}` }); sessions.push(session.id);
          await fs.rm(path.join(launch.workspace, 'mutation-count.txt'), { force: true });
          const seedIDs = await seedDuplicateLiveFixture(request, session.id, fixture, selection);
          const canonical = await request(`/session/${session.id}/message`);
          const before = hash(canonical.filter(row => seedIDs.includes(row.info.id)));
          await send(session.id, fixture.prompt);
          const messages = await request(`/session/${session.id}/message`);
          const after = hash(messages.filter(row => seedIDs.includes(row.info.id)));
          const grade = gradeDuplicateLiveReply(messages, seedIDs, fixture, await fs.readFile(path.join(launch.workspace, 'mutation-count.txt'), 'utf8'));
          const requests = wire.evidence.filter(row => row.arm === arm && row.request?.trialIndex === pair.index);
          const reductions = requests.reduce((sum, row) => sum + (row.request?.skillReferences ?? 0) + (row.request?.managedReferences ?? 0), 0);
          const validWire = requests.length > 0 && requests.every(row => row.status === 'complete' && row.request?.callPairsIntact && row.request?.referencesResolve
            && row.request.factHashes.includes(hash(fixture.facts)) && row.request.uniqueProofHashes.includes(hash(fixture.uniqueProof)));
          const result = { ...identity, fixtureHash: fixture.fixtureHash, duplicateOutputs: arm === 'candidate', executionMode: 'live',
            ...grade, completed: grade.completed && before === after && validWire, cleanupComplete: false,
            appliedReductions: reductions, canonicalUnchanged: before === after, validWire, sessionID: session.id,
            requestCount: requests.length, serializedBytes: requests.map(row => row.request?.bytes ?? null),
            compactionFrequency: messages.filter(row => row.info?.summary === true).length };
          pair[arm] = result;
          console.log(JSON.stringify({ arm, index: pair.index, kind: pair.kind, completed: result.completed,
            factsIntact: result.factsIntact, reductions, repeatedCalls: result.sameKeyRepeatCalls, mutations: result.repeatedMutations, requests: requests.length }));
          // Deleting a session aborts its background requests (its title), so
          // let every forwarded request finish first; a stuck one still fails.
          await wire.idle(60_000);
          await request(`/session/${session.id}`, 'DELETE'); sessions.splice(sessions.indexOf(session.id), 1);
        }
      } catch (error) { failures.push({ arm, reason: error.message }); }
      finally {
        await wire.idle(30_000);
        for (const id of sessions) {
          try { await request?.(`/session/${id}/abort`, 'POST'); await request?.(`/session/${id}`, 'DELETE'); }
          catch { failures.push({ arm, reason: 'session-cleanup-failed' }); }
        }
        await fs.writeFile(path.join(output, `${arm}-host.log`), child.getLog(), { mode: 0o600 });
        try { const cleanup = await child.stop(); cleanups.push({ arm, ...cleanup });
          for (const pair of pairs) if (pair[arm]) pair[arm].cleanupComplete = cleanup.rootObserved && cleanup.trackingClosed && cleanup.remainingProcessIds.length === 0;
        } catch { failures.push({ arm, reason: 'process-cleanup-failed' }); }
      }
    }
  } finally { await wire.close(); }
  for (const pair of pairs) for (const arm of ['baseline', 'candidate']) if (pair[arm]) pair[arm].reportHash = hash(pair[arm]);
  const sizes = pairs.map(pair => ({ index: pair.index, baseline: pair.baseline?.serializedBytes?.[0] ?? null,
    candidate: pair.candidate?.serializedBytes?.[0] ?? null }));
  const nonIncreasingRequests = sizes.every(row => row.baseline !== null && row.candidate !== null && row.candidate <= row.baseline);
  const behavior = gradeDuplicateBehaviorPairs(pairs);
  const probePassed = nonIncreasingRequests && !failures.length && !wire.failures.length && pairs.every(pair => [pair.baseline, pair.candidate]
    .every(trial => trial?.completed && trial.cleanupComplete && trial.criticalFailures === 0 && trial.repeatedMutations === 0)
    && pair.candidate.appliedReductions > 0 && pair.baseline.appliedReductions === 0 && pair.candidate.sameKeyRepeatCalls <= pair.baseline.sameKeyRepeatCalls);
  const result = { kind: verifyDefault ? 'release-default-verification' : pilot ? 'diagnostic-pilot' : 'duplicate-live-acceptance', profile: proposal.profile, wireRoute, pairs, sizes,
    nonIncreasingRequests, behavior, cleanups, failures, wireFailures: wire.failures, metadataRequests: wire.metadata, wire: wire.evidence,
    probePassed, verifiedDefault: verifyDefault && probePassed,
    qualified: !pilot && behavior.qualified && nonIncreasingRequests && !failures.length && !wire.failures.length,
    scope: 'Live model behavior over seeded skill/managed observations; actual native runtime and managed plugin configuration. Synthetic observations do not claim managed child execution.' };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output, qualified: result.qualified, verifiedDefault: result.verifiedDefault, probePassed, failures, wireFailures: wire.failures, behavior }));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , base, bootstrap, option] = process.argv;
  if (!base || !bootstrap || option && !['--pilot', '--verify-default'].includes(option)) throw new Error('Usage: node scripts/qa/duplicate-live.mjs PREPARED_ROOT BOOTSTRAP [--pilot|--verify-default]');
  const result = await runDuplicateLive({ base, bootstrap, pilot: Boolean(option), verifyDefault: option === '--verify-default' });
  if (!option && !result.qualified || !result.probePassed) process.exitCode = 1;
}
