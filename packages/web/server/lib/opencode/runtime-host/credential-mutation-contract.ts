import { Context, type Effect } from 'effect';
import type { OperationPermit } from './native-admission-contract.js';

export type OwnedProviderIntegration = 'xai' | 'opencode' | 'opencode-go';
export const isOwnedProviderIntegration = (value: string): value is OwnedProviderIntegration =>
  value === 'xai' || value === 'opencode' || value === 'opencode-go';

/** Opaque original-caller authorization, privately captured before async OAuth. */
export const CredentialAuthorizationRef = Context.Reference<string | undefined>('DevRyan/CredentialAuthorization', { defaultValue: () => undefined });
/** Issued only inside the queued original action; rereads must not outlive its grant. */
export const CredentialMutationReauthorizeRef = Context.Reference<Effect.Effect<void> | undefined>('DevRyan/CredentialMutationReauthorize', { defaultValue: () => undefined });

/** Private constructor contract; fingerprints bind payloads, never confer grants. */
export type CredentialMutationBinding = {
  readonly directory: string;
  readonly controllerInstanceID: string;
  readonly integrationID: string;
  readonly operation: 'create' | 'update' | 'activate' | 'remove';
  readonly credentialID?: string;
  readonly expectedFingerprint?: string;
  readonly requestedFingerprint: string;
} & ({ readonly valueType: 'key' } | { readonly valueType: 'oauth'; readonly methodID: string })
  & ({ readonly kind: 'openai' } | { readonly kind: 'cursor'; readonly valueType: 'key' } | { readonly kind: 'mcp'; readonly server: string;
    readonly configurationDigest: string; readonly acquisitionID: string }
    | { readonly kind: 'provider'; readonly integrationID: OwnedProviderIntegration });

/** Actual model-resolution scope, not a settings grant or a physical-request claim. */
export type CredentialResolutionBinding = {
  readonly kind: 'provider'; readonly integrationID: OwnedProviderIntegration;
  readonly controllerInstanceID: string; readonly directory: string;
  readonly acquisitionID: string; readonly configurationDigest: string;
  readonly sessionID: string; readonly permit: OperationPermit;
  readonly credentialID: string; readonly expectedFingerprint: string;
} & ({ readonly valueType: 'key'; readonly methodID?: never }
  | { readonly valueType: 'oauth'; readonly integrationID: 'xai'; readonly methodID: 'device' });

export type WithCredentialMutation = <A, E, R>(binding: CredentialMutationBinding,
  action: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
export type WithCredentialResolution = <A, E, R>(binding: CredentialResolutionBinding,
  reauthorize: Effect.Effect<void>, action: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
