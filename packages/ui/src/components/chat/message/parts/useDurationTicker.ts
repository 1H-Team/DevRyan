import React from 'react';
import { useDocumentAnimationState } from '@/hooks/useDocumentAnimationState';

type Subscriber = (now: number) => void;

type TickerChannel = {
    subscribers: Set<Subscriber>;
    timerId: ReturnType<typeof setInterval> | null;
};

const tickerChannels = new Map<number, TickerChannel>();

const getTickerChannel = (intervalMs: number): TickerChannel => {
    const existing = tickerChannels.get(intervalMs);
    if (existing) {
        return existing;
    }

    const created: TickerChannel = {
        subscribers: new Set<Subscriber>(),
        timerId: null,
    };
    tickerChannels.set(intervalMs, created);
    return created;
};

const subscribeToTicker = (intervalMs: number, subscriber: Subscriber): (() => void) => {
    const channel = getTickerChannel(intervalMs);
    channel.subscribers.add(subscriber);
    subscriber(Date.now());

    if (channel.timerId === null) {
        channel.timerId = setInterval(() => {
            const now = Date.now();
            channel.subscribers.forEach((listener) => {
                listener(now);
            });
        }, intervalMs);
    }

    return () => {
        const tracked = tickerChannels.get(intervalMs);
        if (!tracked) {
            return;
        }

        tracked.subscribers.delete(subscriber);
        if (tracked.subscribers.size > 0) {
            return;
        }

        if (tracked.timerId !== null) {
            clearInterval(tracked.timerId);
        }
        tickerChannels.delete(intervalMs);
    };
};

// Always-visible "working" chrome (status shimmer, sidebar working dots, plan
// skeleton, loading icons) blinks on this one shared tick instead of running an
// infinite CSS animation: an infinite animation draws every frame, this draws
// one per second. The tick flips one root attribute that `.oc-tick-blink` and
// the shimmer/skeleton rules in index.css read, so no component re-renders.
// Without a holder (nothing working, window hidden, reduced motion) the
// attribute is absent and every indicator rests in its static state.
export const SHARED_BLINK_INTERVAL_MS = 1_000;
export const SHARED_BLINK_ATTRIBUTE = 'data-tick-blink';

let sharedBlinkHolders = 0;
let stopSharedBlink: (() => void) | null = null;

const holdSharedBlink = (): (() => void) => {
    sharedBlinkHolders += 1;
    if (sharedBlinkHolders === 1) {
        let on = false;
        stopSharedBlink = subscribeToTicker(SHARED_BLINK_INTERVAL_MS, () => {
            on = !on;
            document.documentElement.setAttribute(SHARED_BLINK_ATTRIBUTE, on ? 'on' : 'off');
        });
    }

    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        sharedBlinkHolders -= 1;
        if (sharedBlinkHolders > 0) {
            return;
        }
        stopSharedBlink?.();
        stopSharedBlink = null;
        document.documentElement.removeAttribute(SHARED_BLINK_ATTRIBUTE);
    };
};

export const useSharedBlink = (active: boolean): void => {
    const { shouldAnimate } = useDocumentAnimationState();

    React.useEffect(() => {
        if (!active || !shouldAnimate || typeof document === 'undefined') {
            return;
        }

        return holdSharedBlink();
    }, [active, shouldAnimate]);
};

export const useDurationTickerNow = (active: boolean, intervalMs: number = 250): number => {
    const [now, setNow] = React.useState(() => Date.now());
    const { isVisible } = useDocumentAnimationState();

    React.useEffect(() => {
        if (!active || !isVisible) {
            return;
        }

        return subscribeToTicker(intervalMs, setNow);
    }, [active, intervalMs, isVisible]);

    return now;
};
