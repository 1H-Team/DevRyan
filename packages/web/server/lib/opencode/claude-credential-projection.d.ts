export interface ClaudeTransportEnvironment {readonly env:NodeJS.ProcessEnv;readonly unavailable:string|null}
export function prepareClaudeTransportEnvironment(options:{env:NodeJS.ProcessEnv;account:string;state:string;keychainService?:string}):Promise<ClaudeTransportEnvironment>;
