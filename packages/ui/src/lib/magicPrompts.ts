export type MagicPromptId =
  | 'git.commit.generate.visible'
  | 'git.commit.generate.instructions'
  | 'git.pr.generate.visible'
  | 'git.pr.generate.instructions'
  | 'git.conflict.resolve.visible'
  | 'git.conflict.resolve.instructions'
  | 'git.integrate.cherrypick.resolve.visible'
  | 'git.integrate.cherrypick.resolve.instructions'
  | 'github.pr.review.visible'
  | 'github.pr.review.instructions'
  | 'github.issue.review.visible'
  | 'github.issue.review.instructions'
  | 'github.pr.checks.review.visible'
  | 'github.pr.checks.review.instructions'
  | 'github.pr.comments.review.visible'
  | 'github.pr.comments.review.instructions'
  | 'github.pr.comment.single.visible'
  | 'github.pr.comment.single.instructions'
  | 'plan.todo.visible'
  | 'plan.todo.instructions'
  | 'plan.improve.visible'
  | 'plan.improve.instructions'
  | 'plan.implement.visible'
  | 'plan.implement.instructions'
  | 'session.summary.visible'
  | 'session.summary.instructions'
  | 'session.review.visible'
  | 'session.review.instructions';

export interface MagicPromptDefinition {
  id: MagicPromptId;
  title: string;
  description: string;
  group: 'Git' | 'GitHub' | 'Planning' | 'Session';
  template: string;
  placeholders?: Array<{ key: string; description: string }>;
}

export interface MagicPromptOverridesPayload {
  version: number;
  overrides: Record<string, string>;
}

const API_ENDPOINT = '/api/magic-prompts';

const DEPRECATED_MAGIC_PROMPT_IDS = new Set<string>([
  'git.commit.draft.visible',
  'git.commit.draft.instructions',
  'git.commit.plan.visible',
  'git.commit.plan.instructions',
]);

