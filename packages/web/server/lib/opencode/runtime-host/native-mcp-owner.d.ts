export interface NativeMcpBinding { readonly directory: string; readonly server: string; readonly configurationDigest: string }
export interface NativeMcpInput { readonly directory: string; readonly server: string; readonly attemptID?: string }
export interface NativeMcpCallerGrant { readonly identityKey: string; readonly reauthorize: () => Promise<void> }
export interface NativeMcpRequest { readonly directory: string; readonly method: 'GET' | 'POST' | 'DELETE'; readonly path: string; readonly body?: unknown }
export interface NativeMcpOperation extends NativeMcpRequest, NativeMcpBinding {
  readonly operation: string; readonly integrationID?: string; readonly methodID?: string;
  readonly attemptID?: string; readonly credentialID?: string;
}
export interface NativeMcpOwnerOptions {
  readonly reviewedServersByDirectory: ReadonlyMap<string, ReadonlyMap<string, { readonly configurationDigest: string; readonly disabled: boolean }>>;
  readonly requestNative: (request: NativeMcpRequest) => Promise<unknown>;
  /** Captured from the actual original authenticator, never caller input. The
   * opaque key permits matching later requests to the same private identity. */
  readonly captureCaller: (binding: NativeMcpBinding) => Promise<NativeMcpCallerGrant>;
  readonly withCallerOperation: <A>(operation: NativeMcpOperation, action: () => Promise<A>) => Promise<A>;
  /** Constructor-only scope cleanup; cancellation gives no credential authority. */
  readonly cancelOwnedAttempt: (binding: NativeMcpBinding & { readonly integrationID: string; readonly attemptID: string }) => Promise<void>;
}
export interface NativeMcpOwner {
  readonly status: (input: NativeMcpInput) => Promise<{ readonly status: string }>;
  readonly connect: (input: NativeMcpInput) => Promise<true>;
  readonly disconnect: (input: NativeMcpInput) => Promise<true>;
  readonly authStart: (input: NativeMcpInput) => Promise<{ readonly authorizationUrl: string; readonly attemptID: string; readonly mode: 'auto' | 'code'; readonly time: { readonly created: number; readonly expires: number } }>;
  readonly authStatus: (input: NativeMcpInput) => Promise<{ readonly status: string; readonly time: { readonly created: number; readonly expires: number } }>;
  readonly authComplete: (input: NativeMcpInput & { readonly code?: string }) => Promise<true>;
  readonly authCancel: (input: NativeMcpInput) => Promise<true>;
  readonly authRemove: (input: NativeMcpInput) => Promise<true>;
  readonly close: () => Promise<void>;
}
export function createNativeMcpOwner(options: NativeMcpOwnerOptions): NativeMcpOwner;
