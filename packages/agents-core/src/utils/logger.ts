// DevRyan: the upstream file/stderr logger is replaced by the bound host sinks
// (devryan/owners.ts). No log file is created and no process stream is written;
// every entry is redacted before any sink receives it.
import { reviewedSlimLogSinks } from '../devryan/owners';
import { redactSecretsForLog } from './redact';

/** Kept for upstream call sites; host sinks need no initialisation. */
export function initLogger(_tag?: 'tui'): void {}

/** @internal Kept for upstream tests. */
export function resetLogger(): void {}

/** @internal Host sinks are synchronous. */
export async function flushLoggerForTesting(): Promise<void> {}

export function log(message: string, data?: unknown): void {
  try {
    let serialized = '';
    if (data !== undefined) {
      try {
        serialized = JSON.stringify(data);
      } catch {
        serialized = '[unserializable]';
      }
    }
    const entry = redactSecretsForLog(`${String(message)} ${serialized}`);
    for (const sink of reviewedSlimLogSinks()) sink(entry);
  } catch {
    // Logging must remain best-effort.
  }
}
