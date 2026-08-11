export const DIAGNOSTIC_IMPACTS = Object.freeze(['low', 'medium', 'high', 'critical']);
export const DIAGNOSTIC_SOURCES = Object.freeze(['observed', 'inferred']);
export const DIAGNOSTIC_OUTCOMES = Object.freeze(['recovered', 'unresolved', 'unknown']);
export const FAILURE_CLASSES = Object.freeze([
  'filesystem_target',
  'input',
  'patch_context',
  'tool_runtime',
  'integration_runtime',
  'session_runtime',
  'managed_task',
  'platform_security',
  'platform_integrity',
  'unknown',
]);

const DIAGNOSTIC_IMPACT_SET = new Set(DIAGNOSTIC_IMPACTS);
const DIAGNOSTIC_SOURCE_SET = new Set(DIAGNOSTIC_SOURCES);
const DIAGNOSTIC_OUTCOME_SET = new Set(DIAGNOSTIC_OUTCOMES);
const FAILURE_CLASS_SET = new Set(FAILURE_CLASSES);

const LEGACY_LOW_TOOL_NAMES = new Set([
  'apply_patch',
  'bash',
  'file_read',
  'glob',
  'grep',
  'oc_read',
  'read',
  'rg',
  'search',
  'shell',
  'skill',
  'stat',
]);

const PATCH_CONTEXT_PATTERNS = [
  /apply_patch verification failed/i,
  /failed to find expected lines/i,
  /patch context (?:did not match|mismatch)/i,
];

const FILESYSTEM_TARGET_PATTERNS = [
  /\bENOENT\b/i,
  /\bENOTDIR\b/i,
  /no such file or directory/i,
  /path does not exist/i,
];

const INPUT_PATTERNS = [
  /\binvalid (?:argument|input|path|request)\b/i,
  /\b(?:argument|command|path|field) .{0,80} (?:is required|must be)\b/i,
  /cannot contain an invalid null byte/i,
  /cannot contain more than/i,
  /is not available through DevRyan browser leases/i,
  /is managed by DevRyan and cannot be/i,
];

const NO_MATCH_PATTERNS = [
  /\bno matches? (?:found|returned)\b/i,
  /\bno files? (?:found|matched)\b/i,
  /\bpattern (?:did not match|was not found)\b/i,
];

const CONTEXT_RUNTIME_PATTERNS = [
  /\bSQLITE_IOERR\b/i,
  /\bdisk I\/O error\b/i,
  /\bdatabase is locked\b/i,
];

const BROWSER_RUNTIME_PATTERNS = [
  /\bDEVRYAN_BROWSER_(?:TURN_LOOKUP|LEASE|COMMAND|CONNECTION|CLEANUP)_/i,
  /agent browser (?:lease request|command|connection)/i,
  /cannot resolve the current browser turn/i,
];

const textMatches = (value, patterns) => {
  const text = typeof value === 'string' ? value : '';
  return patterns.some((pattern) => pattern.test(text));
};

const metadataObject = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);

const normalizedToolName = (metadata) => (
  typeof metadata.tool === 'string' ? metadata.tool.trim().toLowerCase() : ''
);

const toolFailureClassification = (metadata, { legacy = false } = {}) => {
  const failureText = typeof metadata.failureText === 'string' ? metadata.failureText : '';
  const tool = normalizedToolName(metadata);

  if (!legacy && textMatches(failureText, PATCH_CONTEXT_PATTERNS)) {
    return { impact: 'low', failureClass: 'patch_context' };
  }
  if (!legacy && textMatches(failureText, FILESYSTEM_TARGET_PATTERNS)) {
    return { impact: 'low', failureClass: 'filesystem_target' };
  }
  if (!legacy && textMatches(failureText, INPUT_PATTERNS)) {
    return { impact: 'low', failureClass: 'input' };
  }
  if (!legacy && textMatches(failureText, NO_MATCH_PATTERNS)) {
    return { impact: 'low', failureClass: 'input' };
  }
  if (!legacy && textMatches(failureText, CONTEXT_RUNTIME_PATTERNS)) {
    return { impact: 'medium', failureClass: 'tool_runtime' };
  }
  if (!legacy && textMatches(failureText, BROWSER_RUNTIME_PATTERNS)) {
    return { impact: 'medium', failureClass: 'integration_runtime' };
  }

  if (legacy && LEGACY_LOW_TOOL_NAMES.has(tool)) {
    if (tool === 'apply_patch') return { impact: 'low', failureClass: 'patch_context' };
    if (tool === 'read' || tool === 'oc_read' || tool === 'file_read' || tool === 'stat') {
      return { impact: 'low', failureClass: 'filesystem_target' };
    }
    return { impact: 'low', failureClass: 'input' };
  }

  if (tool.startsWith('ctx_')) {
    return { impact: 'medium', failureClass: 'tool_runtime' };
  }
  if (tool === 'devryan_browser') {
    return { impact: 'medium', failureClass: 'integration_runtime' };
  }
  if (
    tool === 'devryan_task'
    || tool.startsWith('mcp__')
    || tool.startsWith('gh_')
    || tool.startsWith('linear_')
    || tool.startsWith('stripe_')
    || tool.startsWith('list_mcp_')
  ) {
    return { impact: 'medium', failureClass: 'integration_runtime' };
  }
  return { impact: 'medium', failureClass: 'unknown' };
};

export const classifyDiagnosticFailure = ({ action, metadata } = {}) => {
  const safeMetadata = metadataObject(metadata);
  if (action === 'platform.security_failed') {
    return { impact: 'critical', source: 'observed', failureClass: 'platform_security' };
  }
  if (action === 'platform.integrity_failed') {
    return { impact: 'critical', source: 'observed', failureClass: 'platform_integrity' };
  }
  if (action === 'managed_task.failed') {
    return { impact: 'high', source: 'observed', failureClass: 'managed_task' };
  }
  if (action === 'session.error') {
    return {
      impact: safeMetadata.retryable === true ? 'medium' : 'high',
      source: 'observed',
      failureClass: 'session_runtime',
    };
  }
  if (action === 'tool.failed') {
    return { ...toolFailureClassification(safeMetadata), source: 'observed' };
  }
  return { impact: 'medium', source: 'observed', failureClass: 'unknown' };
};

export const inferLegacyDiagnostic = ({ action, metadata } = {}) => {
  const safeMetadata = metadataObject(metadata);
  if (action === 'managed_task.failed') {
    return { impact: 'high', source: 'inferred', failureClass: 'managed_task' };
  }
  if (action === 'session.error') {
    return {
      impact: safeMetadata.retryable === true ? 'medium' : 'high',
      source: 'inferred',
      failureClass: 'session_runtime',
    };
  }
  if (action === 'tool.failed') {
    return { ...toolFailureClassification(safeMetadata, { legacy: true }), source: 'inferred' };
  }
  return { impact: 'medium', source: 'inferred', failureClass: 'unknown' };
};

export const normalizeDiagnosticImpact = (value) => (
  DIAGNOSTIC_IMPACT_SET.has(value) ? value : null
);

export const normalizeDiagnosticSource = (value) => (
  DIAGNOSTIC_SOURCE_SET.has(value) ? value : null
);

export const normalizeDiagnosticOutcome = (value) => (
  DIAGNOSTIC_OUTCOME_SET.has(value) ? value : 'unknown'
);

export const normalizeFailureClass = (value) => (
  FAILURE_CLASS_SET.has(value) ? value : 'unknown'
);
