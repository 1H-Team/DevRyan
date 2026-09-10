import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readAgent = (name) => readFileSync(new URL(`./${name}.md`, import.meta.url), 'utf8');

describe('bundled agent design routing', () => {
  it('requires Orchestrator to name an open visual decision before dispatching Designer', () => {
    const orchestrator = readAgent('orchestrator');
    expect(orchestrator).toContain('`Designer decides: <the visual or UX question>`');
    expect(orchestrator).toContain('the only honest version of it is "keep the current design"');
    expect(orchestrator).toContain('Apply the two-outcomes test');
    expect(orchestrator).toContain('the brief names a specific unresolved visual or UX decision Designer must make');
    expect(orchestrator).toContain('`Designer decides: <open visual or UX question>` line');
  });

  it('keeps UI behavior work and its visible verification with Fixer', () => {
    const orchestrator = readAgent('orchestrator');
    expect(orchestrator).toContain('save-on-dismiss semantics');
    expect(orchestrator).toContain('unmount cleanup');
    expect(orchestrator).toContain('idempotent close or cancel paths');
    expect(orchestrator).toContain('refetch/rebase and cache reconciliation');
    expect(orchestrator).toContain('applying an already-approved appearance to an additional view');
    expect(orchestrator).toContain('Visible verification is a verification method, not a routing signal');
    expect(orchestrator).toContain('stay with `fixer` even when they render UI or capture screenshots');
    expect(orchestrator).toContain('behavior work whose appearance the brief already fixes, including work that lives entirely in component files');
    expect(orchestrator).toContain('Plan approval is not by itself a Designer routing signal');

    const fixer = readAgent('fixer');
    expect(fixer).toContain('Own browser and screenshot verification for behavior you implement');
    expect(fixer).toContain('UI behavior in component files is yours');
    expect(fixer).toContain('Do not decide an appearance that is still open');
  });

  it('drops the wording that biased mixed and approved work to Designer', () => {
    const orchestrator = readAgent('orchestrator');
    expect(orchestrator).not.toContain('keep the coupled design slice with Designer');
    expect(orchestrator).not.toContain('the coupled UI/design files and behavior');
    expect(orchestrator).not.toContain('its design tasks route to Designer rather than Fixer');
    expect(orchestrator).not.toContain('design-specific tests, layout/responsiveness');
    expect(orchestrator).not.toContain('design-specific component tests stay with Designer');
  });

  it('does not regress Designer ownership of genuine design work', () => {
    const orchestrator = readAgent('orchestrator');
    expect(orchestrator).toContain('report the blocker instead of assigning the design work to Fixer or implementing it directly');
    expect(orchestrator).toContain('Never delegate planning-only or standalone review work to Designer.');
    expect(orchestrator).toContain('never dispatch Designer from a plan-mode turn');
    expect(orchestrator).toContain('Orchestrator owns the grounded design approach');

    const designer = readAgent('designer');
    expect(designer).toContain('**Routing:** better suited to fixer');
    expect(designer).toContain('Do not block, do not ask');
    expect(designer).toContain('implement and validate it in full anyway');
  });
});
