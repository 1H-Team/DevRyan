// These declarations describe coverage. Child prose is never a check receipt.
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;

export const validateRequiredChecks = (value = []) => {
  if (!Array.isArray(value) || value.length > 8) throw new TypeError('requiredChecks must contain at most eight checks');
  const names = new Set();
  for (const check of value) {
    if (!isRecord(check) || !text(check.name, 128) || names.has(check.name)
      || !text(check.command, 2048) || !Array.isArray(check.paths) || check.paths.length < 1 || check.paths.length > 32
      || check.paths.some((entry) => !text(entry, 512) || entry.includes('\0') || /^(?:[\\/]|[a-zA-Z]:)/.test(entry) || entry.split(/[\\/]/).includes('..'))
      || new Set(check.paths).size !== check.paths.length) throw new TypeError('Each required check needs a unique name, exact command, and bounded project-relative file paths');
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
      || !(text(receipt.messageId, 256) || (receipt.messageId === null && receipt.status === 'not-observed'
        && receipt.exitCode === null && receipt.contentHash === null))
      || !(receipt.identityConflict === undefined || receipt.identityConflict === true)
      || (receipt.identityConflict === true && receipt.messageId !== null)
      || !(receipt.exitCode === null || Number.isSafeInteger(receipt.exitCode))
      || !Number.isFinite(receipt.observedAt) || receipt.observedAt < 0
      || !['passed', 'failed', 'not-observed'].includes(receipt.status)
      || !(receipt.contentHash === null || hash(receipt.contentHash))
      || (receipt.status === 'passed' && (receipt.exitCode !== 0 || !hash(receipt.contentHash)))) {
      throw new TypeError('Invalid required check receipt');
    }
    seen.add(receipt.name);
  }
  return receipts;
};

export const projectRequiredCheckEvidence = (checks = [], receipts = [], identities = {}) => {
  validateRequiredCheckReceipts(receipts, checks);
  return checks.map((check) => {
    const receipt = receipts.find((entry) => entry.name === check.name);
    const currentHash = identities[check.name] ?? null;
    const matches = hash(currentHash) && currentHash === receipt?.contentHash;
    const status = receipt?.status === 'passed' && matches ? 'passed'
      : receipt?.status === 'failed' ? 'failed' : 'not-observed';
    return { name: check.name, status, coverage: { kind: 'declared-files', paths: [...check.paths], contentHash: currentHash },
      reason: status === 'passed' ? 'observed_exit_zero_for_current_content'
        : status === 'failed' ? 'observed_nonzero_exit'
          : receipt?.identityConflict ? 'canonical_check_identity_conflict'
            : !receipt ? 'check_not_observed' : !currentHash ? 'content_identity_unavailable' : 'content_changed_or_check_incomplete',
      evidence: receipt ? { callId: receipt.callId, messageId: receipt.messageId, exitCode: receipt.exitCode,
        observedAt: receipt.observedAt, checkedContentHash: receipt.contentHash } : null };
  });
};
