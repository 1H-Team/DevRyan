const hashPattern = /^[a-f0-9]{64}$/;
const rejectionReasons = new Set(['tool_input_invalid', 'binary_read_blocked']);
const progressKinds = new Set(['tool-evidence', 'child-completed', 'artifact-changed', 'required-check']);

export const validateBuilderTodoGuard = value => {
  if (value === undefined) return;
  if (!value || !['taskSetHash', 'progressHash'].every(key => typeof value[key] === 'string' && hashPattern.test(value[key]))
    || !Number.isInteger(value.stagnantCount) || value.stagnantCount < 0 || value.stagnantCount > 2
    || !value.progressCounts || typeof value.progressCounts !== 'object' || Array.isArray(value.progressCounts)
    || Object.entries(value.progressCounts).some(([kind, count]) => !progressKinds.has(kind) || !Number.isSafeInteger(count) || count < 0)) {
    throw new TypeError('Invalid Builder TODO continuation guard');
  }
};

export const validateObjectiveRejections = (value = []) => {
  if (!Array.isArray(value) || value.length > 32 || value.some((entry) => !entry || !hashPattern.test(entry.fingerprint)
    || !rejectionReasons.has(entry.reason) || !Number.isInteger(entry.count) || entry.count < 1 || entry.count > 3
    || !Array.isArray(entry.callIDs) || entry.callIDs.length > 8 || entry.callIDs.some((id) => typeof id !== 'string' || !id || id.length > 256)
    || !Number.isFinite(entry.lastObservedAt))) throw new TypeError('Invalid objective rejection receipts');
  return value;
};

export const applyObjectiveRejection = (previous = [], input) => {
  validateObjectiveRejections(previous);
  if (!hashPattern.test(input?.fingerprint) || !rejectionReasons.has(input.reason)
    || typeof input.callID !== 'string' || !input.callID || input.callID.length > 256 || !Number.isFinite(input.at)) throw new TypeError('Invalid pre-execution rejection');
  const existing = previous.find((entry) => entry.fingerprint === input.fingerprint && entry.reason === input.reason);
  if (existing?.callIDs.includes(input.callID)) return { receipts: previous, state: existing.count >= 3 ? 'blocked' : 'duplicate', count: existing.count };
  // Never evict a known cycle merely because a new input was rejected. New,
  // untracked signatures at the bound remain report-only.
  if (!existing && previous.length >= 32) return { receipts: previous, state: 'tracking-capacity', count: null };
  const receipt = { fingerprint: input.fingerprint, reason: input.reason, count: Math.min(3, (existing?.count ?? 0) + 1),
    callIDs: [...(existing?.callIDs ?? []), input.callID].slice(-8), lastObservedAt: input.at };
  return { receipts: existing ? previous.map((entry) => entry === existing ? receipt : entry) : [...previous, receipt],
    state: receipt.count === 3 ? 'blocked' : receipt.count === 2 ? 'corrective-replan' : 'correct-input', count: receipt.count };
};

export const validateObjectiveProgress = (value) => {
  if (value === undefined) return;
  if (!value || !Number.isFinite(value.lastUsefulAt) || !Array.isArray(value.seen) || value.seen.length > 128
    || value.seen.some((key) => !hashPattern.test(key)) || !value.counts
    || Object.entries(value.counts).some(([kind, count]) => !progressKinds.has(kind) || !Number.isSafeInteger(count) || count < 0)) throw new TypeError('Invalid objective progress');
};

export const applyObjectiveProgress = (previous, { kind, fingerprint, at }) => {
  validateObjectiveProgress(previous);
  if (!progressKinds.has(kind) || !hashPattern.test(fingerprint) || !Number.isFinite(at)) throw new TypeError('Invalid authoritative progress observation');
  if (previous?.seen.includes(fingerprint)) return previous;
  return { lastUsefulAt: at, counts: { ...previous?.counts, [kind]: Math.min(Number.MAX_SAFE_INTEGER, (previous?.counts[kind] ?? 0) + 1) },
    seen: [...(previous?.seen ?? []), fingerprint].slice(-128) };
};

export const projectObjectiveProgress = (value) => ({ policy: 'report-only', lastUsefulAt: value?.lastUsefulAt ?? null,
  counts: value ? { ...value.counts } : {}, relevance: 'structural-evidence; semantic task progress requires outcome grading' });
