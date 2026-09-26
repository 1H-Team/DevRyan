import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const readAgent = name => readFileSync(new URL(`./${name}.md`, import.meta.url), 'utf8');

describe('complexity-based bundled agent routing', () => {
  it('keeps simple discovery, fixes, visual tweaks and related tests direct', () => {
    const prompt = readAgent('orchestrator');
    for (const rule of ['An unknown filename alone never requires Explorer', 'fully specified visual tweak',
      'Keep related tests and visible verification with the agent doing the change',
      'uncertainty, coupling, risk, and expected elapsed time', 'Explicit user requests for a specialist take precedence']) {
      expect(prompt).toContain(rule);
    }
    for (const obsolete of ['Unknown codebase location: call', 'roughly 20 lines', 'default to @fixer',
      'small-direct-edit exception does not bypass', 'Plan approval does not change specialist ownership']) {
      expect(prompt).not.toContain(obsolete);
    }
  });
  it('retains specialist ownership when delegation is justified', () => {
    const prompt = readAgent('orchestrator');
    for (const rule of ['substantial visual or UX implementation', 'Designer implements:',
      'observable acceptance criteria', 'create disjoint scopes', 'Visible verification is a verification method, not a routing signal',
      'Preserve ownership of active assignments']) expect(prompt).toContain(rule);
    expect(readAgent('fixer')).toContain('make no design edits');
    expect(readAgent('designer')).toContain('implement and validate it in full anyway');
    expect(readAgent('designer')).toContain('Orchestrator may implement simple fully specified visual tweaks directly');
  });
  it('keeps planning read-only and preserves explicit approval context', () => {
    const prompt = readAgent('orchestrator');
    expect(prompt).toContain('never dispatch Designer from a plan-mode turn');
    expect(prompt).toContain('Read the approved plan when the follow-up is only "implement plan"');
    expect(prompt).toContain('Use the same direct-first discovery policy in plan mode');
    expect(prompt).toContain('Never delegate planning-only or standalone review work to Designer.');
  });
  it('bounds unsuccessful Explorer discovery and stops when navigation evidence is sufficient', () => {
    const prompt = readAgent('explorer');
    expect(prompt).toContain('After two unsuccessful search rounds');
    expect(prompt).toContain('An explicitly requested broad usage map may continue within its stated scope');
    expect(prompt).toContain('do not keep searching after saying you have enough context');
    expect(prompt).toContain('Do not diagnose the bug');
  });
});
