import React from 'react';
import { cn } from '@/lib/utils';

interface MinDurationShineTextProps {
    active: boolean;
    minDurationMs?: number;
    className?: string;
    children: React.ReactNode;
    style?: React.CSSProperties;
    title?: string;
}

export const MinDurationShineText: React.FC<MinDurationShineTextProps> = ({
    active,
    minDurationMs = 300,
    className,
    children,
    style,
    title,
}) => {
    const busyStartRef = React.useRef<number | null>(active ? Date.now() : null);
    const [isBusy, setIsBusy] = React.useState(active);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    if (active && busyStartRef.current === null) {
        busyStartRef.current = Date.now();
    }

    React.useEffect(() => {
        if (active) {
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            if (busyStartRef.current === null) {
                busyStartRef.current = Date.now();
            }

            setIsBusy(true);
            return;
        }

        if (!isBusy) {
            busyStartRef.current = null;
            return;
        }

        const startedAt = busyStartRef.current ?? Date.now();
        const elapsed = Date.now() - startedAt;

        const remaining = Math.max(0, minDurationMs - elapsed);

        timerRef.current = setTimeout(() => {
            setIsBusy(false);
            busyStartRef.current = null;
            timerRef.current = null;
        }, remaining);

        return () => {
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [active, minDurationMs, isBusy]);

    return (
        <span
            className={cn('transition-opacity duration-200', isBusy && 'opacity-70', className)}
            style={style}
            title={title}
        >
            {children}
        </span>
    );
};
