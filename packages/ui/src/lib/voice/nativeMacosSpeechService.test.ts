import { beforeEach, describe, expect, test } from 'bun:test';
import { nativeMacosSpeechService } from './nativeMacosSpeechService';

type EventHandler = (event: { payload?: unknown }) => void;

const originalWindow = globalThis.window;

const installMockWindow = () => {
  const handlers = new Map<string, EventHandler>();
  const invocations: Array<{ command: string; args?: Record<string, unknown> }> = [];

  const mockWindow = {
    __DEVRYAN_ELECTRON__: { runtime: 'electron' },
    __DEVRYAN_MACOS_MAJOR__: 14,
    navigator: { platform: 'MacIntel' },
    __TAURI__: {
      core: {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          invocations.push({ command, args });
          if (command === 'desktop_macos_speech_capability') {
            return {
              available: true,
              platform: 'darwin',
              reason: null,
              locale: 'en-US',
              speechAuthorization: 'authorized',
              microphoneAuthorization: 'authorized',
              supportsOnDeviceRecognition: true,
            };
          }
          if (command === 'desktop_macos_speech_authorize') {
            return {
              available: true,
              platform: 'darwin',
              reason: null,
              locale: 'en-US',
              speechAuthorization: 'authorized',
              microphoneAuthorization: 'authorized',
              supportsOnDeviceRecognition: true,
            };
          }
          if (command === 'desktop_macos_speech_devices') {
            return [{ id: 'native-mic-1', name: 'Studio Mic', isDefault: true }];
          }
          if (command === 'desktop_macos_microphone_status') {
            return { status: 'granted', granted: true, canPrompt: false };
          }
          if (command === 'desktop_macos_microphone_authorize') {
            return { status: 'granted', granted: true, canPrompt: false };
          }
          return { ok: true };
        },
      },
      event: {
        listen: async (event: string, handler: EventHandler) => {
          handlers.set(event, handler);
          return () => handlers.delete(event);
        },
      },
    },
  };

  Object.defineProperty(globalThis, 'window', {
    value: mockWindow,
    configurable: true,
  });

  return { handlers, invocations };
};

beforeEach(() => {
  nativeMacosSpeechService.stopListening();
  Object.defineProperty(globalThis, 'window', {
    value: originalWindow,
    configurable: true,
  });
});

