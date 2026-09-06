/**
 * BrowserVoiceButton Component
 *
 * Voice input toggle button.
 * Shows visual state indicators for different voice modes.
 *
 * @example
 * ```tsx
 * <BrowserVoiceButton />
 * ```
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { isRecoverableVoiceSilenceError, useBrowserVoice } from '@/hooks/useBrowserVoice';
import { useConfigStore } from '@/stores/useConfigStore';
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { Button } from '@/components/ui/button';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import {
    RiMicLine,
    RiStopCircleLine,
    RiVolumeUpLine,
} from '@remixicon/react';
import { VoiceStatusIndicator } from './VoiceStatusIndicator';
import { toast } from '@/components/ui/toast';

// Status text for accessibility and labels
const statusLabels: Record<string, string> = {
    idle: 'Start Voice',
    listening: 'Listening',
    processing: 'Processing',
    speaking: 'AI Speaking',
    error: 'Voice Error',
};

const normalizeVoiceErrorMessage = (error: string): string => {
    const isMediaDevicesError =
        error.includes('getUserMedia') ||
        error.includes('mediaDevices') ||
        error.includes('Cannot read properties of undefined');

    if (!isMediaDevicesError) {
        return error;
    }

    if (typeof window !== 'undefined' && !window.isSecureContext) {
        return 'Voice requires a secure connection (HTTPS) or localhost. Please use HTTPS or access via localhost.';
    }

    return 'Microphone access is unavailable in this runtime. On desktop, check System Settings -> Privacy & Security -> Microphone for DevRyan.';
};

/**
 * Voice input button
 */
