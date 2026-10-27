import React from 'react';
import { streamPerfCount, streamPerfObserve } from '@/stores/utils/streamDebug';

export type StreamingTextPaintPhase = 'streaming' | 'terminal';

interface UseStreamingTextRevealInput {
    text: string;
    phase: StreamingTextPaintPhase;
    identityKey?: string;
}

/** Backlog is revealed within about this long while the stream is live. */
export const STREAMING_REVEAL_CATCH_UP_MS = 250;
/** Once the stream ends, the remaining backlog is revealed within this long. */
export const STREAMING_REVEAL_TERMINAL_DRAIN_MS = 150;
/** A backlog this large (history load, reconnect, background tab) is shown at once. */
export const STREAMING_REVEAL_SNAP_CHARS = 4000;
const MIN_REVEAL_CHARS_PER_MS = 0.03;
const VELOCITY_EASE_MS = 100;
const MAX_FRAME_DELTA_MS = 100;
const ARRIVAL_PAUSE_MS = 1000;
const MIN_ARRIVAL_SAMPLE_MS = 16;
/** A word longer than this is revealed mid-word rather than held back. */
const MAX_WORD_HOLD_CHARS = 24;

type FrameHandle = number;

export interface StreamingRevealClock {
    now(): number;
    requestFrame(callback: () => void): FrameHandle;
    cancelFrame(handle: FrameHandle): void;
    /** True when frames will not run (background tab) or motion is reduced. */
    shouldSnap(): boolean;
}

let reducedMotionQuery: MediaQueryList | null | undefined;
const prefersReducedMotion = (): boolean => {
    if (reducedMotionQuery === undefined) {
        reducedMotionQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia('(prefers-reduced-motion: reduce)')
            : null;
    }
    return reducedMotionQuery?.matches ?? false;
};

const browserClock: StreamingRevealClock = {
    now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    requestFrame: (callback) => (
        typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(callback)
            : (setTimeout(callback, 16) as unknown as FrameHandle)
    ),
    cancelFrame: (handle) => {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
        else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    },
    shouldSnap: () => (
        typeof requestAnimationFrame !== 'function'
        || (typeof document !== 'undefined' && document.visibilityState === 'hidden')
        || prefersReducedMotion()
    ),
};

/**
 * One frame loop for every live reveal, so N streaming parts cost one
 * animation frame callback, and none while nothing is catching up.
 */
export class StreamingRevealFrameLoop {
    private readonly active = new Set<StreamingTextRevealController>();
    private handle: FrameHandle | null = null;

    constructor(readonly clock: StreamingRevealClock = browserClock) {}

    /** Returns false when the controller was already running. */
    add(controller: StreamingTextRevealController): boolean {
        if (this.active.has(controller)) return false;
        this.active.add(controller);
        if (this.handle === null) {
            this.handle = this.clock.requestFrame(this.tick);
        }
        return true;
    }

    remove(controller: StreamingTextRevealController): void {
        this.active.delete(controller);
        if (this.active.size === 0 && this.handle !== null) {
            this.clock.cancelFrame(this.handle);
            this.handle = null;
        }
    }

    get activeCount(): number {
        return this.active.size;
    }

    private readonly tick = (): void => {
        this.handle = null;
        const now = this.clock.now();
        for (const controller of [...this.active]) {
            if (!controller.advance(now)) {
                this.active.delete(controller);
            }
        }
        if (this.active.size > 0) {
            this.handle = this.clock.requestFrame(this.tick);
        }
    };
}

const isBoundaryChar = (code: number): boolean => code === 32 || code === 10 || code === 9 || code === 13;

/**
 * The longest visible length in (from, position] that ends after whitespace,
 * so words appear whole. A long unbroken run is cut mid-word, never inside a
 * surrogate pair.
 */
export const resolveRevealBoundary = (text: string, from: number, position: number): number => {
    const target = Math.min(text.length, Math.floor(position));
    if (target >= text.length) return text.length;
    if (target <= from) return from;
    for (let index = target; index > from; index -= 1) {
        if (isBoundaryChar(text.charCodeAt(index - 1))) return index;
    }
    if (target - from < MAX_WORD_HOLD_CHARS) return from;
    const previous = text.charCodeAt(target - 1);
    return previous >= 0xd800 && previous <= 0xdbff ? target - 1 : target;
};

const firstReveal = (text: string): string => text.slice(0, resolveRevealBoundary(text, 0, MAX_WORD_HOLD_CHARS));

/**
 * Render-only controller. Canonical text continues to update in sync state;
 * this controller paces the visible projection so bursty network chunks are
 * revealed word by word at the stream's own rate instead of in jumps.
 */
export class StreamingTextRevealController {
    private identityKey: string;
    private phase: StreamingTextPaintPhase;
    private target: string;
    private displayed: string;
    private revealed: number;
    private velocity = 0;
    private arrivalRate = 0;
    private lastGrowthAt = 0;
    private lastFrameAt = 0;
    private onEmit: (text: string) => void = () => {};

    constructor(
        initial: UseStreamingTextRevealInput,
        private readonly loop: StreamingRevealFrameLoop = defaultFrameLoop,
    ) {
        this.identityKey = initial.identityKey ?? '';
        this.phase = initial.phase;
        // Text present at mount (history, a session opened mid-stream) is shown as is.
        this.target = initial.text;
        this.displayed = initial.text;
        this.revealed = initial.text.length;
    }

