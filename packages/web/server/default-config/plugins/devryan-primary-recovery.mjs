import crypto from 'node:crypto';
import fs from 'node:fs';

// One identity per OpenCode process, shared by directory-scoped plugin instances.
const instanceKey = Symbol.for('devryan.primary-recovery.instance.v1');
const RPC_TIMEOUT_MS = 5000;
// The host's hello performs its own bounded 5s OpenCode health verification.
// Leave room for that result to cross the bridge without racing equal timers.
const HELLO_TIMEOUT_MS = 10000;

export const DevRyanPrimaryRecoveryPlugin = async ({ client, directory, fetchImpl = fetch } = {}) => {
  globalThis[instanceKey] ??= crypto.randomUUID();
  const rawUrl = process.env.DEVRYAN_ORCHESTRATION_URL;
  const token = process.env.DEVRYAN_ORCHESTRATION_TOKEN;
  if (!rawUrl || !token) return {}; // External runtimes remain manual.
  const factories = globalThis[Symbol.for('devryan.plugin-factories.v1')] ??= new Map();
  const factoryKey = `primary:${directory}:${import.meta.url}`;
  factories.set(factoryKey, { name: 'devryan-primary-recovery', directory,
    contentHash: (() => {
      try { return crypto.createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'); }
      catch { return null; } // Missing diagnostic source must not disable the plugin.
    })(),
    factoryCalls: (factories.get(factoryKey)?.factoryCalls ?? 0) + 1, ownership: 'managed' });
  while (factories.size > 256) factories.delete(factories.keys().next().value);
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/rpc') {
    throw new Error('Invalid primary recovery bridge');
  }
  const instanceID = globalThis[instanceKey];
  const rpc = async (params) => {
    let response;
    let body;
    let phase = 'request';
    try {
      response = await fetchImpl(url, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'primary_recovery', params: { ...params, instanceID } }),
        signal: AbortSignal.timeout(params.action === 'hello' ? HELLO_TIMEOUT_MS : RPC_TIMEOUT_MS),
      });
      phase = 'response';
      body = await response.json();
    } catch (cause) {
      // Fixed action/phase context survives OpenCode's generic Plugin.trigger
      // stack without exposing the bridge URL, credentials, or response body.
      throw new Error(`Primary recovery ${params.action} ${phase} failed`, { cause });
    }
    if (!response.ok || !body.ok) throw Object.assign(new Error(body?.error?.code ?? 'Primary recovery host unavailable'), { code: body?.error?.code });
    return body.result;
  };
  let handshake;
  const unsupportedTransport = [process.env.OPENCODE_EXPERIMENTAL_WEBSOCKETS, process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM]
    .some((value) => value && !['0', 'false'].includes(value.toLowerCase()));
  const hello = () => (handshake ??= rpc({ action: 'hello', policyVersion: 1,
    transport: unsupportedTransport ? 'websocket-unverified' : 'fetch',
  }).catch((error) => { handshake = null; throw error; }));
  // Managed continuation producers must wait for this real plugin's host
  // registration. An instance UUID by itself is not evidence of ownership.
  globalThis[Symbol.for('devryan.primary-recovery.ready.v1')] = hello;
  const scope = async (sessionID) => { await hello(); return rpc({ action: 'scope', sessionID }); };
  const inspect = async (input) => {
    const response = await client.session.messages({ path: { id: input.sessionID },
      query: { directory, limit: 10 }, signal: AbortSignal.timeout(5000) });
    if (response.error || !Array.isArray(response.data)) throw new Error('Invoking model step unavailable');
    const assistants = response.data.filter((m) => m.info?.role === 'assistant');
    const invoking = input.callID
      ? assistants.find((m) => m.parts?.some((p) => p.type === 'tool' && (p.callID === input.callID || p.id === input.callID)))
      : assistants.filter((m) => m.info.parentID === input.message.id).at(-1);
    if (!invoking?.info.id || !invoking.info.parentID) throw new Error('Invoking model step unresolved');
    return { assistantMessageID: invoking.info.id, userMessageID: invoking.info.parentID };
  };
  const execute = async (action, input, extra = {}) => {
    const policy = await scope(input.sessionID);
    if (!policy.tracked) return;
    const agent = typeof input.agent === 'string' ? input.agent : input.agent?.name;
    if (action === 'step' && agent && agent !== policy.agent) return;
    try {
      const identity = await inspect(input);
      let nativeToolVerified = false;
      if (action === 'tool_before' && policy.readOnly && ['read', 'glob', 'grep'].includes(input.tool)) {
        const catalog = await client.tool.ids({ query: { directory }, signal: AbortSignal.timeout(5000) });
        nativeToolVerified = !catalog.error && Array.isArray(catalog.data)
          && catalog.data.filter((id) => id === input.tool).length === 1;
      }
      return await rpc({ action, sessionID: input.sessionID, ...identity, ...extra, callID: input.callID, tool: input.tool,
        nativeToolVerified,
        execution: action === 'step' ? { providerID: input.model?.providerID, modelID: input.model?.id,
          agent, variant: input.message.variant ?? input.message.model?.variant ?? null } : undefined,
        ...(action === 'step' ? { timeouts: {
          headers: input.provider?.options?.headersTimeout ?? null,
          chunk: input.provider?.options?.chunkTimeout ?? null,
          total: input.provider?.options?.timeout ?? null,
        }, transport: 'unverified', configurationSource: 'chat.params.provider.options' } : {}) });
    } catch (error) {
      if (policy.enforced || policy.readOnly || ['provider_recovery_fenced', 'managed_retry_cycle_blocked', 'recovery_requires_user_action'].includes(error?.code)) throw error;
      // Observe mode cannot stop a user's original turn on diagnostic failure.
    }
  };
  const rejectionObservers = globalThis[Symbol.for('devryan.preexecution-rejection.v1')] ??= new Map();
  const observeRejection = (input, detail) => execute('rejected', input, detail);
  rejectionObservers.set(directory, observeRejection);
  while (rejectionObservers.size > 256) rejectionObservers.delete(rejectionObservers.keys().next().value);
  return {
    event: ({ event } = {}) => {
      if (event?.type === 'server.instance.disposed' && event.properties?.directory === directory
        && rejectionObservers.get(directory) === observeRejection) rejectionObservers.delete(directory);
    },
    'chat.message': async (input, output) => {
      await hello();
      await rpc({ action: 'message', sessionID: input.sessionID,
        userMessageID: output.message.id });
    },
    'chat.params': (input) => execute('step', input),
    'tool.execute.before': (input) => execute('tool_before', input),
    'tool.execute.after': (input) => execute('tool_after', input),
  };
};
