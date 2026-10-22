import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DevRyanManagedOrchestrationPlugin } from './devryan-managed-orchestration.mjs';
import { DevRyanDocumentReaderPlugin } from './devryan-document-reader.mjs';
import { DevRyanBrowserPlugin } from './devryan-browser.mjs';
import { CouncilSessionPlugin } from './council-session.js';
import { ast_grep_replace, ast_grep_search } from '../../../../agents-core/src/tools/ast-grep/tools.ts';
import { rewriteReviewedImagegen } from '../../lib/opencode/runtime-host/reviewed-imagegen-transform.js';

// Bundled tool definitions (description plus argument schema) are sent with
// every request, like packaged prompts. Same ratchet as prompt-budget.test.js:
// raising a ceiling needs a rationale; a shrink must lower the ceiling.
// Runtime-registered definitions (the managed-install browser, Slim's built-in
// ast-grep tools and the reviewed image tool) are measured separately below.
const MAX_SLACK_RATIO = 0.1;
const TOOL_DEFINITION_BUDGETS = {
  devryan_task: { maxBytes: 3165, rationale: 'Measured 2026-10-11 with default-off waitAny and context projection (3014 bytes) plus ~5% headroom; tightened after capability filtering.' },
  devryan_document: { maxBytes: 650, rationale: 'Measured 2026-09-24 (620 bytes) plus ~5% headroom.' },
  council_session: { maxBytes: 330, rationale: 'Measured 2026-09-24 (311 bytes) plus ~5% headroom.' },
};
// Host-policy variants of a tool definition, measured with the policy env set.
const TOOL_DEFINITION_VARIANT_BUDGETS = {
  'devryan_task+waitAny': {
    environment: { DEVRYAN_MANAGED_WAIT_ANY: '1' },
    maxBytes: 3317,
    rationale: 'Measured 2026-10-11 with waitAny enabled and context projection disabled (3159 bytes) plus ~5% headroom; tightened after capability filtering.',
  },
  'devryan_task+contextProjection': {
    environment: { DEVRYAN_TASK_CONTEXT_PROJECTION: '1' },
    maxBytes: 3430,
    rationale: 'Measured 2026-10-11 with context projection enabled and waitAny disabled (3415 bytes), retaining the previous default ceiling.',
  },
  'devryan_task+waitAny+contextProjection': {
    environment: { DEVRYAN_MANAGED_WAIT_ANY: '1', DEVRYAN_TASK_CONTEXT_PROJECTION: '1' },
    maxBytes: 3600,
    rationale: 'Measured 2026-10-11 with both optional policies enabled (3560 bytes), retaining the previous waitAny ceiling.',
  },
  'devryan_task+staticSchema': {
    environment: { DEVRYAN_CAPABILITY_TOOL_SCHEMA: '0' },
    maxBytes: 3600,
    rationale: 'Measured 2026-10-11 with capability filtering disabled (3560 bytes), matching the full-policy definition ceiling.',
  },
};
const POLICY_ENV_KEYS = ['DEVRYAN_MANAGED_WAIT_ANY', 'DEVRYAN_TASK_CONTEXT_PROJECTION', 'DEVRYAN_CAPABILITY_TOOL_SCHEMA'];
// Definitions registered by the runtime rather than by a default plugin factory.
const RUNTIME_TOOL_DEFINITION_BUDGETS = {
  devryan_browser: { maxBytes: 1564, rationale: 'Measured 2026-10-22 with the managed install layout present (1489 bytes) plus ~5% headroom.' },
  ast_grep_search: { maxBytes: 941, rationale: 'Slim built-in definition measured 2026-10-22 (896 bytes) plus ~5% headroom.' },
  ast_grep_replace: { maxBytes: 819, rationale: 'Slim built-in definition measured 2026-10-22 (780 bytes) plus ~5% headroom.' },
  gpt_imagegen: { maxBytes: 1812, rationale: 'Reviewed imagegen 0.1.12 schema with the native API-key description, measured 2026-10-22 (1725 bytes) plus ~5% headroom.' },
};
const BROWSER_ENV_KEYS = ['DEVRYAN_BROWSER_CDP_DISCOVERY_URL', 'DEVRYAN_BROWSER_CDP_TOKEN', 'DEVRYAN_AGENT_BROWSER_BIN', 'DEVRYAN_EXECUTION_WORKER'];

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

