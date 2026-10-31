import { credentialMutationFingerprint } from '../runtime-host/native-credential-mutation-owner.js';
import { resolveClaudeExecutable } from '../runtime-host/claude-agent-host.js';
import { isCatalogProviderIntegration } from '../runtime-host/native-provider-integrations.js';
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
// Providers whose sign-in DevRyan pins to one OAuth method (null: none, OpenCode Console);
// others offer every formless one. The controller applies the same policy.
const providerOAuthMethod = { xai: 'device', openai: 'chatgpt-browser', opencode: null };
/** Providers connected through Providers: OpenAI, Cursor and every catalog provider integration. */
const isProviderID = id => id === 'openai' || id === 'cursor-acp' || isCatalogProviderIntegration(id);
const FIELD_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : undefined;
const formOf = method => Array.isArray(method?.form) ? method.form : [];
// Providers renders string fields (free text or a choice) and checkboxes, each optionally
// shown only when earlier answers match. Methods needing any other field are left out.
const supportedForm = method => method?.form === undefined || method.form === null || Array.isArray(method.form)
  && method.form.length >= 1 && method.form.length <= 16 && method.form.every(field => record(field) && FIELD_KEY.test(field.key ?? '')
    && ['string', 'boolean'].includes(field.type) && (field.options === undefined || Array.isArray(field.options) && field.options.length <= 64
      && field.options.every(option => record(option) && typeof option.value === 'string' && typeof option.label === 'string'))
    && (field.when === undefined || Array.isArray(field.when) && field.when.every(rule => record(rule) && FIELD_KEY.test(rule.key ?? '')
      && ['eq', 'neq'].includes(rule.op) && ['string', 'boolean', 'number'].includes(typeof rule.value))));
/** The browser's copy of a method form: allowlisted primitives only. */
const toBrowserForm = method => formOf(method).map(field => ({ key: field.key, type: field.type,
  ...Object.fromEntries(['title', 'description', 'placeholder'].flatMap(name => text(field[name], 512) === undefined ? [] : [[name, text(field[name], 512)]])),
  ...(field.required === true ? { required: true } : {}), ...(field.hidden === true ? { hidden: true } : {}),
  ...(typeof field.default === (field.type === 'boolean' ? 'boolean' : 'string') ? { default: field.default } : {}),
  ...(Array.isArray(field.options) ? { options: field.options.map(option => ({ value: option.value.slice(0, 512), label: option.label.slice(0, 256),
    ...(text(option.description, 512) === undefined ? {} : { description: text(option.description, 512) }) })) } : {}),
  ...(Array.isArray(field.when) ? { when: field.when.map(rule => ({ key: rule.key, op: rule.op, value: rule.value })) } : {}) }));
const fieldActive = (field, answer) => (field.when ?? []).every(rule => (rule.op === 'eq') === (answer[rule.key] === rule.value));
/**
 * Checks a browser answer against the method's form as OpenCode does: known fields only,
 * required active fields present, none for inactive fields, choices from their options.
 * Returns the answer to forward, or undefined when the method has no form.
 */
const formAnswer = (method, answer) => {
  const fields = formOf(method);
  if (!fields.length) {
    if (answer !== undefined && (!record(answer) || Object.keys(answer).length)) throw fail('opencode_invalid_input', 400);
    return undefined;
  }
  if (!record(answer) || Object.keys(answer).length > 16) throw fail('opencode_invalid_input', 400);
  const known = new Map(fields.map(field => [field.key, field]));
  for (const [key, value] of Object.entries(answer)) {
    const field = known.get(key);
    if (!field || !fieldActive(field, answer)) throw fail('opencode_invalid_input', 400);
    if (field.type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string' || !value.trim() || value.length > 2048
      || Array.isArray(field.options) && !field.options.some(option => option.value === value)) throw fail('opencode_invalid_input', 400);
  }
  for (const field of fields) if (field.required === true && fieldActive(field, answer) && answer[field.key] === undefined) throw fail('opencode_invalid_input', 400);
  return { ...answer };
};
/**
 * The ways a provider connects from Providers, in its own order: API keys and OAuth
 * methods whose forms Providers can render. The browser names an OAuth method by its
 * index among the OAuth entries of this list.
 */
