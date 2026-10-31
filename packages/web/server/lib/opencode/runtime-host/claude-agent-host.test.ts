import { expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertClaudeAgentArgs, buildClaudeAgentEnvironment, claudeAgentUsageFromEvent, claudeAgentUsageFromReport, createClaudeAgentHost, readClaudeAgentUsage } from './claude-agent-host.js';
import { createClaudeAgentChannel } from './claude-agent-io.js';
import { CLAUDE_AGENT_EXECUTABLE } from './claude-agent-protocol.js';

// The argv Agent SDK 0.3.301 builds for OpenCode's claude-agent probe (captured from a real run).
const PROBE = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--model=haiku',
  '--allowedTools=mcp__opencode__*', '--tools=', '--setting-sources=', '--strict-mcp-config', '--permission-mode=dontAsk',
  '--no-session-persistence', '--settings', '{"disableAllHooks":true}'];
const SESSION = [...PROBE.filter(arg => arg !== '--no-session-persistence'), '--include-partial-messages', '--effort=high',
  '--session-id=0b6c5f8e-6a0e-4f0f-9a43-0f1c2d3e4f50', '--mcp-config', '{"mcpServers":{"opencode":{"type":"sdk","name":"opencode"}}}'];
const RATE = { status: 'allowed', resetsAt: 1793829600, rateLimitType: 'seven_day', overageStatus: 'rejected', isUsingOverage: false,
  unifiedWindows: { seven_day: { utilization: 0.55, resetsAt: 1793829600, status: 'allowed' }, five_hour: { utilization: 0.12, resetsAt: 1793800000, status: 'allowed' } } };

test('accepts only the tool-less SDK invocation', () => {
  expect(assertClaudeAgentArgs(PROBE)).toBe(PROBE);
  expect(assertClaudeAgentArgs(SESSION)).toBe(SESSION);
  const without = (flag: string) => PROBE.filter(arg => !arg.startsWith(flag));
  for (const args of [
    [...PROBE, '--dangerously-skip-permissions'], [...PROBE, '--allow-dangerously-skip-permissions'], [...PROBE, '--add-dir=/'],
    PROBE.map(arg => arg === '--tools=' ? '--tools=Bash' : arg), PROBE.map(arg => arg.startsWith('--allowedTools') ? '--allowedTools=Bash' : arg),
    PROBE.map(arg => arg === '--permission-mode=dontAsk' ? '--permission-mode=bypassPermissions' : arg),
    PROBE.map(arg => arg === '{"disableAllHooks":true}' ? '{"disableAllHooks":true,"env":{"X":"1"}}' : arg),
    [...PROBE, '--mcp-config', '{"mcpServers":{"opencode":{"type":"stdio","command":"sh"}}}'],
    [...PROBE, '--plugin-dir=/tmp/x'], [...PROBE, '--model=$(id)'], without('--tools'), without('--permission-mode'), [...PROBE, '--settings'],
  ]) expect(() => assertClaudeAgentArgs(args)).toThrow('claude_agent_argument_refused');
});

