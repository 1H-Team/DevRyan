import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const agentsDirectory = path.dirname(fileURLToPath(import.meta.url));
const readAgent = (name) => fs.readFileSync(path.join(agentsDirectory, `${name}.md`), 'utf8');

describe('project agent design routing', () => {
  test('keeps design planning and implementation with Designer', () => {
    const orchestrator = readAgent('orchestrator');

    assert.ok(orchestrator.includes('Designer owns that change end to end'));
    assert.ok(orchestrator.includes('Never hand a Designer-produced plan or review to Fixer for implementation'));
    assert.ok(orchestrator.includes('route approved plan-card design work back to Designer'));
    assert.ok(orchestrator.includes('Explicit plan-only and review-only tasks stay read-only.'));
    assert.ok(orchestrator.includes('split design and non-design work into disjoint file ownership'));
    assert.ok(orchestrator.includes('report the blocker instead of routing design work to Fixer or implementing it directly'));
  });

  test('requires Designer to execute normal design assignments while preserving read-only tasks', () => {
    const designer = readAgent('designer');

    assert.ok(designer.includes('Plan, implement, and review cohesive UI/UX'));
    assert.ok(designer.includes('Own design changes end to end'));
    assert.ok(designer.includes('do not stop at a plan, mock recommendation, or review findings'));
    assert.ok(designer.includes('If an approved design plan is supplied, implement it'));
    assert.ok(designer.includes('explicitly plan-only or review-only, remain read-only'));
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
