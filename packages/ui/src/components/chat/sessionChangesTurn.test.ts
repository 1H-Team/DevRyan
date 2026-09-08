import { describe, expect, test } from 'bun:test';
import type { Message, TextPart } from '@opencode-ai/sdk/v2';
import { buildPlanImplementationRequestMarker } from '@/lib/messages/actionablePlan';
import type { State } from '@/sync/types';
import { createSessionChangesTurnSelector } from './sessionChangesTurn';

const user = (id: string): Message => ({
    id, sessionID: 'session', role: 'user', time: { created: 1 },
    agent: 'orchestrator', model: { providerID: 'fixture', modelID: 'fixture' },
});
const assistant = (parentID: string, completed = true): Message => ({
    id: `${parentID}-answer`, parentID, sessionID: 'session', role: 'assistant',
    time: { created: 2, ...(completed ? { completed: 3 } : {}) },
    modelID: 'fixture', providerID: 'fixture', mode: 'primary', agent: 'orchestrator',
    path: { cwd: '/fixture', root: '/fixture' }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});
const text = (messageID: string, content: string, synthetic = false): TextPart => ({
    id: `${messageID}-text`, messageID, sessionID: 'session', type: 'text', text: content, synthetic,
});
const plan = (id: string) => text(id, 'User has requested to enter plan mode.', true);
type Fixture = Pick<State, 'message' | 'part'>;
const select = () => createSessionChangesTurnSelector('session', () => false);

describe('session changes submitted turn eligibility', () => {
    test('requires hydrated intent and a completed response, including the pre-busy gap', () => {
        const eligible = select();
        expect(eligible({ message: {}, part: {} })).toBe(false);
        const state: Fixture = { message: { session: [user('work')] }, part: { work: [text('work', 'Implement it')] } };
        expect(eligible(state)).toBe(false);
        expect(eligible({ ...state, message: { session: [user('work'), assistant('work', false)] } })).toBe(false);
        const done = { ...state, message: { session: [user('work'), assistant('work')] } };
        expect(eligible(done)).toBe(true);
        expect(eligible({ ...done, part: {} })).toBe(false);
    });

    test('hides previous implementation through planning, reload and maintenance', () => {
        const state: Fixture = {
            message: { session: [user('work'), assistant('work'), user('plan'), assistant('plan')] },
            part: { work: [text('work', 'Implement it')], plan: [plan('plan')] },
        };
        expect(select()(state)).toBe(false);
        const continued: Fixture = {
            message: { session: [...state.message.session, user('wake'), assistant('wake')] },
            part: { ...state.part, wake: [text('wake', '[devryan-provider-recovery:v1:task_fixture]\nCollect the result.', true)] },
        };
        expect(select()(continued)).toBe(false);
        const marker = buildPlanImplementationRequestMarker({ sourceSessionId: 'session', sourceMessageId: 'plan-answer', planIndex: 0 });
        expect(select()({
            message: { session: [...continued.message.session, user('implement'), assistant('implement')] },
            part: { ...continued.part, implement: [text('implement', marker, true)] },
        })).toBe(true);
    });

    test('recorded plan flags work without canonical metadata and composer settings are not inputs', () => {
        const state: Fixture = {
            message: { session: [user('plan'), assistant('plan')] },
            part: { plan: [text('plan', 'Prepare a plan')] },
        };
        expect(createSessionChangesTurnSelector('session', id => id === 'plan')(state)).toBe(false);
        expect(createSessionChangesTurnSelector('another-session', () => false)(state)).toBe(false);
    });

    test('newest unhydrated planning turn cannot borrow older implementation intent', () => {
        const eligible = select();
        const state: Fixture = {
            message: { session: [user('work'), assistant('work')] },
            part: { work: [text('work', 'Implement it')] },
        };
        expect(eligible(state)).toBe(true);
        const pending = { ...state, message: { session: [...state.message.session, user('plan'), assistant('plan')] } };
        expect(eligible(pending)).toBe(false);
        expect(eligible({ ...pending, part: { ...pending.part, plan: [plan('plan')] } })).toBe(false);
        expect(eligible(state)).toBe(true);
    });
});
