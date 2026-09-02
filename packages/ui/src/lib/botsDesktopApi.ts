import {
  canUseElectronDesktopIPC,
  invokeDesktop,
  isDesktopLocalOriginActive,
  listenDesktopEvent,
} from '@/lib/desktop';

export type BotRuntimeOperationProgress = {
  id: string;
  action: string;
  phase: 'checking' | 'downloading_image' | 'verifying_images' | 'starting_services'
    | 'verifying_health' | 'ready' | 'failed';
  completed: number | null;
  total: number | null;
  code: string | null;
  message?: string | null;
  startedAt: string;
};

export type BotsDesktopRuntimeStatus = {
  ok: boolean;
  state: string;
  code: string | null;
  issues: readonly Readonly<Record<string, unknown>>[];
  /** Non-blocking preflight findings (for example a small Docker Desktop VM); the runtime can still be healthy. */
  warnings?: readonly Readonly<Record<string, unknown>>[];
  manifest: Readonly<Record<string, unknown>> | null;
  desiredManifest: Readonly<Record<string, unknown>> | null;
  updateStaged: boolean;
  canSetup: boolean;
  canRepair: boolean;
  canUpdate: boolean;
  canRollback: boolean;
  changed?: boolean;
};

export type RuntimeServiceStatus = {
  configuredMode: 'app_bound' | 'service' | 'disabled';
  registrationMode: 'smappservice' | 'legacy' | 'unsupported' | 'unavailable';
  registration: {
    ok: boolean;
    state: string;
    code: string | null;
  };
  connected: boolean;
  handshake: {
    instanceId: string;
    protocolVersion: number;
    health: string;
    ownerGeneration: number;
    desktopHost: {
      state: 'connected' | 'unavailable';
      capabilities: readonly string[];
    };
  } | null;
  settingsUrl: string | null;
  canEnable: boolean;
};