export function BrowserVoiceButton() {
    const voiceModeEnabled = useConfigStore((s) => s.voiceModeEnabled);

    const {
        status,
        isSupported,
        error,

        startVoice,
        stopVoice,
        isMobile,
        audioLevel,
        localModelStatus,
        localRecovery,
        recoverWithLocal,
    } = useBrowserVoice();

    const [isPressing, setIsPressing] = useState(false);

    const buttonSizeClass = isMobile ? 'h-8 w-8 min-h-[32px] min-w-[32px]' : ('h-6 w-6');
    const iconSizeClass = isMobile ? 'h-[18px] w-[18px]' : ('h-[18px] w-[18px]');
    const activeStopIconSizeClass = isMobile ? 'h-[19px] w-[19px]' : ('h-[19px] w-[19px]');
    const clearHoverBackgroundClass = 'bg-transparent hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent';

    // Refs for touch handling
    const touchHandledRef = useRef(false);
    const lastToastedErrorRef = useRef<string | null>(null);
    const localRecoveryToastIdRef = useRef<string | number | null>(null);

    // NOTE: Do NOT pre-request microphone permission on mount.
    // Permission is requested when the user explicitly taps the mic button.
    // Pre-requesting causes an unwanted permission prompt on mobile page load.

    // Determine active states
    const isActive = status === 'listening' || status === 'speaking' || status === 'processing';
    const isError = status === 'error';

    const isSpeaking = status === 'speaking';
    const localStatusLabel = status === 'processing'
        ? localModelStatus.state === 'downloading'
            ? `Downloading local voice (${Math.round(localModelStatus.progress)}%)`
            : localModelStatus.state === 'loading'
                ? 'Loading local voice'
                : undefined
        : undefined;

    // Show toast notification when voice error occurs
    useEffect(() => {
        if (localRecovery) {
            const recoveryKey = `local:${localRecovery.reason}:${localRecovery.modelId}`;
            if (lastToastedErrorRef.current === recoveryKey) {
                return;
            }

            lastToastedErrorRef.current = recoveryKey;
            localRecoveryToastIdRef.current = toast.warning('Browser speech service unavailable', {
                description: `Use ${localRecovery.modelName} locally? This requires a one-time ${localRecovery.modelSize} download. Your recorded audio stays on this device.`,
                duration: Infinity,
                action: {
                    label: 'Use Local',
                    onClick: () => {
                        void recoverWithLocal();
                    },
                },
            });
            return;
        }

        if (localRecoveryToastIdRef.current !== null) {
            toast.dismiss(localRecoveryToastIdRef.current);
            localRecoveryToastIdRef.current = null;
        }

        if (isError && error) {
            if (isRecoverableVoiceSilenceError(error)) {
                return;
            }
            if (lastToastedErrorRef.current === error) {
                return;
            }
            lastToastedErrorRef.current = error;
            const displayError = normalizeVoiceErrorMessage(error);

            toast.error(displayError, {
                duration: 5000,
            });
        }

        if (!isError) {
            lastToastedErrorRef.current = null;
        }
    }, [isError, error, localRecovery, recoverWithLocal]);

    useEffect(() => () => {
        if (localRecoveryToastIdRef.current !== null) {
            toast.dismiss(localRecoveryToastIdRef.current);
        }
    }, []);

    // Status text for accessibility
    const statusText = isError
        ? error || 'Voice Error'
        : (localStatusLabel ?? statusLabels[status]) || 'Start Voice';

    // Tooltip content based on state
    const getTooltipContent = () => {
        if (isError && error) {
            return normalizeVoiceErrorMessage(error);
        }
        if (isActive) {
            return 'Stop voice conversation';
        }
        if (isMobile) {
            return 'Start voice conversation';
        }
        return 'Start voice conversation';
    };

    // Handle voice activation (used by both click and touch)
    const activateVoice = useCallback(async () => {
        if (isActive) {
            stopVoice();
        } else if (status !== 'error') {
            // On mobile, we must NOT do any async operations before calling startVoice()
            // because iOS Safari requires SpeechRecognition.start() to be called
            // synchronously within the user gesture handler
            if (isMobile) {
                // Start voice immediately - no await before this!
                // Audio unlock is now handled inside startVoice() for mobile
                startVoice();
            } else {
                // Desktop can use async path
                try {
                    await startVoice();
                } catch (err) {
                    console.error('Failed to start voice:', err);
                }
            }
        } else {
            // Reset from error state
            if (isMobile) {
                startVoice();
            } else {
                try {
                    await startVoice();
                } catch (err) {
                    console.error('Failed to start voice:', err);
                }
            }
        }
    }, [isActive, status, startVoice, stopVoice, isMobile]);

    const handleClick = useCallback(async () => {
        // Prevent double-firing if touch already handled this
        if (touchHandledRef.current) {
            touchHandledRef.current = false;
            return;
        }

        await activateVoice();
    }, [activateVoice]);

    const handleMouseDown = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        // Keep focus in the composer so voice input feels like it is typing there.
        event.preventDefault();
    }, []);

    // Handle touch start for mobile devices
    const handleTouchStart = useCallback((e: React.TouchEvent) => {
        // Prevent default to stop mouse event emulation
        e.preventDefault();

        // Mark that touch handled this interaction
        touchHandledRef.current = true;
        // Immediate visual feedback
        setIsPressing(true);
    }, []);

    // Handle touch end
    const handleTouchEnd = useCallback(() => {
        activateVoice();

        setIsPressing(false);
    }, [activateVoice]);

    // Handle touch cancel
    const handleTouchCancel = useCallback(() => {
        setIsPressing(false);
    }, []);

    // If voice mode is disabled, don't render anything
    if (!voiceModeEnabled) {
        return null;
    }

    // If not supported, show disabled button with tooltip
    if (!isSupported) {
        const supportDetails = browserVoiceService.getSupportDetails();
        const tooltipMessage = !supportDetails.secureContext
            ? 'Voice requires HTTPS or localhost. Please use a secure connection.'
            : !supportDetails.recognition
                ? 'Speech recognition not supported in this browser. Try Chrome, Edge, or Safari.'
                : !supportDetails.synthesis
                    ? 'Speech synthesis not supported in this browser.'
                    : 'Voice not supported in this browser';

        return (
            <TooltipProvider>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            disabled
                            aria-label={tooltipMessage}
                            className={`${buttonSizeClass} p-0 ${clearHoverBackgroundClass}`}
                        >
                            <RiMicLine className={`${iconSizeClass} opacity-50`} />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="center">
                        <p className="max-w-[200px] text-center">{tooltipMessage}</p>
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
        );
    }

    return (
        <div className={`flex items-center ${isMobile ? 'gap-1' : 'gap-1.5'}`}>
            {/* Status indicator with label - show when active, simplified on mobile */}
            {isActive && !isMobile && (
                <VoiceStatusIndicator
                    status={status}
                    showLabel
                    size="sm"
                    audioLevel={audioLevel}
                    statusLabel={localStatusLabel}
                    className="mr-1"
                />
            )}

            {/* Voice button with tooltip */}
            <TooltipProvider>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={handleClick}
                            onMouseDown={handleMouseDown}
                            onTouchStart={handleTouchStart}
                            onTouchEnd={handleTouchEnd}
                            onTouchCancel={handleTouchCancel}
                            aria-label={statusText}
                            className={`
                                relative
                                ${buttonSizeClass}
                                p-0
                                ${clearHoverBackgroundClass}
                                touch-manipulation
                                ${isPressing ? 'scale-95 opacity-80' : ''}
                            `}
                            style={{
                                WebkitTapHighlightColor: 'transparent',
                                touchAction: 'manipulation',
                            }}
                        >
                            {isActive ? (
                                isSpeaking ? (
                                    // Green speaker icon when AI is speaking
                                    <RiVolumeUpLine className={`${iconSizeClass} text-green-400 animate-pulse`} />
                                ) : (
                                    // Red stop icon for listening/processing (both mobile and desktop)
                                    <RiStopCircleLine className={`${activeStopIconSizeClass} text-[var(--status-error)]`} />
                                )
                            ) : (
                                <VoiceStatusIndicator
                                    status={isError ? 'idle' : status}
                                    size={isMobile ? 'sm' : 'md'}
                                    audioLevel={audioLevel}
                                />
                            )}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="center">
                        <p className="max-w-[200px] text-center">{getTooltipContent()}</p>
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
        </div>
    );
}
