// Controlled local dependencies only. Measures application preparation, not live providers/Docker.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createBotOpenCodeProvider } from '../../../packages/web/server/lib/bots/opencode-provider.js';
import { createBotWarmRuntimeLeases } from '../../../packages/web/server/lib/bots/warm-runtime-leases.js';
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const binding = { principalId: randomUUID(), botId: randomUUID(), channelId: randomUUID(), revisionId: randomUUID(), librarySnapshotKey: '' };
const model = { providerId: 'fixture', modelId: 'fixture' };
const contract = { models: { primary: model, fallbacks: [] } };
const run = { id: randomUUID(), botId: binding.botId, channelId: binding.channelId, revisionId: binding.revisionId, ownerUserId: binding.principalId, updatedAt: '2026-09-07T00:00:00Z' };
const sample = async (scenario) => {
  const provider = createBotOpenCodeProvider({
    dockerProvider: { ensureReasoning: async () => ({ endpoint: { baseUrl: 'http://127.0.0.1:55101', port: 55101, host: '127.0.0.1' } }), stopReasoning: async () => ({ state: 'stopped' }) },
    configCompiler: { compile: async () => ({ compiledHash: 'a'.repeat(64), contract, directory: '/fixture' }) },
    modelCredentialBroker: { preflightRun: async () => ({}), prepareRun: async () => ({ model, modelSnapshot: model, egressHosts: ['example.com:443'], chatgptImageGeneration: scenario === 'image' }), prepareProvisionalRun: async () => ({ model, modelSnapshot: model, egressHosts: ['example.com:443'] }), finalizeRun: async () => ({}), discardRun: async () => ({}) },
    gatewayHost: { start: async () => {}, issueCapability: () => ({ token: 't'.repeat(43), dockerGatewayUrl: 'http://host.docker.internal:55100', expiresAt: Date.now()+60000 }), revokeRun: () => 1, shutdown: async () => {} },
    artifactService: { materializeRun: async () => { await delay(scenario === 'attachment' ? 35 : 20); return { objectCount: 0 }; }, cleanupRun: async () => ({}) },
    environmentSecrets: { prepareRun: async () => { await delay(20); return { count: 0 }; }, finalizeRun: async () => ({}) },
    createClient: () => ({ session: { abort: async () => ({}), create: async () => ({ data: { id: 'fixture' } }), promptAsync: async () => ({}), messages: async () => ({ data: [] }) } }),
    waitForReady: async () => {},
  });
  const start = performance.now();
  await provider.startReasoningRun({ run, contract, catalog: [], ...(scenario === 'attachment' ? { attachmentIds: [randomUUID()] } : {}) });
  const duration = performance.now()-start;
  await provider.shutdown();
  return duration;
};
const values = {};
for (const scenario of ['text', 'image', 'attachment']) {
  values[`${scenario}PreparationMs`] = [];
  for (let i=0;i<25;i++) values[`${scenario}PreparationMs`].push(await sample(scenario));
}
values.inflightWarmReservationMs = [];
for(let i=0;i<25;i++) {
  const leases = createBotWarmRuntimeLeases({ uuid: randomUUID, prepare: () => delay(40), stop: async () => {} });
  const lease = leases.begin(binding);
  const start = performance.now();
  const claim = await leases.claim({ ...binding, leaseId: lease.leaseId, messageId: randomUUID() });
  values.inflightWarmReservationMs.push(performance.now()-start);
  if (leases.waitForClaim) await leases.waitForClaim(claim.runId);
  await leases.shutdown();
}
const summarize = values => { const sorted = [...values].sort((a,b)=>a-b); return { n: values.length, p50: sorted[Math.floor(sorted.length*.5)], p95: sorted[Math.floor(sorted.length*.95)], samples: values }; };
const result = { synthetic: true, dependencyDelaysMs: { environment:20, materialization:20, attachmentMaterialization:35, warmPreparation:40 }, limitations: 'Application preparation and warm reservation only; excludes live provider, Docker startup, browser commands, acknowledgment paint and final completion.', metrics: Object.fromEntries(Object.entries(values).map(([key,value])=>[key,summarize(value)])) };
await writeFile(new URL(`./${process.argv[2] || 'results'}.json`, import.meta.url), JSON.stringify(result, null, 2)+'\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(result.metrics).map(([key,{n,p50,p95}])=>[key,{n,p50,p95}]))));
