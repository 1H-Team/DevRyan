// These declarations describe coverage. Child prose is never a check receipt.
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const USER_CHECK_WAIVER = Symbol('user-check-waiver');
const relativePath = value => text(value, 512) && !value.includes('\0') && !/^(?:[\\/]|[a-zA-Z]:)/.test(value) && !value.split(/[\\/]/).includes('..');
const text = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;

export const validateRequiredChecks = (value = []) => {
  if (!Array.isArray(value) || value.length > 8) throw new TypeError('requiredChecks must contain at most eight checks');
  const names = new Set();
  for (const check of value) {
    if (!isRecord(check) || !text(check.name, 128) || names.has(check.name)
      || !text(check.command, 2048) || !Array.isArray(check.paths) || check.paths.length < 1 || check.paths.length > 32
      || check.paths.some((entry) => !text(entry, 512) || entry.includes('\0') || /^(?:[\\/]|[a-zA-Z]:)/.test(entry) || entry.split(/[\\/]/).includes('..'))
      || new Set(check.paths).size !== check.paths.length) throw new TypeError('Each required check needs a unique name, exact command, and bounded project-relative file paths');
    if (check.cwd !== undefined && !(check.cwd === '.' || relativePath(check.cwd)) ) throw new TypeError('Invalid required check working directory');
    if (check.environment !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(check.environment)) throw new TypeError('Invalid required check environment');
    if (check.purpose !== undefined && !['implementation', 'integration', 'deployment'].includes(check.purpose)
      || check.prerequisites !== undefined && (!Array.isArray(check.prerequisites) || check.prerequisites.length > 16
        || check.prerequisites.some(entry => !text(entry, 128)) || new Set(check.prerequisites).size !== check.prerequisites.length)) throw new TypeError('Invalid required check purpose or prerequisites');
    if (check.kind !== undefined && !['command', 'visual'].includes(check.kind)) throw new TypeError('Invalid required check kind');
    if (check.kind === 'visual' && (!isRecord(check.visual) || check.visual.state !== 'populated'
      || !['fixture', 'live'].includes(check.visual.dataSource) || !relativePath(check.visual.reportPath)
      || !Array.isArray(check.visual.assertions) || !check.visual.assertions.length || check.visual.assertions.length > 32
      || check.visual.assertions.some(entry => !text(entry, 256)) || new Set(check.visual.assertions).size !== check.visual.assertions.length)) {
      throw new TypeError('Visual checks need populated state, data source, assertions and a project-relative report');
    }
    if (check.kind !== 'visual' && check.visual !== undefined) throw new TypeError('Visual requirements need visual kind');
    names.add(check.name);
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 32 * 1024) throw new RangeError('requiredChecks exceeds 32 KiB');
  return value;
};

