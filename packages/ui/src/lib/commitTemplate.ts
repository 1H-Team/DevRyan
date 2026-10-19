/**
 * Deterministic conventional-commit setup.
 *
 * This module replaces the previous AI-driven commit message generation. It
 * supplies the static `.gitmessage` template + the `commit-msg` hook script,
 * and exposes `validateCommitMessage` so the same rules can be enforced in
 * the app (preflight, before shelling out to git) and on disk (hook script
 * that catches CLI commits too).
 */

export const ALLOWED_COMMIT_TYPES = [
  'feat',
  'fix',
  'refactor',
  'perf',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
  'style',
  'revert',
] as const;

export type AllowedCommitType = (typeof ALLOWED_COMMIT_TYPES)[number];

export const PREFERRED_COMMIT_SCOPES = [
  'dashboard',
  'admin',
  'data',
  'db',
  'i18n',
  'services',
  'analytics',
  'booking',
  'billing',
  'provider',
  'professionals',
  'components',
] as const;

export const COMMIT_SUBJECT_MAX_LENGTH = 72;

// The template text written to ~/.config/git/message. Comment lines (`#`) are
// stripped by git's default `commit.cleanup=strip` mode on commit.
export const COMMIT_TEMPLATE_CONTENT = `

# ----------------------------------------------------------------------
# Conventional Commit template
#
# Format:
#   type(scope): summary
# or:
#   type: summary           (only when no clear scope fits)
#
# Allowed types:
#   ${ALLOWED_COMMIT_TYPES.join(', ')}
#
# Preferred scopes:
#   ${PREFERRED_COMMIT_SCOPES.join(', ')}
#
# Rules:
#   - subject must be non-empty
#   - subject ≤ ${COMMIT_SUBJECT_MAX_LENGTH} characters
#   - imperative mood, no trailing period
# ----------------------------------------------------------------------
`;

const TYPE_PATTERN = ALLOWED_COMMIT_TYPES.join('|');
// type(scope): summary  OR  type: summary
// type and scope are lowercase alnum/hyphens; summary is anything non-empty.
const SUBJECT_REGEX = new RegExp(
  `^(${TYPE_PATTERN})(?:\\(([a-z0-9][a-z0-9_-]*)\\))?(!)?:\\s+(\\S.*)$`,
);

export interface CommitMessageValidation {
  valid: boolean;
  errors: string[];
  /** Cleaned message — comments stripped, trimmed. */
  cleaned: string;
}

/** Strip `#`-prefixed lines (mirroring git's default commit.cleanup=strip). */
export function stripCommitComments(message: string): string {
  return message
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/^\s+|\s+$/g, '');
}

/**
 * Apply the same validation rules as the commit-msg hook. Pure function; can
 * run in the browser preflight or be ported to bash for the hook.
 */
export function validateCommitMessage(message: string): CommitMessageValidation {
  const cleaned = stripCommitComments(message);
  const errors: string[] = [];

  if (cleaned.length === 0) {
    errors.push('Commit message is empty');
    return { valid: false, errors, cleaned };
  }

  const firstLine = cleaned.split(/\r?\n/, 1)[0] ?? '';

  if (firstLine.length > COMMIT_SUBJECT_MAX_LENGTH) {
    errors.push(
      `Subject is ${firstLine.length} chars; keep it ≤ ${COMMIT_SUBJECT_MAX_LENGTH}`,
    );
  }

  const match = SUBJECT_REGEX.exec(firstLine);
  if (!match) {
    errors.push(
      `Subject must match "type(scope): summary" or "type: summary" using one of: ${ALLOWED_COMMIT_TYPES.join(', ')}`,
    );
    return { valid: false, errors, cleaned };
  }

  const summary = match[4]?.trim() ?? '';
  if (summary.length === 0) {
    errors.push('Subject summary is empty');
  }
  if (/\.$/.test(summary)) {
    errors.push('Subject summary must not end with a period');
  }

  return { valid: errors.length === 0, errors, cleaned };
}

/**
 * Bash content of the `commit-msg` hook. Installed at
 * ~/.config/git/hooks/commit-msg with executable bit; opt-in via the global
 * `core.hooksPath` setting so it applies to every repo on the machine without
 * touching repo-local files.
 *
 * Kept in lockstep with `validateCommitMessage`. Update both together.
 */
export function buildCommitMsgHookScript(): string {
  const typeAlternation = ALLOWED_COMMIT_TYPES.join('|');
  return `#!/usr/bin/env bash
# Conventional Commit validator (managed by DevRyan)
# Installed via global core.hooksPath. Edit at ~/.config/git/hooks/commit-msg.
set -euo pipefail

msg_file="\${1:-}"
if [ -z "\${msg_file}" ] || [ ! -f "\${msg_file}" ]; then
  exit 0
fi

# Match git's default commit.cleanup=strip: drop comment-only lines and trim.
cleaned="$(grep -v '^[[:space:]]*#' "\${msg_file}" | awk 'NF {found=1} found' | awk 'NF || prev {print; prev=NF}' | sed -e :a -e '/^\\n*$/{$d;N;ba' -e '}')"

if [ -z "\${cleaned}" ]; then
  echo "✖ commit-msg: empty commit message after stripping comments" >&2
  exit 1
fi

subject="$(printf '%s\\n' "\${cleaned}" | head -n 1)"
subject_len=\${#subject}
max_len=${COMMIT_SUBJECT_MAX_LENGTH}

errors=()

if [ "\${subject_len}" -gt "\${max_len}" ]; then
  errors+=("subject is \${subject_len} chars; keep it ≤ \${max_len}")
fi

# type(scope)!: summary | type(scope): summary | type!: summary | type: summary
subject_re='^(${typeAlternation})(\\([a-z0-9][a-z0-9_-]*\\))?(!)?:[[:space:]]+[^[:space:]].*$'
if ! [[ "\${subject}" =~ \${subject_re} ]]; then
  errors+=("subject must match 'type(scope): summary' or 'type: summary' using one of: ${ALLOWED_COMMIT_TYPES.join(', ')}")
fi

# Reject trailing period on summary.
if [[ "\${subject}" =~ \\.[[:space:]]*$ ]]; then
  errors+=("subject summary must not end with a period")
fi

if [ "\${#errors[@]}" -gt 0 ]; then
  echo "✖ commit-msg validation failed:" >&2
  for err in "\${errors[@]}"; do
    echo "   - \${err}" >&2
  done
  echo "" >&2
  echo "Allowed types: ${ALLOWED_COMMIT_TYPES.join(', ')}" >&2
  echo "Subject:       \${subject}" >&2
  exit 1
fi

exit 0
`;
}
