import { getSafeStorage } from '@/stores/utils/safeStorage';
/**
 * useBrowserVoice Hook
 * 
 * React hook for voice dictation integration.
 * Manages speech recognition and transcript insertion into the input box.
 * 
 * @example
 * ```typescript
 * const {
 *   status,
 *   isSupported,
 *   browserLanguage,
 *   setBrowserLanguage,
 *   startVoice,
 *   stopVoice,
 *   prepareVoice,
 *   isMobile,
 * } = useBrowserVoice();
 * 
 * // Start voice mode
 * startVoice();
 * 
 * // Change Browser provider recognition language
 * setBrowserLanguage('es-ES');
 * ```
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  browserVoiceService,
  type BrowserVoiceError,
  type BrowserVoiceErrorCode,
} from '@/lib/voice/browserVoiceService';
import { audioStreamService } from '@/lib/voice/audioStreamService';
import { nativeMacosSpeechService } from '@/lib/voice/nativeMacosSpeechService';
import {
  WASM_MODELS,
  wasmSttService,
  type WasmModelStatus,
} from '@/lib/voice/wasmSttService';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { useConfigStore } from '@/stores/useConfigStore';

export type BrowserVoiceStatus = 'idle' | 'listening' | 'processing' | 'speaking' | 'error';

export type LocalVoiceRecovery = {
  reason: Extract<BrowserVoiceErrorCode, 'network' | 'service-not-allowed'>;
  modelId: string;
  modelName: string;
  modelSize: string;
};

export interface UseBrowserVoiceReturn {
  /** Current voice status */
  status: BrowserVoiceStatus;
  /** Whether browser voice is supported */
  isSupported: boolean;
  /** Error message if any */
  error: string | null;
  /** Browser provider recognition language */
  browserLanguage: string;
  /** Set Browser provider recognition language */
  setBrowserLanguage: (lang: string) => void;
  /** Start voice mode (listening) */
  startVoice: () => Promise<void>;
  /** Stop voice mode */
  stopVoice: () => void;
  /** Prepare voice for mobile (request permission) */
  prepareVoice: () => Promise<boolean>;
  /** Whether the device is mobile */
  isMobile: boolean;
  /** Current microphone level, normalized from 0 to 1 when available */
  audioLevel: number | null;
  /** Local model download/load status */
  localModelStatus: WasmModelStatus;
  /** Consent-based Local fallback offered for browser service failures */
  localRecovery: LocalVoiceRecovery | null;
  /** Download the configured Local model, persist it, and resume listening */
  recoverWithLocal: () => Promise<boolean>;
  /** Current voice provider */
  voiceProvider: 'browser' | 'openai' | 'openai-compatible' | 'say';
}

// Storage key for persisting Browser provider language preference.
// Keep the existing key so users retain their previous browser STT language selection.
const LANGUAGE_STORAGE_KEY = 'browserVoiceLanguage';
const LANGUAGE_CHANGE_EVENT = 'openchamber:voice-language-changed';
const DEVICE_CHANGE_RESTART_DELAY_MS = 700;
const BLOCKED_SPEECH_LANGUAGES = new Set(['ru', 'ru-RU']);
const SERVER_STT_AUTO_LANGUAGE = 'auto';
// Intentionally no app language override: macOS should use Apple/system default speech language.
const MACOS_SYSTEM_LANGUAGE: string | undefined = undefined;

export const isBrowserServiceRecoveryError = (
  code: BrowserVoiceErrorCode,
): code is LocalVoiceRecovery['reason'] => code === 'network' || code === 'service-not-allowed';

const getChatInput = (): HTMLTextAreaElement | null => {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input="true"]');
};

const readChatInputText = (): string => getChatInput()?.value ?? '';

const readChatInputState = (): { text: string; hasActiveSelection: boolean } => {
  const input = getChatInput();
  if (!input) {
    return { text: '', hasActiveSelection: false };
  }

  return {
    text: input.value,
    hasActiveSelection: input.selectionStart !== input.selectionEnd,
  };
};

const focusChatInput = (): void => {
  const input = getChatInput();
  if (!input) return;
  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus();
  }
};

export const appendVoiceTranscript = (baseText: string, transcript: string): string => {
  const next = transcript.trim();
  if (!next) return baseText;
  if (!baseText) return `${next} `;
  const separator = /[\s\n]$/.test(baseText) ? '' : ' ';
  return `${baseText}${separator}${next} `;
};

