import { evaluate } from './cdp.mjs';

export const INITIAL_BOOTSTRAP_TIMEOUT_MS = 180000;
const REQUEST_TIMEOUT_MS = 5000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const nativePrimaryAgent = (agents, requested) => {
  const visible = agents.filter(agent => !agent.hidden);
  const name = requested === 'builder' && !visible.some(agent => agent.name === 'builder') ? 'build' : requested;
  return visible.some(agent => agent.name === name) ? name : null;
};

export function initialBootstrapSnapshotExpression(cell) {
  return `(() => {
    const visible = e => { if (!e || e.disabled) return false; const r=e.getBoundingClientRect();
      if(r.width<=0||r.height<=0)return false;
      for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)<0.95)return false;}
      return true; };
    const state = window.__zustand_config_store__?.getState();
    const provider = state?.providers?.find(p => p.id === ${JSON.stringify(cell.providerId)});
    const model = provider?.models?.find(m => m.id === ${JSON.stringify(cell.modelId)});
    const selectedProvider = state?.providers?.find(p => p.id === state.currentProviderId);
    const selectedModel = selectedProvider?.models?.find(m => m.id === state.currentModelId);
    const agents = state?.agents?.filter(agent => !agent.hidden) ?? [];
    const nativeAgent = ${JSON.stringify(cell.agent)} === 'builder' && !agents.some(agent => agent.name === 'builder') ? 'build' : ${JSON.stringify(cell.agent)};
    const selectedAgent = agents.find(agent => agent.name === state?.currentAgentName);
    const control = selector => [...document.querySelectorAll(selector)].some(e => e.textContent.trim() && visible(e.closest('button')));
    return { origin:location.origin, initialized:state?.isInitialized === true,
      providersLoadStatus:state?.providersLoadStatus ?? null, agentsLoadStatus:state?.agentsLoadStatus ?? null,
      providerCount:state?.providers?.length ?? 0, agentCount:agents.length,
      pinnedModelAvailable:Boolean(model && model.available !== false),
      selectedModel:state ? {providerId:state.currentProviderId,modelId:state.currentModelId,agent:state.currentAgentName,variant:state.currentVariant ?? null,
        catalogAvailable:Boolean(selectedModel && selectedModel.available !== false)} : null,
      selectedAgentDefault:selectedAgent ? {model:selectedAgent.model,variant:selectedAgent.variant ?? null} : null,
      thinkingLabels:[...document.querySelectorAll('.model-controls__variant-trigger')].filter(e=>visible(e.closest('button'))).map(e=>e.innerText.trim()),
      nativeAgent:agents.some(agent => agent.name === nativeAgent) ? nativeAgent : null,
      composer:[...document.querySelectorAll('textarea')].some(visible),
      newChat:[...document.querySelectorAll('button[aria-label="New Chat"]')].some(visible),
      modelControl:control('.model-controls__model-label'), agentControl:control('.model-controls__agent-label') };
  })()`;
}

export const initialBootstrapIsReady = snapshot => snapshot.initialized === true
  && snapshot.providersLoadStatus === 'ready' && snapshot.agentsLoadStatus === 'ready'
  && snapshot.pinnedModelAvailable === true && Boolean(snapshot.nativeAgent)
  && snapshot.composer === true && snapshot.newChat === true
  && snapshot.modelControl === true && snapshot.agentControl === true;

export const effectiveQaSelectionIsReady = (snapshot, cell, nativeAgent) => initialBootstrapIsReady(snapshot)
  && snapshot.nativeAgent === nativeAgent
  && snapshot.selectedModel?.providerId === cell.providerId
  && snapshot.selectedModel?.modelId === cell.modelId
  && snapshot.selectedModel?.agent === nativeAgent
  && snapshot.selectedModel?.catalogAvailable === true
  && (cell.transport !== 'fixture' || (snapshot.selectedModel.variant === 'low'
    && snapshot.selectedAgentDefault?.model?.providerID === cell.providerId
    && snapshot.selectedAgentDefault?.model?.modelID === cell.modelId
    && snapshot.selectedAgentDefault?.variant === 'low' && snapshot.thinkingLabels?.includes('Low')));

const bounded = async (promise, timeoutMs, label) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: initial bootstrap ${label}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
};

