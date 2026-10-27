import { describe, expect, test } from 'bun:test';
import { createCompactResultHeader } from './compact-result-header.js';
import { decodeRequiredCheckVerification, projectRequiredCheckCompletion, projectRequiredCheckEvidence, selectRequiredCheckTasks, validateRequiredCheckReceipts, validateRequiredChecks } from './required-checks.js';

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

describe('typed required verification completion', () => {
  test('the wire decoder validates every consumed verification field and projects bounded shapes', () => {
    const checks = projectRequiredCheckEvidence([{ name: 'unit', command: 'bun test', paths: ['src.js'] }]);
    const value = { ...projectRequiredCheckCompletion(checks), objectiveId: 'msg_user', checks, observedAt: 1 };
    expect(decodeRequiredCheckVerification(value)).toEqual(value);
    for (const change of [{ kind: 'unreviewed' }, { coverage: { ...checks[0].coverage, kind: 'all-code' } },
      { evidence: { callId: 12 } }, { visual: { dataSource: 'fixture' } }, { waiver: { reason: 'child prose' } }]) {
      expect(decodeRequiredCheckVerification({ ...value, checks: [{ ...checks[0], ...change }] })).toBeNull();
    }
    expect(decodeRequiredCheckVerification({ ...value, ready: true })).toBeNull();
  });
  test('only observed passes or content-bound authenticated waivers satisfy declared checks', () => {
    const checks = [{ name: 'unit', command: 'bun test', paths: ['src.js'] }];
    expect(projectRequiredCheckCompletion([])).toMatchObject({ ready: true, status: 'passed' });
    expect(projectRequiredCheckCompletion(projectRequiredCheckEvidence(checks))).toMatchObject({ ready: false, status: 'pending', remaining: [{ name: 'unit' }] });
    const receipt = { name: 'unit', callId: 'waiver_1', messageId: null, exitCode: null, observedAt: 1, status: 'waived', contentHash: 'a'.repeat(64),
      waiver: { source: 'authenticated-user', userId: 'owner', reason: 'Accept this known limitation' } };
    expect(projectRequiredCheckCompletion(projectRequiredCheckEvidence(checks, [receipt], { unit: 'a'.repeat(64) }))).toMatchObject({ ready: true, status: 'waived' });
    expect(projectRequiredCheckCompletion(projectRequiredCheckEvidence(checks, [receipt], { unit: 'b'.repeat(64) }))).toMatchObject({ ready: false, status: 'pending' });
    expect(() => validateRequiredCheckReceipts([{ ...receipt, waiver: { ...receipt.waiver, source: 'child-report' } }], checks)).toThrow();
  });
  test('visual declarations require populated state, assertions and an explicit data source', () => {
    const check = { name: 'visual', command: 'bun run visual', paths: ['src.js'], kind: 'visual', visual: { state: 'populated', dataSource: 'fixture', assertions: ['rows visible'], reportPath: 'visual.json' } };
    expect(validateRequiredChecks([check])).toEqual([check]);
    for (const visual of [{ ...check.visual, assertions: [] }, { ...check.visual, state: 'empty' }, { ...check.visual, reportPath: '../report.json' }]) {
      expect(() => validateRequiredChecks([{ ...check, visual }])).toThrow();
    }
  });
  test('supersession preserves requirements and never treats abandonment or a new objective as a waiver', () => {
    const prior = { taskId: 'old', dispatchGroupId: 'objective', priorTaskId: null, requiredChecks: [{ name: 'unit', command: 'bun test', paths: ['src.js'] }] };
    const next = { ...prior, taskId: 'retry', priorTaskId: 'old' };
    expect(selectRequiredCheckTasks([prior, next], 'objective')).toEqual([next]);
    expect(selectRequiredCheckTasks([prior, { ...next, requiredChecks: [] }], 'objective')).toEqual([prior]);
    expect(selectRequiredCheckTasks([prior], 'new-objective')).toEqual([]);
    const projected = { ...prior, dispatchGroupId: undefined, verification: { objectiveId: 'objective' } };
    expect(selectRequiredCheckTasks([projected], 'objective')).toEqual([projected]);
  });
});
