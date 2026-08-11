const CONTEXT_EXECUTE_TOOLS = new Set([
  'ctx_execute',
  'mcp__context_mode__ctx_execute',
]);

const JAVASCRIPT_LANGUAGES = new Set(['javascript', 'js']);
const ABSOLUTE_PATH_START_PATTERN = /(?:^|\s)["']?(?:\/(?!\/)|[a-z]:[\\/]|\\\\)/gi;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const isRecord = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const inputError = (message) => {
  const error = new Error(`DEVRYAN_TOOL_INPUT_INVALID: Invalid input: ${message}`);
  error.code = 'DEVRYAN_TOOL_INPUT_INVALID';
  return error;
};

const hasMultipleAbsoluteTargets = (value) => {
  if (typeof value !== 'string') return false;
  const matches = value.match(ABSOLUTE_PATH_START_PATTERN);
  return Array.isArray(matches) && matches.length > 1;
};

const validateGrepInput = (args) => {
  if (!isRecord(args) || !hasMultipleAbsoluteTargets(args.path)) return;
  throw inputError(
    'grep.path accepts exactly one path. Use one grep call per target or pass their common parent directory.',
  );
};

const validateContextExecuteInput = (args) => {
  if (!isRecord(args)) return;
  const language = typeof args.language === 'string' ? args.language.trim().toLowerCase() : '';
  const code = typeof args.code === 'string' ? args.code : '';
  if (!JAVASCRIPT_LANGUAGES.has(language) || !code.trim()) return;

  try {
    // Compile as an async function body so top-level await and return remain valid.
    // The function is never invoked; this hook performs syntax validation only.
    new AsyncFunction(code);
  } catch (error) {
    const reason = error instanceof Error && error.message ? ` (${error.message})` : '';
    throw inputError(`ctx_execute JavaScript must parse before execution${reason}. Correct the syntax and retry once.`);
  }
};

export const DevRyanToolInputGuardPlugin = async () => ({
  'tool.execute.before': async (input, output) => {
    if (input?.tool === 'grep') {
      validateGrepInput(output?.args);
      return;
    }
    if (CONTEXT_EXECUTE_TOOLS.has(input?.tool)) {
      validateContextExecuteInput(output?.args);
    }
  },
});

export default DevRyanToolInputGuardPlugin;