const connectMethods = info => info.methods.filter(method => record(method) && supportedForm(method) && (method.type === 'key'
  || method.type === 'oauth' && identifier(method.id) && info.id !== 'cursor-acp'
    && (providerOAuthMethod[info.id] === undefined || method.id === providerOAuthMethod[info.id])));
const oauthMethodAt = (info, index) => Number.isSafeInteger(index) && index >= 0
  ? connectMethods(info).filter(method => method.type === 'oauth')[index] : undefined;
const methodIndex = body => Number.isSafeInteger(body.method) && body.method >= 0 && body.method < 64;
const CLAUDE_AGENT = 'claude-agent', CLAUDE_LOGIN = 'claude-login';
const CONNECTION_STATUSES = new Set(['needs_auth', 'error']);
/** Browser projection of OpenCode's claude-agent integration: login state only, no credential fields. */
export const toClaudeAgentStatus = info => {
  const connection = info.connections.find(item => record(item) && item.type === 'credential' && item.method === 'external' && identifier(item.id));
  const problem = record(connection?.status) && CONNECTION_STATUSES.has(connection.status.status) ? connection.status : undefined;
  return {
    providerID: CLAUDE_AGENT,
    available: info.methods.some(method => method.type === 'external' && method.id === CLAUDE_LOGIN),
    connected: Boolean(connection),
    ...(problem ? { problem: { status: problem.status,
      message: typeof problem.message === 'string' ? problem.message.slice(0, 1024) : '',
      ...(typeof problem.url === 'string' && /^https:\/\//.test(problem.url) ? { url: problem.url.slice(0, 2048) } : {}) } } : {}),
  };
};
const oauthMethods = info => info.methods.filter(method => method.type === 'oauth');
const segment = value => { if (!identifier(value)) throw fail('native_integration_invalid_response', 502); return encodeURIComponent(value); };

const ACCOUNT_METHODS = new Set(['key', 'oauth', 'external']);

/**
 * The browser account list for one provider: metadata only. Every field is
 * copied from an allowlist of primitives, never spread, so no key, token,
 * refresh grant, credential value or mutation fingerprint can reach a browser
 * even when the native rows carry them.
 * @param {string} providerID
 * @param {unknown} rows native credential metadata rows
 * @param {unknown} connections the Integration's connection list (for `needs_auth`)
 */
export const toProviderAccountList = (providerID, rows, connections) => {
  const needsAuth = new Set((Array.isArray(connections) ? connections : [])
    .filter(connection => record(connection) && connection.type === 'credential' && identifier(connection.id)
      && record(connection.status) && connection.status.status === 'needs_auth')
    .map(connection => connection.id));
  const accounts = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!record(row) || !identifier(row.id) || row.integrationID !== providerID) continue;
    const method = typeof row.valueType === 'string' && ACCOUNT_METHODS.has(row.valueType) ? row.valueType : null;
    if (!method) continue;
    accounts.push({
      id: row.id,
      label: typeof row.label === 'string' ? row.label.slice(0, 256) : '',
      method,
      active: row.active === true,
      ...(needsAuth.has(row.id) ? { needsAuth: true } : {}),
    });
  }
  return { providerID, accounts };
};

/** Original UI routes adapt to frozen native locations and redacted catalogs.
 * No browser payload supplies a configuration digest, integration binding, or
 * credential fingerprint; the owned host acquires each from current state. */
export function createNativeIntegrationFacade({ getNativeRuntimeOwner, getOpenCodeRuntime, request, now = Date.now,
  claudeInstalled = () => Boolean(resolveClaudeExecutable()) }) {
  const attempts = new Map();
  // Configuration snapshots whose claude-agent connection was already settled.
  const claudeSettled = new WeakSet();
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
    if (providerID !== CLAUDE_AGENT && !isProviderID(providerID)) throw unavailable('providerAuthentication');
    return { kind: providerID === 'openai' ? 'openai' : providerID === 'cursor-acp' ? 'cursor' : providerID === CLAUDE_AGENT ? 'claude' : 'provider', directory: selected.location.directory, integrationID: providerID,
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
    const info = validateInfo(await scopedRequest(selected, scope, `${scope.kind}.integration`, `/api/integration/${segment(providerID)}`, options), providerID);
    if (info.metadata?.source === 'mcp') throw unavailable('providerAuthentication');
    return info;
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
  // Web-search tools are integrations with keys too; Providers connects only model providers.
  const searchProviderIDs = async (selected, options) => new Set(unwrapList(await request({ ...options, label: 'browser.websearch.providers',
    path: '/api/websearch/provider', directory: selected.location.directory }).catch(() => [])).map(item => item?.id));
  const modelProviderInfo = async (selected, providerID, options) => {
    if (isCatalogProviderIntegration(providerID) && (await searchProviderIDs(selected, options)).has(providerID)) throw unavailable('providerAuthentication');
    return providerInfo(selected, providerID, options);
  };
  /** Activates the external Claude Code login; true when this call created the connection. */
  const connectClaude = async (selected, options) => {
    const info = await providerInfo(selected, CLAUDE_AGENT, options);
    if (!info.methods.some(method => method.type === 'external' && method.id === CLAUDE_LOGIN)) throw fail('native_provider_method_unsupported');
    if (info.connections.some(connection => connection.type === 'credential' && connection.method === 'external')) return false;
    const scope = { ...providerScope(selected, CLAUDE_AGENT), methodID: CLAUDE_LOGIN };
    await scopedRequest(selected, scope, 'claude.connect', `/api/integration/${CLAUDE_AGENT}/connect/external`, options, 'POST', { methodID: CLAUDE_LOGIN });
    return true;
  };
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
  const start = async (selected, scope, methodID, key, options, answer) => {
    const reservation = reserve(selected, key);
    let dispatched = false;
    let value;
    try {
      value = await scopedRequest(selected, { ...scope, methodID }, `${scope.kind}.oauth.start`,
        `/api/integration/${segment(scope.integrationID)}/connect/oauth`, options, 'POST', { methodID, ...(answer ? { answer } : {}) }, () => { dispatched = true; });
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
    if (!value?.attemptID) throw fail('native_integration_attempt_unavailable', 404);
    check(value.selected);
    if (value.selected.owner !== selected.owner || value.selected.snapshot !== selected.snapshot) throw fail('native_integration_grant_expired');
    return value;
  };
  const complete = async (selected, key, options, input) => {
    const value = pending(selected, key);
    if (value.expiresAt <= now()) throw fail('native_integration_attempt_expired', 410);
    bodyFields(input, ['code']);
    if (input.code !== undefined && (typeof input.code !== 'string' || !input.code || input.code.length > 8192)) throw fail('opencode_invalid_input', 400);
    const path = `/api/integration/${segment(value.scope.integrationID)}/connect/oauth/${segment(value.attemptID)}/complete`;
    await scopedRequest(selected, { ...value.scope, methodID: value.methodID, attemptID: value.attemptID }, `${value.scope.kind}.oauth.complete`, path, { ...options, timeoutMs: 180_000 }, 'POST', input);
    attempts.delete(key); return true;
  };
  const cancel = async (selected, key, options) => {
    const value = pending(selected, key);
    await scopedRequest(selected, { ...value.scope, methodID: value.methodID, attemptID: value.attemptID }, `${value.scope.kind}.oauth.cancel`,
      `/api/integration/${segment(value.scope.integrationID)}/connect/oauth/${segment(value.attemptID)}`, options, 'DELETE');
    if (attempts.get(key) === value) attempts.delete(key);
  };
  const credential = async (selected, id, options) => {
    if (!identifier(id) || typeof selected.owner.credentialMetadata !== 'function') throw unavailable('providerAuthentication');
    const integrations = unwrapList(await request({ ...options, label: 'browser.integration.connections', path: '/api/integration', directory: selected.location.directory }));
    if (integrations.length > 256) throw fail('native_integration_invalid_response', 502);
    const matches = integrations.filter(info => Array.isArray(info?.connections) && info.connections.some(connection => connection.type === 'credential' && connection.id === id));
    if (matches.length !== 1) throw fail('native_credential_metadata_unavailable', 404);
    const info = validateInfo(matches[0]);
    const scope = isProviderID(info.id) && info.metadata?.source !== 'mcp' ? providerScope(selected, info.id) : { ...mcpScope(selected, info.name), integrationID: info.id };
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
    if (options.expectedFingerprint !== undefined && options.expectedFingerprint !== metadata.expectedFingerprint) throw fail('native_credential_changed', 409);
    let scope;
    if (isProviderID(metadata.integrationID) && metadata.server === undefined) {
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
      // One read of OpenCode's integrations; web-search tools and MCP servers are not model providers.
      const [integrations, searchIDs] = await Promise.all([
        request({ ...options, label: 'browser.integration.list', path: '/api/integration', directory: selected.location.directory }),
        searchProviderIDs(selected, options),
      ]);
      check(selected);
      const list = unwrapList(integrations);
      if (list.length > 1024) throw fail('native_integration_invalid_response', 502);
      const result = {};
      for (const value of list) {
        if (!record(value) || !isProviderID(value.id) || searchIDs.has(value.id) || value.metadata?.source === 'mcp' || !Array.isArray(value.methods)) continue;
        const methods = connectMethods(value);
        // OpenCode's display name rides on each method, so the add-provider list shows names, not IDs.
        const providerName = typeof value.name === 'string' && value.name.trim() && value.name !== value.id ? { providerName: value.name.slice(0, 128) } : {};
        if (methods.length) result[value.id] = methods.map(method => ({ type: method.type === 'key' ? 'api' : 'oauth',
          label: typeof method.label === 'string' ? method.label.slice(0, 256) : '', ...providerName,
          ...(formOf(method).length ? { fields: toBrowserForm(method) } : {}) }));
      }
      return result;
    }),
    providerAccounts: (providerID, options) => run(options.directory, 'providerAuthentication', async selected => {
      if (typeof selected.owner.credentialMetadata !== 'function') throw unavailable('providerAccounts');
      const info = await providerInfo(selected, providerID, options);
      const scope = providerScope(selected, providerID);
      const rows = await selected.owner.credentialMetadata({ ...scope, operation: `${scope.kind}.integration`, method: 'GET',
        path: `/api/integration/${segment(providerID)}` });
      check(selected);
      if (!Array.isArray(rows)) throw fail('native_credential_metadata_invalid', 502);
      return toProviderAccountList(providerID, rows, info.connections);
    }),
    providerStart: (providerID, body, options) => run(options.directory, 'providerAuthentication', async selected => {
      bodyFields(body, ['method', 'answer']);
      if (!methodIndex(body)) throw fail('opencode_invalid_input', 400);
      const info = await modelProviderInfo(selected, providerID, options);
      const method = oauthMethodAt(info, body.method);
      if (!method) throw fail('opencode_invalid_input', 400);
      const answer = formAnswer(method, body.answer);
      const scope = providerScope(selected, providerID), key = keyFor(options.directory, scope.kind, providerID, body.method);
      pruneReplaced(selected);
      if (attempts.get(key)?.attemptID) await cancel(selected, key, options);
      return start(selected, scope, method.id, key, options, answer);
    }),
    providerComplete: (providerID, body, options) => run(options.directory, 'providerAuthentication', async selected => {
      bodyFields(body, ['method', 'code']);
      if (!isProviderID(providerID) || !methodIndex(body) || !oauthMethodAt(await providerInfo(selected, providerID, options), body.method)) throw fail('opencode_invalid_input', 400);
      const scope = providerScope(selected, providerID), key = keyFor(options.directory, scope.kind, providerID, body.method);
      const value = pending(selected, key);
      if (value.expiresAt <= now()) { await cancel(selected, key, options); return { status: 'expired' }; }
      if (body.code !== undefined) {
        await complete(selected, key, options, { code: body.code }); return { status: 'complete' };
      }
      const status = unwrapData(await scopedRequest(selected, { ...value.scope, methodID: value.methodID, attemptID: value.attemptID },
        `${value.scope.kind}.oauth.status`, `/api/integration/${segment(providerID)}/connect/oauth/${segment(value.attemptID)}`, options));
      if (!record(status) || !['pending', 'complete', 'failed', 'expired'].includes(status.status)) throw fail('native_integration_invalid_response', 502);
      if (status.status !== 'pending') attempts.delete(key);
      return { status: status.status };
    }),
    providerCancel: (providerID, body, options) => run(options.directory, 'providerAuthentication', async selected => {
      bodyFields(body, ['method']);
      if (!isProviderID(providerID) || !methodIndex(body) || !oauthMethodAt(await providerInfo(selected, providerID, options), body.method)) throw fail('opencode_invalid_input', 400);
      const scope = providerScope(selected, providerID);
      await cancel(selected, keyFor(options.directory, scope.kind, providerID, body.method), options); return true;
    }),
    claudeStatus: options => run(options.directory, 'providerAuthentication', async selected => toClaudeAgentStatus(await providerInfo(selected, CLAUDE_AGENT, options))),
    claudeConnect: options => run(options.directory, 'providerAuthentication', async selected => {
      await connectClaude(selected, options);
      await selected.owner.recordClaudeAgentConnectionChoice?.('connected');
      return toClaudeAgentStatus(await providerInfo(selected, CLAUDE_AGENT, options));
    }),
    /**
     * Connects claude-agent once per configuration when Claude Code is installed and
     * nobody chose Disconnect, so Claude models are listed without a trip to Providers.
     * Claude Code's own login still decides whether a turn runs.
     */
    claudeAutoConnect: options => run(options.directory, 'providerAuthentication', async selected => {
      if (claudeSettled.has(selected.snapshot)) return false;
      if (selected.owner.claudeAgentConnectionChoice?.() === 'disconnected' || !claudeInstalled()) { claudeSettled.add(selected.snapshot); return false; }
      const connected = await connectClaude(selected, options);
      claudeSettled.add(selected.snapshot);
      return connected;
    }),
    claudeDisconnect: options => run(options.directory, 'providerAuthentication', async selected => {
      await selected.owner.recordClaudeAgentConnectionChoice?.('disconnected');
      const info = await providerInfo(selected, CLAUDE_AGENT, options), scope = providerScope(selected, CLAUDE_AGENT);
      for (const connection of info.connections.filter(item => item.type === 'credential' && identifier(item.id))) {
        await scopedRequest(selected, { ...scope, credentialID: connection.id, requestedFingerprint: credentialMutationFingerprint({ id: connection.id }) },
          'claude.credential.remove', `/api/credential/${segment(connection.id)}`, options, 'DELETE');
      }
      return toClaudeAgentStatus(await providerInfo(selected, CLAUDE_AGENT, options));
    }),
    saveKey: (providerID, body, options) => run(options.directory, 'providerAuthentication', async selected => {
      bodyFields(body, ['type', 'key', 'answer']); if (!isProviderID(providerID) || body.type !== 'api' || typeof body.key !== 'string' || !body.key.trim() || body.key.length > 16384) throw fail('opencode_invalid_input', 400);
      const keyMethod = connectMethods(await modelProviderInfo(selected, providerID, options)).find(method => method.type === 'key');
      if (!keyMethod) throw fail('native_provider_method_unsupported');
      // A key method's form answer is stored as the key's metadata, as OpenCode's own key connect does.
      const metadata = formAnswer(keyMethod, body.answer);
      const input = { integrationID: providerID, value: { type: 'key', key: body.key.trim(), ...(metadata ? { metadata } : {}) } };
      const scope = providerScope(selected, providerID), spec = { ...scope, operation: `${scope.kind}.credential.create`, method: 'POST', path: '/api/credential',
        body: input, valueType: 'key', requestedFingerprint: credentialMutationFingerprint(input) };
      await selected.owner.credentialOperation(spec, { operation: 'create', input }); check(selected); return { success: true, configured: true };
    }),
    providerDisconnect: (providerID, scope, options) => run(options.directory, 'providerAuthentication', async selected => {
      if (!isProviderID(providerID) || !['auth', 'all'].includes(scope)) throw unavailable('providerConfigurationRemoval');
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
