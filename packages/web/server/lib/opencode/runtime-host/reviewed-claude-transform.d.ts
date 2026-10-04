export const REVIEWED_CLAUDE_STARTUP: Readonly<{package:'opencode-with-claude';version:'1.8.0';meridianVersion:'1.62.6';sourceSha256:string}>;
export function rewriteReviewedClaudeStartup(source:string):string;
export const REVIEWED_CLAUDE_ASSETS:Readonly<Record<'claude'|'libsql',Readonly<{path:string;sha256:string;version:string;mode:number}>>>;
export function rewriteReviewedMeridianLibsql(source:string|Uint8Array):string;
export function rewriteReviewedClaudeSpawn(source:string|Uint8Array):string;

export function rewriteReviewedMeridianHttp(source:string|Uint8Array):string;
export const REVIEWED_CLAUDE_CREDENTIALS:Readonly<{path:string;sourceSha256:string;sha256:string;mode:number}>;
export function rewriteReviewedClaudeCredentials(source:string|Uint8Array):string;
