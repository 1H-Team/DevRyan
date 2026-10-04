import fs from 'node:fs/promises';

const fail = code => Object.assign(new Error(code), { code, status: 403, statusCode: 403 });
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const DETACHED = new Set(['runner.drain','store.claim','store.countResume','execution.resume']);

/** Original web callers and detached native work have separate, fresh grant checks. */
export function createNativeAuthorization({ locations, manifest, getRequestPrincipal, getMultiUserRuntime, captureLocalAuthorization }) {
  if (!Array.isArray(locations) || !locations.length || !Array.isArray(manifest.inputs?.nativeRegistrations)
    || typeof getRequestPrincipal !== 'function' || typeof getMultiUserRuntime !== 'function') throw fail('native_authorization_configuration_invalid');
  const origins = new Map([...manifest.inputs.nativeRegistrations.map(origin => [{ kind: 'native', ...origin }, origin.id]),
    ...manifest.inputs.reviewedPlugins.map(origin => [{ kind: 'plugin', ...origin }, origin.id])].map(([origin, id]) => [id, stable(origin)]));
  const directoryAllowed = async directory => {
    if (!locations.some(location=>location.directory===directory) || await fs.realpath(directory) !== directory) throw fail('native_session_directory_mismatch');
  };
  const detached = async session => {
    if (!session?.id || session.time?.archived) throw fail('native_session_owner_required');
    await directoryAllowed(session.directory);
    const multiUser = getMultiUserRuntime();
    if (!multiUser) throw fail('native_session_owner_unavailable');
    if (multiUser.enabled) {
      const context = await multiUser.resolveSessionPlanContext({ sessionID: session.id, directory: session.directory });
      if (!context || await fs.realpath(context.directory) !== session.directory) throw fail('native_session_access_revoked');
    } else {
      const connection = multiUser.connection;
      if (connection?.isLocalAccessActive?.() !== true
        || connection.configured && (!connection.ownerPrincipal?.()?.id || connection.ownerPrincipal()?.role !== 'admin')) throw fail('native_session_access_revoked');
    }
    // With local authentication the verified bundle and canonical session own
    // detached work; a missing HTTP principal never creates a web grant.
  };
  return {
    captureTitleHelperAuthorization: async session=>{
      if(session?.revert||!session?.model?.providerID||!(session.model.id??session.model.modelID))throw fail('native_title_scope_invalid');
      await detached(session);return ()=>detached(session);
    },
    captureWebAuthorization: async (request, session) => {
      const principal = getRequestPrincipal();
      if (!principal) throw fail('native_web_principal_required');
      // Ask the authenticator while this is still its exact private principal.
      // Public clones and matching identity fields cannot manufacture a grant.
      const local = principal.scope === 'local-admin' ? await captureLocalAuthorization?.(principal) : null;
      const original = structuredClone(principal);
      let settingsAccess;
      if (request.operation === 'provider.configuration') {
        if (!['read', 'auth', 'user', 'project', 'custom', 'all'].includes(request.scope)) throw fail('native_settings_scope_invalid');
        settingsAccess = { page: 'providers', mode: request.scope === 'read' ? 'read' : 'edit' };
      } else if (['mcp', 'openai', 'cursor', 'provider'].includes(request.kind)) {
        if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) throw fail('native_settings_scope_invalid');
        settingsAccess = { page: request.kind === 'mcp' ? 'mcp' : 'providers', mode: request.method === 'GET' ? 'read' : 'edit' };
      }
      const directory = session?.directory ?? request.directory, sessionID = request.sessionID;
      await directoryAllowed(directory);
      return async () => {
        await directoryAllowed(directory);
        const multiUser = getMultiUserRuntime();
        if (!multiUser) throw fail('native_session_owner_unavailable');
        if (original.scope === 'managed') {
          const context = await multiUser.resolveCurrentNativeOperationContext?.({ principal: original, sessionID, directory, ...(settingsAccess ? { settingsAccess } : {}) });
          if (!context || context.directory !== directory) throw fail('native_session_access_revoked');
        } else if (original.scope !== 'local-admin' || multiUser.enabled || typeof local !== 'function' || await local() !== true) {
          throw fail('native_web_principal_denied');
        }
      };
    },
    /** Constructor-only document ancestry read. A parent ID never grants another owner's data. */
    authorizeRelatedSessionRead: async ({session, source, parent}) => {
      if(!session?.id || !source?.id || !parent?.id || source.parentID!==parent.id || session.directory!==source.directory
        || session.directory!==parent.directory || [session,source,parent].some(row=>row.time?.archived || row.revert))throw fail('native_related_session_scope_invalid');
      for(const row of [session,source,parent])await detached(row);
      const multiUser=getMultiUserRuntime();
      if(!multiUser)throw fail('native_session_owner_unavailable');
      if(multiUser.enabled){
        const grants=await Promise.all([session,source,parent].map(row=>multiUser.resolveSessionPlanContext({sessionID:row.id,directory:row.directory})));
        const first=grants[0];
        if(!first || typeof first.ownerKey!=='string' || !first.ownerKey || typeof first.projectId!=='string'
          || grants.some(value=>!value || value.ownerKey!==first.ownerKey || value.projectId!==first.projectId || value.directory!==session.directory))
          throw fail('native_related_session_access_denied');
      }
      for(const row of [session,source,parent])await detached(row);
    },
    authorizeOperation: async (request, session) => {
      if (request.operation === 'tool.execute') {
        const provenance = request.input?.provenance;
        if (!provenance || origins.get(provenance.id) !== stable(provenance)) throw fail('native_registration_origin_denied');
        if (provenance.kind === 'plugin' && !(provenance.id === 'devryan.managed-task' && request.input.toolID === 'devryan_task'
          || provenance.id === 'devryan.council' && request.input.toolID === 'council_session'
          || provenance.id === 'devryan.harness-context' && ['todoread', 'todowrite'].includes(request.input.toolID)
          || provenance.id === 'devryan.browser' && request.input.toolID === 'devryan_browser'
          || provenance.id === 'devryan.document-reader' && request.input.toolID === 'devryan_document'
          || provenance.id === 'opencode-gpt-imagegen' && request.input.toolID === 'gpt_imagegen'
          || provenance.id === 'devryan.slim' && ['ast_grep_search', 'ast_grep_replace','webfetch'].includes(request.input.toolID))) {
          throw fail('native_tool_capability_unavailable');
        }
      } else if (request.operation === 'primary.step') {
        if (request.parentAuthorization?.operation !== 'runner.drain') throw fail('native_primary_origin_required');
      } else if (!DETACHED.has(request.operation)) {
        throw fail('native_owned_operation_required');
      }
      await detached(session);
    },
  };
}
