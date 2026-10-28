import { readFileSync } from 'node:fs';
import { MANAGED_RECOVERY_INSTRUCTIONS } from '@devryan/orchestration-runtime';
import { describe, expect, it } from 'vitest';

const readAgent = (name) => readFileSync(new URL(`./${name}.md`, import.meta.url), 'utf8');

describe('bundled agent tool recovery guidance', () => {
  it.each(['fixer', 'designer'])('preserves declared commands and environment-only Docker skips for %s', (name) => {
    const prompt = readAgent(name);
    expect(prompt).toContain('Run declared acceptance commands unchanged, with declared cwd/environment');
    expect(prompt).toContain('supplemental checks never replace receipts');
    expect(prompt).toContain('Ask Orchestrator to correct mistaken commands');
    expect(prompt).toContain('Preserve failing receipts/reasons');
    expect(prompt).toContain('only host-attested Docker daemon/socket or UID-map prerequisites');
    expect(prompt).toContain('environment_unavailable skips, never passes');
    expect(prompt).toContain('return `**Status:** complete` with deferred reasons');
    expect(prompt).toContain('Unproven prerequisites stay pending');
    expect(prompt).not.toContain('leave verification pending, and continue independent checks');
    expect(prompt).toContain('SQL, assertions and application errors remain failures');
    expect(prompt).toContain('retry only affected checks');
  });

  it('accepts host-attested prerequisite skips without treating defects or missing evidence as passes', () => {
    const prompt = readAgent('orchestrator');
    expect(prompt).toContain('Only host-attested Docker daemon/socket or UID-map skips from exact failing receipts');
    expect(prompt).toContain('allow complete with deferred check reasons after implementation/available checks finish');
    expect(prompt).toContain('never invent skips or passes');
    expect(prompt).toContain('Missing evidence stays pending');
    expect(prompt).toContain('SQL, assertion and application defects remain failures');
  });

  it('keeps parked Orchestrator output brief while the task card owns recovery controls', () => {
    const prompt = readAgent('orchestrator');
    // Recovery wording travels with the failed result, not the static prompt.
    expect(prompt).toContain('following the `instruction` the failed result carries');
    expect(MANAGED_RECOVERY_INSTRUCTIONS.manual).toContain('at most one brief status sentence');
    expect(MANAGED_RECOVERY_INSTRUCTIONS.manual).toContain('Do not repeat recovery instructions');
    expect(prompt).not.toContain('Do not repeat recovery instructions');
    expect(prompt).toContain('DevRyan owns automatic recovery');
    expect(prompt).not.toContain('tell the user to choose a model');
    expect(prompt).not.toContain('click Try Again');
  });
  it('requires Explorer to use exact discovered paths and one bounded ENOENT correction', () => {
    const explorer = readAgent('explorer');
    expect(explorer).toContain('Never synthesize paths from naming conventions or nearby files');
    expect(explorer).toContain('For read/grep/glob, use only paths supplied by the user/Orchestrator or returned exactly');
    expect(explorer).toContain('perform one bounded basename or symbol rediscovery from a verified parent');
    expect(explorer).toContain('retry once using only the exact returned path');
    expect(explorer).toContain('`grep.path` accepts exactly one path');
    expect(explorer).toContain('never concatenate paths');
    expect(explorer).toContain('DEVRYAN_TOOL_INPUT_INVALID');
    expect(explorer).toContain('never replay the rejected arguments unchanged');
  });

  it('batches Explorer discovery and grounds every claim in path:line evidence', () => {
    const explorer = readAgent('explorer');
    expect(explorer).toContain('Batch independent globs, greps, and reads in one step (aim for 5-10 calls)');
    expect(explorer).toContain('Back every claim in `## Answer` with a `path:line` entry under `## Files`.');
    expect(explorer).toContain('## Open questions');
  });

  it.each(['designer', 'fixer'])('reuses one dev server and a warm browser page for %s', (agent) => {
    const prompt = readAgent(agent);
    expect(prompt).toContain('Reuse one dev server: if its port already serves, start no other.');
    expect(prompt).toContain('checks use one warm `devryan_browser` page; Playwright runs only the final verification.');
  });

  it('requires Orchestrator to correct guarded grep inputs once', () => {
    const orchestrator = readAgent('orchestrator');
    expect(orchestrator).toContain('`grep.path` accepts exactly one path');
    expect(orchestrator).toContain('DEVRYAN_TOOL_INPUT_INVALID');
    expect(orchestrator).toContain('retry once');
    expect(orchestrator).toContain('never replay the rejected arguments unchanged');
  });

  it.each(['explorer', 'orchestrator'])('bounds missing-path discovery and recovery for %s', (agent) => {
    const prompt = readAgent(agent);
    expect(prompt).toContain('unknown folders from a verified parent');
    expect(prompt).toContain('For read/grep/glob ENOENT or missing search path');
    expect(prompt).toContain('perform one bounded basename or symbol rediscovery from a verified parent');
    expect(prompt).toContain('retry once using only the exact returned path');
    expect(prompt).toContain('never replay or silently broaden the failed request');
  });

  it('requires Orchestrator to refresh every direct patch target after specialist work', () => {
    const orchestrator = readAgent('orchestrator');
    expect(orchestrator).toContain('Specialist reports, quoted source, line references, and earlier reads are navigation context, not authoritative patch context');
    expect(orchestrator).toContain('immediately before a direct patch, read the current narrow hunk for every target');
    expect(orchestrator).toContain('Before the final Oracle checkpoint, route remediation and related test updates by the routing policy.');
    expect(orchestrator).not.toContain('Keep coherent remediation, localization, and related test updates direct');
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

  it.each(['builder', 'fixer', 'orchestrator'])('names confined write locations and forbids stopping on EPERM for %s', (agent) => {
    const prompt = readAgent(agent);
    expect(prompt).toContain('including gitignored output folders such as `.artifacts/`');
    expect(prompt).toContain('`$DEVRYAN_SESSION_TMP` (kept for the session)');
    expect(prompt).toContain('`/tmp`, and paths outside the workspace are read-only');
    expect(prompt).toContain('retry once with the log, output, or cache in a writable location');
    expect(prompt).toContain('never stop to ask the user to restore access');
  });

  it.each(['builder', 'designer', 'fixer', 'orchestrator'])('keeps %s in its mapped view and fails fast before readiness polling', (agent) => {
    const prompt = readAgent(agent);
    expect(prompt).toContain('mapped shell `$PWD`');
    expect(prompt).toContain('never `cd` to the absolute project path');
    expect(prompt).toContain('$DEVRYAN_SESSION_TMP');
    expect(prompt).toContain('$TMPDIR');
    expect(prompt).toContain('Fail fast on temp/server setup errors');
    expect(prompt).toContain('poll readiness only after successful launch');
  });
});
