import { credentialMutationFingerprint } from '../runtime-host/native-credential-mutation-owner.js';
import { reviewedMcpConfiguration } from '../runtime-host/reviewed-mcp-configuration.js';
import { unwrapData, unwrapList } from '../opencode-client/envelope.js';
import { isSameOpenCodeRuntime, readOpenCodeRuntime, withOpenCodeRuntime } from '../opencode-client/runtime.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, statusCode = 403) => Object.assign(new Error(code), { code, statusCode });
const unavailable = capability => Object.assign(fail('capability_unavailable', 501), { capability });
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const bodyFields = (body, fields) => {
  if (!record(body) || Object.keys(body).some(field => !fields.includes(field))) throw fail('opencode_invalid_input', 400);
  return body;
};
const oauthMethods = info => info.methods.filter(method => method.type === 'oauth');
const segment = value => { if (!identifier(value)) throw fail('native_integration_invalid_response', 502); return encodeURIComponent(value); };

/** Original UI routes adapt to frozen native locations and redacted catalogs.
 * No browser payload supplies a configuration digest, integration binding, or
 * credential fingerprint; the owned host acquires each from current state. */
export function createNativeIntegrationFacade({ getNativeRuntimeOwner, getOpenCodeRuntime, request, now = Date.now }) {
  const attempts = new Map();
  const current = (directory, capability = 'providerAuthentication') => {
    const owner = getNativeRuntimeOwner?.();
    const snapshot = owner?.getConfigurationSnapshot?.();
    const location = snapshot?.locations.find(item => item.directory === directory);
    if (!owner || !snapshot) throw unavailable(capability);
    if (!location) throw fail('native_configuration_location_unreviewed');
    if (owner.isReady?.() !== true) throw fail('native_runtime_not_ready', 503);
    return { owner, snapshot, location, runtime: { ...readOpenCodeRuntime(getOpenCodeRuntime) } };
  };
  const check = selected => {
    if (getNativeRuntimeOwner() !== selected.owner || selected.owner.getConfigurationSnapshot() !== selected.snapshot
      || !isSameOpenCodeRuntime(selected.runtime, readOpenCodeRuntime(getOpenCodeRuntime))) throw fail('native_integration_grant_expired');
  };
  const run = (directory, capability, action) => withOpenCodeRuntime(getOpenCodeRuntime, 'browser.integration', async () => {
    const selected = current(directory, capability); const result = await action(selected); check(selected); return result;
  });
  const definitions = selected => reviewedMcpConfiguration(selected.snapshot, [selected.location.directory]).get(selected.location.directory);
  const mcpScope = (selected, server) => {
    const definition = definitions(selected).get(server);
    if (!definition || definition.config.disabled) throw fail('native_mcp_server_unreviewed');
    return { kind: 'mcp', directory: selected.location.directory, server, configurationDigest: definition.configurationDigest };
  };
  const providerScope = (selected, providerID) => {
    if (!['openai', 'cursor-acp', 'xai', 'opencode', 'opencode-go'].includes(providerID)) throw unavailable('providerAuthentication');
    return { kind: providerID === 'openai' ? 'openai' : providerID === 'cursor-acp' ? 'cursor' : 'provider', directory: selected.location.directory, integrationID: providerID,
      configurationDigest: credentialMutationFingerprint(selected.location.configuration.providers?.[providerID] ?? {}) };
  };
  const openAiScope = selected => providerScope(selected, 'openai');
  const scopedRequest = (selected, scope, operation, path, options, method = 'GET', body, beforeDispatch) => {
    check(selected);
    const specification = { ...scope, operation, method, path, ...(body === undefined ? {} : { body }) };
    return selected.owner.withIntegrationOperation(specification, () => {
      beforeDispatch?.();
      return request({ ...options, directory: scope.directory, label: `browser.${operation}`, method, path, ...(body === undefined ? {} : { body }) });
    });
  };
  const validateInfo = (value, integrationID) => {
    const info = unwrapData(value);
    if (!record(info) || !identifier(info.id) || integrationID && info.id !== integrationID
      || !Array.isArray(info.methods) || !Array.isArray(info.connections)) throw fail('native_integration_invalid_response', 502);
    return info;
  };
  const providerInfo = async (selected, providerID, options) => {
    const scope = providerScope(selected, providerID);
    return validateInfo(await scopedRequest(selected, scope, `${scope.kind}.integration`, `/api/integration/${segment(providerID)}`, options), providerID);
  };
  const openAiInfo = (selected, options) => providerInfo(selected, 'openai', options);
  const mcpInfo = async (selected, server, options) => {
    const scope = mcpScope(selected, server);
    // MCP.status is a read with the original caller scope. Its native catalog
    // identifies the exact Integration; names alone never authorize mutation.
    const status = unwrapList(await scopedRequest(selected, scope, 'mcp.status', '/api/mcp', options));
    const matches = status.filter(item => item?.name === server);
    if (matches.length !== 1 || !identifier(matches[0].integrationID)) throw fail('native_mcp_integration_unavailable', 409);
    const integrationID = matches[0].integrationID;
    const info = validateInfo(await scopedRequest(selected, { ...scope, integrationID }, 'mcp.integration',
      `/api/integration/${segment(integrationID)}`, options), integrationID);
    if (info.metadata?.source !== 'mcp' || info.name !== server) throw fail('native_mcp_integration_unavailable', 409);
    return { scope: { ...scope, integrationID }, info };
  };
  const keyFor = (directory, kind, name, methodIndex = '') => JSON.stringify([directory, kind, name, methodIndex]);
  const pruneReplaced = selected => {
    // A replacement controller has closed its old acquisition. Never replace
    // an outstanding attempt on the same acquisition with another caller.
    for (const [id, value] of attempts) {
      if (value.selected.owner !== selected.owner || value.selected.snapshot !== selected.snapshot
        || !isSameOpenCodeRuntime(value.selected.runtime, selected.runtime)) attempts.delete(id);
    }
  };
  const reserve = (selected, key) => {
    pruneReplaced(selected);
    if (attempts.has(key)) throw fail('native_integration_attempt_pending', 409);
    if (attempts.size >= 256) throw fail('native_integration_attempt_capacity', 503);
    const reservation = { selected }; attempts.set(key, reservation); return reservation;
  };
  const start = async (selected, scope, methodID, key, options) => {
    const reservation = reserve(selected, key);
    let dispatched = false;
    let value;
    try {
      value = await scopedRequest(selected, { ...scope, methodID }, `${scope.kind}.oauth.start`,
        `/api/integration/${segment(scope.integrationID)}/connect/oauth`, options, 'POST', { methodID }, () => { dispatched = true; });
    } catch (error) {
      // Original caller refusal before dispatch proves no native effect. A lost
      // start acknowledgement retains its reservation until acquisition close.
      if (!dispatched && attempts.get(key) === reservation) attempts.delete(key);
      throw error;
    }
    check(selected);
    const attempt = unwrapData(value);
    if (!record(attempt) || !identifier(attempt.attemptID) || !['auto', 'code'].includes(attempt.mode)
      || typeof attempt.url !== 'string' || !attempt.url
      || attempt.expiresAt !== undefined && (!Number.isFinite(attempt.expiresAt) || attempt.expiresAt <= now())) throw fail('native_integration_invalid_response', 502);
    if (attempts.get(key) !== reservation) throw fail('native_integration_grant_expired');
    attempts.set(key, { selected, scope, methodID, attemptID: attempt.attemptID, expiresAt: Math.min(now() + 600_000, attempt.expiresAt ?? Infinity) });
    return { method: attempt.mode, url: attempt.url, instructions: attempt.instructions, authorizationUrl: attempt.url };
  };
  const pending = (selected, key) => {
    const value = attempts.get(key);
    if (!value?.attemptID || value.expiresAt <= now()) throw fail('native_integration_attempt_unavailable', 404);
    check(value.selected);
    if (value.selected.owner !== selected.owner || value.selected.snapshot !== selected.snapshot) throw fail('native_integration_grant_expired');
    return value;
  };
  const complete = async (selected, key, options, input) => {
    const value = pending(selected, key);
    bodyFields(input, ['code']);
    if (input.code !== undefined && (typeof input.code !== 'string' || !input.code || input.code.length > 8192)) throw fail('opencode_invalid_input', 400);
    const path = `/api/integration/${segment(value.scope.integrationID)}/connect/oauth/${segment(value.attemptID)}/complete`;
    await scopedRequest(selected, { ...value.scope, methodID: value.methodID, attemptID: value.attemptID }, `${value.scope.kind}.oauth.complete`, path, { ...options, timeoutMs: 180_000 }, 'POST', input);
    attempts.delete(key); return true;
  };
  const credential = async (selected, id, options) => {
    if (!identifier(id) || typeof selected.owner.credentialMetadata !== 'function') throw unavailable('providerAuthentication');
    const integrations = unwrapList(await request({ ...options, label: 'browser.integration.connections', path: '/api/integration', directory: selected.location.directory }));
    if (integrations.length > 256) throw fail('native_integration_invalid_response', 502);
    const matches = integrations.filter(info => Array.isArray(info?.connections) && info.connections.some(connection => connection.type === 'credential' && connection.id === id));
    if (matches.length !== 1) throw fail('native_credential_metadata_unavailable', 404);
    const info = validateInfo(matches[0]);
    const scope = ['openai', 'cursor-acp', 'xai', 'opencode', 'opencode-go'].includes(info.id) ? providerScope(selected, info.id) : { ...mcpScope(selected, info.name), integrationID: info.id };
    if (scope.kind === 'mcp' && info.metadata?.source !== 'mcp') throw fail('native_credential_metadata_invalid', 502);
    const rows = await selected.owner.credentialMetadata({ ...scope, operation: `${scope.kind}.integration`, method: 'GET', path: `/api/integration/${segment(info.id)}` });
    check(selected);
    if (!Array.isArray(rows)) throw fail('native_credential_metadata_invalid', 502);
    const value = rows.find(row => row.id === id);
    if (!record(value) || value.id !== id || value.integrationID !== info.id || !['key', 'oauth'].includes(value.valueType)
      || !/^[a-f0-9]{64}$/.test(value.expectedFingerprint ?? '')
      || value.valueType === 'oauth' && !identifier(value.methodID)) throw fail('native_credential_metadata_invalid', 502);
    return { ...value, ...(scope.kind === 'mcp' ? { server: info.name } : {}) };
  };
  const mutateCredential = async (selected, id, operation, options, body) => {
    const metadata = await credential(selected, id, options);
    if (operation === 'remove' && metadata.integrationID === 'openai' && metadata.valueType === 'oauth') throw fail('native_chatgpt_siwc_disconnect_required', 409);
    if (options.expectedFingerprint !== undefined && options.expectedFingerprint !== metadata.expectedFingerprint) throw fail('native_credential_changed', 409);
    let scope;
    if (['openai', 'cursor-acp', 'xai', 'opencode', 'opencode-go'].includes(metadata.integrationID)) {
      scope = providerScope(selected, metadata.integrationID);
      if (scope.kind === 'cursor' && metadata.valueType !== 'key') throw fail('native_credential_mutation_denied');
    }
    else {
      if (operation !== 'remove' || metadata.valueType !== 'oauth') throw fail('native_credential_mutation_denied');
      const server = metadata.server;
      if (typeof server !== 'string') throw fail('native_credential_metadata_invalid', 502);
      const resolved = await mcpInfo(selected, server, options);
      if (resolved.info.id !== metadata.integrationID || !resolved.info.methods.some(method => method.type === 'oauth' && method.id === metadata.methodID)) throw fail('native_credential_metadata_invalid', 502);
      scope = resolved.scope;
    }
    const mutation = operation === 'update' ? { operation, id, updates: body } : { operation, id };
    const method = operation === 'update' ? 'PATCH' : operation === 'remove' ? 'DELETE' : 'POST';
    const path = `/api/credential/${segment(id)}${operation === 'activate' ? '/activate' : ''}`;
    const spec = { ...scope, operation: scope.kind === 'mcp' ? 'mcp.oauth.remove' : `${scope.kind}.credential.${operation}`,
      method, path, credentialID: id, valueType: metadata.valueType,
      ...(metadata.methodID === undefined ? {} : { methodID: metadata.methodID }), expectedFingerprint: metadata.expectedFingerprint,
      ...(options.expectedActiveFingerprint === undefined ? {} : { expectedActiveFingerprint: options.expectedActiveFingerprint }),
      ...(options.assertCurrent ? { assertCurrent: options.assertCurrent } : {}),
      requestedFingerprint: credentialMutationFingerprint(operation === 'update' ? { id, updates: body } : { id }), ...(body === undefined ? {} : { body }) };
    check(selected); await selected.owner.credentialOperation(spec, mutation); check(selected); return true;
  };
  return {
    mcpConnect: (server, action, options) => run(options.directory, 'mcpOAuth', async selected => {
      const scope = mcpScope(selected, server);
      await scopedRequest(selected, scope, `mcp.${action}`, `/api/experimental/mcp/${encodeURIComponent(server)}/${action}`, options, 'POST'); return true;
    }),
    mcpStart: (server, options) => run(options.directory, 'mcpOAuth', async selected => {
      const { scope, info } = await mcpInfo(selected, server, options), methods = oauthMethods(info);
      if (methods.length !== 1) throw fail('native_mcp_oauth_method_ambiguous', 409);
      return start(selected, scope, methods[0].id, keyFor(options.directory, 'mcp', server), options);
    }),
    mcpComplete: (server, body, options) => run(options.directory, 'mcpOAuth', selected => complete(selected, keyFor(options.directory, 'mcp', server), options, body)),
    mcpRemove: (server, options) => run(options.directory, 'mcpOAuth', async selected => {
      pruneReplaced(selected);
      const key = keyFor(options.directory, 'mcp', server), attempt = attempts.get(key);
      if (attempt) {
        check(attempt.selected);
        if (!attempt.attemptID) throw fail('native_integration_attempt_pending', 409);
        await scopedRequest(selected, { ...attempt.scope, methodID: attempt.methodID, attemptID: attempt.attemptID }, 'mcp.oauth.cancel',
          `/api/integration/${segment(attempt.scope.integrationID)}/connect/oauth/${segment(attempt.attemptID)}`, options, 'DELETE');
        if (attempts.get(key) === attempt) attempts.delete(key);
      }
      const { info } = await mcpInfo(selected, server, options);
      const records = info.connections.filter(connection => connection.type === 'credential' && connection.method === 'oauth');
      for (const connection of records) await mutateCredential(selected, connection.id, 'remove', options);
      return true;
    }),
    providerMethods: options => run(options.directory, 'providerAuthentication', async selected => {
      const result = {};
      for (const providerID of ['openai','cursor-acp','xai','opencode','opencode-go']) {
        const info = await providerInfo(selected,providerID,options);
        result[providerID] = info.methods.filter(method => method.type === 'key'
          || method.type === 'oauth' && providerID === 'xai' && method.id === 'device')
          .map(method => ({type:method.type==='key'?'api':'oauth',label:method.label}));
      }
      return result;
    }),
    providerStart: (providerID, body, options) => run(options.directory, 'providerAuthentication', async selected => {
      bodyFields(body,['method']);if(providerID!=='xai'||!Number.isSafeInteger(body.method)||body.method<0)throw fail('opencode_invalid_input',400);
      const info=await providerInfo(selected,providerID,options),methods=info.methods.filter(method=>method.type==='oauth'&&method.id==='device');
      const method=methods[body.method];if(method?.type!=='oauth')throw fail('native_provider_method_unsupported');
      const scope=providerScope(selected,providerID);return start(selected,scope,method.id,keyFor(options.directory,scope.kind,providerID,body.method),options);
    }),
    providerComplete: (providerID, body, options) => run(options.directory,'providerAuthentication',selected=>{
      bodyFields(body,['method','code']);if(providerID!=='xai'||!Number.isSafeInteger(body.method)||body.method<0)throw fail('opencode_invalid_input',400);
      return complete(selected,keyFor(options.directory,'provider',providerID,body.method),options,body.code===undefined?{}:{code:body.code});
    }),
    saveOAuthCredential: (providerID, body, options) => run(options.directory, 'providerAuthentication', async selected => {
      if (providerID !== 'openai' || !record(body) || body.type !== 'oauth' || body.methodID !== 'chatgpt-siwc'
        || typeof body.access !== 'string' || !body.access || typeof body.refresh !== 'string' || !body.refresh
        || !Number.isSafeInteger(body.expires) || !record(body.metadata)) throw fail('opencode_invalid_input', 400);
      if (options.credentialID !== undefined && !identifier(options.credentialID)) throw fail('opencode_invalid_input', 400);
      const input = { ...(options.credentialID === undefined ? {} : { id: options.credentialID }), integrationID: 'openai', value: {
        type: 'oauth', methodID: 'chatgpt-siwc', access: body.access, refresh: body.refresh, expires: body.expires, metadata: body.metadata,
      }, activate: false };
      const scope = providerScope(selected, 'openai');
      const spec = { ...scope, operation: 'openai.credential.create', method: 'POST', path: '/api/credential',
        ...(options.expectedActiveFingerprint === undefined ? {} : { expectedActiveFingerprint: options.expectedActiveFingerprint }),
        ...(options.assertCurrent ? { assertCurrent: options.assertCurrent } : {}),
        body: input, valueType: 'oauth', methodID: 'chatgpt-siwc', requestedFingerprint: credentialMutationFingerprint(input) };
      const result = await selected.owner.credentialOperation(spec, { operation: 'create', input }); check(selected);
      if (!identifier(result?.credentialID) || options.credentialID !== undefined && result.credentialID !== options.credentialID) throw fail('native_integration_invalid_response', 502);
      return { success: true, credentialID: result.credentialID };
    }),
    saveKey: (providerID, body, options) => run(options.directory, 'providerAuthentication', async selected => {
      bodyFields(body, ['type', 'key']); if (!['openai', 'cursor-acp', 'xai', 'opencode', 'opencode-go'].includes(providerID) || body.type !== 'api' || typeof body.key !== 'string' || !body.key.trim() || body.key.length > 16384) throw fail('opencode_invalid_input', 400);
      const input = { integrationID: providerID, value: { type: 'key', key: body.key.trim() } };
      const scope = providerScope(selected, providerID), spec = { ...scope, operation: `${scope.kind}.credential.create`, method: 'POST', path: '/api/credential',
        body: input, valueType: 'key', requestedFingerprint: credentialMutationFingerprint(input) };
      await selected.owner.credentialOperation(spec, { operation: 'create', input }); check(selected); return { success: true, configured: true };
    }),
    providerDisconnect: (providerID, scope, options) => run(options.directory, 'providerAuthentication', async selected => {
      if (!['openai', 'cursor-acp', 'xai', 'opencode', 'opencode-go'].includes(providerID) || !['auth', 'all'].includes(scope)) throw unavailable('providerConfigurationRemoval');
      // The frozen native configuration cannot be rewritten through a credential
      // effect. Refuse before deleting accounts when this needs config ownership.
      if (scope === 'all' && Object.keys(selected.location.configuration.providers?.[providerID] ?? {}).length) throw unavailable('providerConfigurationRemoval');
      const info = await providerInfo(selected, providerID, options);
      const connections = info.connections.filter(connection => connection.type === 'credential');
      for (const connection of connections) await mutateCredential(selected, connection.id, 'remove', options);
      const remaining = (await providerInfo(selected, providerID, options)).connections.filter(connection => connection.type === 'credential');
      return { success: true, removed: connections.length > 0, removedSources: { auth: connections.length > 0, user: false, project: false, custom: false },
        stillProvidedBy: remaining.length ? [{ type: 'auth', path: null }] : [],
        sources: { auth: { exists: remaining.length > 0 }, user: { exists: false }, project: { exists: false }, custom: { exists: false } } };
    }),
    credentialMutation: (id, operation, body, options) => run(options.directory, 'providerAuthentication', selected => {
      if (!['update', 'activate', 'remove'].includes(operation)) throw fail('opencode_invalid_input', 400);
      if (operation === 'update') { bodyFields(body, ['label']); if (typeof body.label !== 'string' || body.label.length > 256) throw fail('opencode_invalid_input', 400); }
      else if (body !== undefined && (!record(body) || Object.keys(body).length)) throw fail('opencode_invalid_input', 400);
      return mutateCredential(selected, id, operation, options, operation === 'update' ? body : undefined);
    }),
  };
}
