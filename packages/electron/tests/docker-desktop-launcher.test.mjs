import fs from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { createDockerDesktopLauncher } from '../docker-desktop-launcher.mjs';

const mainSource = fs.readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
const preloadSource = fs.readFileSync(new URL('../preload.mjs', import.meta.url), 'utf8');

describe('createDockerDesktopLauncher', () => {
  test('opens Docker Desktop by its fixed bundle identifier', async () => {
    const calls = [];
    const launcher = createDockerDesktopLauncher({
      platform: 'darwin',
      execFile: async (...args) => { calls.push(args); },
    });

    expect(await launcher.open()).toEqual({ opened: true, code: null });
    expect(calls).toEqual([
      ['/usr/bin/open', ['-g', '-b', 'com.docker.docker'], { timeout: 10_000 }],
    ]);
  });

  test('reports a missing Docker Desktop without throwing', async () => {
    const launcher = createDockerDesktopLauncher({
      platform: 'darwin',
      execFile: async () => { throw Object.assign(new Error('Unable to find application'), { code: 1 }); },
    });

    expect(await launcher.open()).toEqual({ opened: false, code: 'docker_desktop_open_failed' });
  });

  test('never runs a command on another platform', async () => {
    let calls = 0;
    const launcher = createDockerDesktopLauncher({
      platform: 'linux',
      execFile: async () => { calls += 1; },
    });

    expect(await launcher.open()).toEqual({ opened: false, code: 'docker_desktop_unsupported_platform' });
    expect(calls).toBe(0);
  });
});

describe('Open Docker Desktop IPC contract', () => {
  test('the command takes no renderer input and stays in the foreground process', () => {
    const start = mainSource.indexOf("case 'desktop_open_docker_desktop':");
    expect(start).toBeGreaterThan(-1);
    const handler = mainSource.slice(start, mainSource.indexOf('case ', start + 10));

    expect(handler).toContain('getDockerDesktopLauncher().open()');
    expect(handler).not.toMatch(/\bargs\b/);
    expect(handler).not.toContain('runtimeServiceBotRuntimeOperation');
  });

  test('only the local DevRyan UI may invoke it', () => {
    const allowlist = preloadSource.slice(
      preloadSource.indexOf('const LOCAL_ONLY_BOT_RUNTIME_COMMANDS = new Set(['),
      preloadSource.indexOf(']);', preloadSource.indexOf('const LOCAL_ONLY_BOT_RUNTIME_COMMANDS')),
    );
    expect(allowlist).toContain("'desktop_open_docker_desktop'");
    expect(mainSource).not.toMatch(/COMMANDS_SAFE_FOR_REMOTE[^;]*desktop_open_docker_desktop/s);
  });
});
