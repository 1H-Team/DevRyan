import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import {
    buildTurnWindowModel,
    countTurnRows,
    getInitialTurnStartByRows,
    getRevealTurnStartByRows,
    updateTurnWindowModelIncremental,
    windowMessagesByTurn,
} from './windowTurns';
import { TURN_WINDOW_DEFAULTS } from './constants';
import type { ChatMessageEntry } from './types';

function message({ id, role, parentID }: { id: string; role: 'user' | 'assistant' | 'system'; parentID?: string }): ChatMessageEntry {
    return {
        info: {
            id,
            role,
            ...(parentID ? { parentID } : {}),
            time: { created: 1 },
        } as Message,
        parts: [] as Part[],
    };
}

describe('windowTurns', () => {
    test('does not map assistant messages without a parent to the current turn', () => {
        const user = message({ id: 'u1', role: 'user' });
        const assistant = message({ id: 'a1', role: 'assistant' });

        const model = buildTurnWindowModel([user, assistant]);

        expect(model.messageToTurnId.get('u1')).toBe('u1');
        expect(model.messageToTurnId.has('a1')).toBe(false);
    });

    test('incremental update does not map assistant messages without a parent to the current turn', () => {
        const user = message({ id: 'u1', role: 'user' });
        const assistant = message({ id: 'a1', role: 'assistant' });
        const base = buildTurnWindowModel([user]);

        const next = updateTurnWindowModelIncremental(base, [user], [user, assistant]);

        expect(next?.messageToTurnId.get('u1')).toBe('u1');
        expect(next?.messageToTurnId.has('a1')).toBe(false);
    });

    test('maps assistant messages to their parent user turn', () => {
        const user = message({ id: 'u1', role: 'user' });
        const assistant = message({ id: 'a1', role: 'assistant', parentID: 'u1' });

        const model = buildTurnWindowModel([user, assistant]);

        expect(model.messageToTurnId.get('a1')).toBe('u1');
    });

    describe('row-sized window', () => {
        const tool = (id: string) => ({ id, type: 'tool' } as Part);
        // A conversation of `toolsPerTurn` tool rows per turn (plus one text row).
        const conversation = (toolsPerTurn: number[]): ChatMessageEntry[] => toolsPerTurn.flatMap((tools, turn) => {
            const user = message({ id: `u${turn}`, role: 'user' });
            const assistant = message({ id: `a${turn}`, role: 'assistant', parentID: `u${turn}` });
            assistant.parts = [
                ...Array.from({ length: tools }, (_, index) => tool(`t${turn}_${index}`)),
                { id: `x${turn}`, type: 'text' } as Part,
                { id: `s${turn}`, type: 'step-finish' } as Part,
            ];
            return [user, assistant];
        });

        test('counts a prompt plus each tool, text and reasoning part', () => {
            const messages = conversation([3]);
            expect(countTurnRows(messages, buildTurnWindowModel(messages), 0)).toBe(5);
        });

        test('mounts a short transcript whole', () => {
            const messages = conversation([2, 2, 2, 2]);
            expect(getInitialTurnStartByRows(messages, buildTurnWindowModel(messages))).toBe(0);
        });

        test('mounts only the newest turns that fit the row budget once a transcript is long', () => {
            // Ten turns of 22 rows each: 220 rows, though only ten turns.
            const messages = conversation(Array.from({ length: 10 }, () => 20));
            const model = buildTurnWindowModel(messages);
            const start = getInitialTurnStartByRows(messages, model);

            expect(start).toBe(9 - Math.floor(TURN_WINDOW_DEFAULTS.initialRows / 22) + 1);
            let mountedRows = 0;
            for (let turn = start; turn < model.turnCount; turn += 1) mountedRows += countTurnRows(messages, model, turn);
            expect(mountedRows).toBeLessThan(TURN_WINDOW_DEFAULTS.initialRows + 1);
            expect(windowMessagesByTurn(messages, model, start)[0]?.info.id).toBe(`u${start}`);
        });

        test('always mounts the newest turn whole, however many rows it holds', () => {
            const messages = conversation([1, 1, 300]);
            expect(getInitialTurnStartByRows(messages, buildTurnWindowModel(messages))).toBe(2);
        });

        test('still caps a window of tiny turns by turn count', () => {
            const messages = conversation(Array.from({ length: 30 }, () => 0));
            expect(getInitialTurnStartByRows(messages, buildTurnWindowModel(messages))).toBe(30 - TURN_WINDOW_DEFAULTS.initialTurns);
        });

        test('reveals older turns a row batch at a time, at least one turn', () => {
            const messages = conversation([100, 5, 5, 5, 5, 5, 5, 5]);
            const model = buildTurnWindowModel(messages);

            expect(getRevealTurnStartByRows(messages, model, 8)).toBe(3);
            expect(getRevealTurnStartByRows(messages, model, 1)).toBe(0);
            expect(getRevealTurnStartByRows(messages, model, 0)).toBe(0);
        });
    });
});
