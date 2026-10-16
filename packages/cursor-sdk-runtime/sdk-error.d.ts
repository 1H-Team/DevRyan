export type CursorSdkErrorDetails = { name?: string; code?: string; source?: 'provider'; reason?: 'missing' | 'unavailable' | 'limit' | 'shape' | 'mismatch' };
export function cursorProviderFailure(error: unknown): boolean;
export function cursorErrorDetails(error: unknown): CursorSdkErrorDetails;
export function cursorWorkerFailure(message: string, details?: CursorSdkErrorDetails): Error & {code?: string; cursorFailureSource?: 'provider'};
