import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { BotsDesktopApi } from '@/lib/botsDesktopApi';
import { BotRecovery } from './BotRecovery';
import { buildBotRecoveryExportRequest } from './botRecoveryPresentation';

const desktopApi = (available: boolean): BotsDesktopApi => ({
  isAvailable: () => available,
  status: async () => { throw new Error('not used'); },
  setup: async () => { throw new Error('not used'); },
  repair: async () => { throw new Error('not used'); },
  update: async () => { throw new Error('not used'); },
  rollback: async () => { throw new Error('not used'); },
  exportRecovery: async () => ({ cancelled: false, fileName: 'DevRyan-Bot-Recovery.drbr' }),
  restoreRecovery: async () => ({ cancelled: false, restored: true }),
});

describe('BotRecovery', () => {
  test('builds a safe-by-default export without high-risk secret sections', () => {
    expect(buildBotRecoveryExportRequest({
      passphrase: 'correct horse battery staple',
      passphraseConfirmation: 'correct horse battery staple',
      includeLibraryObjects: true,
      includeWorkspaceObjects: true,
      includeConnectorVault: false,
      confirmConnectorVault: false,
      includeEnvironmentSecrets: false,
      confirmEnvironmentSecrets: false,
      includeBrowserProfiles: false,
      confirmBrowserProfiles: false,
    })).toEqual({
      passphrase: 'correct horse battery staple',
      includeLibraryObjects: true,
      includeWorkspaceObjects: true,
      includeConnectorVault: false,
      confirmConnectorVault: false,
      includeEnvironmentSecrets: false,
      confirmEnvironmentSecrets: false,
      includeBrowserProfiles: false,
      confirmBrowserProfiles: false,
    });
  });

  test('requires independent confirmations for all three secret sections', () => {
    const base = {
      passphrase: 'correct horse battery staple',
      passphraseConfirmation: 'correct horse battery staple',
      includeLibraryObjects: true,
      includeWorkspaceObjects: true,
      includeConnectorVault: true,
      confirmConnectorVault: false,
      includeEnvironmentSecrets: false,
      confirmEnvironmentSecrets: false,
      includeBrowserProfiles: false,
      confirmBrowserProfiles: false,
    };
    expect(() => buildBotRecoveryExportRequest(base)).toThrow('separate high-risk confirmation');
    expect(() => buildBotRecoveryExportRequest({
      ...base,
      confirmConnectorVault: true,
      includeEnvironmentSecrets: true,
    })).toThrow('separate high-risk confirmation');
    expect(() => buildBotRecoveryExportRequest({
      ...base,
      confirmConnectorVault: true,
      includeEnvironmentSecrets: true,
      confirmEnvironmentSecrets: true,
      includeBrowserProfiles: true,
    })).toThrow('separate high-risk confirmation');
    expect(() => buildBotRecoveryExportRequest({
      ...base,
      passphrase: 'correct horse\nbattery staple',
      passphraseConfirmation: 'correct horse\nbattery staple',
    })).toThrow('line breaks');
  });

  test('keeps recovery unavailable outside the local macOS app', () => {
    const markup = renderToStaticMarkup(
      <BotRecovery
        botId="11111111-1111-4111-8111-111111111111"
        botName="Research Desk"
        canManage
        desktopApi={desktopApi(false)}
      />,
    );
    expect(markup).toContain('available only in the local DevRyan macOS app');
    expect(markup).toContain('never exposed to the web renderer');
    expect(markup).not.toContain('Bundle Passphrase');
  });

  test('renders safe selections before either high-risk confirmation', () => {
    const markup = renderToStaticMarkup(
      <BotRecovery
        botId="11111111-1111-4111-8111-111111111111"
        botName="Research Desk"
        canManage
        canRestore
        desktopApi={desktopApi(true)}
      />,
    );
    expect(markup).toContain('Bot configuration and the deployment key are always included');
    expect(markup).toContain('Include Library Objects');
    expect(markup).toContain('Include Private Workspace Objects');
    expect(markup).toContain('Include Connector Vault');
    expect(markup).toContain('Include Environment Secrets');
    expect(markup).toContain('Include Browser Profiles');
    expect(markup).not.toContain('I Confirm Connector Secret Export');
    expect(markup).not.toContain('I Confirm Environment Secret Export');
    expect(markup).not.toContain('I Confirm Authenticated Browser State Export');
  });
});
