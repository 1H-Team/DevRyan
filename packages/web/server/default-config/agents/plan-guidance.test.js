import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readAgent = (name) => readFileSync(new URL(`./${name}.md`, import.meta.url), 'utf8');

// The primary agents carry the writing/executing plans guidance that the retired
// Superpowers skills used to supply, so no turn has to load a skill first.
describe('primary agent plan guidance', () => {
  it.each([
    ['orchestrator', '<Plan Writing>', '<Plan Execution>'],
    ['builder', '**Plan Writing**', '**Plan Execution**'],
    ['plan', 'Plan writing:', 'Plan execution:'],
  ])('%s carries plan writing and plan execution guidance', (agent, writing, execution) => {
    const prompt = readAgent(agent);
    expect(prompt).toContain(writing);
    expect(prompt).toContain(execution);
    expect(prompt).toContain('test-first');
    expect(prompt).toContain('No placeholders');
    expect(prompt).toContain('root cause');
    expect(prompt).toContain('plan_read');
    expect(prompt).not.toMatch(/superpowers|writing-plans|executing-plans/i);
  });

  it('keeps plan execution on the saved revision and managed phases for Orchestrator', () => {
    const prompt = readAgent('orchestrator');
    const execution = prompt.slice(prompt.indexOf('<Plan Execution>'), prompt.indexOf('</Plan Execution>'));
    expect(execution).toContain('The selected saved revision is the source of truth');
    expect(execution).toContain('Approved-plan implementation startup:');
    expect(execution).toContain('Start a dependent phase only after its dependency is terminal and dispositioned');
    expect(execution).toContain("run the plan's Verification section once across scopes");
    expect(prompt).toContain('never a skill loaded first');
    expect(prompt).not.toContain('Orchestrator loads planning and routing skills');
  });
});
