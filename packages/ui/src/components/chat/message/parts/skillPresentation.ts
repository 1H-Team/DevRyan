import type { ToolPart } from '@opencode-ai/sdk/v2';
import { describeExecutionFailure } from '@/lib/executionFailure';

/** DevRyan reviewed-skill ids are opaque hashes (`devryan-<hex>`), never display
 * names, including a model's mistyped copy of one. */
const REVIEWED_SKILL_ID = /^devryan-[0-9a-f]+$/i;
const SKILL_CONTENT_NAME = /<skill_content\s+name="([^"]+)"/;
const GENERIC_SKILL_NAME = 'Skill';

const nonEmpty = (value: unknown): string | null => (
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
);

/**
 * Human skill name for a skill tool part: `metadata.name`, else the loaded
 * `<skill_content name>`, else a non-hash `input.name`. Unknown active names
 * stay empty so the loading status does not flash a generic name.
 */
export function getSkillDisplayName(part: ToolPart): string {
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown>; output?: unknown };
    const fromMetadata = nonEmpty(state.metadata?.name);
    if (fromMetadata) return fromMetadata;
    const fromContent = typeof state.output === 'string' ? nonEmpty(SKILL_CONTENT_NAME.exec(state.output)?.[1]) : null;
    if (fromContent) return fromContent;
    const fromInput = nonEmpty(state.input?.name);
    if (fromInput && !REVIEWED_SKILL_ID.test(fromInput)) return fromInput;
    return part.state.status === 'pending' || part.state.status === 'running' ? '' : GENERIC_SKILL_NAME;
}

export function getSkillPresentation(parts: readonly ToolPart[]) {
    const running = parts.some(part => part.state.status === 'running' || part.state.status === 'pending');
    const failed = parts.filter(part => part.state.status === 'error');
    const errors = failed.map(part => part.state.status === 'error'
        ? describeExecutionFailure(part.state.error) ?? 'The skill could not be loaded.' : '');
    return {
        title: running ? 'Loading Skill:' : failed.length ? 'Skill Failed:' : 'Loaded Skill:',
        running,
        failed: failed.length > 0,
        explanation: [...new Set(errors)].join(' '),
    };
}
