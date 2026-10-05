import { describe, expect, it } from 'vitest';

import { buildPackagedPromptMeasurement } from '../../lib/opencode/harness-context-budget.js';
import { listPackagedAgents } from '../../lib/opencode/packaged-agents.js';

// Packaged prompt bodies are part of every request's static prefix. Each
// bundled agent declares a byte ceiling; raising one requires updating its
// rationale in the same change. Budgets must also stay close to the actual
// size, so a shrink has to lower the budget instead of banking the headroom.
const MAX_SLACK_RATIO = 0.1;

const PROMPT_BODY_BUDGETS = {
  builder: { maxBodyBytes: 8996, rationale: 'Sandbox write locations and EPERM recovery 2026-09-27 (7771 bytes) plus 3% headroom; Writing/Executing Plans guidance replacing the retired Superpowers skill 2026-10-05 (+992 bytes, 8984 bytes).' },
  council: { maxBodyBytes: 3900, rationale: 'Baseline 2026-09-23 (3700 bytes) plus ~3% headroom.' },
  designer: { maxBodyBytes: 5648, rationale: 'Specialist-owned routing wording 2026-09-28 (5409 bytes) plus ~4% headroom.' },
  explorer: { maxBodyBytes: 5710, rationale: 'Explorer-first goal discovery 2026-09-27 (5544 bytes) plus 3% headroom.' },
  fixer: { maxBodyBytes: 8355, rationale: 'Specialist-owned routing wording 2026-09-28 (8066 bytes) plus ~3.5% headroom.' },
  librarian: { maxBodyBytes: 2030, rationale: 'Context Mode guidance removed 2026-09-24 (1969 bytes) plus ~3% headroom.' },
  oracle: { maxBodyBytes: 5600, rationale: 'Code-review precision rules (change attribution, severity vs confidence, verified vs unverified) 2026-09-23; Context Mode guidance removed 2026-09-24 (5439 bytes) plus ~3% headroom.' },
  orchestrator: { maxBodyBytes: 42718, rationale: 'Parallel dispatch of independent plan phases, one closing cross-scope check and Designer task sizing 2026-09-30, replacing the Dispatching Parallel Agents skill (39922 bytes) plus ~2% headroom; Writing/Executing Plans sections replacing the retired Superpowers skill 2026-10-05 (+1998 bytes, 42036 bytes).' },
  plan: { maxBodyBytes: 5268, rationale: 'Owner and dependency line per phase 2026-09-30 (3994 bytes) plus ~3% headroom; Writing/Executing plans guidance replacing the retired Superpowers skill 2026-10-05 (+1153 bytes, 5147 bytes).' },
};

const measuredPrompts = () => buildPackagedPromptMeasurement(listPackagedAgents()).items;

describe('packaged agent prompt budgets', () => {
  it('measures parsed prompt bodies for every packaged agent', () => {
    const items = measuredPrompts();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.source).toBe('prompt');
      expect(item.byteCount).toBeGreaterThan(0);
    }
  });

  it('declares an explicit budget with a rationale for every packaged agent', () => {
    const names = measuredPrompts().map((item) => item.name);
    expect(Object.keys(PROMPT_BODY_BUDGETS).sort()).toEqual([...names].sort());
    for (const [name, budget] of Object.entries(PROMPT_BODY_BUDGETS)) {
      expect(Number.isSafeInteger(budget.maxBodyBytes), name).toBe(true);
      expect(budget.rationale.trim().length, name).toBeGreaterThan(0);
    }
  });

  it('keeps every prompt body within its budget', () => {
    const overBudget = measuredPrompts()
      .filter((item) => item.byteCount > PROMPT_BODY_BUDGETS[item.name].maxBodyBytes)
      .map((item) => `${item.name}: ${item.byteCount} > ${PROMPT_BODY_BUDGETS[item.name].maxBodyBytes} bytes`);
    expect(overBudget, 'Trim the prompt, or raise its budget and update the rationale.').toEqual([]);
  });

  it('lowers a budget when its prompt shrinks', () => {
    const slack = measuredPrompts()
      .filter((item) => PROMPT_BODY_BUDGETS[item.name].maxBodyBytes > item.byteCount * (1 + MAX_SLACK_RATIO))
      .map((item) => `${item.name}: budget ${PROMPT_BODY_BUDGETS[item.name].maxBodyBytes} for ${item.byteCount} bytes`);
    expect(slack, 'Lower the budget to the new size plus small headroom.').toEqual([]);
  });
});
