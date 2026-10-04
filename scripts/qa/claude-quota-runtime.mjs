// Real DevRyan/OpenCode transport in an owned profile. Credentials are supplied
// only in child environments by the live runner; this module never reads them.
import path from 'node:path';
import { repository } from './claude-quota-fixture.mjs';
import { assertQaLaunchEnvironmentOwned } from './profile-preparation.mjs';

const shim = path.join(repository, 'scripts/qa/isolated-home.mjs');

// The env is built from scratch, so nothing inherited relocates state. Meridian
// runs inside the compiled Bun OpenCode host, where the home shim cannot rebind
// named `homedir` imports and Bun reads HOME only at start (an unset HOME falls
// back to the owner's passwd home). Meridian 1.62.x derives its oauth-token
// profile CLAUDE_CONFIG_DIR, telemetry, profiles and plugins from homedir(), so
// HOME must be the owned QA home.
export function createClaudeQuotaLaunchEnvironment({ runtimeRoot, qaHome, workspace, claudeExecutable }) {
  const env = {
    PATH: process.env.PATH, USER: process.env.USER, TERM: process.env.TERM ?? 'xterm-256color',
    DEVRYAN_QA_RUNTIME_ROOT: runtimeRoot, DEVRYAN_QA_HOME: qaHome, DEVRYAN_QA_RUNTIME: 'web',
    HOME: qaHome, OPENCODE_TEST_HOME: qaHome, XDG_CONFIG_HOME: path.join(qaHome, '.config'),
    XDG_DATA_HOME: path.join(qaHome, '.local/share'), XDG_STATE_HOME: path.join(qaHome, '.local/state'),
    XDG_CACHE_HOME: path.join(qaHome, '.cache'), TMPDIR: path.join(qaHome, 'tmp'),
    OPENCHAMBER_DATA_DIR: path.join(qaHome, '.config/openchamber'), OPENCHAMBER_DIST_DIR: path.join(repository, 'packages/web/dist'),
    CLAUDE_CONFIG_DIR: path.join(qaHome, '.claude'), MERIDIAN_CLAUDE_PATH: claudeExecutable,
    MERIDIAN_CONFIG_DIR: path.join(qaHome, '.config/meridian'), MERIDIAN_SESSION_DIR: path.join(qaHome, '.cache/meridian'),
    MERIDIAN_WORKDIR: workspace, CLAUDE_PROXY_PORT: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(qaHome, '.gitconfig'),
    NODE_OPTIONS: `--import=${JSON.stringify(shim)}`,
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
  };
  assertClaudeQuotaLaunchEnvironmentOwned(env, qaHome);
  return env;
}

// Profiles saved before HOME was owned fail here instead of launching Meridian
// against the owner's real ~/.config/meridian.
export function assertClaudeQuotaLaunchEnvironmentOwned(env, qaHome) {
  if (typeof qaHome !== 'string' || !path.isAbsolute(qaHome) || env.HOME !== qaHome || env.DEVRYAN_QA_HOME !== qaHome) {
    throw new Error('Claude quota launch environment must set HOME to its owned QA home');
  }
  assertQaLaunchEnvironmentOwned(env, qaHome, { executables: ['MERIDIAN_CLAUDE_PATH'] });
}

export async function prepareClaudeQuotaRuntime() {
  throw Object.assign(new Error('The v1 quota runtime profile is retired; native v2 quota runtime qualification is unavailable in this historical lane'),
    { code: 'qa_native_diagnostic_unavailable' });
}

export async function startClaudeQuotaRuntime(profile) {
  assertClaudeQuotaLaunchEnvironmentOwned(profile.env, profile.qaHome);
  throw Object.assign(new Error('The v1 quota runtime launcher is retired; no runtime process was started'),
    { code: 'qa_native_diagnostic_unavailable' });
}
