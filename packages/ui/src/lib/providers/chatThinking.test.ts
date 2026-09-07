import { describe, expect, test } from 'bun:test';
import { getChatThinkingState, resolveChatThinkingLevel, resolveChatThinkingVariant } from './chatThinking';
import { resolveCursorAcpVariantSelection } from './cursorThinking';
import { resolveProviderModelVariant } from './variantControls';

const provider = (levels: string[], id = 'fixture') => ({ id, models: [{ id: 'model', variants: Object.fromEntries(levels.map(level => [level, {}])) }] });

describe('chat thinking policy', () => {
    for (const [levels, expected] of [
        [[], undefined], [['high'], 'high'], [['low', 'high'], 'low'],
        [['low', 'medium', 'high'], 'medium'], [['low', 'medium', 'high', 'xhigh'], 'medium'],
        [['minimal', 'low', 'high', 'max', 'ultra'], 'high'], [['budget-a', 'budget-b', 'budget-c'], 'budget-b'],
    ] as const) {
        test(`fallback for ${levels.length} levels: ${levels.join(',')}`, () => {
            for (const value of [null, undefined, 'removed']) expect(resolveChatThinkingLevel(value, levels)).toBe(expected);
            for (const value of levels) expect(resolveChatThinkingLevel(value, levels)).toBe(value);
        });
    }
    test('uses exact provider keys and never changes the settings resolver', () => {
        const catalog = provider(['Low', 'Medium', 'High']);
        expect(resolveChatThinkingVariant(catalog, 'model', null)).toBe('Medium');
        expect(resolveChatThinkingVariant(catalog, 'model', 'high')).toBe('High');
        expect(resolveProviderModelVariant(catalog, 'model', null)).toBeUndefined();
        expect(resolveChatThinkingVariant(provider([]), 'model', null)).toBeUndefined();
    });
    test('OpenAI keeps native none remapping and Fast remains a separate mode', () => {
        const catalog = provider(['none', 'low', 'medium', 'high', 'fast'], 'openai');
        expect(getChatThinkingState(catalog, 'model', null).levels).toEqual(['low', 'medium', 'high']);
        expect(resolveChatThinkingVariant(catalog, 'model', 'none')).toBe('low');
        expect(resolveChatThinkingVariant(catalog, 'model', 'fast')).toBe('fast');
        expect(getChatThinkingState(catalog, 'model', 'fast')).toEqual({ levels: [], selected: undefined });
    });
    test('Cursor preserves native compound keys, including thinking-only effort catalogs', () => {
        const catalog = provider(['thinking-low', 'thinking-medium', 'thinking-high', 'thinking-xhigh'], 'cursor-acp');
        expect(resolveChatThinkingVariant(catalog, 'model', null)).toBe('thinking-medium');
        expect(resolveChatThinkingVariant(catalog, 'model', 'thinking-xhigh')).toBe('thinking-xhigh');
        expect(getChatThinkingState(catalog, 'model', 'thinking-xhigh').selected).toBe('extra-high');
    });
    test('Cursor without Medium uses the lower middle native effort and preserves paired fast model identity', () => {
        const catalog = provider(['low', 'high', 'xhigh', 'max'], 'cursor-acp');
        catalog.models.push({ ...catalog.models[0]!, id: 'model-fast' });
        expect(resolveChatThinkingVariant(catalog, 'model-fast', null)).toBe('high');
    });
});

test('extra-high aliases sort before max and ultra without changing their native keys', () => {
    const catalog = provider(['ultra', 'extra_high', 'low', 'max', 'medium', 'high']);
    expect(getChatThinkingState(catalog, 'model').levels).toEqual(['low', 'medium', 'high', 'extra_high', 'max', 'ultra']);
});

test('Cursor mode-only defaults resolve to a real effort, and missing compounds keep the requested stop', () => {
    const catalog = provider(['low', 'medium', 'extra-high', 'thinking', 'thinking-medium'], 'cursor-acp');
    expect(resolveChatThinkingVariant(catalog, 'model', 'thinking')).toBe('thinking-medium');
    expect(resolveCursorAcpVariantSelection(catalog, 'model', 'thinking-medium', { effort: 'extra-high' }).variant).toBe('extra-high');
});