export const validateRequiredCheckReceipts = (receipts = [], checks = []) => {
  validateRequiredChecks(checks);
  if (!Array.isArray(receipts) || receipts.length > checks.length) throw new TypeError('Invalid required check receipts');
  const seen = new Set();
  for (const receipt of receipts) {
    const check = checks.find((entry) => entry.name === receipt?.name);
    if (!check || seen.has(receipt.name) || !text(receipt.callId, 256)
      || !(text(receipt.messageId, 256) || receipt.messageId === null && receipt.status === 'waived'
        || receipt.messageId === null && ['not-observed', 'pending'].includes(receipt.status) && receipt.exitCode === null && receipt.contentHash === null)
      || !(receipt.identityConflict === undefined || receipt.identityConflict === true)
      || (receipt.identityConflict === true && receipt.messageId !== null)
      || !(receipt.exitCode === null || Number.isSafeInteger(receipt.exitCode))
      || !Number.isFinite(receipt.observedAt) || receipt.observedAt < 0
      || !['passed', 'failed', 'not-observed', 'pending', 'blocked', 'skipped', 'waived'].includes(receipt.status)
      || !(receipt.contentHash === null || hash(receipt.contentHash))
      || (receipt.status === 'passed' && (receipt.exitCode !== 0 || !hash(receipt.contentHash)))) {
      throw new TypeError('Invalid required check receipt');
    }
    if (receipt.environmentUnavailable !== undefined && (receipt.status !== 'skipped' || !hash(receipt.contentHash) || receipt.exitCode === null || receipt.exitCode === 0
      || !isRecord(receipt.environmentUnavailable) || Object.keys(receipt.environmentUnavailable).some(key => !['reason', 'hint'].includes(key)) || !['docker_daemon_unavailable', 'docker_socket_denied', 'uid_mapping_unavailable'].includes(receipt.environmentUnavailable.reason)
      || !text(receipt.environmentUnavailable.hint, 512))) throw new TypeError('Invalid environment-unavailable receipt');
    if (receipt.status === 'skipped' && !receipt.environmentUnavailable) throw new TypeError('Skipped checks require canonical environment-unavailable evidence');
    if (receipt.status === 'waived' && (!isRecord(receipt.waiver) || receipt.waiver.source !== 'authenticated-user'
      || !text(receipt.waiver.userId, 256) || !text(receipt.waiver.reason, 2048) || !hash(receipt.contentHash))) throw new TypeError('Invalid user waiver receipt');
    if (receipt.status !== 'waived' && receipt.waiver !== undefined) throw new TypeError('Waiver cannot accompany another outcome');
    if (check.kind === 'visual' && receipt.status === 'passed' && !visualCheckPassed(check, receipt.visual)) throw new TypeError('Visual pass requires populated assertion and artifact evidence');
    seen.add(receipt.name);
  }
  return receipts;
};

const validVisualObservation = visual => isRecord(visual) && visual.state === 'populated'
  && ['fixture', 'live'].includes(visual.dataSource) && hash(visual.reportHash)
  && Array.isArray(visual.assertions) && visual.assertions.length <= 32
  && visual.assertions.every(entry => isRecord(entry) && text(entry.name, 256) && ['passed', 'failed'].includes(entry.status))
  && new Set(visual.assertions.map(entry => entry.name)).size === visual.assertions.length
  && Array.isArray(visual.evidence) && visual.evidence.length > 0 && visual.evidence.length <= 16
  && visual.evidence.every(entry => isRecord(entry) && relativePath(entry.path) && hash(entry.sha256))
  && (visual.servedFreshness === undefined || ['fresh', 'unknown', 'stale'].includes(visual.servedFreshness));

// A loopback server the check named must serve current files (servedFreshness).
export const visualCheckPassed = (check, visual) => validVisualObservation(visual)
  && (visual.servedFreshness === undefined || visual.servedFreshness === 'fresh')
  && visual.dataSource === check.visual?.dataSource && visual.assertions.length === check.visual.assertions.length
  && check.visual.assertions.every(name => visual.assertions.some(entry => entry.name === name && entry.status === 'passed'));

export const projectRequiredCheckEvidence = (checks = [], receipts = [], identities = {}, visualFreshness = {}) => {
  validateRequiredCheckReceipts(receipts, checks);
  return checks.map((check) => {
    const receipt = receipts.find((entry) => entry.name === check.name);
    const currentHash = identities[check.name] ?? null;
    const matches = hash(currentHash) && currentHash === receipt?.contentHash;
    const visualCurrent = check.kind !== 'visual' || visualFreshness[check.name] === true;
    const status = receipt?.status === 'skipped' && matches ? 'skipped' : receipt?.status === 'waived' && matches ? 'waived'
      : receipt?.status === 'passed' && matches && visualCurrent ? 'passed'
        : receipt?.status === 'failed' ? 'failed' : receipt?.status === 'blocked' ? 'blocked' : 'pending';
    return { name: check.name, kind: check.kind ?? 'command', status,
      ...(check.purpose ? { purpose: check.purpose } : {}), ...(check.prerequisites ? { prerequisites: [...check.prerequisites] } : {}),
      ...(check.kind === 'visual' ? { visual: { ...check.visual, observation: receipt?.visual ?? null } } : {}),
      ...(status === 'waived' ? { waiver: receipt.waiver } : {}),
      ...(status === 'skipped' && receipt?.environmentUnavailable ? { environmentUnavailable: { reason: receipt.environmentUnavailable.reason, hint: receipt.environmentUnavailable.hint } } : {}),
      execution: { command: check.command, cwd: check.cwd ?? '.', environment: check.environment ?? 'native' },
      coverage: { kind: 'declared-files', paths: [...check.paths], contentHash: currentHash },
      reason: status === 'skipped' ? 'environment_unavailable' : status === 'passed' ? 'observed_exit_zero_for_current_content'
        : status === 'waived' ? 'authenticated_user_waiver_for_current_content'
          : status === 'failed' ? 'observed_nonzero_exit'
            : status === 'blocked' ? 'required_evidence_unavailable'
              : receipt?.identityConflict ? 'canonical_check_identity_conflict'
                : !receipt ? 'check_not_observed' : !currentHash ? 'content_identity_unavailable' : 'content_changed_or_check_incomplete',
      evidence: receipt ? { callId: receipt.callId, messageId: receipt.messageId, exitCode: receipt.exitCode,
        observedAt: receipt.observedAt, checkedContentHash: receipt.contentHash } : null };
  });
};

