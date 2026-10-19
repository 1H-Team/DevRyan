/**
 * Routes that install/uninstall the global conventional-commit setup.
 *
 * The setup is intentionally global (not per-repo) so the user opts in once
 * and every repo on the machine gets the template + validation hook. Three
 * artifacts on disk:
 *
 *   ~/.config/git/message       — commit.template body (comments + format)
 *   ~/.config/git/hooks/commit-msg  — bash validator (lockstep with TS validator)
 *   ~/.gitconfig                — sets commit.template and core.hooksPath
 *
 * The hook script content and template body live in the TS module
 * `packages/ui/src/lib/commitTemplate.ts`. For the server they're inlined
 * below (regenerated from the TS source) so the server has no dependency on
 * the UI bundle.
 */

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';

const ALLOWED_COMMIT_TYPES = [
  'feat', 'fix', 'refactor', 'perf', 'docs', 'test',
  'build', 'ci', 'chore', 'style', 'revert',
];

const PREFERRED_COMMIT_SCOPES = [
  'dashboard', 'admin', 'data', 'db', 'i18n', 'services', 'analytics',
  'booking', 'billing', 'provider', 'professionals', 'components',
];

const SUBJECT_MAX_LENGTH = 72;

const TEMPLATE_BODY = `

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
#   - subject ≤ ${SUBJECT_MAX_LENGTH} characters
#   - imperative mood, no trailing period
# ----------------------------------------------------------------------
`;

const HOOK_SCRIPT = `#!/usr/bin/env bash
# Conventional Commit validator (managed by DevRyan)
# Installed via global core.hooksPath. Edit at ~/.config/git/hooks/commit-msg.
set -euo pipefail

msg_file="\${1:-}"
if [ -z "\${msg_file}" ] || [ ! -f "\${msg_file}" ]; then
  exit 0
fi

cleaned="$(grep -v '^[[:space:]]*#' "\${msg_file}" | awk 'NF || prev {print; prev=NF}' | awk 'BEGIN{found=0} { if (NF) found=1; if (found) print }')"

if [ -z "\${cleaned}" ]; then
  echo "✖ commit-msg: empty commit message after stripping comments" >&2
  exit 1
fi

subject="$(printf '%s\\n' "\${cleaned}" | head -n 1)"
subject_len=\${#subject}
max_len=${SUBJECT_MAX_LENGTH}

errors=()

if [ "\${subject_len}" -gt "\${max_len}" ]; then
  errors+=("subject is \${subject_len} chars; keep it ≤ \${max_len}")
fi

subject_re='^(${ALLOWED_COMMIT_TYPES.join('|')})(\\([a-z0-9][a-z0-9_-]*\\))?(!)?:[[:space:]]+[^[:space:]].*$'
if ! [[ "\${subject}" =~ \${subject_re} ]]; then
  errors+=("subject must match 'type(scope): summary' or 'type: summary' using one of: ${ALLOWED_COMMIT_TYPES.join(', ')}")
fi

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

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.config', 'git');
const TEMPLATE_PATH = path.join(CONFIG_DIR, 'message');
const HOOKS_DIR = path.join(CONFIG_DIR, 'hooks');
const HOOK_PATH = path.join(HOOKS_DIR, 'commit-msg');

const runGit = (args) => new Promise((resolve, reject) => {
  const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) resolve(stdout.trim());
    else if (code === 1) resolve(''); // `git config --get` returns 1 when unset
    else reject(new Error(stderr.trim() || `git ${args.join(' ')} exited ${code}`));
  });
});

const readGitConfig = (key) => runGit(['config', '--global', '--get', key]);
const setGitConfig = (key, value) => runGit(['config', '--global', key, value]);
const unsetGitConfig = async (key) => {
  try {
    await runGit(['config', '--global', '--unset', key]);
  } catch (error) {
    // 5 = no such section/key; treat as already-unset.
    if (!/exit code 5|key/i.test(error.message || '')) throw error;
  }
};

const safeReadFile = async (filePath) => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
};

const fileMatches = (existing, expected) => {
  if (existing == null) return false;
  return existing.replace(/\r\n/g, '\n').trim() === expected.replace(/\r\n/g, '\n').trim();
};

export function registerCommitTemplateRoutes(app) {
  app.get('/api/git/commit-template/status', async (_req, res) => {
    try {
      const [templateOnDisk, hookOnDisk, configuredTemplate, configuredHooksPath] = await Promise.all([
        safeReadFile(TEMPLATE_PATH),
        safeReadFile(HOOK_PATH),
        readGitConfig('commit.template'),
        readGitConfig('core.hooksPath'),
      ]);

      const templatePresent = templateOnDisk !== null;
      const hookPresent = hookOnDisk !== null;
      const templateMatches = fileMatches(templateOnDisk, TEMPLATE_BODY);
      const hookMatches = fileMatches(hookOnDisk, HOOK_SCRIPT);
      const templateConfigured = configuredTemplate === TEMPLATE_PATH;
      const hooksPathConfigured = configuredHooksPath === HOOKS_DIR;

      const installed = templatePresent && hookPresent && templateMatches && hookMatches
        && templateConfigured && hooksPathConfigured;

      res.json({
        installed,
        templatePath: TEMPLATE_PATH,
        hookPath: HOOK_PATH,
        hooksDir: HOOKS_DIR,
        templatePresent,
        hookPresent,
        templateMatches,
        hookMatches,
        templateConfigured,
        hooksPathConfigured,
        currentTemplate: configuredTemplate,
        currentHooksPath: configuredHooksPath,
      });
    } catch (error) {
      console.error('Failed to read commit template status:', error);
      res.status(500).json({ error: error.message || 'Failed to read status' });
    }
  });

  app.post('/api/git/commit-template/install', async (_req, res) => {
    try {
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      await fs.mkdir(HOOKS_DIR, { recursive: true });
      await fs.writeFile(TEMPLATE_PATH, TEMPLATE_BODY, 'utf8');
      await fs.writeFile(HOOK_PATH, HOOK_SCRIPT, { encoding: 'utf8', mode: 0o755 });
      // Re-set mode in case writeFile honored umask.
      await fs.chmod(HOOK_PATH, 0o755);

      await setGitConfig('commit.template', TEMPLATE_PATH);
      await setGitConfig('core.hooksPath', HOOKS_DIR);

      res.json({
        success: true,
        templatePath: TEMPLATE_PATH,
        hookPath: HOOK_PATH,
        hooksDir: HOOKS_DIR,
      });
    } catch (error) {
      console.error('Failed to install commit template:', error);
      res.status(500).json({ error: error.message || 'Failed to install commit template' });
    }
  });

  app.post('/api/git/commit-template/uninstall', async (_req, res) => {
    try {
      await unsetGitConfig('commit.template');
      await unsetGitConfig('core.hooksPath');
      // Leave the on-disk files in place by default — they're user-owned and
      // re-enabling later is a one-click. If we want destructive uninstall,
      // we can add an explicit `?removeFiles=1`.
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to uninstall commit template:', error);
      res.status(500).json({ error: error.message || 'Failed to uninstall commit template' });
    }
  });

  app.get('/api/git/commit-template/content', async (_req, res) => {
    try {
      const onDisk = await safeReadFile(TEMPLATE_PATH);
      res.json({
        templatePath: TEMPLATE_PATH,
        content: onDisk ?? TEMPLATE_BODY,
        fromDisk: onDisk !== null,
      });
    } catch (error) {
      console.error('Failed to read commit template content:', error);
      res.status(500).json({ error: error.message || 'Failed to read template content' });
    }
  });
}
