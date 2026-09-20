import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeDuplicateBehaviorPairs } from './duplicate-behavior.mjs';
import { inspectDuplicateRequest } from './duplicate-serializer-probe.mjs';

const trial = duplicateOutputs => ({ duplicateOutputs, executionMode: 'live', completed: true, cleanupComplete: true,
  fixtureHash: 'a'.repeat(64), environmentHash: 'b'.repeat(64), configurationHash: 'c'.repeat(64), reportHash: 'd'.repeat(64),
  appliedReductions: duplicateOutputs ? 2 : 0, criticalFailures: 0, repeatedMutations: 0, sameKeyRepeatCalls: 1, eligibleCalls: 10 });
const pairs = () => Array.from({ length: 10 }, (_, index) => ({ index, kind: index < 5 ? 'skill' : 'managed', baseline: { ...trial(false), reportHash: index.toString(16).padStart(64, '0') }, candidate: { ...trial(true), reportHash: (index + 10).toString(16).padStart(64, '0') } }));
test('behavior gate requires all ten matched live trials with five per kind, independent of savings', () => {
  assert.equal(gradeDuplicateBehaviorPairs(pairs()).qualified, true);
  for (const mutate of [p => p.pop(), p => { p[0].candidate = null; }, p => { p[0].candidate.executionMode = 'fixture'; },
    p => { p[0].candidate.criticalFailures++; }, p => { p[0].candidate.repeatedMutations++; },
    p => { p[0].candidate.sameKeyRepeatCalls++; }, p => { delete p[0].candidate.eligibleCalls; },
    p => { p[0].candidate.configurationHash = 'f'.repeat(64); }, p => { p[0].kind = 'managed'; },
    p => { p[0].candidate.duplicateOutputs = false; }, p => { p[0].candidate.cleanupComplete = false; }]) {
    const p = pairs(); mutate(p); assert.equal(gradeDuplicateBehaviorPairs(p).qualified, false);
  }
  assert.equal(gradeDuplicateBehaviorPairs().qualified, false);
  const incomplete = pairs(); incomplete[0].candidate.completed = false;
  assert.equal(gradeDuplicateBehaviorPairs(incomplete).completedPairs, 9);
});
test('wire inspection measures final UTF-8 serialization and sees nested summary references', () => {
  const request = { input: [{ type: 'message', content: '世界 <devryan_skill_reuse>reference</devryan_skill_reuse>' }] };
  const raw = JSON.stringify(request), result = inspectDuplicateRequest(request, raw);
  assert.equal(result.bytes, Buffer.byteLength(raw)); assert.equal(result.skillReferences, 1); assert.equal(result.uniqueEvidence, false);
});
