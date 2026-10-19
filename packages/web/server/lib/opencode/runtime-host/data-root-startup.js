import { migrateLegacyDataRoot } from '@devryan/harness-runtime';
import { recordStartupFindings } from './startup-notices.js';

// Outcomes the open app reports; `deferred` (an older process still owns the
// folder) is retried silently at the next start.
const NOTICE_OUTCOMES = new Set(['merged', 'kept_in_place', 'failed']);
const QUIET_OUTCOMES = new Set(['none', 'current', 'explicit', 'unsupported_platform']);

/**
 * Runs the one-time ~/.config/openchamber → ~/.config/devryan move before any
 * data-root reader. Never throws: a failed move leaves the legacy folder in use.
 * Logs outcome codes only, never paths or file names.
 */
export async function migrateDataRootAtStartup({ log = console, env = process.env, ...options } = {}) {
  // A test runner's in-process or child server must never move the real
  // user's folder; migration tests call migrateLegacyDataRoot with a fixture home.
  if (env.NODE_ENV === 'test' || env.VITEST !== undefined || env.NODE_TEST_CONTEXT !== undefined) return { outcome: 'test_runner' };
  let result;
  try {
    result = await migrateLegacyDataRoot({ env, ...options });
  } catch (error) {
    result = { outcome: 'failed', code: typeof error?.code === 'string' ? error.code : 'error' };
  }
  if (NOTICE_OUTCOMES.has(result.outcome)) {
    recordStartupFindings('data_root', [{ code: `data_root_${result.outcome}`, scope: result.code ?? '', key: String(result.conflicts?.length ?? '') }], log);
  } else if (!QUIET_OUTCOMES.has(result.outcome)) {
    log.info?.(`[data-root] ${result.outcome}`);
  }
  return result;
}
