import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const readAgent = name => readFileSync(new URL(`./${name}.md`, import.meta.url), 'utf8');

describe('specialist-owned bundled agent routing', () => {
  it('uses exact search references without stale codemap instructions', () => {
    for (const agent of ['builder', 'explorer', 'fixer', 'orchestrator']) expect(readAgent(agent)).not.toMatch(/codemap/i);
  });
  it('routes coherent work without mandatory Explorer discovery and routes implementation to its owning specialist', () => {
    const prompt = readAgent('orchestrator');
    for (const rule of ['**Evidence-driven discovery.**', 'Use one appropriate specialist for one coherent concern',
      'Sequence only actual dependencies', 'Do not repeat discovery',
      'Verify a decisive claim or explicit gap with a narrow named read.', '**Specialist-owned implementation.**',
      'You are not the default implementer.', 'every bug fix, tests, fixtures, and backend/server/state/CLI/config work go to `fixer`',
      'visual or UX changes go to `designer`', 'current external documentation goes to `librarian`',
      'whatever its size', 'every bug fix', 'A one-line bug fix is still a bug fix: send it to `fixer` instead of patching it yourself.',
      'Implement directly only a mechanical edit that changes no behavior or presentation',
      'Start `librarian` alongside independent repository work for external/version-specific facts.',
      'answer stable, general programming knowledge directly',
      'Keep related tests and visible verification with the agent doing the change',
      'Explicit user requests for a specialist take precedence']) {
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
      'direct-first discovery policy', 'only when it adds value',
      // Retired with Ponytail, the only source of appended minimal-diff style guidance.
      'minimal-diff or lazy-developer']) {
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
    expect(prompt).toContain('Use the same evidence-driven routing in plan mode; every planning specialist stays read-only.');
    expect(prompt).toContain('When the plan depends on external or version-specific facts, start `librarian` alongside independent repository work.');
    expect(prompt).toContain('Plan approval preserves specialist ownership: in the implementation turn, route approved visual work to Designer and non-design implementation to Fixer.');
    expect(prompt).toContain('Never delegate planning-only or standalone review work to Designer.');
  });
  it('uses evidence gaps rather than read counts to route planning discovery', () => {
    expect(readAgent('orchestrator')).toContain('A read-count advisory asks you to reassess evidence, not start a fresh Explorer.');
    expect(readAgent('orchestrator')).toContain('continue the existing Explorer with the unanswered question and supplied findings');
    const explorer = readAgent('explorer');
    expect(explorer).toContain('## Excerpts');
    expect(explorer).toContain('at most 12 quoted lines headed by `path:line`; 2 KiB in total');
  });
  it('bounds unsuccessful Explorer discovery and stops when navigation evidence is sufficient', () => {
    const prompt = readAgent('explorer');
    expect(prompt).toContain('After two unsuccessful search rounds');
    expect(prompt).toContain('An explicitly requested broad usage map may continue within its stated scope');
    expect(prompt).toContain('Stop when the entrypoint, relevant symbol, and requested immediate connections are established.');
    expect(prompt).toContain('Avoid repeating discovery');
    expect(prompt).toContain('Aim for a report around 6 KiB');
    expect(prompt).toContain('Do not diagnose the bug');
    expect(prompt).toContain('Given a task goal rather than a single target');
  });
});
