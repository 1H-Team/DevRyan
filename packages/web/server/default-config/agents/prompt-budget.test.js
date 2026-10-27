import { describe, expect, it } from 'vitest';

import { buildPackagedPromptMeasurement } from '../../lib/opencode/harness-context-budget.js';
import { listPackagedAgents } from '../../lib/opencode/packaged-agents.js';
import { translateNativeConfiguration } from '../../lib/opencode/runtime-host/native-configuration-data.js';
import { MAGIC_PROMPT_DEFINITIONS } from '../../../../ui/src/lib/magicPrompts.ts';

// Packaged prompt bodies are part of every request's static prefix. Each
// bundled agent declares a byte ceiling; raising one requires updating its
// rationale in the same change. Budgets must also stay close to the actual
// size, so a shrink has to lower the budget instead of banking the headroom.
const MAX_SLACK_RATIO = 0.1;

const PROMPT_BODY_BUDGETS = {
  builder: { maxBodyBytes: 8996, rationale: 'Sandbox write locations and EPERM recovery 2026-09-27 (7771 bytes) plus 3% headroom; Writing/Executing Plans guidance replacing the retired Superpowers skill 2026-10-05 (+992 bytes, 8984 bytes).' },
  council: { maxBodyBytes: 3900, rationale: 'Baseline 2026-09-23 (3700 bytes) plus ~3% headroom.' },
  designer: { maxBodyBytes: 5280, rationale: '2026-10-20: compact repeated prose, preserve Git, skill visibility, authority and recovery rules (5130 bytes); 2026-10-23 live QA: reuse one dev server and take interim checks on a warm devryan_browser page instead of cold Playwright runs, paid for by tighter batching wording (5275 bytes) within the retained ceiling.' },
  explorer: { maxBodyBytes: 5114, rationale: '2026-10-20: compact repeated prose, preserve Git, skill visibility, authority and recovery rules (4674 bytes); 2026-10-23 live QA showed ~26 sequential steps at ~2 tool calls each, so batch 5-10 independent calls per step, cite path:line for every claim and report gaps under an optional Open questions section (5005 bytes); 2026-10-24 live QA: optional Excerpts section (12 lines per edit target, 2 KiB total) that replaces the Orchestrator re-reading them, paid for by merged Status wording (4965 bytes) plus 3% headroom.' },
  fixer: { maxBodyBytes: 8108, rationale: '2026-10-20: compact repeated prose, preserve Git, skill visibility, authority and recovery rules (7968 bytes); 2026-10-23 live QA: reuse one dev server and take interim checks on a warm devryan_browser page instead of cold Playwright runs, paid for by removing redundant words (8108 bytes) within the retained ceiling.' },
  librarian: { maxBodyBytes: 1230, rationale: '2026-10-26: concise evidence handoff and concrete blocker guidance; compress duplicate no-git prose for research-only scope (1185 bytes plus small headroom).' },
  oracle: { maxBodyBytes: 5600, rationale: 'Code-review precision rules (change attribution, severity vs confidence, verified vs unverified) 2026-09-23; Context Mode guidance removed 2026-09-24 (5439 bytes) plus ~3% headroom.' },
  orchestrator: { maxBodyBytes: 29690, rationale: '2026-10-22 context diet: recovery detail moved into failed-result instructions, default-off capability paragraphs rendered only when enabled, duplicated plan/template/tool-description text removed (42036 -> 29003 bytes rendered with default policies; 29572 with waitAny and compactResults on) plus ~2% headroom; 2026-10-23 live QA: one narrow follow-up Explorer or up to three named reads for a discovery gap, and dev-server reuse (29699 bytes) within the retained ceiling; 2026-10-24 live QA: plan mode reads at most 3 named targets after an Explorer report, no grep, no AGENTS.md/DOCUMENTATION.md re-read, paid for by a shorter Plan Writing section (29686 bytes).' },
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

// Shared instruction text outside agent bodies: the Plan-mode suffix every
// visible primary prefix carries, and the hidden Implement handoff template
// sent with each saved-plan implementation turn. Same ratchet as above.
const SHARED_PROMPT_BUDGETS = {
  planModeSuffix: { maxBytes: 4824, rationale: 'Measured 2026-10-22 as appended to a visible primary system prefix (4683 bytes) plus ~3% headroom; 2026-10-23 states that read-only shell inspection stays available (4741 bytes) within the retained ceiling.' },
  implementTemplate: { maxBytes: 8106, rationale: 'plan.implement.instructions default template measured 2026-10-23 (7870 bytes: parallel-phase start and the Class 1 frontend carve-out matching orchestrator.md) plus ~3% headroom.' },
};

const measureSharedPrompts = () => {
  const prompt = 'Own orchestration.';
  const system = translateNativeConfiguration({ legacy: {}, agents: { orchestrator: { mode: 'primary', prompt } } }).agents.orchestrator.system;
  expect(system.startsWith(prompt)).toBe(true);
  const implement = MAGIC_PROMPT_DEFINITIONS.find((definition) => definition.id === 'plan.implement.instructions');
  return { planModeSuffix: Buffer.byteLength(system) - Buffer.byteLength(prompt), implementTemplate: Buffer.byteLength(implement.template) };
};

describe('shared instruction budgets', () => {
  it('keeps the plan-mode suffix and implement template within their budgets and close to them', () => {
    const measured = measureSharedPrompts();
    expect(Object.keys(measured).sort()).toEqual(Object.keys(SHARED_PROMPT_BUDGETS).sort());
    for (const [name, bytes] of Object.entries(measured)) {
      const budget = SHARED_PROMPT_BUDGETS[name];
      expect(budget.rationale.trim().length, name).toBeGreaterThan(0);
      expect(bytes, `${name}: trim the text, or raise its budget and update the rationale`).toBeLessThanOrEqual(budget.maxBytes);
      expect(budget.maxBytes, `${name}: lower the budget to the new size plus small headroom`)
        .toBeLessThanOrEqual(Math.floor(bytes * (1 + MAX_SLACK_RATIO)));
    }
  });
});
