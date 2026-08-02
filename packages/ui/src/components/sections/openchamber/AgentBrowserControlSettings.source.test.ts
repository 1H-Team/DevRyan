import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./AgentBrowserControlSettings.tsx', import.meta.url)),
  'utf8',
);

const messages = readFileSync(
  fileURLToPath(new URL('../../../lib/i18n/messages/en.settings.ts', import.meta.url)),
  'utf8',
);

const desktop = readFileSync(
  fileURLToPath(new URL('../../../lib/desktop.ts', import.meta.url)),
  'utf8',
);

describe('AgentBrowserControlSettings', () => {
  test('renders only in the local-origin Electron shell', () => {
    expect(source).toContain('isElectronShell() && isDesktopLocalOriginActive()');
    expect(source).toContain('if (!isLocalDesktop) {');
  });

  test('defaults to enabled unless explicitly persisted as false', () => {
    expect(source).toContain('React.useState(true)');
    expect(source).toContain("data?.agentBrowserControlEnabled !== false");
    expect(source).toContain('setEnabled(result.enabled)');
  });

  test('persists and enforces the setting in one authoritative desktop IPC operation', () => {
    expect(source).toContain('setAgentBrowserControlEnabled(nextEnabled)');
    expect(source).not.toContain('saveDesktopSettingsNow({ agentBrowserControlEnabled: nextEnabled })');
  });

  test('repeatedly polls pending installer status until it reaches a terminal state', () => {
    expect(source).toContain('const pollInstallerStatus = async');
    expect(source).toContain("if (status.state === 'pending')");
    expect(source).toContain('schedulePoll();');
    expect(source).toContain('cancelled = true;');
    expect(source).toContain('window.clearTimeout(pollTimer);');
  });

  test('loads installer status, repairs through IPC helpers, and shows the global lease total', () => {
    expect(source).toContain('getAgentBrowserInstallerStatus()');
    expect(source).toContain('repairAgentBrowserInstaller()');
    expect(source).toContain('installerStatus?.activeLeaseCount ?? 0');
    expect(source).toContain("window.addEventListener('browser-agent-lease-total'");
    expect(source).not.toContain('useBrowserAgentStore');
    expect(source).toContain('installerStatus?.expectedVersion');
    expect(source).toContain('installerStatus?.installedVersion');
    expect(source).toContain('installerStatus?.issues?.map');
    expect(source).toContain('skill.conflicts');
    expect(source).toContain('skill.issues');
    expect(source).toContain("skill.state === 'conflict'");
    expect(source).not.toContain('issue.path');
    expect(desktop).toContain("invokeDesktop<AgentBrowserInstallerStatus>('desktop_agent_browser_status')");
    expect(desktop).toContain("invokeDesktop<AgentBrowserInstallerStatus>('desktop_agent_browser_repair')");
  });

  test('only reports repair success after setup was applied and managed OpenCode restarted', () => {
    expect(source).toContain('status.ok && status.applied === true && status.restartSucceeded === true');
    expect(source).toContain('setInstallerError(failureMessage)');
    expect(source).toContain('toast.error(failureMessage)');
    expect(source).toContain("installerStatus?.state !== 'restart-failed'");
  });

  test('describes hidden leases and per-lease local capabilities', () => {
    expect(messages).toContain('Agent browser leases start hidden');
    expect(messages).toContain('Each lease uses a separate local-only capability');
    expect(messages).not.toContain('while you watch');
    expect(messages).not.toContain('per-session token');
  });

  test('has en strings for every referenced i18n key', () => {
    const keys = [...source.matchAll(/t\('([^']+)'\)/g)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of new Set(keys)) {
      expect(messages).toContain(`'${key}':`);
    }
  });
});
