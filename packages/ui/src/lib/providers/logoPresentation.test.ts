import { describe, expect, test } from 'bun:test';
import { shouldPreserveProviderLogoColor } from './logoPresentation';

describe('shouldPreserveProviderLogoColor', () => {
    test('keeps Claude-compatible provider marks in their orange brand color', () => {
        for (const providerId of [
            'anthropic',
            'anthropic-oauth',
            'claude',
            'opencode-with-claude',
            'provider.anthropic',
            'models.claude/claude-opus-4-7',
        ]) {
            expect(shouldPreserveProviderLogoColor(providerId)).toBe(true);
        }
    });

    test('allows monochrome provider marks to follow theme contrast', () => {
        expect(shouldPreserveProviderLogoColor('openai')).toBe(false);
        expect(shouldPreserveProviderLogoColor(undefined)).toBe(false);
    });
});
