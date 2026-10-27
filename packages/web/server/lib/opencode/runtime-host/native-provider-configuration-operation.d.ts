import type { NativeConfigurationSnapshot } from './native-configuration-snapshot.js';
import type { NativeIntegrationOperation } from './native-integration-authorization.js';
import type { NativeCredentialOperation } from './native-process-protocol.js';
export type NativeProviderConfigurationScope = 'read' | 'auth' | 'user' | 'project' | 'custom' | 'all';
export interface NativeProviderConfigurationInput { readonly providerID: 'openai' | 'cursor-acp'; readonly scope: NativeProviderConfigurationScope; readonly directory?: string | null; }
export interface NativeProviderSource { readonly exists: boolean; readonly path: string | null; }
export interface NativeProviderConfigurationOperation {
  readonly recheck: () => Promise<void>;
  readonly verifyConfiguration: () => Promise<void>;
  readonly readAuthenticationSource: () => Promise<NativeProviderSource>;
  readonly readSources: () => Readonly<Record<'user' | 'project' | 'custom', NativeProviderSource>>;
  readonly listRemainingConfigSources: () => readonly { readonly type: 'config'; readonly path: string }[];
  readonly disconnectCredentials: (onCommitted: () => void, onStarted?: () => void) => Promise<void>;
  readonly removeConfiguration: (onCommitted: (scope: 'user' | 'project' | 'custom') => void) => Promise<void>;
}
export interface NativeProviderConfigurationOptions {
  readonly descriptor: { readonly generation: number; readonly launch: { readonly opencodeConfigDirectory: string }; readonly projectMap: readonly { readonly targetDirectory: string }[] };
  readonly getSnapshot: () => NativeConfigurationSnapshot | undefined;
  readonly isReady: () => boolean;
  readonly captureWebAuthorization: (input: { readonly operation: 'provider.configuration'; readonly scope: NativeProviderConfigurationScope; readonly directory: string }) => Promise<() => Promise<void>>;
  readonly credentialMetadata: (input: NativeIntegrationOperation) => Promise<unknown>;
  readonly credentialOperation: (input: NativeIntegrationOperation, mutation: NativeCredentialOperation) => Promise<unknown>;
}
export function createNativeProviderConfigurationOperation(options: NativeProviderConfigurationOptions): <A>(input: NativeProviderConfigurationInput, action: (owner: NativeProviderConfigurationOperation) => Promise<A>) => Promise<A>;
