import { expect, test } from 'bun:test';
import type { ToolPart } from '@opencode-ai/sdk/v2';
import { getSkillDisplayName, getSkillPresentation } from './skillPresentation';

const skill = (state: ToolPart['state']): ToolPart => ({
    id: 'part', sessionID: 'session', messageID: 'message', type: 'tool', tool: 'skill', callID: 'call', state,
});
test('skill outcome survives transcript reload and terminal replacement', () => {
    const running = skill({ status: 'running', input: { name: 'Release Checklist' }, time: { start: 1 } });
    const failed = skill({ status: 'error', input: { name: 'Release Checklist' }, error: 'local_execution_timeout', time: { start: 1, end: 2 } });
    expect(getSkillPresentation([running]).title).toBe('Loading skill:');
    for (const part of [failed, JSON.parse(JSON.stringify(failed))]) {
        const result = getSkillPresentation([part]);
        expect(result.title).toBe('Skill failed:');
        expect(result.running).toBe(false);
        expect(result.explanation).toContain('workspace');
    }
    expect(getSkillPresentation([skill({ status: 'completed', input: {}, output: 'body', title: 'Release Checklist', metadata: {}, time: { start: 1, end: 2 } })]).title).toBe('Loaded skill:');
});
test('mixed skill outcomes retain failures and never expose raw errors', () => {
    const failed = skill({ status: 'error', input: {}, error: 'secret /private/file', time: { start: 1, end: 2 } });
    const running = skill({ status: 'pending', input: {}, raw: '' });
    const result = getSkillPresentation([failed, running]);
    expect(result.title).toBe('Loading skill:');
    expect(result.explanation).toBe('The skill could not be loaded.');
});
test('skill display name prefers metadata, then skill_content, then a non-hash input name, never the hashed id', () => {
    const hashed = 'devryan-539ddc37a961e3aceadfc7bbb540b8e7';
    const body = '<skill_content name="Superpowers">\nbody\n</skill_content>';
    expect(getSkillDisplayName(skill({ status: 'completed', input: { id: hashed, name: hashed }, output: body, title: '', metadata: { name: 'From Metadata' }, time: { start: 1, end: 2 } }))).toBe('From Metadata');
    expect(getSkillDisplayName(skill({ status: 'completed', input: { id: hashed, name: hashed }, output: body, title: '', metadata: {}, time: { start: 1, end: 2 } }))).toBe('Superpowers');
    expect(getSkillDisplayName(skill({ status: 'running', input: { id: 'pdf', name: 'pdf' }, time: { start: 1 } }))).toBe('pdf');
    expect(getSkillDisplayName(skill({ status: 'running', input: { id: hashed, name: hashed }, time: { start: 1 } }))).toBe('Skill');
    expect(getSkillDisplayName(skill({ status: 'running', input: { id: hashed }, time: { start: 1 } }))).toBe('Skill');
    expect(getSkillDisplayName(skill({ status: 'pending', input: {}, raw: '' }))).toBe('Skill');
    expect(getSkillDisplayName(skill({ status: 'error', input: { name: hashed }, error: 'x', time: { start: 1, end: 2 } }))).toBe('Skill');
});
