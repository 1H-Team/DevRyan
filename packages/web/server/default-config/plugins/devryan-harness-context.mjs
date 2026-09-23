import crypto from 'node:crypto';
import fs from 'node:fs';

const COMPACTION_ANCHOR_TAG = '[devryan-compaction-anchor:v1]';

const registryKey = Symbol.for('devryan.plugin-factories.v1');
const identity = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const count = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const checkObserverUnavailable = (error) => error?.code === 'managed_bridge_authentication_failed' ? error : Object.assign(
  new Error('Required-check observation is unavailable. Restore the managed runtime connection before retrying this command.'),
  { code: 'managed_check_observer_unavailable', statusCode: 503 },
);
const visibleBytes = (messages) => messages.reduce((total, message) => total + (message.parts ?? []).reduce((sum, part) => {
  if (part?.type === 'text') return sum + Buffer.byteLength(part.text ?? '');
  if (part?.type === 'tool' && typeof part.state?.output === 'string') return sum + Buffer.byteLength(part.state.output);
  return sum;
}, 0), 0);

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = (value) => Array.isArray(value) ? value.map(stable) : record(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const encodedBytes = (value) => Buffer.byteLength(JSON.stringify(value));
const SKILL_REUSE = '<devryan_skill_reuse>';
const protectedFields = (value) => record(value) && Object.keys(value).some(key =>
  key !== 'providerID' && /provider|signature|opaque|encrypted|reasoning/i.test(key) && value[key] != null);
const sessionOf = (messages) => {
  if (!Array.isArray(messages) || !messages.length) return null;
  const sessionID = identity(messages[0]?.info?.sessionID);
  return sessionID && messages.every(message => message?.info?.sessionID === sessionID
    && identity(message.info.id) && Array.isArray(message.parts)
    && message.parts.every(part => record(part) && (!part.sessionID || part.sessionID === sessionID)
      && (!part?.messageID || part.messageID === message.info.id))) ? sessionID : null;
};
const observationKey = (part) => part?.tool === 'skill' && identity(part.state?.input?.name)
  ? `skill:${part.state.input.name}` : part?.tool === 'devryan_task'
    && ['status', 'wait'].includes(part.state?.input?.action) ? 'managed' : null;

// Request-local only. The native caller consumes this very array, ignoring a
// replacement output.messages. Clone changed records, never canonical records.
const projectObservations = (messages) => {
  const stats = { plannedReductions: 0, appliedReductions: 0, savedBytes: 0 };
  const sessionID = sessionOf(messages);
  if (!sessionID) return stats;
  const seen = new Map();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.info.summary === true || message.parts.some(part => part?.type === 'compaction')) { seen.clear(); continue; }
    if (message.info.role !== 'assistant') continue;
    const messageProtected = protectedFields(message.info) || message.parts.some(part => protectedFields(part) || protectedFields(part.metadata));
    let parts = message.parts;
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      let key = observationKey(part);
      if (part?.type !== 'tool' || !key) continue;
      const state = part.state;
      let task, header;
      if (key === 'managed') {
        try { const result = JSON.parse(state.output); task = result?.task; header = result?.resultHeader;
          if (!identity(task?.taskId)?.startsWith('dvr_task_') || task.rootSessionId !== sessionID
            || header?.schemaVersion !== 1 || header.taskId !== task.taskId
            || !identity(header.envelopeId) || header.envelopeId !== result.resultEnvelope?.envelopeId
            || header.outcome?.status !== task.status) { seen.clear(); continue; }
          key = `managed:${task.taskId}`;
        } catch { seen.clear(); continue; }
      }
      // A noneligible observation breaks this key's sequence, including native
      // prune markers, errors, references and unknown metadata transitions.
      if (state?.status !== 'completed' || !identity(part.callID)
        || state.time?.compacted != null || state.attachments?.length || part.attachments?.length || message.info.error
        || messageProtected || protectedFields(state)
        || protectedFields(state.metadata)
        || (part.tool === 'skill' && Object.entries(state.metadata ?? {}).some(([key, value]) => !['name', 'dir'].includes(key) || typeof value !== 'string'))
        || (part.tool === 'devryan_task' && Object.keys(state.metadata ?? {}).length)
        || typeof state.output !== 'string' || !state.output.trim()
        || Buffer.byteLength(state.output) > 256 * 1024 || state.output.includes(SKILL_REUSE)
        || state.output.includes('"observation":"identical-managed-result"')) { seen.delete(key); continue; }
      // Arguments and metadata are part of equivalence; timing and call IDs are
      // deliberately not. Distinct versions invalidate the earlier anchor.
      const version = hash(JSON.stringify(stable({ output: state.output, input: state.input,
        metadata: state.metadata, title: state.title })));
      const previous = seen.get(key);
      const anchor = { version, reference: { messageID: message.info.id, callID: part.callID } };
      if (!previous || previous.version !== version || previous.shortened) { seen.set(key, anchor); continue; }
      const output = part.tool === 'skill'
        ? `${SKILL_REUSE}The byte-identical completed skill content is retained earlier in this active context. Continue following that full content.</devryan_skill_reuse>`
        : JSON.stringify({ schemaVersion: 1, observation: 'identical-managed-result', taskId: task.taskId,
          envelopeId: header.envelopeId, reference: previous.reference,
          instruction: 'Use the retained identical task/envelope observation; no new status or verification is implied.' });
      const reduction = encodedBytes(state.output) - encodedBytes(output);
      if (reduction <= 0) { seen.set(key, anchor); continue; }
      stats.plannedReductions++;
      if (parts === message.parts) parts = [...parts];
      parts[j] = { ...part, state: { ...state, output } };
      seen.set(key, { ...previous, shortened: true });
      stats.appliedReductions++; stats.savedBytes += reduction;
    }
    if (parts !== message.parts) messages[i] = { ...message, parts };
  }
  return stats;
};

