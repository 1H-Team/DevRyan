import { buildManagedAgentContract } from '@openchamber/orchestration-runtime';

import { ANTHROPIC_PROVIDER_IDS } from '../opencode/anthropic-provider-ids.js';
import { readMeridianPromptMode } from '../opencode/meridian-sdk-features.js';

// Provider ids that route through Meridian to Anthropic; shared with the
// quota and title runtimes so every consumer agrees on the alias set.
export { ANTHROPIC_PROVIDER_IDS } from '../opencode/anthropic-provider-ids.js';
// Meridian prompt mode in which opencode's system prompt (and with it the
// designer/fixer agent instructions) is dropped for Anthropic-routed sessions.
export const CLAUDE_COMPATIBILITY_PROMPT_MODE = 'claude-only';
// `~/.config/meridian/sdk-features.json` is global and read per request; a short
// memo keeps managed dispatch from re-reading it on every child start.
export const DEFAULT_PROMPT_MODE_MEMO_MS = 5_000;
// Agents whose long tool loops get an assistant-turn backstop; the others are
// bounded by their read-only tool surface and shorter task timeouts.
export const TURN_BUDGETED_MANAGED_AGENTS = Object.freeze(new Set(['designer', 'fixer']));
export const DEFAULT_MANAGED_TURN_BUDGET = 150;

const normalizeId = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

export const isAnthropicProviderId = (providerId) => (
  ANTHROPIC_PROVIDER_IDS.has(normalizeId(providerId))
);

export const resolveManagedTaskTurnBudget = (task) => (
  TURN_BUDGETED_MANAGED_AGENTS.has(normalizeId(task?.agent))
    ? DEFAULT_MANAGED_TURN_BUDGET
    : null
);

export const createClaudeCompatibilityPreambleResolver = (options = {}) => {
  const readPromptMode = typeof options.readPromptMode === 'function'
    ? options.readPromptMode
    : () => readMeridianPromptMode();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const memoMs = Number.isFinite(options.memoMs) ? options.memoMs : DEFAULT_PROMPT_MODE_MEMO_MS;
  let memo = null;

  const currentPromptMode = () => {
    if (memo && now() - memo.readAt < memoMs) return memo.mode;
    let mode = null;
    try {
      const result = readPromptMode();
      mode = result?.ok === true && typeof result.mode === 'string' ? result.mode : null;
    } catch {
      // An unreadable settings file means the mode is unknown; treat it as not
      // compatibility mode rather than failing the dispatch.
      mode = null;
    }
    memo = { readAt: now(), mode };
    return mode;
  };

  return (task) => {
    if (!isAnthropicProviderId(task?.providerId)) return null;
    if (currentPromptMode() !== CLAUDE_COMPATIBILITY_PROMPT_MODE) return null;
    return buildManagedAgentContract({ agent: task?.agent });
  };
};