export const isRecoverableVoiceSilenceError = (errorMsg: string): boolean => {
  const normalized = errorMsg.trim().toLowerCase();
  if (!normalized) return false;

  if (
    normalized.includes('permission') ||
    normalized.includes('not allowed') ||
    normalized.includes('network') ||
    normalized.includes('service unavailable') ||
    normalized.includes('microphone')
  ) {
    return false;
  }

  return normalized.includes('no-speech') ||
    normalized.includes('no speech') ||
    normalized.includes('no input');
};

const resolveIncrementalTranscript = (transcript: string, previousTranscript?: string | null): string => {
  const normalizedTranscript = transcript.trim();
  const normalizedPrevious = previousTranscript?.trim() ?? '';
  if (!normalizedTranscript || !normalizedPrevious) {
    return normalizedTranscript;
  }
  if (!normalizedTranscript.toLowerCase().startsWith(normalizedPrevious.toLowerCase())) {
    return normalizedTranscript;
  }
  return normalizedTranscript.slice(normalizedPrevious.length).trim();
};

export type VoiceOwnedRange = { start: number; end: number };

export type VoiceTranscriptDraftState = {
  insertionStart: number;
  insertionEnd: number;
  interimRange: VoiceOwnedRange | null;
  ownedText: string;
  lastTranscript: string | null;
};

export type VoiceTranscriptDraftUpdate = {
  state: VoiceTranscriptDraftState | null;
  currentText: string;
  selectionStart: number;
  selectionEnd: number;
  transcript: string;
  isFinal: boolean;
};

export type VoiceTranscriptDraftResult = {
  nextText: string;
  nextState: VoiceTranscriptDraftState;
  selection: { start: number; end: number };
};

const clampTextOffset = (value: number, text: string): number => {
  if (!Number.isFinite(value)) return text.length;
  return Math.max(0, Math.min(text.length, Math.trunc(value)));
};

const transcriptSegment = (currentText: string, start: number, transcript: string): string => {
  const normalized = transcript.trim();
  if (!normalized) return '';
  const needsLeadingSpace = start > 0 && !/[\s\n]$/.test(currentText.slice(0, start));
  return `${needsLeadingSpace ? ' ' : ''}${normalized} `;
};

const emptyVoiceDraftState = (position: number): VoiceTranscriptDraftState => ({
  insertionStart: position,
  insertionEnd: position,
  interimRange: null,
  ownedText: '',
  lastTranscript: null,
});

export const applyVoiceTranscriptUpdate = ({
  state,
  currentText,
  selectionStart,
  selectionEnd,
  transcript,
  isFinal,
}: VoiceTranscriptDraftUpdate): VoiceTranscriptDraftResult => {
  const normalized = transcript.trim();
  const safeSelectionStart = clampTextOffset(selectionStart, currentText);
  const safeSelectionEnd = clampTextOffset(selectionEnd, currentText);
  const selectionMin = Math.min(safeSelectionStart, safeSelectionEnd);
  const selectionMax = Math.max(safeSelectionStart, safeSelectionEnd);
  const activeSelection = selectionMin !== selectionMax;
  const fallbackState = state ?? emptyVoiceDraftState(selectionMax);

  if (!normalized || activeSelection) {
    return {
      nextText: currentText,
      selection: { start: safeSelectionStart, end: safeSelectionEnd },
      nextState: {
        ...fallbackState,
        insertionStart: selectionMax,
        insertionEnd: selectionMax,
        interimRange: null,
        ownedText: '',
      },
    };
  }

  const range = fallbackState.interimRange;
  const rangeIsValid = Boolean(
    range
      && range.start >= 0
      && range.end >= range.start
      && range.end <= currentText.length
      && currentText.slice(range.start, range.end) === fallbackState.ownedText,
  );

  const replaceStart = rangeIsValid
    ? range!.start
    : clampTextOffset(selectionMax, currentText);
  const replaceEnd = rangeIsValid
    ? range!.end
    : replaceStart;
  const effectiveTranscript = range && !rangeIsValid
    ? resolveIncrementalTranscript(normalized, fallbackState.lastTranscript)
    : normalized;
  const inserted = transcriptSegment(currentText, replaceStart, effectiveTranscript);

  if (!inserted) {
    return {
      nextText: currentText,
      selection: { start: safeSelectionStart, end: safeSelectionEnd },
      nextState: {
        ...fallbackState,
        insertionStart: selectionMax,
        insertionEnd: selectionMax,
        interimRange: null,
        ownedText: '',
        lastTranscript: normalized,
      },
    };
  }

  const nextText = `${currentText.slice(0, replaceStart)}${inserted}${currentText.slice(replaceEnd)}`;
  const nextCaret = replaceStart + inserted.length;
  return {
    nextText,
    selection: { start: nextCaret, end: nextCaret },
    nextState: {
      insertionStart: nextCaret,
      insertionEnd: nextCaret,
      interimRange: isFinal ? null : { start: replaceStart, end: nextCaret },
      ownedText: isFinal ? '' : inserted,
      lastTranscript: normalized,
    },
  };
};

