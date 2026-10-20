import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createNativeAuthorization } from './native-authorization.js';
import { DEFAULT_HELPER_MODEL_SELECTION, parseHelperModelSelection } from '@devryan/shared-runtime';
import { createSupabaseConnection } from '../../multi-user/supabase-connection.js';
import { getRequestPrincipal, runWithRequestPrincipal } from '../../multi-user/request-context.js';
import { createNativeAdmissionOwner } from './native-admission-owner.js';
import { createOpenCodeClient } from '../opencode-client/index.js';
import { createOpenCodeAdmission } from '../v2/admission.js';

const fixture = async action => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-native-auth-')));
  try { await action(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
};
const manifest = { inputs: { nativeRegistrations: [{ id: 'opencode.tool.read', manifestDigest: 'a'.repeat(64), capabilities: ['read'] }], reviewedPlugins: [] } };

test('archive retains real local owner authorization across client locks and native metadata effects', () => fixture(async directory => {
  const connection = await createSupabaseConnection({ config: { configured: true, enabled: false, dataDirectory: directory },
    fetchImpl: () => { throw new Error('Cloud calls forbidden'); } });
  let owner, admission, cookie;
  const sessionID = 'ses_archive';
  let metadata = { unrelated: 'preserved' };
  try {
    await connection.rememberOwner({ id: 'enrolled-uuid', role: 'admin', scope: 'managed' }, { setHeader: (_name, values) => { cookie = values[0].split(';')[0]; } });
    const principal = connection.authenticateLocalOwner({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3000', cookie } });
    const authorization = createNativeAuthorization({ locations: [{ directory }], manifest, getRequestPrincipal,
      captureLocalAuthorization: value => connection.captureAuthorization(value), getMultiUserRuntime: () => ({ enabled: false, connection }) });
    const client = createOpenCodeClient({ getRuntime: () => ({ generation: 2, baseUrl: 'http://fixture.invalid', epoch: 1 }), getAdmission: () => admission,
      getAuthHeaders: () => owner.requestHeaders(), withNativeWebOperation: (spec, action) => owner.withWebOperation(spec, action),
      fetchImpl: async (_url, options) => {
        expect(getRequestPrincipal()).toBe(principal);
        if (options.method === 'PATCH') {
          const body = JSON.parse(options.body);
          await owner.handleRpc('native.admission.authorize', { operation: 'session.setMetadata', sessionID,
            existingPermit: JSON.parse(options.headers['x-devryan-native-permit']), input: { sessionID, metadata: body.metadata } });
          metadata = body.metadata;
        }
        return Response.json({ data: { id: sessionID, location: { directory }, metadata, time: { created: 1, updated: 1 } } });
      } });
    admission = createOpenCodeAdmission({ getRuntime: () => ({ generation: 2, baseUrl: 'http://fixture.invalid', epoch: 1 }) }, { client });
    owner = createNativeAdmissionOwner({ directory, ownerID: 'fixture', runtime: { registerNativeSession: async () => {}, nativeAdmissionState: async () => ({ held: false, revision: 0 }) },
      getSession: id => client.sessions.get(id), readSessionMetadata: async () => ({id:sessionID,directory,metadata:structuredClone(metadata)}), ...authorization });
    await runWithRequestPrincipal(principal, async () => {
      expect((await client.sessions.archive(sessionID, 123, { directory })).time.archived).toBe(123);
      expect(metadata.unrelated).toBe('preserved');
      expect((await client.sessions.archive(sessionID, 0, { directory })).time.archived).toBe(0);
      await connection.dispose();
      await expect(client.sessions.archive(sessionID, 456, { directory })).rejects.toMatchObject({ code: 'native_web_principal_denied' });
    });
  } finally { owner?.dispose(); await connection.dispose(); }
}));

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


test('detached managed catalog issuer verifies root owner without granting a public operation',()=>fixture(async directory=>{
 let allowed=true;const authorization=createNativeAuthorization({locations:[{directory}],manifest,getRequestPrincipal:()=>undefined,getMultiUserRuntime:()=>({enabled:true,resolveSessionPlanContext:async()=>allowed?{directory}:null})});
 const session={id:'ses_catalog_root',directory};
 const check=await authorization.captureManagedCatalogAuthorization(session);await check();
 await expect(authorization.authorizeOperation({operation:'cursor.readonly'},session)).rejects.toMatchObject({code:'native_owned_operation_required'});
 for(const invalid of [{parentID:'ses_other'},{revert:{messageID:'msg_old'}},{time:{archived:1}}])await expect(authorization.captureManagedCatalogAuthorization({...session,...invalid})).rejects.toMatchObject({code:'native_managed_catalog_scope_invalid'});
 allowed=false;await expect(check()).rejects.toMatchObject({code:'native_session_access_revoked'});
}));

test('configured helper authorization binds the exact saved revision and keeps active fallback canonical', () => fixture(async directory => {
  let settings = { helperModelSelection: { providerID: 'opencode', modelID: 'flash', revision: 'one' } }, allowed = true;
  const session = { id: 'ses_owned', directory, model: { providerID: 'anthropic', id: 'active', variant: 'high' } };
  const authorization = createNativeAuthorization({ locations: [{ directory }], manifest, getRequestPrincipal: () => ({ scope: 'managed', id: 'alice', appSessionId: 'login' }),
    getMultiUserRuntime: () => ({ enabled: true, resolveSessionPlanContext: async () => allowed ? { directory } : null,
      resolveCurrentNativeOperationContext: async () => allowed ? { directory } : null,
      resolveNativeHelperSettings: async () => settings }) });
  const configured = await authorization.captureHelperSelection({ directory, sessionID: session.id, agent: 'devryan-title', selectionMode: 'configured' }, session);
  expect(configured.selection).toEqual(settings.helperModelSelection);
  expect(configured.selection).not.toHaveProperty('variant');
  await configured.recheck();
  settings = { helperModelSelection: { ...settings.helperModelSelection, revision: 'two' } };
  await expect(configured.recheck()).rejects.toMatchObject({ code: 'native_helper_selection_changed' });
  const active = await authorization.captureHelperSelection({ directory, sessionID: session.id, agent: 'devryan-pr', selectionMode: 'active' }, session);
  expect(active.selection).toEqual({ providerID: 'anthropic', modelID: 'active', variant: 'high', revision: 'active-session' });
  expect(session.model.variant).toBe('high');
  const defaultActive = await authorization.captureHelperSelection({ directory, sessionID: session.id, agent: 'devryan-pr', selectionMode: 'active' },
    { ...session, model: { providerID: 'anthropic', id: 'active' } });
  expect(defaultActive.selection).not.toHaveProperty('variant');
  settings = { helperModelSelection: { providerID: 'openai', modelID: 'reasoner', variant: 'low', revision: 'three' } };
  const reasoned = await authorization.captureHelperSelection({ directory, sessionID: session.id, agent: 'devryan-commit', selectionMode: 'configured' }, session);
  expect(reasoned.selection).toEqual(settings.helperModelSelection);
  settings = { helperModelSelection: { ...settings.helperModelSelection, variant: 'high' } };
  await expect(reasoned.recheck()).rejects.toMatchObject({ code: 'native_helper_selection_changed' });
  settings = null;
  await expect(authorization.captureHelperSelection({ directory, sessionID: session.id, agent: 'devryan-pr', selectionMode: 'configured' }, session))
    .rejects.toMatchObject({ code: 'native_helper_settings_unavailable', statusCode: 503 });
  settings = { helperModelSelection: { providerID: 'opencode', modelID: 'flash' } };
  await expect(authorization.captureHelperSelection({ directory, sessionID: session.id, agent: 'devryan-pr', selectionMode: 'configured' }, session))
    .rejects.toMatchObject({ code: 'native_helper_selection_invalid', statusCode: 400 });
  allowed = false;
  await expect(active.recheck()).rejects.toMatchObject({ code: 'native_session_access_revoked' });
}));

test('devryan-notify follows the detached title path: session required, no web principal, unknown agents rejected', () => fixture(async directory => {
  const authorization = createNativeAuthorization({ locations: [{ directory }], manifest, getRequestPrincipal: () => undefined,
    getMultiUserRuntime: () => ({ enabled: true, resolveSessionPlanContext: async () => ({ directory }),
      resolveNativeHelperSettings: async () => ({ helperModelSelection: { providerID: 'opencode', modelID: 'flash', revision: 'one' } }) }) });
  const session = { id: 'ses_notify', directory };
  // No web principal is required, but a canonical session is.
  const configured = await authorization.captureHelperSelection({ directory, sessionID: session.id, agent: 'devryan-notify', selectionMode: 'configured' }, session);
  expect(configured.selection).toEqual({ providerID: 'opencode', modelID: 'flash', revision: 'one' });
  await configured.recheck();
  await expect(authorization.captureHelperSelection({ directory, sessionID: session.id, agent: 'devryan-notify', selectionMode: 'configured' }))
    .rejects.toMatchObject({ code: 'native_helper_selection_invalid' });
  await expect(authorization.captureHelperSelection({ directory, sessionID: session.id, agent: 'devryan-something', selectionMode: 'configured' }, session))
    .rejects.toMatchObject({ code: 'native_helper_selection_invalid' });
}));

test('a single-user saved helper model and reasoning level is what every helper captures', () => fixture(async directory => {
  // The settings write path keeps the exact tuple; the host read returns it.
  let persisted = {};
  const save = changes => { const helperModelSelection = parseHelperModelSelection(changes.helperModelSelection); if (helperModelSelection) persisted = { ...persisted, helperModelSelection }; };
  const principal = { id: 'local-admin', scope: 'local-admin' };
  const authorization = createNativeAuthorization({ locations: [{ directory }], manifest, getRequestPrincipal: () => principal,
    captureLocalAuthorization: value => value === principal ? () => true : null,
    getMultiUserRuntime: () => ({ enabled: false, connection: { configured: false, isLocalAccessActive: () => true } }),
    readHelperSettings: async () => structuredClone(persisted) });
  const session = { id: 'ses_saved', directory, model: { providerID: 'openai', id: 'chat', variant: 'high' } };
  const capture = agent => authorization.captureHelperSelection({ directory, sessionID: session.id, agent, selectionMode: 'configured' }, session);
  for (const agent of ['devryan-title', 'devryan-notify', 'devryan-commit', 'devryan-pr']) {
    expect((await capture(agent)).selection).toEqual(DEFAULT_HELPER_MODEL_SELECTION);
  }
  save({ helperModelSelection: { providerID: 'xai', modelID: 'grok-4.6', variant: 'low', revision: 'saved-1' } });
  for (const agent of ['devryan-title', 'devryan-notify', 'devryan-commit', 'devryan-pr']) {
    const captured = await capture(agent);
    expect(captured.selection).toEqual({ providerID: 'xai', modelID: 'grok-4.6', variant: 'low', revision: 'saved-1' });
    await captured.recheck();
  }
}));
