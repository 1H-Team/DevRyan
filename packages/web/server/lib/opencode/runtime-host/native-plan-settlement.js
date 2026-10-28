// Why a plan source is not settled, a closed set the client acts on: a
// transient reason is waited out and retried, a terminal one is final.
export const PLAN_SETTLEMENT_TRANSIENT_REASONS = Object.freeze(['barrier_pending', 'tasks_active', 'sessions_busy', 'leases_active', 'primary_busy']);
export const PLAN_SETTLEMENT_TERMINAL_REASONS = Object.freeze(['source_changed', 'superseded', 'cancelled', 'needs_attention', 'pin_changed', 'invalid_state']);
const fail = (reason) => Object.assign(new Error('plan_source_unsettled'), { code: 'plan_source_unsettled', statusCode: 409, reason });
const PRIMARY_BUSY_STATES = new Set(['stopping', 'reconciling', 'recovery_reserved', 'recovering']);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);

/** Physical completion stamps cannot release mandatory process/child barriers.
 * The composing native owner supplies the current controller/configuration pin. */
export function createNativePlanSettlementVerifier({ readControllerPin, readStatus, readManagedState, readManagedBarrier, activeLeases, readPrimaryRecord }) {
  return async ({ sessionID, directory, sourceIdentity, providerID }) => {
    const pin = readControllerPin();
    const primary = await readPrimaryRecord(sessionID);
    const checkPrimary = value => {
      if (value?.sessionID !== sessionID || value.directory !== directory
        || !Number.isSafeInteger(value.cancellationGeneration) || value.cancellationGeneration < 0) throw fail('invalid_state');
      if (['superseded', 'cancelled', 'needs_attention'].includes(value.state)) throw fail(value.state);
      if (value.recoveryID || PRIMARY_BUSY_STATES.has(value.state)) throw fail('primary_busy');
      if (value.anchorID !== sourceIdentity?.rootUserMessageID
        || providerID !== 'cursor-acp' && value.stepID !== sourceIdentity.currentSourceMessageID) throw fail('source_changed');
    };
    checkPrimary(primary);
    if (!identifier(sessionID) || typeof pin?.instanceID !== 'string' || !pin.instanceID
      || !/^[a-f0-9]{64}$/.test(pin.configurationDigest ?? '')) throw fail('invalid_state');
    const [statuses, managed, barrier] = await Promise.all([readStatus({ sessionID, directory }),
      readManagedState({ sessionID, directory }), readManagedBarrier({ sessionID, directory })]);
    if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses) || !Array.isArray(managed?.tasks)
      || !Array.isArray(managed?.envelopes)) throw fail('invalid_state');
    if (barrier?.state !== 'clear') throw fail('barrier_pending');
    const children = managed.tasks.map(task => task.childSessionId).filter(id => id !== null && id !== undefined);
    if (!children.every(identifier)) throw fail('invalid_state');
    if (managed.tasks.some(task => !['completed', 'failed', 'aborted', 'interrupted'].includes(task.status))) throw fail('tasks_active');
    const sessions = [...new Set([sessionID, ...children])];
    // Native status maps omit idle sessions. Only known idle/absent statuses
    // may settle after the independently checked process and task barriers.
    if (sessions.some(id => statuses[id] && statuses[id].type !== 'idle')) throw fail('sessions_busy');
    const leases = await activeLeases({ directory, sessions });
    if (!Array.isArray(leases)) throw fail('invalid_state');
    if (leases.length) throw fail('leases_active');
    const currentPrimary = await readPrimaryRecord(sessionID); checkPrimary(currentPrimary);
    if (currentPrimary.anchorID !== primary.anchorID || currentPrimary.objectiveID !== primary.objectiveID
      || currentPrimary.cancellationGeneration !== primary.cancellationGeneration) throw fail('source_changed');
    const current = readControllerPin();
    if (current.instanceID !== pin.instanceID || current.configurationDigest !== pin.configurationDigest) throw fail('pin_changed');
  };
}