export const MAGIC_PROMPT_DEFINITIONS: readonly MagicPromptDefinition[] = [
  {
    id: 'git.commit.generate.visible',
    title: 'Commit Generation Visible Prompt',
    group: 'Git',
    description: 'Visible user message for non-mutating commit plan previews.',
    template: 'Generate commit metadata for the selected git changes. Return JSON only.',
  },
  {
    id: 'git.commit.generate.instructions',
    title: 'Commit Generation Instructions',
    group: 'Git',
    description: 'Hidden instructions for non-mutating commit plan previews.',
    placeholders: [
      { key: 'generation_mode', description: 'Commit generation mode: plan_preview.' },
      { key: 'selected_files', description: 'Bullet list of currently scoped file paths.' },
      { key: 'git_context', description: 'Pre-collected git status, recent commits, and bounded diffs for selected files.' },
      { key: 'output_contract', description: 'Mode-specific JSON output contract.' },
      { key: 'safety_rules', description: 'Mode-specific safety constraints.' },
    ],
    template: `Return structured JSON only. Do not include prose, markdown, explanations, or code fences.

Use the supplied git context below. Do not inspect the repository with tools.

Generation mode: {{generation_mode}}

{{output_contract}}

Repo commit style:
- Conventional commits with scopes when changes map to a clear area.
- Use scope for focused areas: dashboard, admin, data, db, i18n, services, analytics, booking, billing, provider, professionals, components.
- Omit scope only for broad cross-cutting changes.
- Keep summaries concise, imperative, and close to the repo's wording.
- Prefer verbs used in history: add, update, enhance, improve, implement, integrate, wire, standardize, simplify, remove, avoid, align.

Rules:
- do not stage, commit, pull, rebase, or push.
- subject format: <type>(<scope>): <summary>, or <type>: <summary> only when no clear scope fits.
- allowed types: feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert.
- keep subject concise and user-facing.
- highlights: 0-3 concise user-facing points.
- use double quotes for all JSON strings.

{{safety_rules}}

Selected files:
{{selected_files}}

Git context:
{{git_context}}`,
  },
  {
    id: 'git.pr.generate.visible',
    title: 'PR Generation Visible Prompt',
    group: 'Git',
    description: 'Visible user message for PR title/body generation.',
    template: 'You are drafting GitHub Pull Request title and body using session context, commit list, and changed files.',
  },
  {
    id: 'git.pr.generate.instructions',
    title: 'PR Generation Instructions',
    group: 'Git',
    description: 'Hidden instructions for PR title/body generation.',
    placeholders: [
      { key: 'base_branch', description: 'Base branch name.' },
      { key: 'head_branch', description: 'Head branch name.' },
      { key: 'commits', description: 'Bullet list of commits in base...head.' },
      { key: 'changed_files', description: 'Bullet list of changed files in base...head.' },
      { key: 'additional_context_block', description: 'Optional Additional context block (already formatted).' },
    ],
    template: `Return exactly one JSON object and nothing else. Do not include prose, markdown outside JSON, explanations, or code fences.

The JSON object must have exactly this shape:
{"title": string, "body": string}

Rules:
- title: concise, outcome-first, conventional style
- body: markdown with sections: ## Summary, ## Why, ## Testing
- keep output concrete and user-facing
- put all markdown inside the body string
- use double quotes for all JSON strings and escape newlines as \\n
- do not include trailing commas or comments

Base branch: {{base_branch}}
Head branch: {{head_branch}}

Commits in range (base...head):
{{commits}}

Files changed across these commits:
{{changed_files}}{{additional_context_block}}`,
  },
  {
    id: 'github.pr.review.visible',
    title: 'PR Review Visible Prompt',
    group: 'GitHub',
    description: 'Visible user message when creating PR review requests from GitHub context.',
    placeholders: [
      { key: 'pr_number', description: 'Pull request number.' },
    ],
    template: 'Review this pull request #{{pr_number}} using the provided PR context',
  },
  {
    id: 'github.pr.review.instructions',
    title: 'PR Review Instructions',
    group: 'GitHub',
    description: 'Hidden instructions attached when generating a PR review response.',
    template: `You are drafting a pull request review comment that will be posted back to the PR author. You are not the implementer; do not propose to write code or run commands.

Before drafting:
- Read the PR title and body first to anchor on the author's intent. Evaluate whether the implementation matches that intent — missing pieces, incorrect behavior vs intent, scope creep.
- The PR diff is the source of truth for what changed; the repo on disk may not yet reflect those changes. Read the diff carefully. Use the repo only as ancillary context (imports, call sites, existing patterns, nearby code) when you need to verify a specific claim — not to discover the changes themselves.
- No speculation: every reported issue must be grounded in the diff plus ancillary repo evidence you actually read. If a claim cannot be verified, drop it — do not hedge or guess.
- Clarifying question: if the PR's intent itself is unreadable (title/body give no "why", diff is ambiguous on purpose), ask me one focused question about intent and stop. Do not open a discovery loop — this is a review, not a planning session.

High-signal bar — only report issues that meet all of:
- Objective and verifiable from the diff plus ancillary repo evidence.
- Introduced by this PR (not pre-existing).
- Material: bugs that will cause incorrect runtime behavior, security/privacy risks, correctness edge cases, backwards-compat breakage, missing implementations across modules/targets, boundary violations, OR a clear CLAUDE.md / AGENTS.md violation where you can quote the exact rule.

Do NOT report:
- Pre-existing issues unrelated to the diff.
- Pedantic nitpicks a senior engineer would not flag.
- Issues a linter would catch.
- Subjective style preferences not explicitly required by CLAUDE.md / AGENTS.md.
- "Might" / "could" / "potential" concerns without concrete evidence.
- Rules mentioned in CLAUDE.md / AGENTS.md but explicitly silenced in the code (e.g., via an ignore comment or documented exception).
- Missing tests / coverage gaps unless CLAUDE.md / AGENTS.md explicitly requires them for the changed area.

Validation pass: before writing the final comment, re-check each candidate issue against the diff + ancillary repo evidence. Drop anything you are not certain about. False positives waste the author's time.

Output rules:
- Produce a single review comment addressed to the PR author, using the exact format below.
- No emojis. No code snippets. No fenced blocks. Short inline code identifiers are fine.
- Reference evidence with file paths and line ranges (e.g., path/to/file.ts:120-138) derived from the diff. Use "approx" only as a last resort when the diff does not expose exact lines.
- One bullet per unique issue; do not duplicate an issue across sections.
- Keep the whole comment under ~300 words.

Format exactly:
<1-2 sentence summary of intent and top-level verdict>

Must-fix:
- <issue> - <brief why> - <file:line-range> - Action: <one-line action>
Nice-to-have:
- <issue> - <brief why> - <file:line-range> - Action: <one-line action>

If nothing clears the high-signal bar, write:
Must-fix:
- None
Nice-to-have:
- None`,
  },
  {
    id: 'github.issue.review.visible',
    title: 'Issue Review Visible Prompt',
    group: 'GitHub',
    description: 'Visible user message when creating issue review requests from GitHub context.',
    placeholders: [
      { key: 'issue_number', description: 'Issue number.' },
    ],
    template: 'Review this issue #{{issue_number}} using the provided issue context',
  },
  {
    id: 'github.issue.review.instructions',
    title: 'Issue Review Instructions',
    group: 'GitHub',
    description: 'Hidden instructions attached when generating an issue review response.',
    template: `Review this issue using the provided issue context.

Process:
- First classify the issue type (bug / feature request / question/support / refactor / ops) and state it as: Type: <one label>.
- Gather any needed repository context (code, config, docs) to validate assumptions.
- After gathering, if anything is still unclear or cannot be verified, do not speculate — state what's missing and ask targeted questions.
- Clarifying-question routing is best-effort, but when you need to ask clarifying questions, always use the structured question tool. Send 2–3 related questions in a single call by populating the questions[] array. Never ask clarifying questions as free-form chat text.

Mode selection by type:
- Bug / Question/Support / Ops: deliver the response directly using the matching template below. Do not bombard me with questions for straightforward diagnosis; use "Missing info" / "Repro/diagnostics needed" fields instead.
- Feature request / Refactor with substantive unknowns: this is effectively a planning session. Do not emit the Feature template on the first turn. Instead, ask me focused clarifying questions in batches of at most 3, one topic at a time (scope, constraints, tradeoffs, UX, etc.), wait for answers, drop questions that became irrelevant, and repeat until you have no more substantive questions. Only then emit the Feature template.

Output rules:
- Compact output; pick ONE template below and omit the others.
- No emojis. No code snippets. No fenced blocks.
- Short inline code identifiers allowed.
- Reference evidence with file paths and line ranges when applicable; if exact lines are not available, cite the file and say "approx" + why.
- Keep the entire response under ~300 words (applies to the final template output, not to clarifying-question turns).

Templates (choose one):
Bug:
- Summary (1-2 sentences)
- Likely cause (max 2)
- Repro/diagnostics needed (max 3)
- Fix approach (max 4 steps)
- Verification (max 3)

Feature:
- Summary (1-2 sentences)
- Requirements (max 4)
- Unknowns/questions (max 4)
- Proposed plan (max 5 steps)
- Verification (max 3)

Question/Support:
- Summary (1-2 sentences)
- Answer/guidance (max 6 lines)
- Missing info (max 4)

Do not implement changes until I confirm; end with: "Next actions: <1 sentence>".`,
  },
  {
    id: 'github.pr.checks.review.visible',
    title: 'PR Failed Checks Visible Prompt',
    group: 'GitHub',
    description: 'Visible user message for PR failed checks analysis.',
    template: 'Review these PR failed checks and propose likely fixes. Do not implement until I confirm.',
  },
  {
    id: 'github.pr.checks.review.instructions',
    title: 'PR Failed Checks Instructions',
    group: 'GitHub',
    description: 'Hidden instructions for PR failed checks analysis.',
    template: `Use the attached checks payload.
- Summarize what is failing.
- Prioritize check annotations/errors over generic status text.
- Identify likely root cause(s).
- Propose a minimal fix plan and verification steps.
- No speculation: ask for missing info if needed.`,
  },
  {
    id: 'github.pr.comments.review.visible',
    title: 'PR Comments Review Visible Prompt',
    group: 'GitHub',
    description: 'Visible user message for PR comments analysis.',
    template: 'Review these PR comments and propose the required changes and next actions. Do not implement until I confirm.',
  },
  {
    id: 'github.pr.comments.review.instructions',
    title: 'PR Comments Review Instructions',
    group: 'GitHub',
    description: 'Hidden instructions for PR comments analysis.',
    template: `Use the attached comments payload.
- Identify required vs optional changes.
- Call out intent/implementation mismatch if present.
- Before proposing a plan: if a comment's intent is ambiguous, or the required change depends on a tradeoff only I can decide, ask me focused clarifying questions in batches of at most 3 and wait for answers. Do not speculate.
- Once intent is clear, propose a minimal plan and verification steps.`,
  },
  {
    id: 'github.pr.comment.single.visible',
    title: 'Single PR Comment Visible Prompt',
    group: 'GitHub',
    description: 'Visible user message for single PR comment analysis.',
    template: 'Address this comment from PR and propose required changes. Do not implement until I confirm.',
  },
  {
    id: 'github.pr.comment.single.instructions',
    title: 'Single PR Comment Instructions',
    group: 'GitHub',
    description: 'Hidden instructions for single PR comment analysis.',
    template: `Use the attached single-comment payload.
- Explain what the reviewer is asking for.
- Identify exact code areas likely impacted.
- Before proposing a plan: if the reviewer's intent is ambiguous or the required change depends on a tradeoff only I can decide, ask me focused clarifying questions in batches of at most 3 and wait for answers. Do not speculate.
- Once intent is clear, propose a minimal implementation plan and verification steps.`,
  },
  {
    id: 'git.conflict.resolve.visible',
    title: 'Merge/Rebase Conflict Visible Prompt',
    group: 'Git',
    description: 'Visible user message for merge/rebase conflict resolution help.',
    placeholders: [
      { key: 'operation_label', description: 'Operation label in lower-case (merge/rebase).' },
      { key: 'head_ref', description: 'Head reference for preserving intent.' },
    ],
    template: 'Investigate the {{operation_label}} conflicts and concisely report the intended resolution strategy without making modifications. Wait for confirmation before resolving, staging, or continuing the {{operation_label}}. Preserve the intent of changes from {{head_ref}}.',
  },
  {
    id: 'git.conflict.resolve.instructions',
    title: 'Merge/Rebase Conflict Instructions',
    group: 'Git',
    description: 'Hidden instructions for merge/rebase conflict resolution help.',
    placeholders: [
      { key: 'operation_label', description: 'Operation label in lower-case (merge/rebase).' },
      { key: 'directory', description: 'Repository directory path.' },
      { key: 'operation', description: 'Operation name.' },
      { key: 'head_info', description: 'Head metadata if available.' },
      { key: 'continue_cmd', description: 'Command to continue operation.' },
    ],
    template: `Git {{operation_label}} operation is in progress with conflicts.
- Directory: {{directory}}
- Operation: {{operation}}
- Head Info: {{head_info}}

Required steps before confirmation:
1. Read each conflicted file to understand the conflict markers (<<<<<<< HEAD, =======, >>>>>>> ...)
2. Inspect the relevant surrounding code and changes from both sides
3. Report a concise per-file resolution strategy and any assumptions or tradeoffs
4. Wait for explicit user confirmation before editing files, staging files, or running: {{continue_cmd}}

Important:
- Do not modify files before the user confirms the proposed strategy
- Do not stage files before the user confirms the proposed strategy
- Do not continue the {{operation_label}} before the user confirms the proposed strategy
- Remove ALL conflict markers from files (<<<<<<< HEAD, =======, >>>>>>>)
- Make sure the final code is syntactically correct and preserves intent from both sides
- Do not leave any files with unresolved conflict markers
- After completing all steps, confirm the {{operation_label}} was successful`,
  },
  {
    id: 'git.integrate.cherrypick.resolve.visible',
    title: 'Cherry-pick Conflict Visible Prompt',
    group: 'Git',
    description: 'Visible user message for cherry-pick conflict resolution help.',
    placeholders: [
      { key: 'current_commit', description: 'Current commit hash being applied.' },
      { key: 'target_branch', description: 'Target branch name.' },
    ],
    template: 'Resolve cherry-pick conflicts, stage the resolved files, and continue the cherry-pick. Keep intent of commit {{current_commit}} onto branch {{target_branch}}.',
  },
  {
    id: 'git.integrate.cherrypick.resolve.instructions',
    title: 'Cherry-pick Conflict Instructions',
    group: 'Git',
    description: 'Hidden instructions for cherry-pick conflict resolution help.',
    placeholders: [
      { key: 'repo_root', description: 'Repository root path.' },
      { key: 'temp_worktree_path', description: 'Temporary worktree path.' },
      { key: 'source_branch', description: 'Source branch name.' },
      { key: 'target_branch', description: 'Target branch name.' },
      { key: 'current_commit', description: 'Current commit hash being applied.' },
    ],
    template: `Worktree commit integration (cherry-pick) is in progress with conflicts.
- Repo root: {{repo_root}}
- Temp target worktree: {{temp_worktree_path}}
- Source branch: {{source_branch}}
- Target branch: {{target_branch}}
- Current commit: {{current_commit}}

Required steps:
1. Read each conflicted file in the temp worktree to understand the conflict markers (<<<<<<< HEAD, =======, >>>>>>> ...)
2. Edit each file to resolve conflicts by choosing the correct code or merging both changes appropriately
3. Stage all resolved files with: git add <file>
4. Complete the cherry-pick with: git cherry-pick --continue

Important:
- Work inside the temp worktree directory: {{temp_worktree_path}}
- Remove ALL conflict markers from files (<<<<<<< HEAD, =======, >>>>>>>)
- Preserve the intent of the commit being applied
- Make sure the final code is syntactically correct
- Do not leave any files with unresolved conflict markers
- After completing all steps, confirm the cherry-pick was successful`,
  },
  {
    id: 'plan.todo.visible',
    title: 'Todo Planning Visible Prompt',
    group: 'Planning',
    description: 'Visible user message when sending a todo into a new planning session.',
    placeholders: [
      { key: 'todo_text', description: 'Todo text selected by the user.' },
    ],
    template: '{{todo_text}}',
  },
  {
    id: 'plan.todo.instructions',
    title: 'Todo Planning Instructions',
    group: 'Planning',
    description: 'Hidden instructions for sending a project todo into a new planning session.',
    placeholders: [
      { key: 'todo_text', description: 'Todo text selected by the user.' },
    ],
    template: `You are starting from a project todo item.
Todo: {{todo_text}}
Your job right now is to produce a thorough implementation plan for this todo, not to implement it yet. Optimize for a well-considered plan, not a fast one.

Work back and forth with me. Do not dump a wall of questions. Do not jump to the full plan.

Discovery — questions in batches of 3:
1. First, inspect the repo — relevant files, module docs, existing patterns, nearby code, constraints, dependencies — enough to form informed questions, not enough to guess the plan.
2. Ask me at most 3 questions per turn. Each batch should be focused on one topic at a time (e.g., scope, architecture, data model, UX, edge cases). Pick the topic that most blocks the plan right now.
3. Wait for my answers. Use them to refine your understanding, re-read code if needed, and prepare the next batch.
4. Questions that became irrelevant after my earlier answers — drop them, don't ask.
5. Repeat until you have no more substantive questions.

Clarifying-question routing is best-effort, but when you need to ask clarifying questions, always use the structured question tool. Send 2–3 related questions in a single call by populating the questions[] array. Never ask clarifying questions as free-form chat text.

Alignment:
6. Share a short outline: affected areas, proposed approach, main risks. Wait for my confirmation or corrections. Iterate on the outline until I confirm.

Final plan:
7. Once aligned, deliver the concrete implementation plan grounded in the repo context. Make remaining assumptions and missing context explicit.
8. Write the plan as ordinary markdown — no code fences, no plan.md wrapper. Use the actual plan name as the top heading, without an "Implementation Plan:" prefix. Use headings, lists, and bold for structure so the chat UI can render it as typeset prose. Under \`## Implementation\`, use sequential \`### Phase 1: <name>\`, \`### Phase 2: <name>\` headings and numbered actionable tasks. Organize phases so each phase contains multiple related implementation tasks; merge any phase that would contain only one task. Keep verification, acceptance criteria, files, and risks separate from actionable implementation tasks so task counts stay accurate. Emit the final plan and stop; the plan card provides the implementation action.`,
  },
  {
    id: 'plan.improve.visible',
    title: 'Improve Plan Visible Prompt',
    group: 'Planning',
    description: 'Visible user message when sending a saved plan into an improve flow.',
    placeholders: [
      { key: 'plan_title', description: 'Current plan title.' },
    ],
    template: 'Improve this plan: {{plan_title}}',
  },
  {
    id: 'plan.improve.instructions',
    title: 'Improve Plan Instructions',
    group: 'Planning',
    description: 'Hidden instructions for improving a saved plan from project context.',
    placeholders: [
      { key: 'plan_title', description: 'Current plan title.' },
      { key: 'plan_path', description: 'Absolute path to the saved plan file.' },
    ],
    template: `You are starting from an existing implementation plan.
Plan title: {{plan_title}}
This plan is stored in the file: {{plan_path}}
Read that file first and treat its current contents as the source of truth for the plan.
Your job right now is to improve this plan so it is better grounded in the actual repo state. Do not implement yet. Optimize for a well-considered improved plan, not a fast one.

Work back and forth with me. Do not dump a wall of questions. Do not jump to the full improved plan.

Discovery — questions in batches of 3:
1. First, inspect the repo and map it against the plan — relevant files, module docs, existing patterns, nearby code, constraints, dependencies. Identify gaps, plan assumptions that don't match the repo, missing context, and risks.
2. Ask me at most 3 questions per turn. Each batch should be focused on one topic at a time (e.g., scope deltas, architecture assumptions, data model, UX, edge cases, tradeoffs between approaches). Pick the topic that most blocks a confident improvement right now.
3. Wait for my answers. Use them to refine your understanding, re-read code if needed, and prepare the next batch.
4. Questions that became irrelevant after my earlier answers — drop them, don't ask.
5. Repeat until you have no more substantive questions.

Alignment:
6. Share a short summary of proposed changes — what sections of the plan change and why, open questions, recommendations. Do not rewrite the whole plan inline and do not return the full plan as a code block. Quote only small targeted snippets or describe the exact sections to change. Wait for my confirmation or corrections. Iterate until I confirm.

Final step:
7. Once aligned, explicitly offer to edit this same file ({{plan_path}}) with the agreed changes. Make remaining assumptions and missing context explicit.`,
  },
  {
    id: 'plan.implement.visible',
    title: 'Implement Plan Visible Prompt',
    group: 'Planning',
    description: 'Visible user message when sending a saved plan into an implement flow.',
    template: 'Implement plan.',
  },
  {
    id: 'plan.implement.instructions',
    title: 'Implement Plan Instructions',
    group: 'Planning',
    description: 'Hidden instructions for implementing a saved plan from project context.',
    placeholders: [
      { key: 'plan_title', description: 'Current plan title.' },
      { key: 'plan_path', description: 'Absolute path to the saved plan file.' },
    ],
    template: `You are starting from an existing implementation plan.
Plan title: {{plan_title}}
This plan is stored in the file: {{plan_path}}
Read that file first and treat its current contents as the source of truth for the plan. The plan is already agreed; implement it end-to-end without deviating from it.

Before and during implementation, build a deep understanding of the project — relevant files, module docs, existing patterns, nearby code, conventions — so your choices fit the repo's style.

Task tracking is part of the implementation contract:
1. Read the complete \`## Implementation\` section and identify every numbered actionable task under its sequential phase headings.
2. Before editing any file, create the complete todo list with exactly one todo per plan task. Preserve the plan's phase order and task wording. Prefix every todo with \`Phase <number>: \` so the UI can show which saved-plan phase is active.
3. Do not add todos for Context, Critical files, Visual details, acceptance criteria, risks, or the separate Verification checklist. Unless the saved plan is legitimately revised under the plan-deviation rules below, do not remove, merge, reorder, cancel, add, or replace plan todos while implementing them.
4. Keep exactly one todo \`in_progress\`. Mark a task \`completed\` only after its implementation and focused checks are complete. If later verification finds a regression, reopen the relevant task.
5. Keep the final plan task \`in_progress\` while running every applicable item in the plan's \`## Verification\` section. Mark it complete only after those checks pass or an unavailable check is explicitly justified.
6. Do not emit a completion response while any todo is \`pending\` or \`in_progress\`. A successful implementation finishes only when the counter reaches N/N. If genuinely blocked, explain the blocker and leave the affected todo incomplete instead of claiming completion.

Do the implementation work continuously. When a plan step is ambiguous, do not stop to ask — make the best judgment call consistent with the plan's intent and the repo's conventions, and briefly note the decision inline so it is visible on review. Prefer forward progress over interrupting me.

Plan deviations and related findings:
1. A change the user's request or the approved plan already requires (including its migrations) is not a deviation and never needs a question. When implementation or verification shows that a plan step cannot be done as written, or reveals work missing from the saved plan, classify the change before acting. Do not treat ordinary ambiguity as a deviation.
2. Class 1 (continue without asking): file, API-shape, helper, order, or test-approach changes and repository-rule compliance fixes that keep the approved outcome. Class 2 (ask first): changes to user-visible behaviour or to data/schema meaning beyond what the approved plan or request already requires, permissions, external side effects, or irreversible steps. These tripwires force Class 2 regardless of judgment: security-definer functions, RLS policies or grants, destructive statements on existing user data (DROP / DELETE / TRUNCATE / type-narrowing on populated tables), and external calls (email, webhooks, payments). Planned migrations are not a tripwire. If unsure whether the plan already covers it, re-read the plan and the user's request; ask only if it is genuinely outside both.
3. Every deviation note reads \`Deviation: <step> → <change>. Why: … Still delivers: <approved outcome>\`. For a Class 1 deviation, note it inline in normal progress reporting, record it in this same plan file ({{plan_path}}) under \`## Deviations\`, reconcile the todos under the rules below, and continue automatically; do not interrupt me for approval.
4. For a Class 2 deviation, do not implement it yet. Ask exactly one question through the structured question tool so the existing question-card UI can keep the session resumable. Use the header \`Plan deviation\`. Write the question as several lines in layman's terms: line 1 is the question itself; then one line each starting with \`What changes:\`, \`Why:\`, \`For end users:\`, \`Security & data:\`, \`Reversibility:\`, and \`If we keep the original plan:\`. Offer exactly these options: \`Approve deviation (Recommended)\`, \`Keep original plan\`, and \`Something else\` (a custom answer is allowed). Never ask this as free-form assistant text. While the question is pending, do not emit a completion or blocked response and do not implement the Class 2 change.
5. If I choose \`Approve deviation\`, record the deviation in this same plan file first, reconcile the todos, implement it, and resume in the same session without asking me to send another prompt. If I choose \`Something else\`, treat the custom answer as the approved change and record it the same way. If I choose \`Keep original plan\`, skip the question, or give an ambiguous answer, do not implement the deviation: follow the original step when it can still be done; otherwise leave the affected todo incomplete and report that the implementation is paused for plan revision.
6. Record every deviation in this same plan file under a \`## Deviations\` section (create it at the end of the file when missing) as a numbered list: \`N. [Class 1 | Class 2 approved] <step> → <change>. Why: … Still delivers: …\`.
7. For an unrelated finding, do not expand the plan to fix it. Record it concisely and continue when the agreed outcome can still be completed. If it genuinely prevents the agreed outcome or its verification, treat the required response as a Class 2 deviation and use the question-card flow.
8. "Blocked" is reserved for missing user intent, a provider or tool failure, or a rule that cannot be satisfied. A sub-agent's blocked status caused by a plan-vs-repository conflict is a deviation to classify, not a blocker.

Todo reconciliation after a recorded Class 1 or approved Class 2 deviation:
1. Re-read the revised \`## Implementation\` section and restore exactly one todo per numbered plan task in the revised phase order.
2. Preserve the wording, identity, and status of unchanged tasks; add newly approved tasks in plan order; and reopen any completed task whose work or verification is affected by the revision.
3. This reconciliation is the only exception to the rule against adding or replacing plan todos. After reconciliation, continue with exactly one todo \`in_progress\` and do not finish until the revised counter reaches N/N.`,
  },
  {
    id: 'session.summary.visible',
    title: 'Session Summary Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /summary command.',
    placeholders: [
      { key: 'topic_line', description: 'Pre-formatted topic clause (e.g. " focused on: <topic>") or empty string.' },
    ],
    template: 'Summarize this session{{topic_line}}.',
  },
  {
    id: 'session.summary.instructions',
    title: 'Session Summary Instructions',
    group: 'Session',
    description: 'Hidden instructions attached to the /summary command. Produces a non-destructive summary usable for handing off to a new session.',
    placeholders: [
      { key: 'topic_block', description: 'Pre-formatted topic focus paragraph, or empty string when no topic hint was given.' },
    ],
    template: `Produce a non-destructive summary of this conversation. Do NOT compact or mutate session history — your output is an additional assistant message the user will read and may use to hand off to a new session.

Cover the information useful for continuing this work:
- What was done (completed work, in order)
- What is currently in progress
- Files modified — brief what and why per file
- Open questions and next steps
- User requests, constraints, or preferences to carry forward
- Important technical decisions and why they were made

{{topic_block}}

Formatting:
- Concise markdown with short sections and bullet lists
- No preamble like "Here is a summary" — jump straight to content
- Do not answer questions found in the conversation — only summarize
- Keep length proportional to session length; do not pad

Respond in the same language the user used most in the conversation.`,
  },
  {
    id: 'session.review.visible',
    title: 'Workspace Review Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /workspace-review command.',
    template: 'Review the changes made in this workspace.',
  },
  {
    id: 'session.review.instructions',
    title: 'Workspace Review Instructions',
    group: 'Session',
    description: 'Hidden instructions attached to the /workspace-review command. Reviews current workspace changes for high-signal issues only.',
    template: `
Report only real, high-signal issues introduced by these changes.

The diff is the source of truth. Use the local repo only as ancillary context when you need to validate a specific claim or check an applicable rule.

Focus on:
- runtime bugs
- incorrect logic
- broken assumptions in the changed code
- clear regressions introduced by the changes
- missing implementations across affected modules or targets when the diff clearly introduced the gap
- clear CLAUDE.md or AGENTS.md violations that apply to the changed files

Do not report:
- pre-existing issues unrelated to the diff
- pedantic nitpicks a senior engineer would not flag
- issues a linter would catch
- subjective style preferences not explicitly required by CLAUDE.md or AGENTS.md
- speculative concerns or anything you cannot verify with high confidence
- missing tests or coverage gaps unless an applicable CLAUDE.md or AGENTS.md explicitly requires them for the changed area
- rules mentioned in CLAUDE.md or AGENTS.md but explicitly silenced in the code

Validation pass:
- Before reporting an issue, re-check it against the diff plus only the local context you actually needed to read.
- For CLAUDE.md or AGENTS.md violations, verify the rule applies to the affected file path and cite the exact rule.
- If you are not certain an issue is real, omit it.

Output:
- If no high-signal issues are found, respond with exactly: No high-signal issues found.
- Otherwise, return a concise numbered list.
- For each issue include:
  - short title
  - why it is a real problem
  - affected file path
  - category: bug or rule violation

Keep the review concise and practical.`,
  },
] as const;

