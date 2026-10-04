import type { CredentialMutationBinding, CredentialResolutionBinding } from './credential-mutation-contract.js';
export interface CredentialMutationControl { readonly callID: string; readonly controllerInstanceID: string; readonly bindingFingerprint: string }
export interface CredentialMutationRequest extends CredentialMutationControl { readonly binding: CredentialMutationBinding | CredentialResolutionBinding; readonly authorizationID: string }
export interface NativeCredentialMutationOwnerOptions {
  readonly controllerInstanceID: string;
  readonly withMutationQueue: <A>(work: () => Promise<A>) => Promise<A>;
  /** Resolves a private original-principal grant captured before OAuth/refresh. */
  readonly resolveAuthorization: (input: { readonly authorizationID: string; readonly binding: CredentialMutationBinding }) => Promise<{ readonly reauthorize: () => Promise<void> | void }>;
  readonly verifyBinding: (binding: CredentialMutationBinding) => Promise<void>;
  /** Includes actual native action/finalizer settlement on success OR error; a transport timeout alone is insufficient. */
  readonly withResolution?: <A>(binding: CredentialResolutionBinding, action: () => Promise<A>) => Promise<A>;
  readonly commitOwned: (control: CredentialMutationControl) => Promise<void>;
}
export function credentialMutationFingerprint(value: unknown): string;
export function parseCredentialMutationBinding(value: unknown): CredentialMutationBinding;
export function parseCredentialResolutionBinding(value: unknown): CredentialResolutionBinding;
export function createNativeCredentialMutationOwner(options: NativeCredentialMutationOwnerOptions): {
  readonly handleRpc: (method: string, input: unknown, context?: { readonly signal?: AbortSignal }) => Promise<null>;
  readonly invalidate: () => Promise<void>; readonly close: () => Promise<void>;
};
