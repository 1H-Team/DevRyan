import type { Credential } from '@opencode/core/credential';
export interface NativeOpenAiSelected {
  readonly controllerInstanceID: string;
  readonly directory: string;
  readonly credentialID: string;
  readonly integrationID: 'openai';
  readonly value: Credential.Value;
}
export interface NativeOpenAiNormalizedAuth {
  readonly type: 'oauth'; readonly access: string; readonly refresh: string; readonly expires: number;
  readonly accountId?: string; readonly credentialID: string; readonly methodID: string;
}
export interface NativeOpenAiAsyncStorage {
  readonly isActive?: () => boolean;
  readonly readAuth: () => Promise<NativeOpenAiNormalizedAuth | { readonly type: 'api'; readonly key: string } | undefined>;
  readonly compareAndSwap: (expected: NativeOpenAiNormalizedAuth, next: NativeOpenAiNormalizedAuth) => Promise<boolean>;
}
export type NativeOpenAiMutationQueue = <A>(action: () => A | Promise<A>) => Promise<A>;
export interface NativeOpenAiAttempt {
  readonly credentialID: string; readonly methodID: string; readonly accountId: string;
  readonly accessToken: string; readonly expiresAt: number; readonly generation: string;
}
export interface NativeOpenAiCoordinator {
  access(input: { expectedAccountId: string; credentialId: string }): Promise<{
    accessToken: string; expiresAt: number; accountId: string; generation: string;
  }>;
}
export function createNativeOpenAiAuth(options: {
  directory: string;
  controllerIdentity(): string | undefined;
  readSelected(input: { directory: string }): Promise<NativeOpenAiSelected | undefined>;
  compareAndSwapSelected(input: { directory: string; expected: NativeOpenAiSelected; next: Credential.Value }): Promise<boolean>;
}): {
  readonly asyncStorage: NativeOpenAiAsyncStorage;
  access(coordinator: NativeOpenAiCoordinator, input: { directory: string; credentialID?: string }): Promise<NativeOpenAiAttempt | undefined>;
};
