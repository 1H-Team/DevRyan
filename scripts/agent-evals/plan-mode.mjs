import { readFileSync } from 'node:fs';

// The chat composer owns the Plan-mode preface (buildPlanModeSyntheticInstruction
// in the UI session store). Its body is a string-array literal of JSON-compatible
// strings; parse it as data so evaluations send the composer's exact bytes
// without importing the TypeScript store. A format change fails loudly.
const SOURCE_URL = new URL('../../packages/ui/src/sync/session-ui-store.ts', import.meta.url);
const DECLARATION = 'export const buildPlanModeSyntheticInstruction = (): string => [';
const TERMINATOR = '].join("\\n")';

export const PLAN_MODE_INSTRUCTION_PREFIX = 'User has requested to enter plan mode';

export const parsePlanModeInstruction = (source) => {
  const start = source.indexOf(DECLARATION);
  const end = start < 0 ? -1 : source.indexOf(TERMINATOR, start);
  if (start < 0 || end < 0) throw new Error('Plan-mode instruction declaration was not found in the UI session store');
  const literal = source.slice(start + DECLARATION.length - 1, end + 1).replace(/,\s*\]$/, ']');
  const lines = JSON.parse(literal);
  if (!Array.isArray(lines) || !lines.every(line => typeof line === 'string')) {
    throw new Error('Plan-mode instruction is not a string array');
  }
  const text = lines.join('\n');
  if (!text.startsWith(PLAN_MODE_INSTRUCTION_PREFIX)) throw new Error('Plan-mode instruction lost its required prefix');
  return text;
};

let cachedInstruction = null;
export const loadPlanModeInstruction = () => {
  cachedInstruction ??= parsePlanModeInstruction(readFileSync(SOURCE_URL, 'utf8'));
  return cachedInstruction;
};