    getRenderText(input: UseStreamingTextRevealInput): string {
        const { text, phase } = input;
        if ((input.identityKey ?? '') !== this.identityKey || this.shouldSnapTo(text, phase)) {
            return text;
        }
        if (this.displayed.length === 0 && text.length > 0) {
            return phase === 'terminal' ? text : firstReveal(text);
        }
        return this.displayed;
    }

    update(input: UseStreamingTextRevealInput, onEmit: (text: string) => void): void {
        const { text, phase } = input;
        const identityKey = input.identityKey ?? '';
        this.onEmit = onEmit;

        if (identityKey !== this.identityKey) {
            this.identityKey = identityKey;
            this.arrivalRate = 0;
            this.lastGrowthAt = 0;
            this.phase = phase;
            this.snap(text);
            return;
        }

        const now = this.loop.clock.now();
        const phaseChanged = phase !== this.phase;
        this.phase = phase;

        if (phase === 'streaming' && text.length < this.displayed.length) {
            // A temporary shorter snapshot never truncates visible text.
            return;
        }
        if (this.shouldSnapTo(text, phase)) {
            this.snap(text);
            return;
        }
        if (text === this.target && !phaseChanged) {
            return;
        }

        if (text.length > this.target.length) {
            const elapsed = now - this.lastGrowthAt;
            if (this.lastGrowthAt > 0 && elapsed < ARRIVAL_PAUSE_MS) {
                const sample = (text.length - this.target.length) / Math.max(MIN_ARRIVAL_SAMPLE_MS, elapsed);
                this.arrivalRate = this.arrivalRate === 0 ? sample : this.arrivalRate * 0.75 + sample * 0.25;
            }
            this.lastGrowthAt = now;
        }
        this.target = text;

        if (this.displayed.length === 0) {
            this.displayed = firstReveal(text);
            this.revealed = this.displayed.length;
            this.emit();
        }
        if (this.displayed.length < this.target.length && this.loop.add(this)) {
            this.lastFrameAt = now;
        }
    }

    /** Advances the reveal for one frame; false once fully revealed. */
    advance(now: number): boolean {
        const dt = Math.min(MAX_FRAME_DELTA_MS, Math.max(0, now - this.lastFrameAt));
        this.lastFrameAt = now;
        const length = this.target.length;
        const backlog = length - this.revealed;
        if (backlog <= 0) {
            this.revealed = length;
            if (this.displayed !== this.target) {
                this.displayed = this.target;
                this.emit();
            }
            return false;
        }

        const terminal = this.phase === 'terminal';
        const desired = Math.max(
            MIN_REVEAL_CHARS_PER_MS,
            this.arrivalRate,
            backlog / (terminal ? STREAMING_REVEAL_TERMINAL_DRAIN_MS : STREAMING_REVEAL_CATCH_UP_MS),
        );
        this.velocity = terminal
            ? Math.max(this.velocity, desired)
            : Math.max(MIN_REVEAL_CHARS_PER_MS, this.velocity + (desired - this.velocity) * Math.min(1, dt / VELOCITY_EASE_MS));
        this.revealed = Math.min(length, this.revealed + this.velocity * dt);

        const next = resolveRevealBoundary(this.target, this.displayed.length, this.revealed);
        if (next > this.displayed.length) {
            this.displayed = this.target.slice(0, next);
            streamPerfObserve('ui.stream_reveal.backlog_chars', length - next);
            this.emit();
        }
        return this.displayed.length < length;
    }

    dispose(): void {
        this.loop.remove(this);
        this.onEmit = () => {};
    }

    private shouldSnapTo(text: string, phase: StreamingTextPaintPhase): boolean {
        if (text === this.displayed) return false;
        if (phase === 'terminal' && this.displayed.length === 0) return true;
        if (text.length < this.displayed.length) return phase === 'terminal';
        return !text.startsWith(this.displayed)
            || text.length - this.displayed.length > STREAMING_REVEAL_SNAP_CHARS
            || this.loop.clock.shouldSnap();
    }

    private snap(text: string): void {
        this.loop.remove(this);
        this.target = text;
        this.revealed = text.length;
        this.velocity = 0;
        if (this.displayed !== text) {
            this.displayed = text;
            this.emit();
        }
    }

    private emit(): void {
        streamPerfCount('ui.stream_reveal.commit');
        this.onEmit(this.displayed);
    }
}

const defaultFrameLoop = new StreamingRevealFrameLoop();

export const useStreamingTextReveal = (input: UseStreamingTextRevealInput): string => {
    const controllerRef = React.useRef<StreamingTextRevealController | null>(null);
    if (controllerRef.current === null) {
        controllerRef.current = new StreamingTextRevealController(input);
    }

    const [, forceCommit] = React.useReducer((version: number) => version + 1, 0);
    const controller = controllerRef.current;
    const renderText = controller.getRenderText(input);
    const { identityKey, phase, text } = input;

    React.useEffect(() => {
        controller.update({ identityKey, phase, text }, () => {
            forceCommit();
        });
    }, [controller, identityKey, phase, text]);

    React.useEffect(() => () => controller.dispose(), [controller]);

    return renderText;
};
