// Real interactive Claude Code, using the web package's existing PTY dependency.
// Native turn_duration records establish completion; terminal text only gates
// startup. Authentication is inherited in memory and never written to evidence.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import { repository, isolatedClaudeEnvironment, studyModel, studyEffort } from './claude-quota-fixture.mjs';
import { createQaProcessOwnership } from './process-ownership.mjs';

export async function nativeTranscriptFiles(directory) {
  const files = [];
  const visit = async current => {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
    }
  };
  await visit(path.join(directory, 'projects'));
  return files;
}

export async function startInteractiveClaude({ fixture, claudeExecutable, oauthToken, signal }) {
  const require = createRequire(path.join(repository, 'packages/web/package.json'));
  const pty = require('node-pty');
  const environment = { ...isolatedClaudeEnvironment(fixture, claudeExecutable),
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken, TERM: 'xterm-256color',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const directory of [environment.CLAUDE_CONFIG_DIR, environment.XDG_CONFIG_HOME,
    environment.XDG_DATA_HOME, environment.XDG_STATE_HOME, environment.XDG_CACHE_HOME]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await fs.writeFile(path.join(environment.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, theme: 'dark', bypassPermissionsModeAccepted: true,
    projects: { [fixture.workspace]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }), { mode: 0o600 });
  const terminal = pty.spawn(claudeExecutable, ['--model', studyModel, '--effort', studyEffort, '--name', 'Claude quota fixture',
    '--dangerously-skip-permissions', '--setting-sources', '', '--settings', JSON.stringify({
      autoMemoryEnabled: false, promptSuggestionEnabled: false,
    })], { cwd: fixture.workspace, env: environment, cols: 140, rows: 40, name: 'xterm-256color' });
  let text = '';
  let exited = false;
  const ownedIdentity = { pid: terminal.pid, exitCode: null, signalCode: null };
  const ownership = createQaProcessOwnership(ownedIdentity);
  terminal.onData(data => { text = (text + stripVTControlCharacters(data)).slice(-64 * 1024); });
  terminal.onExit(event => { exited = true; ownedIdentity.exitCode = event.exitCode; ownedIdentity.signalCode = event.signal || null; });
  const wait = async (predicate, timeout = 600_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (exited) throw new Error('Owned interactive Claude exited unexpectedly');
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`Owned interactive Claude timed out (${JSON.stringify({
      bypass: text.includes('bypass'), permissions: text.includes('permissions'),
      opus: text.includes('Opus'), medium: text.includes('medium'), trust: text.includes('trust'),
      tokenPrompt: text.includes('token'), theme: text.includes('theme'), login: text.includes('/login'),
      skipPermissions: text.includes('Bypass Permissions'), acceptRisk: text.includes('Yes, I accept'),
      selectedModel: /(?:Opus|Fable|Sonnet)\s+[0-9.]+/.exec(text)?.[0] ?? null,
    })})`);
  };
  const close = async () => {
    try {
      await ownership.refresh();
      if (!exited) terminal.write('\x1b');
      await new Promise(resolve => setTimeout(resolve, 200));
      if (!exited) terminal.write('/exit\r');
      const deadline = Date.now() + 3000;
      while (!exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (!exited) terminal.kill('SIGTERM');
      await ownership.terminateRemaining();
      await ownership.auditStopped();
    } finally { await ownership.closeTracking(); }
    return ownership.getEvidence();
  };
  try {
    await wait(() => {
      if (/Yes,\s*I\s*trust\s*this\s*folder/.test(text)) { terminal.write('\r'); text = ''; return false; }
      if (text.includes('Not logged in') || text.includes('Please run /login')) throw new Error('Interactive Claude OAuth access is unavailable');
      return /bypass\s*permissions\s*on/.test(text) && /Opus\s*4\.8\s*with\s*medium\s*effort/.test(text);
    }, 45_000);
    return {
      kind: 'interactive-native-pty', claudeDirectory: environment.CLAUDE_CONFIG_DIR,
      close,
      interrupt: () => terminal.write('\x1b'),
      async prompt(prompt, { onPoll, allowInterrupt = false } = {}) {
        const startedAt = Date.now();
        text = '';
        terminal.write(`\x1b[200~${prompt}\x1b[201~`);
        await new Promise(resolve => setTimeout(resolve, 200));
        terminal.write('\r');
        let lastPoll = 0;
        let interrupted = false;
        await wait(async () => {
          for (const file of await nativeTranscriptFiles(environment.CLAUDE_CONFIG_DIR)) {
            const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
            for (const line of lines.slice(-20)) {
              let row;
              try { row = JSON.parse(line); } catch { continue; }
              const interruptedText = Array.isArray(row.message?.content) && row.message.content.length === 1
                ? row.message.content[0]?.text : row.message?.content;
              if (allowInterrupt && row.type === 'user' && Date.parse(row.timestamp) >= startedAt
                && /^\[Request interrupted by user(?: for tool use)?\]$/.test(interruptedText ?? '')) {
                interrupted = true;
                return true;
              }
              if (row.type === 'system' && row.subtype === 'turn_duration' && Date.parse(row.timestamp) >= startedAt) return true;
            }
          }
          if (/Not logged in|Please run \/login|API Error:/.test(text)) throw new Error('Interactive Claude reported an authentication/provider error');
          if (Date.now() - lastPoll > 30_000) { lastPoll = Date.now(); await onPoll?.(); }
          return false;
        });
        return { startedAt, completedAt: Date.now(), interrupted };
      },
    };
  } catch (error) { await close(); throw error; }
}
