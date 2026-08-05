/**
 * VoiceStatusIndicator Component
 *
 * Reusable visual indicator for voice mode states with icons, animations,
 * and optional status text labels.
 *
 * @example
 * ```tsx
 * // Basic usage - icon only
 * <VoiceStatusIndicator status="listening" />
 *
 * // With label
 * <VoiceStatusIndicator status="listening" showLabel />
 *
 * // Different size
 * <VoiceStatusIndicator status="processing" size="lg" />
 * ```
 */

import {
    RiMicLine,
    RiLoader4Line,
    RiVolumeUpLine,
    RiAlertLine,
} from '@remixicon/react';
import type { BrowserVoiceStatus } from '@/hooks/useBrowserVoice';
import { useI18n } from '@/lib/i18n';

export interface VoiceStatusIndicatorProps {
    /** Current voice status */
    status: BrowserVoiceStatus;
    /** Show text label next to icon */
    showLabel?: boolean;
    /** Size of the indicator */
    size?: 'sm' | 'md' | 'lg';
    /** Optional className for styling */
    className?: string;
    /** Optional normalized microphone level for waveform rendering */
    audioLevel?: number | null;
    /** Optional status label override, for example local-model download progress */
    statusLabel?: string;
}

const sizeClasses = {
    sm: {
        icon: 'w-4 h-4',
        container: 'gap-1.5',
    },
    md: {
        icon: 'w-5 h-5',
        container: 'gap-2',
    },
    lg: {
        icon: 'w-6 h-6',
        container: 'gap-2.5',
    },
};

const statusConfig: Record<
    BrowserVoiceStatus,
    {
        icon: typeof RiMicLine;
        color: string;
        labelKey:
          | 'voice.status.idle'
          | 'voice.status.listening'
          | 'voice.status.processing'
          | 'voice.status.speaking'
          | 'voice.status.error';
        animation?: string;
    }
> = {
    idle: {
        icon: RiMicLine,
        color: 'text-muted-foreground',
        labelKey: 'voice.status.idle',
    },
    listening: {
        icon: RiMicLine,
        color: 'text-primary',
        labelKey: 'voice.status.listening',
        animation: 'animate-pulse',
    },
    processing: {
        icon: RiLoader4Line,
        color: 'text-primary',
        labelKey: 'voice.status.processing',
        animation: 'animate-spin',
    },
    speaking: {
        icon: RiVolumeUpLine,
        color: 'text-[var(--status-success)]',
        labelKey: 'voice.status.speaking',
    },
    error: {
        icon: RiAlertLine,
        color: 'text-[var(--status-error)]',
        labelKey: 'voice.status.error',
    },
};

function VoiceWaveform({ level = null, size }: { level?: number | null; size: 'sm' | 'md' | 'lg' }) {
    const bars = size === 'lg' ? 7 : 5;
    const heightClass = size === 'lg' ? 'h-6' : size === 'md' ? 'h-5' : 'h-4';
    const widthClass = size === 'lg' ? 'w-8' : size === 'md' ? 'w-7' : 'w-6';
    const normalized = typeof level === 'number' && Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : null;
    const activeLevel = normalized !== null && normalized > 0.04 ? normalized : 0;

    return (
        <div
            className={`flex ${heightClass} ${widthClass} items-center justify-center gap-[2px]`}
            aria-hidden="true"
        >
            {Array.from({ length: bars }).map((_, index) => {
                const distanceFromCenter = Math.abs(index - (bars - 1) / 2);
                const weight = 1 - distanceFromCenter / bars;
                const scale = activeLevel === 0
                    ? 0.14
                    : 0.2 + Math.min(1, activeLevel * (0.9 + weight * 0.8)) * 0.8;

                return (
                    <span
                        key={index}
                        className="w-[2px] rounded-full bg-[var(--primary-base)] transition-transform duration-75 ease-out"
                        style={{
                            height: '100%',
                            transform: `scaleY(${scale})`,
                            transformOrigin: 'center',
                            opacity: activeLevel === 0 ? 0.45 : 0.45 + activeLevel * 0.55,
                        }}
                    />
                );
            })}
        </div>
    );
}

/**
 * VoiceStatusIndicator - Visual indicator for voice mode states
 */
export function VoiceStatusIndicator({
    status,
    showLabel = false,
    size = 'md',
    className = '',
    audioLevel = null,
    statusLabel,
}: VoiceStatusIndicatorProps) {
    const { t } = useI18n();
    const config = statusConfig[status];
    const Icon = config.icon;
    const sizeClass = sizeClasses[size];
    const containerClass = showLabel ? sizeClass.container : '';

    return (
        <div className={`flex items-center ${containerClass} ${className}`}>
            <div className="relative">
                {status === 'listening' ? (
                    <VoiceWaveform level={audioLevel} size={size} />
                ) : (
                    <Icon
                        className={`
                            ${sizeClass.icon}
                            ${config.color}
                            ${config.animation || ''}
                        `}
                        aria-hidden="true"
                    />
                )}
            </div>
            {showLabel && status !== 'listening' && (
                <span className={`typography-meta ${config.color}`}>
                    {statusLabel ?? t(config.labelKey)}
                </span>
            )}
            {status === 'listening' && <span className="sr-only">{statusLabel ?? t(config.labelKey)}</span>}
        </div>
    );
}

export default VoiceStatusIndicator;