const MAGIC_PROMPT_DEFINITION_BY_ID = new Map<MagicPromptId, MagicPromptDefinition>(
  MAGIC_PROMPT_DEFINITIONS.map((definition) => [definition.id, definition])
);

const LEGACY_PROMPT_KEY_MAP: Record<string, { visible: MagicPromptId; instructions: MagicPromptId }> = {
  'git.pr.generate': {
    visible: 'git.pr.generate.visible',
    instructions: 'git.pr.generate.instructions',
  },
};

let cachedOverrides: Record<string, string> | null = null;
let inFlightOverridesRequest: Promise<Record<string, string>> | null = null;

const replaceTemplateVariables = (template: string, variables: Record<string, string>) => {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) {
      return '';
    }
    return variables[key] ?? '';
  });
};

const normalizeOverridesPayload = (payload: unknown): Record<string, string> => {
  const overridesRaw = (payload as { overrides?: unknown } | null)?.overrides;
  if (!overridesRaw || typeof overridesRaw !== 'object' || Array.isArray(overridesRaw)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(overridesRaw as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      continue;
    }
    if (DEPRECATED_MAGIC_PROMPT_IDS.has(key)) {
      continue;
    }
    result[key] = value;
  }

  for (const [legacyKey, splitKeys] of Object.entries(LEGACY_PROMPT_KEY_MAP)) {
    const legacyValue = result[legacyKey];
    if (typeof legacyValue !== 'string') {
      continue;
    }

    const firstNewlineIndex = legacyValue.indexOf('\n');
    const visible = (firstNewlineIndex === -1 ? legacyValue : legacyValue.slice(0, firstNewlineIndex)).trim();
    const instructions = (firstNewlineIndex === -1 ? '' : legacyValue.slice(firstNewlineIndex + 1)).trim();

    if (!(splitKeys.visible in result) && visible.length > 0) {
      result[splitKeys.visible] = visible;
    }
    if (!(splitKeys.instructions in result) && instructions.length > 0) {
      result[splitKeys.instructions] = instructions;
    }
  }

  return result;
};

