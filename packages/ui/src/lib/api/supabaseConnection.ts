import type { SupabaseConnectionStatus } from './types';

export type SupabaseConnectionFailure = 'unauthenticated' | 'forbidden' | 'unsupported' | 'temporary';

export class SupabaseConnectionError extends Error {
  constructor(readonly kind: SupabaseConnectionFailure, readonly status: number | null = null) {
    super({
      unauthenticated: 'Sign in as the local owner to view the Supabase connection.',
      forbidden: 'Only the authenticated local owner can view or change the Supabase connection.',
      unsupported: 'This runtime does not support the Supabase connection control. Update the runtime to use it.',
      temporary: 'The Supabase connection status is temporarily unavailable. Retry when the host is ready.',
    }[kind]);
    this.name = 'SupabaseConnectionError';
  }
}

export function isSupabaseConnectionStatus(value: unknown): value is SupabaseConnectionStatus {
  if (!value || typeof value !== 'object') return false;
  return 'configured' in value && typeof value.configured === 'boolean'
    && 'desiredEnabled' in value && typeof value.desiredEnabled === 'boolean'
    && 'effectiveEnabled' in value && typeof value.effectiveEnabled === 'boolean'
    && 'state' in value && typeof value.state === 'string'
    && ['connected', 'disconnecting', 'disconnected', 'connecting', 'connection_failed'].includes(value.state)
    && 'errorCode' in value && (value.errorCode === null || typeof value.errorCode === 'string')
    && 'restartRequired' in value && typeof value.restartRequired === 'boolean'
    && 'restartAvailable' in value && typeof value.restartAvailable === 'boolean'
    && 'blockers' in value && Array.isArray(value.blockers) && value.blockers.every((item) => typeof item === 'string');
}
