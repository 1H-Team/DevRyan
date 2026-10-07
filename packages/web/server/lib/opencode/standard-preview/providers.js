import { createV2Requester } from '../opencode-client/v2.js';
import { unwrapData, unwrapList } from '../opencode-client/envelope.js';
import { withOpenCodeRuntime } from '../opencode-client/runtime.js';
import { previewUnavailable } from './capabilities.js';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const invalid = () => Object.assign(new Error('Invalid provider API-key request'), { code: 'opencode_invalid_input', statusCode: 400 });

/** API-key-only adaptation. Secret values are never read back or stored by DevRyan. */
export function createStandardPreviewProviders(deps) {
  const request = createV2Requester(deps);
  const providers = async options => unwrapList(await request({ ...options, label: 'preview.providers', path: '/api/provider' }));
  const information = async (id, options) => {
    if (!identifier(id) || !(await providers(options)).some(provider => provider.id === id)) throw invalid();
    const value = unwrapData(await request({ ...options, label: 'preview.integration', path: `/api/integration/${encodeURIComponent(id)}` }));
    if (value?.id !== id || !Array.isArray(value.methods) || !Array.isArray(value.connections)) {
      throw Object.assign(new Error('Invalid stock provider integration'), { code: 'opencode_invalid_response', statusCode: 502 });
    }
    return value;
  };
  const run = action => withOpenCodeRuntime(deps.getRuntime, 'preview.provider', action);
  const credentialConnections = info => info.connections.filter(connection => connection.type === 'credential' && identifier(connection.id));
  return {
    providerMethods: options => run(async () => {
      const catalog = await providers(options);
      const integrations = unwrapList(await request({ ...options, label: 'preview.integrations', path: '/api/integration' }));
      return Object.fromEntries(catalog.map(provider => [provider.id,
        (integrations.find(info => info.id === provider.id)?.methods ?? []).filter(method => method.type === 'key')
          .map(method => ({ type: 'api', label: typeof method.label === 'string' ? method.label : 'API key' }))]));
    }),
    saveKey: (id, body, options) => run(async () => {
      if (!body || body.type !== 'api' || Object.keys(body).some(key => !['type', 'key'].includes(key))
        || typeof body.key !== 'string' || !body.key.trim() || body.key.length > 16384) throw invalid();
      const info = await information(id, options);
      if (!info.methods.some(method => method.type === 'key')) throw previewUnavailable('providerApiKey');
      await request({ ...options, label: 'preview.provider.connectKey', method: 'POST',
        path: `/api/integration/${encodeURIComponent(id)}/connect/key`, body: { key: body.key.trim() } });
      return { success: true, configured: true };
    }),
    source: (id, options) => run(async () => {
      const info = await information(id, options);
      return { providerId: id, sources: { auth: { exists: credentialConnections(info).length > 0 },
        user: { exists: false }, project: { exists: false }, custom: { exists: false } } };
    }),
    providerDisconnect: (id, scope, options) => run(async () => {
      if (scope !== 'auth') throw previewUnavailable('providerConfigurationRemoval');
      const info = await information(id, options), connections = credentialConnections(info);
      // The preview UI owns key setup only; OAuth accounts remain outside this adapter.
      if (connections.some(connection => connection.method === 'oauth')) throw previewUnavailable('providerOAuth');
      for (const connection of connections) await request({ ...options, label: 'preview.provider.disconnect', method: 'DELETE',
        path: `/api/credential/${encodeURIComponent(connection.id)}` });
      const remains = credentialConnections(await information(id, options)).length > 0;
      return { success: true, removed: connections.length > 0,
        removedSources: { auth: connections.length > 0, user: false, project: false, custom: false },
        sources: { auth: { exists: remains }, user: { exists: false }, project: { exists: false }, custom: { exists: false } },
        stillProvidedBy: remains ? [{ type: 'auth', path: null }] : [] };
    }),
  };
}
