import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolPart } from '@opencode-ai/sdk/v2';
import type { TurnActivityRecord } from '../../lib/turns/types';
import { StaticToolRow } from './StaticToolRow';

// Reviewed v2 skills are called by an opaque hashed id; the row must show the human name.
const HASHED = 'devryan-539ddc37a961e3aceadfc7bbb540b8e7';
const body = '<skill_content name="Superpowers">\n# Skill: Superpowers\n\nbody\n</skill_content>';
const activity = (state: ToolPart['state']): TurnActivityRecord => ({
    id: 'p', turnId: 't', messageId: 'msg_1', partIndex: 0, kind: 'tool',
    part: { id: 'part', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', tool: 'skill', callID: 'call_1', state },
} as TurnActivityRecord);
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

for (const [label, state] of [
    ['running, named by progress', { status: 'running', input: { id: HASHED, name: 'Superpowers' }, metadata: { name: 'Superpowers' }, time: { start: 1 } }],
    ['completed, hashed name only', { status: 'completed', input: { id: HASHED, name: HASHED }, output: body, title: '', metadata: {}, time: { start: 1, end: 2 } }],
    ['completed, metadata name', { status: 'completed', input: { id: HASHED }, output: body, title: 'Superpowers', metadata: { name: 'Superpowers', directory: '/skills/superpowers' }, time: { start: 1, end: 2 } }],
] as const) {
    test(`skill row shows the human name (${label})`, () => {
        const markup = renderToStaticMarkup(<StaticToolRow toolName="skill" activities={[activity(state as ToolPart['state'])]} animateTailText={false} />);
        expect(text(markup)).toContain('Superpowers');
        expect(markup).not.toContain(HASHED);
    });
}

test('a hash-only running skill row falls back to a generic label', () => {
    const markup = renderToStaticMarkup(<StaticToolRow toolName="skill" activities={[activity({ status: 'running', input: { id: HASHED, name: HASHED }, time: { start: 1 } } as ToolPart['state'])]} animateTailText={false} />);
    expect(markup).not.toContain(HASHED);
    expect(text(markup)).toContain('Skill');
});
