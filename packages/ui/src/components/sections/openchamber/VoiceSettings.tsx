import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useBrowserVoice } from '@/hooks/useBrowserVoice';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDeviceInfo } from '@/lib/device';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { RiPlayLine, RiStopLine, RiCloseLine, RiAppleLine, RiInformationLine } from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { audioStreamService } from '@/lib/voice/audioStreamService';
import { nativeMacosSpeechService, type MacosMicrophoneStatus, type MacosSpeechCapability, type MacosSpeechInputDevice } from '@/lib/voice/nativeMacosSpeechService';
import { WASM_MODELS, wasmSttService, type WasmModelStatus } from '@/lib/voice/wasmSttService';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { getSelectableVoiceInputProviders, getVoiceInputSourceMode, normalizeVoiceInputProvider } from './voiceSettingsUtils';
const LANGUAGE_OPTIONS = [
    { value: 'en-US', label: 'English' },
    { value: 'es-ES', label: 'Español' },
    { value: 'fr-FR', label: 'Français' },
    { value: 'de-DE', label: 'Deutsch' },
    { value: 'ja-JP', label: '日本語' },
    { value: 'zh-CN', label: '中文' },
    { value: 'pt-BR', label: 'Português' },
    { value: 'it-IT', label: 'Italiano' },
    { value: 'ko-KR', label: '한국어' },
    { value: 'uk-UA', label: 'Українська' },
];

const isSelectableAudioInputDevice = (device: MediaDeviceInfo): boolean => {
    if (device.kind !== 'audioinput') return false;
    if (!device.deviceId || device.deviceId === 'default' || device.deviceId === 'communications') return false;
    // Chromium exposes a synthetic "Default - …" microphone in addition to the real device.
    // Keep a single System Default option and hide that duplicate row.
    if (/^default\s*-/i.test(device.label)) return false;
    return true;
};

