export interface NativeMeridianProfile {readonly id:string;readonly type?:'claude-max'|'api'|'oauth-token';readonly credentialPolicy?:'access-only';readonly claudeConfigDir?:string;readonly keychainService?:string;readonly apiKey?:string;readonly baseUrl?:string;readonly oauthToken?:string}
export interface NativeProviderBoot {readonly protocol:1;readonly type:'provider-boot';readonly provider:'anthropic';readonly requestAuthorization:string;readonly instanceID:string;readonly buildId:string;readonly globals:Readonly<Record<'home'|'config'|'data'|'state'|'cache'|'bin'|'log'|'repos'|'tmp',string>>;readonly profiles:readonly NativeMeridianProfile[];readonly defaultProfile?:string;readonly assets:Readonly<Record<'claude'|'libsql',Readonly<{path:string;sha256:string}>>>;readonly transport:{readonly launcher:string;readonly storage:string;readonly directories:readonly string[]}}
export interface NativeProviderBound {readonly protocol:1;readonly type:'provider-bound';readonly instanceID:string;readonly buildId:string;readonly url:string;readonly port:number;readonly health:'healthy'|'degraded'}
export interface NativeProviderCredentialRequest {readonly protocol:1;readonly type:'credential-request';readonly id:string;readonly attemptID:string;readonly sessionID:string;readonly directory:string;readonly profileID:string;readonly purpose:'request'|'authentication-retry';readonly failedFingerprint?:string}
export interface NativeProviderCredentialResult {readonly profileID:string;readonly accessToken:string;readonly expiresAt:number;readonly fingerprint:string}
export type NativeProviderCredentialReply={readonly protocol:1;readonly id:string;readonly action:'credential-reply'}&({readonly ok:true;readonly result:NativeProviderCredentialResult}|{readonly ok:false;readonly error:{readonly code:string}});
export type NativeProviderCommand=NativeProviderCredentialReply|({readonly protocol:1;readonly id:string}&({readonly action:'health'|'close'}|{readonly action:'authorize-attempt'|'release-attempt';readonly attemptID:string;readonly sessionID:string;readonly directory:string}));
export const NATIVE_CLAUDE_CREDENTIAL_ERRORS:readonly string[];
export function parseProviderCredentialRequest(value:unknown):NativeProviderCredentialRequest;
export function parseProviderCredentialResult(value:unknown):NativeProviderCredentialResult;
export function parseProviderCredentialReply(value:unknown):NativeProviderCredentialReply;
export function parseProviderBoot(value:unknown):NativeProviderBoot;
export function parseProviderBound(value:unknown):NativeProviderBound;
export function parseProviderCommand(value:unknown):NativeProviderCommand;
