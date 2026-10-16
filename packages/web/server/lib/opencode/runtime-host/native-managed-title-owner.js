import { isCanonicalManagedTitleMetadata } from '../v2/managed-title-metadata.js';
import { createHash } from 'node:crypto';
const fail = () => Object.assign(Error('native_managed_title_source_invalid'), { code: 'native_managed_title_source_invalid', statusCode: 403 });
const hash = text => createHash('sha256').update(text).digest('hex');
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,160}$/.test(value);
// Stream activity updates this timestamp without changing source authority.
// Every other session field, including archival, permissions and selection,
// retains its original comparison.
const sessionIdentity = value => {
  if (!value || typeof value !== 'object') return stable(value);
  const { updated: _volatile, ...time } = value.time ?? {};
  return stable({ ...value, ...(value.time ? { time } : {}) });
};

/** Canonical metadata is a candidate binding. Durable assignment/control and
 * live constructor readers must independently agree before it grants a title. */
export function createNativeManagedTitleOwner(options) {
  const readScope = async (sessionID, directory) => {
    const configuration = options.readConfiguration();
    if (!id(configuration.controllerInstanceID) || !/^[a-f0-9]{64}$/.test(configuration.configurationDigest ?? '')) throw fail();
    const child = await options.readSession(sessionID, directory);
    if (!child?.parentID || child.id !== sessionID || directory && child.directory !== directory) throw fail();
    const assignment = await options.readAssignment({ childSessionId: sessionID, directory: child.directory });
    if (child.parentID !== assignment.parentSessionId || child.agent !== assignment.agent
      || child.model?.providerID !== assignment.providerId || child.model?.id !== assignment.modelId
      || (child.model?.variant ?? 'default') !== assignment.variant) throw fail();
    const root = await options.readSession(assignment.rootSessionId, assignment.directory);
    if (!root || root.parentID || root.directory !== assignment.directory) throw fail();
    const primary = await options.readPrimary(assignment.rootSessionId);
    const scope = { directory: assignment.directory, sessionID: assignment.rootSessionId, callID: assignment.dispatchCallId };
    const state = await options.readState(scope), captured = await options.readCaptured(scope), lease = await options.readLease(scope);
    if (!primary || primary.directory !== assignment.directory || !id(primary.anchorID)
      || !id(primary.objectiveID ?? primary.anchorID) || !Number.isSafeInteger(primary.cancellationGeneration)
      || ['cancelled', 'superseded', 'stopping', 'reconciling'].includes(primary.state)
      || state.held || state.reverting || !captured.captured || captured.pending || !Number.isSafeInteger(captured.generation)
      || !lease || lease.executionKind !== 'control' || lease.preparation !== 'none'
      || !['ready', 'published'].includes(lease.state) || lease.generation !== captured.generation
      || lease.scope.sessionID !== assignment.rootSessionId || lease.scope.callID !== assignment.dispatchCallId
      || lease.scope.messageID !== assignment.dispatchGroupId) throw fail();
    if (stable(options.readConfiguration()) !== stable(configuration)) throw fail();
    return { v: 1, ...assignment, anchorID: primary.anchorID, objectiveID: primary.objectiveID ?? primary.anchorID,
      cancellationGeneration: primary.cancellationGeneration, generation: captured.generation,
      admissionRevision: state.revision, ...configuration };
  };
  const current = async (sessionID, directory) => {
    const original = await readScope(sessionID, directory);
    const child = await options.readSession(sessionID, original.directory);
    const authorize = await options.captureAuthorization(child); await authorize();
    const root = await options.readSession(original.rootSessionId, original.directory);
    const authorizeRoot = await options.captureAuthorization(root); await authorizeRoot();
    const latest = await readScope(sessionID, original.directory);
    if (stable(latest) !== stable(original)) throw fail();
    return latest;
  };
  const humanScope = async (sessionID, directory) => {
    const configuration = options.readConfiguration(), child = await options.readSession(sessionID, directory);
    if (!child || child.id !== sessionID || directory && child.directory !== directory) throw fail();
    const seen = new Set(); let root = child;
    while (root?.parentID) {
      if (seen.size >= 256 || seen.has(root.id)) throw fail();
      seen.add(root.id); root = await options.readSession(root.parentID, child.directory);
    }
    if (!root) throw fail();
    if (root.directory !== child.directory) throw fail();
    for (const session of [child, root]) { const authorize = await options.captureAuthorization(session); await authorize(); }
    if (sessionIdentity(await options.readSession(sessionID, child.directory)) !== sessionIdentity(child)
      || sessionIdentity(await options.readSession(root.id, root.directory)) !== sessionIdentity(root)) throw fail();
    const childState = await options.readState({ sessionID, directory: child.directory });
    const rootState = await options.readState({ sessionID: root.id, directory: root.directory });
    const captured = await options.readCaptured({ sessionID: root.id, directory: root.directory });
    const primary = await options.readPrimary(root.id);
    if (childState.held || childState.reverting || rootState.held || rootState.reverting || captured.pending
      || ['cancelled', 'superseded', 'stopping', 'reconciling'].includes(primary?.state)
      || stable(options.readConfiguration()) !== stable(configuration)) throw fail();
    return { ...configuration, sessionID, directory: child.directory, rootSessionID: root.id,
      model: child.model, agent: child.agent, childRevision: childState.revision, rootRevision: rootState.revision,
      generation: captured.generation ?? 0, anchorID: primary?.anchorID ?? null,
      objectiveID: primary?.objectiveID ?? primary?.anchorID ?? null, cancellationGeneration: primary?.cancellationGeneration ?? 0 };
  };
  return {
    seal: async ({ sessionID, directory, messageID, fingerprint, text, dispatch }) => {
      if (!id(messageID) || typeof text !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint ?? '')) throw fail();
      const binding = await current(sessionID, directory);
      if (dispatch.taskId !== binding.taskId || dispatch.sessionID !== sessionID) throw fail();
      const sealed = { ...binding, sourceMessageID: messageID, fingerprint, textSha256: hash(text) };
      if (!isCanonicalManagedTitleMetadata(sealed)) throw fail();
      return sealed;
    },
    capture: async ({ sessionID, directory, messageID }) => {
      if (!id(sessionID) || messageID !== undefined && !id(messageID)) throw fail();
      const binding = await current(sessionID, directory);
      const records = await options.readUsers({ sessionID, directory: binding.directory });
      const first = records.find(row => row.info.role === 'user');
      if (!first || messageID && first.info.id !== messageID) throw fail();
      const source = await options.readUser({ sessionID, directory: binding.directory, messageID: first.info.id });
      const candidate = source?.metadata?.devryan?.managedTitle;
      const expected = { ...binding, sourceMessageID: first.info.id,
        fingerprint: source?.metadata?.devryan?.admission?.fingerprint, textSha256: hash(source?.text ?? '') };
      if (source?.id !== first.info.id || source.sessionID !== sessionID || source.type !== 'user'
        || source.metadata?.devryan?.v !== 1 || !/^[a-f0-9]{64}$/.test(expected.fingerprint ?? '')
        || !isCanonicalManagedTitleMetadata(candidate) || stable(candidate) !== stable(expected)) throw fail();
      const recheck = async () => {
        if (stable(await current(sessionID, binding.directory)) !== stable(binding)) throw fail();
        const latest = await options.readUser({ sessionID, directory: binding.directory, messageID: first.info.id });
        if (stable(latest?.metadata?.devryan?.managedTitle) !== stable(expected)
          || hash(latest?.text ?? '') !== expected.textSha256) throw fail();
        const users = (await options.readUsers({ sessionID, directory: binding.directory })).filter(row => row.info.role === 'user');
        if (users.length !== 1 || users[0]?.info.id !== first.info.id) throw fail();
        if (stable(await current(sessionID, binding.directory)) !== stable(binding)) throw fail();
      };
      await recheck();
      return Object.freeze({ sessionID, directory: binding.directory, sourceMessageID: first.info.id, recheck });
    },
    captureHuman: async ({ sessionID, directory, messageID }) => {
      if (!id(sessionID) || !id(messageID)) throw fail();
      const scope = await humanScope(sessionID, directory);
      const source = await options.readUser({ sessionID, directory: scope.directory, messageID });
      if (source?.id !== messageID || source.sessionID !== sessionID || source.type !== 'user'
        || source.metadata?.devryan?.v !== 1 || source.metadata.devryan.origin !== 'human'
        || source.metadata.devryan.command || source.metadata.devryan.admission?.v !== 1
        || !/^[a-f0-9]{64}$/.test(source.metadata.devryan.admission.fingerprint ?? '')) throw fail();
      const identity = stable(source);
      const originalUsers = (await options.readUsers({sessionID,directory:scope.directory})).filter(row=>row.info.role==='user');
      const original = originalUsers.at(-1);
      if(original?.info.id!==messageID||!Array.isArray(original.parts))throw fail();
      const sourceParts = stable(original.parts);
      const readSource = async () => {
        const users = (await options.readUsers({ sessionID, directory: scope.directory })).filter(row => row.info.role === 'user');
        if (users.at(-1)?.info.id !== messageID || stable(users.at(-1)?.parts)!==sourceParts
          || stable(await options.readUser({ sessionID, directory: scope.directory, messageID })) !== identity) throw fail();
      };
      const recheck = async () => {
        await readSource();
        if (stable(await humanScope(sessionID, scope.directory)) !== stable(scope)) throw fail();
        await readSource();
      };
      await recheck();
      return Object.freeze({ sessionID, directory: scope.directory, sourceMessageID: messageID, text: source.text, recheck });
    },
  };
}
