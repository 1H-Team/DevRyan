import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BrowserVoiceService, type BrowserVoiceError } from './browserVoiceService';

class FakeSpeechRecognition {
  continuous = false;
  interimResults = false;
  lang = '';
  onstart: (() => void) | null = null;
  onaudiostart: (() => void) | null = null;
  onsoundstart: (() => void) | null = null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  startCalls = 0;
  stopCalls = 0;

  start(): void {
    this.startCalls += 1;
    this.onstart?.();
  }

  stop(): void {
    this.stopCalls += 1;
  }

  emitError(error: string): void {
    this.onerror?.({ error } as SpeechRecognitionErrorEvent);
  }

  emitEnd(): void {
    this.onend?.();
  }
}

let recognition: FakeSpeechRecognition;
let originalWindow: typeof globalThis.window | undefined;

beforeEach(() => {
  originalWindow = globalThis.window;
  recognition = new FakeSpeechRecognition();
  class RecognitionConstructor {
    constructor() {
      return recognition;
    }
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      SpeechRecognition: RecognitionConstructor,
      webkitSpeechRecognition: RecognitionConstructor,
      speechSynthesis: {},
      isSecureContext: true,
    },
  });
});

afterEach(() => {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, 'window');
    return;
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

describe('BrowserVoiceService recognition errors', () => {
  test('preserves the network error code and prevents an end-event restart', () => {
    const service = new BrowserVoiceService();
    const errors: BrowserVoiceError[] = [];

    service.startListeningSync('en-US', () => {}, (error) => errors.push(error));
    recognition.emitError('network');
    recognition.emitEnd();

    expect(errors).toEqual([{ code: 'network', message: 'Network error - check connection' }]);
    expect(recognition.startCalls).toBe(1);
    expect(service.getIsListening()).toBe(false);
  });

  test('preserves service and permission errors as distinct codes', () => {
    const service = new BrowserVoiceService();
    const errors: BrowserVoiceError[] = [];

    service.startListeningSync('en-US', () => {}, (error) => errors.push(error));
    recognition.emitError('service-not-allowed');
    recognition.emitError('not-allowed');

    expect(errors.map((error) => error.code)).toEqual(['service-not-allowed', 'not-allowed']);
  });

  test('keeps silence recoverable and ignores intentional aborts', () => {
    const service = new BrowserVoiceService();
    const errors: BrowserVoiceError[] = [];

    service.startListeningSync('en-US', () => {}, (error) => errors.push(error));
    recognition.emitError('aborted');
    recognition.emitError('no-speech');
    recognition.emitEnd();

    expect(errors).toEqual([{ code: 'no-speech', message: 'No speech detected' }]);
    expect(recognition.startCalls).toBe(2);
  });
});
