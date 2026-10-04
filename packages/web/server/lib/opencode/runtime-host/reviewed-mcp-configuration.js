import { Mcp } from '@opencode/schema/mcp';
import { Schema } from 'effect';
import { credentialMutationFingerprint } from './native-credential-mutation-owner.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const defined = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
const fail = () => Object.assign(new Error('native_mcp_configuration_unqualified'), { code: 'native_mcp_configuration_unqualified', status: 503 });

/** The pinned v1→v2 data mapping, without importing the SDK runtime graph. */
export function reviewedMcpConfiguration(snapshot, directories) {
  return new Map(directories.map(directory => {
    const definitions = snapshot?.locations.find(location => location.directory === directory)?.compatibility.mcp ?? {};
    if (!record(definitions)) throw fail();
    const servers = new Map();
    for (const [server, info] of Object.entries(definitions)) {
      if (!record(info)) throw fail();
      if (info.enabled === false && info.type !== 'remote') continue;
      if (info.type !== 'remote' || Object.keys(info).some(key => !['type', 'url', 'headers', 'oauth', 'enabled', 'timeout'].includes(key))
        || info.oauth !== undefined && info.oauth !== false && !record(info.oauth)) throw fail();
      if (record(info.oauth) && Object.keys(info.oauth).some(key => !['clientId', 'clientSecret', 'scope', 'callbackPort', 'redirectUri'].includes(key))) throw fail();
      const config = Schema.decodeUnknownSync(Mcp.RemoteConfig)(defined({ type: 'remote', url: info.url, headers: info.headers,
        disabled: info.enabled === undefined ? undefined : !info.enabled, codemode: false,
        timeout: info.timeout === undefined ? undefined : { catalog: info.timeout, execution: info.timeout },
        oauth: info.oauth && defined({ client_id: info.oauth.clientId, client_secret: info.oauth.clientSecret, scope: info.oauth.scope,
          callback_port: info.oauth.callbackPort, redirect_uri: info.oauth.redirectUri }) }), { onExcessProperty: 'error' });
      const url = new URL(config.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail();
      servers.set(server, { config, configurationDigest: credentialMutationFingerprint({ ...config, timeout: config.timeout ?? {} }) });
    }
    return [directory, servers];
  }));
}
