import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const readAgent = name => readFileSync(new URL(`./${name}.md`, import.meta.url), 'utf8');

describe('specialist-owned bundled agent routing', () => {
  it('starts new tasks with Explorer discovery and routes implementation to its owning specialist', () => {
    const prompt = readAgent('orchestrator');
    for (const rule of ['**Explorer-first discovery.**', 'the user named the exact files or symbols to change',
      'the whole answer is one narrow lookup', 'do not repeat its search', '**Specialist-owned implementation.**',
      'You are not the default implementer.', 'every bug fix, tests, fixtures, and backend/server/state/CLI/config work go to `fixer`',
      'visual or UX changes go to `designer`', 'current external documentation goes to `librarian`',
      'whatever its size', 'every bug fix', 'A one-line bug fix is still a bug fix: send it to `fixer` instead of patching it yourself.',
      'Implement directly only a mechanical edit that changes no behavior or presentation',
      'When the goal depends on external or version-specific facts, start `librarian` in the same dispatch as Explorer.',
      'answer stable, general programming knowledge directly',
      'Keep related tests and visible verification with the agent doing the change',
      'Explicit user requests for a specialist take precedence',
      'it never makes you the implementer or replaces Explorer-first discovery']) {
      expect(prompt).toContain(rule);
    }
    // The 2026-09-25 direct-first policy left Orchestrator implementing everything after Explorer returned.
    for (const obsolete of ['Unknown codebase location: call', 'roughly 20 lines',
      'Direct implementation is the default', 'Direct work is the default', 'A bounded behavior fix stays direct',
      'Simple specified visual work may stay with Orchestrator', 'Delegate only when specialization',
      'uncertainty, coupling, risk, and expected elapsed time', 'Delegate only when a specialist gives clear net value',
      'Solve a small coherent change directly', 'simple work stays direct', 'complexity-based routing',
      'Plan approval does not change specialist ownership', 'a couple of lines with no test change', 'trivial one-file edit',
      'when it also depends on external', "a child's provider may report", 'An unknown filename alone never requires Explorer',
      'direct-first discovery policy', 'only when it adds value']) {
      expect(prompt).not.toContain(obsolete);
    }
  });
  it('keeps specialist ownership boundaries between Designer and Fixer', () => {
    const prompt = readAgent('orchestrator');
    for (const rule of ['owner of visual or UX implementation, including fully specified tweaks', 'Designer implements:',
      'observable acceptance criteria', 'default owner of bounded non-design implementation', 'create disjoint scopes',
      'Merely touching a UI file is not a design change', 'under an unchanged presentation route to `fixer`',
      'Visible verification is a verification method, not a routing signal',
      'Preserve ownership of active assignments']) expect(prompt).toContain(rule);
    expect(prompt).toContain('Name every file by its absolute path in the current workspace');
    expect(readAgent('fixer')).toContain('make no design edits');
    expect(readAgent('fixer')).toContain('Visual changes, including fully specified tweaks, belong to Designer.');
    expect(readAgent('designer')).toContain('implement and validate it in full anyway');
    expect(readAgent('designer')).toContain('visual implementation, including fully specified tweaks, belongs to Designer');
    for (const agent of ['fixer', 'designer']) {
      expect(readAgent(agent)).not.toContain('simple fully specified visual tweaks directly');
    }
  });
  it('keeps planning read-only and preserves explicit approval context', () => {
    const prompt = readAgent('orchestrator');
    expect(prompt).toContain('never dispatch Designer from a plan-mode turn');
    expect(prompt).toContain('Read the approved plan when the follow-up is only "implement plan"');
    expect(prompt).toContain('Apply Explorer-first discovery in plan mode too; Explorer is read-only.');
    expect(prompt).toContain('When the plan depends on external or version-specific facts, start `librarian` alongside Explorer.');
    expect(prompt).toContain('Plan approval preserves specialist ownership: in the implementation turn, route approved visual work to Designer and non-design implementation to Fixer.');
    expect(prompt).toContain('Never delegate planning-only or standalone review work to Designer.');
  });
  it('bounds unsuccessful Explorer discovery and stops when navigation evidence is sufficient', () => {
    const prompt = readAgent('explorer');
    expect(prompt).toContain('After two unsuccessful search rounds');
    expect(prompt).toContain('An explicitly requested broad usage map may continue within its stated scope');
    expect(prompt).toContain('do not keep searching after saying you have enough context');
    expect(prompt).toContain('Do not diagnose the bug');
    expect(prompt).toContain('Given a task goal rather than a single target');
  });
});
