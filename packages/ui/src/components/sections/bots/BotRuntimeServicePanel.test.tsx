import React from 'react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import type { BotsDesktopApi, RuntimeServiceStatus } from '@/lib/botsDesktopApi';
import { I18nProvider } from '@/lib/i18n';
import { BotRuntimeServicePanel } from './BotRuntimeServicePanel';
import { runtimeServicePresentation } from './botRuntimeServicePresentation';

const status = (overrides: Partial<RuntimeServiceStatus> = {}): RuntimeServiceStatus => ({
  configuredMode: 'service',
  registrationMode: 'smappservice',
  registration: { ok: true, state: 'enabled', code: null },
  connected: true,
  handshake: {
    instanceId: '123e4567-e89b-42d3-a456-426614174000',
    protocolVersion: 2,
    health: 'healthy',
    ownerGeneration: 4,
    desktopHost: { state: 'connected', capabilities: ['focus', 'browser_cdp'] },
  },
  settingsUrl: 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
  canEnable: true,
  ...overrides,
});

const desktopApi: BotsDesktopApi = {
  isAvailable: () => true,
  status: async () => { throw new Error('not used'); },
  setup: async () => { throw new Error('not used'); },
  repair: async () => { throw new Error('not used'); },
  update: async () => { throw new Error('not used'); },
  rollback: async () => { throw new Error('not used'); },
  exportRecovery: async () => ({ cancelled: true }),
  restoreRecovery: async () => ({ cancelled: true }),
  runtimeServiceStatus: async () => status(),
};

describe('Bot background runtime presentation', () => {
  test('distinguishes connected, approval, starting, degraded, updating, and disabled states', () => {
    expect(runtimeServicePresentation(status(), false).label).toBe('Background Bots connected');
    expect(runtimeServicePresentation(status({
      registration: { ok: true, state: 'requires_approval', code: null },
      connected: false,
      handshake: null,
    }), false).label).toBe('Approval required');
    expect(runtimeServicePresentation(status({ connected: false, handshake: null }), false).label)
      .toBe('Background runtime connection failed');
    expect(runtimeServicePresentation(status({
      handshake: { ...status().handshake!, health: 'starting' },
    }), false).label).toBe('Starting background runtime');
    expect(runtimeServicePresentation(status({
      handshake: { ...status().handshake!, health: 'degraded' },
    }), false).label).toBe('Background runtime degraded');
    expect(runtimeServicePresentation(status({
      handshake: { ...status().handshake!, health: 'updating' },
    }), false).label).toBe('Updating background runtime');
    expect(runtimeServicePresentation(status({
      configuredMode: 'disabled',
      connected: false,
      handshake: null,
      registration: { ok: true, state: 'not_registered', code: null },
    }), false).label).toBe('Background Bots disabled');
    expect(runtimeServicePresentation(status({
      registrationMode: 'smappservice',
      registration: {
        ok: false,
        state: 'unavailable',
        code: 'runtime_service_native_bridge_missing',
      },
      connected: false,
      handshake: null,
      canEnable: false,
    }), false).label).toBe('Background runtime bridge missing');
    expect(runtimeServicePresentation(status({
      registration: { ok: false, state: 'not_found', code: null },
      connected: false,
      handshake: null,
      canEnable: false,
    }), false).label).toBe('Background service definition not found');
    expect(runtimeServicePresentation(status({
      registration: {
        ok: false,
        state: 'unavailable',
        code: 'runtime_service_native_bridge_load_failed',
      },
      connected: false,
      handshake: null,
      canEnable: false,
    }), false).label).toBe('Background runtime bridge invalid');
    expect(runtimeServicePresentation(status({
      registrationMode: 'unavailable',
      registration: {
        ok: false,
        state: 'unavailable',
        code: 'runtime_service_packaged_build_required',
      },
      connected: false,
      handshake: null,
      canEnable: false,
    }), false).label).toBe('Background runtime unavailable in development');
  });

  test('renders only sanitized service state and no broker capability material', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotRuntimeServicePanel canManage desktopApi={desktopApi} initialStatus={status()} />
      </I18nProvider>,
    );
    expect(markup).toContain('Background Bots connected');
    expect(markup).toContain('Routines, memory, and computer supervision continue');
    expect(markup).not.toContain('brokerToken');
    expect(markup).not.toContain('123e4567-e89b-42d3-a456-426614174000');
  });

  test('does not offer enable when the packaged service is unavailable', () => {
    const unavailable = status({
      connected: false,
      handshake: null,
      canEnable: false,
      registration: {
        ok: false,
        state: 'unavailable',
        code: 'runtime_service_native_bridge_missing',
      },
    });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotRuntimeServicePanel canManage desktopApi={desktopApi} initialStatus={unavailable} />
      </I18nProvider>,
    );

    expect(markup).toContain('Background runtime bridge missing');
    expect(markup).not.toContain('Enable Background Bots');
  });

  test('offers private LaunchAgent enablement and retains manual confirmation', () => {
    const legacy = status({
      configuredMode: 'app_bound',
      registrationMode: 'legacy',
      registration: { ok: true, state: 'not_registered', code: null },
      connected: false,
      handshake: null,
      settingsUrl: null,
      canEnable: true,
    });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotRuntimeServicePanel canManage desktopApi={desktopApi} initialStatus={legacy} />
      </I18nProvider>,
    );
    const source = readFileSync(new URL('./BotRuntimeServicePanel.tsx', import.meta.url), 'utf8');

    expect(markup).toContain('Enable Background Bots');
    expect(source).toContain("status?.registrationMode === 'legacy'");
    expect(source).toContain('setLegacyConsentOpen(true)');
    expect(source).toContain('This DevRyan build uses a private per-user LaunchAgent');
  });
});
