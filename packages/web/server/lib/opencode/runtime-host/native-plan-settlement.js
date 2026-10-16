const fail = () => Object.assign(new Error('plan_source_unsettled'), { code: 'plan_source_unsettled', statusCode: 409 });
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);

/** Physical completion stamps cannot release mandatory process/child barriers.
 * The composing native owner supplies the current controller/configuration pin. */
export function createNativePlanSettlementVerifier({ readControllerPin, readStatus, readManagedState, readManagedBarrier, activeLeases, readPrimaryRecord }) {
  return async ({ sessionID, directory, sourceIdentity, providerID }) => {
    const pin = readControllerPin();
    const primary = await readPrimaryRecord(sessionID);
    const checkPrimary = value => {
      if (value?.sessionID !== sessionID || value.directory !== directory || value.anchorID !== sourceIdentity?.rootUserMessageID
        || !Number.isSafeInteger(value.cancellationGeneration) || value.cancellationGeneration < 0
        || value.recoveryID || ['stopping', 'reconciling', 'recovery_reserved', 'recovering', 'superseded', 'cancelled', 'needs_attention'].includes(value.state)
        || providerID !== 'cursor-acp' && value.stepID !== sourceIdentity.currentSourceMessageID) throw fail();
    };
    checkPrimary(primary);
    if (!identifier(sessionID) || typeof pin?.instanceID !== 'string' || !pin.instanceID
      || !/^[a-f0-9]{64}$/.test(pin.configurationDigest ?? '')) throw fail();
    const [statuses, managed, barrier] = await Promise.all([readStatus({ sessionID, directory }),
      readManagedState({ sessionID, directory }), readManagedBarrier({ sessionID, directory })]);
    if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses) || !Array.isArray(managed?.tasks)
      || !Array.isArray(managed?.envelopes) || barrier?.state !== 'clear') throw fail();
    const children = managed.tasks.map(task => task.childSessionId).filter(id => id !== null && id !== undefined);
    if (!children.every(identifier) || managed.tasks.some(task => !['completed', 'failed', 'aborted', 'interrupted'].includes(task.status))) throw fail();
    const sessions = [...new Set([sessionID, ...children])];
    // Native status maps omit idle sessions. Only known idle/absent statuses
    // may settle after the independently checked process and task barriers.
    if (sessions.some(id => statuses[id] && statuses[id].type !== 'idle')) throw fail();
    const leases = await activeLeases({ directory, sessions });
    if (!Array.isArray(leases) || leases.length) throw fail();
    const currentPrimary = await readPrimaryRecord(sessionID); checkPrimary(currentPrimary);
    if (currentPrimary.anchorID !== primary.anchorID || currentPrimary.objectiveID !== primary.objectiveID
      || currentPrimary.cancellationGeneration !== primary.cancellationGeneration) throw fail();
    const current = readControllerPin();
    if (current.instanceID !== pin.instanceID || current.configurationDigest !== pin.configurationDigest) throw fail();
  };
}