// Native config includes auto-discovered plugins in this ordered list. Only
// local code files qualify; package resolution and unknown options stay off.
// No file body, source path or plugin options leave the private bridge.
const pluginInventory = (config) => {
  if (!Array.isArray(config?.plugin) || !config.plugin.length || config.plugin.length > 128) return null;
  try {
    let bytes = 0;
    const entries = config.plugin.map(spec => {
      if (typeof spec !== 'string') throw new Error('Unknown plugin options');
      const url = new URL(spec);
      if (url.protocol !== 'file:' || url.search || url.hash || !/\.(?:mjs|cjs|js|ts)$/.test(url.pathname)) throw new Error('Unknown plugin source');
      const stat = fs.statSync(url);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || (bytes += stat.size) > 32 * 1024 * 1024) throw new Error('Unknown plugin file');
      return { name: url.pathname.split('/').at(-1), sourceHash: hash(spec), contentHash: hash(fs.readFileSync(url)) };
    });
    return { entries, providerHash: hash(JSON.stringify(stable(config.provider ?? {}))), configurationHash: hash(JSON.stringify(config.plugin)), contentHash: hash(JSON.stringify(entries)) };
  } catch { return null; }
};

const measureHeadroom = (model, messages, variant) => {
  const limit = { ...(model?.limit ?? {}), ...(model?.variants?.[variant]?.limit ?? {}) };
  const capacity = [limit.input, limit.context].filter((value) => count(value) !== null && value > 0);
  const inputCapacity = capacity.length ? Math.min(...capacity) : null;
  let latest = null;
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.parts?.some((part) => part.type === 'compaction')) break;
    const info = message?.info;
    if (info?.role !== 'assistant' || info.providerID !== model?.providerID || info.modelID !== model?.id) continue;
    if (count(info.tokens?.input) === null) continue;
    latest = info; break;
  }
  const tokens = latest?.tokens;
  const previousInput = tokens ? tokens.input + (count(tokens.cache?.read) ?? 0) + (count(tokens.cache?.write) ?? 0) : null;
  const estimate = previousInput === null ? null : previousInput + (count(tokens.output) ?? 0) + (count(tokens.reasoning) ?? 0);
  return { inputCapacity, capacitySource: inputCapacity === null ? 'unknown' : 'declared-model-limits',
    previousRequestInputTokens: previousInput, sourceMessageID: latest?.id ?? null,
    estimatedHeadroomTokens: inputCapacity === null || estimate === null ? null : Math.max(0, inputCapacity - estimate),
    estimateBasis: 'previous-provider-input-plus-output; excludes new messages, tools and dynamic system additions',
    currentActiveContextTokens: null, visibleContextBytes: visibleBytes(messages ?? []), byteScope: 'text-and-tool-output-only' };
};

