import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createNativeAuthorization } from './native-authorization.js';
import { createSupabaseConnection } from '../../multi-user/supabase-connection.js';

const fixture = async action => {
  const root = await fs.mkdtemp(path.resolve(import.meta.dirname, '../../../../../../.cache/v2-validation/native-auth-'));
  try { await action(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
};
const manifest = { inputs: { nativeRegistrations: [{ id: 'opencode.tool.read', manifestDigest: 'a'.repeat(64), capabilities: ['read'] }], reviewedPlugins: [] } };

test('native web scope retains the original managed caller and rechecks grants before each effect', () => fixture(async directory => {
  let current = { scope: 'managed', id: 'alice', appSessionId: 'alice-session' }, allowed = true;
  const callers = [];
  const runtime = { enabled: true, resolveCurrentNativeOperationContext: async input => {
    callers.push(input.principal); return allowed ? { directory } : null;
  } };
  const authorization = createNativeAuthorization({ locations: [{ directory }], manifest,
    getRequestPrincipal: () => current, getMultiUserRuntime: () => runtime });
  const check = await authorization.captureWebAuthorization({ sessionID: 'ses_owned', directory }, { id: 'ses_owned', directory });
  current = { scope: 'managed', id: 'owner', appSessionId: 'owner-session' };
  await check();
  expect(callers[0]).toEqual({ scope: 'managed', id: 'alice', appSessionId: 'alice-session' });
  allowed = false;
  await expect(check()).rejects.toMatchObject({ code: 'native_session_access_revoked' });
}));

test('native account and config grants retain the exact settings action through fresh checks', () => fixture(async directory => {
  let allowed = true;
  const seen = [];
  const authorization = createNativeAuthorization({ locations: [{ directory }], manifest,
    getRequestPrincipal: () => ({ scope: 'managed', id: 'alice', appSessionId: 'alice-session' }),
    getMultiUserRuntime: () => ({ enabled: true, resolveCurrentNativeOperationContext: async input => {
      seen.push(input.settingsAccess); return allowed ? { directory } : null;
    } }) });
  for (const [request, expected] of [
    [{ operation: 'provider.configuration', scope: 'read' }, { page: 'providers', mode: 'read' }],
    [{ operation: 'provider.configuration', scope: 'all' }, { page: 'providers', mode: 'edit' }],
    [{ kind: 'cursor', method: 'POST' }, { page: 'providers', mode: 'edit' }],
    [{ kind: 'mcp', method: 'GET' }, { page: 'mcp', mode: 'read' }],
  ]) {
    const check = await authorization.captureWebAuthorization({ ...request, directory });
    allowed = true; await check(); expect(seen.at(-1)).toEqual(expected);
    allowed = false; await expect(check()).rejects.toMatchObject({ code: 'native_session_access_revoked' });
    expect(seen.at(-1)).toEqual(expected);
  }
  await expect(authorization.captureWebAuthorization({ operation: 'provider.configuration', scope: 'unknown', directory }))
    .rejects.toMatchObject({ code: 'native_settings_scope_invalid' });
}));

test('missing principals never become local administrators and selected locations stay exact', () => fixture(async directory => {
  let current, configured = false;
  const authorization = createNativeAuthorization({ locations: [{ directory }], manifest, getRequestPrincipal: () => current,
    captureLocalAuthorization: principal => principal === current ? () => !configured : null,
    getMultiUserRuntime: () => ({ enabled: false, connection: { configured } }) });
  await expect(authorization.captureWebAuthorization({ directory })).rejects.toMatchObject({ code: 'native_web_principal_required' });
  current = { id: 'local-admin', scope: 'local-admin' };
  const check = await authorization.captureWebAuthorization({ directory }); await check();
  configured = true;
  await expect(check()).rejects.toMatchObject({ code: 'native_web_principal_denied' });
  await expect(authorization.captureWebAuthorization({ directory: path.dirname(directory) })).rejects.toMatchObject({ code: 'native_session_directory_mismatch' });
}));

test('local native grants come from the original authenticator and canonical Off work does not require a provenance map', () => fixture(async directory => {
  const original = { id: 'actual-owner-uuid', scope: 'local-admin', localOwner: true };
  let current = original, live = true, active = true, owner = { id: original.id, role: 'admin' };
  const authorization = createNativeAuthorization({ locations: [{ directory }], manifest, getRequestPrincipal: () => current,
    captureLocalAuthorization: principal => principal === original ? () => live : null,
    getMultiUserRuntime: () => ({ enabled: false, connection: { configured: true, isLocalAccessActive: () => active, ownerPrincipal: () => owner } }) });
  const check = await authorization.captureWebAuthorization({ sessionID: 'ses_prior_managed', directory }); await check();
  current = structuredClone(original);
  const forged = await authorization.captureWebAuthorization({ directory });
  await expect(forged()).rejects.toMatchObject({ code: 'native_web_principal_denied' });
  await authorization.authorizeOperation({ operation: 'runner.drain' }, { id: 'ses_prior_managed', directory });
  live = false;
  await expect(check()).rejects.toMatchObject({ code: 'native_web_principal_denied' });
  active = false;
  await expect(authorization.authorizeOperation({ operation: 'store.claim' }, { id: 'ses_prior_managed', directory }))
    .rejects.toMatchObject({ code: 'native_session_access_revoked' });
  active = true; owner = null;
  await expect(authorization.authorizeOperation({ operation: 'runner.drain' }, { id: 'ses_prior_managed', directory }))
    .rejects.toMatchObject({ code: 'native_session_access_revoked' });
}));

test('configured Off native work uses the genuine current local owner and refuses after owner disposal', () => fixture(async directory => {
  const connection = await createSupabaseConnection({ config: { configured: true, enabled: false, dataDirectory: directory },
    fetchImpl: () => { throw new Error('Cloud calls forbidden'); } });
  let cookie;
  try {
    await connection.rememberOwner({ id: 'enrolled-uuid', role: 'admin', scope: 'managed' }, { setHeader: (_name, values) => { cookie = values[0].split(';')[0]; } });
    const principal = connection.authenticateLocalOwner({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3000', cookie } });
    const authorization = createNativeAuthorization({ locations: [{ directory }], manifest, getRequestPrincipal: () => principal,
      captureLocalAuthorization: value => connection.captureAuthorization(value), getMultiUserRuntime: () => ({ enabled: false, connection }) });
    const web = await authorization.captureWebAuthorization({ sessionID: 'ses_old_managed', directory }); await web();
    await authorization.authorizeOperation({ operation: 'runner.drain' }, { id: 'ses_old_managed', directory });
    await connection.dispose();
    await expect(web()).rejects.toMatchObject({ code: 'native_web_principal_denied' });
    await expect(authorization.authorizeOperation({ operation: 'store.claim' }, { id: 'ses_old_managed', directory }))
      .rejects.toMatchObject({ code: 'native_session_access_revoked' });
  } finally { await connection.dispose(); }
}));

test('detached work needs live ownership and the full reviewed tool origin', () => fixture(async directory => {
  let allowed = true;
  const authorization = createNativeAuthorization({ locations: [{ directory }], manifest, getRequestPrincipal: () => undefined,
    getMultiUserRuntime: () => ({ enabled: true, resolveSessionPlanContext: async () => allowed ? { directory } : null }) });
  const session = { id: 'ses_owned', directory };
  const tool = { operation: 'tool.execute', input: { toolID: 'read', provenance: { kind: 'native', ...manifest.inputs.nativeRegistrations[0] } } };
  await authorization.authorizeOperation(tool, session);
  await expect(authorization.authorizeOperation({ ...tool, input: { ...tool.input, provenance: { ...tool.input.provenance, manifestDigest: 'b'.repeat(64) } } }, session))
    .rejects.toMatchObject({ code: 'native_registration_origin_denied' });
  await expect(authorization.authorizeOperation({ operation: 'session.remove' }, session)).rejects.toMatchObject({ code: 'native_owned_operation_required' });
  allowed = false;
  await expect(authorization.authorizeOperation({ operation: 'runner.drain' }, session)).rejects.toMatchObject({ code: 'native_session_access_revoked' });
}));

test('only compiled Slim AST names gain supervised authority with the whole reviewed origin', () => fixture(async directory => {
  const slim = { id: 'devryan.slim', manifestDigest: 'b'.repeat(64), capabilities: ['read', 'write', 'process'] };
  const authorization = createNativeAuthorization({ locations: [{ directory }], manifest: { inputs: { ...manifest.inputs, reviewedPlugins: [slim] } },
    getRequestPrincipal: () => undefined, getMultiUserRuntime: () => ({ enabled: true, resolveSessionPlanContext: async () => ({ directory }) }) });
  const request = toolID => ({ operation: 'tool.execute', input: { toolID, provenance: { kind: 'plugin', ...slim } } });
  const session = { id: 'ses_owned', directory };
  for (const tool of ['ast_grep_search', 'ast_grep_replace']) await authorization.authorizeOperation(request(tool), session);
  await expect(authorization.authorizeOperation(request('write'), session)).rejects.toMatchObject({ code: 'native_tool_capability_unavailable' });
  const forged = request('ast_grep_search'); forged.input.provenance.capabilities = ['read'];
  await expect(authorization.authorizeOperation(forged, session)).rejects.toMatchObject({ code: 'native_registration_origin_denied' });
}));

test('browser authority requires its exact compiled registration and tool name', () => fixture(async directory => {
  const browser = { id: 'devryan.browser', manifestDigest: 'c'.repeat(64), capabilities: ['process'] };
  const authorization = createNativeAuthorization({ locations: [{ directory }], manifest: { inputs: { ...manifest.inputs, reviewedPlugins: [browser] } },
    getRequestPrincipal: () => undefined, getMultiUserRuntime: () => ({ enabled: true, resolveSessionPlanContext: async () => ({ directory }) }) });
  const request = toolID => ({ operation: 'tool.execute', input: { toolID, provenance: { kind: 'plugin', ...browser } } });
  const session = { id: 'ses_owned', directory };
  await authorization.authorizeOperation(request('devryan_browser'), session);
  await expect(authorization.authorizeOperation(request('shell'), session)).rejects.toMatchObject({ code: 'native_tool_capability_unavailable' });
  const forged = request('devryan_browser'); forged.input.provenance.capabilities = ['read'];
  await expect(authorization.authorizeOperation(forged, session)).rejects.toMatchObject({ code: 'native_registration_origin_denied' });
}));

test('document ancestry needs a current shared owner and project grant as well as the actual parent link',()=>fixture(async directory=>{
 const session={id:'ses_child',parentID:'ses_parent',directory},parent={id:'ses_parent',directory};
 let revoked=false,foreign=false;
 const authority=createNativeAuthorization({locations:[{directory}],manifest,getRequestPrincipal:()=>undefined,
  getMultiUserRuntime:()=>({enabled:true,resolveSessionPlanContext:async({sessionID})=>revoked&&sessionID===parent.id?null:
   {directory,ownerKey:foreign&&sessionID===parent.id?'user:other':'user:original',projectId:'owned-project'}})});
 await authority.authorizeRelatedSessionRead({session,source:session,parent});
 foreign=true;await expect(authority.authorizeRelatedSessionRead({session,source:session,parent})).rejects.toMatchObject({code:'native_related_session_access_denied'});foreign=false;
 revoked=true;await expect(authority.authorizeRelatedSessionRead({session,source:session,parent})).rejects.toMatchObject({code:'native_session_access_revoked'});revoked=false;
 await expect(authority.authorizeRelatedSessionRead({session,source:{...session,parentID:'ses_other'},parent})).rejects.toMatchObject({code:'native_related_session_scope_invalid'});
 await expect(authority.authorizeRelatedSessionRead({session,source:session,parent:{...parent,time:{archived:1}}})).rejects.toMatchObject({code:'native_related_session_scope_invalid'});
}));

test('detached title issuer retains canonical owner checks without enabling generic helper or rename authority',()=>fixture(async directory=>{
 let allowed=true;const authorization=createNativeAuthorization({locations:[{directory}],manifest,getRequestPrincipal:()=>undefined,getMultiUserRuntime:()=>({enabled:true,resolveSessionPlanContext:async()=>allowed?{directory}:null})});
 const session={id:'ses_title_owned',directory,model:{providerID:'fixture',id:'chosen'}};
 const check=await authorization.captureTitleHelperAuthorization(session);await check();
 for(const operation of ['helper.generate','session.rename'])await expect(authorization.authorizeOperation({operation},session)).rejects.toMatchObject({code:'native_owned_operation_required'});
 allowed=false;await expect(check()).rejects.toMatchObject({code:'native_session_access_revoked'});
 await expect(authorization.captureTitleHelperAuthorization({...session,revert:{messageID:'msg_old'}})).rejects.toMatchObject({code:'native_title_scope_invalid'});
}));
