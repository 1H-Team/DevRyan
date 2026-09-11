import { describe, expect, test } from 'bun:test';
import { createCompactResultHeader } from './compact-result-header.js';

const task = { taskId: 'dvr_task_header', rootSessionId: 'ses_root', status: 'completed', failureReason: null };
const checks = [{ name: 'unit', status: 'passed' }];
const header = (preview, overrides = {}) => createCompactResultHeader({ task,
  envelope: { ...task, envelopeId: 'dvr_result_header', partial: false, action: null,
    resumable: false, recoverablePreview: preview, canonicalRefs: [] },
  checks, observedAt: 1, ...overrides });

describe('compact reported outcomes and detail requirements', () => {
  test('retains a blocked marker beyond the first result page without changing canonical status', () => {
    const result = header(`${'Long activity report.\n'.repeat(600)}The required implementation is blocked.\n**Status:** blocked`);
    expect(result.outcome.status).toBe('completed');
    expect(result.reported).toMatchObject({ authoritative: false, terminalMarker: 'blocked' });
    expect(result.criticalFailures[0]).toContain('Child reports blocked');
    expect(result.detail.requiredBeforeDisposition).toBe(true);
  });
  test('permits selective detail for an unambiguous complete report with all named checks passed', () => {
    const result = header('Implemented and verified.\n**Routing:** better suited to fixer - persistence only\n**Status:** complete');
    expect(result.reported).toMatchObject({ terminalMarker: 'complete', routing: 'better suited to fixer - persistence only' });
    expect(result.detail.requiredBeforeDisposition).toBe(false);
  });
  test.each([
    ['No terminal marker', 'missing'],
    ['**Status:** blocked\n**Status:** complete', 'ambiguous'],
    ['**Status:** complete\nA remaining blocker.', 'ambiguous'],
    ['**Status:** done', 'ambiguous'],
    ['```markdown\n**Status:** complete\n```', 'missing'],
    ['~~~\n**Status:** blocked\n~~~\n**Status:** complete', 'complete'],
    ['```\n```markdown\n**Status:** complete', 'missing'],
  ])('classifies retained markers without treating quoted code as an outcome: %s', (preview, expected) => {
    expect(header(preview).reported.terminalMarker).toBe(expected);
    expect(header(preview).detail.requiredBeforeDisposition).toBe(expected !== 'complete');
  });
  test.each([{ requiredChecks: [] }, { requiredChecks: [{ name: 'unit', status: 'not-observed' }] },
    { requiredChecks: [{ name: 'unit', status: 'failed' }] }])(
    'does not infer sufficient verification from a complete report', ({ requiredChecks }) => {
      expect(header('**Status:** complete', { checks: requiredChecks }).detail.requiredBeforeDisposition).toBe(true);
    },
  );
});
