import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import yaml from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(__dirname, '../../default-config/agents');

const LOCAL_PATH_PATTERNS = [
  /(^|[\s"'`])\/Users\//,
  /(^|[\s"'`])\/home\//,
  /(^|[\s"'`])\/private\//,
  /(^|[\s"'`])\/var\/folders\//,
  /(^|[\s"'`])~\//,
  /(^|[\s"'`])[A-Za-z]:\\Users\\/,
];

function containsLocalMachinePath(value) {
  return LOCAL_PATH_PATTERNS.some((pattern) => pattern.test(value));
}

function readPackagedAgent(name) {
  const content = fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  expect(match).toBeTruthy();
  return {
    content,
    frontmatter: yaml.parse(match[1]) || {},
    body: match[2],
  };
}

describe('packaged agent defaults', () => {
  it('detects common user-local path forms', () => {
    expect(containsLocalMachinePath('external_directory: /Users/dev/.codex/skills')).toBe(true);
    expect(containsLocalMachinePath('external_directory: /home/dev/.codex/skills')).toBe(true);
    expect(containsLocalMachinePath('external_directory: /private/var/folders/dev/skills')).toBe(true);
    expect(containsLocalMachinePath('external_directory: /var/folders/dev/skills')).toBe(true);
    expect(containsLocalMachinePath('external_directory: ~/.codex/skills')).toBe(true);
    expect(containsLocalMachinePath('external_directory: C:\\Users\\dev\\.codex\\skills')).toBe(true);
    expect(containsLocalMachinePath('external_directory: /opt/devryan/skills')).toBe(false);
  });

  it('do not ship user-specific absolute external-directory permissions', () => {
    const offenders = [];

    for (const entry of fs.readdirSync(AGENTS_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const filePath = path.join(AGENTS_DIR, entry.name);
      const content = fs.readFileSync(filePath, 'utf8');
      for (const [index, line] of content.split('\n').entries()) {
        if (containsLocalMachinePath(line)) {
          offenders.push(`${entry.name}:${index + 1}:${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('orchestrator requires a terminal work summary', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'orchestrator.md'), 'utf8');

    expect(content).toContain('<Completion Contract>');
    expect(content).toContain('finish every completed work turn');
    expect(content).toContain('<summary>');
    expect(content).toContain('<verification>');
  });

  it('council reconciles plan-mode prompts with its required council report', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'council.md'), 'utf8');

    expect(content).toContain('Plan-mode council requests');
    expect(content).toContain('<!--plan-->');
    expect(content).toContain('Councillor Details');
    expect(content).toContain('Council Summary');
    expect(content).toContain('immediately before the final plan body');
  });

  it('orchestrator prompt stays condensed while preserving routing contracts', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'orchestrator.md'), 'utf8');
    const lineCount = content.trimEnd().split('\n').length;

    expect(lineCount).toBeLessThanOrEqual(260);
    expect(content).toContain('Simple requests: do the work yourself');
    expect(content).toContain('Design-quality UI work: route to `designer`');
    expect(content).toContain('Context:');
    expect(content).toContain('Starting points:');
    expect(content).toContain('Return:');
    expect(content).toContain('<status>complete</status>');
    expect(content).toContain('No-mutation plans must keep snapshots and logs outside the target workspace');
  });

  it('grants managed delegation only to orchestrator and keeps provider-native work distinct', () => {
    const orchestrator = readPackagedAgent('orchestrator');
    expect(orchestrator.frontmatter.permission.devryan_task).toBe('allow');
    expect(orchestrator.content).toContain('DevRyan-managed delegation');
    expect(orchestrator.content).toContain('provider-native');
    expect(orchestrator.content).toContain('no more than three');

    for (const agentName of ['builder', 'council', 'designer', 'explorer', 'fixer', 'librarian', 'oracle', 'plan']) {
      expect(readPackagedAgent(agentName).frontmatter.permission.devryan_task, agentName).toBe('deny');
    }
  });

  it('orchestrator asks on consequential ambiguity without over-analyzing', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'orchestrator.md'), 'utf8');

    expect(content).toContain('Clarify intent before consequential choices.');
    expect(content).toContain('Ask when ambiguity affects user-visible outcome');
    expect(content).toContain('Infer only reversible implementation details');
    expect(content).toContain('Do not build long speculative option trees');
    expect(content).toContain('Do not re-litigate settled decisions');
    expect(content).toContain('Ask one focused structured question before analyzing branches that depend on the missing answer.');
    expect(content).toContain('Pick exactly one next action: ask, inspect, delegate, implement, verify, or finish.');
  });

  it('orchestrator owns planning and asks Explorer only for context locations', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'orchestrator.md'), 'utf8');

    expect(content).toContain('Orchestrator owns planning');
    expect(content).toContain('migration candidates if relevant');
    expect(content).toContain('Do not ask Explorer to plan');
    expect(content).not.toContain('likely edit points');
  });

  it('orchestrator requires Explorer for unknown discovery in normal and plan modes', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'orchestrator.md'), 'utf8');

    expect(content).toContain('Unknown codebase location: call `explorer` before broad direct search.');
    expect(content).toContain('Unknown file/code discovery in plan mode also routes to `explorer`; keep the rest of the turn read-only and produce only the plan.');
    expect(content).toContain('Direct inspection is allowed only for codemap-identified targets, exact known paths, exact symbols in 1-2 files, or one narrow `read`/`grep`.');
    expect(content).toContain('If Explorer is unavailable in the task tool choices, report that blocker before doing broad direct search.');
    expect(content).toContain('Do not phrase unknown discovery as optional between Explorer and broad direct search.');
    expect(content).not.toContain('delegate to `explorer` or look yourself');
  });

  it('explorer is constrained to context discovery only', () => {
    const { content, frontmatter } = readPackagedAgent('explorer');

    expect(content).toContain('Context-only mission');
    expect(content).toContain('relevant context locations');
    expect(content).toContain('<migration_candidates>');
    expect(content).toContain('Do not create or modify files');
    expect(content).toContain('Do not produce plans');
    expect(content).not.toContain('likely edit points');
    expect(content).not.toContain('test strategy');
    expect(content).not.toContain('implementation plan');
    expect(content).not.toContain('next implementation steps');
    expect(frontmatter.permission).toMatchObject({
      '*': 'deny',
      read: {
        '*': 'allow',
        '*.env': 'ask',
        '*.env.*': 'ask',
        '*.env.example': 'allow',
      },
      write: 'deny',
      edit: 'deny',
      patch: 'deny',
      apply_patch: 'deny',
      bash: 'deny',
      task: { '*': 'deny' },
      plan_enter: 'deny',
      plan_exit: 'deny',
      council_session: 'deny',
    });
    expect(frontmatter.permission).not.toHaveProperty('websearch_*');
    expect(frontmatter.permission).not.toHaveProperty('context7_*');
    expect(frontmatter.permission).not.toHaveProperty('grep_app_*');
  });

  it('specialist prompts stay compact while preserving terminal-status guardrails', () => {
    for (const agentName of ['designer', 'explorer', 'fixer', 'librarian', 'oracle']) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, `${agentName}.md`), 'utf8');
      const lineCount = content.trimEnd().split('\n').length;

      expect(lineCount, `${agentName}.md line count`).toBeLessThanOrEqual(95);
      expect(content).toContain('On unrecoverable provider/tool errors, return `<status>blocked</status>` with a concise reason.');
      expect(content).toContain('Avoid repeated progress-only messages such as "continuing" or "implementing" without a terminal status marker.');
      expect(content).toContain('Do not use `git status`, `git diff`, `git diff --stat`, or `git diff --check` to determine whether you made edits.');
    }
  });

  it('agents that load skills avoid self-referential visible reasoning status lines', () => {
    for (const agentName of ['orchestrator', 'builder', 'designer', 'explorer', 'fixer', 'oracle']) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, `${agentName}.md`), 'utf8');

      expect(content).toContain('Skill announcements are tool activity only');
      expect(content).toContain('do not write assistant text to announce skill use');
      expect(content).toContain('Do not write visible reasoning/status lines that restate the same action and target');
      expect(content).toContain('the tool activity already shows skill loading, file inspection, and specialist routing');
      expect(content).not.toContain('Do not write assistant prose announcing that you are loading a skill, using a skill, or about to invoke a specialist');
      expect(content).toContain('Do not write visible reasoning about balancing skill instructions against developer or agent instructions');
    }
  });
});
