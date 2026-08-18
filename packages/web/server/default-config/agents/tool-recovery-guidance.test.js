import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readAgent = (name) => readFileSync(new URL(`./${name}.md`, import.meta.url), 'utf8');

describe('bundled agent tool recovery guidance', () => {
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

  it('requires Orchestrator to correct guarded grep and context-mode inputs once', () => {
    const orchestrator = readAgent('orchestrator');
    expect(orchestrator).toContain('`grep.path` accepts exactly one path');
    expect(orchestrator).toContain('Keep context-mode JavaScript small and syntactically complete');
    expect(orchestrator).toContain('DEVRYAN_TOOL_INPUT_INVALID');
    expect(orchestrator).toContain('retry once');
    expect(orchestrator).toContain('never replay the rejected arguments unchanged');
  });

  it('requires Orchestrator to refresh every direct patch target after specialist work', () => {
    const orchestrator = readAgent('orchestrator');
    expect(orchestrator).toContain('Specialist reports, quoted source, line references, and earlier reads are navigation context, not authoritative patch context');
    expect(orchestrator).toContain('immediately before a direct patch, read the current narrow hunk for every target');
    expect(orchestrator).toContain('Multi-file review remediation, localization, or test updates are not tiny direct edits');
    expect(orchestrator).toContain('and retry once; never replay the failed patch unchanged');
    expect(orchestrator).toContain('If the refreshed retry also mismatches, stop direct mutation and report concurrent modification');
  });

  it.each(['builder', 'fixer', 'orchestrator'])('bounds patch-context recovery for %s', (agent) => {
    const prompt = readAgent(agent);
    expect(prompt).toContain('After a patch-context mismatch, reread only the narrow target hunk');
  });

  it.each(['builder', 'fixer', 'orchestrator'])('bounds context-mode recovery for %s', (agent) => {
    const prompt = readAgent(agent);
    expect(prompt).toContain('do not retry any `ctx_*` tool for the rest of the turn');
    expect(prompt).not.toContain('Retry a context-mode SQLite or disk I/O failure once only');
    expect(prompt).toMatch(/continue with native read\/search tools/i);
    expect(prompt).toContain('Never automatically replay a potentially mutating context-mode command');
    expect(prompt).toContain('keep each `ctx_execute` call bounded to one test command or group');
    expect(prompt).toContain('report between calls');
    expect(prompt).toContain('Never wrap an entire test matrix in one synchronous `spawnSync` or `execSync` loop');
  });

  it.each(['builder', 'fixer', 'orchestrator'])('requires repository-sanctioned bounded shell work for %s', (agent) => {
    const prompt = readAgent(agent);
    expect(prompt).toContain("read and follow the repository's documented command, skill, or script");
    expect(prompt).toContain('Never replace a sanctioned migration workflow with an ad hoc database container or one-off harness');
    expect(prompt).toContain('every shell invocation to one bounded command or group');
    expect(prompt).toContain('four-minute default deadline');
    expect(prompt).toContain('up to sixty minutes');
  });

  it('gives Orchestrator a safe fallback after a context-mode storage failure', () => {
    const orchestrator = readAgent('orchestrator');
    expect(orchestrator).toContain('SQLite, disk I/O, or database-is-locked failure');
    expect(orchestrator).toContain('native read/search tools or appropriately scoped specialist discovery');
    expect(orchestrator).toContain('Report a blocker only when neither safe fallback can satisfy the task');
  });
});
