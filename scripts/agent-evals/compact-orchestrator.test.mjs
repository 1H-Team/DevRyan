import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCompactOrchestrator, GUIDANCE_NAME } from './compact-orchestrator.mjs';

test('candidate preserves persistent permissions, routing, recovery and startup authority verbatim', async () => {
  const source = await readFile(new URL('../../packages/web/server/default-config/agents/orchestrator.md', import.meta.url), 'utf8');
  const { prompt, skill } = createCompactOrchestrator(source);
  assert.equal(prompt.split('---')[1], source.split('---')[1]);
  for (const section of ['Role & Operating Model', 'Hard Rules', 'Git Command Boundary', 'Routing', 'Plan Mode', 'Expected Tool Outcomes', 'Completion Contract']) {
    const pattern = new RegExp(`<${section}>[\\s\\S]*?</${section}>`);
    assert.equal(prompt.match(pattern)?.[0], source.match(pattern)?.[0]);
  }
  for (const line of source.split('\n').filter(line => /^(Skills routing:|Approved-plan implementation startup:)/.test(line))) assert.ok(prompt.includes(line));
  assert.ok(prompt.includes(GUIDANCE_NAME));
  assert.ok(skill.includes('Review target: final implementation/task result'));
  assert.ok(skill.includes('exactly one terminal status marker'));
  assert.ok(Buffer.byteLength(prompt) < Buffer.byteLength(source) * 0.85);
});
