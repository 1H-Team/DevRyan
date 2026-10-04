declare module 'devryan:reviewed-claude-startup' {
  export const startReviewedProxy: import('./native-meridian-worker.js').ReviewedClaudeStartup['startReviewedProxy'];
  export const checkReviewedProxy: import('./native-meridian-worker.js').ReviewedClaudeStartup['checkReviewedProxy'];
  export function scrubReviewedSystem(text:string):string;
}
declare module 'devryan:reviewed-claude-scrub' {
  export function scrubOpencodeFingerprints(text:string):string;
}
