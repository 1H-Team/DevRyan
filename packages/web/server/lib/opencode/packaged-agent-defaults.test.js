import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import yaml from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(__dirname, '../../default-config/agents');
const PRE_TASK_ORCHESTRATOR_PROMPT_UTF8_BYTES = 15_902;
const EXPECTED_ORCHESTRATOR_PROMPT_UTF8_BYTES = 23_290;
const DEFAULT_SLIM_PROFILE_PATH = path.resolve(
  __dirname,
  '../../default-config/user-profile/oh-my-opencode-slim.json',
);

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

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
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
    expect(content).toContain('Designer owns every design change end to end');
    expect(content).toContain('Context:');
    expect(content).toContain('Starting points:');
    expect(content).toContain('Return:');
    expect(content).toContain('<status>complete</status>');
    expect(content).toContain('No-mutation plans must keep snapshots and logs outside the target workspace');
    expect(content).toContain(
      'start it before any standalone todo read/write whose only purpose is to restate that delegation',
    );
    expect(content).toContain('Oracle review gate:');
    expect(content).toContain('Review depth: focused | deep');
    expect(content).toContain('Do not ask Oracle to rerun tests, builds, lint, or type-checking');
  });

  it('keeps Designer responsible for design planning through implementation', () => {
    const orchestrator = readPackagedAgent('orchestrator');
    const designer = readPackagedAgent('designer');
    const fixer = readPackagedAgent('fixer');

    expect(orchestrator.body).toContain('Designer owns every design change end to end');
    expect(orchestrator.body).toContain('Never hand a Designer-produced plan or review to Fixer for implementation.');
    expect(orchestrator.body).toContain('route that work back to Designer in normal mode');
    expect(orchestrator.body).toContain('UI correctness bugs with no visual judgment route to `fixer`.');
    expect(orchestrator.body).toContain('For mixed work, create disjoint scopes');
    expect(orchestrator.body).toContain('If Designer remains unavailable after the existing managed recovery, report the blocker');
    expect(orchestrator.body).toContain('Design-change planning in plan mode routes to a read-only Designer task.');
    expect(orchestrator.body).toContain('Non-design implementation gate');
    expect(orchestrator.body).not.toContain('Fixer-first implementation gate');

    expect(designer.body).toContain('End-to-end design-change ownership');
    expect(designer.body).toContain('then edit the code, add or update the design-specific tests, and validate the visible result');
    expect(designer.body).toContain('If the assignment provides an approved design plan, implement it instead of returning another proposal.');
    expect(designer.body).toContain('explicitly plan-only or review-only, remain read-only');

    expect(fixer.body).toContain("Implement the Orchestrator's non-design task specification");
    expect(fixer.body).toContain('frontend data/state/logic and component correctness');
    expect(fixer.body).toContain('make no design edits and return `<status>blocked</status>`');
    expect(fixer.body).toContain('work only on an explicitly disjoint non-design scope');
  });

  it('makes Oracle focused and high-reasoning by default without weakening deep review', () => {
    const { content, frontmatter } = readPackagedAgent('oracle');
    const slimProfile = JSON.parse(fs.readFileSync(DEFAULT_SLIM_PROFILE_PATH, 'utf8'));

    expect(frontmatter.variant).toBe('high');
    expect(slimProfile.agents.oracle).toEqual({
      model: 'openai/gpt-5.6-sol',
      variant: 'high',
    });
    expect(content).toContain('Focused is the default.');
    expect(content).toContain('Review depth: deep');
    expect(content).toContain('30 completed tool calls');
    expect(content).toContain('80 completed tool calls');
    expect(content).toContain('Do not run tests, builds, linters, type-checks, or broad validation');
    expect(content).toContain('at most five actionable findings');
    expect(content).toContain('path:line');
  });

  it('puts correctness and reliability gates before efficiency and cost', () => {
    const { body } = readPackagedAgent('orchestrator');
    const correctnessGate = 'Correctness and reliability are hard gates.';
    const efficiencyPriority = 'Once both hold, optimize latency and resource efficiency, then cost.';

    expect(body).toContain(correctnessGate);
    expect(body).toContain(efficiencyPriority);
    expect(body.indexOf(correctnessGate)).toBeLessThan(body.indexOf(efficiencyPriority));
    expect(body).not.toContain('optimizing for quality, speed, cost, and reliability — in that order');
  });

  it('keeps one authoritative occurrence of each consolidated prompt policy', () => {
    const { body } = readPackagedAgent('orchestrator');
    const canonicalRules = [
      '**Question routing.**',
      '**Skill announcement rule.**',
      '**Visible reasoning rule.**',
      '**Plan approval.**',
    ];

    for (const rule of canonicalRules) {
      expect(countOccurrences(body, rule), rule).toBe(1);
    }

    expect(countOccurrences(body, 'structured question tool')).toBe(1);
    expect(countOccurrences(body, 'Skill announcements are tool activity only')).toBe(1);
    expect(countOccurrences(body, 'Honor the DevRyan rationale-display reminder captured in the first user turn')).toBe(1);
    expect(countOccurrences(body, 'Explain why instead of merely repeating the tool action')).toBe(1);
    expect(countOccurrences(body, 'Never expose or claim to expose private chain-of-thought')).toBe(1);
    expect(countOccurrences(body, 'Approval belongs only to the plan card lifecycle')).toBe(1);
    expect(body).toContain('Do not guess user-owned intent, ask about trivial, reversible mechanics, or request permission for already-approved mechanical steps; when the next step is clear, take it.');
    expect(body).not.toContain('**Clarify unresolved user intent.**');
    expect(body).not.toContain('**Formulating questions.**');
  });

  it('gives grounded implementation decisions precedence over user-owned question routing', () => {
    const { body } = readPackagedAgent('orchestrator');
    const questionRule = body.split('\n').find((line) => line.startsWith('**Question routing.**')) ?? '';
    const planApprovalRule = body.split('\n').find((line) => line.startsWith('- **Plan approval.**')) ?? '';
    const planModeStart = body.indexOf('<Plan Mode>');
    const planModeEnd = body.indexOf('</Plan Mode>');
    const planMode = body.slice(planModeStart, planModeEnd);

    expect(`${questionRule}\n${planApprovalRule}`).toMatch(
      /Ask through the structured question tool only when unresolved user-owned intent, requirements, preferences, or choices would materially change scope, the user-visible outcome, external effects, or an irreversible tradeoff[\s\S]*Do not ask the user to ratify an implementation approach or plan already grounded by the requested outcome; defer to the Plan approval rule\.[\s\S]*\n- \*\*Plan approval\.\*\* When the requested outcome already provides sufficient intent to ground a design, implementation approach, or plan, do not ask the user to ratify it through assistant prose or a question tool in normal mode; take the grounded next step\./,
    );
    expect(questionRule).not.toContain('competing implementation approaches');
    expect(body.indexOf(planApprovalRule)).toBeLessThan(planModeStart);
    expect(planMode).toContain('Follow the canonical Plan approval rule above.');
  });

  it('requires mutually exclusive options for every structured question', () => {
    const { body } = readPackagedAgent('orchestrator');
    const questionRule = body.split('\n').find((line) => line.startsWith('**Question routing.**')) ?? '';

    expect(questionRule).toContain('Batch 1–3 focused questions, each with 2–3 mutually exclusive, concrete, decision-ready options.');
    expect(questionRule).not.toContain('Batch 1–3 focused questions with 2–3');
  });

  it('preserves the complete Orchestrator frontmatter and always-on execution contracts', () => {
    const { body, frontmatter } = readPackagedAgent('orchestrator');

    expect(frontmatter).toEqual({
      mode: 'primary',
      description: 'AI coding orchestrator that delegates tasks to specialist agents for optimal quality, speed, and cost',
      model: 'openai/gpt-5.5',
      variant: 'medium',
      temperature: 0.1,
      permission: {
        '*': 'allow',
        doom_loop: 'ask',
        external_directory: { '*': 'ask' },
        plan_enter: 'deny',
        plan_exit: 'deny',
        question: 'allow',
        'question_*': 'allow',
        read: {
          '*.env': 'ask',
          '*.env.*': 'ask',
          '*.env.example': 'allow',
        },
        task: 'deny',
        council_session: 'deny',
        devryan_task: 'allow',
        skill: {
          'agent-browser': 'allow',
          'browser-testing-with-devtools': 'allow',
          'code-simplification': 'allow',
          'debugging-and-error-recovery': 'allow',
          'deprecation-and-migration': 'allow',
          'frontend-design': 'allow',
          'dashboard-design': 'allow',
          'component-patterns': 'allow',
          accessibility: 'allow',
          'frontend-ui-engineering': 'allow',
          'planning-and-task-breakdown': 'allow',
          'dispatching-parallel-agents': 'allow',
          supabase: 'allow',
          'supabase-postgres-best-practices': 'allow',
          'using-agent-skills': 'allow',
        },
      },
      modelRefs: ['openai/gpt-5.5'],
    });

    for (const contract of [
      '**DevRyan-managed delegation.**',
      'at most one managed recovery',
      'never change its model automatically',
      'choose a model and thinking level in Model Recovery and click Try Again',
      'DevRyan will send one synthetic continuation after the recovered child settles',
      'A collected `provider_prompt_rejected` failure is context-specific',
      'compact, semantically complete task capsule',
      'preserve the configured agent, model, and thinking level',
      'do not retry again or enter Model Recovery solely for prompt rejection',
      '**Managed dispatch barrier.**',
      'Only after every result is dispositioned may you resume local work',
      'Allowed subagents: `explorer`, `librarian`, `oracle`, `designer`, `fixer`, `council`.',
      '<Git Command Boundary>',
      'Do not run git commands as a default finalization or safety routine.',
      '<Completion Contract>',
      'Always finish every completed work turn with a concise user-facing final response.',
      '<Routing>',
      '- `explorer`:',
      '- `librarian`:',
      '- `oracle`:',
      '- `designer`:',
      '- `fixer`:',
      '- `council`:',
      '<Plan Mode>',
      'When the user asks only for a plan, do not edit files.',
      'Once the plan is finished, stop after presenting it.',
      'Ask every delegated subagent to end with exactly one terminal status marker: `<status>complete</status>` or `<status>blocked</status>`.',
      'Use only real runtime tools.',
      'Provider-native `task` is unavailable to Orchestrator.',
      'Never use `general-purpose`.',
    ]) {
      expect(body, contract).toContain(contract);
    }
    expect(body).not.toContain('use `recover_in_place`');
  });

  it('records exact historical and current Orchestrator UTF-8 byte counts', () => {
    const { content } = readPackagedAgent('orchestrator');
    const afterBytes = Buffer.byteLength(content, 'utf8');

    expect({
      beforeBytes: PRE_TASK_ORCHESTRATOR_PROMPT_UTF8_BYTES,
      afterBytes,
    }).toEqual({
      beforeBytes: 15_902,
      afterBytes: EXPECTED_ORCHESTRATOR_PROMPT_UTF8_BYTES,
    });
    expect(new TextEncoder().encode(content).byteLength).toBe(EXPECTED_ORCHESTRATOR_PROMPT_UTF8_BYTES);
  });

  it('grants managed delegation only to orchestrator and disables its provider-native task tool', () => {
    const orchestrator = readPackagedAgent('orchestrator');
    expect(orchestrator.frontmatter.permission.devryan_task).toBe('allow');
    expect(orchestrator.frontmatter.permission.task).toBe('deny');
    expect(orchestrator.content).toContain('DevRyan-managed delegation');
    expect(orchestrator.content).toContain('Provider-native `task` is disabled for Orchestrator');
    expect(orchestrator.content).toContain('does not impose an artificial managed concurrency cap');

    for (const agentName of ['builder', 'council', 'designer', 'explorer', 'fixer', 'librarian', 'oracle', 'plan']) {
      expect(readPackagedAgent(agentName).frontmatter.permission.devryan_task, agentName).toBe('deny');
    }
  });

  it('requires managed dispatches to be waited, collected, and dispositioned before local work', () => {
    const content = readPackagedAgent('orchestrator').content;

    expect(content).toContain('Start all independent managed tasks first');
    expect(content).toContain('wait for every dispatched task');
    expect(content).toContain('Disposition every collected non-provider-limit result');
    expect(content).toContain(
      'Each `wait` stays attached while DevRyan repeats bounded polling slices internally',
    );
    expect(content).toContain('use `status` only when a non-blocking live snapshot is explicitly needed');
    expect(content).toContain('Only after every result is dispositioned may you resume local work');
    expect(content).toContain('successful result requires `continue` after `wait`');
  });

  it('requires managed deadlines to match delegated scope', () => {
    const content = readPackagedAgent('orchestrator').content;

    expect(content).toContain('Size `timeout_seconds` to the delegated work');
    expect(content).toContain('1,800 seconds for read-only discovery and small bounded fixes');
    expect(content).toContain('3,600 seconds for multi-file implementation plus tests');
    expect(content).toContain('7,200 seconds when the same child also owns builds');
  });

  it('never presents provider-native delegation as an Orchestrator path', () => {
    const content = readPackagedAgent('orchestrator').content;

    expect(content).toContain('consume its partial output');
    expect(content).toContain('at most one managed recovery');
    expect(content).toContain('prefer `resume` only for a resumable timed-out or interrupted result');
    expect(content).toContain('never use `resume`, `recover_in_place`, or `retry_in_place`');
    expect(content).toContain('Number steps only when their order is a real dependency.');
    expect(content).toContain('Provider-native `task` is disabled for Orchestrator');
    expect(content).toContain('Provider-native `task` is unavailable to Orchestrator');
    expect(content).not.toContain('explicit current-user request');
  });

  it('keeps Builder ambiguity handling while scoping Orchestrator questions to material user-owned choices', () => {
    const builder = fs.readFileSync(path.join(AGENTS_DIR, 'builder.md'), 'utf8');
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'orchestrator.md'), 'utf8');

    expect(builder).toContain('Inspect repository and system facts that could resolve the ambiguity before asking.');
    expect(builder).toContain('multiple plausible interpretations remain and the user can resolve them');
    expect(builder).toContain('even when the ambiguity is not a hard blocker');
    expect(content).toContain('Inspect repository and system facts that could resolve uncertainty before asking.');
    expect(content).toContain('unresolved user-owned intent, requirements, preferences, or choices would materially change');
    expect(content).toContain('even when work is not otherwise blocked');

    for (const prompt of [builder, content]) {
      expect(prompt).toContain('If the user skips a question, continue with best judgment and explicitly state the assumption.');
      expect(prompt).not.toContain('Ask only when truly blocked');
    }
    expect(content).toContain('Infer only trivial, reversible implementation details');
    expect(content).not.toContain('Clarify intent before consequential choices.');
    expect(content).toContain('Do not build long speculative option trees');
    expect(content).toContain('Do not re-litigate settled decisions');
    expect(content).toContain('**Question routing.**');
    expect(content).toContain('Pick exactly one next action: ask, inspect, delegate, implement, verify, or finish.');
  });

  it('requires Builder task generation and prevents completion with unfinished todos', () => {
    const builder = fs.readFileSync(path.join(AGENTS_DIR, 'builder.md'), 'utf8');

    expect(builder).toContain('create the complete todo list for every implementation request');
    expect(builder).toContain('ordinary work that did not come from a saved implementation plan');
    expect(builder).toContain('Do not invent phases or prefix tasks with `Phase`');
    expect(builder).toContain('exactly one todo per numbered task');
    expect(builder).toContain('Never produce a completion response while any todo remains `pending` or `in_progress`');
    expect(builder).toContain('Do not delete, merge, reorder, cancel, or replace unfinished todos');
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
    expect(content).toContain('If Explorer remains unavailable after the one managed recovery, continue direct inspection only within the current task scope or report the blocker before broader search.');
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

  it('delegated agents that load skills avoid self-referential visible reasoning status lines', () => {
    for (const agentName of ['builder', 'designer', 'explorer', 'fixer', 'oracle']) {
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