export const fetchMagicPromptOverrides = async (): Promise<Record<string, string>> => {
  if (cachedOverrides) {
    return cachedOverrides;
  }

  if (!inFlightOverridesRequest) {
    inFlightOverridesRequest = fetch(API_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Failed to load magic prompts');
        }
        const payload = await response.json().catch(() => ({}));
        const normalized = normalizeOverridesPayload(payload);
        cachedOverrides = normalized;
        return normalized;
      })
      .finally(() => {
        inFlightOverridesRequest = null;
      });
  }

  return inFlightOverridesRequest;
};

export const invalidateMagicPromptOverridesCache = () => {
  cachedOverrides = null;
  inFlightOverridesRequest = null;
};

export const getMagicPromptDefinition = (id: MagicPromptId): MagicPromptDefinition => {
  const definition = MAGIC_PROMPT_DEFINITION_BY_ID.get(id);
  if (!definition) {
    throw new Error(`Unknown magic prompt id: ${id}`);
  }
  return definition;
};

export const getDefaultMagicPromptTemplate = (id: MagicPromptId): string => {
  return getMagicPromptDefinition(id).template;
};

export const getEffectiveMagicPromptTemplate = async (id: MagicPromptId): Promise<string> => {
  const overrides = await fetchMagicPromptOverrides().catch((): Record<string, string> => ({}));
  const override = overrides[id];
  if (typeof override === 'string') {
    return override;
  }
  return getDefaultMagicPromptTemplate(id);
};

