const fail = code => Object.assign(new Error(code), { code, status: 403, statusCode: 403 });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fields = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));

/** Only the supervised browser worker can reach the existing desktop lease owner through its exact live tool call. */
export function createNativeBrowserOwner({ admissionOwner, openCodeClient, origin, getLeaseRuntime }) {
  const expected = structuredClone(origin);
  if (expected?.kind !== 'plugin' || expected.id !== 'devryan.browser') throw fail('native_browser_origin_required');
  return async (invocation, event, context = {}) => {
    const provenance = invocation?.authorization?.input?.provenance;
    if (invocation?.tool !== 'devryan_browser' || provenance?.kind !== expected.kind || provenance.id !== expected.id
      || provenance.manifestDigest !== expected.manifestDigest || !equal(provenance.capabilities, expected.capabilities)) {
      throw fail('native_browser_origin_required');
    }
    if (!fields(event, ['type', 'id', 'operation', 'scope', 'leaseID']) || event.type !== 'browser'
      || typeof event.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.id)
      || !['assert-current', 'resolve', 'acquire', 'touch', 'release'].includes(event.operation)
      || !fields(event.scope, ['opencodeSessionID', 'messageID', 'directory', 'agent'])
      || (['touch', 'release'].includes(event.operation)
        ? typeof event.leaseID !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.leaseID)
        : event.leaseID !== undefined)) throw fail('native_browser_operation_invalid');
    const check = async () => {
      context.signal?.throwIfAborted();
      await admissionOwner.recheckExecution(invocation);
      const [session, message] = await Promise.all([
        openCodeClient.sessions.get(invocation.sessionID, { directory: invocation.directory }),
        openCodeClient.sessions.message(invocation.sessionID, invocation.messageID, { directory: invocation.directory }),
      ]);
      if (session?.id !== invocation.sessionID || session.directory !== invocation.directory || session.time?.archived || session.revert
        || message?.info?.id !== invocation.messageID || message.info.sessionID !== invocation.sessionID
        || message.info.role !== 'assistant' || message.info.time?.completed || message.info.agent !== invocation.agent
        || message.turnOwnership?.source !== 'native-sequence' || message.turnOwnership.userMessageID !== message.info.parentID
        || !message.parts?.some(part => part.type === 'tool' && part.tool === 'devryan_browser'
          && part.callID === invocation.callID && part.state?.status === 'running')) throw fail('native_browser_call_stale');
      const user = await openCodeClient.sessions.message(invocation.sessionID, message.info.parentID, { directory: invocation.directory });
      if (user?.info?.id !== message.info.parentID || user.info.sessionID !== invocation.sessionID || user.info.role !== 'user'
        || event.scope.opencodeSessionID !== invocation.sessionID || event.scope.messageID !== message.info.parentID
        || event.scope.directory !== invocation.directory || event.scope.agent !== (invocation.agent?.trim() || null)) {
        throw fail('native_browser_scope_mismatch');
      }
      await admissionOwner.recheckExecution(invocation);
      context.signal?.throwIfAborted();
    };
    await check();
    if (event.operation === 'assert-current') return { current: true };
    const runtime = getLeaseRuntime?.();
    if (!runtime || ['resolvePreview', 'acquire', 'touch', 'release'].some(method => typeof runtime[method] !== 'function')) {
      throw fail('native_browser_host_unavailable');
    }
    const scope = structuredClone(event.scope);
    const result = event.operation === 'resolve' ? await runtime.resolvePreview(scope)
      : event.operation === 'acquire' ? await runtime.acquire(scope)
      : event.operation === 'touch' ? await runtime.touch(event.leaseID, scope) : await runtime.release(event.leaseID, scope);
    try { await check(); }
    catch (cause) {
      // The grant can expire while Electron creates the surface. Retire exactly that newly acquired lease.
      if (event.operation === 'acquire' && typeof result?.leaseId === 'string') {
        try { await runtime.release(result.leaseId, scope); }
        catch (cleanup) { throw new AggregateError([cause, cleanup], 'native_browser_revoked_lease_cleanup_failed'); }
      }
      throw cause;
    }
    return result;
  };
}
