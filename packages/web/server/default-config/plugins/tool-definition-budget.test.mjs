import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DevRyanManagedOrchestrationPlugin } from './devryan-managed-orchestration.mjs';
import { DevRyanDocumentReaderPlugin } from './devryan-document-reader.mjs';
import { CouncilSessionPlugin } from './council-session.js';

// Bundled tool definitions (description plus argument schema) are sent with
// every request, like packaged prompts. Same ratchet as prompt-budget.test.js:
// raising a ceiling needs a rationale; a shrink must lower the ceiling.
// devryan-browser.mjs exposes its tools only with a live browser context, so
// it is measured by the runtime context budget instead.
const MAX_SLACK_RATIO = 0.1;
const TOOL_DEFINITION_BUDGETS = {
  devryan_task: { maxBytes: 3430, rationale: 'Measured 2026-09-24 with the default-off waitAny policy (3268 bytes) plus ~5% headroom.' },
  devryan_document: { maxBytes: 650, rationale: 'Measured 2026-09-24 (620 bytes) plus ~5% headroom.' },
  council_session: { maxBytes: 330, rationale: 'Measured 2026-09-24 (311 bytes) plus ~5% headroom.' },
};
// Host-policy variants of a tool definition, measured with the policy env set.
const TOOL_DEFINITION_VARIANT_BUDGETS = {
  'devryan_task+waitAny': {
    environment: { DEVRYAN_MANAGED_WAIT_ANY: '1' },
    maxBytes: 3600,
    rationale: 'Measured 2026-09-24 with DEVRYAN_MANAGED_WAIT_ANY=1 (3429 bytes) plus ~5% headroom.',
  },
};
const POLICY_ENV_KEYS = ['DEVRYAN_MANAGED_WAIT_ANY', 'DEVRYAN_CAPABILITY_TOOL_SCHEMA'];

const definitionBytes = (definition) => Buffer.byteLength(definition.description)
  + Buffer.byteLength(JSON.stringify(z.toJSONSchema(z.object(definition.args))));

const measureTools = async () => {
  const context = { directory: '/tmp', worktree: '/tmp', client: {}, project: {} };
  const plugins = [
    await DevRyanManagedOrchestrationPlugin(),
    await DevRyanDocumentReaderPlugin(context),
    await CouncilSessionPlugin(context),
  ];
  return Object.fromEntries(plugins.flatMap((plugin) => Object.entries(plugin?.tool ?? {}))
    .map(([id, definition]) => [id, definitionBytes(definition)]));
};

const expectWithinBudget = (id, bytes, budget) => {
  expect(budget.rationale.trim().length, id).toBeGreaterThan(0);
  expect(bytes, `${id}: trim the definition, or raise its budget with a rationale`).toBeLessThanOrEqual(budget.maxBytes);
  expect(budget.maxBytes, `${id}: lower the budget to the new size plus small headroom`)
    .toBeLessThanOrEqual(Math.ceil(bytes * (1 + MAX_SLACK_RATIO)));
};

describe('bundled tool definition budgets', () => {
  const originalEnvironment = {};
  beforeEach(() => {
    for (const key of POLICY_ENV_KEYS) {
      originalEnvironment[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of POLICY_ENV_KEYS) {
      if (originalEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnvironment[key];
    }
  });

  it('keeps every measured tool definition within its budget and close to it', async () => {
    const measured = await measureTools();
    expect(Object.keys(measured).sort()).toEqual(Object.keys(TOOL_DEFINITION_BUDGETS).sort());
    for (const [id, bytes] of Object.entries(measured)) {
      expectWithinBudget(id, bytes, TOOL_DEFINITION_BUDGETS[id]);
    }
  });

  it('keeps every host-policy tool definition variant within its budget and close to it', async () => {
    for (const [id, budget] of Object.entries(TOOL_DEFINITION_VARIANT_BUDGETS)) {
      Object.assign(process.env, budget.environment);
      try {
        const [toolId] = id.split('+');
        const measured = await measureTools();
        expectWithinBudget(id, measured[toolId], budget);
      } finally {
        for (const key of Object.keys(budget.environment)) delete process.env[key];
      }
    }
  });

  it('advertises wait_any and its arguments only when the host policy enables it', async () => {
    const actionsOf = (definition) => z.toJSONSchema(z.object(definition.args)).properties.action.enum;
    const disabled = (await DevRyanManagedOrchestrationPlugin()).tool.devryan_task;
    expect(actionsOf(disabled)).not.toContain('wait_any');
    expect(Object.keys(disabled.args)).not.toEqual(expect.arrayContaining(['task_ids']));
    expect(Object.keys(disabled.args)).not.toEqual(expect.arrayContaining(['after_cursor']));
    expect(`${disabled.description} ${disabled.args.action.description} ${disabled.args.task_id.description}`)
      .not.toContain('wait_any');

    process.env.DEVRYAN_MANAGED_WAIT_ANY = '1';
    const enabled = (await DevRyanManagedOrchestrationPlugin()).tool.devryan_task;
    expect(actionsOf(enabled)).toContain('wait_any');
    expect(Object.keys(enabled.args)).toEqual(expect.arrayContaining(['task_ids', 'after_cursor']));
    expect(enabled.description).toContain('Use wait_any for the first collectable result');

    // Kill switch: the static schema advertises wait_any regardless of policy.
    delete process.env.DEVRYAN_MANAGED_WAIT_ANY;
    process.env.DEVRYAN_CAPABILITY_TOOL_SCHEMA = '0';
    const staticSchema = (await DevRyanManagedOrchestrationPlugin()).tool.devryan_task;
    expect(actionsOf(staticSchema)).toContain('wait_any');
    expect(definitionBytes(staticSchema)).toBe(definitionBytes(enabled));
  });
});
