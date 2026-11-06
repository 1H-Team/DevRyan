import { execFile } from 'child_process';
import { promisify } from 'util';
import { getRequestPrincipal } from '../multi-user/request-context.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

// The characters escapeSshKeyPath (lib/git/service.js) and
// escapeCloneSshKeyPath (lib/fs/routes.js) refuse in a key path.
const SSH_KEY_PATH_REFUSED_CHARACTERS = /[`$!"';&|<>(){}[\]*?#~]/;

/**
 * The `core.sshCommand` for an identity's SSH key. Git runs it through the
 * shell, so the key path follows the other clone paths' rule: a path with a
 * shell metacharacter is refused, any other is single-quoted, in the MSYS form
 * (`/c/...`) on Windows. Without a key there is no command.
 *
 * @param {{ sshKey?: unknown } | null | undefined} identity
 * @param {string} [platform] `process.platform` unless given.
 * @returns {{ ok: true, sshCommand: string | null } | { ok: false, error: { kind: 'invalidSource', message: string } }}
 */
export function sshCommandForIdentity(identity, platform = process.platform) {
  const sshKeyPath = identity?.sshKey ? String(identity.sshKey).trim() : '';
  if (!sshKeyPath) {
    return { ok: true, sshCommand: null };
  }

  const normalized = platform === 'win32' ? sshKeyPath.replace(/\\/g, '/') : sshKeyPath;
  if (SSH_KEY_PATH_REFUSED_CHARACTERS.test(normalized)) {
    return {
      ok: false,
      error: { kind: 'invalidSource', message: `SSH key path contains invalid characters: ${sshKeyPath}` },
    };
  }

  const driveMatch = platform === 'win32' ? normalized.match(/^([A-Za-z]):\//) : null;
  const keyPath = driveMatch ? `/${driveMatch[1].toLowerCase()}${normalized.slice(2)}` : normalized;
  // The single quote is itself refused, so the quoted path needs no escapes.
  // Avoid interactive host key prompts; still safe against changed keys.
  return { ok: true, sshCommand: `ssh -i '${keyPath}' -o BatchMode=yes -o StrictHostKeyChecking=accept-new` };
}

export function looksLikeAuthError(message) {
  const text = String(message || '');
  return (
    /permission denied/i.test(text) ||
    /publickey/i.test(text) ||
    /could not read from remote repository/i.test(text) ||
    /authentication failed/i.test(text) ||
    /fatal: could not/i.test(text)
  );
}

const isManagedRequest = () => getRequestPrincipal()?.scope === 'managed';

/**
 * The Git identity a scan or install clones with. Managed Git refuses the SSH
 * transport, so a managed principal's scan or install ignores the identity
 * profile's key and clones over HTTPS with only its own GitHub token.
 *
 * @template T
 * @param {T | null | undefined} identity
 * @returns {T | null}
 */
export function gitIdentityForRequest(identity) {
  return isManagedRequest() ? null : identity ?? null;
}

/**
 * The error for a clone that failed to authenticate. A managed principal can
 * authenticate only with its own GitHub account.
 *
 * @returns {{ kind: 'authRequired', message: string, sshOnly: true }}
 */
export function authRequiredError() {
  return {
    kind: 'authRequired',
    message: isManagedRequest()
      ? 'Authentication required to access this repository. Connect a GitHub account that can read it.'
      : 'Authentication required to access this repository',
    // A field of the response contract that no client reads.
    sshOnly: true,
  };
}

// A managed principal's catalog Git runs in the Git service's environment
// (buildGitEnv in lib/git/service.js): without the host's credential helpers,
// askpass programs and SSH transport, with only the principal's own GitHub
// token. Everyone else's keeps the server's environment.
const gitEnvironment = async () => {
  if (!isManagedRequest()) {
    return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  }
  const { buildGitEnv } = await import('../git/index.js');
  return { ...(await buildGitEnv(null, { includeCredentials: true })), GIT_TERMINAL_PROMPT: '0' };
};

export async function runGit(args, options = {}) {
  const cwd = options.cwd;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBuffer = Number.isFinite(options.maxBuffer) ? options.maxBuffer : DEFAULT_MAX_BUFFER;

  const normalizedArgs = Array.isArray(args) ? args.slice() : [];

  // A refused key path fails here, without starting git.
  const ssh = sshCommandForIdentity(options.identity || null);
  if (!ssh.ok) {
    return { ok: false, stdout: '', stderr: '', message: ssh.error.message, code: null, signal: null };
  }
  if (ssh.sshCommand) {
    normalizedArgs.unshift('-c', `core.sshCommand=${ssh.sshCommand}`);
  }

  // Non-interactive git (avoid prompts / hangs)
  const env = await gitEnvironment();

  try {
    const { stdout, stderr } = await execFileAsync('git', normalizedArgs, {
      cwd,
      env,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer,
    });

    return { ok: true, stdout: stdout || '', stderr: stderr || '' };
  } catch (error) {
    const err = error;
    const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
    const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
    const message = err instanceof Error ? err.message : String(err);

    return {
      ok: false,
      stdout,
      stderr,
      message,
      code: typeof err?.code === 'number' ? err.code : null,
      signal: typeof err?.signal === 'string' ? err.signal : null,
    };
  }
}

export async function assertGitAvailable() {
  const result = await runGit(['--version'], { timeoutMs: 5_000 });
  if (!result.ok) {
    return { ok: false, error: { kind: 'gitUnavailable', message: 'Git is not available in PATH' } };
  }
  return { ok: true };
}
