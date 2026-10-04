const fail = code => Object.assign(new Error(code), { code, status: 403, statusCode: 403 });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const key = (directory, server) => `${directory}\0${server}`;

/** Typed browser adaptation over native MCP/Integration operations. Grants and
 * attempt identities stay private; this owner never requests credential values. */
export function createNativeMcpOwner({ reviewedServersByDirectory, requestNative, captureCaller, withCallerOperation, cancelOwnedAttempt }) {
  if (!(reviewedServersByDirectory instanceof Map) || typeof requestNative !== 'function'
    || typeof captureCaller !== 'function' || typeof withCallerOperation !== 'function'
    || typeof cancelOwnedAttempt !== 'function') throw fail('native_mcp_owner_configuration_invalid');
  const reviewed = new Map([...reviewedServersByDirectory].map(([directory, servers]) => [directory,
    new Map([...servers].map(([server, binding]) => [server, Object.freeze({ ...binding })]))]));
  const attempts = new Map();
  const starts = new Map();
  let closed = false;
  const bindingFor = ({ directory, server }) => {
    if (closed) throw fail('native_mcp_owner_closed');
    const binding = reviewed.get(directory)?.get(server);
    if (!binding || binding.disabled || typeof server !== 'string' || !server || server.length > 256
      || /[\u0000-\u001f]/.test(server) || !/^[a-f0-9]{64}$/.test(binding.configurationDigest)) throw fail('native_mcp_server_unreviewed');
    return Object.freeze({ directory, server, configurationDigest: binding.configurationDigest });
  };
  const grantFor = async binding => {
    const grant = await captureCaller(binding);
    if (!grant || typeof grant.identityKey !== 'string' || !grant.identityKey || typeof grant.reauthorize !== 'function') throw fail('native_mcp_caller_required');
    await grant.reauthorize(); if (closed) throw fail('native_mcp_owner_closed');
    return grant;
  };
  const scoped = async (binding, grant, spec, onResponse) => {
    await grant.reauthorize(); if (closed) throw fail('native_mcp_owner_closed');
    const result = await withCallerOperation({ ...binding, ...spec }, () => requestNative({
      directory: binding.directory, method: spec.method, path: spec.path, ...(spec.body === undefined ? {} : { body: spec.body }) }));
    onResponse?.(result);
    await grant.reauthorize(); if (closed) throw fail('native_mcp_owner_closed');
    return result;
  };
  const integration = async (binding, grant) => {
    const servers = await scoped(binding, grant, { operation: 'mcp.status', method: 'GET', path: '/api/mcp' });
    if (!Array.isArray(servers)) throw fail('native_mcp_catalog_invalid');
    const matches = servers.filter(server => record(server) && server.name === binding.server);
    if (matches.length !== 1 || !id(matches[0].integrationID)) throw fail('native_mcp_integration_unavailable');
    const integrationID = matches[0].integrationID;
    const info = await scoped(binding, grant, { operation: 'mcp.integration', method: 'GET',
      path: `/api/integration/${encodeURIComponent(integrationID)}`, integrationID });
    if (!record(info) || info.id !== integrationID || info.name !== binding.server || !record(info.metadata)
      || info.metadata.source !== 'mcp' || !Array.isArray(info.methods) || !Array.isArray(info.connections)) throw fail('native_mcp_integration_unavailable');
    return { integrationID, info };
  };
  const attemptFor = async input => {
    const binding = bindingFor(input), current = await grantFor(binding), attempt = attempts.get(key(binding.directory, binding.server));
    if (!attempt || (input.attemptID !== undefined && input.attemptID !== attempt.attemptID)
      || attempt.grant.identityKey !== current.identityKey || attempt.binding.configurationDigest !== binding.configurationDigest) throw fail('native_mcp_attempt_owner_mismatch');
    await attempt.grant.reauthorize(); await current.reauthorize();
    if (closed || attempts.get(key(binding.directory, binding.server)) !== attempt) throw fail('native_mcp_owner_closed');
    return { ...attempt, current };
  };
  const oauthPath = attempt => `/api/integration/${encodeURIComponent(attempt.integrationID)}/connect/oauth/${encodeURIComponent(attempt.attemptID)}`;
  const connect = async (input, action) => {
    const binding = bindingFor(input), grant = await grantFor(binding);
    await scoped(binding, grant, { operation: `mcp.${action}`, method: 'POST',
      path: `/api/experimental/mcp/${encodeURIComponent(binding.server)}/${action}` });
    return true;
  };
  return {
    status: async input => {
      const binding = bindingFor(input), grant = await grantFor(binding);
      const servers = await scoped(binding, grant, { operation: 'mcp.status', method: 'GET', path: '/api/mcp' });
      if (!Array.isArray(servers)) throw fail('native_mcp_catalog_invalid');
      const match = servers.filter(server => record(server) && server.name === binding.server);
      if (match.length !== 1 || !record(match[0].status) || !['connected', 'pending', 'disabled', 'failed', 'needs_auth'].includes(match[0].status.status)) throw fail('native_mcp_catalog_invalid');
      return { status: match[0].status.status };
    },
    connect: input => connect(input, 'connect'), disconnect: input => connect(input, 'disconnect'),
    authStart: async input => {
      const binding = bindingFor(input), attemptKey = key(binding.directory, binding.server);
      if (attempts.has(attemptKey) || starts.has(attemptKey)) return Promise.reject(fail('native_mcp_attempt_in_progress'));
      const work = (async () => {
      const grant = await grantFor(binding);
      const { integrationID, info } = await integration(binding, grant);
      const methods = info.methods.filter(method => record(method) && method.type === 'oauth' && id(method.id));
      if (methods.length !== 1 || methods[0].form !== undefined) throw fail('native_mcp_oauth_method_unavailable');
      const methodID = methods[0].id;
      let ownedAttempt;
      let value;
      try {
        value = await scoped(binding, grant, { operation: 'mcp.oauth.start', method: 'POST',
          path: `/api/integration/${encodeURIComponent(integrationID)}/connect/oauth`, body: { methodID }, integrationID, methodID }, response => {
          if (record(response) && id(response.attemptID)) {
            ownedAttempt = { binding, grant, integrationID, methodID, attemptID: response.attemptID };
            attempts.set(attemptKey, ownedAttempt);
          }
        });
      if (!record(value) || !id(value.attemptID) || !['auto', 'code'].includes(value.mode) || typeof value.url !== 'string'
        || !record(value.time) || !Number.isFinite(value.time.created) || !Number.isFinite(value.time.expires)) throw fail('native_mcp_attempt_invalid');
      let url; try { url = new URL(value.url); } catch { throw fail('native_mcp_attempt_invalid'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw fail('native_mcp_attempt_invalid');
      return { authorizationUrl: value.url, attemptID: value.attemptID, mode: value.mode, time: { created: value.time.created, expires: value.time.expires } };
      } catch (error) {
        if (ownedAttempt) {
          try { await cancelOwnedAttempt({ ...binding, integrationID, attemptID: ownedAttempt.attemptID }); }
          catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native MCP rejected attempt cleanup failed'); }
          finally { attempts.delete(attemptKey); }
        }
        throw error;
      }
      })();
      starts.set(attemptKey, work);
      return work.finally(() => { if (starts.get(attemptKey) === work) starts.delete(attemptKey); });
    },
    authStatus: async input => {
      const attempt = await attemptFor(input);
      const value = await scoped(attempt.binding, attempt.grant, { operation: 'mcp.oauth.status', method: 'GET',
        path: oauthPath(attempt), integrationID: attempt.integrationID, attemptID: attempt.attemptID });
      if (!record(value) || !['pending', 'complete', 'failed', 'expired'].includes(value.status)
        || !record(value.time) || !Number.isFinite(value.time.created) || !Number.isFinite(value.time.expires)) throw fail('native_mcp_attempt_invalid');
      return { status: value.status, time: { created: value.time.created, expires: value.time.expires } };
    },
    authComplete: async input => {
      const attempt = await attemptFor(input);
      if (input.code !== undefined && (typeof input.code !== 'string' || !input.code || input.code.length > 8192)) throw fail('native_mcp_oauth_code_invalid');
      await scoped(attempt.binding, attempt.grant, { operation: 'mcp.oauth.complete', method: 'POST',
        path: `${oauthPath(attempt)}/complete`, body: input.code === undefined ? {} : { code: input.code },
        integrationID: attempt.integrationID, attemptID: attempt.attemptID });
      return true;
    },
    authCancel: async input => {
      const attempt = await attemptFor(input);
      await scoped(attempt.binding, attempt.grant, { operation: 'mcp.oauth.cancel', method: 'DELETE',
        path: oauthPath(attempt), integrationID: attempt.integrationID, attemptID: attempt.attemptID });
      const attemptKey = key(attempt.binding.directory, attempt.binding.server);
      if (attempts.get(attemptKey)?.attemptID === attempt.attemptID) attempts.delete(attemptKey); return true;
    },
    authRemove: async input => {
      const binding = bindingFor(input), grant = await grantFor(binding);
      const { integrationID, info } = await integration(binding, grant);
      for (const connection of info.connections) {
        if (!record(connection) || connection.type !== 'credential' || connection.method !== 'oauth') continue;
        if (!id(connection.id)) throw fail('native_mcp_connection_invalid');
        await scoped(binding, grant, { operation: 'mcp.oauth.remove', method: 'DELETE', path: `/api/credential/${encodeURIComponent(connection.id)}`,
          integrationID, credentialID: connection.id });
      }
      return true;
    },
    close: async () => {
      closed = true;
      await Promise.allSettled([...starts.values()]);
      const results = await Promise.allSettled([...attempts.values()].map(attempt => cancelOwnedAttempt({ ...attempt.binding,
        integrationID: attempt.integrationID, attemptID: attempt.attemptID })));
      attempts.clear();
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Native MCP owned attempt cleanup failed');
    },
  };
}
