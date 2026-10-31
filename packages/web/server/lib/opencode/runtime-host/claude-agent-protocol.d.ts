export declare const CLAUDE_AGENT_CHUNK_BYTES: number;
export declare const CLAUDE_AGENT_EXECUTABLE: string;
export declare const CLAUDE_AGENT_ERRORS: readonly string[];
export type ClaudeAgentRequest =
  | { readonly protocol: 1; readonly type: 'claude-agent'; readonly id: string; readonly action: 'spawn'; readonly args: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string>> }
  | { readonly protocol: 1; readonly type: 'claude-agent'; readonly id: string; readonly action: 'stdin'; readonly chunk: string }
  | { readonly protocol: 1; readonly type: 'claude-agent'; readonly id: string; readonly action: 'end' }
  | { readonly protocol: 1; readonly type: 'claude-agent'; readonly id: string; readonly action: 'kill'; readonly signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' }
  | { readonly protocol: 1; readonly type: 'claude-agent'; readonly id: string; readonly action: 'session'; readonly operation: 'exists' | 'fork' | 'remove'; readonly sessionID: string; readonly messageID?: string };
export interface ClaudeAgentForkResult { readonly sessionID: string; readonly messages: readonly (readonly [string, string])[] }
export type ClaudeAgentReply =
  | { readonly protocol: 1; readonly type: 'claude-agent-reply'; readonly id: string; readonly action: 'started' }
  | { readonly protocol: 1; readonly type: 'claude-agent-reply'; readonly id: string; readonly action: 'stdout'; readonly chunk: string }
  | { readonly protocol: 1; readonly type: 'claude-agent-reply'; readonly id: string; readonly action: 'exit'; readonly code: number | null; readonly signal: string | null; readonly error?: string }
  | { readonly protocol: 1; readonly type: 'claude-agent-reply'; readonly id: string; readonly action: 'result'; readonly result: boolean | null | ClaudeAgentForkResult }
  | { readonly protocol: 1; readonly type: 'claude-agent-reply'; readonly id: string; readonly action: 'error'; readonly error: string };
export declare function parseClaudeAgentRequest(value: unknown): ClaudeAgentRequest;
export declare function parseClaudeAgentReply(value: unknown): ClaudeAgentReply;