export const renderMagicPrompt = async (id: MagicPromptId, variables: Record<string, string> = {}): Promise<string> => {
  const template = await getEffectiveMagicPromptTemplate(id);
  return replaceTemplateVariables(template, variables);
};

export const saveMagicPromptOverride = async (id: MagicPromptId, text: string): Promise<MagicPromptOverridesPayload> => {
  const response = await fetch(`${API_ENDPOINT}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error((errorPayload as { error?: string })?.error || 'Failed to save magic prompt');
  }
  const payload = await response.json();
  cachedOverrides = normalizeOverridesPayload(payload);
  return {
    version: typeof payload?.version === 'number' ? payload.version : 1,
    overrides: cachedOverrides,
  };
};

export const resetMagicPromptOverride = async (id: MagicPromptId): Promise<MagicPromptOverridesPayload> => {
  const response = await fetch(`${API_ENDPOINT}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error((errorPayload as { error?: string })?.error || 'Failed to reset magic prompt');
  }
  const payload = await response.json();
  cachedOverrides = normalizeOverridesPayload(payload);
  return {
    version: typeof payload?.version === 'number' ? payload.version : 1,
    overrides: cachedOverrides,
  };
};

export const resetAllMagicPromptOverrides = async (): Promise<MagicPromptOverridesPayload> => {
  const response = await fetch(API_ENDPOINT, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error((errorPayload as { error?: string })?.error || 'Failed to reset all magic prompts');
  }
  const payload = await response.json();
  cachedOverrides = normalizeOverridesPayload(payload);
  return {
    version: typeof payload?.version === 'number' ? payload.version : 1,
    overrides: cachedOverrides,
  };
};
