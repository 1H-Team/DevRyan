import { isElectronShell } from '@/lib/desktop';

export type SpeechResultCallback = (text: string, isFinal: boolean, finalReason?: string) => void;
export type ErrorCallback = (error: string) => void;
export type AudioLevelCallback = (level: number) => void;

export type MacosSpeechAuthorization = 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown' | 'unsupported';
export type MacosMicrophoneStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown' | 'unsupported';

export interface MacosSpeechCapability {
  available: boolean;
  platform: string;
  reason: string | null;
  locale: string | null;
  speechAuthorization: MacosSpeechAuthorization;
  microphoneAuthorization: MacosSpeechAuthorization;
  supportsOnDeviceRecognition: boolean;
}

export interface MacosSpeechInputDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface MacosMicrophonePermission {
  status: MacosMicrophoneStatus;
  granted: boolean;
  canPrompt: boolean;
}

export interface MacosPrepareListeningResult {
  microphoneStatus: MacosMicrophoneStatus;
  speechAuthorization: MacosSpeechAuthorization;
  microphoneGranted: boolean;
  speechGranted: boolean;
  granted: boolean;
  needsSettings: boolean;
  settingsTarget: 'microphone' | 'speech' | null;
  message: string | null;
}

interface TauriEvent<TPayload = unknown> {
  payload?: TPayload;
}

interface TauriGlobal {
  core?: {
    invoke?: <TResult = unknown>(command: string, args?: Record<string, unknown>) => Promise<TResult>;
  };
  event?: {
    listen?: <TPayload = unknown>(event: string, handler: (event: TauriEvent<TPayload>) => void) => Promise<() => void>;
  };
}

type MacosSpeechEvent =
  | { type: 'started'; provider: 'macos'; locale?: string }
  | { type: 'stopped'; provider: 'macos' }
  | { type: 'transcript'; provider: 'macos'; text: string; isFinal: boolean; finalReason?: string }
  | { type: 'level'; provider: 'macos'; level: number }
  | { type: 'error'; provider: 'macos'; code?: string; message?: string };

const MACOS_SPEECH_EVENT = 'devryan:macos-speech';

const getTauri = (): TauriGlobal | null => {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
};

const isMacOSHost = (): boolean => {
  if (typeof window === 'undefined') return false;
  const macosMajor = (window as unknown as { __DEVRYAN_MACOS_MAJOR__?: unknown }).__DEVRYAN_MACOS_MAJOR__;
  if (typeof macosMajor === 'number' && Number.isFinite(macosMajor) && macosMajor > 0) return true;
  return /mac/i.test(window.navigator?.platform ?? '');
};

const normalizeErrorMessage = (event: Extract<MacosSpeechEvent, { type: 'error' }>): string => {
  switch (event.code) {
    case 'speech_permission_denied':
      return 'Speech Recognition permission is disabled. Enable it in macOS System Settings → Privacy & Security → Speech Recognition.';
    case 'microphone_permission_denied':
      return 'Microphone permission is disabled. Enable it in macOS System Settings → Privacy & Security → Microphone.';
    case 'locale_unavailable':
      return event.message || 'macOS Speech is not available for the requested language.';
    case 'helper_missing':
      return 'macOS Speech helper is missing. Rebuild the Electron app.';
    default:
      return event.message || 'macOS Speech recognition failed.';
  }
};

const normalizeMicrophonePermission = (value: unknown): MacosMicrophonePermission => {
  const raw = typeof value === 'object' && value !== null ? value as Partial<MacosMicrophonePermission> : null;
  const status = raw?.status === 'granted'
    || raw?.status === 'denied'
    || raw?.status === 'restricted'
    || raw?.status === 'not-determined'
    || raw?.status === 'unknown'
    || raw?.status === 'unsupported'
      ? raw.status
      : 'unknown';
  return {
    status,
    granted: raw?.granted === true || status === 'granted',
    canPrompt: raw?.canPrompt === true || status === 'not-determined',
  };
};

export const getMacosPermissionMessage = (result: Pick<MacosPrepareListeningResult, 'settingsTarget'>): string | null => {
  if (result.settingsTarget === 'microphone') {
    return 'Microphone permission is disabled. Opening macOS Microphone settings.';
  }
  if (result.settingsTarget === 'speech') {
    return 'Speech Recognition permission is disabled. Opening macOS Speech Recognition settings.';
  }
  return null;
};

class NativeMacosSpeechService {
  private onResult: SpeechResultCallback | null = null;
  private onError: ErrorCallback | null = null;
  private onLevel: AudioLevelCallback | null = null;
  private unlisten: (() => void) | null = null;
  private isListening = false;

