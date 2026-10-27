import type { ChildProcess } from 'node:child_process';
import type { ClaudeTransportIncarnation } from './native-claude-transport-protocol.js';
export function captureClaudeTransportIncarnation(supervisor: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>, executable: string): Promise<ClaudeTransportIncarnation>;