async function readInitialCatalogs({ origin, directory, cell, timeoutMs, fetchImpl, now }) {
  const read = async route => {
    const startedAt = now();
    try {
      const url = new URL(route, origin);
      url.searchParams.set('directory', directory);
      const response = await fetchImpl(url, { headers: { accept: 'application/json', 'x-opencode-directory': directory },
        signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))) });
      if ([502, 503].includes(response.status)) return { route, status: response.status, durationMs: now() - startedAt, retry: true };
      if (!response.ok) throw new Error(`Initial bootstrap ${route}: HTTP ${response.status}`);
      const body = await response.json();
      return { route, status: response.status, durationMs: now() - startedAt, body };
    } catch (error) {
      if (['TimeoutError', 'AbortError', 'TypeError'].includes(error.name)
        || ['ECONNREFUSED', 'ConnectionRefused'].includes(error.code ?? error.cause?.code)) {
        return { route, durationMs: now() - startedAt, retry: true, reason: error.name };
      }
      throw error;
    }
  };
  const results = await Promise.all([read('/api/provider'), read('/api/agent')]);
  const attempts = results.map(({ route, status, durationMs, retry, reason }) => ({ route, status, durationMs, retry, reason }));
  if (results.some(result => result.retry)) return { attempts };
  const [providers, agents] = results.map(result => result.body);
  if (!Array.isArray(providers?.all) || !Array.isArray(providers.connected) || !Array.isArray(agents)) {
    throw new Error('Initial bootstrap catalog response has an invalid shape');
  }
  const provider = providers.all.find(value => value.id === cell.providerId);
  if (!provider?.models?.[cell.modelId] || provider.models[cell.modelId].available === false
    || !providers.connected.includes(cell.providerId)) throw new Error('Initial bootstrap pinned model access is unavailable');
  const nativeAgent = nativePrimaryAgent(agents, cell.agent);
  if (!nativeAgent) throw new Error('Initial bootstrap pinned primary agent is unavailable');
  return { attempts, catalog: { providerId: cell.providerId, modelId: cell.modelId, nativeAgent, connected: true } };
}

// Only the first cold reload uses this gate. The UI driver's ordinary reload
// remains at 30 seconds for every subsequent persistence/reconnection check.
export async function reloadQaInitialBootstrap({ cdp, cell, directory, cellDeadline,
  checkAlive = () => {}, record = async () => {}, timeoutMs = INITIAL_BOOTSTRAP_TIMEOUT_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS, intervalMs = 250, fetchImpl = fetch,
  now = Date.now, wait = delay }) {
  const startedAt = now();
  const deadline = Math.min(startedAt + timeoutMs, cellDeadline);
  const evidence = { outcome: 'pending', timeoutMs: Math.max(0, deadline - startedAt),
    scope: 'first cold reload only; actual UI and pinned native catalogs', phases: [], catalogAttempts: [], lastSnapshot: null };
  const remaining = () => {
    checkAlive();
    const value = deadline - now();
    if (value <= 0) throw new Error('Timed out: initial application bootstrap');
    return value;
  };
  const phase = async name => { evidence.phases.push({ name, elapsedMs: now() - startedAt }); await record(evidence); };
  try {
    await phase('reload-started');
    const documentTimeout = Math.min(30000, remaining());
    await Promise.all([cdp.waitFor('Page.loadEventFired', documentTimeout),
      bounded(cdp.send('Page.reload'), documentTimeout, 'reload')]);
    await bounded(cdp.send('Page.bringToFront'), Math.min(30000, remaining()), 'foreground');
    await phase('document-loaded');
    let previousSnapshot;
    while (true) {
      const snapshot = await bounded(evaluate(cdp, initialBootstrapSnapshotExpression(cell)),
        Math.min(requestTimeoutMs, remaining()), 'UI snapshot');
      evidence.lastSnapshot = { ...snapshot, elapsedMs: now() - startedAt };
      if (JSON.stringify(snapshot) !== previousSnapshot) {
        previousSnapshot = JSON.stringify(snapshot);
        await record(evidence);
      }
      if (!evidence.catalog && /^http:\/\/127\.0\.0\.1:\d+$/.test(snapshot.origin)) {
        const result = await readInitialCatalogs({ origin: snapshot.origin, directory, cell,
          timeoutMs: Math.min(requestTimeoutMs, remaining()), fetchImpl, now });
        evidence.catalogAttempts.push({ elapsedMs: now() - startedAt, requests: result.attempts });
        if (result.catalog) { evidence.catalog = result.catalog; await phase('native-catalogs-ready'); }
        else await record(evidence);
      }
      if (evidence.catalog && initialBootstrapIsReady(snapshot) && snapshot.nativeAgent === evidence.catalog.nativeAgent) {
        evidence.outcome = 'passed';
        await phase('usable-ui-ready');
        return evidence;
      }
      await wait(Math.min(intervalMs, remaining()));
    }
  } catch (error) {
    evidence.outcome = 'failed'; evidence.error = error.message;
    throw error;
  } finally { evidence.elapsedMs = now() - startedAt; await record(evidence); }
}
