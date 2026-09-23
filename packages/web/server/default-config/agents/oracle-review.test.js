import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readAgent = (name) => readFileSync(new URL(`./${name}.md`, import.meta.url), 'utf8');

describe('bundled Oracle review precision', () => {
  it('treats the finding limits as ceilings and accepts a clean review', () => {
    const oracle = readAgent('oracle');
    expect(oracle).toContain('do not manufacture speculative findings');
    expect(oracle).toContain('The finding limits are ceilings: zero actionable findings is a valid review.');
  });

  it('attributes findings to the reviewed change without excluding failures in unchanged code', () => {
    const oracle = readAgent('oracle');
    expect(oracle).toContain('Attribute each finding to the reviewed change.');
    expect(oracle).toContain('A failure that surfaces in unchanged code counts when the change causes or exposes it');
    expect(oracle).toContain('report unrelated pre-existing defects only when critical, labeled pre-existing');
    expect(oracle).not.toMatch(/no findings on unchanged code/i);
  });

  it('keeps severity tied to impact and separates verified findings from unverified risks', () => {
    const oracle = readAgent('oracle');
    expect(oracle).toContain('Set severity by impact and state confidence separately');
    expect(oracle).toContain('incomplete proof lowers confidence, not severity');
    expect(oracle).toContain('Keep verified findings apart from unverified risks');
    expect(oracle).toContain('name the evidence that would confirm each risk');
  });

  it('scopes the output rules to code review', () => {
    const oracle = readAgent('oracle');
    expect(oracle).toContain('These output rules apply to code review.');
    expect(oracle).toContain('Plan and architecture advice may cite design evidence instead of `path:line`.');
  });
});