type RuntimeServiceCommandResult = {
  ok: true;
  status: RuntimeServiceStatus;
} | {
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

export type BotRecoveryExportRequest = {
  passphrase: string;
  includeLibraryObjects: boolean;
  includeWorkspaceObjects: boolean;
  includeConnectorVault: boolean;
  confirmConnectorVault: boolean;
  includeEnvironmentSecrets: boolean;
  confirmEnvironmentSecrets: boolean;
  includeBrowserProfiles: boolean;
  confirmBrowserProfiles: boolean;
};

export type BotRecoveryNativeResult = {
  cancelled: boolean;
  fileName?: string;
  restored?: boolean;
  bot?: Readonly<Record<string, unknown>> | null;
  mode?: 'empty' | 'merge';
  result?: Readonly<Record<string, unknown>>;
};

export class BotsDesktopApiError extends Error {
  readonly code: string;

  constructor(message: string, code = 'bot_runtime_ipc_failed') {
    super(message);
    this.name = 'BotsDesktopApiError';
    this.code = code;
  }
}

const desktopErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : 'Bot runtime request failed';
  return message
    .replace(/^Error invoking remote method ['"]openchamber:invoke['"]:\s*/i, '')
    .replace(/^BotRuntimeManagerError:\s*/i, '')
    .replace(/^RuntimeServiceRegistrationError:\s*/i, '')
    .trim() || 'Bot runtime request failed';
};

export type BotsDesktopApi = {
  isAvailable(): boolean;
  status(): Promise<BotsDesktopRuntimeStatus>;
  setup(): Promise<BotsDesktopRuntimeStatus>;
  repair(): Promise<BotsDesktopRuntimeStatus>;
  update(): Promise<BotsDesktopRuntimeStatus>;
  rollback(): Promise<BotsDesktopRuntimeStatus>;
  runtimeServiceStatus?(): Promise<RuntimeServiceStatus>;
  enableRuntimeService?(allowLegacy?: boolean): Promise<RuntimeServiceStatus>;
  disableRuntimeService?(): Promise<RuntimeServiceStatus>;
  openRuntimeServiceSettings?(): Promise<void>;
  operationStatus?(): Promise<BotRuntimeOperationProgress | null>;
  listenProgress?(listener: (progress: BotRuntimeOperationProgress) => void): Promise<() => void>;
  exportRecovery(botId: string, request: BotRecoveryExportRequest): Promise<BotRecoveryNativeResult>;
  restoreRecovery(passphrase: string, mode: 'empty' | 'merge'): Promise<BotRecoveryNativeResult>;
};

type DesktopCommand =
  | 'desktop_bot_runtime_status'
  | 'desktop_bot_runtime_operation_status'
  | 'desktop_bot_runtime_setup'
  | 'desktop_bot_runtime_repair'
  | 'desktop_bot_runtime_update'
  | 'desktop_bot_runtime_rollback'
  | 'desktop_runtime_service_status'
  | 'desktop_runtime_service_enable'
  | 'desktop_runtime_service_disable'
  | 'desktop_runtime_service_open_settings'
  | 'desktop_export_bot_recovery'
  | 'desktop_restore_bot_recovery';

export const createBotsDesktopApi = ({
  invoke = invokeDesktop,
  available = () => canUseElectronDesktopIPC() && isDesktopLocalOriginActive(),
}: {
  invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T | null>;
  available?: () => boolean;
} = {}): BotsDesktopApi => {
  const call = async <T extends object>(
    command: DesktopCommand,
    args: Record<string, unknown>,
    invalidMessage: string,
  ): Promise<T> => {
    if (!available()) {
      throw new BotsDesktopApiError(
        'Bot runtime management is available only in the local DevRyan macOS app',
        'bot_runtime_ipc_unavailable',
      );
    }
    try {
      const result = await invoke<T>(command, args);
      if (!result || typeof result !== 'object') {
        throw new BotsDesktopApiError(invalidMessage, 'bot_runtime_ipc_invalid');
      }
      return result;
    } catch (error) {
      if (error instanceof BotsDesktopApiError) throw error;
      const code = typeof (error as { code?: unknown })?.code === 'string'
        ? (error as { code: string }).code
        : 'bot_runtime_ipc_failed';
      throw new BotsDesktopApiError(
        desktopErrorMessage(error),
        code,
      );
    }
  };

  const callRuntimeService = async (
    command: Extract<DesktopCommand,
      | 'desktop_runtime_service_status'
      | 'desktop_runtime_service_enable'
      | 'desktop_runtime_service_disable'>,
    args: Record<string, unknown>,
  ): Promise<RuntimeServiceStatus> => {
    const result = await call<RuntimeServiceCommandResult>(
      command,
      args,
      'Background runtime returned an invalid result',
    );
    if (result.ok === false) {
      throw new BotsDesktopApiError(result.error.message, result.error.code);
    }
    if (!result.status || typeof result.status !== 'object') {
      throw new BotsDesktopApiError(
        'Background runtime returned an invalid status',
        'bot_runtime_ipc_invalid',
      );
    }
    return result.status;
  };

  return Object.freeze({
    isAvailable: available,
    status: () => call<BotsDesktopRuntimeStatus>(
      'desktop_bot_runtime_status', {}, 'Bot runtime returned an invalid status',
    ),
    operationStatus: async () => {
      if (!available()) return null;
      const result = await invoke<BotRuntimeOperationProgress>(
        'desktop_bot_runtime_operation_status',
        {},
      );
      return result && typeof result === 'object' ? result : null;
    },
    listenProgress: (listener) => listenDesktopEvent<BotRuntimeOperationProgress>(
      'openchamber:bot-runtime-progress',
      listener,
    ),
    setup: () => call<BotsDesktopRuntimeStatus>(
      'desktop_bot_runtime_setup', {}, 'Bot runtime returned an invalid status',
    ),
    repair: () => call<BotsDesktopRuntimeStatus>(
      'desktop_bot_runtime_repair', {}, 'Bot runtime returned an invalid status',
    ),
    update: () => call<BotsDesktopRuntimeStatus>(
      'desktop_bot_runtime_update', {}, 'Bot runtime returned an invalid status',
    ),
    rollback: () => call<BotsDesktopRuntimeStatus>(
      'desktop_bot_runtime_rollback', {}, 'Bot runtime returned an invalid status',
    ),
    runtimeServiceStatus: () => callRuntimeService('desktop_runtime_service_status', {}),
    enableRuntimeService: (allowLegacy = false) => callRuntimeService(
      'desktop_runtime_service_enable',
      { allowLegacy },
    ),
    disableRuntimeService: () => callRuntimeService('desktop_runtime_service_disable', {}),
    openRuntimeServiceSettings: async () => {
      await call<{ opened: boolean }>(
        'desktop_runtime_service_open_settings', {}, 'Login Items settings could not be opened',
      );
    },
    exportRecovery: (botId, request) => call<BotRecoveryNativeResult>(
      'desktop_export_bot_recovery',
      { botId, request },
      'Bot recovery export returned an invalid result',
    ),
    restoreRecovery: (passphrase, mode) => call<BotRecoveryNativeResult>(
      'desktop_restore_bot_recovery',
      { passphrase, mode },
      'Bot recovery restore returned an invalid result',
    ),
  });
};

export const botsDesktopApi = createBotsDesktopApi();
