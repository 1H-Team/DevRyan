import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readAgent = (name) => readFileSync(new URL(`./${name}.md`, import.meta.url), 'utf8');

describe('bundled agent tool recovery guidance', () => {
  it('keeps parked Orchestrator output brief while the task card owns recovery controls', () => {
    const prompt = readAgent('orchestrator');
    expect(prompt).toContain('at most one brief status sentence');
    expect(prompt).toContain('Do not repeat recovery instructions');
    expect(prompt).toContain('DevRyan owns automatic recovery');
    expect(prompt).not.toContain('tell the user to choose a model');
    expect(prompt).not.toContain('click Try Again');
  });
  it('requires Explorer to use exact discovered paths and one bounded ENOENT correction', () => {
    const explorer = readAgent('explorer');
    expect(explorer).toContain('Never synthesize an exact path from a naming convention');
    expect(explorer).toContain('perform one basename or symbol rediscovery');
    expect(explorer).toContain('retry once using only the exact returned path');
    expect(explorer).toContain('`grep.path` accepts exactly one path');
    expect(explorer).toContain('Never concatenate multiple paths');
    expect(explorer).toContain('DEVRYAN_TOOL_INPUT_INVALID');
    expect(explorer).toContain('never replay the rejected arguments unchanged');
  });

  it('requires Orchestrator to correct guarded grep inputs once', () => {
    const orchestrator = readAgent('orchestrator');
    expect(orchestrator).toContain('`grep.path` accepts exactly one path');
    expect(orchestrator).toContain('DEVRYAN_TOOL_INPUT_INVALID');
    expect(orchestrator).toContain('retry once');
    expect(orchestrator).toContain('never replay the rejected arguments unchanged');
  });

  it('requires Orchestrator to refresh every direct patch target after specialist work', () => {
    const orchestrator = readAgent('orchestrator');
    expect(orchestrator).toContain('Specialist reports, quoted source, line references, and earlier reads are navigation context, not authoritative patch context');
    expect(orchestrator).toContain('immediately before a direct patch, read the current narrow hunk for every target');
    expect(orchestrator).toContain('Keep coherent remediation, localization, and related test updates direct');
    expect(orchestrator).toContain('and retry once; never replay the failed patch unchanged');
    expect(orchestrator).toContain('If the refreshed retry also mismatches, stop direct mutation and report concurrent modification');
  });

  it.each(['builder', 'fixer', 'orchestrator'])('bounds patch-context recovery for %s', (agent) => {
    const prompt = readAgent(agent);
    expect(prompt).toContain('After a patch-context mismatch, reread only the narrow target hunk');
  });

  it.each(['builder', 'fixer', 'orchestrator'])('bounds unknown-outcome recovery and test runs for %s', (agent) => {
    const prompt = readAgent(agent);
    expect(prompt).toContain("If a tool's execution outcome is unknown, inspect current state before any mutation or retry");
    expect(prompt).toContain('never replay the failed command automatically');
    expect(prompt).toContain('Keep large test runs bounded to one test command or group and report between runs');
    expect(prompt).toContain('Never wrap an entire test matrix in one synchronous `spawnSync` or `execSync` loop');
  });

  it.each(['builder', 'council', 'designer', 'explorer', 'fixer', 'librarian', 'oracle', 'orchestrator', 'plan'])('carries no Context Mode tool guidance for %s', (agent) => {
    const prompt = readAgent(agent);
    expect(prompt).not.toMatch(/context[ _-]mode|ctx_[a-z]/i);
  });

  it.each(['builder', 'fixer', 'orchestrator'])('requires repository-sanctioned bounded shell work for %s', (agent) => {
    const prompt = readAgent(agent);
    expect(prompt).toContain("read and follow the repository's documented command, skill, or script");
    expect(prompt).toContain('Never replace a sanctioned migration workflow with an ad hoc database container or one-off harness');
    expect(prompt).toContain('every shell invocation to one bounded command or group');
    expect(prompt).toContain('four-minute default deadline');
    expect(prompt).toContain('up to sixty minutes');
  });
});
