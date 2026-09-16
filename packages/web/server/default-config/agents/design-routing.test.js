import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readAgent = (name) => readFileSync(new URL(`./${name}.md`, import.meta.url), 'utf8');

describe('bundled agent design routing', () => {
  it('routes visual implementation by the requested change even after plan approval', () => {
    const orchestrator = readAgent('orchestrator');
    expect(orchestrator).toContain('including approved plans and fully specified appearances');
    expect(orchestrator).toContain('regrouping service rows, increasing spacing, restyling a service-type pill');
    expect(orchestrator).toContain('both before and after the user says "implement plan"');
    expect(orchestrator).toContain('Plan approval does not change specialist ownership');
    expect(orchestrator).toContain('Read the approved plan when the follow-up is only "implement plan"');
    expect(orchestrator).toContain('`Designer implements: <the visual or UX changes>`');
    expect(orchestrator).toContain('observable acceptance criteria');
    expect(orchestrator).not.toContain('Designer decides:');
    expect(orchestrator).not.toContain('two-outcomes test');
    expect(orchestrator).not.toContain('open visual');
    expect(orchestrator).not.toContain("A plan that approves an appearance has resolved that decision");
  });

  it('keeps behavior work and its visible verification with Fixer', () => {
    const orchestrator = readAgent('orchestrator');
    for (const example of ['save-on-dismiss semantics', 'unmount cleanup',
      'idempotent close or cancel paths', 'refetch/rebase and cache reconciliation']) {
      expect(orchestrator).toContain(example);
    }
    expect(orchestrator).toContain('behavior work under an unchanged presentation');
    expect(orchestrator).toContain('Visible verification is a verification method, not a routing signal');
    expect(orchestrator).toContain('stay with `fixer` even when they render UI or capture screenshots');
    const fixer = readAgent('fixer');
    expect(fixer).toContain('Own browser and screenshot verification for behavior you implement');
    expect(fixer).toContain('UI behavior in component files is yours');
    expect(fixer).toContain('Approved or fully specified visual changes belong to Designer');
    expect(fixer).toContain('make no design edits');
  });

  it('keeps coupled visual changes with Designer and splits independent behavior work', () => {
    const orchestrator = readAgent('orchestrator');
    expect(orchestrator).toContain('For mixed work, create disjoint scopes');
    expect(orchestrator).toContain('keep the coupled visual implementation with Designer');
    expect(orchestrator).toContain('tests that assert the visual changes Designer implements stay with Designer');
    expect(orchestrator).toContain('report the blocker instead of assigning the design work to Fixer or implementing it directly');
    expect(readAgent('fixer')).toContain('work only on an explicitly disjoint non-design scope');
  });

  it('retains planning ownership and limits routing feedback to behavior-only assignments', () => {
    const orchestrator = readAgent('orchestrator');
    expect(orchestrator).toContain('Never delegate planning-only or standalone review work to Designer.');
    expect(orchestrator).toContain('never dispatch Designer from a plan-mode turn');
    expect(orchestrator).toContain('Orchestrator owns the grounded design approach');
    const designer = readAgent('designer');
    expect(designer).toContain('an approved or fully specified visual change still belongs to Designer');
    expect(designer).toContain('if the assignment is only behavior work under an unchanged presentation');
    expect(designer).toContain('**Routing:** better suited to fixer');
    expect(designer).toContain('Do not block, do not ask');
    expect(designer).toContain('implement and validate it in full anyway');
    expect(designer).not.toContain('open visual');
  });
});
