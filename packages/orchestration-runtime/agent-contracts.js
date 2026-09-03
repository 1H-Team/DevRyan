// Compact, role-specific rule sets for managed child tasks.
//
// In Claude compatibility mode Meridian drops opencode's system prompt for
// Anthropic-routed sessions, so designer.md / fixer.md never reach the child.
// Text in the user turn IS honoured, so the host prepends one of these contracts
// to the first task prompt. Kept deliberately short: it rides on every
// Anthropic-routed sub-agent prompt and must not crowd out the brief itself.

export const MANAGED_AGENT_CONTRACT_TAG = '[devryan-agent-contract:v1]';
export const MANAGED_AGENT_CONTRACT_MAX_LINES = 25;
export const MANAGED_AGENT_CONTRACT_DEFAULT_ROLE = 'default';
export const MANAGED_AGENT_CONTRACT_ROLES = Object.freeze([
  'designer',
  'fixer',
  'explorer',
  'librarian',
  'oracle',
]);

const READ_ONLY_ROLE_LINE = 'Read-only role: do not edit files, and do not run tests, builds, or linters unless the prompt assigns it. Report findings with exact file paths.';

const ROLE_LINES = Object.freeze({
  designer: Object.freeze([
    'Designer: validate what users actually see: layout, states, dark and light themes, mobile and desktop. Do not run tsc for a UI-only task unless the task asks for it.',
  ]),
  fixer: Object.freeze([
    'Fixer: verification means the focused acceptance check you were assigned, run once at the end; no broad sweeps.',
  ]),
  explorer: Object.freeze([READ_ONLY_ROLE_LINE]),
  librarian: Object.freeze([READ_ONLY_ROLE_LINE]),
  oracle: Object.freeze([READ_ONLY_ROLE_LINE]),
  [MANAGED_AGENT_CONTRACT_DEFAULT_ROLE]: Object.freeze([]),
});

export const normalizeManagedAgentContractRole = (agent) => {
  const role = typeof agent === 'string' ? agent.trim().toLowerCase() : '';
  return MANAGED_AGENT_CONTRACT_ROLES.includes(role) ? role : MANAGED_AGENT_CONTRACT_DEFAULT_ROLE;
};

const describeRole = (role) => (
  role === MANAGED_AGENT_CONTRACT_DEFAULT_ROLE ? 'sub-agent' : role
);

export const buildManagedAgentContract = ({ agent } = {}) => {
  const role = normalizeManagedAgentContractRole(agent);
  const lines = [
    `${MANAGED_AGENT_CONTRACT_TAG} Rules for this managed ${describeRole(role)} task. They stand in for agent instructions that are not loaded in this mode; follow them together with the brief below.`,
    'Scope: edit only the files the task names. Report newly discovered unrelated work back to the parent instead of doing it.',
    'Foreign changes: uncommitted changes you did not make are out of scope. Do not ask about them, revert them, or validate them.',
    'Git: run no git commands (no status, diff, add, commit, stash, checkout). The parent owns version control.',
    'Validation budget: at most 2 focused test runs and 1 type-check, plus one final acceptance check. Report external failures; do not absorb them.',
    ...ROLE_LINES[role],
    'Finish: end your final message with exactly one terminal marker line: **Status:** complete or **Status:** blocked.',
    'Blocked only when the brief is missing, a tool or provider fails, or a rule cannot be satisfied; otherwise finish and report.',
  ];
  return lines.join('\n');
};