export const VoiceSettings: React.FC = () => {
    const { t } = useI18n();
    const { isMobile } = useDeviceInfo();
    const {
        isSupported,
        browserLanguage,
        setBrowserLanguage,
    } = useBrowserVoice();
    const voiceProvider = useConfigStore((state) => state.voiceProvider);
    const setVoiceProvider = useConfigStore((state) => state.setVoiceProvider);
    const speechRate = useConfigStore((state) => state.speechRate);
    const setSpeechRate = useConfigStore((state) => state.setSpeechRate);
    const speechPitch = useConfigStore((state) => state.speechPitch);
    const setSpeechPitch = useConfigStore((state) => state.setSpeechPitch);
    const speechVolume = useConfigStore((state) => state.speechVolume);
    const setSpeechVolume = useConfigStore((state) => state.setSpeechVolume);
    const sayVoice = useConfigStore((state) => state.sayVoice);
    const setSayVoice = useConfigStore((state) => state.setSayVoice);
    const browserVoice = useConfigStore((state) => state.browserVoice);
    const setBrowserVoice = useConfigStore((state) => state.setBrowserVoice);
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    // STT settings
    const sttProvider = useConfigStore((state) => state.sttProvider);
    const setSttProvider = useConfigStore((state) => state.setSttProvider);
    const voiceInputDeviceId = useConfigStore((state) => state.voiceInputDeviceId);
    const setVoiceInputDeviceId = useConfigStore((state) => state.setVoiceInputDeviceId);
    const sttServerUrl = useConfigStore((state) => state.sttServerUrl);
    const setSttServerUrl = useConfigStore((state) => state.setSttServerUrl);
    const sttModel = useConfigStore((state) => state.sttModel);
    const setSttModel = useConfigStore((state) => state.setSttModel);
    const wasmSttModel = useConfigStore((state) => state.wasmSttModel);
    const setWasmSttModel = useConfigStore((state) => state.setWasmSttModel);
    const sttLanguage = useConfigStore((state) => state.sttLanguage);
    const setSttLanguage = useConfigStore((state) => state.setSttLanguage);
    const sttSilenceThresholdDb = useConfigStore((state) => state.sttSilenceThresholdDb);
    const setSttSilenceThresholdDb = useConfigStore((state) => state.setSttSilenceThresholdDb);
    const sttSilenceHoldMs = useConfigStore((state) => state.sttSilenceHoldMs);
    const setSttSilenceHoldMs = useConfigStore((state) => state.setSttSilenceHoldMs);
    const setShowMessageTTSButtons = useConfigStore((state) => state.setShowMessageTTSButtons);
    const voiceModeEnabled = useConfigStore((state) => state.voiceModeEnabled);
    const setVoiceModeEnabled = useConfigStore((state) => state.setVoiceModeEnabled);
    const voicePlaybackEnabled = useConfigStore((state) => state.voicePlaybackEnabled);
    const setVoicePlaybackEnabled = useConfigStore((state) => state.setVoicePlaybackEnabled);
    const summarizeMessageTTS = useConfigStore((state) => state.summarizeMessageTTS);
    const setSummarizeMessageTTS = useConfigStore((state) => state.setSummarizeMessageTTS);
    const summarizeCharacterThreshold = useConfigStore((state) => state.summarizeCharacterThreshold);
    const setSummarizeCharacterThreshold = useConfigStore((state) => state.setSummarizeCharacterThreshold);
    const summarizeMaxLength = useConfigStore((state) => state.summarizeMaxLength);
    const setSummarizeMaxLength = useConfigStore((state) => state.setSummarizeMaxLength);

    const [isSayAvailable, setIsSayAvailable] = useState(false);
    const [sayVoices, setSayVoices] = useState<Array<{ name: string; locale: string }>>([]);
    const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
    const [previewAudio, setPreviewAudio] = useState<HTMLAudioElement | null>(null);

    const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);
    const [isBrowserPreviewPlaying, setIsBrowserPreviewPlaying] = useState(false);
    const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
    const [macosInputDevices, setMacosInputDevices] = useState<MacosSpeechInputDevice[]>([]);
    const [macosSpeechCapability, setMacosSpeechCapability] = useState<MacosSpeechCapability | null>(null);
    const [macosAppMicrophoneStatus, setMacosAppMicrophoneStatus] = useState<MacosMicrophoneStatus>('unknown');
    const [wasmModelStatus, setWasmModelStatus] = useState<WasmModelStatus>(() => wasmSttService.getModelStatus());

    const refreshMacosCapability = useCallback(async () => {
        try {
            setMacosSpeechCapability(await nativeMacosSpeechService.getCapability());
        } catch {
            setMacosSpeechCapability({
                available: false,
                platform: 'unknown',
                reason: 'capability_check_failed',
                locale: null,
                speechAuthorization: 'unknown',
                microphoneAuthorization: 'unknown',
                supportsOnDeviceRecognition: false,
            });
        }
    }, []);

    const loadMacosInputDevices = useCallback(async () => {
        setMacosInputDevices(await nativeMacosSpeechService.getInputDevices());
    }, []);

    const refreshMacosMicrophoneStatus = useCallback(async () => {
        setMacosAppMicrophoneStatus((await nativeMacosSpeechService.getMicrophonePermission()).status);
    }, []);

    useEffect(() => {
        const loadVoices = async () => {
            const voices = await browserVoiceService.waitForVoices();
            setBrowserVoices(voices);
        };
        loadVoices();

        if ('speechSynthesis' in window) {
            window.speechSynthesis.onvoiceschanged = () => {
                setBrowserVoices(window.speechSynthesis.getVoices());
            };
        }

        return () => {
            if ('speechSynthesis' in window) {
                window.speechSynthesis.onvoiceschanged = null;
            }
        };
    }, []);

    useEffect(() => {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
            return;
        }

        const loadInputDevices = async () => {
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                setInputDevices(devices.filter(isSelectableAudioInputDevice));
            } catch {
                setInputDevices([]);
            }
        };

        void loadInputDevices();
        navigator.mediaDevices.addEventListener?.('devicechange', loadInputDevices);
        return () => {
            navigator.mediaDevices.removeEventListener?.('devicechange', loadInputDevices);
        };
    }, []);

    useEffect(() => {
        void refreshMacosCapability();
        void loadMacosInputDevices();
        void refreshMacosMicrophoneStatus();
    }, [loadMacosInputDevices, refreshMacosCapability, refreshMacosMicrophoneStatus]);

    useEffect(() => wasmSttService.subscribeModelStatus(setWasmModelStatus), []);

    const filteredBrowserVoices = useMemo(() => {
        return browserVoices
            .filter(v => v.lang)
            .sort((a, b) => {
                const aIsEnglish = a.lang.startsWith('en');
                const bIsEnglish = b.lang.startsWith('en');
                if (aIsEnglish && !bIsEnglish) return -1;
                if (!aIsEnglish && bIsEnglish) return 1;
                const langCompare = a.lang.localeCompare(b.lang);
                if (langCompare !== 0) return langCompare;
                return a.name.localeCompare(b.name);
            });
    }, [browserVoices]);

    const previewBrowserVoice = useCallback(() => {
        if (isBrowserPreviewPlaying) {
            browserVoiceService.cancelSpeech();
            setIsBrowserPreviewPlaying(false);
            return;
        }

        const selectedVoice = browserVoices.find(v => v.name === browserVoice);
        const voiceName = selectedVoice?.name ?? t('settings.voice.page.preview.browserVoiceFallback');
        const previewText = t('settings.voice.page.preview.voiceLine', { voiceName });

        setIsBrowserPreviewPlaying(true);

        const utterance = new SpeechSynthesisUtterance(previewText);
        utterance.rate = speechRate;
        utterance.pitch = speechPitch;
        utterance.volume = speechVolume;

        if (selectedVoice) {
            utterance.voice = selectedVoice;
            utterance.lang = selectedVoice.lang;
        }

        utterance.onend = () => setIsBrowserPreviewPlaying(false);
        utterance.onerror = () => setIsBrowserPreviewPlaying(false);

        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
    }, [browserVoice, browserVoices, speechRate, speechPitch, speechVolume, isBrowserPreviewPlaying, t]);

    useEffect(() => {
        return () => {
            if (isBrowserPreviewPlaying) {
                browserVoiceService.cancelSpeech();
            }
        };
    }, [isBrowserPreviewPlaying]);

    useEffect(() => {
        fetch('/api/tts/say/status')
            .then(res => res.json())
            .then(data => {
                setIsSayAvailable(data.available);
                if (data.voices) {
                    const uniqueVoices = data.voices
                        .filter((v: { name: string; locale: string }, i: number, arr: Array<{ name: string; locale: string }>) =>
                            arr.findIndex((x: { name: string }) => x.name === v.name) === i
                        )
                        .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
                    setSayVoices(uniqueVoices);
                }
            })
            .catch(() => {
                setIsSayAvailable(false);
            });
    }, []);

    const previewVoice = useCallback(async () => {
        if (previewAudio) {
            previewAudio.pause();
            previewAudio.currentTime = 0;
            setPreviewAudio(null);
            setIsPreviewPlaying(false);
            return;
        }

        setIsPreviewPlaying(true);
        try {
            const response = await fetch('/api/tts/say/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: t('settings.voice.page.preview.voiceLine', { voiceName: sayVoice }),
                    voice: sayVoice,
                    rate: Math.round(100 + (speechRate - 0.5) * 200),
                }),
            });

            if (!response.ok) throw new Error('Preview failed');

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);

            audio.onended = () => {
                URL.revokeObjectURL(url);
                setPreviewAudio(null);
                setIsPreviewPlaying(false);
            };

            audio.onerror = () => {
                URL.revokeObjectURL(url);
                setPreviewAudio(null);
                setIsPreviewPlaying(false);
            };

            setPreviewAudio(audio);
            await audio.play();
        } catch {
            setIsPreviewPlaying(false);
        }
    }, [sayVoice, speechRate, previewAudio, t]);

    useEffect(() => {
        return () => {
            if (previewAudio) {
                previewAudio.pause();
            }
        };
    }, [previewAudio]);

    useEffect(() => {
        if (voiceProvider === 'openai' || voiceProvider === 'openai-compatible') {
            // OpenAI and custom playback are no longer exposed in Voice settings; normalize persisted UI state to Browser.
            setVoiceProvider('browser');
        }
    }, [setVoiceProvider, voiceProvider]);

    const sliderClass = "flex-1 min-w-0 h-1.5 bg-[var(--interactive-border)] rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:border-0 disabled:opacity-50";
    const visibleVoiceProvider = voiceProvider === 'say' ? 'say' : 'browser';
    const inputSourceMode = getVoiceInputSourceMode(sttProvider);
    const isMacosSpeechAvailable = Boolean(macosSpeechCapability?.available);
    const isLocalSpeechAvailable = wasmSttService.isSupported();
    const selectableVoiceInputProviders = useMemo(
        () => getSelectableVoiceInputProviders(isMacosSpeechAvailable, isLocalSpeechAvailable),
        [isLocalSpeechAvailable, isMacosSpeechAvailable],
    );
    const selectedBrowserInputDeviceId = inputDevices.some((device) => device.deviceId === voiceInputDeviceId) ? voiceInputDeviceId : '';
    const selectedMacosInputDeviceId = macosInputDevices.some((device) => device.id === voiceInputDeviceId) ? voiceInputDeviceId : '';
    const hasUndeterminedMacosPermission = macosAppMicrophoneStatus === 'not-determined'
        || macosSpeechCapability?.speechAuthorization === 'notDetermined';
    const formatPermissionStatus = useCallback((status: MacosSpeechCapability['speechAuthorization'] | MacosMicrophoneStatus) => {
        switch (status) {
            case 'authorized': return t('settings.voice.page.field.permissionAuthorized');
            case 'granted': return t('settings.voice.page.field.permissionAuthorized');
            case 'not-determined': return t('settings.voice.page.field.permissionNotDetermined');
            case 'notDetermined': return t('settings.voice.page.field.permissionNotDetermined');
            case 'denied': return t('settings.voice.page.field.permissionDenied');
            case 'restricted': return t('settings.voice.page.field.permissionRestricted');
            default: return t('settings.voice.page.field.permissionUnknown');
        }
    }, [t]);
    const handleRequestMacosAccess = useCallback(async () => {
        await nativeMacosSpeechService.prepareListeningDetailed();
        await refreshMacosMicrophoneStatus();
        await refreshMacosCapability();
        await loadMacosInputDevices();
    }, [loadMacosInputDevices, refreshMacosCapability, refreshMacosMicrophoneStatus]);
    const handleOpenMacosSettings = useCallback((target: 'microphone' | 'speech') => {
        void nativeMacosSpeechService.openPrivacySettings(target);
    }, []);
    const handleLoadWasmModel = useCallback(async () => {
        try {
            await wasmSttService.loadModel(wasmSttModel);
        } catch {
            // The service publishes its actionable error through wasmModelStatus.
        }
    }, [wasmSttModel]);
    const macosSpeechPermissionMessage = useMemo(() => {
        if (sttProvider !== 'macos' || !macosSpeechCapability) return null;
        if (macosSpeechCapability.speechAuthorization === 'denied' || macosSpeechCapability.speechAuthorization === 'restricted') {
            return t('settings.voice.page.field.macosSpeechPermissionDenied');
        }
        if (macosAppMicrophoneStatus === 'denied' || macosAppMicrophoneStatus === 'restricted') {
            return t('settings.voice.page.field.macosMicrophonePermissionDenied');
        }
        if (!macosSpeechCapability.available) {
            return t('settings.voice.page.field.macosSpeechUnavailable');
        }
        return null;
    }, [macosAppMicrophoneStatus, macosSpeechCapability, sttProvider, t]);
    const isSelectedWasmModelReady = wasmModelStatus.state === 'ready'
        && wasmSttService.getCurrentModelId() === wasmSttModel;
    const isWasmModelBusy = wasmModelStatus.state === 'downloading' || wasmModelStatus.state === 'loading';
    const wasmModelStatusText = isSelectedWasmModelReady
        ? t('settings.voice.page.stt.wasmLoaded')
        : wasmModelStatus.state === 'downloading'
            ? `${t('settings.voice.page.stt.wasmDownloading')} ${Math.round(wasmModelStatus.progress)}%`
            : wasmModelStatus.state === 'loading'
                ? t('settings.voice.page.stt.wasmLoading')
                : wasmModelStatus.state === 'error'
                    ? wasmModelStatus.error
                    : t('settings.voice.page.stt.wasmNotLoaded');

    useEffect(() => {
        if (!macosSpeechCapability) return;
        const normalizedProvider = normalizeVoiceInputProvider(sttProvider, isMacosSpeechAvailable, isLocalSpeechAvailable);
        if (normalizedProvider !== sttProvider) {
            setSttProvider(normalizedProvider);
        }
    }, [isLocalSpeechAvailable, isMacosSpeechAvailable, macosSpeechCapability, setSttProvider, sttProvider]);

    useEffect(() => {
        if (!voiceInputDeviceId) return;
        if (sttProvider === 'macos' && macosInputDevices.length > 0 && !selectedMacosInputDeviceId) {
            setVoiceInputDeviceId('');
        }
        if ((sttProvider === 'server' || sttProvider === 'wasm') && inputDevices.length > 0 && !selectedBrowserInputDeviceId) {
            setVoiceInputDeviceId('');
        }
    }, [inputDevices.length, macosInputDevices.length, selectedBrowserInputDeviceId, selectedMacosInputDeviceId, setVoiceInputDeviceId, sttProvider, voiceInputDeviceId]);

    return (
        <div className="space-y-8">
            <div className="mb-8">
                <div className="mb-1 px-1">
                    <h3 className="typography-ui-header font-medium text-foreground">
                        {t('settings.voice.page.section.voiceInput')}
                    </h3>
                </div>

                <section className="px-2 pb-2 pt-0 space-y-0">
                    <div
                        className="group flex cursor-pointer items-center gap-2 py-1.5"
                        role="button"
                        tabIndex={0}
                        aria-pressed={voiceModeEnabled}
                        onClick={() => setVoiceModeEnabled(!voiceModeEnabled)}
                        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setVoiceModeEnabled(!voiceModeEnabled); } }}
                    >
                        <Checkbox checked={voiceModeEnabled} onChange={setVoiceModeEnabled} ariaLabel={t('settings.voice.page.field.enableVoiceModeAria')} />
                        <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.enableVoiceMode')}</span>
                    </div>

                    {voiceModeEnabled && (
                        <>
                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.inputSource')}</span>
                                <div className="flex min-w-0 flex-col gap-1">
                                    {inputSourceMode === 'native-device' ? (
                                        <>
                                            <Select value={selectedMacosInputDeviceId || '__default__'} onValueChange={(value) => setVoiceInputDeviceId(value === '__default__' ? '' : value)}>
                                                <SelectTrigger className="w-fit max-w-[260px]">
                                                    <SelectValue placeholder={t('settings.voice.page.field.inputSourceDefault')}>
                                                        {(value) => {
                                                            if (!value || value === '__default__') return t('settings.voice.page.field.inputSourceDefault');
                                                            return macosInputDevices.find((device) => device.id === value)?.name ?? t('settings.voice.page.field.inputSourceDefault');
                                                        }}
                                                    </SelectValue>
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="__default__">{t('settings.voice.page.field.inputSourceDefault')}</SelectItem>
                                                    {macosInputDevices.map((device, index) => (
                                                        <SelectItem key={device.id || `macos-input-${index}`} value={device.id}>
                                                            {device.name || t('settings.voice.page.field.inputSourceUnnamed', { index: String(index + 1) })}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <p className="typography-meta text-muted-foreground">{macosInputDevices.length > 0 ? t('settings.voice.page.field.inputSourceMacosHint') : t('settings.voice.page.field.inputSourceNoDevices')}</p>
                                        </>
                                    ) : inputSourceMode === 'media-device' ? (
                                        <Select value={selectedBrowserInputDeviceId || '__default__'} onValueChange={(value) => setVoiceInputDeviceId(value === '__default__' ? '' : value)}>
                                            <SelectTrigger className="w-fit max-w-[260px]">
                                                <SelectValue placeholder={t('settings.voice.page.field.inputSourceDefault')}>
                                                    {(value) => {
                                                        if (!value || value === '__default__') return t('settings.voice.page.field.inputSourceDefault');
                                                        return inputDevices.find((device) => device.deviceId === value)?.label ?? t('settings.voice.page.field.inputSourceDefault');
                                                    }}
                                                </SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="__default__">{t('settings.voice.page.field.inputSourceDefault')}</SelectItem>
                                                {inputDevices.map((device, index) => (
                                                    <SelectItem key={device.deviceId || `input-${index}`} value={device.deviceId}>
                                                        {device.label || t('settings.voice.page.field.inputSourceUnnamed', { index: String(index + 1) })}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    ) : (
                                        <>
                                            <Select value="__default__" onValueChange={() => {}} disabled>
                                                <SelectTrigger className="w-fit max-w-[260px]">
                                                    <SelectValue placeholder={t('settings.voice.page.field.inputSourceDefault')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="__default__">{t('settings.voice.page.field.inputSourceDefault')}</SelectItem>
                                                </SelectContent>
                                            </Select>
                                            <p className="typography-meta text-muted-foreground">{t('settings.voice.page.field.inputSourceBrowserHint')}</p>
                                        </>
                                    )}
                                </div>
                            </div>

                            <div className="pb-1.5 pt-0.5">
                                <div className="flex min-w-0 flex-col gap-1.5">
                                    <div className="flex items-center gap-1.5">
                                        <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.inputProvider')}</span>
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <button type="button" className="rounded-sm text-muted-foreground/60 hover:text-foreground focus:outline-none focus:ring-1 focus:ring-[var(--interactive-focus-ring)]" aria-label={t('settings.voice.page.field.inputProviderInfoAria')}>
                                                    <RiInformationLine className="h-3.5 w-3.5" />
                                                </button>
                                            </TooltipTrigger>
                                            <TooltipContent sideOffset={8} className="max-w-xs">
                                                <ul className="space-y-1">
                                                    {selectableVoiceInputProviders.includes('macos') && <li><strong>{t('settings.voice.page.provider.macos')}</strong> {t('settings.voice.page.tooltip.sttMacos')}</li>}
                                                    {selectableVoiceInputProviders.includes('browser') && <li><strong>{t('settings.voice.page.provider.browser')}</strong> {t('settings.voice.page.tooltip.sttBrowser')}</li>}
                                                    {selectableVoiceInputProviders.includes('wasm') && <li><strong>{t('settings.voice.page.provider.wasm')}</strong> {t('settings.voice.page.tooltip.sttWasm')}</li>}
                                                    {selectableVoiceInputProviders.includes('server') && <li><strong>{t('settings.voice.page.provider.server')}</strong> {t('settings.voice.page.tooltip.sttServer')}</li>}
                                                </ul>
                                            </TooltipContent>
                                        </Tooltip>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-1">
                                        {selectableVoiceInputProviders.map((provider) => {
                                            const labelKey = `settings.voice.page.provider.${provider}` as const;
                                            return (
                                                <Button key={provider} variant="chip" size="xs" aria-pressed={sttProvider === provider} onClick={() => setSttProvider(provider)} className="!font-normal">
                                                    {provider === 'macos' && <RiAppleLine className="w-3.5 h-3.5 mr-0.5" />}
                                                    {t(labelKey)}
                                                </Button>
                                            );
                                        })}
                                    </div>
                                    {sttProvider === 'macos' && macosSpeechCapability && (
                                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 typography-meta text-muted-foreground">
                                            <span className="text-foreground">{t('settings.voice.page.field.macosPermissionStatus')}</span>
                                            <span>{t('settings.voice.page.field.macosAppMicrophoneStatus', { status: formatPermissionStatus(macosAppMicrophoneStatus) })}</span>
                                            <span>{t('settings.voice.page.field.macosSpeechStatus', { status: formatPermissionStatus(macosSpeechCapability.speechAuthorization) })}</span>
                                            {hasUndeterminedMacosPermission && (
                                                <Button variant="outline" size="xs" onClick={handleRequestMacosAccess} className="!font-normal">
                                                    {t('settings.voice.page.actions.requestMacosAccess')}
                                                </Button>
                                            )}
                                            {(macosAppMicrophoneStatus === 'denied' || macosAppMicrophoneStatus === 'restricted') && (
                                                <Button variant="outline" size="xs" onClick={() => handleOpenMacosSettings('microphone')} className="!font-normal">
                                                    {t('settings.voice.page.actions.openMacosMicrophoneSettings')}
                                                </Button>
                                            )}
                                            {(macosSpeechCapability.speechAuthorization === 'denied' || macosSpeechCapability.speechAuthorization === 'restricted') && (
                                                <Button variant="outline" size="xs" onClick={() => handleOpenMacosSettings('speech')} className="!font-normal">
                                                    {t('settings.voice.page.actions.openMacosSpeechSettings')}
                                                </Button>
                                            )}
                                        </div>
                                    )}
                                    {macosSpeechPermissionMessage && <p className="typography-meta text-[var(--status-warning)]">{macosSpeechPermissionMessage}</p>}
                                </div>
                            </div>

                            {sttProvider === 'browser' && (
                                <div className="flex items-center gap-8 py-1.5">
                                    <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.browserLanguage')}</span>
                                    <div className="flex items-center gap-2 w-fit">
                                        <Select value={browserLanguage} onValueChange={setBrowserLanguage} disabled={!isSupported}>
                                            <SelectTrigger className="w-fit">
                                                <SelectValue placeholder={t('settings.voice.page.field.selectLanguagePlaceholder')} />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {LANGUAGE_OPTIONS.map((lang) => (
                                                    <SelectItem key={lang.value} value={lang.value}>{lang.label}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>
                            )}

                            {sttProvider === 'wasm' && (
                                <div className="py-1.5 space-y-2">
                                    <p className="typography-meta text-muted-foreground">
                                        {t('settings.voice.page.stt.wasmPrivacyHint')}
                                    </p>
                                    <div className="flex flex-wrap items-end gap-2">
                                        <div>
                                            <span className="typography-ui-label text-foreground">{t('settings.voice.page.stt.wasmModel')}</span>
                                            <Select value={wasmSttModel} onValueChange={setWasmSttModel} disabled={isWasmModelBusy}>
                                                <SelectTrigger className="mt-1.5 w-fit max-w-[320px]">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {WASM_MODELS.map((model) => (
                                                        <SelectItem key={model.id} value={model.id}>
                                                            {model.name} · {model.size} · {model.languages}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <Button
                                            variant="outline"
                                            size="xs"
                                            disabled={isWasmModelBusy || isSelectedWasmModelReady}
                                            onClick={() => void handleLoadWasmModel()}
                                            className="!font-normal"
                                        >
                                            {wasmModelStatus.state === 'error'
                                                ? t('settings.voice.page.stt.wasmRetry')
                                                : t('settings.voice.page.stt.wasmDownload')}
                                        </Button>
                                    </div>
                                    <p className={cn(
                                        'typography-meta',
                                        wasmModelStatus.state === 'error' ? 'text-[var(--status-error)]' : 'text-muted-foreground',
                                    )}>
                                        {wasmModelStatusText}
                                    </p>
                                    <p className="typography-meta text-muted-foreground">
                                        {WASM_MODELS.find((model) => model.id === wasmSttModel)?.description}
                                    </p>
                                    <div className="flex items-center gap-8 py-0.5">
                                        <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.language')}</span>
                                        <div className="relative max-w-[8rem]">
                                            <input type="text" value={sttLanguage} onChange={(e) => setSttLanguage(e.target.value)} placeholder="auto" className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70" />
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-8 py-0.5">
                                        <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.silenceThreshold')}</span>
                                        <div className="flex items-center gap-2 w-fit">
                                            {!isMobile && <input type="range" min={-60} max={-20} step={1} value={sttSilenceThresholdDb} onChange={(e) => setSttSilenceThresholdDb(Number(e.target.value))} className={sliderClass} />}
                                            <span className="typography-ui-label text-foreground tabular-nums min-w-[3.5rem] text-right">{sttSilenceThresholdDb} dB</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-8 py-0.5">
                                        <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.silenceHold')}</span>
                                        <div className="flex items-center gap-2 w-fit">
                                            {!isMobile && <input type="range" min={500} max={3000} step={100} value={sttSilenceHoldMs} onChange={(e) => setSttSilenceHoldMs(Number(e.target.value))} className={sliderClass} />}
                                            <NumberInput value={sttSilenceHoldMs} onValueChange={setSttSilenceHoldMs} min={500} max={3000} step={100} className="w-20 tabular-nums" />
                                            <span className="typography-meta text-muted-foreground">{t('settings.voice.page.field.millisecondsUnit')}</span>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {sttProvider === 'server' && (
                                <div className="py-1.5 space-y-2">
                                    {!audioStreamService.isSupported() && (
                                        <p className="typography-meta text-[var(--status-error)]">
                                            {t('settings.voice.page.field.sttBrowserSupportError')}
                                        </p>
                                    )}
                                    <div>
                                        <span className={cn("typography-ui-label text-foreground", !sttServerUrl.trim() && "text-[var(--status-error)]")}>{t('settings.voice.page.field.serverUrl')}</span>
                                        <span className="typography-meta ml-2 text-muted-foreground">{t('settings.voice.page.field.sttServerUrlHint')}</span>
                                        <div className="relative mt-1.5 max-w-xs">
                                            <input type="text" value={sttServerUrl} onChange={(e) => setSttServerUrl(e.target.value)} placeholder="http://localhost:8001/v1" className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70" />
                                            {sttServerUrl && (
                                                <button type="button" onClick={() => setSttServerUrl('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                                    <RiCloseLine className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <div>
                                        <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.model')}</span>
                                        <div className="relative mt-1.5 max-w-xs">
                                            <input type="text" value={sttModel} onChange={(e) => setSttModel(e.target.value)} placeholder="deepdml/faster-whisper-large-v3-turbo-ct2" className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70" />
                                        </div>
                                    </div>
                                    <div>
                                        <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.language')}</span>
                                        <span className="typography-meta ml-2 text-muted-foreground">{t('settings.voice.page.field.sttLanguageHint')}</span>
                                        <div className="relative mt-1.5 max-w-[8rem]">
                                            <input type="text" value={sttLanguage} onChange={(e) => setSttLanguage(e.target.value)} placeholder="auto" className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70" />
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-8 py-0.5">
                                        <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.silenceThreshold')}</span>
                                        <div className="flex items-center gap-2 w-fit">
                                            {!isMobile && <input type="range" min={-60} max={-20} step={1} value={sttSilenceThresholdDb} onChange={(e) => setSttSilenceThresholdDb(Number(e.target.value))} className={sliderClass} />}
                                            <span className="typography-ui-label text-foreground tabular-nums min-w-[3.5rem] text-right">{sttSilenceThresholdDb} dB</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-8 py-0.5">
                                        <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.silenceHold')}</span>
                                        <div className="flex items-center gap-2 w-fit">
                                            {!isMobile && <input type="range" min={500} max={3000} step={100} value={sttSilenceHoldMs} onChange={(e) => setSttSilenceHoldMs(Number(e.target.value))} className={sliderClass} />}
                                            <NumberInput value={sttSilenceHoldMs} onValueChange={setSttSilenceHoldMs} min={500} max={3000} step={100} className="w-20 tabular-nums" />
                                            <span className="typography-meta text-muted-foreground">{t('settings.voice.page.field.millisecondsUnit')}</span>
                                        </div>
                                    </div>
                                </div>
                            )}

                        </>
                    )}
                </section>

            </div>

            <div className="mb-8">
                <div className="mb-1 px-1">
                    <h3 className="typography-ui-header font-medium text-foreground">
                        {t('settings.voice.page.section.voicePlayback')}
                    </h3>
                </div>

                <section className="px-2 pb-2 pt-0 space-y-0">
                    <div className="group flex cursor-pointer items-center gap-2 py-1.5" role="button" tabIndex={0} aria-pressed={voicePlaybackEnabled} onClick={() => setVoicePlaybackEnabled(!voicePlaybackEnabled)} onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setVoicePlaybackEnabled(!voicePlaybackEnabled); } }}>
                        <Checkbox checked={voicePlaybackEnabled} onChange={setVoicePlaybackEnabled} ariaLabel={t('settings.voice.page.field.voicePlaybackAria')} />
                        <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.voicePlayback')}</span>
                    </div>

                    {voicePlaybackEnabled && (
                        <>
                            <div className="pb-1.5 pt-0.5">
                                <div className="flex min-w-0 flex-col gap-1.5">
                                    <div className="flex items-center gap-1.5">
                                        <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.playbackProvider')}</span>
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <button type="button" className="rounded-sm text-muted-foreground/60 hover:text-foreground focus:outline-none focus:ring-1 focus:ring-[var(--interactive-focus-ring)]" aria-label={t('settings.voice.page.field.playbackProviderInfoAria')}>
                                                    <RiInformationLine className="h-3.5 w-3.5" />
                                                </button>
                                            </TooltipTrigger>
                                            <TooltipContent sideOffset={8} className="max-w-xs">
                                                <ul className="space-y-1">
                                                    <li><strong>{t('settings.voice.page.provider.browser')}</strong> {t('settings.voice.page.tooltip.browser')}</li>
                                                    <li><strong>{t('settings.voice.page.provider.say')}</strong> {t('settings.voice.page.tooltip.say')}</li>
                                                </ul>
                                            </TooltipContent>
                                        </Tooltip>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-1">
                                        <Button variant="chip" size="xs" aria-pressed={visibleVoiceProvider === 'browser'} onClick={() => setVoiceProvider('browser')} className="!font-normal">
                                            {t('settings.voice.page.provider.browser')}
                                        </Button>
                                        {isSayAvailable && (
                                            <Button variant="chip" size="xs" aria-pressed={visibleVoiceProvider === 'say'} onClick={() => setVoiceProvider('say')} className="!font-normal">
                                                <RiAppleLine className="w-3.5 h-3.5 mr-0.5" />
                                                {t('settings.voice.page.provider.say')}
                                            </Button>
                                        )}
                                    </div>
                                    {!isSayAvailable && <p className="typography-meta text-muted-foreground/70">{t('settings.voice.page.field.macosUnavailable')}</p>}
                                </div>
                            </div>

                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.voice')}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {visibleVoiceProvider === 'say' && isSayAvailable && sayVoices.length > 0 && (
                                        <>
                                            <Select value={sayVoice} onValueChange={setSayVoice}>
                                                <SelectTrigger className="w-fit">
                                                    <SelectValue placeholder={t('settings.voice.page.field.selectVoicePlaceholder')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {sayVoices.map((v) => <SelectItem key={v.name} value={v.name}>{v.name}</SelectItem>)}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewVoice} title={t('settings.voice.page.actions.preview')}>
                                                {isPreviewPlaying ? <RiStopLine className="w-3.5 h-3.5" /> : <RiPlayLine className="w-3.5 h-3.5" />}
                                            </Button>
                                        </>
                                    )}

                                    {visibleVoiceProvider === 'browser' && filteredBrowserVoices.length > 0 && (
                                        <>
                                            <Select value={browserVoice || '__auto__'} onValueChange={(value) => setBrowserVoice(value === '__auto__' ? '' : value)}>
                                                <SelectTrigger className="w-fit max-w-[200px]">
                                                    <SelectValue placeholder={t('settings.voice.page.field.auto')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="__auto__">{t('settings.voice.page.field.auto')}</SelectItem>
                                                    {filteredBrowserVoices.map((v) => <SelectItem key={v.name} value={v.name}>{v.name} ({v.lang})</SelectItem>)}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewBrowserVoice} title={t('settings.voice.page.actions.preview')}>
                                                {isBrowserPreviewPlaying ? <RiStopLine className="w-3.5 h-3.5" /> : <RiPlayLine className="w-3.5 h-3.5" />}
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </div>

                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.speechRate')}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {!isMobile && <input type="range" min={0.5} max={2} step={0.1} value={speechRate} onChange={(e) => setSpeechRate(Number(e.target.value))} className={sliderClass} />}
                                    <NumberInput value={speechRate} onValueChange={setSpeechRate} min={0.5} max={2} step={0.1} className="w-16 tabular-nums" />
                                </div>
                            </div>

                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.speechPitch')}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {!isMobile && <input type="range" min={0.5} max={2} step={0.1} value={speechPitch} onChange={(e) => setSpeechPitch(Number(e.target.value))} className={sliderClass} />}
                                    <NumberInput value={speechPitch} onValueChange={setSpeechPitch} min={0.5} max={2} step={0.1} className="w-16 tabular-nums" />
                                </div>
                            </div>

                            <div className="flex items-center gap-8 py-1.5">
                                <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.speechVolume')}</span>
                                <div className="flex items-center gap-2 w-fit">
                                    {!isMobile && <input type="range" min={0} max={1} step={0.1} value={speechVolume} onChange={(e) => setSpeechVolume(Number(e.target.value))} className={sliderClass} />}
                                    {isMobile ? (
                                        <NumberInput value={Math.round(speechVolume * 100)} onValueChange={(v) => setSpeechVolume(v / 100)} min={0} max={100} step={10} className="w-16 tabular-nums" />
                                    ) : (
                                        <span className="typography-ui-label text-foreground tabular-nums min-w-[3rem] text-right">{Math.round(speechVolume * 100)}%</span>
                                    )}
                                </div>
                            </div>

                            <div className="group flex cursor-pointer items-center gap-2 py-1.5" role="button" tabIndex={0} aria-pressed={showMessageTTSButtons} onClick={() => setShowMessageTTSButtons(!showMessageTTSButtons)} onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setShowMessageTTSButtons(!showMessageTTSButtons); } }}>
                                <Checkbox checked={showMessageTTSButtons} onChange={setShowMessageTTSButtons} ariaLabel={t('settings.voice.page.field.messageReadAloudButtonAria')} />
                                <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.messageReadAloudButton')}</span>
                            </div>

                            <div className="group flex cursor-pointer items-center gap-2 py-1.5" role="button" tabIndex={0} aria-pressed={summarizeMessageTTS} onClick={() => setSummarizeMessageTTS(!summarizeMessageTTS)} onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setSummarizeMessageTTS(!summarizeMessageTTS); } }}>
                                <Checkbox checked={summarizeMessageTTS} onChange={setSummarizeMessageTTS} ariaLabel={t('settings.voice.page.field.summarizeBeforePlaybackAria')} />
                                <span className="typography-ui-label text-foreground">{t('settings.voice.page.field.summarizeBeforePlayback')}</span>
                            </div>

                            {summarizeMessageTTS && (
                                <>
                                    <div className="flex items-center gap-8 py-1.5">
                                        <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.summarizationThreshold')}</span>
                                        <div className="flex items-center gap-2 w-fit">
                                            {!isMobile && <input type="range" min={50} max={2000} step={50} value={summarizeCharacterThreshold} onChange={(e) => setSummarizeCharacterThreshold(Number(e.target.value))} className={sliderClass} />}
                                            <NumberInput value={summarizeCharacterThreshold} onValueChange={setSummarizeCharacterThreshold} min={50} max={2000} step={50} className="w-16 tabular-nums" />
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-8 py-1.5">
                                        <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.summaryMaxLength')}</span>
                                        <div className="flex items-center gap-2 w-fit">
                                            {!isMobile && <input type="range" min={50} max={2000} step={50} value={summarizeMaxLength} onChange={(e) => setSummarizeMaxLength(Number(e.target.value))} className={sliderClass} />}
                                            <NumberInput value={summarizeMaxLength} onValueChange={setSummarizeMaxLength} min={50} max={2000} step={50} className="w-16 tabular-nums" />
                                        </div>
                                    </div>
                                </>
                            )}
                        </>
                    )}
                </section>
            </div>
        </div>
    );
};
