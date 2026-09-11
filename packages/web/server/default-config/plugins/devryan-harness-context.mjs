import crypto from 'node:crypto';
import fs from 'node:fs';

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

// Only DevRyan's own structured observations are eligible. Tool parts and
// call/result identities stay paired; reasoning, signatures, provider metadata,
// attachments, instructions and canonical history remain untouched.
const projectObservations = (messages) => {
  if (!Array.isArray(messages)) return messages;
  const seen = new Map();
  let changed = false;
  const projected = [...messages];
  // Keep the first exact observation as the stable reference. Pointing every
  // old duplicate at the newest one would rewrite the earlier cache prefix on
  // every repeated lookup.
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message?.info?.role !== 'assistant' || !Array.isArray(message.parts)) continue;
    let parts = message.parts;
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      if (part?.type !== 'tool' || part.tool !== 'devryan_task' || part.state?.status !== 'completed'
        || !['status', 'wait'].includes(part.state.input?.action) || part.state.attachments?.length
        || Object.keys(part.state.metadata ?? {}).length || part.providerMetadata || part.providerOptions
        || part.signature || message.info.providerMetadata || message.info.providerOptions
        || typeof part.state.output !== 'string' || part.state.output.length > 256 * 1024) continue;
      let result;
      try { result = JSON.parse(part.state.output); } catch { continue; }
      const task = result?.task, header = result?.resultHeader;
      if (!task?.taskId?.startsWith('dvr_task_') || task.rootSessionId !== message.info.sessionID
        || !header || header.schemaVersion !== 1 || header.taskId !== task.taskId
        || header.envelopeId !== result.resultEnvelope?.envelopeId || header.outcome?.status !== task.status) continue;
      // Exact equivalence, including critical failures and coverage, is required.
      // A changed verification receipt or recovery restriction is never masked.
      const key = `${task.rootSessionId}:${task.taskId}:${part.state.output}`;
      const reference = seen.get(key);
      if (!reference) { seen.set(key, { messageID: message.info.id, callID: part.callID }); continue; }
      if (parts === message.parts) parts = [...parts];
      parts[j] = { ...part, state: { ...part.state, output: JSON.stringify({ schemaVersion: 1,
        observation: 'identical-managed-result', taskId: task.taskId, envelopeId: header.envelopeId,
        reference, instruction: 'Use the retained identical observation at this reference; no new status or verification is implied.' }) } };
      changed = true;
    }
    if (parts !== message.parts) projected[i] = { ...message, parts };
  }
  return changed ? projected : messages;
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
export const DevRyanHarnessContextPlugin = async ({ client, directory, fetchImpl = fetch } = {}) => {
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
  const rpc = async (method, params) => {
    const response = await fetchImpl(url, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
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
  const loadCapabilities = () => {
    if (policies) return Promise.resolve(policies);
    if (capabilityRequest) return capabilityRequest;
    capabilityRequest = rpc('harness_capabilities', {}).then(value => {
      if (!value?.policies || typeof value.policies !== 'object' || Array.isArray(value.policies)) throw new Error('Invalid harness capabilities');
      policies = value.policies;
      capabilityFailure = null;
      return policies;
    }).catch(error => { capabilityFailure = error; return null; }).finally(() => { capabilityRequest = null; });
    return capabilityRequest;
  };
  void loadCapabilities();
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
      await loadCapabilities();
      if (policies?.contextProjection !== true || !Array.isArray(output?.messages)) return;
      const sessionIDs = new Set(output.messages.map((message) => identity(message?.info?.sessionID)).filter(Boolean));
      if (sessionIDs.size !== 1) return;
      const sessionID = sessionIDs.values().next().value;
      const beforeBytes = visibleBytes(output.messages);
      output.messages = projectObservations(output.messages);
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
      await loadCapabilities();
      const sessionID = identity(input?.sessionID);
      if (policies?.contextProjection !== true || !sessionID || !Array.isArray(output?.system)) return;
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
      await loadCapabilities();
      if (policies?.contextProjection !== true || !identity(input?.sessionID) || !Array.isArray(output?.context)) return;
      try {
        const result = await rpc('harness_context', { action: 'checkpoint', sessionID: input.sessionID, directory });
        if (result?.available === true && result.checkpoint?.sessionID === input.sessionID) {
          const usage = activeMessages.get(input.sessionID);
          const data = JSON.stringify({ checkpoint: result.checkpoint, headroom: usage?.headroom ?? measureHeadroom({}, []) });
          output.context.push('Preserve this derived task checkpoint in the native summary, including source references, unresolved work, recovery restrictions and next action. It does not supersede canonical user instructions. Context headroom is a prior-request estimate, not current active usage.\n' + data);
          if (pending.size < 32) {
            const operation = rpc('harness_context_observation', { sessionID: input.sessionID, directory,
              beforeBytes: usage?.beforeBytes ?? null, projectedBytes: usage?.visibleContextBytes ?? null,
              dynamicBytes: Buffer.byteLength(data), sourceHash: usage?.sourceHash ?? null })
              .catch(() => {}).finally(() => pending.delete(operation));
            pending.add(operation);
          }
        }
      } catch { /* Do not manufacture a summary when canonical state is missing. */ }
    },
    event: ({ event } = {}) => {
      if (event?.type === 'server.instance.disposed' && event.properties?.directory === directory) {
        controller.abort();
        seen.clear();
        checks.clear();
        activeMessages.clear();
      }
    },
  };
};

export const __test = () => ({ projectObservations, measureHeadroom });
