import { describe, expect, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';

import {
    formatAgentLabel,
    formatEffortLabel,
    formatVisibleEffortLabel,
    getCursorAcpVariantDisplayLabel,
    getCursorAcpVariantState,
    getCycledPrimaryAgentName,
    resolveCursorAcpVariantSelection,
    shouldHideCursorAcpFastModel,
} from './mobileControlsUtils';
import { resolveSelectableAgentOptions } from './modelControlAgentOptions';

describe('formatAgentLabel', () => {
    test('normalizes builder agent names', () => {
        expect(formatAgentLabel('build')).toBe('Builder');
        expect(formatAgentLabel('builder')).toBe('Builder');
    });

    test('capitalizes regular agent names', () => {
        expect(formatAgentLabel('plan')).toBe('Plan');
    });

    test('handles an empty agent name', () => {
        expect(formatAgentLabel('')).toBe('');
    });
});

describe('getCycledPrimaryAgentName', () => {
    test('cycles through the canonical builder agent only once when build alias is present', () => {
        const selectableAgents = resolveSelectableAgentOptions([
            { name: 'build', mode: 'primary' },
            { name: 'builder', mode: 'primary' },
            { name: 'orchestrator', mode: 'primary' },
        ] as Agent[], []);

        expect(selectableAgents.map((agent) => agent.name)).toEqual(['builder', 'orchestrator']);
        expect(getCycledPrimaryAgentName(selectableAgents, 'orchestrator')).toBe('builder');
        expect(getCycledPrimaryAgentName(selectableAgents, 'builder')).toBe('orchestrator');
    });

    test('returns null when only one selectable primary agent remains', () => {
        const selectableAgents = resolveSelectableAgentOptions([
            { name: 'build', mode: 'primary' },
            { name: 'builder', mode: 'primary' },
        ] as Agent[], []);

        expect(selectableAgents.map((agent) => agent.name)).toEqual(['builder']);
        expect(getCycledPrimaryAgentName(selectableAgents, 'builder')).toBeNull();
    });
});

describe('formatVisibleEffortLabel', () => {
    test('shows medium when default is selected and medium is a supported thinking level', () => {
        expect(formatVisibleEffortLabel(undefined, ['minimal', 'low', 'medium', 'high'])).toBe('Medium');
    });

    test('shows the first supported thinking level when default is selected and medium is unavailable', () => {
        expect(formatVisibleEffortLabel(undefined, ['low', 'high'])).toBe('Light');
    });

    test('shows the selected thinking level when an explicit variant is selected', () => {
        expect(formatVisibleEffortLabel('high', ['minimal', 'low', 'medium', 'high'])).toBe('High');
    });

    test('formats stale compound Cursor thinking levels as effort labels', () => {
        expect(formatVisibleEffortLabel('extra-high-thinking', ['extra-high-thinking'])).toBe('Extra High');
        expect(formatVisibleEffortLabel('xhigh-thinking', ['xhigh-thinking'])).toBe('Extra High');
        expect(formatVisibleEffortLabel('low-thinking', ['low-thinking'])).toBe('Light');
    });

    test('returns null when the model has no thinking levels', () => {
        expect(formatVisibleEffortLabel(undefined, [])).toBeNull();
    });

    test('keeps Extra High and Ultra as separate labels', () => {
        expect(formatEffortLabel('low')).toBe('Light');
        expect(formatEffortLabel('xhigh')).toBe('Extra High');
        expect(formatEffortLabel('extra-high')).toBe('Extra High');
        expect(formatEffortLabel('ultra')).toBe('Ultra');
    });
});

describe('Cursor ACP variant helpers', () => {
    const provider = {
        id: 'cursor-acp',
        models: [
            {
                id: 'claude-opus-4-7',
                name: 'Opus 4.7',
                variants: {
                    low: {},
                    medium: {},
                    high: {},
                    'extra-high': {},
                    ultra: {},
                    'thinking-low': {},
                    'thinking-medium': {},
                    'thinking-high': {},
                    'thinking-ultra': {},
                    thinking: {},
                },
            },
            {
                id: 'claude-opus-4-7-fast',
                name: 'Opus 4.7 Fast',
                variants: {
                    low: {},
                    medium: {},
                    'thinking-low': {},
                    'thinking-medium': {},
                },
            },
            {
                id: 'composer-2',
                name: 'Composer 2',
            },
            {
                id: 'composer-2-fast',
                name: 'Composer 2 Fast',
            },
            {
                id: 'composer-2.5',
                name: 'Composer 2.5',
            },
            {
                id: 'composer-2.5-fast',
                name: 'Composer 2.5 Fast',
            },
        ],
    };

    test('derives Cursor toggles and clean effort options from canonical variants', () => {
        const state = getCursorAcpVariantState(provider, 'claude-opus-4-7', 'thinking-medium');

        expect(state?.fastEnabled).toBe(false);
        expect(state?.canToggleFast).toBe(true);
        expect(state?.thinkingEnabled).toBe(true);
        expect(state?.canToggleThinking).toBe(true);
        expect(state?.selectedEffort).toBe('medium');
        expect(state?.effortOptions).toEqual(['low', 'medium', 'high', 'extra-high', 'ultra']);
        expect(state?.visibleVariantOptions).toEqual(['low', 'medium', 'high', 'extra-high', 'ultra']);
    });

    test('normalizes stale Cursor thinking suffixes for UI state', () => {
        const state = getCursorAcpVariantState(provider, 'claude-opus-4-7', 'medium-thinking');

        expect(state?.thinkingEnabled).toBe(true);
        expect(state?.selectedEffort).toBe('medium');
        expect(state?.normalizedVariant).toBe('thinking-medium');
    });

    test('maps Cursor Thinking toggle to canonical thinking variants', () => {
        expect(resolveCursorAcpVariantSelection(provider, 'claude-opus-4-7', 'medium', { thinkingEnabled: true })).toEqual({
            modelId: 'claude-opus-4-7',
            variant: 'thinking-medium',
        });
        expect(resolveCursorAcpVariantSelection(provider, 'claude-opus-4-7', 'thinking-medium', { thinkingEnabled: false })).toEqual({
            modelId: 'claude-opus-4-7',
            variant: 'medium',
        });
    });

    test('selects Ultra without collapsing Extra High', () => {
        expect(resolveCursorAcpVariantSelection(provider, 'claude-opus-4-7', 'extra-high', { effort: 'ultra' })).toEqual({
            modelId: 'claude-opus-4-7',
            variant: 'ultra',
        });
        expect(resolveCursorAcpVariantSelection(provider, 'claude-opus-4-7', 'ultra', { effort: 'extra-high' })).toEqual({
            modelId: 'claude-opus-4-7',
            variant: 'extra-high',
        });
        expect(resolveCursorAcpVariantSelection(provider, 'claude-opus-4-7', 'ultra', { thinkingEnabled: true })).toEqual({
            modelId: 'claude-opus-4-7',
            variant: 'thinking-ultra',
        });
    });

    test('maps Cursor Fast toggle to paired fast model while preserving effort and thinking', () => {
        expect(resolveCursorAcpVariantSelection(provider, 'claude-opus-4-7', 'thinking-medium', { fastEnabled: true })).toEqual({
            modelId: 'claude-opus-4-7-fast',
            variant: 'thinking-medium',
        });
        expect(resolveCursorAcpVariantSelection(provider, 'claude-opus-4-7-fast', 'thinking-medium', { fastEnabled: false })).toEqual({
            modelId: 'claude-opus-4-7',
            variant: 'thinking-medium',
        });
    });

    test('hides paired Cursor fast rows from visible model lists', () => {
        expect(shouldHideCursorAcpFastModel(provider, 'claude-opus-4-7-fast')).toBe(true);
        expect(shouldHideCursorAcpFastModel(provider, 'claude-opus-4-7')).toBe(false);
        expect(shouldHideCursorAcpFastModel({ id: 'anthropic', models: provider.models }, 'claude-opus-4-7-fast')).toBe(false);
    });

    test('derives a Cursor Fast toggle even when the model has no thinking variants', () => {
        const state = getCursorAcpVariantState(provider, 'composer-2.5', undefined);

        expect(state?.canToggleFast).toBe(true);
        expect(state?.fastEnabled).toBe(false);
        expect(state?.canToggleThinking).toBe(false);
        expect(state?.visibleVariantOptions).toEqual([]);
        expect(getCursorAcpVariantDisplayLabel(state)).toBe('Default');
        const recordedMediumState = getCursorAcpVariantState(provider, 'composer-2.5', 'medium');
        expect(recordedMediumState?.selectedEffort).toBe(undefined);
        expect(getCursorAcpVariantDisplayLabel(recordedMediumState)).toBe('Default');
        const fastState = getCursorAcpVariantState(provider, 'composer-2.5-fast', undefined);
        expect(fastState?.fastEnabled).toBe(true);
        expect(getCursorAcpVariantDisplayLabel(fastState)).toBeNull();
        expect(resolveCursorAcpVariantSelection(provider, 'composer-2.5', undefined, { fastEnabled: true })).toEqual({
            modelId: 'composer-2.5-fast',
            variant: undefined,
        });
        expect(resolveCursorAcpVariantSelection(provider, 'composer-2.5-fast', undefined, { fastEnabled: false })).toEqual({
            modelId: 'composer-2.5',
            variant: undefined,
        });
    });

    test('uses effort labels instead of the fast-only Default fallback when thinking levels exist', () => {
        const state = getCursorAcpVariantState(provider, 'claude-opus-4-7', undefined);

        expect(state?.canToggleFast).toBe(true);
        expect(state?.canToggleThinking).toBe(true);
        expect(state?.visibleVariantOptions).toEqual(['low', 'medium', 'high', 'extra-high', 'ultra']);
        expect(getCursorAcpVariantDisplayLabel(state)).toBe('Medium');
    });

    test('hides paired Composer 2.5 Fast row from visible model lists', () => {
        expect(shouldHideCursorAcpFastModel(provider, 'composer-2.5-fast')).toBe(true);
        expect(shouldHideCursorAcpFastModel(provider, 'composer-2.5')).toBe(false);
    });
});
