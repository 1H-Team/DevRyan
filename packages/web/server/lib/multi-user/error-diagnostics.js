import { classifyProviderTransportFailure } from '@openchamber/orchestration-runtime';

export const DIAGNOSTIC_IMPACTS = Object.freeze(['low', 'medium', 'high', 'critical']);
export const DIAGNOSTIC_SOURCES = Object.freeze(['observed', 'inferred']);
export const DIAGNOSTIC_OUTCOMES = Object.freeze(['recovered', 'unresolved', 'unknown']);
export const DIAGNOSTIC_DISPOSITIONS = Object.freeze(['actionable', 'expected']);
export const FAILURE_CLASSES = Object.freeze([
  'filesystem_target',
  'input',
  'patch_context',
  'command_exit',
  'tool_runtime',
  'integration_runtime',
  'session_runtime',
  'managed_task',
  'client_runtime',
  'platform_security',
  'platform_integrity',
  'unknown',
]);

const DIAGNOSTIC_IMPACT_SET = new Set(DIAGNOSTIC_IMPACTS);
const DIAGNOSTIC_SOURCE_SET = new Set(DIAGNOSTIC_SOURCES);
const DIAGNOSTIC_OUTCOME_SET = new Set(DIAGNOSTIC_OUTCOMES);
const DIAGNOSTIC_DISPOSITION_SET = new Set(DIAGNOSTIC_DISPOSITIONS);
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
  /\b(?:invalid patch text|malformed patch)\b/i,
];

const FILESYSTEM_TARGET_PATTERNS = [
  /\bENOENT\b/i,
  /\bENOTDIR\b/i,
  /\bEISDIR\b/i,
  /no such file or directory/i,
  /path does not exist/i,
];