export const projectRequiredCheckCompletion = (checks = []) => {
  const remaining = checks.filter(check => !['passed', 'waived', 'skipped'].includes(check.status)).map(({ name, status, reason }) => ({ name, status, reason }));
  return { ready: remaining.length === 0, status: remaining.some(check => check.status === 'failed') ? 'failed'
    : remaining.some(check => check.status === 'blocked') ? 'blocked' : remaining.length ? 'pending'
      : checks.some(check => check.status === 'skipped') ? 'skipped' : checks.some(check => check.status === 'waived') ? 'waived' : 'passed', remaining };
};

/** Only an equivalent retained requirement set in a retry may supersede its ancestor. */
export const selectRequiredCheckTasks = (tasks = [], objectiveId) => tasks.filter(task => (task.dispatchObjectiveId ?? task.dispatchGroupId ?? task.verification?.objectiveId) === objectiveId
  && task.requiredChecks?.length && !tasks.some(next => next.priorTaskId === task.taskId && next.rootSessionId === task.rootSessionId && next.directory === task.directory
    && (next.dispatchObjectiveId ?? next.dispatchGroupId ?? next.verification?.objectiveId) === objectiveId
    && JSON.stringify(next.requiredChecks) === JSON.stringify(task.requiredChecks)));

export const decodeRequiredCheckVerification = value => {
  if (!isRecord(value) || !(value.objectiveId === null || text(value.objectiveId, 256)) || !Number.isFinite(value.observedAt)
    || value.observedAt < 0 || !Array.isArray(value.checks) || value.checks.length > 8
    || JSON.stringify(value).length > 32 * 1024) return null;
  const statuses = ['pending', 'passed', 'failed', 'blocked', 'skipped', 'waived'], checks = [], names = new Set();
  for (const check of value.checks) {
    if (!isRecord(check) || !text(check.name, 128) || names.has(check.name) || !statuses.includes(check.status) || !text(check.reason, 256)
      || check.hint !== undefined && !text(check.hint, 512)
      || !['command', 'visual'].includes(check.kind ?? 'command') || !isRecord(check.coverage) || check.coverage.kind !== 'declared-files'
      || !Array.isArray(check.coverage.paths) || !check.coverage.paths.length || check.coverage.paths.length > 32
      || check.coverage.paths.some(entry => !relativePath(entry)) || new Set(check.coverage.paths).size !== check.coverage.paths.length
      || !(check.coverage.contentHash === null || hash(check.coverage.contentHash))) return null;
    try{validateRequiredChecks([{name:check.name,command:'projection',paths:check.coverage.paths,purpose:check.purpose,prerequisites:check.prerequisites}]);}catch{return null;}
    if (check.execution !== undefined && (!isRecord(check.execution) || !text(check.execution.command, 2048)
      || !(check.execution.cwd === '.' || relativePath(check.execution.cwd))
      || !(check.execution.environment === null || typeof check.execution.environment === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(check.execution.environment)))) return null;
    if (check.environmentUnavailable !== undefined && (check.status !== 'skipped' || check.reason !== 'environment_unavailable'
      || !isRecord(check.environmentUnavailable) || Object.keys(check.environmentUnavailable).some(key => !['reason', 'hint'].includes(key)) || !['docker_daemon_unavailable', 'docker_socket_denied', 'uid_mapping_unavailable'].includes(check.environmentUnavailable.reason)
      || !text(check.environmentUnavailable.hint, 512))) return null;
    names.add(check.name);
    const evidence = check.evidence;
    if (evidence !== null && (!isRecord(evidence) || !text(evidence.callId, 256)
      || !(evidence.messageId === null || text(evidence.messageId, 256))
      || !(evidence.exitCode === null || Number.isSafeInteger(evidence.exitCode))
      || !Number.isFinite(evidence.observedAt) || evidence.observedAt < 0
      || !(evidence.checkedContentHash === null || hash(evidence.checkedContentHash)))) return null;
    if (check.status === 'skipped' && !check.environmentUnavailable) return null;
    if (check.environmentUnavailable && (evidence?.exitCode === null || evidence?.exitCode === undefined || evidence.exitCode === 0)) return null;
    if (['passed', 'waived', 'skipped'].includes(check.status) && (!hash(check.coverage.contentHash)
      || evidence?.checkedContentHash !== check.coverage.contentHash)) return null;
    if (check.status === 'passed' && (evidence.exitCode !== 0 || !text(evidence.messageId, 256))) return null;
    if (check.status === 'waived' && (!isRecord(check.waiver) || check.waiver.source !== 'authenticated-user'
      || !text(check.waiver.reason, 2048) || !text(check.waiver.userId, 256))) return null;
    if (check.status !== 'waived' && check.waiver !== undefined) return null;
    let visual;
    if (check.kind === 'visual') {
      try { validateRequiredChecks([{ name: check.name, command: 'visual', paths: check.coverage.paths, kind: 'visual', visual: check.visual }]); } catch { return null; }
      if (check.visual.observation !== null && !validVisualObservation(check.visual.observation)) return null;
      if (check.status === 'passed' && !visualCheckPassed({ visual: check.visual }, check.visual.observation)) return null;
      const observed = check.visual.observation;
      visual = { state: 'populated', dataSource: check.visual.dataSource, assertions: [...check.visual.assertions], reportPath: check.visual.reportPath,
        observation: observed === null ? null : { state: 'populated', dataSource: observed.dataSource, reportHash: observed.reportHash,
          assertions: observed.assertions.map(({ name, status }) => ({ name, status })), evidence: observed.evidence.map(({ path, sha256 }) => ({ path, sha256 })) } };
    } else if (check.visual !== undefined) return null;
    checks.push({ name: check.name, kind: check.kind ?? 'command', status: check.status, reason: check.reason, ...(check.hint ? { hint: check.hint } : {}),
      ...(check.execution ? { execution: { command: check.execution.command, cwd: check.execution.cwd, environment: check.execution.environment } } : {}),
      ...(check.environmentUnavailable ? { environmentUnavailable: { reason: check.environmentUnavailable.reason, hint: check.environmentUnavailable.hint } } : {}),
      ...(check.purpose?{purpose:check.purpose}:{}),...(check.prerequisites?{prerequisites:[...check.prerequisites]}:{}),
      coverage: { kind: 'declared-files', paths: [...check.coverage.paths], contentHash: check.coverage.contentHash },
      evidence: evidence === null ? null : { callId: evidence.callId, messageId: evidence.messageId, exitCode: evidence.exitCode,
        observedAt: evidence.observedAt, checkedContentHash: evidence.checkedContentHash },
      ...(visual ? { visual } : {}), ...(check.status === 'waived' ? { waiver: { source: 'authenticated-user', userId: check.waiver.userId, reason: check.waiver.reason } } : {}) });
  }
  const completion = projectRequiredCheckCompletion(checks);
  if (value.ready !== completion.ready || value.status !== completion.status) return null;
  return { ...completion, objectiveId: value.objectiveId, observedAt: value.observedAt, checks };
};
