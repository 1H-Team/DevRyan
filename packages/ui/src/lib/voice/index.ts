/**
 * Voice module barrel export
 *
 * @example
 * ```typescript
 * import { voiceHooks, isVoiceSessionStarted } from '@/lib/voice';
 * ```
 */

// Voice session registry (from voiceSession.ts)
export { isVoiceSessionStarted } from "./voiceSession";

// Voice hooks for session-to-voice event routing (from voiceHooks.ts)
export { voiceHooks } from "./voiceHooks";
