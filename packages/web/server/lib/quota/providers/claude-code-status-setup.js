import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { getRuntimeHome } from '../../opencode/runtime-host/runtime-bundle-binding.js';
import { dirname, join } from 'path';

import { isPlainObject } from '../../opencode/shared.js';
import { CLAUDE_CODE_STATUS_PATH } from './claude-code-status.js';

export const CLAUDE_CODE_STATUS_SCRIPT_PATH = join(getRuntimeHome(), '.cache', 'openchamber', 'claude-code-status-line.sh');
export const CLAUDE_CODE_SETTINGS_PATH = join(getRuntimeHome(), '.claude', 'settings.json');
export const CLAUDE_CODE_USAGE_PENDING_CODE = 'claude_code_usage_pending';
export const CLAUDE_CODE_STATUS_LINE_CUSTOM_CODE = 'claude_code_status_line_custom';
export const CLAUDE_CODE_STATUS_SETUP_FAILED_CODE = 'claude_code_status_setup_failed';
export const CLAUDE_CODE_USAGE_PENDING_MESSAGE = 'OpenChamber refreshed Claude Code with the Claude CLI, but Claude Code did not emit usage data yet.';

const MANAGED_SCRIPT_HEADER = '# Managed by OpenChamber. Writes Claude Code status-line JSON for usage display.';

const shellSingleQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export const getManagedStatusLineCommand = ({ scriptPath = CLAUDE_CODE_STATUS_SCRIPT_PATH } = {}) => shellSingleQuote(scriptPath);

export const buildClaudeCodeStatusLineScript = ({ statusPath = CLAUDE_CODE_STATUS_PATH } = {}) => `#!/bin/sh
${MANAGED_SCRIPT_HEADER}
set -u

STATUS_PATH=${shellSingleQuote(statusPath)}
STATUS_DIR=$(dirname "$STATUS_PATH")
mkdir -p "$STATUS_DIR" || exit 0

input=$(cat)
tmp="$STATUS_PATH.$$"
if printf '%s\n' "$input" > "$tmp"; then
  mv "$tmp" "$STATUS_PATH" 2>/dev/null || rm -f "$tmp"
else
  rm -f "$tmp"
fi

if command -v node >/dev/null 2>&1; then
  STATUS_INPUT="$input" node -e '
const input = process.env.STATUS_INPUT || "{}";
try {
  const payload = JSON.parse(input);
  const fiveHour = payload?.rate_limits?.five_hour?.used_percentage;
  const sevenDay = payload?.rate_limits?.seven_day?.used_percentage;
  const format = (value) => Number.isFinite(Number(value)) ? String(Math.round(Number(value))) + "%" : "?";
  console.log("5h " + format(fiveHour) + " · 7d " + format(sevenDay));
} catch {
  console.log("Claude usage captured");
}
' 2>/dev/null && exit 0
fi

echo "Claude usage captured"
`;

const parseSettingsFile = (settingsPath) => {
  if (!existsSync(settingsPath)) {
    return {};
  }

  const content = readFileSync(settingsPath, 'utf8').trim();
  if (!content) {
    return {};
  }

  const parsed = JSON.parse(content);
  return isPlainObject(parsed) ? parsed : {};
};

const commandMatchesManagedScript = (command, scriptPath) => {
  if (typeof command !== 'string') {
    return false;
  }

  return command === scriptPath || command === getManagedStatusLineCommand({ scriptPath });
};

export const ensureClaudeCodeStatusLineBridge = ({
  settingsPath = CLAUDE_CODE_SETTINGS_PATH,
  scriptPath = CLAUDE_CODE_STATUS_SCRIPT_PATH,
  statusPath = CLAUDE_CODE_STATUS_PATH,
  fs = { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync },
} = {}) => {
  try {
    fs.mkdirSync(dirname(scriptPath), { recursive: true });
    const scriptContent = buildClaudeCodeStatusLineScript({ statusPath });
    let shouldWriteScript = true;
    if (fs.existsSync(scriptPath)) {
      const existing = fs.readFileSync(scriptPath, 'utf8');
      shouldWriteScript = existing !== scriptContent;
    }
    if (shouldWriteScript) {
      fs.writeFileSync(scriptPath, scriptContent, { encoding: 'utf8', mode: 0o755 });
    }
    fs.chmodSync?.(scriptPath, 0o755);

    fs.mkdirSync(dirname(settingsPath), { recursive: true });
    const settings = parseSettingsFileWithFs(settingsPath, fs);
    const statusLine = isPlainObject(settings.statusLine) ? settings.statusLine : null;
    const managedCommand = getManagedStatusLineCommand({ scriptPath });

    if (statusLine?.type === 'command' && commandMatchesManagedScript(statusLine.command, scriptPath)) {
      return { ok: true, status: 'already-configured', scriptPath, statusPath, command: managedCommand };
    }

    if (settings.statusLine !== undefined) {
      // Safety decision: do not wrap arbitrary user commands. Claude Code status lines can be any shell command,
      // so preserving the user's setting is safer than silently replacing behavior.
      return {
        ok: false,
        code: CLAUDE_CODE_STATUS_LINE_CUSTOM_CODE,
        status: 'custom-status-line',
        scriptPath,
        statusPath,
        command: managedCommand,
        error: `Claude Code already has a custom statusLine. To show Anthropic usage in OpenChamber, update Claude Code settings to run ${managedCommand} or merge that script into your existing statusLine command.`,
      };
    }

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ ...settings, statusLine: { type: 'command', command: managedCommand } }, null, 2),
      'utf8'
    );

    return { ok: true, status: 'installed', scriptPath, statusPath, command: managedCommand };
  } catch (error) {
    return {
      ok: false,
      code: CLAUDE_CODE_STATUS_SETUP_FAILED_CODE,
      status: 'error',
      scriptPath,
      statusPath,
      command: getManagedStatusLineCommand({ scriptPath }),
      error: error instanceof Error ? error.message : 'Failed to configure Claude Code usage bridge.',
    };
  }
};

const parseSettingsFileWithFs = (settingsPath, fs) => {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }

  const stats = fs.statSync(settingsPath);
  if (!stats.isFile()) {
    throw new Error('Claude Code settings path exists but is not a file.');
  }

  const content = fs.readFileSync(settingsPath, 'utf8').trim();
  if (!content) {
    return {};
  }

  const parsed = JSON.parse(content);
  return isPlainObject(parsed) ? parsed : {};
};

export { parseSettingsFile };
