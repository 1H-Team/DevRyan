import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reservePort, startOwnedProcess } from './process.mjs';
import { createRuntimeDigestReader } from '../../packages/web/server/lib/opencode/harness-duplicate-qualification.js';

const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const objects = value => Array.isArray(value) ? value.flatMap(objects) : value && typeof value === 'object'
  ? [value, ...Object.values(value).flatMap(objects)] : [];
export const inspectDuplicateRequest = (body, raw) => {
  const values = strings(body);
  const outputs = objects(body).filter(value => value.type === 'function_call_output');
  const calls = new Set(objects(body).filter(value => value.type === 'function_call').map(value => value.call_id));
  const references = values.filter(value => value.startsWith('{') && value.includes('"observation":"identical-managed-result"'))
    .map(value => { const parsed = JSON.parse(value); return { taskId: parsed.taskId, envelopeId: parsed.envelopeId, reference: parsed.reference }; });
  return { bytes: Buffer.byteLength(raw), skillReferences: values.filter(value => value.includes('<devryan_skill_reuse>')).length,
    managedReferences: values.filter(value => value.includes('"observation":"identical-managed-result"')).length,
    skillEvidence: values.some(value => value.includes('SKILL_UNIQUE_SENTINEL')),
    managedEvidence: values.some(value => value.includes('MANAGED_UNIQUE_SENTINEL')),
    uniqueEvidence: values.some(value => value.includes('UNIQUE_EVIDENCE_RETAINED')),
    callPairsIntact: outputs.every(value => calls.has(value.call_id)),
    referencesResolve: references.every(ref => outputs.some(value => value.call_id === ref.reference?.callID && strings(value.output).some(text => {
      try { const source = JSON.parse(text); return source.task?.taskId === ref.taskId && source.resultHeader?.envelopeId === ref.envelopeId && text.includes('MANAGED_UNIQUE_SENTINEL'); }
      catch { return false; }
    }))), references };
};

