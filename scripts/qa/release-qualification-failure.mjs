// Release qualification failure classes. `infra` is the runner or network
// failing to provide inputs (downloads, artifact fetches, installs, a busy disk
// image) and is retried once; `product` is the candidate failing a check (boot
// over budget, migration or history mismatch, a renderer that never answers)
// and is never retried. An unknown failure is `product`: a retry must never
// hide a real defect. Logs and reports carry bounded error text, not only a code.

export const INFRA = 'infra';
export const PRODUCT = 'product';

const INFRA_COMMANDS = new Set(['gh', 'git', 'tar', 'ditto', 'bun', 'hdiutil']);
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const INFRA_TEXT = /resource busy|hdiutil: (?:attach|detach) failed|fetch failed|socket hang up|HTTP 50[234]|rate limit|Baseline installer digest mismatch/i;

/** Bounded report text: the run root becomes <run>, long opaque tokens are dropped, `limit` printable characters at most. */
export function boundedDiagnostic(value, runRoot, limit = 240) {
  let text = String(value ?? '');
  if (runRoot) text = text.replaceAll(runRoot, '<run>');
  return text.replace(/[A-Za-z0-9+/_=-]{32,}/g, '<redacted>').replace(/[^\x20-\x7e]/g, '?').slice(0, limit);
}

export function classifyQualificationFailure(error) {
  if ([INFRA, PRODUCT].includes(error?.qualificationClass)) return error.qualificationClass;
  const code = error?.code ?? error?.cause?.code;
  if (code === 'qa_release_upgrade_command') return INFRA_COMMANDS.has(error.command) ? INFRA : PRODUCT;
  if (NETWORK_CODES.has(code) || NETWORK_CODES.has(error?.cause?.code) || ['TimeoutError'].includes(error?.name)) return INFRA;
  return INFRA_TEXT.test(`${error?.message ?? ''}\n${error?.stderr ?? ''}`) ? INFRA : PRODUCT;
}

/** The message plus the failing command's stderr tail, bounded and redacted for logs and reports. */
export function describeQualificationError(error, { runRoot } = {}) {
  const command = error?.command ? ` [${error.command} exit ${error.exitCode ?? '?'}]` : '';
  const stderr = String(error?.stderr ?? '').trim().split('\n').slice(-6).join(' | ');
  return boundedDiagnostic(`${error?.message ?? error}${command}${stderr ? ` stderr: ${stderr}` : ''}`, runRoot, 600);
}

/**
 * Run `operation(attempt)`; an `infra` failure is logged with its text and
 * retried once, a `product` failure is logged and rethrown at once. The
 * rethrown error carries `qualificationClass`.
 */
export async function retryInfraOnce(label, operation, { log = console.log, runRoot } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      const kind = classifyQualificationFailure(error);
      log(`[qualification] ${label} attempt ${attempt} failed (${kind}): ${describeQualificationError(error, { runRoot })}`);
      if (kind !== INFRA || attempt >= 2) throw Object.assign(error instanceof Error ? error : new Error(String(error)), { qualificationClass: kind });
      log(`[qualification] retrying ${label} once after an infrastructure failure`);
    }
  }
}
