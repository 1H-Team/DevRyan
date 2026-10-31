/** A Claude profile row from the Meridian era, as clone and setup migration read it. */
export interface NativeMeridianProfile {readonly id:string;readonly type?:'claude-max'|'api'|'oauth-token';readonly credentialPolicy?:'access-only';readonly claudeConfigDir?:string;readonly keychainService?:string;readonly apiKey?:string;readonly baseUrl?:string;readonly oauthToken?:string}
export function isNativeClaudeEnrollmentDirectory(profile:NativeMeridianProfile,input:{readonly controlRoot?:string;readonly home:string}):Promise<boolean>;