export const resolveVoiceInputDraft = ({
  baseText,
  currentText,
  lastAppliedText,
  transcript,
  previousTranscript,
  hasActiveSelection = false,
  isRecentUserEdit = false,
}: {
  baseText: string;
  currentText: string;
  lastAppliedText: string | null;
  transcript: string;
  previousTranscript?: string | null;
  hasActiveSelection?: boolean;
  isRecentUserEdit?: boolean;
}): string => {
  // If the user edited after our last voice draft, treat their current input as
  // the new base instead of overwriting it with stale dictation state.
  const userChangedInput = lastAppliedText !== null && currentText !== lastAppliedText;
  const shouldRespectUserEdit = userChangedInput || hasActiveSelection || isRecentUserEdit;
  const effectiveBase = shouldRespectUserEdit ? currentText : baseText;
  const effectiveTranscript = shouldRespectUserEdit
    ? resolveIncrementalTranscript(transcript, previousTranscript)
    : transcript;
  return appendVoiceTranscript(effectiveBase, effectiveTranscript);
};

export const resolveCommittedVoiceInputDraft = (input: {
  baseText: string;
  currentText: string;
  lastAppliedText: string | null;
  transcript: string;
  previousTranscript?: string | null;
  hasActiveSelection?: boolean;
  isRecentUserEdit?: boolean;
}): {
  nextText: string;
  nextBaseText: string;
  nextLastAppliedText: string;
} => {
  const nextText = resolveVoiceInputDraft(input);
  return {
    nextText,
    nextBaseText: nextText,
    nextLastAppliedText: nextText,
  };
};

const sanitizeSpeechLanguage = (lang: string): string => {
  const normalized = (lang || '').trim();
  if (!normalized) {
    return 'en-US';
  }
  const base = normalized.split('-')[0].toLowerCase();
  if (BLOCKED_SPEECH_LANGUAGES.has(normalized) || BLOCKED_SPEECH_LANGUAGES.has(base)) {
    return 'en-US';
  }
  return normalized;
};

/**
 * Hook for managing browser-based voice dictation
 */