export async function runDuplicateSerializerProbe({ binary, respond }) {
  if (!path.isAbsolute(binary)) throw new Error('Explicit absolute OpenCode binary required');
  const base = fileURLToPath(new URL('../../.cache/qa/', import.meta.url)); await fs.mkdir(base, { recursive: true });
  const output = await fs.mkdtemp(path.join(base, 'duplicate-serializer-'));
  const runtimeVersion = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  const runtimeHash = await createRuntimeDigestReader(() => binary)();
  let pluginInventory = null;
  const observations = [], hookObservations = [], lifecycle = [], cleanup = [], failures = [];
  // API keys and usage below are synthetic. This never reads installed profiles.
  for (const arm of ['baseline', 'candidate']) {
    const root = path.join(output, arm === 'baseline' ? 'baseline' : 'canary00'), home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
    await fs.mkdir(home, { recursive: true }); await fs.mkdir(workspace);
    for (const directory of [path.join(home, 'config/opencode'), path.join(home, 'overlay')]) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.18.31' } }));
      await fs.mkdir(path.join(directory, 'node_modules/@opencode-ai'), { recursive: true });
      const installed = fileURLToPath(new URL('../../packages/web/node_modules/@opencode-ai/plugin', import.meta.url));
      const manifest = JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8'));
      if (manifest.version !== '1.18.31') throw new Error('Existing fixture plugin SDK version mismatch');
      await fs.symlink(installed, path.join(directory, 'node_modules/@opencode-ai/plugin'), 'dir');
      await fs.writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3,
        packages: { '': { dependencies: { '@opencode-ai/plugin': manifest.version } } } }));
      await fs.writeFile(path.join(directory, '.npmrc'), 'offline=true\nignore-scripts=true\n');
    }
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '--quiet', workspace]);
    await fs.writeFile(path.join(root, 'context.json'), JSON.stringify({ mode: 'duplicates' }));
    let label = 'warmup', highUsage = false;
    const server = http.createServer(async (req, res) => {
      try {
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2 * 1024 * 1024) throw new Error('oversized fixture'); }
        const body = JSON.parse(raw);
        if (req.url === '/rpc') {
          if (body.method === 'harness_duplicate_qualification') pluginInventory = body.params.inventory;
          if (body.method === 'harness_context_observation' && body.params.phase === 'hook-applied') {
            const { appliedReductions, plannedReductions, savedBytes, transformDurationMs } = body.params;
            hookObservations.push({ arm, label, appliedReductions, plannedReductions, savedBytes, transformDurationMs });
          }
          const result = body.method === 'harness_capabilities' ? { policies: { duplicateOutputs: arm === 'candidate', contextProjection: true } }
            : body.method === 'harness_duplicate_qualification' ? { qualified: true, ...body.params, ...body.params.inventory, profileId: 'synthetic-only' }
              : { available: false };
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); return;
        }
        const phase = JSON.parse(await fs.readFile(path.join(root, 'phase.json'), 'utf8'));
        observations.push({ arm, label, ...phase, ...inspectDuplicateRequest(body, raw) });
        respond(res, body, observations.length, highUsage ? 127500 : 10000); highUsage = false;
      } catch { res.writeHead(500); res.end('Synthetic duplicate probe rejected request'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const plugins = ['./duplicate-serializer-fixture.mjs', '../../packages/web/server/default-config/plugins/devryan-harness-context.mjs',
      '../../packages/web/server/default-config/plugins/devryan-skill-context.mjs',
      '../../packages/web/server/default-config/plugins/devryan-document-reader.mjs', '../../packages/web/server/default-config/plugins/devryan-tool-input-guard.mjs']
      .map(file => new URL(file, import.meta.url).href);
    const config = path.join(root, 'opencode.json');
    await fs.writeFile(config, JSON.stringify({ provider: { openai: { options: { baseURL: origin + '/v1', apiKey: 'synthetic-qa' },
      models: { 'gpt-5.6-sol': { name: 'gpt-5.6-sol', limit: { input: 128000, context: 128000, output: 1000 } } } } },
      model: 'openai/gpt-5.6-sol', small_model: 'openai/gpt-5.6-sol', plugin: plugins, enabled_providers: ['openai'], agent: { title: { disable: true } } }));
    const port = await reservePort();
    const child = startOwnedProcess(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: workspace,
      env: { PATH: process.env.PATH, HOME: home, OPENCODE_TEST_HOME: home, LANG: 'en_US.UTF-8',
        XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
        OPENCODE_CONFIG: config, OPENCODE_CONFIG_DIR: path.join(home, 'overlay'), OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
        OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
        OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true', OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(home, 'managed'), DEVRYAN_DUPLICATE_PROBE_ROOT: root,
        DEVRYAN_OPENCODE_USER_CONFIG_DIR: path.join(home, 'overlay'), DEVRYAN_ORCHESTRATION_URL: origin + '/rpc', DEVRYAN_ORCHESTRATION_TOKEN: 'synthetic-qa' } });
    const request = async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-opencode-directory': workspace },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`Native fixture HTTP ${response.status} at ${route.replace(/ses_[^/]+/, 'session')}`);
      return response.json();
    };
    const prompt = id => request(`/session/${id}/message`, { model: { providerID: 'openai', modelID: 'gpt-5.6-sol' }, agent: 'build', parts: [{ type: 'text', text: 'Reply done.' }] });
    try {
      const deadline = Date.now() + 60000;
      for (;;) { child.check(); try { await request('/global/health'); break; } catch (error) { if (Date.now() >= deadline) throw error; } await new Promise(resolve => setTimeout(resolve, 100)); }
      const warm = await request('/session', { title: 'Synthetic qualification warmup' }); await prompt(warm.id);
      // Qualification is asynchronous; the warmup response provides the native
      // scheduling boundary, and the bridge reply must settle before sampling.
      for (const mode of ['control', 'duplicates', 'pruned']) {
        label = mode; await fs.writeFile(path.join(root, 'context.json'), JSON.stringify({ mode }));
        const session = await request('/session', { title: 'Synthetic duplicate fixture' }); await prompt(session.id);
        const canonical = await request(`/session/${session.id}/message`);
        if (JSON.stringify(canonical).includes('SKILL_UNIQUE_SENTINEL') || JSON.stringify(canonical).includes('devryan_skill_reuse')) failures.push(`${arm}:canonical-history-modified`);
      }
      label = 'manual'; await fs.writeFile(path.join(root, 'context.json'), JSON.stringify({ mode: 'duplicates' }));
      const session = await request('/session', { title: 'Synthetic native summaries' }); await prompt(session.id);
      for (let i = 0; i < 2; i++) {
        await request(`/session/${session.id}/summarize`, { providerID: 'openai', modelID: 'gpt-5.6-sol', auto: false }); await prompt(session.id);
      }
      label = 'automatic'; highUsage = true;
      const automatic = await request('/session', { title: 'Synthetic overflow' });
      const pressure = await prompt(automatic.id); lifecycle.push({ arm, syntheticPressureTokens: pressure.info?.tokens }); await prompt(automatic.id);
      const order = (await fs.readFile(path.join(root, 'ordering.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
      lifecycle.push({ arm, order, valid: order.every((entry, i) => entry.phase !== 'summary' || order[i - 1]?.phase === 'compacting') });
    } catch (error) { failures.push(`${arm}:${error.message}`); await fs.writeFile(path.join(output, `${arm}-native.log`), child.getLog());
      for (const file of await fs.readdir(path.join(home, 'data/opencode/log')).catch(() => [])) {
        await fs.copyFile(path.join(home, 'data/opencode/log', file), path.join(output, `${arm}-${file}`));
      } }
    finally {
      let stopped = false;
      try { cleanup.push(await child.stop()); stopped = true; }
      catch { failures.push(`${arm}:owned-process-cleanup-incomplete`); }
      finally {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        if (stopped) await fs.rm(root, { recursive: true, force: true });
      }
    }
  }
  const samples = label => observations.filter(row => row.label === label && row.phase === 'ordinary');
  const paired = ['control', 'duplicates', 'pruned'].map(label => {
    const rows = samples(label), before = rows.find(row => row.arm === 'baseline'), after = rows.find(row => row.arm === 'candidate');
    return { label, baselineBytes: before?.bytes ?? null, candidateBytes: after?.bytes ?? null,
      passed: rows.length === 2 && after.bytes <= before.bytes && (label !== 'control' || after.bytes === before.bytes)
        && before.skillReferences === 0 && before.managedReferences === 0
        && (label === 'control' ? after.skillReferences === 0 && after.managedReferences === 0 : after.skillReferences > 0 && after.managedReferences > 0) };
  });
  const summaries = observations.filter(row => row.phase === 'summary');
  const checks = { paired: paired.every(row => row.passed), uniqueEvidence: observations.every(row => row.skillEvidence && row.managedEvidence && row.uniqueEvidence),
    cleanupComplete: cleanup.length === 2 && cleanup.every(row => row.rootObserved && row.trackingClosed && row.remainingProcessIds.length === 0),
    referencesResolve: observations.every(row => row.referencesResolve), callPairsIntact: observations.every(row => row.callPairsIntact),
    summaryReferencesAbsent: summaries.every(row => !row.skillReferences && !row.managedReferences),
    manualBoundaries: ['baseline', 'candidate'].every(arm => summaries.filter(row => row.arm === arm && row.label === 'manual').length === 2),
    automaticBoundary: ['baseline', 'candidate'].every(arm => summaries.some(row => row.arm === arm && row.label === 'automatic')),
    nativeOrdering: lifecycle.filter(row => row.order).length === 2 && lifecycle.filter(row => row.order).every(row => row.valid),
    prunedAnchorsRejected: samples('pruned').every(row => row.references.every(ref => ref.reference.callID !== 'call_msg_managed_0')) };
  const evidence = { kind: 'duplicate-outputs', runtimeVersion, runtimeHash, pluginInventory, liveProvider: false, qualification: 'synthetic-fixture-only',
    passed: !failures.length && Object.values(checks).every(Boolean), checks, paired, failures, cleanup,
    compactionFrequency: summaries.length, lifecycle, providerInputTokens: null, providerCacheTokens: null, peakInputTokens: null,
    peakSerializedRequestBytes: Math.max(0, ...observations.map(row => row.bytes)), hookObservations,
    transformTimingScope: 'observed hook only; concurrent test workload; not provider or end-to-end latency', observations, output };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2)); return evidence;
}
