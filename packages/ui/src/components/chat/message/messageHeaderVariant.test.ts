import { describe, expect, test } from 'bun:test';

import { resolveMessageHeaderVariant, resolveMessageHeaderVariantDisplay } from './messageHeaderVariant';
import { resolveUserMessageVariant } from '@/sync/subtask-agent';
import { formatEffortLabel } from '../mobileControlsUtils';

describe('resolveMessageHeaderVariant', () => {
    test('retains primary-agent effort when the catalog is unavailable or has changed', () => {
        expect(resolveMessageHeaderVariant('high', [])).toBe('high');
        expect(resolveMessageHeaderVariant('ultra', ['low', 'medium', 'high'])).toBe('ultra');
        expect(resolveMessageHeaderVariant(' High ', ['high'])).toBe('high');
    });

    test('formats recorded compound and provider-specific effort without requiring catalog membership', () => {
        for (const variant of ['thinking-xhigh', 'xhigh-thinking', 'extra-high-thinking']) {
            expect(formatEffortLabel(resolveMessageHeaderVariant(variant, ['low', 'high']), { providerId: 'cursor-acp' })).toBe('Extra High');
        }
        expect(formatEffortLabel(resolveMessageHeaderVariant('low', []), { providerId: 'openai' })).toBe('Light');
    });

    test('does not replace absent or explicit default effort with a catalog selection', () => {
        for (const variant of [undefined, null, '', '   ']) {
            expect(resolveMessageHeaderVariant(variant, ['medium', 'high'])).toBeUndefined();
        }
        expect(resolveMessageHeaderVariant(' FAST ', [])).toBeUndefined();
        expect(resolveMessageHeaderVariant(resolveUserMessageVariant({ model: { variant: null }, variant: 'high' }), [])).toBeUndefined();
        expect(resolveMessageHeaderVariant(resolveUserMessageVariant({ variant: 'high' }), [])).toBe('high');
    });
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