export function useBrowserVoice(): UseBrowserVoiceReturn {
  const [status, setStatus] = useState<BrowserVoiceStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState<number | null>(null);
  const [localModelStatus, setLocalModelStatus] = useState<WasmModelStatus>(() => wasmSttService.getModelStatus());
  const [localRecovery, setLocalRecovery] = useState<LocalVoiceRecovery | null>(null);
  const [browserLanguage, setBrowserLanguageState] = useState<string>(() => {
    // Try to load from localStorage, fallback to navigator.language
    if (typeof window !== 'undefined') {
      const saved = getSafeStorage().getItem(LANGUAGE_STORAGE_KEY);
      if (saved) return sanitizeSpeechLanguage(saved);
    }
    return sanitizeSpeechLanguage(navigator.language || 'en-US');
  });
  
  // Mobile detection
  const isMobile = useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    const userAgent = navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod|android|mobile|webos|blackberry|iemobile|opera mini/i.test(userAgent);
  }, []);
  
  // Refs for managing async operations
  const isActiveRef = useRef(false);
  const processingMessageRef = useRef(false);
  const voiceDraftStateRef = useRef<VoiceTranscriptDraftState | null>(null);
  const deviceChangeRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localRecoveryOfferedRef = useRef(false);
  
  // Store access
  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  const setPendingInputText = useInputStore((s) => s.setPendingInputText);
  const voiceProvider = useConfigStore((state) => state.voiceProvider);

  // STT provider config
  const sttProvider = useConfigStore((state) => state.sttProvider);
  const setSttProvider = useConfigStore((state) => state.setSttProvider);
  const sttServerUrl = useConfigStore((state) => state.sttServerUrl);
  const sttModel = useConfigStore((state) => state.sttModel);
  const wasmSttModel = useConfigStore((state) => state.wasmSttModel);
  const sttLanguage = useConfigStore((state) => state.sttLanguage);
  const voiceInputDeviceId = useConfigStore((state) => state.voiceInputDeviceId);
  const sttSilenceThresholdDb = useConfigStore((state) => state.sttSilenceThresholdDb);
  const sttSilenceHoldMs = useConfigStore((state) => state.sttSilenceHoldMs);

  const isSupported = sttProvider === 'server'
    ? audioStreamService.isSupported()
    : sttProvider === 'macos'
      ? nativeMacosSpeechService.isSupported()
      : sttProvider === 'wasm'
        ? wasmSttService.isSupported()
        : browserVoiceService.isSupported();

  useEffect(() => wasmSttService.subscribeModelStatus(setLocalModelStatus), []);

  // Stop voice when session changes to prevent microphone from staying active
  // This ensures voice mode doesn't carry over between sessions
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSessionIdRef.current !== null && prevSessionIdRef.current !== currentSessionId) {
      // Session changed - stop any active voice session
      if (isActiveRef.current) {
        console.log('[useBrowserVoice] Session changed, stopping voice');
        isActiveRef.current = false;
        processingMessageRef.current = false;
        browserVoiceService.stopListening();
        audioStreamService.stopListening();
        nativeMacosSpeechService.stopListening();
        wasmSttService.stopListening();
        browserVoiceService.cancelSpeech();
        voiceDraftStateRef.current = null;
        localRecoveryOfferedRef.current = false;
        setLocalRecovery(null);
        setAudioLevel(null);
        setStatus('idle');
        setError(null);
      }
    }
    prevSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);
  
  // Persist Browser provider language preference.
  const setBrowserLanguage = useCallback((lang: string) => {
    const nextLang = sanitizeSpeechLanguage(lang);
    setBrowserLanguageState(nextLang);
    if (typeof window !== 'undefined') {
      getSafeStorage().setItem(LANGUAGE_STORAGE_KEY, nextLang);
      window.dispatchEvent(new CustomEvent<string>(LANGUAGE_CHANGE_EVENT, { detail: nextLang }));
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleLanguageEvent = (event: Event) => {
      const customEvent = event as CustomEvent<string>;
      const nextLang = sanitizeSpeechLanguage(customEvent.detail || getSafeStorage().getItem(LANGUAGE_STORAGE_KEY) || 'en-US');
      setBrowserLanguageState((prev) => (prev === nextLang ? prev : nextLang));
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== LANGUAGE_STORAGE_KEY || !event.newValue) {
        return;
      }
      const nextLang = sanitizeSpeechLanguage(event.newValue);
      setBrowserLanguageState((prev) => (prev === nextLang ? prev : nextLang));
    };

    window.addEventListener(LANGUAGE_CHANGE_EVENT, handleLanguageEvent as EventListener);
    window.addEventListener('storage', handleStorage);

    return () => {
      window.removeEventListener(LANGUAGE_CHANGE_EVENT, handleLanguageEvent as EventListener);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  // Refs for callbacks to avoid circular dependencies
  const handleSpeechErrorRef = useRef<((errorMsg: string) => void) | null>(null);
  const handleBrowserSpeechErrorRef = useRef<((error: BrowserVoiceError) => void) | null>(null);
  const handleSpeechResultRef = useRef<((text: string, isFinal: boolean) => Promise<void>) | null>(null);

  const handleAudioLevel = useCallback((level: number) => {
    if (!isActiveRef.current) return;
    setAudioLevel(Math.max(0, Math.min(1, level)));
  }, []);

  // Handle speech recognition error
  const handleSpeechError = useCallback((errorMsg: string) => {
    // Ignore errors if we've already stopped voice mode
    if (!isActiveRef.current) {
      console.log('[useBrowserVoice] Ignoring error after voice stopped:', errorMsg);
      return;
    }

    const normalizedError = errorMsg.toLowerCase();
    if (normalizedError.includes('aborted')) {
      console.log('[useBrowserVoice] Ignoring non-fatal aborted error');
      setError(null);
      setStatus('listening');
      return;
    }

    if (isRecoverableVoiceSilenceError(errorMsg)) {
      console.log('[useBrowserVoice] Ignoring recoverable silence error:', errorMsg);
      setError(null);
      setStatus('listening');
      return;
    }

    const isPermissionStyleError =
      normalizedError.includes('permission') ||
      normalizedError.includes('not allowed') ||
      normalizedError.includes('service not allowed');
    const isFatalRecognitionError =
      isPermissionStyleError ||
      normalizedError.includes('network') ||
      normalizedError.includes('service unavailable') ||
      normalizedError.includes('no microphone found');

    console.error('[useBrowserVoice] Recognition error:', errorMsg);
    setError(errorMsg);
    setStatus('error');

    if (isFatalRecognitionError) {
      isActiveRef.current = false;
      browserVoiceService.stopListening();
      audioStreamService.stopListening();
      nativeMacosSpeechService.stopListening();
      return;
    }
    
    // Auto-recover from certain errors
    setTimeout(() => {
      if (isActiveRef.current) {
        setStatus('listening');
        setError(null);
        if (sttProvider === 'server') {
          audioStreamService.startListening(SERVER_STT_AUTO_LANGUAGE, handleSpeechResultRef.current!, handleSpeechError, handleAudioLevel).catch(() => {});
        } else if (sttProvider === 'macos') {
          nativeMacosSpeechService.startListening(MACOS_SYSTEM_LANGUAGE, handleSpeechResultRef.current!, handleSpeechError, {
            inputDeviceId: voiceInputDeviceId || undefined,
            silenceThresholdDb: sttSilenceThresholdDb,
            silenceHoldMs: sttSilenceHoldMs,
          }, handleAudioLevel).catch(() => {});
        } else if (sttProvider === 'wasm') {
          wasmSttService.configure({
            deviceId: voiceInputDeviceId || undefined,
            silenceThresholdDb: sttSilenceThresholdDb,
            silenceHoldMs: sttSilenceHoldMs,
          });
          wasmSttService.startListening(sttLanguage || browserLanguage, handleSpeechResultRef.current!, handleSpeechError, handleAudioLevel).catch(() => {});
        } else {
          const browserErrorHandler = handleBrowserSpeechErrorRef.current;
          if (browserErrorHandler) {
            browserVoiceService.startListening(browserLanguage, handleSpeechResultRef.current!, browserErrorHandler);
          }
        }
      }
    }, 1000);
  }, [browserLanguage, sttLanguage, sttProvider, voiceInputDeviceId, sttSilenceThresholdDb, sttSilenceHoldMs, handleAudioLevel]);

  // Update the ref when handleSpeechError changes
  useEffect(() => {
    handleSpeechErrorRef.current = handleSpeechError;
  }, [handleSpeechError]);

  const handleBrowserSpeechError = useCallback((browserError: BrowserVoiceError) => {
    if (!isActiveRef.current) {
      console.log('[useBrowserVoice] Ignoring browser error after voice stopped:', browserError);
      return;
    }

    if (
      sttProvider === 'browser'
      && isBrowserServiceRecoveryError(browserError.code)
      && wasmSttService.isSupported()
    ) {
      if (localRecoveryOfferedRef.current) {
        return;
      }

      localRecoveryOfferedRef.current = true;
      browserVoiceService.stopListening();
      isActiveRef.current = false;
      setAudioLevel(null);
      setError(browserError.message);
      setStatus('error');

      const model = WASM_MODELS.find((candidate) => candidate.id === wasmSttModel);
      setLocalRecovery({
        reason: browserError.code,
        modelId: wasmSttModel,
        modelName: model?.name ?? wasmSttModel,
        modelSize: model?.size ?? 'one-time download',
      });
      return;
    }

    handleSpeechError(browserError.message);
  }, [handleSpeechError, sttProvider, wasmSttModel]);

  useEffect(() => {
    handleBrowserSpeechErrorRef.current = handleBrowserSpeechError;
  }, [handleBrowserSpeechError]);

  // Handle speech recognition result
  const handleSpeechResult = useCallback(async (text: string, isFinal: boolean) => {
    if (!isActiveRef.current) return;
    const normalized = text.trim();
    if (!normalized) return;

    const input = getChatInput();
    const { text: currentText } = readChatInputState();
    const selectionStart = input?.selectionStart ?? currentText.length;
    const selectionEnd = input?.selectionEnd ?? selectionStart;
    const result = applyVoiceTranscriptUpdate({
      state: voiceDraftStateRef.current,
      currentText,
      selectionStart,
      selectionEnd,
      transcript: text,
      isFinal,
    });
    voiceDraftStateRef.current = result.nextState;
    if (result.nextText !== currentText) {
      setPendingInputText(result.nextText, 'replace', {
        selection: result.selection,
        source: 'voice',
        preserveFocus: true,
      });
    }
    processingMessageRef.current = false;
  }, [setPendingInputText]);

  useEffect(() => {
    if (typeof navigator === 'undefined') {
      return;
    }

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.addEventListener !== 'function') {
      return;
    }

    const handleDeviceChange = () => {
      if (!isActiveRef.current || status !== 'listening') {
        return;
      }

      if (deviceChangeRestartTimerRef.current) {
        clearTimeout(deviceChangeRestartTimerRef.current);
      }

      deviceChangeRestartTimerRef.current = setTimeout(() => {
        deviceChangeRestartTimerRef.current = null;
        if (!isActiveRef.current || status !== 'listening') {
          return;
        }

        try {
          if (sttProvider === 'server') {
            audioStreamService.stopListening();
            void audioStreamService.startListening(SERVER_STT_AUTO_LANGUAGE, handleSpeechResultRef.current!, handleSpeechErrorRef.current!, handleAudioLevel);
          } else if (sttProvider === 'macos') {
            nativeMacosSpeechService.stopListening();
            void nativeMacosSpeechService.startListening(MACOS_SYSTEM_LANGUAGE, handleSpeechResultRef.current!, handleSpeechErrorRef.current!, {
              inputDeviceId: voiceInputDeviceId || undefined,
              silenceThresholdDb: sttSilenceThresholdDb,
              silenceHoldMs: sttSilenceHoldMs,
            }, handleAudioLevel);
          } else if (sttProvider === 'wasm') {
            wasmSttService.stopListening();
            wasmSttService.configure({
              deviceId: voiceInputDeviceId || undefined,
              silenceThresholdDb: sttSilenceThresholdDb,
              silenceHoldMs: sttSilenceHoldMs,
            });
            void wasmSttService.startListening(sttLanguage || browserLanguage, handleSpeechResultRef.current!, handleSpeechErrorRef.current!, handleAudioLevel);
          } else {
            browserVoiceService.stopListening();
            const browserErrorHandler = handleBrowserSpeechErrorRef.current;
            if (!browserErrorHandler) return;
            if (isMobile) {
              browserVoiceService.startListeningSync(browserLanguage, handleSpeechResultRef.current!, browserErrorHandler);
            } else {
              void browserVoiceService.startListening(browserLanguage, handleSpeechResultRef.current!, browserErrorHandler);
            }
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Microphone source changed. Tap mic to continue.';
          setError(errorMsg);
          setStatus('error');
          isActiveRef.current = false;
        }
      }, DEVICE_CHANGE_RESTART_DELAY_MS);
    };

    mediaDevices.addEventListener('devicechange', handleDeviceChange);

    return () => {
      mediaDevices.removeEventListener('devicechange', handleDeviceChange);
      if (deviceChangeRestartTimerRef.current) {
        clearTimeout(deviceChangeRestartTimerRef.current);
        deviceChangeRestartTimerRef.current = null;
      }
    };
  }, [isMobile, browserLanguage, sttLanguage, status, sttProvider, voiceInputDeviceId, sttSilenceThresholdDb, sttSilenceHoldMs, handleAudioLevel]);

  // Update the ref when handleSpeechResult changes
  useEffect(() => {
    handleSpeechResultRef.current = handleSpeechResult;
  }, [handleSpeechResult]);

  const recoverWithLocal = useCallback(async (): Promise<boolean> => {
    if (!localRecovery || !wasmSttService.isSupported()) {
      return false;
    }

    const recoverySessionId = currentSessionIdRef.current;
    browserVoiceService.stopListening();
    isActiveRef.current = true;
    setError(null);
    setAudioLevel(null);
    setStatus('processing');
    focusChatInput();

    try {
      const modelStatus = wasmSttService.getModelStatus();
      if (modelStatus.state !== 'ready' || wasmSttService.getCurrentModelId() !== localRecovery.modelId) {
        await wasmSttService.loadModel(localRecovery.modelId);
      }
      if (!isActiveRef.current || currentSessionIdRef.current !== recoverySessionId) {
        isActiveRef.current = false;
        voiceDraftStateRef.current = null;
        setLocalRecovery(null);
        setError(null);
        setAudioLevel(null);
        setStatus('idle');
        return false;
      }

      wasmSttService.configure({
        deviceId: voiceInputDeviceId || undefined,
        silenceThresholdDb: sttSilenceThresholdDb,
        silenceHoldMs: sttSilenceHoldMs,
      });
      setSttProvider('wasm');
      setLocalRecovery(null);
      setStatus('listening');
      await wasmSttService.startListening(
        sttLanguage || browserLanguage,
        handleSpeechResult,
        handleSpeechError,
        handleAudioLevel,
      );
      return wasmSttService.getIsListening();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to load the local voice model';
      console.error('[useBrowserVoice] Local fallback failed:', errorMsg);
      isActiveRef.current = false;
      setLocalRecovery(null);
      setError(`Local voice setup failed: ${errorMsg}`);
      setStatus('error');
      setAudioLevel(null);
      return false;
    }
  }, [browserLanguage, handleAudioLevel, handleSpeechError, handleSpeechResult, localRecovery, setSttProvider, sttLanguage, sttSilenceHoldMs, sttSilenceThresholdDb, voiceInputDeviceId]);

  // Prepare voice for mobile (request permission)
  const prepareVoice = useCallback(async (): Promise<boolean> => {
    if (!isSupported) {
      return false;
    }
    if (sttProvider === 'server') {
      // getUserMedia permission is requested on startListening; nothing to prepare
      return true;
    }
    if (sttProvider === 'macos') {
      try {
        return await nativeMacosSpeechService.prepareListening();
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'macOS Speech permission denied';
        setError(errorMsg);
        return false;
      }
    }
    if (sttProvider === 'wasm') {
      return true;
    }
    try {
      await browserVoiceService.prepareListening();
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Microphone permission denied';
      setError(errorMsg);
      return false;
    }
  }, [isSupported, sttProvider]);

  // Start voice mode
  const startVoice = useCallback(async () => {
    if (!isSupported) {
      setError('Voice input not supported in this browser');
      setStatus('error');
      return;
    }
    
    localRecoveryOfferedRef.current = false;
    setLocalRecovery(null);
    isActiveRef.current = true;
    const initialInput = getChatInput();
    const initialPosition = initialInput?.selectionEnd ?? readChatInputText().length;
    voiceDraftStateRef.current = emptyVoiceDraftState(initialPosition);
    setError(null);
    setAudioLevel(null);

    if (sttProvider === 'server') {
      setStatus('listening');
      focusChatInput();
      // Server STT: configure the service then start async recording
      audioStreamService.configure({
        baseURL: sttServerUrl,
        model: sttModel,
        language: sttLanguage || undefined,
        deviceId: voiceInputDeviceId || undefined,
        silenceThresholdDb: sttSilenceThresholdDb,
        silenceHoldMs: sttSilenceHoldMs,
      });
      try {
        await audioStreamService.startListening(SERVER_STT_AUTO_LANGUAGE, handleSpeechResult, handleSpeechError, handleAudioLevel);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to start voice';
        console.error('[useBrowserVoice] Server STT start error:', errorMsg);
        setError(errorMsg);
        setStatus('error');
        isActiveRef.current = false;
        voiceDraftStateRef.current = null;
        setAudioLevel(null);
      }
      return;
    }

    if (sttProvider === 'macos') {
      try {
        const permission = await nativeMacosSpeechService.prepareListeningDetailed(MACOS_SYSTEM_LANGUAGE);
        if (!permission.granted) {
          if (permission.needsSettings && permission.settingsTarget) {
            await nativeMacosSpeechService.openPrivacySettings(permission.settingsTarget);
          }
          const errorMsg = permission.message || 'macOS voice input permission was not granted.';
          setError(errorMsg);
          setStatus('error');
          isActiveRef.current = false;
          voiceDraftStateRef.current = null;
          setAudioLevel(null);
          return;
        }
        if (!isActiveRef.current) return;
        setStatus('listening');
        focusChatInput();
        await nativeMacosSpeechService.startListening(MACOS_SYSTEM_LANGUAGE, handleSpeechResult, handleSpeechError, {
          inputDeviceId: voiceInputDeviceId || undefined,
          silenceThresholdDb: sttSilenceThresholdDb,
          silenceHoldMs: sttSilenceHoldMs,
        }, handleAudioLevel);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to start macOS voice input';
        console.error('[useBrowserVoice] macOS STT start error:', errorMsg);
        setError(errorMsg);
        setStatus('error');
        isActiveRef.current = false;
        voiceDraftStateRef.current = null;
        setAudioLevel(null);
      }
      return;
    }

    if (sttProvider === 'wasm') {
      setStatus('processing');
      focusChatInput();
      try {
        const modelStatus = wasmSttService.getModelStatus();
        if (modelStatus.state !== 'ready' || wasmSttService.getCurrentModelId() !== wasmSttModel) {
          await wasmSttService.loadModel(wasmSttModel);
        }
        if (!isActiveRef.current) return;
        wasmSttService.configure({
          deviceId: voiceInputDeviceId || undefined,
          silenceThresholdDb: sttSilenceThresholdDb,
          silenceHoldMs: sttSilenceHoldMs,
        });
        setStatus('listening');
        await wasmSttService.startListening(sttLanguage || browserLanguage, handleSpeechResult, handleSpeechError, handleAudioLevel);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to start local voice input';
        console.error('[useBrowserVoice] WASM STT start error:', errorMsg);
        setError(errorMsg);
        setStatus('error');
        isActiveRef.current = false;
        voiceDraftStateRef.current = null;
        setAudioLevel(null);
      }
      return;
    }

    // Browser STT
    // On mobile, use sync path to ensure SpeechRecognition.start() is called
    // within the same user gesture context (required by iOS Safari)
    if (isMobile) {
      setStatus('listening');
      focusChatInput();
      try {
        browserVoiceService.unlockAudio().catch(() => {
          // Audio unlock failed, but continue anyway
        });
        browserVoiceService.startListeningSync(browserLanguage, handleSpeechResult, handleBrowserSpeechError);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to start voice';
        console.error('[useBrowserVoice] Mobile voice start error:', errorMsg);
        setError(errorMsg);
        setStatus('error');
          isActiveRef.current = false;
          voiceDraftStateRef.current = null;
          setAudioLevel(null);
      }
    } else {
      setStatus('listening');
      focusChatInput();
      // Desktop can use async path with permission check
      try {
        await browserVoiceService.startListening(browserLanguage, handleSpeechResult, handleBrowserSpeechError);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to start voice';
        console.error('[useBrowserVoice] Desktop voice start error:', errorMsg);
        setError(errorMsg);
        setStatus('error');
        isActiveRef.current = false;
        voiceDraftStateRef.current = null;
        setAudioLevel(null);
      }
    }
  }, [isSupported, browserLanguage, handleSpeechResult, handleSpeechError, handleBrowserSpeechError, handleAudioLevel, isMobile, sttProvider, sttServerUrl, sttModel, wasmSttModel, sttLanguage, voiceInputDeviceId, sttSilenceThresholdDb, sttSilenceHoldMs]);

  // Stop voice mode
  const stopVoice = useCallback(() => {
    isActiveRef.current = false;
    processingMessageRef.current = false;
    if (deviceChangeRestartTimerRef.current) {
      clearTimeout(deviceChangeRestartTimerRef.current);
      deviceChangeRestartTimerRef.current = null;
    }
    browserVoiceService.stopListening();
    audioStreamService.stopListening();
    nativeMacosSpeechService.stopListening();
    wasmSttService.stopListening();
    browserVoiceService.cancelSpeech();
    voiceDraftStateRef.current = null;
    localRecoveryOfferedRef.current = false;
    setLocalRecovery(null);
    setAudioLevel(null);
    setStatus('idle');
    setError(null);
  }, []);
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isActiveRef.current = false;
      if (deviceChangeRestartTimerRef.current) {
        clearTimeout(deviceChangeRestartTimerRef.current);
        deviceChangeRestartTimerRef.current = null;
      }
      browserVoiceService.stopListening();
      audioStreamService.stopListening();
      nativeMacosSpeechService.stopListening();
      wasmSttService.stopListening();
      browserVoiceService.cancelSpeech();
      voiceDraftStateRef.current = null;
      localRecoveryOfferedRef.current = false;
      setAudioLevel(null);
    };
  }, []);
  
  return {
    status,
    isSupported,
    error,
    browserLanguage,
    setBrowserLanguage,
    startVoice,
    stopVoice,
    prepareVoice,
    isMobile,
    audioLevel,
    localModelStatus,
    localRecovery,
    recoverWithLocal,
    voiceProvider,
  };
}
