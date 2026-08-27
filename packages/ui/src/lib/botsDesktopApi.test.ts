import { describe, expect, test } from 'bun:test';

import { BotsDesktopApiError, createBotsDesktopApi } from './botsDesktopApi';

describe('Production Bots desktop client', () => {
  test('refuses runtime mutations outside the local Electron origin', async () => {
    const api = createBotsDesktopApi({ available: () => false });
    const error = await api.setup().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BotsDesktopApiError);
    expect((error as BotsDesktopApiError).code).toBe('bot_runtime_ipc_unavailable');
  });

  test('uses the fixed Electron command allowlist and preserves IPC codes', async () => {
    const commands: string[] = [];
    const api = createBotsDesktopApi({
      available: () => true,
      invoke: async <T>(command: string) => {
        commands.push(command);
        if (command === 'desktop_bot_runtime_repair') {
          throw Object.assign(new Error('Docker is stopped'), {
            code: 'bot_runtime_docker_unavailable',
          });
        }
        return { ok: true, state: 'healthy' } as T;
      },
    });

    await api.status();
    expect(await api.operationStatus?.()).toEqual({ ok: true, state: 'healthy' });
    const error = await api.repair().catch((caught: unknown) => caught);

    expect(commands).toEqual([
      'desktop_bot_runtime_status',
      'desktop_bot_runtime_operation_status',
      'desktop_bot_runtime_repair',
    ]);
    expect((error as BotsDesktopApiError).code).toBe('bot_runtime_docker_unavailable');
  });

  test('removes Electron transport prefixes from runtime failures', async () => {
    const api = createBotsDesktopApi({
      available: () => true,
      invoke: async () => {
        throw new Error(
          "Error invoking remote method 'openchamber:invoke': "
          + 'BotRuntimeManagerError: Bot runtime image supervisor is not publicly accessible.',
        );
      },
    });

    const error = await api.setup().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BotsDesktopApiError);
    expect((error as BotsDesktopApiError).message).toBe(
      'Bot runtime image supervisor is not publicly accessible.',
    );
  });

  test('preserves structured background-runtime failure codes', async () => {
    const api = createBotsDesktopApi({
      available: () => true,
      invoke: async <T>() => ({
        ok: false,
        error: {
          code: 'runtime_service_helper_missing',
          message: 'This DevRyan build is missing the signed background runtime helper',
        },
      }) as T,
    });

    const error = await api.enableRuntimeService?.().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BotsDesktopApiError);
    expect((error as BotsDesktopApiError).code).toBe('runtime_service_helper_missing');
    expect((error as BotsDesktopApiError).message).not.toContain('RuntimeServiceRegistrationError');
  });

  test('sends recovery choices through native IPC without receiving bundle bytes', async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const api = createBotsDesktopApi({
      available: () => true,
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return (command === 'desktop_export_bot_recovery'
          ? { cancelled: false, fileName: 'DevRyan-Bot-Recovery.drbr' }
          : { cancelled: false, restored: true, mode: 'empty' }) as T;
      },
    });
    const request = {
      passphrase: 'correct horse battery staple',
      includeLibraryObjects: true,
      includeWorkspaceObjects: true,
      includeConnectorVault: false,
      confirmConnectorVault: false,
      includeEnvironmentSecrets: false,
      confirmEnvironmentSecrets: false,
      includeBrowserProfiles: false,
      confirmBrowserProfiles: false,
    };

    const exported = await api.exportRecovery('11111111-1111-4111-8111-111111111111', request);
    const restored = await api.restoreRecovery('correct horse battery staple', 'empty');

    expect(exported).toEqual({ cancelled: false, fileName: 'DevRyan-Bot-Recovery.drbr' });
    expect(Object.hasOwn(exported, 'bundle')).toBe(false);
    expect(restored).toEqual({ cancelled: false, restored: true, mode: 'empty' });
    expect(calls).toEqual([
      {
        command: 'desktop_export_bot_recovery',
        args: {
          botId: '11111111-1111-4111-8111-111111111111',
          request,
        },
      },
      {
        command: 'desktop_restore_bot_recovery',
        args: { passphrase: 'correct horse battery staple', mode: 'empty' },
      },
    ]);
  });
});
