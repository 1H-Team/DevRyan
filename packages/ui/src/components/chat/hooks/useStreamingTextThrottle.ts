import React from 'react';

export type StreamingTextPaintPhase = 'streaming' | 'terminal';

interface UseStreamingTextThrottleInput {
    text: string;
    phase: StreamingTextPaintPhase;
    throttleMs?: number;
    identityKey?: string;
}

export const DEFAULT_STREAMING_TEXT_THROTTLE_MS = 32;

export const computeStreamingThrottleDelay = (lastEmitAt: number, now: number, throttleMs: number): number => {
    const elapsed = now - lastEmitAt;
    return Math.min(throttleMs, Math.max(0, throttleMs - elapsed));
};

type StreamingTextThrottleUpdate = Required<Pick<UseStreamingTextThrottleInput, 'text' | 'phase' | 'throttleMs'>> & {
    identityKey: string;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export interface StreamingTextThrottleScheduler {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): TimerHandle;
    clearTimeout(timer: TimerHandle): void;
}

const defaultScheduler: StreamingTextThrottleScheduler = {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer),
};

const normalizeUpdate = ({
    text,
    phase,
    throttleMs = DEFAULT_STREAMING_TEXT_THROTTLE_MS,
    identityKey,
}: UseStreamingTextThrottleInput): StreamingTextThrottleUpdate => ({
    text,
    phase,
    throttleMs: Math.max(0, throttleMs),
    identityKey: identityKey ?? '',
});

/**
 * Render-only controller. Canonical text continues to update in sync state;
 * this controller only limits how often the visible projection is committed.
 */
export class StreamingTextThrottleController {
    private identityKey: string;
    private displayedText: string;
    private pendingText: string;
    private lastEmitAt: number;
    private timer: TimerHandle | null = null;
    private onEmit: (text: string) => void = () => {};

    constructor(
        initial: UseStreamingTextThrottleInput,
        private readonly scheduler: StreamingTextThrottleScheduler = defaultScheduler,
    ) {
        const update = normalizeUpdate(initial);
        this.identityKey = update.identityKey;
        this.displayedText = update.text;
        this.pendingText = update.text;
        this.lastEmitAt = update.phase === 'streaming' && update.text.length > 0
            ? scheduler.now()
            : 0;
    }

    getRenderText(input: UseStreamingTextThrottleInput): string {
        const update = normalizeUpdate(input);
        if (update.identityKey !== this.identityKey || update.phase === 'terminal') {
            return update.text;
        }
        if (this.displayedText.length === 0 && update.text.length > 0) {
            return update.text;
        }
        if (update.text.length < this.displayedText.length) {
            return this.displayedText;
        }
        return this.displayedText;
    }

    update(input: UseStreamingTextThrottleInput, onEmit: (text: string) => void): void {
        const update = normalizeUpdate(input);
        this.onEmit = onEmit;

        if (update.identityKey !== this.identityKey) {
            this.cancelTimer();
            this.identityKey = update.identityKey;
            this.pendingText = update.text;
            this.displayedText = update.text;
            this.lastEmitAt = update.phase === 'streaming' && update.text.length > 0
                ? this.scheduler.now()
                : 0;
            this.onEmit(update.text);
            return;
        }

        this.pendingText = update.text;

        if (update.phase === 'terminal') {
            this.cancelTimer();
            this.displayedText = update.text;
            this.lastEmitAt = this.scheduler.now();
            this.onEmit(update.text);
            return;
        }

        if (update.text.length < this.displayedText.length) {
            this.cancelTimer();
            return;
        }

        if (this.displayedText.length === 0 && update.text.length > 0) {
            this.cancelTimer();
            this.displayedText = update.text;
            this.lastEmitAt = this.scheduler.now();
            this.onEmit(update.text);
            return;
        }

        if (update.text === this.displayedText) {
            this.cancelTimer();
            return;
        }

        const delay = computeStreamingThrottleDelay(
            this.lastEmitAt,
            this.scheduler.now(),
            update.throttleMs,
        );
        this.cancelTimer();
        if (delay === 0) {
            this.emitPending();
            return;
        }

        this.timer = this.scheduler.setTimeout(() => {
            this.timer = null;
            this.emitPending();
        }, delay);
    }

    dispose(): void {
        this.cancelTimer();
        this.onEmit = () => {};
    }

    private emitPending(): void {
        if (this.pendingText.length < this.displayedText.length) {
            return;
        }
        if (this.pendingText === this.displayedText) {
            return;
        }

        this.displayedText = this.pendingText;
        this.lastEmitAt = this.scheduler.now();
        this.onEmit(this.displayedText);
    }

    private cancelTimer(): void {
        if (this.timer === null) return;
        this.scheduler.clearTimeout(this.timer);
        this.timer = null;
    }
}

export const useStreamingTextThrottle = (input: UseStreamingTextThrottleInput): string => {
    const controllerRef = React.useRef<StreamingTextThrottleController | null>(null);
    if (controllerRef.current === null) {
        controllerRef.current = new StreamingTextThrottleController(input);
    }

    const [, forceCommit] = React.useReducer((version: number) => version + 1, 0);
    const controller = controllerRef.current;
    const renderText = controller.getRenderText(input);
    const { identityKey, phase, text, throttleMs } = input;

    React.useEffect(() => {
        controller.update({ identityKey, phase, text, throttleMs }, () => {
            forceCommit();
        });
    }, [controller, identityKey, phase, text, throttleMs]);

    React.useEffect(() => () => controller.dispose(), [controller]);

    return renderText;
};