test('environment keeps the user home and drops controller roots and unknown keys', () => {
  const env = buildClaudeAgentEnvironment({ HOME: '/bundle/global/home', XDG_CONFIG_HOME: '/bundle/config', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    DISABLE_AUTO_COMPACT: '1', NODE_OPTIONS: '--require /tmp/x.js', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
  { hostEnv: { PATH: '/usr/bin', SECRET: 'x' }, home: '/Users/person', accountHome: '/Users/person', tmpdir: '/private/tmp' });
  expect(env).toEqual({ HOME: '/Users/person', TMPDIR: '/private/tmp', PATH: '/usr/bin', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', DISABLE_AUTO_COMPACT: '1' });
  // An isolated host keeps the account's keychain and moves only Claude Code's own state.
  const isolated = buildClaudeAgentEnvironment({}, { hostEnv: {}, home: '/qa/home', accountHome: '/Users/person', tmpdir: '/private/tmp' });
  expect(isolated).toEqual({ HOME: '/Users/person', TMPDIR: '/private/tmp', CLAUDE_CONFIG_DIR: '/qa/home/.claude' });
});

test('rate-limit events reduce to persisted subscription windows', () => {
  const usage = claudeAgentUsageFromEvent(RATE, undefined, 1000);
  expect(usage).toEqual({ version: 1, updatedAt: 1000, overage: { status: 'rejected', using: false }, windows: {
    seven_day: { utilization: 0.55, resetsAt: 1793829600, status: 'allowed' }, five_hour: { utilization: 0.12, resetsAt: 1793800000, status: 'allowed' } } });
  // A later single-window event keeps the other window.
  const next = claudeAgentUsageFromEvent({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.81, resetsAt: 1793800000 }, usage, 2000);
  expect(next?.windows.five_hour).toEqual({ utilization: 0.81, resetsAt: 1793800000, status: 'allowed_warning' });
  expect(next?.windows.seven_day?.utilization).toBe(0.55);
  expect(claudeAgentUsageFromEvent({ rateLimitType: 'unknown', utilization: 0.5 }, undefined, 3000)?.windows).toEqual({});
});

// Claude Code 2.1.311's `/usage` answer for a plan with no 5-hour window (trimmed).
const REPORT = { subscription_type: 'max', rate_limits_available: true, rate_limits: {
  five_hour: null, seven_day: { utilization: 64, resets_at: '2026-11-04T22:00:00.737110+00:00' }, seven_day_opus: null,
  model_scoped: [{ display_name: 'Fable', utilization: 28, resets_at: '2026-11-04T21:59:59.737260+00:00' }, { display_name: '../x', utilization: 1, resets_at: null }] } };

test('the /usage report replaces the recorded windows', () => {
  const previous = claudeAgentUsageFromEvent(RATE, undefined, 1000);
  const usage = claudeAgentUsageFromReport(REPORT, previous, 5000);
  expect(usage).toEqual({ version: 1, updatedAt: 5000, overage: { status: 'rejected', using: false },
    windows: { seven_day: { utilization: 0.64, resetsAt: 1793829600, status: 'allowed' } }, models: [{ name: 'Fable', utilization: 0.28, resetsAt: 1793829599 }] });
  // A turn's limit status stays while its window is the same one.
  const blocked = claudeAgentUsageFromEvent({ rateLimitType: 'seven_day', utilization: 1, resetsAt: 1793829600, status: 'rejected' }, usage, 6000);
  expect(blocked?.models).toEqual(usage?.models);
  expect(claudeAgentUsageFromReport(REPORT, blocked, 7000)?.windows.seven_day).toEqual({ utilization: 0.64, resetsAt: 1793829600, status: 'rejected' });
  // API-key and signed-out sessions report no plan limits; the last record stays.
  expect(claudeAgentUsageFromReport({ rate_limits_available: false, rate_limits: null }, usage, 8000)).toBe(usage);
});

test('usage refresh asks Claude Code at most once a minute and persists the answer', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-claude-agent-')));
  try {
    const usageFile = path.join(root, 'runtime', 'claude-agent-usage.json');
    let clock = 10_000, calls = 0, fail = false;
    const requests: unknown[] = [];
    const host = createClaudeAgentHost({ usageFile, resolveExecutable: () => '/opt/claude', now: () => clock,
      environment: () => ({ HOME: '/Users/person' }),
      readUsageReport: async request => { calls++; requests.push(request); if (fail) throw new Error('signed out'); return REPORT; } });
    const [first, second] = await Promise.all([host.refreshUsage(), host.refreshUsage()]);
    expect(first).toBe(second);
    expect(calls).toBe(1);
    expect(requests[0]).toMatchObject({ executable: '/opt/claude', env: { HOME: '/Users/person' }, timeoutMs: 15_000 });
    expect(first?.windows.seven_day?.utilization).toBe(0.64);
    clock += 30_000;
    await host.refreshUsage({ force: true });
    expect(calls).toBe(1);
    clock += 31_000; fail = true;
    expect((await host.refreshUsage())?.updatedAt).toBe(10_000);
    expect(calls).toBe(2);
    await host.close();
    expect(readClaudeAgentUsage(usageFile)?.models?.[0]?.name).toBe('Fable');
    const missing = createClaudeAgentHost({ resolveExecutable: () => undefined, readUsageReport: async () => { calls++; return REPORT; } });
    expect(await missing.refreshUsage({ force: true })).toBeUndefined();
    expect(calls).toBe(2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

const connect = (options: Parameters<typeof createClaudeAgentHost>[0]) => {
  const host = createClaudeAgentHost(options);
  // Frames cross JSON lines in both directions, as over the controller's stdio.
  const channel = createClaudeAgentChannel(value => host.accept(JSON.parse(JSON.stringify(value))));
  host.attach(value => channel.accept(JSON.parse(JSON.stringify(value))));
  return { host, channel };
};
const collect = (child: ReturnType<NonNullable<ReturnType<typeof createClaudeAgentChannel>['io']['spawn']>>) => new Promise<{ stdout: string; code: number | null; errors: string[] }>(resolve => {
  let stdout = '';
  const errors: string[] = [];
  child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString('utf8'); });
  child.on('error', error => { errors.push(error.message); });
  child.on('exit', code => setImmediate(() => resolve({ stdout, code, errors })));
});

test('relays a host-launched process and records its usage', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-claude-agent-')));
  try {
    const claude = path.join(root, 'claude'), usageFile = path.join(root, 'runtime', 'claude-agent-usage.json');
    // Echoes stdin and reports one rate-limit event, like Claude Code's stream-json output.
    await fs.writeFile(claude, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: RATE })}'\nprintf 'home=%s\\n' "$HOME"\ncat\nexit 3\n`, { mode: 0o755 });
    const { host, channel } = connect({ usageFile, resolveExecutable: () => claude,
      environment: requested => buildClaudeAgentEnvironment(requested, { home: root, accountHome: root }) });
    const spawn = channel.io.spawn;
    if (!spawn) throw new Error('spawn missing');
    const child = spawn({ command: CLAUDE_AGENT_EXECUTABLE, args: PROBE, cwd: root, env: { HOME: '/bundle/home' }, signal: new AbortController().signal });
    const result = collect(child);
    child.stdin.end(Buffer.alloc(40_000, 'x'));
    const { stdout, code } = await result;
    expect(code).toBe(3);
    expect(stdout).toContain(`home=${root}\n`);
    expect(stdout.endsWith('x'.repeat(40_000))).toBe(true);
    await host.close();
    expect(readClaudeAgentUsage(usageFile)?.windows.seven_day?.utilization).toBe(0.55);
    expect(host.usage()?.windows.five_hour?.utilization).toBe(0.12);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('refusals settle the process with a readable error', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-claude-agent-')));
  try {
    const missing = connect({ resolveExecutable: () => undefined });
    const spawnMissing = missing.channel.io.spawn;
    if (!spawnMissing) throw new Error('spawn missing');
    const absent = await collect(spawnMissing({ command: CLAUDE_AGENT_EXECUTABLE, args: PROBE, cwd: root, env: {}, signal: new AbortController().signal }));
    expect(absent.code).toBe(1);
    expect(absent.errors[0]).toMatch(/Claude Code is not installed/);
    const refused = await collect(spawnMissing({ command: CLAUDE_AGENT_EXECUTABLE, args: [...PROBE, '--add-dir=/'], cwd: root, env: {}, signal: new AbortController().signal }));
    expect(refused.errors[0]).toMatch(/refused a Claude Code option/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('session files are read and written on the host', async () => {
  const calls: string[] = [];
  const sessionID = '0b6c5f8e-6a0e-4f0f-9a43-0f1c2d3e4f50', copy = '1b6c5f8e-6a0e-4f0f-9a43-0f1c2d3e4f51';
  const { channel } = connect({ loadSessions: async () => ({
    exists: async (id: string) => { calls.push(`exists:${id}`); return true; },
    remove: async (id: string) => { calls.push(`remove:${id}`); },
    fork: async (id: string, message: string) => { calls.push(`fork:${id}:${message}`); return { sessionID: copy, messages: new Map([[message, copy]]) }; },
  }) });
  expect(await channel.io.sessionExists(sessionID)).toBe(true);
  expect(await channel.io.fork(sessionID, sessionID)).toEqual({ sessionID: copy, messages: new Map([[sessionID, copy]]) });
  await channel.io.remove(sessionID);
  expect(calls).toEqual([`exists:${sessionID}`, `fork:${sessionID}:${sessionID}`, `remove:${sessionID}`]);
  channel.close();
  await expect(channel.io.sessionExists(sessionID)).rejects.toThrow('claude_agent_closed');
});