  isSupported(): boolean {
    const tauri = getTauri();
    return isElectronShell() && isMacOSHost() && typeof tauri?.core?.invoke === 'function' && typeof tauri?.event?.listen === 'function';
  }

  async getCapability(language?: string): Promise<MacosSpeechCapability> {
    if (!this.isSupported()) {
      return {
        available: false,
        platform: typeof navigator === 'undefined' ? 'unknown' : navigator.platform,
        reason: 'runtime_unsupported',
        locale: null,
        speechAuthorization: 'unknown',
        microphoneAuthorization: 'unknown',
        supportsOnDeviceRecognition: false,
      };
    }

    const invoke = getTauri()?.core?.invoke;
    if (typeof invoke !== 'function') {
      throw new Error('Desktop runtime is not available');
    }
    const args = language ? { language } : undefined;
    const result = await invoke<MacosSpeechCapability>('desktop_macos_speech_capability', args);
    return result ?? {
      available: false,
      platform: 'unknown',
      reason: 'ipc_unavailable',
      locale: null,
      speechAuthorization: 'unknown',
      microphoneAuthorization: 'unknown',
      supportsOnDeviceRecognition: false,
    };
  }

  async getMicrophonePermission(): Promise<MacosMicrophonePermission> {
    if (!this.isSupported()) return { status: 'unsupported', granted: false, canPrompt: false };
    const invoke = getTauri()?.core?.invoke;
    if (typeof invoke !== 'function') return { status: 'unknown', granted: false, canPrompt: false };
    const result = await invoke<MacosMicrophonePermission>('desktop_macos_microphone_status');
    return normalizeMicrophonePermission(result);
  }

  async requestMicrophonePermission(): Promise<MacosMicrophonePermission> {
    if (!this.isSupported()) return { status: 'unsupported', granted: false, canPrompt: false };
    const invoke = getTauri()?.core?.invoke;
    if (typeof invoke !== 'function') return { status: 'unknown', granted: false, canPrompt: false };
    const result = await invoke<MacosMicrophonePermission>('desktop_macos_microphone_authorize');
    return normalizeMicrophonePermission(result);
  }

  async prepareListeningDetailed(language?: string): Promise<MacosPrepareListeningResult> {
    if (!this.isSupported()) {
      return {
        microphoneStatus: 'unsupported',
        speechAuthorization: 'unsupported',
        microphoneGranted: false,
        speechGranted: false,
        granted: false,
        needsSettings: false,
        settingsTarget: null,
        message: 'Native macOS Speech input is not available in this runtime.',
      };
    }

    let microphonePermission = await this.getMicrophonePermission();
    if (microphonePermission.canPrompt) {
      microphonePermission = await this.requestMicrophonePermission();
    }

    if (!microphonePermission.granted) {
      const needsSettings = microphonePermission.status === 'denied' || microphonePermission.status === 'restricted';
      return {
        microphoneStatus: microphonePermission.status,
        speechAuthorization: 'unknown',
        microphoneGranted: false,
        speechGranted: false,
        granted: false,
        needsSettings,
        settingsTarget: needsSettings ? 'microphone' : null,
        message: needsSettings
          ? getMacosPermissionMessage({ settingsTarget: 'microphone' })
          : 'Microphone permission was not granted.',
      };
    }

    const invoke = getTauri()?.core?.invoke;
    if (typeof invoke !== 'function') {
      return {
        microphoneStatus: microphonePermission.status,
        speechAuthorization: 'unknown',
        microphoneGranted: true,
        speechGranted: false,
        granted: false,
        needsSettings: false,
        settingsTarget: null,
        message: 'Desktop runtime is not available.',
      };
    }
    const args = language ? { language } : undefined;

    const capability = await this.getCapability(language);
    if (capability.speechAuthorization === 'authorized' && capability.available) {
      return {
        microphoneStatus: microphonePermission.status,
        speechAuthorization: 'authorized',
        microphoneGranted: true,
        speechGranted: true,
        granted: true,
        needsSettings: false,
        settingsTarget: null,
        message: null,
      };
    }
    if (capability.speechAuthorization === 'denied' || capability.speechAuthorization === 'restricted') {
      return {
        microphoneStatus: microphonePermission.status,
        speechAuthorization: capability.speechAuthorization,
        microphoneGranted: true,
        speechGranted: false,
        granted: false,
        needsSettings: true,
        settingsTarget: 'speech',
        message: getMacosPermissionMessage({ settingsTarget: 'speech' }),
      };
    }

    const result = await invoke<MacosSpeechCapability>('desktop_macos_speech_authorize', args);
    const speechAuthorization = result?.speechAuthorization ?? 'unknown';
    const speechGranted = speechAuthorization === 'authorized';
    const speechNeedsSettings = speechAuthorization === 'denied' || speechAuthorization === 'restricted';
    return {
      microphoneStatus: microphonePermission.status,
      speechAuthorization,
      microphoneGranted: true,
      speechGranted,
      granted: speechGranted,
      needsSettings: speechNeedsSettings,
      settingsTarget: speechNeedsSettings ? 'speech' : null,
      message: speechGranted
        ? null
        : speechNeedsSettings
          ? getMacosPermissionMessage({ settingsTarget: 'speech' })
          : 'Speech Recognition permission was not granted.',
    };
  }

