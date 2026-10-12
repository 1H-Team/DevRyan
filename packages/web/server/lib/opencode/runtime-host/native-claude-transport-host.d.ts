import type { NativeProviderBoot, NativeProviderCredentialRequest, NativeProviderCredentialResult } from './native-provider-worker-protocol.js';
import type { ClaudeTransportReply } from './native-claude-transport-protocol.js';
export interface NativeClaudeTransportBinding { readonly attemptID: string; readonly sessionID: string; readonly directory: string }
export interface NativeClaudeTransportHost {
  authorize(input: NativeClaudeTransportBinding): void;
  release(input: NativeClaudeTransportBinding): Promise<void>;
  accept(input: unknown): Promise<void>;
  close(): Promise<void>;
}
export function createNativeClaudeTransportHost(options: {
  readonly boot: NativeProviderBoot; readonly environment: NodeJS.ProcessEnv; readonly deniedReadDirectories?: readonly string[];
  readonly send: (reply: ClaudeTransportReply) => Promise<void>;
  readonly resolveCredential?: (request: NativeProviderCredentialRequest, context: { readonly signal: AbortSignal }) => Promise<NativeProviderCredentialResult>;
}): NativeClaudeTransportHost;
