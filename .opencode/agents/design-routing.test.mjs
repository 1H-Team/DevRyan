import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const agentsDirectory = path.dirname(fileURLToPath(import.meta.url));
const readAgent = (name) => fs.readFileSync(path.join(agentsDirectory, `${name}.md`), 'utf8');

describe('project agent design routing', () => {
  test('keeps design planning with Orchestrator and implementation with Designer', () => {
    const orchestrator = readAgent('orchestrator');

    assert.ok(orchestrator.includes('Orchestrator owns the grounded design approach and decision-complete brief'));
    assert.ok(orchestrator.includes('Route approved plan-card design work back to Designer'));
    assert.ok(orchestrator.includes('Never delegate planning-only or standalone review work to Designer.'));
    assert.ok(orchestrator.includes('Never call Designer in plan mode.'));
    assert.ok(orchestrator.includes('split design and non-design work into disjoint file ownership'));
    assert.ok(orchestrator.includes('report the blocker instead of routing design work to Fixer or implementing it directly'));
  });

  test('uses Oracle only as a once-per-phase late checkpoint and closes final delegation', () => {
    const orchestrator = readAgent('orchestrator');
    const planDraftGate = 'During planning, call it only after you have completed a grounded, decision-complete draft';
    const implementationGate = 'During implementation or another task, call it only after all delegated implementation work has returned and initial deterministic validation is complete';
    const planCloseout = 'after a usable plan review, call no more specialists before presenting the plan.';
    const finalCloseout = 'after a usable final implementation/task review, call no more specialists of any kind.';

    assert.equal(orchestrator.split('Oracle is optional and may be used at most once in each phase.').length - 1, 1);
    assert.ok(orchestrator.includes(planDraftGate));
    assert.ok(orchestrator.includes(implementationGate));
    assert.ok(orchestrator.includes(planCloseout));
    assert.ok(orchestrator.includes('Normal delegation becomes available again only when a later implementation phase begins; that phase may use its own one final Oracle checkpoint.'));
    assert.ok(orchestrator.includes(finalCloseout));
    assert.ok(orchestrator.includes('Apply Oracle findings directly'));
    assert.ok(orchestrator.includes('This overrides normal Designer, Fixer, Explorer, Librarian, Council, parallel-routing, and tiny-direct-edit rules.'));
    assert.ok(orchestrator.includes('A retry or resume of the same failed Oracle task is recovery of that same logical checkpoint, not another review'));
    assert.ok(orchestrator.includes('choose focused or deep before the sole dispatch.'));
    assert.ok(orchestrator.includes('omit `timeout_seconds` for its 15-minute window'));
    assert.ok(orchestrator.includes('passes exactly `timeout_seconds: 1800`'));
    assert.ok(orchestrator.includes('Never call a second Oracle to deepen, follow up, or re-review a usable result.'));
    assert.ok(orchestrator.includes('Review target: final plan draft'));
    assert.ok(orchestrator.includes('Draft plan: <complete decision-ready draft or a compact complete rendering of it>'));
    assert.ok(orchestrator.includes('Review target: final implementation/task result'));
    assert.ok(!orchestrator.includes('a precise focused-review escalation'));
    assert.ok(orchestrator.indexOf(planDraftGate) < orchestrator.indexOf(planCloseout));
    assert.ok(orchestrator.indexOf(implementationGate) < orchestrator.indexOf(finalCloseout));
  });

  test('requires Designer to implement and verify an approved brief', () => {
    const designer = readAgent('designer');

    assert.ok(designer.includes('Implement approved, decision-complete UI/UX briefs'));
    assert.ok(designer.includes('Own the implementation of approved design changes'));
    assert.ok(designer.includes('do not stop at a plan, mock recommendation, or review findings'));
    assert.ok(designer.includes('Do not author design plans, propose alternate directions, or take standalone review assignments'));
    assert.ok(designer.includes('If the task is plan-only, review-only, or lacks an implementation brief'));
    assert.ok(designer.includes('<status>complete</status>'));
    assert.ok(designer.includes('<status>blocked</status>'));
  });

  test('keeps non-design implementation with Fixer and blocks design decisions', () => {
    const fixer = readAgent('fixer');

    assert.ok(fixer.includes('Execute non-design code changes efficiently'));
    assert.ok(fixer.includes('frontend data/state/logic and component correctness'));
    assert.ok(fixer.includes('make no design edits and return `<status>blocked</status>`'));
    assert.ok(fixer.includes('work only on an explicitly disjoint non-design scope'));
    assert.ok(fixer.includes('<status>complete|blocked</status>'));
  });
});
