import { expect, test } from 'bun:test';
import type { ToolPart } from '@opencode-ai/sdk/v2';
import { getSkillPresentation } from './skillPresentation';

const skill = (state: ToolPart['state']): ToolPart => ({
    id: 'part', sessionID: 'session', messageID: 'message', type: 'tool', tool: 'skill', callID: 'call', state,
});
test('skill outcome survives transcript reload and terminal replacement', () => {
    const running = skill({ status: 'running', input: { name: 'Superpowers' }, time: { start: 1 } });
    const failed = skill({ status: 'error', input: { name: 'Superpowers' }, error: 'local_execution_timeout', time: { start: 1, end: 2 } });
    expect(getSkillPresentation([running]).title).toBe('Loading skill:');
    for (const part of [failed, JSON.parse(JSON.stringify(failed))]) {
        const result = getSkillPresentation([part]);
        expect(result.title).toBe('Skill failed:');
        expect(result.running).toBe(false);
        expect(result.explanation).toContain('workspace');
    }
    expect(getSkillPresentation([skill({ status: 'completed', input: {}, output: 'body', title: 'Superpowers', metadata: {}, time: { start: 1, end: 2 } })]).title).toBe('Loaded skill:');
});
test('mixed skill outcomes retain failures and never expose raw errors', () => {
    const failed = skill({ status: 'error', input: {}, error: 'secret /private/file', time: { start: 1, end: 2 } });
    const running = skill({ status: 'pending', input: {}, raw: '' });
    const result = getSkillPresentation([failed, running]);
    expect(result.title).toBe('Loading skill:');
    expect(result.explanation).toBe('The skill could not be loaded.');
});
