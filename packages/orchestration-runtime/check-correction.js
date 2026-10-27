import { validateRequiredChecks, validateRequiredCheckReceipts } from './required-checks.js';

const fail = code => Object.assign(new TypeError(code), { code });
export const REQUIRED_CHECK_CORRECTION = Symbol('required-check-correction');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};

/** Deliberately bounded: no shell grammar, alternative commands or renamed selectors. */
export function parseVitestEdgeCommand(command) {
  if (typeof command !== 'string') return null;
  const match = /^npx vitest run (supabase\/functions\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\/__tests__)(?: --maxWorkers=[1-9]\d{0,2})?$/.exec(command);
  return match ? { functionName: match[2], testPath: match[1], functionPath: `supabase/functions/${match[2]}` } : null;
}

export function correctedEdgeCommand(functionName) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(functionName ?? '')) throw fail('required_check_correction_invalid');
  return `npm run test:edge -- --function ${functionName}`;
}

export function validateCheckCorrection(correction, check) {
  validateRequiredChecks([check]);
  const source = parseVitestEdgeCommand(check.command), identity = correction?.runnerIdentity;
  if (!object(correction) || Object.keys(correction).some(key => !['name', 'previousCommand', 'command', 'reason', 'observedAt', 'previousReceipt', 'runnerIdentity'].includes(key))
    || !source || check.kind === 'visual' || correction.name !== check.name || correction.previousCommand !== check.command
    || correction.command !== correctedEdgeCommand(source.functionName) || correction.reason !== 'repository_edge_deno_runner'
    || !Number.isFinite(correction.observedAt) || correction.observedAt < 0
    || !object(identity) || Object.keys(identity).sort().join() !== ['kind', 'packagePath', 'packageSha256', 'scriptPath', 'scriptSha256', 'functionName', 'selector', 'testPath', 'coverageHash', 'verifiedBy'].sort().join()
    || identity.kind !== 'edge-deno-function-v1' || identity.packagePath !== 'package.json'
    || identity.scriptPath !== 'scripts/testing/run-deno-tests.mjs' || identity.selector !== '--function'
    || identity.functionName !== source.functionName || identity.testPath !== source.testPath || identity.verifiedBy !== 'host-policy'
    || !hash(identity.packageSha256) || !hash(identity.scriptSha256) || !hash(identity.coverageHash)
    || check.paths.some(path => path !== source.functionPath && !path.startsWith(`${source.functionPath}/`))) {
    throw fail('required_check_correction_invalid');
  }
  if (correction.previousReceipt !== undefined) validateRequiredCheckReceipts([correction.previousReceipt], [check]);
  return freeze(structuredClone(correction));
}

export function validateCheckCorrectionHistory(history = []) {
  if (!Array.isArray(history) || history.length > 128 || new TextEncoder().encode(JSON.stringify(history)).length > 256 * 1024) throw fail('required_check_correction_history_limit');
  for (const entry of history) {
    if (!object(entry)) throw fail('required_check_correction_invalid');
    const { previousCheck, ...correction } = entry;
    validateCheckCorrection(correction, previousCheck);
  }
  return freeze(structuredClone(history));
}

/** Caller persists this result atomically with its existing scheduler CAS.
 * No successful receipt is manufactured; the corrected command must run again. */
export function applyCheckCorrection({ checks = [], receipts = [], history = [] }, correction) {
  validateRequiredCheckReceipts(receipts, checks);
  validateCheckCorrectionHistory(history);
  if (history.length >= 128) throw fail('required_check_correction_history_limit');
  const previousCheck = checks.find(check => check.name === correction?.name);
  if (!previousCheck || previousCheck.command !== correction.previousCommand) throw fail('required_check_correction_stale');
  const previousReceipt = receipts.find(receipt => receipt.name === previousCheck.name);
  if (JSON.stringify(correction.previousReceipt ?? null) !== JSON.stringify(previousReceipt ?? null)) throw fail('required_check_correction_stale');
  const validated = validateCheckCorrection(correction, previousCheck);
  const nextChecks = checks.map(check => check.name === previousCheck.name ? { ...structuredClone(check), command: validated.command } : structuredClone(check));
  const nextHistory = [...structuredClone(history), { ...structuredClone(validated), previousCheck: structuredClone(previousCheck) }];
  validateCheckCorrectionHistory(nextHistory);
  return freeze({ checks: nextChecks, receipts: receipts.filter(receipt => receipt.name !== previousCheck.name).map(receipt => structuredClone(receipt)), history: nextHistory });
}

export function isCheckCorrectionTransition(previous, next) {
  const prior = previous.requiredCheckCorrections ?? [], history = next.requiredCheckCorrections ?? [];
  if (history.length !== prior.length + 1 || JSON.stringify(history.slice(0, -1)) !== JSON.stringify(prior)) return false;
  try {
    const { previousCheck, ...correction } = history.at(-1);
    if (JSON.stringify(previousCheck) !== JSON.stringify(previous.requiredChecks?.find(check => check.name === correction.name))) return false;
    const applied = applyCheckCorrection({ checks: previous.requiredChecks, receipts: previous.requiredCheckReceipts, history: prior }, correction);
    return JSON.stringify(applied.checks) === JSON.stringify(next.requiredChecks)
      && JSON.stringify(applied.receipts) === JSON.stringify(next.requiredCheckReceipts)
      && JSON.stringify(applied.history) === JSON.stringify(history);
  } catch { return false; }
}
