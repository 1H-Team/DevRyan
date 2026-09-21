import type { ToolPart } from '@opencode-ai/sdk/v2';
import { describeExecutionFailure } from '@/lib/executionFailure';

export function getSkillPresentation(parts: readonly ToolPart[]) {
    const running = parts.some(part => part.state.status === 'running' || part.state.status === 'pending');
    const failed = parts.filter(part => part.state.status === 'error');
    const errors = failed.map(part => part.state.status === 'error'
        ? describeExecutionFailure(part.state.error) ?? 'The skill could not be loaded.' : '');
    return {
        title: running ? 'Loading skill:' : failed.length ? 'Skill failed:' : 'Loaded skill:',
        running,
        failed: failed.length > 0,
        explanation: [...new Set(errors)].join(' '),
    };
}