describe('nativeMacosSpeechService', () => {
  test('reports capability through Electron IPC', async () => {
    const { invocations } = installMockWindow();

    const capability = await nativeMacosSpeechService.getCapability('en-US');

    expect(capability.available).toBe(true);
    expect(capability.speechAuthorization).toBe('authorized');
    expect(invocations[0]).toEqual({ command: 'desktop_macos_speech_capability', args: { language: 'en-US' } });
  });

  test('omits language override for system default recognition', async () => {
    const { invocations } = installMockWindow();

    await nativeMacosSpeechService.getCapability();
    await nativeMacosSpeechService.startListening(
      undefined,
      () => {},
      () => {},
      { silenceThresholdDb: -44, silenceHoldMs: 900 },
    );

    expect(invocations[0]).toEqual({ command: 'desktop_macos_speech_capability', args: undefined });
    expect(invocations.some((invocation) => JSON.stringify(invocation) === JSON.stringify({
      command: 'desktop_macos_speech_start',
      args: { silenceThresholdDb: -44, silenceHoldMs: 900 },
    }))).toBe(true);
  });

  test('requests authorization through Electron IPC', async () => {
    const { invocations } = installMockWindow();
    const invoke = ((globalThis.window as unknown as { __TAURI__: { core: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } } }).__TAURI__.core.invoke);
    (globalThis.window as unknown as { __TAURI__: { core: { invoke: typeof invoke } } }).__TAURI__.core.invoke = async (command, args) => {
      if (command === 'desktop_macos_speech_capability') {
        invocations.push({ command, args });
        return {
          available: true,
          platform: 'darwin',
          reason: null,
          locale: 'en-US',
          speechAuthorization: 'notDetermined',
          microphoneAuthorization: 'authorized',
          supportsOnDeviceRecognition: true,
        };
      }
      return invoke(command, args);
    };

    const prepared = await nativeMacosSpeechService.prepareListening('en-US');

    expect(prepared).toBe(true);
    expect(invocations[0]).toEqual({ command: 'desktop_macos_microphone_status', args: undefined });
    expect(invocations[1]).toEqual({ command: 'desktop_macos_speech_capability', args: { language: 'en-US' } });
    expect(invocations[2]).toEqual({ command: 'desktop_macos_speech_authorize', args: { language: 'en-US' } });
  });

  test('uses existing authorized speech capability without re-requesting authorization', async () => {
    const { invocations } = installMockWindow();
    const invoke = ((globalThis.window as unknown as { __TAURI__: { core: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } } }).__TAURI__.core.invoke);
    (globalThis.window as unknown as { __TAURI__: { core: { invoke: typeof invoke } } }).__TAURI__.core.invoke = async (command, args) => {
      if (command === 'desktop_macos_speech_authorize') {
        invocations.push({ command, args });
        return {
          available: false,
          platform: 'darwin',
          reason: 'authorization_failed',
          locale: null,
          speechAuthorization: 'unknown',
          microphoneAuthorization: 'unknown',
          supportsOnDeviceRecognition: false,
        };
      }
      return invoke(command, args);
    };

    const result = await nativeMacosSpeechService.prepareListeningDetailed();

    expect(result.granted).toBe(true);
    expect(result.speechAuthorization).toBe('authorized');
    expect(invocations.some((item) => item.command === 'desktop_macos_speech_authorize')).toBe(false);
  });

  test('reports denied app microphone permission as a settings action', async () => {
    const { invocations } = installMockWindow();
    const invoke = ((globalThis.window as unknown as { __TAURI__: { core: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } } }).__TAURI__.core.invoke);
    (globalThis.window as unknown as { __TAURI__: { core: { invoke: typeof invoke } } }).__TAURI__.core.invoke = async (command, args) => {
      invocations.push({ command, args });
      if (command === 'desktop_macos_microphone_status') {
        return { status: 'denied', granted: false, canPrompt: false };
      }
      return invoke(command, args);
    };

    const result = await nativeMacosSpeechService.prepareListeningDetailed('en-US');

    expect(result.microphoneStatus).toBe('denied');
    expect(result.microphoneGranted).toBe(false);
    expect(result.granted).toBe(false);
    expect(result.needsSettings).toBe(true);
    expect(result.settingsTarget).toBe('microphone');
    expect(invocations.some((item) => item.command === 'desktop_macos_speech_authorize')).toBe(false);
  });

  test('lists native macOS input devices', async () => {
    const { invocations } = installMockWindow();

    const devices = await nativeMacosSpeechService.getInputDevices();

    expect(devices).toEqual([{ id: 'native-mic-1', name: 'Studio Mic', isDefault: true }]);
    expect(invocations[0]).toEqual({ command: 'desktop_macos_speech_devices', args: undefined });
  });

  test('bridges native transcript and error events', async () => {
    const { handlers, invocations } = installMockWindow();
    const transcripts: Array<{ text: string; isFinal: boolean }> = [];
    const errors: string[] = [];
    const levels: number[] = [];

    await nativeMacosSpeechService.startListening(
      'en-US',
      (text, isFinal) => transcripts.push({ text, isFinal }),
      (error) => errors.push(error),
      { inputDeviceId: 'native-mic-1', silenceThresholdDb: -44, silenceHoldMs: 900 },
      (level) => levels.push(level),
    );

    handlers.get('devryan:macos-speech')?.({
      payload: { type: 'transcript', provider: 'macos', text: 'hello', isFinal: false },
    });
    handlers.get('devryan:macos-speech')?.({
      payload: { type: 'transcript', provider: 'macos', text: 'hello world', isFinal: true },
    });
    handlers.get('devryan:macos-speech')?.({
      payload: { type: 'level', provider: 'macos', level: 1.4 },
    });
    handlers.get('devryan:macos-speech')?.({
      payload: { type: 'error', provider: 'macos', code: 'speech_permission_denied' },
    });

    expect(transcripts).toEqual([
      { text: 'hello', isFinal: false },
      { text: 'hello world', isFinal: true },
    ]);
    expect(levels).toEqual([1]);
    expect(errors[0]).toContain('Speech Recognition permission is disabled');
    expect(invocations.some((invocation) => JSON.stringify(invocation) === JSON.stringify({
      command: 'desktop_macos_speech_start',
      args: { language: 'en-US', inputDeviceId: 'native-mic-1', silenceThresholdDb: -44, silenceHoldMs: 900 },
    }))).toBe(true);
  });

  test('bridges final transcript metadata without stopping listening', async () => {
    const { handlers } = installMockWindow();
    const transcripts: Array<{ text: string; isFinal: boolean; finalReason?: string }> = [];

    await nativeMacosSpeechService.startListening(
      'en-US',
      (text, isFinal, finalReason) => transcripts.push({ text, isFinal, finalReason }),
      () => {},
      { silenceThresholdDb: -44, silenceHoldMs: 900 },
    );

    handlers.get('devryan:macos-speech')?.({
      payload: { type: 'transcript', provider: 'macos', text: 'pause here', isFinal: true, finalReason: 'silence' },
    });

    expect(transcripts).toEqual([
      { text: 'pause here', isFinal: true, finalReason: 'silence' },
    ]);
    expect(nativeMacosSpeechService.getIsListening()).toBe(true);
  });

  test('marks macOS speech as stopped only after a stopped event', async () => {
    const { handlers } = installMockWindow();

    await nativeMacosSpeechService.startListening(
      'en-US',
      () => {},
      () => {},
      { silenceThresholdDb: -44, silenceHoldMs: 900 },
    );

    expect(nativeMacosSpeechService.getIsListening()).toBe(true);

    handlers.get('devryan:macos-speech')?.({
      payload: { type: 'stopped', provider: 'macos' },
    });

    expect(nativeMacosSpeechService.getIsListening()).toBe(false);
  });
});
