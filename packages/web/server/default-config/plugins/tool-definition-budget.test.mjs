import { describe, expect, it } from 'vitest';
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
  devryan_task: { maxBytes: 3600, rationale: 'Measured 2026-09-24 (3429 bytes) plus ~5% headroom.' },
  devryan_document: { maxBytes: 650, rationale: 'Measured 2026-09-24 (620 bytes) plus ~5% headroom.' },
  council_session: { maxBytes: 330, rationale: 'Measured 2026-09-24 (311 bytes) plus ~5% headroom.' },
};

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

describe('bundled tool definition budgets', () => {
  it('keeps every measured tool definition within its budget and close to it', async () => {
    const measured = await measureTools();
    expect(Object.keys(measured).sort()).toEqual(Object.keys(TOOL_DEFINITION_BUDGETS).sort());
    for (const [id, bytes] of Object.entries(measured)) {
      const budget = TOOL_DEFINITION_BUDGETS[id];
      expect(budget.rationale.trim().length, id).toBeGreaterThan(0);
      expect(bytes, `${id}: trim the definition, or raise its budget with a rationale`).toBeLessThanOrEqual(budget.maxBytes);
      expect(budget.maxBytes, `${id}: lower the budget to the new size plus small headroom`)
        .toBeLessThanOrEqual(Math.ceil(bytes * (1 + MAX_SLACK_RATIO)));
    }
  });
});
