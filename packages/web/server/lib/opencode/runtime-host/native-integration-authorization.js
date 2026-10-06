import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const fail = code => Object.assign(new Error(code), { code, status: 403, statusCode: 403 });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = value => JSON.stringify(value, (_key, item) => record(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const token = () => randomBytes(32).toString('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const HEADER = 'x-devryan-native-integration-grant';

/** Only the constructor-owned browser adapter may issue an HTTP grant. */
function operation(spec) {
  if (!record(spec) || !path.isAbsolute(spec.directory ?? '') || !['mcp', 'openai', 'cursor', 'provider'].includes(spec.kind)
    || !sha(spec.configurationDigest) || spec.kind === 'mcp' && (typeof spec.server !== 'string' || !spec.server
      || spec.server.length > 256 || /[\u0000-\u001f]/.test(spec.server))
    || spec.kind === 'provider' && (!['xai', 'opencode', 'opencode-go'].includes(spec.integrationID)
      || spec.methodID !== undefined && (spec.integrationID !== 'xai' || spec.methodID !== 'device'))
    || spec.kind === 'openai' && spec.integrationID !== 'openai'
    || spec.kind === 'cursor' && (spec.integrationID !== 'cursor-acp' || spec.methodID !== undefined)) throw fail('native_integration_scope_invalid');
  if (spec.expectedActiveFingerprint !== undefined && (spec.kind !== 'openai' || !sha(spec.expectedActiveFingerprint))) throw fail('native_integration_scope_invalid');
  const encoded = value => { if (!id(value)) throw fail('native_integration_scope_invalid'); return encodeURIComponent(value); };
  const integration = () => `/api/integration/${encoded(spec.integrationID)}`;
  const attempt = () => `${integration()}/connect/oauth/${encoded(spec.attemptID)}`;
  let method, route, body;
  switch (spec.operation) {
    case 'mcp.status': method = 'GET'; route = '/api/mcp'; break;
    case 'mcp.integration': case 'openai.integration': case 'cursor.integration': case 'provider.integration': method = 'GET'; route = integration(); break;
    case 'mcp.connect': case 'mcp.disconnect':
      method = 'POST'; route = `/api/experimental/mcp/${encodeURIComponent(spec.server)}/${spec.operation.slice(4)}`; break;
    case 'mcp.oauth.start': case 'openai.oauth.start': case 'provider.oauth.start':
      method = 'POST'; route = `${integration()}/connect/oauth`; encoded(spec.methodID); body = { methodID: spec.methodID }; break;
    case 'mcp.oauth.status': case 'openai.oauth.status': case 'provider.oauth.status': method = 'GET'; route = attempt(); break;
    case 'mcp.oauth.cancel': case 'openai.oauth.cancel': case 'provider.oauth.cancel': method = 'DELETE'; route = attempt(); break;
    case 'mcp.oauth.complete': case 'openai.oauth.complete': case 'provider.oauth.complete':
      method = 'POST'; route = `${attempt()}/complete`;
      if (!record(spec.body) || Object.keys(spec.body).some(key => key !== 'code')
        || spec.body.code !== undefined && (typeof spec.body.code !== 'string' || !spec.body.code || spec.body.code.length > 8192)) throw fail('native_integration_scope_invalid');
      body = spec.body; break;
    case 'mcp.oauth.remove': method = 'DELETE'; route = `/api/credential/${encoded(spec.credentialID)}`; break;
    case 'openai.credential.create': case 'cursor.credential.create': case 'provider.credential.create':
      method = 'POST'; route = '/api/credential'; body = spec.body;
      if (!record(body) || body.integrationID !== spec.integrationID || !record(body.value)
        || !['key', 'oauth'].includes(body.value.type) || spec.valueType !== body.value.type
        || body.value.type === 'oauth' && spec.methodID !== body.value.methodID
        || digest(body) !== spec.requestedFingerprint) throw fail('native_integration_scope_invalid');
      break;
    case 'openai.credential.update': case 'cursor.credential.update': case 'provider.credential.update':
      method = 'PATCH'; route = `/api/credential/${encoded(spec.credentialID)}`; body = spec.body;
      if (!record(body) || Object.keys(body).some(key => key !== 'label') || typeof body.label !== 'string'
        || digest({ id: spec.credentialID, updates: body }) !== spec.requestedFingerprint) throw fail('native_integration_scope_invalid');
      break;
    case 'openai.credential.activate': case 'openai.credential.remove': case 'cursor.credential.activate': case 'provider.credential.activate': case 'cursor.credential.remove': case 'provider.credential.remove':
      method = spec.operation.endsWith('remove') ? 'DELETE' : 'POST';
      route = `/api/credential/${encoded(spec.credentialID)}${method === 'POST' ? '/activate' : ''}`;
      if (digest({ id: spec.credentialID }) !== spec.requestedFingerprint) throw fail('native_integration_scope_invalid');
      break;
    default: throw fail('native_integration_scope_invalid');
  }
  if (spec.kind === 'provider' && spec.operation.startsWith('provider.oauth.') && (spec.integrationID !== 'xai' || spec.methodID !== 'device')) throw fail('native_integration_scope_invalid');
  if (!spec.operation.startsWith(`${spec.kind}.`)
    || spec.kind === 'openai' && spec.operation.startsWith('openai.oauth.')
      && spec.methodID !== undefined && !['chatgpt-siwc'].includes(spec.methodID)) throw fail('native_integration_scope_invalid');
  if (['openai', 'cursor', 'provider'].includes(spec.kind) && spec.operation.startsWith(`${spec.kind}.credential.`) && (!['key', 'oauth'].includes(spec.valueType)
    || spec.kind === 'cursor' && spec.valueType !== 'key'
    || spec.valueType === 'oauth' && (spec.kind === 'provider' ? spec.integrationID !== 'xai' || spec.methodID !== 'device' : !['chatgpt-siwc', ...(spec.operation === 'openai.credential.remove' ? ['chatgpt-browser', 'chatgpt-headless'] : [])].includes(spec.methodID))
    || !spec.operation.endsWith('.credential.create') && !sha(spec.expectedFingerprint))) throw fail('native_integration_scope_invalid');
  if (method !== spec.method || route !== spec.path || stable(body) !== stable(spec.body)) throw fail('native_integration_scope_invalid');
  return structuredClone(spec);
}

const bindingScope = binding => {
  if (!record(binding) || !path.isAbsolute(binding.directory ?? '') || !id(binding.controllerInstanceID)
    || !id(binding.integrationID) || !['mcp', 'openai', 'cursor', 'provider'].includes(binding.kind)
    || !sha(binding.configurationDigest) || !id(binding.acquisitionID)
    || binding.kind === 'mcp' && (!id(binding.methodID) || typeof binding.server !== 'string' || !binding.server || binding.server.length > 256)
    || binding.kind === 'cursor' && (binding.integrationID !== 'cursor-acp' || binding.methodID !== undefined || binding.server !== undefined)
    || binding.kind === 'provider' && (!['xai', 'opencode', 'opencode-go'].includes(binding.integrationID) || binding.server !== undefined
      || binding.methodID !== undefined && (binding.integrationID !== 'xai' || binding.methodID !== 'device'))
    || binding.kind === 'openai' && (binding.integrationID !== 'openai'
      || binding.methodID !== undefined && !['chatgpt-siwc', 'chatgpt-browser', 'chatgpt-headless'].includes(binding.methodID))) throw fail('native_integration_binding_invalid');
  return { kind: binding.kind, controllerInstanceID: binding.controllerInstanceID, directory: binding.directory,
    server: binding.server, configurationDigest: binding.configurationDigest, acquisitionID: binding.acquisitionID,
    integrationID: binding.integrationID, methodID: binding.methodID };
};

/** Grants retain the original caller closure; copied metadata and fingerprints
 * cannot create one. Configured connection grants can only refresh a selected
 * native OAuth credential, never create or activate another account. */
export function createNativeIntegrationAuthorization({ controllerIdentity, verifyBinding, captureWebAuthorization,
  authorizeConfiguredConnection, limit = 2048 }) {
  if ([controllerIdentity, verifyBinding, captureWebAuthorization, authorizeConfiguredConnection].some(fn => typeof fn !== 'function')) {
    throw fail('native_integration_owner_required');
  }
  const context = new AsyncLocalStorage(), requests = new Map(), grants = new Map();
  let closed = false;
  const current = instanceID => {
    if (closed || !instanceID || controllerIdentity() !== instanceID) throw fail('native_integration_grant_expired');
  };
  const check = async (scope, reauthorize) => {
    current(scope.controllerInstanceID);
    await reauthorize(); current(scope.controllerInstanceID);
    await verifyBinding(scope); current(scope.controllerInstanceID);
    await reauthorize(); current(scope.controllerInstanceID);
  };
  const resolve = async ({ authorizationID, binding }) => {
    const grant = grants.get(authorizationID);
    const scope = bindingScope(['openai', 'cursor', 'provider'].includes(binding?.kind) && binding.acquisitionID === undefined && grant
      ? { ...binding, acquisitionID: grant.scope.acquisitionID, configurationDigest: grant.scope.configurationDigest } : binding);
    if (!grant || stable(scope) !== stable(grant.scope)) throw fail('native_integration_grant_mismatch');
    const reauthorize = () => check(scope, grant.reauthorize);
    await reauthorize();
    return { ...grant, reauthorize };
  };
  return {
    withCallerOperation: async (spec, action) => {
      const selected = operation(spec), instanceID = controllerIdentity(); current(instanceID);
      if (requests.size >= limit) throw fail('native_integration_grant_capacity');
      const reauthorize = await captureWebAuthorization(selected); await reauthorize(); current(instanceID);
      const authorizationID = token();
      requests.set(authorizationID, { spec: selected, instanceID, reauthorize });
      try { return await context.run(authorizationID, action); }
      finally { requests.delete(authorizationID); }
    },
    requestHeaders: () => context.getStore() ? { [HEADER]: context.getStore() } : {},
    capture: async ({ binding, operation: requested, requestAuthorization }) => {
      const scope = bindingScope(binding); current(scope.controllerInstanceID);
      let reauthorize, mode;
      if (requested === 'connection') {
        if (scope.kind === 'cursor' || scope.kind === 'provider') throw fail('native_integration_scope_invalid');
        mode = 'connection'; reauthorize = () => authorizeConfiguredConnection(scope);
      } else {
        const request = requests.get(requestAuthorization);
        if (!request || request.instanceID !== scope.controllerInstanceID || request.spec.kind !== scope.kind || request.spec.directory !== scope.directory
          || request.spec.server !== scope.server || request.spec.configurationDigest !== scope.configurationDigest
          || request.spec.integrationID !== scope.integrationID) throw fail('native_integration_caller_required');
        if (requested === 'oauth' && request.spec.operation === `${scope.kind}.oauth.start` && request.spec.methodID === scope.methodID) mode = 'oauth';
        else if (requested === 'remove' && request.spec.operation === 'mcp.oauth.remove'
          && request.spec.credentialID === binding.credentialID) mode = 'remove';
        else if (requested === 'mutation' && ['openai', 'cursor', 'provider'].includes(scope.kind) && request.spec.operation === `${scope.kind}.credential.${binding.operation}`
          && request.spec.valueType === binding.valueType && request.spec.methodID === binding.methodID
          && request.spec.credentialID === binding.credentialID && request.spec.expectedFingerprint === binding.expectedFingerprint
          && request.spec.requestedFingerprint === binding.requestedFingerprint) mode = 'mutation';
        else throw fail('native_integration_scope_invalid');
        reauthorize = request.reauthorize;
      }
      await check(scope, reauthorize);
      if (grants.size >= limit) throw fail('native_integration_grant_capacity');
      const authorizationID = token();
      grants.set(authorizationID, { scope, mode, reauthorize, ...(mode === 'remove' ? { credentialID: binding.credentialID } : {}),
        ...(mode === 'mutation' ? { mutation: { operation: binding.operation, valueType: binding.valueType,
          credentialID: binding.credentialID, expectedFingerprint: binding.expectedFingerprint, requestedFingerprint: binding.requestedFingerprint } } : {}) });
      return { authorizationID };
    },
    reauthorize: async input => { await resolve(input); },
    resolveMutation: async input => {
      const grant = await resolve(input), binding = input.binding;
      if (!['key', 'oauth'].includes(binding.valueType) || grant.scope.kind === 'mcp' && binding.valueType !== 'oauth'
        || grant.scope.kind === 'cursor' && binding.valueType !== 'key' || !sha(binding.requestedFingerprint)
        || !['create', 'update', 'activate', 'remove'].includes(binding.operation)) throw fail('native_credential_mutation_invalid');
      if (grant.mode === 'connection' && (binding.valueType !== 'oauth' || !['update', 'remove'].includes(binding.operation)
        || !id(binding.credentialID) || !sha(binding.expectedFingerprint))) throw fail('native_credential_mutation_denied');
      if (grant.mode === 'oauth' && !['create', 'activate'].includes(binding.operation)) throw fail('native_credential_mutation_denied');
      if (grant.mode === 'oauth' && binding.valueType !== 'oauth') throw fail('native_credential_mutation_denied');
      if (grant.mode === 'mutation' && stable(grant.mutation) !== stable({ operation: binding.operation, valueType: binding.valueType,
        credentialID: binding.credentialID, expectedFingerprint: binding.expectedFingerprint, requestedFingerprint: binding.requestedFingerprint })) throw fail('native_credential_mutation_denied');
      if (grant.mode === 'remove' && (binding.operation !== 'remove' || binding.credentialID !== grant.credentialID
        || !sha(binding.expectedFingerprint) || binding.requestedFingerprint !== digest({ id: binding.credentialID }))) throw fail('native_credential_mutation_denied');
      if (grant.mode === 'mutation') {
        const stored = grants.get(input.authorizationID);
        if (!stored || stored.consumed) throw fail('native_credential_mutation_denied');
        // The original HTTP intent admits one concrete action. An uncertain
        // outcome requires a fresh caller operation, never a copied grant.
        stored.consumed = true;
      }
      return { reauthorize: grant.reauthorize };
    },
    authorizeControl: async ({ binding, operation: requested, requestAuthorization }) => {
      const request = requests.get(requestAuthorization);
      if (!request || request.instanceID !== controllerIdentity() || request.spec.directory !== binding.directory
        || request.spec.server !== binding.server || request.spec.configurationDigest !== binding.configurationDigest
        || request.spec.operation !== requested || !['mcp.connect', 'mcp.disconnect'].includes(requested)) throw fail('native_integration_caller_required');
      await request.reauthorize(); current(request.instanceID); await verifyBinding(binding);
      current(request.instanceID); await request.reauthorize(); current(request.instanceID);
    },
    close: () => { closed = true; requests.clear(); grants.clear(); },
  };
}
