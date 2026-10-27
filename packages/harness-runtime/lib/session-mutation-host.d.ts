import type { SessionMutationRuntime, createSessionMutationRuntime } from './session-mutations.js';
export const SESSION_MUTATION_METHODS: readonly (keyof SessionMutationRuntime)[];
/** False when the runtime must run inline (DEVRYAN_LEDGER_WORKER=0, Windows, a Windows owner or launcher, or an injected Git runner). */
export function sessionMutationWorkerEnabled(options?: Parameters<typeof createSessionMutationRuntime>[0] | Record<string, unknown>): boolean;
/** The host's Node flags without inline-entry flags, or undefined when the worker can inherit them unchanged. */
export function workerExecArgv(argv?: readonly string[]): string[] | undefined;
/** The session mutation runtime behind a worker thread of this process; inline where the worker is disabled. */
export interface SessionMutationWorkerStatus { running: boolean; pendingCalls: number; heapUsedMB: number | null; heapTotalMB: number | null }
export function createSessionMutationHost(options: Parameters<typeof createSessionMutationRuntime>[0]): SessionMutationRuntime & { close?: () => Promise<void>; workerStatus?: () => Promise<SessionMutationWorkerStatus> };