// The browser plugin registers its tool only inside the managed install layout.
const measureBrowserTool = async () => {
  const saved = Object.fromEntries(BROWSER_ENV_KEYS.map((key) => [key, process.env[key]]));
  const root = mkdtempSync(join(tmpdir(), 'devryan-tool-budget-'));
  try {
    const binary = join(root, 'node_modules', 'agent-browser', 'bin', 'agent-browser');
    mkdirSync(join(root, 'node_modules', 'agent-browser', 'bin'), { recursive: true });
    writeFileSync(join(root, 'devryan-agent-browser.json'), '{}');
    delete process.env.DEVRYAN_EXECUTION_WORKER;
    Object.assign(process.env, { DEVRYAN_BROWSER_CDP_DISCOVERY_URL: 'http://127.0.0.1:9/api/desktop/browser-cdp',
      DEVRYAN_BROWSER_CDP_TOKEN: 'fixture-token', DEVRYAN_AGENT_BROWSER_BIN: binary });
    return (await DevRyanBrowserPlugin({})).tool;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
};

// The native registration reuses the pinned reviewed schema and rewrites one
// sentence of its description (native-imagegen-plugin.ts); measure exactly that.
const measureImagegenTool = () => {
  const source = readFileSync(new URL('../../../runtime/reviewed-inputs/imagegen-0.1.12/dist/index.js', import.meta.url));
  const exported = /\nexport const reviewedImagegenDescription=([\s\S]*?);\nconst reviewedImagegenArguments=([\s\S]*?);\nexport const reviewedImagegenInputSchema=/
    .exec(rewriteReviewedImagegen(source).contents);
  expect(exported, 'reviewed imagegen export shape changed').not.toBeNull();
  const [description, args] = runInNewContext(`[${exported[1]}, ${exported[2]}]`, { tool: { schema: z } });
  const plugin = readFileSync(new URL('../../lib/opencode/runtime-host/native-imagegen-plugin.ts', import.meta.url), 'utf8');
  const replacement = /reviewedImagegenDescription\.replace\('([^']*)',\s*'([^']*)'\)/.exec(plugin);
  expect(replacement && description.includes(replacement[1]), 'native imagegen description rewrite changed').toBe(true);
  return { description: description.replace(replacement[1], replacement[2]), args };
};

const measureRuntimeTools = async () => {
  const definitions = { ...await measureBrowserTool(), ast_grep_search, ast_grep_replace, gpt_imagegen: measureImagegenTool() };
  return Object.fromEntries(Object.entries(definitions).map(([id, definition]) => [id, definitionBytes(definition)]));
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

  it('keeps every runtime-registered tool definition within its budget and close to it', async () => {
    const measured = await measureRuntimeTools();
    expect(Object.keys(measured).sort()).toEqual(Object.keys(RUNTIME_TOOL_DEFINITION_BUDGETS).sort());
    for (const [id, bytes] of Object.entries(measured)) {
      expectWithinBudget(id, bytes, RUNTIME_TOOL_DEFINITION_BUDGETS[id]);
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

  it('advertises optional actions and wait_any arguments only when their host policies enable them', async () => {
    const actionsOf = (definition) => z.toJSONSchema(z.object(definition.args)).properties.action.enum;
    const disabled = (await DevRyanManagedOrchestrationPlugin()).tool.devryan_task;
    expect(actionsOf(disabled)).not.toContain('wait_any');
    for (const action of ['checkpoint', 'decisions', 'remember_decision']) {
      expect(actionsOf(disabled)).not.toContain(action);
    }
    expect(Object.keys(disabled.args)).not.toEqual(expect.arrayContaining(['task_ids']));
    expect(Object.keys(disabled.args)).not.toEqual(expect.arrayContaining(['after_cursor']));
    expect(`${disabled.description} ${disabled.args.action.description} ${disabled.args.task_id.description}`)
      .not.toContain('wait_any');

    process.env.DEVRYAN_MANAGED_WAIT_ANY = '1';
    const enabled = (await DevRyanManagedOrchestrationPlugin()).tool.devryan_task;
    expect(actionsOf(enabled)).toContain('wait_any');
    for (const action of ['checkpoint', 'decisions', 'remember_decision']) {
      expect(actionsOf(enabled)).not.toContain(action);
    }
    expect(Object.keys(enabled.args)).toEqual(expect.arrayContaining(['task_ids', 'after_cursor']));
    expect(enabled.description).toContain('Use wait_any for the first collectable result');

    process.env.DEVRYAN_TASK_CONTEXT_PROJECTION = '1';
    const fullPolicySchema = (await DevRyanManagedOrchestrationPlugin()).tool.devryan_task;
    expect(actionsOf(fullPolicySchema)).toEqual(expect.arrayContaining(['wait_any', 'checkpoint', 'decisions', 'remember_decision']));

    // Kill switch: the static schema advertises all optional actions regardless of policy.
    delete process.env.DEVRYAN_MANAGED_WAIT_ANY;
    delete process.env.DEVRYAN_TASK_CONTEXT_PROJECTION;
    process.env.DEVRYAN_CAPABILITY_TOOL_SCHEMA = '0';
    const staticSchema = (await DevRyanManagedOrchestrationPlugin()).tool.devryan_task;
    expect(actionsOf(staticSchema)).toEqual(actionsOf(fullPolicySchema));
    expect(z.toJSONSchema(z.object(staticSchema.args))).toEqual(z.toJSONSchema(z.object(fullPolicySchema.args)));
    expect(staticSchema.description).toBe(fullPolicySchema.description);
    expect(definitionBytes(staticSchema)).toBe(definitionBytes(fullPolicySchema));
  });
});