  async prepareListening(language?: string): Promise<boolean> {
    const result = await this.prepareListeningDetailed(language);
    return result.granted;
  }

  async getInputDevices(): Promise<MacosSpeechInputDevice[]> {
    if (!this.isSupported()) return [];
    const invoke = getTauri()?.core?.invoke;
    if (typeof invoke !== 'function') return [];
    const result = await invoke<MacosSpeechInputDevice[]>('desktop_macos_speech_devices');
    return Array.isArray(result)
      ? result.filter((device) => typeof device?.id === 'string' && typeof device?.name === 'string')
      : [];
  }

  async openPrivacySettings(target: 'microphone' | 'speech' = 'microphone'): Promise<void> {
    const invoke = getTauri()?.core?.invoke;
    if (typeof invoke !== 'function') return;
    await invoke('desktop_open_system_privacy_settings', { target });
  }

  async startListening(
    language: string | undefined,
    onResult: SpeechResultCallback,
    onError?: ErrorCallback,
    options?: { inputDeviceId?: string; silenceThresholdDb?: number; silenceHoldMs?: number },
    onLevel?: AudioLevelCallback,
  ): Promise<void> {
    if (!this.isSupported()) {
      const message = 'Native macOS Speech input is not available in this runtime.';
      onError?.(message);
      throw new Error(message);
    }

    this.stopListening();
    this.onResult = onResult;
    this.onError = onError ?? null;
    this.onLevel = onLevel ?? null;

    const tauri = getTauri();
    const listen = tauri?.event?.listen;
    const invoke = tauri?.core?.invoke;
    if (typeof listen !== 'function' || typeof invoke !== 'function') {
      const message = 'Desktop speech IPC is not available.';
      onError?.(message);
      throw new Error(message);
    }

    this.unlisten = await listen<MacosSpeechEvent>(MACOS_SPEECH_EVENT, (event) => {
      const payload = event.payload;
      if (!payload || payload.provider !== 'macos') return;

      if (payload.type === 'transcript') {
        this.onResult?.(payload.text, payload.isFinal, payload.finalReason);
        return;
      }

      if (payload.type === 'level') {
        const level = Number(payload.level);
        if (Number.isFinite(level)) {
          this.onLevel?.(Math.max(0, Math.min(1, level)));
        }
        return;
      }

      if (payload.type === 'error') {
        this.isListening = false;
        this.onError?.(normalizeErrorMessage(payload));
        return;
      }

      if (payload.type === 'stopped') {
        this.isListening = false;
      }
    }) ?? null;

    try {
      await invoke('desktop_macos_speech_start', {
        ...(language ? { language } : {}),
        ...(options?.inputDeviceId ? { inputDeviceId: options.inputDeviceId } : {}),
        silenceThresholdDb: options?.silenceThresholdDb,
        silenceHoldMs: options?.silenceHoldMs,
      });
      this.isListening = true;
    } catch (error) {
      this.cleanupListener();
      this.isListening = false;
      const message = error instanceof Error ? error.message : 'Failed to start macOS Speech input.';
      onError?.(message);
      throw error;
    }
  }

  stopListening(): void {
    this.isListening = false;
    this.cleanupListener();
    const invoke = getTauri()?.core?.invoke;
    if (typeof invoke === 'function') {
      void invoke('desktop_macos_speech_stop').catch(() => {});
    }
    this.onResult = null;
    this.onError = null;
    this.onLevel = null;
  }

  getIsListening(): boolean {
    return this.isListening;
  }

  private cleanupListener(): void {
    const unlisten = this.unlisten;
    this.unlisten = null;
    if (unlisten) {
      try {
        unlisten();
      } catch {
        // ignore stale listener cleanup failures
      }
    }
  }
}

export const nativeMacosSpeechService = new NativeMacosSpeechService();
