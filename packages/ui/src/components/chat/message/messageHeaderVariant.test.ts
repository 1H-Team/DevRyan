import { describe, expect, test } from 'bun:test';

import { resolveMessageHeaderVariant, resolveMessageHeaderVariantDisplay } from './messageHeaderVariant';
import { resolveUserMessageVariant } from '@/sync/subtask-agent';

describe('resolveMessageHeaderVariant', () => {
    test('keeps a recorded thinking level when the model supports it', () => {
        expect(resolveMessageHeaderVariant('high', ['minimal', 'low', 'medium', 'high'])).toBe('high');
    });

    test('does not claim a concrete effort for provider default', () => {
        expect(resolveMessageHeaderVariant(undefined, ['minimal', 'low', 'medium', 'high'])).toBeUndefined();
    });

    test('uses canonical user-message effort while provider default suppresses a stale legacy badge', () => {
        const options = ['low', 'medium', 'high'];
        expect(resolveMessageHeaderVariant(resolveUserMessageVariant({
            model: { variant: 'low' }, variant: 'high',
        }), options)).toBe('low');
        expect(resolveMessageHeaderVariant(resolveUserMessageVariant({
            model: { variant: '' }, variant: 'high',
        }), options)).toBeUndefined();
    });

    test('does not infer historical effort from catalog order', () => {
        expect(resolveMessageHeaderVariant(undefined, ['low', 'high'])).toBeUndefined();
    });

    test('hides the thinking badge for models without thinking variants', () => {
        expect(resolveMessageHeaderVariant(undefined, [])).toBe(undefined);
    });

    test('keeps fast separate from the visible thinking level', () => {
        expect(resolveMessageHeaderVariantDisplay({
            recordedVariant: 'fast',
            modelVariantOptions: ['low', 'medium'],
            fastEnabled: true,
        })).toEqual({
            fastEnabled: true,
            variant: undefined,
        });
    });
});