const INPUT_PATTERNS = [
  /\bDEVRYAN_TOOL_INPUT_INVALID\b/i,
  /\binvalid (?:argument|input|path|request)\b/i,
  /\b(?:argument|command|path|field)\b.{0,80}\b(?:is required|must be)\b/i,
  /model tried to call unavailable tool/i,
  /File access blocked:[\s\S]{0,2048}resolves outside the project root[\s\S]{0,2048}context-mode confines ctx_execute_file to the workspace/i,
  /cannot contain an invalid null byte/i,
  /cannot contain more than/i,
  /is not available through DevRyan browser leases/i,
  /is managed by DevRyan and cannot be/i,
  /\b(?:tool|command|operation) (?:was )?denied by (?:tool )?policy\b/i,
  /\bpolicy denial\b/i,
  /\bJSON record.{0,80}(?:65,?536|65536).{0,80}(?:bytes?|limit)\b/i,
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

const COMMAND_EXIT_PATTERNS = [
  /(?:^|\n)Exit code:\s*[1-9]\d*\b/i,
  /(?:^|\n)(?:Command|Process) exited with (?:code|status)\s*[1-9]\d*\b/i,
];

const MANAGED_TASK_INPUT_PATTERNS = [
  /\bDEVRYAN_TOOL_INPUT_INVALID\b/i,
  /successful(?:ly)? completed task.{0,160}(?:action\s*[:=]?\s*["']?continue|use (?:the )?continue action)/i,
  /\bretry\b.{0,160}(?:is unavailable|cannot be used).{0,160}\b(?:completed|successful)\b/i,
];

const BROWSER_RUNTIME_PATTERNS = [
  /\bDEVRYAN_BROWSER_(?:LEASE|COMMAND|CONNECTION|CLEANUP)_/i,
  /agent browser (?:lease request|command|connection)/i,
];

const BROWSER_TARGET_PATTERNS = [
  /\bDEVRYAN_BROWSER_TURN_LOOKUP_/i,
  /cannot resolve the current browser turn/i,
  /\bcould not locate element\b/i,
  /\b(?:browser )?(?:element|target|frame|tab).{0,120}(?:not found|missing|not visible|covered)\b/i,
  /\bcoverage miss\b/i,
];

const WEB_TARGET_PATTERNS = [
  /\b(?:HTTP|status)\s*404\b/i,
  /\b(?:ERR_CONNECTION_REFUSED|ECONNREFUSED)\b/i,
  /\bENOTFOUND\b/i,
  /\bnetwork is unreachable\b/i,
  /\bgetaddrinfo\b.{0,80}\bnot found\b/i,
];

const WEB_FETCH_TOOL_NAMES = new Set(['webfetch', 'web_fetch']);
const WEB_FETCH_404_PATTERNS = [/\bstatus code:\s*404\b/i];

const COMMAND_TOOL_NAMES = new Set([
  'bash',
  'exec',
  'exec_command',
  'shell',
]);

const SEARCH_TOOL_NAMES = new Set(['grep', 'rg', 'search']);
const DISCOVERY_TOOL_NAMES = new Set(['glob', ...SEARCH_TOOL_NAMES]);
const DISCOVERY_BUFFER_PATTERNS = [/\bstdout maxBuffer length exceeded\b/i];

const SEARCH_REGEX_INPUT_PATTERNS = [
  /regex parse error/i,
  /invalid (?:regular expression|regex)/i,
  /unclosed (?:group|character class)/i,
  /invalid repetition/i,
];

const TARGETED_RIPGREP_FAILURE_PATTERN = /^ripgrep execution failed\.?$/i;

const expected = (classification) => ({ ...classification, disposition: 'expected' });
const actionable = (classification) => ({ ...classification, disposition: 'actionable' });

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

const isManagedTaskInputMisuse = (metadata) => (
  metadata.errorCode === 'DEVRYAN_TOOL_INPUT_INVALID'
  || textMatches(metadata.failureText, MANAGED_TASK_INPUT_PATTERNS)
);

const toolFailureClassification = (metadata, { legacy = false } = {}) => {
  const failureText = typeof metadata.failureText === 'string' ? metadata.failureText : '';
  const tool = normalizedToolName(metadata);

  if (!legacy && metadata.errorCode === 'DEVRYAN_TOOL_INPUT_INVALID') {
    return expected({ impact: 'low', failureClass: 'input' });
  }
  if (!legacy && SEARCH_TOOL_NAMES.has(tool) && textMatches(failureText, SEARCH_REGEX_INPUT_PATTERNS)) {
    return expected({ impact: 'low', failureClass: 'input' });
  }
  if (!legacy && DISCOVERY_TOOL_NAMES.has(tool) && textMatches(failureText, DISCOVERY_BUFFER_PATTERNS)) {
    return expected({ impact: 'low', failureClass: 'input' });
  }
  if (
    !legacy
    && SEARCH_TOOL_NAMES.has(tool)
    && TARGETED_RIPGREP_FAILURE_PATTERN.test(failureText.trim())
    && Array.isArray(metadata.paths)
    && metadata.paths.length > 0
  ) {
    return expected({ impact: 'low', failureClass: 'filesystem_target' });
  }
  if (!legacy && textMatches(failureText, PATCH_CONTEXT_PATTERNS)) {
    return expected({ impact: 'low', failureClass: 'patch_context' });
  }
  if (!legacy && textMatches(failureText, FILESYSTEM_TARGET_PATTERNS)) {
    return expected({ impact: 'low', failureClass: 'filesystem_target' });
  }
  if (!legacy && textMatches(failureText, INPUT_PATTERNS)) {
    return expected({ impact: 'low', failureClass: 'input' });
  }
  if (!legacy && textMatches(failureText, NO_MATCH_PATTERNS)) {
    return expected({ impact: 'low', failureClass: 'input' });
  }
  if (!legacy && textMatches(failureText, CONTEXT_RUNTIME_PATTERNS)) {
    return actionable({ impact: 'medium', failureClass: 'tool_runtime' });
  }
  if (!legacy && tool === 'devryan_browser' && textMatches(failureText, BROWSER_TARGET_PATTERNS)) {
    return expected({ impact: 'low', failureClass: 'input' });
  }
  if (!legacy && WEB_FETCH_TOOL_NAMES.has(tool) && textMatches(failureText, WEB_FETCH_404_PATTERNS)) {
    return expected({ impact: 'low', failureClass: 'integration_runtime' });
  }
  if (!legacy && textMatches(failureText, WEB_TARGET_PATTERNS)) {
    return expected({ impact: 'low', failureClass: 'integration_runtime' });
  }
  if (!legacy && textMatches(failureText, BROWSER_RUNTIME_PATTERNS)) {
    return actionable({ impact: 'medium', failureClass: 'integration_runtime' });
  }
  if (
    !legacy
    && (tool.startsWith('ctx_') || COMMAND_TOOL_NAMES.has(tool))
    && textMatches(failureText, COMMAND_EXIT_PATTERNS)
  ) {
    return expected({ impact: 'low', failureClass: 'command_exit' });
  }

  if (legacy && LEGACY_LOW_TOOL_NAMES.has(tool)) {
    if (tool === 'apply_patch') return expected({ impact: 'low', failureClass: 'patch_context' });
    if (tool === 'read' || tool === 'oc_read' || tool === 'file_read' || tool === 'stat') {
      return expected({ impact: 'low', failureClass: 'filesystem_target' });
    }
    return expected({ impact: 'low', failureClass: 'input' });
  }

  if (tool.startsWith('ctx_')) {
    return actionable({ impact: 'medium', failureClass: 'tool_runtime' });
  }
  if (tool === 'devryan_browser') {
    return actionable({ impact: 'medium', failureClass: 'integration_runtime' });
  }
  if (
    tool === 'devryan_task'
    || tool.startsWith('mcp__')
    || tool.startsWith('gh_')
    || tool.startsWith('linear_')
    || tool.startsWith('stripe_')
    || tool.startsWith('list_mcp_')
  ) {
    return actionable({ impact: 'medium', failureClass: 'integration_runtime' });
  }
  return actionable({ impact: 'medium', failureClass: 'unknown' });
};

const sessionFailureImpact = (metadata) => {
  if (metadata.retryable === true) return 'medium';
  if (metadata.retryable === false) return 'high';
  return classifyProviderTransportFailure(metadata.errorName, metadata.failureText) ? 'medium' : 'high';
};

const sessionFailureClassification = (metadata) => {
  const transportFailure = classifyProviderTransportFailure(metadata.errorName, metadata.failureText);
  const isChildSession = typeof metadata.childSessionId === 'string' && metadata.childSessionId.trim();
  if (isChildSession && transportFailure && metadata.retryable !== false) {
    return expected({ impact: 'low', failureClass: 'session_runtime' });
  }
  return actionable({
    impact: sessionFailureImpact(metadata),
    failureClass: 'session_runtime',
  });
};

export const classifyDiagnosticFailure = ({ action, metadata } = {}) => {
  const safeMetadata = metadataObject(metadata);
  if (action === 'platform.security_failed') {
    return actionable({ impact: 'critical', source: 'observed', failureClass: 'platform_security' });
  }
  if (action === 'platform.integrity_failed') {
    return actionable({ impact: 'critical', source: 'observed', failureClass: 'platform_integrity' });
  }
  if (action === 'managed_task.failed') {
    if (isManagedTaskInputMisuse(safeMetadata)) {
      return expected({ impact: 'low', source: 'observed', failureClass: 'input' });
    }
    return actionable({ impact: 'high', source: 'observed', failureClass: 'managed_task' });
  }
  if (action === 'session.error') {
    return { ...sessionFailureClassification(safeMetadata), source: 'observed' };
  }
  if (action === 'tool.failed') {
    return { ...toolFailureClassification(safeMetadata), source: 'observed' };
  }
  if (action === 'client.error') {
    // A caught render crash blanks a surface; a stray listener error usually does not.
    return actionable({
      impact: safeMetadata.source === 'error_boundary' ? 'high' : 'medium',
      source: 'observed',
      failureClass: 'client_runtime',
    });
  }
  return actionable({ impact: 'medium', source: 'observed', failureClass: 'unknown' });
};

export const inferLegacyDiagnostic = ({ action, metadata } = {}) => {
  const safeMetadata = metadataObject(metadata);
  if (action === 'managed_task.failed') {
    if (isManagedTaskInputMisuse(safeMetadata)) {
      return expected({ impact: 'low', source: 'inferred', failureClass: 'input' });
    }
    return actionable({ impact: 'high', source: 'inferred', failureClass: 'managed_task' });
  }
  if (action === 'session.error') {
    return { ...sessionFailureClassification(safeMetadata), source: 'inferred' };
  }
  if (action === 'tool.failed') {
    return { ...toolFailureClassification(safeMetadata, { legacy: true }), source: 'inferred' };
  }
  if (action === 'client.error') {
    return actionable({
      impact: safeMetadata.source === 'error_boundary' ? 'high' : 'medium',
      source: 'inferred',
      failureClass: 'client_runtime',
    });
  }
  return actionable({ impact: 'medium', source: 'inferred', failureClass: 'unknown' });
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

export const normalizeDiagnosticDisposition = (value) => (
  DIAGNOSTIC_DISPOSITION_SET.has(value) ? value : null
);

export const normalizeFailureClass = (value) => (
  FAILURE_CLASS_SET.has(value) ? value : 'unknown'
);
