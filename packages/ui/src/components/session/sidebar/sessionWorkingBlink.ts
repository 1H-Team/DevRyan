// Must match `.animate-session-working-blink` in index.css.
export const SESSION_WORKING_BLINK_DURATION_MS = 2400;

const positiveModulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;

/**
 * Animation `currentTime` that puts a blink whose effect delay is `delayMs` on
 * the wall-clock phase `nowMs mod duration` (active time = currentTime - delay).
 */
export function resolveWorkingBlinkCurrentTimeMs(nowMs: number, delayMs: number): number {
  return positiveModulo(nowMs + delayMs, SESSION_WORKING_BLINK_DURATION_MS);
}
