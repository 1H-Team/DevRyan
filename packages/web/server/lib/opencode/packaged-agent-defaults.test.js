import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import yaml from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(__dirname, '../../default-config/agents');
const PRE_TASK_ORCHESTRATOR_PROMPT_UTF8_BYTES = 15_902;
const EXPECTED_ORCHESTRATOR_PROMPT_UTF8_BYTES = 33_745;
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
    expect(content).toContain('Use natural Markdown headings such as `Summary` and `Verification`');
    expect(content).toContain('do not use tool-shaped XML report wrappers');
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
    expect(content).toContain('Designer owns the approved design implementation end to end');
    expect(content).toContain('Context:');
    expect(content).toContain('Starting points:');
    expect(content).toContain('Return:');
    expect(content).toContain('**Status:** complete');
    expect(content).toContain('No-mutation plans must keep snapshots and logs outside the target workspace');
    expect(content).toContain(
      'start it before any standalone todo read/write whose only purpose is to restate that delegation',
    );
    expect(content).toContain('Oracle review gate and timing:');
    expect(content).toContain('Review depth: focused | deep');
    expect(content).toContain('Do not ask Oracle to rerun tests, builds, lint, or type-checking');
  });

  it('uses Oracle only as a once-per-phase late checkpoint and closes final delegation', () => {
    const { body } = readPackagedAgent('orchestrator');
    const planDraftGate = 'During planning, dispatch only after Orchestrator has completed a grounded, decision-complete draft';
    const implementationGate = 'During implementation or another task, dispatch only after all delegated implementation work is terminal and dispositioned and initial deterministic validation is complete';
    const planCloseout = 'after a usable plan review, dispatch no more specialists before presenting the plan.';
    const finalCloseout = 'after a usable final implementation/task review, dispatch no more specialists of any kind.';

    expect(countOccurrences(body, 'Oracle is optional and may be used at most once in each phase.')).toBe(1);
    expect(body).toContain(planDraftGate);
    expect(body).toContain(implementationGate);
    expect(body).toContain(planCloseout);
    expect(body).toContain('Normal delegation becomes available again only when a later implementation phase begins; that phase may use its own one final Oracle checkpoint.');
    expect(body).toContain(finalCloseout);
    expect(body).toContain('Orchestrator applies Oracle findings directly');
    expect(body).toContain('This closeout rule overrides normal Designer, Fixer, Explorer, Librarian, Council, and parallel-routing rules.');
    expect(body).toContain('A retry or resume inside the same failed managed Oracle dispatch group is recovery of that same logical checkpoint, not another review');
    expect(body).toContain('choose focused or deep before the sole dispatch.');
    expect(body).toContain('Focused is the default and omits `timeout_seconds`');
    expect(body).toContain('passes exactly `timeout_seconds: 1800`');
    expect(body).toContain('Never dispatch a second Oracle to deepen, follow up, or re-review a usable result.');
    expect(body).toContain('Review target: final plan draft');
    expect(body).toContain('Draft plan: <complete decision-ready draft or a compact complete rendering of it>');
    expect(body).toContain('Review target: final implementation/task result');
    expect(body).not.toContain('when a focused review returns a precise escalation target');
    expect(body.indexOf(planDraftGate)).toBeLessThan(body.indexOf(planCloseout));
    expect(body.indexOf(implementationGate)).toBeLessThan(body.indexOf(finalCloseout));
  });

  it('keeps design planning with Orchestrator and implementation with Designer', () => {
    const orchestrator = readPackagedAgent('orchestrator');
    const designer = readPackagedAgent('designer');
    const fixer = readPackagedAgent('fixer');

    expect(orchestrator.body).toContain('Orchestrator owns the grounded design approach and decision-complete implementation brief.');
    expect(orchestrator.body).toContain('Designer owns the approved design implementation end to end');
    expect(orchestrator.body).toContain('route that work back to Designer in normal mode');
    expect(orchestrator.body).toContain('UI correctness bugs with no visual judgment route to `fixer`.');
    expect(orchestrator.body).toContain('For mixed work, create disjoint scopes');
    expect(orchestrator.body).toContain('If Designer remains unavailable after the existing managed recovery, report the blocker');
    expect(orchestrator.body).toContain('Orchestrator owns design-change planning in plan mode.');
    expect(orchestrator.body).toContain('never dispatch Designer from a plan-mode turn');
    expect(orchestrator.body).toContain('Never delegate planning-only or standalone review work to Designer.');
    expect(orchestrator.body).toContain('Non-design implementation gate');
    expect(orchestrator.body).not.toContain('Fixer-first implementation gate');

    expect(designer.body).toContain('End-to-end implementation of an approved design plan or decision-complete brief');
    expect(designer.body).toContain('then edit the code, add or update the design-specific tests, and validate the visible result');
    expect(designer.body).toContain('Do not author design plans, propose alternate directions, or take standalone review assignments.');
    expect(designer.body).toContain('If the assignment is plan-only, review-only, or lacks an implementation brief');

    expect(fixer.body).toContain("Implement the Orchestrator's non-design task specification");
    expect(fixer.body).toContain('frontend data/state/logic and component correctness');
    expect(fixer.body).toContain('make no design edits and return a final `**Status:** blocked` line');
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
    expect(content).toContain('20 completed inspection calls');
    expect(content).toContain('50 completed inspection calls');
    expect(content).toContain('Do not run tests, builds, linters, type-checks, or broad validation');
    expect(content).toContain('at most three actionable findings');
    expect(content).toContain('time and tool budgets are ceilings, not targets');
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
        skill: 'allow',
      },
    });

    for (const contract of [
      '**DevRyan-managed delegation.**',
      'at most one managed recovery',
      'never change its model automatically',
      'choose a model and thinking level in Model Recovery and click Try Again',
      'DevRyan sends one synthetic continuation to the idle parent',
      'Any collected result with `manualRecoveryRequired: true`',
      'sends one transcript-marked same-child continuation when the child is already terminal',
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
      'Ask every delegated subagent to end with exactly one terminal status marker: `**Status:** complete` or `**Status:** blocked`.',
      'Use only real runtime tools.',
      'Provider-native `task` is unavailable to Orchestrator.',
      'Never use `general-purpose`.',
    ]) {
      expect(body, contract).toContain(contract);
    }
    expect(body).not.toContain('use `recover_in_place`');
  });

  it('uses catalog-driven skill permissions without hardcoded skill names', () => {
    const skillCapable = ['builder', 'designer', 'explorer', 'fixer', 'oracle', 'orchestrator', 'plan'];
    const skillDenied = ['council', 'librarian'];

    for (const name of skillCapable) {
      expect(readPackagedAgent(name).frontmatter.permission.skill).toBe('allow');
    }
    for (const name of skillDenied) {
      expect(readPackagedAgent(name).frontmatter.permission.skill).toBe('deny');
    }
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
    expect(content).toContain('Disposition every collected result that does not require manual recovery');
    expect(content).toContain(
      'Each `wait` stays attached while DevRyan repeats bounded polling slices internally',
    );
    expect(content).toContain('use `status` only when a non-blocking live snapshot is explicitly needed');
    expect(content).toContain('call `read_result` with that exact cursor and each returned next cursor in order');
    expect(content).toContain('`read_result` never acknowledges the envelope');
    expect(content).toContain('Only after every result is dispositioned may you resume local work');
    expect(content).toContain('successful result requires `continue` after `wait`');
  });

  it('keeps managed deadlines as exceptional recovery boundaries', () => {
    const content = readPackagedAgent('orchestrator').content;

    expect(content).toContain('A deadline is a recovery safety boundary');
    expect(content).toContain('Omit `timeout_seconds` for ordinary bounded work');
    expect(content).toContain('only for a closed, inherently indivisible operation');
    expect(content).toContain('Never lengthen a deadline merely because an implementation spans multiple files or tests');
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
    expect(content).toContain('## Migration Candidates');
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
    const maxLineCounts = {
      designer: 95,
      explorer: 102,
      fixer: 96,
      librarian: 95,
      oracle: 95,
    };

    for (const [agentName, maxLineCount] of Object.entries(maxLineCounts)) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, `${agentName}.md`), 'utf8');
      const lineCount = content.trimEnd().split('\n').length;

      expect(lineCount, `${agentName}.md line count`).toBeLessThanOrEqual(maxLineCount);
      expect(content).toContain('On unrecoverable provider/tool errors, return a final `**Status:** blocked` line with a concise reason.');
      expect(content).toContain('Avoid repeated progress-only messages such as "continuing" or "implementing" without a terminal status marker.');
      expect(content).toContain('Do not use `git status`, `git diff`, `git diff --stat`, or `git diff --check` to determine whether you made edits.');
    }
  });

  it('uses provider-neutral Markdown instead of tool-shaped XML for specialist results', () => {
    const unsafeOutputTag = /<\/?(?:results|files|answer|migration_candidates|confidence|next_searches|summary|changes|verification|sources|status)>/i;

    for (const agentName of ['council', 'designer', 'explorer', 'fixer', 'librarian', 'oracle']) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, `${agentName}.md`), 'utf8');

      expect(content, `${agentName}.md Markdown status`).toContain('**Status:**');
      expect(content, `${agentName}.md unsafe output tag`).not.toMatch(unsafeOutputTag);
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
