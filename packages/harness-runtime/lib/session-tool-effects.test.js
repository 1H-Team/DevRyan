import { expect, test } from 'bun:test';
import { REVIEWED_READ_ONLY_TOOLS, reviewedToolEffect } from './session-tool-effects.js';

test('reviewed read effects require the exact independent registration identity', () => {
  const origins = {
    read: ['native', 'opencode.tool.read'], glob: ['native', 'opencode.tool.glob'], grep: ['native', 'opencode.tool.grep'],
    skill: ['native', 'opencode.tool.skill'], question: ['native', 'opencode.tool.question'],
    webfetch: ['plugin', 'devryan.slim'], devryan_document: ['plugin', 'devryan.document-reader'],
    devryan_plan_read: ['plugin', 'devryan.managed-task'],
    devryan_task: ['plugin', 'devryan.managed-task'], council_session: ['plugin', 'devryan.council'],
    todoread: ['plugin', 'devryan.harness-context'], todowrite: ['plugin', 'devryan.harness-context'],
  };
  expect(REVIEWED_READ_ONLY_TOOLS).toEqual(Object.keys(origins));
  for (const [tool, [kind, id]] of Object.entries(origins)) {
    const origin = { kind, id, manifestDigest: 'a'.repeat(64), capabilities: ['read'] };
    expect(reviewedToolEffect({ tool, origin, reviewedOrigin: { ...origin } })).toMatchObject({ tool, effect: 'read-only' });
    expect(reviewedToolEffect({ tool, origin: { ...origin, manifestDigest: 'b'.repeat(64) }, reviewedOrigin: origin })).toBeNull();
    expect(reviewedToolEffect({ tool, origin: { ...origin, id: 'different' }, reviewedOrigin: origin })).toBeNull();
  }
  expect(reviewedToolEffect({ tool: 'unknown', origin: {}, reviewedOrigin: {} })).toBeNull();
});