// Diagnostics are asynchronous and bounded. Canonical sessions and task stores
// remain authoritative when a host is unavailable or observation is incomplete.
export const DevRyanHarnessContextPlugin = async ({ client, directory, fetchImpl = fetch, now = Date.now } = {}) => {
  const rawUrl = process.env.DEVRYAN_ORCHESTRATION_URL;
  const token = process.env.DEVRYAN_ORCHESTRATION_TOKEN;
  if (!rawUrl || !token) return {};
  const factories = globalThis[registryKey] ??= new Map();
  const factoryKey = `harness-context:${directory}:${import.meta.url}`;
  let contentHash = null;
  try { contentHash = crypto.createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'); } catch { /* optional diagnostic identity */ }
  factories.set(factoryKey, { name: 'devryan-harness-context', directory, contentHash,
    factoryCalls: (factories.get(factoryKey)?.factoryCalls ?? 0) + 1, ownership: 'managed' });
  while (factories.size > 256) factories.delete(factories.keys().next().value);
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/rpc') throw new Error('Invalid harness context bridge');
  const seen = new Set();
  const pending = new Set();
  const controller = new AbortController();
  const rpc = async (method, params, { timeoutMs = 15_000 } = {}) => {
    const response = await fetchImpl(url, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]) });
    if (response.status === 401) throw Object.assign(
      new Error('The managed runtime bridge is no longer authenticated. Reconnect the managed OpenCode runtime before retrying.'),
      { code: 'managed_bridge_authentication_failed', statusCode: 401 },
    );
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error('Harness context host unavailable');
    return payload.result;
  };
  let policies = null;
  const checks = new Map();
  const activeMessages = new Map();
  let capabilityRequest = null;
  let capabilityFailure = null;
  let retryCapabilitiesAt = 0;
  const suppressSummary = new Set();
  const summarySystem = new Set();
  let suppressionOverflow = false;
  let nativeConfig = null;
  let inventory = null;
  const refreshInventory = () => {
    if (!nativeConfig || policies?.duplicateOutputs !== true) return;
    inventory = pluginInventory(nativeConfig);
    if (!inventory?.entries.some(entry => entry.name === 'devryan-harness-context.mjs' && entry.contentHash === contentHash)) inventory = null;
  };
  const qualifications = new Map();
  const qualificationRequests = new Map();
  const loadCapabilities = ({ optional = false } = {}) => {
    if (controller.signal.aborted) return Promise.resolve(null);
    if (policies) return Promise.resolve(policies);
    if (capabilityRequest) return capabilityRequest;
    if (optional && now() < retryCapabilitiesAt) return Promise.resolve(null);
    capabilityRequest = rpc('harness_capabilities', { directory }).then(value => {
      if (!value?.policies || typeof value.policies !== 'object' || Array.isArray(value.policies)) throw new Error('Invalid harness capabilities');
      policies = value.policies;
      refreshInventory();
      capabilityFailure = null;
      return policies;
    }).catch(error => { capabilityFailure = error; retryCapabilitiesAt = now() + 30_000; return null; }).finally(() => { capabilityRequest = null; });
    return capabilityRequest;
  };
  void loadCapabilities({ optional: true });
  const selectionOf = (messages) => {
    const user = messages.findLast(message => message.info.role === 'user');
    const model = user?.info.model;
    if (user?.info.variant && model?.variant && user.info.variant !== model.variant) return null;
    return identity(model?.providerID) && identity(model?.modelID)
      ? { providerID: model.providerID, modelID: model.modelID, variant: identity(model.variant ?? user.info.variant) } : null;
  };
  const qualificationFor = (selection) => {
    if (!selection || !inventory || !nativeConfig || controller.signal.aborted) return null;
    // Later config hooks may have changed the list after our own config hook.
    if (hash(JSON.stringify(nativeConfig.plugin)) !== inventory.configurationHash
      || hash(JSON.stringify(stable(nativeConfig.provider ?? {}))) !== inventory.providerHash) return null;
    const key = JSON.stringify(selection);
    const cached = qualifications.get(key);
    if (cached?.qualified === true) return cached;
    if (!qualificationRequests.has(key) && (!cached || now() >= cached.retryAt) && qualificationRequests.size < 8) {
      const currentInventory = inventory;
      const operation = rpc('harness_duplicate_qualification', { directory, ...selection, inventory: currentInventory })
        .then(value => {
          if (inventory !== currentInventory || controller.signal.aborted) return;
          const qualified = value?.qualified === true && value.configurationHash === currentInventory.configurationHash
            && value.contentHash === currentInventory.contentHash && value.providerID === selection.providerID
            && value.modelID === selection.modelID && value.variant === selection.variant;
          qualifications.set(key, { qualified, profileId: qualified ? value.profileId : null, retryAt: now() + 30_000 });
        }).catch(() => { qualifications.set(key, { qualified: false, retryAt: now() + 30_000 }); })
        .finally(() => qualificationRequests.delete(key));
      qualificationRequests.set(key, operation);
      while (qualifications.size > 32) qualifications.delete(qualifications.keys().next().value);
    }
    return null;
  };
  const observeContext = (sessionID, payload) => {
    if (pending.size >= 32 || controller.signal.aborted) return;
    const operation = rpc('harness_context_observation', { sessionID, directory, ...payload })
      .catch(() => {}).finally(() => pending.delete(operation));
    pending.add(operation);
  };
  const dispose = () => {
    controller.abort(); seen.clear(); checks.clear(); activeMessages.clear();
    suppressSummary.clear(); summarySystem.clear(); qualifications.clear(); inventory = null; nativeConfig = null;
  };
  const resolveCheckMessage = async (input) => {
    if (typeof client?.session?.messages !== 'function') return null;
    const response = await client.session.messages({ path: { id: input.sessionID }, query: { directory, limit: 10 },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
    if (response.error || !Array.isArray(response.data)) return null;
    const matches = response.data.filter((message) => message.info?.role === 'assistant'
      && (!message.info.sessionID || message.info.sessionID === input.sessionID)
      && message.parts?.some((part) => part.type === 'tool' && part.tool === 'bash' && part.callID === input.callID
        && (!part.sessionID || part.sessionID === input.sessionID) && (!part.messageID || part.messageID === message.info.id)));
    return matches.length === 1 ? identity(matches[0].info.id) : null;
  };
  const observe = (input) => {
    const sessionID = identity(input?.sessionID);
    const messageID = identity(input?.message?.id);
    const agent = identity(typeof input?.agent === 'string' ? input.agent : input?.agent?.name);
    if (!sessionID || !messageID || !agent || !directory || controller.signal.aborted) return;
    const key = `${sessionID}:${messageID}:${agent}`;
    if (seen.has(key) || pending.size >= 32) return;
    seen.add(key);
    while (seen.size > 256) seen.delete(seen.values().next().value);
    const registry = globalThis[registryKey];
    const observedPlugins = registry instanceof Map ? [...registry.values()]
      .filter((entry) => entry.directory === directory).map(({ name, contentHash, factoryCalls, ownership }) => ({ name, contentHash, factoryCalls, ownership })) : [];
    const operation = rpc('harness_run', { directory, sessionID, messageID, agent,
      providerID: identity(input.model?.providerID), modelID: identity(input.model?.id),
      variant: identity(input.message?.variant ?? input.message?.model?.variant), observedPlugins,
    }).catch(() => {
      if (!controller.signal.aborted) console.error(JSON.stringify({ plugin: 'devryan-harness-context',
        event: 'harness_run_observation_unavailable', identityHash: crypto.createHash('sha256').update(key).digest('hex') }));
    }).finally(() => pending.delete(operation));
    pending.add(operation);
  };
  return {
    config: async (config) => {
      nativeConfig = config; inventory = null; qualifications.clear(); refreshInventory();
    },
    dispose,
    'chat.params': (input) => { observe(input); },
    'tool.execute.before': async (input, output) => {
      if (input?.tool !== 'bash' || controller.signal.aborted) return;
      if (await loadCapabilities() === null) throw checkObserverUnavailable(capabilityFailure);
      if (policies?.compactResults !== true) return;
      const params = { phase: 'before', directory, sessionId: input.sessionID,
        callId: input.callID, tool: input.tool, command: output?.args?.command,
        workdir: output?.args?.workdir ?? output?.args?.cwd };
      // If the enabled host cannot reserve before execution, do not run a new
      // command while an older durable pass could remain visible.
      let probe;
      try {
        probe = await rpc('required_check', params);
        if (typeof probe?.tracked !== 'boolean' && probe?.needsIdentity !== true) throw checkObserverUnavailable();
      } catch (error) { throw checkObserverUnavailable(error); }
      if (probe?.needsIdentity !== true) return;
      checks.set(`${input.sessionID}:${input.callID}`, params);
      while (checks.size > 256) checks.delete(checks.keys().next().value);
      try {
        // Native tool hooks provide sessionID/callID, not messageID. Resolve the
        // owning canonical assistant after reserving an unverified invocation.
        const messageId = await resolveCheckMessage(input);
        if (messageId) await rpc('required_check', { ...params, messageId });
      } catch { /* Missing observation cannot establish a passed check. */ }
    },
    'tool.execute.after': async (input, output) => {
      if (input?.tool === 'devryan_task' && input.args?.action === 'checkpoint') {
        await loadCapabilities();
        if (policies?.contextProjection !== true || typeof output?.output !== 'string' || output.output.length > 256 * 1024) return;
        try {
          const result = JSON.parse(output.output);
          if (result?.available === true && result.checkpoint?.sessionID === input.sessionID) {
            output.output = JSON.stringify({ ...result, headroom: activeMessages.get(input.sessionID)?.headroom ?? measureHeadroom({}, []) });
          }
        } catch { /* Unknown tool output cannot establish context usage. */ }
        return;
      }
      const key = `${input?.sessionID}:${input?.callID}`, params = checks.get(key);
      if (!params) return;
      checks.delete(key);
      try {
        // The canonical tool part may only become visible after execution.
        // Resolve again so an ambiguous or changed identity cannot attest a pass.
        const messageId = await resolveCheckMessage(input);
        if (!messageId) return;
        const bound = await rpc('required_check', { ...params, messageId });
        if (bound?.tracked !== true) return;
        await rpc('required_check', { phase: 'after', directory, sessionId: input.sessionID,
          messageId, callId: input.callID,
          exitCode: Number.isSafeInteger(output?.metadata?.exit) ? output.metadata.exit : null });
      } catch { /* A failed receipt remains unverified; the command is never replayed. */ }
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      void loadCapabilities({ optional: true });
      if (!Array.isArray(output?.messages) || controller.signal.aborted) return;
      const sessionID = sessionOf(output.messages);
      if (!sessionID || suppressionOverflow) return;
      if (suppressSummary.delete(sessionID)) {
        if (summarySystem.size >= 128 && !summarySystem.has(sessionID)) suppressionOverflow = true;
        else summarySystem.add(sessionID);
        observeContext(sessionID, { phase: 'summary-suppressed', appliedReductions: 0 });
        return;
      }
      if (policies && policies.contextProjection !== true && policies.duplicateOutputs !== true) return;
      const beforeBytes = visibleBytes(output.messages);
      const start = performance.now();
      const qualified = policies?.duplicateOutputs === true ? qualificationFor(selectionOf(output.messages)) : null;
      const projection = qualified?.qualified === true ? projectObservations(output.messages)
        : { plannedReductions: 0, appliedReductions: 0, savedBytes: 0 };
      if (policies?.duplicateOutputs === true) observeContext(sessionID, { phase: 'hook-applied',
        reason: qualified?.qualified === true ? 'qualified' : 'unqualified',
        beforeBytes, projectedBytes: visibleBytes(output.messages), ...projection,
        transformDurationMs: performance.now() - start, finalRequestBytes: null });
      if (policies && policies.contextProjection !== true) return;
      // Retain only bounded usage metadata. Full active transcripts belong to
      // OpenCode, not to another per-plugin history cache.
      activeMessages.set(sessionID, { messages: output.messages.slice(-12).map((message) => ({
        info: { role: message.info.role, id: message.info.id, providerID: message.info.providerID,
          modelID: message.info.modelID, tokens: message.info.tokens ? { input: count(message.info.tokens.input),
            output: count(message.info.tokens.output), reasoning: count(message.info.tokens.reasoning),
            cache: { read: count(message.info.tokens.cache?.read), write: count(message.info.tokens.cache?.write) } } : undefined },
        parts: message.parts.filter((part) => part.type === 'compaction').map(() => ({ type: 'compaction' })),
      })), visibleContextBytes: visibleBytes(output.messages), beforeBytes });
      while (activeMessages.size > 128) activeMessages.delete(activeMessages.keys().next().value);
    },
    'experimental.chat.system.transform': async (input, output) => {
      void loadCapabilities({ optional: true });
      const sessionID = identity(input?.sessionID);
      if (suppressionOverflow || summarySystem.delete(sessionID)) return;
      if ((policies && policies.contextProjection !== true) || !sessionID || !Array.isArray(output?.system)) return;
      const usage = activeMessages.get(sessionID) ?? {};
      const headroom = measureHeadroom(input.model, usage.messages, input.variant);
      headroom.visibleContextBytes = usage.visibleContextBytes ?? null;
      // Dynamic checkpoints and headroom belong at explicit retrieval and
      // compaction boundaries. Never invalidate the static provider prefix on
      // every request or write another checkpoint just to construct a prompt.
      activeMessages.set(sessionID, { ...usage, headroom,
        sourceHash: crypto.createHash('sha256').update(JSON.stringify(output.system)).digest('hex') });
      while (activeMessages.size > 128) activeMessages.delete(activeMessages.keys().next().value);
    },
    'experimental.session.compacting': async (input, output) => {
      // Set before any await: compaction's next transform serializes a selected
      // summary head, not an ordinary provider conversation. Never expire it.
      const sessionID = identity(input?.sessionID);
      if (sessionID) {
        if (suppressSummary.size >= 128 && !suppressSummary.has(sessionID)) suppressionOverflow = true;
        else suppressSummary.add(sessionID);
      } else suppressionOverflow = true;
      // Re-anchor every compaction summary to the canonical objective, plan,
      // todos and outstanding children (a child keeps its delegated brief).
      // It is appended only to the summary request, so ordinary requests and
      // their cached prefix are unchanged. Never block or fail compaction.
      void loadCapabilities({ optional: true });
      if (!sessionID || !Array.isArray(output?.context) || controller.signal.aborted) return;
      try {
        const result = await rpc('harness_context', { action: 'compaction_anchor', sessionID, directory }, { timeoutMs: 5_000 });
        const text = result?.available === true && typeof result.text === 'string'
          && result.text.startsWith(COMPACTION_ANCHOR_TAG) && Buffer.byteLength(result.text) <= 16 * 1024 ? result.text : null;
        if (!text) {
          observeContext(sessionID, { phase: 'checkpoint-unavailable', reason: 'canonical-state-unavailable' });
          return;
        }
        const usage = policies?.contextProjection === true ? activeMessages.get(sessionID) : null;
        output.context.push(usage?.headroom
          ? `${text}\nContext headroom (prior-request estimate, not current usage): ${JSON.stringify(usage.headroom)}` : text);
        observeContext(sessionID, { phase: 'checkpoint',
          beforeBytes: usage?.beforeBytes ?? null, projectedBytes: usage?.visibleContextBytes ?? null,
          dynamicBytes: Buffer.byteLength(text), sourceHash: usage?.sourceHash ?? null });
      } catch { observeContext(sessionID, { phase: 'checkpoint-unavailable', reason: 'bridge-unavailable' }); }
    },
    event: ({ event } = {}) => {
      if (event?.type === 'session.deleted') {
        const sessionID = identity(event.properties?.info?.id ?? event.properties?.sessionID);
        suppressSummary.delete(sessionID); summarySystem.delete(sessionID); activeMessages.delete(sessionID);
      }
      if (event?.type === 'server.instance.disposed' && event.properties?.directory === directory) {
        dispose();
      }
    },
  };
};

export const __test = () => ({ projectObservations, measureHeadroom, pluginInventory, sessionOf });
