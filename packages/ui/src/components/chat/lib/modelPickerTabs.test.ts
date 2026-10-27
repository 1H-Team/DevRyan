import { describe, expect, test } from 'bun:test';
import { getProviderModelsForDisplay } from '@/components/sections/providers/providerSorting';

import {
    FAVORITES_MODEL_PICKER_TAB_ID,
    LEGACY_MODEL_AGE_MS,
    buildModelPickerTabs,
    getAdjacentModelPickerTabId,
    isModelLegacyCandidate,
    parseModelReleaseTime,
    resolveDefaultModelPickerTabId,
    resolveModelPickerView,
    searchModelPickerTabs,
    type ModelPickerModelLike,
    type ModelPickerProviderLike,
} from './modelPickerTabs';

type TestModel = ModelPickerModelLike & { id: string };

const NOW = Date.parse('2026-09-25T00:00:00Z');
const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const model = (id: string, name: string, release_date?: string, status?: string): TestModel => ({
    id,
    name,
    ...(release_date ? { release_date } : {}),
    ...(status ? { status } : {}),
});

const contains = (candidate: string, query: string) => candidate.toLowerCase().includes(query.toLowerCase());
const label = (entry: TestModel) => entry.name ?? entry.id;

const build = ({
    providers,
    favorites = [],
    current = null,
    fallbackDates = {},
}: {
    providers: ModelPickerProviderLike<TestModel>[];
    favorites?: Array<{ providerID: string; model: TestModel }>;
    current?: { providerID: string; modelID: string } | null;
    fallbackDates?: Record<string, string>;
}) => buildModelPickerTabs<TestModel>({
    providers,
    favorites: favorites.map(({ providerID, model: entry }) => ({ providerID, modelID: entry.id, model: entry })),
    now: NOW,
    favoritesLabel: 'Favorites',
    getExecutionProviderId: (providerID) => providerID,
    getProviderName: (providerID) => providers.find((provider) => provider.id === providerID)?.name ?? providerID,
    isCurrentModel: (providerID, modelID) => current?.providerID === providerID && current?.modelID === modelID,
    getFallbackReleaseDate: (providerID, modelID) => fallbackDates[`${providerID}/${modelID}`],
});

describe('model picker release classification', () => {
    test('parses release dates and rejects missing or invalid values', () => {
        expect(parseModelReleaseTime('2026-09-01')).toBe(Date.parse('2026-09-01'));
        expect(parseModelReleaseTime('')).toBeNull();
        expect(parseModelReleaseTime('not-a-date')).toBeNull();
        expect(parseModelReleaseTime(undefined)).toBeNull();
    });

    test('legacy means deprecated or older than 12 months; a missing date is not legacy', () => {
        expect(isModelLegacyCandidate({ status: 'deprecated' }, NOW, NOW)).toBe(true);
        expect(isModelLegacyCandidate({}, NOW - LEGACY_MODEL_AGE_MS - 1, NOW)).toBe(true);
        expect(isModelLegacyCandidate({}, NOW - LEGACY_MODEL_AGE_MS, NOW)).toBe(false);
        expect(isModelLegacyCandidate({ status: 'beta' }, null, NOW)).toBe(false);
    });
});

describe('buildModelPickerTabs', () => {
    const anthropic: ModelPickerProviderLike<TestModel> = {
        id: 'anthropic',
        name: 'Claude',
        models: [
            model('sonnet-5', 'Claude Sonnet 5', daysAgo(5)),
            model('opus-5-5', 'Claude Opus 5.5', daysAgo(120)),
            model('opus-3', 'Claude Opus 3', daysAgo(900)),
            model('haiku-2', 'Claude Haiku 2', daysAgo(1000), 'deprecated'),
            model('mystery', 'Mystery Model'),
        ],
    };

    test('orders provider tabs alphabetically by displayed name after favorites', () => {
        const providers = [
            { id: 'z', name: 'Zeta', models: [model('z', 'Z')] },
            { id: 'openai', name: 'OpenAI', models: [model('o', 'O')] },
            { id: 'anthropic', name: 'Anthropic', models: [model('a', 'A')] },
            { id: 'b', name: 'beta', models: [model('b', 'B')] },
        ];
        const tabs = build({ providers, favorites: [{ providerID: 'z', model: providers[0].models[0] }] });
        expect(tabs.map((tab) => tab.id)).toEqual([FAVORITES_MODEL_PICKER_TAB_ID, 'b', 'openai', 'anthropic', 'z']);
        expect(providers.map((provider) => provider.id)).toEqual(['z', 'openai', 'anthropic', 'b']);
    });

    test('matches settings order within main and legacy groups despite conflicting release dates', () => {
        const [tab] = build({ providers: [anthropic] });
        expect(tab.kind).toBe('provider');
        expect(tab.primary.map((row) => row.modelID)).toEqual(['opus-5-5', 'sonnet-5', 'mystery']);
        expect(tab.legacy.map((row) => row.modelID)).toEqual(['haiku-2', 'opus-3']);
        expect(tab.legacy.every((row) => row.isLegacy)).toBe(true);
    });

    test('matches settings numeric, missing-name and duplicate-name ordering without mutating inputs', () => {
        const entries: TestModel[] = [
            model('ten', 'Model 10', daysAgo(1)),
            model('two', 'model 2', daysAgo(100)),
            { id: 'Model 3' },
            model('z', 'Shared'),
            model('a', 'shared'),
        ];
        const oldEntries = entries.map((entry) => ({ ...entry, id: `old-${entry.id}`, status: 'deprecated' }));
        const providers = [{ id: 'p', name: 'P', models: [...entries, ...oldEntries] }];
        const before = structuredClone(providers);
        const [tab] = build({ providers });
        expect(tab.primary.map((row) => row.modelID)).toEqual(getProviderModelsForDisplay({ models: entries }).map((entry) => entry.id));
        expect(tab.primary.map((row) => row.modelID)).toEqual(['two', 'Model 3', 'ten', 'a', 'z']);
        expect(tab.legacy.map((row) => row.modelID)).toEqual(getProviderModelsForDisplay({ models: oldEntries }).map((entry) => entry.id));
        expect(providers).toEqual(before);
    });

    test('uses metadata release dates for legacy classification', () => {
        const [tab] = build({
            providers: [{ id: 'p', name: 'P', models: [model('a', 'A'), model('b', 'B', daysAgo(10))] }],
            fallbackDates: { 'p/a': daysAgo(800) },
        });
        expect(tab.primary.map((row) => row.modelID)).toEqual(['b']);
        expect(tab.legacy.map((row) => row.modelID)).toEqual(['a']);
    });

    test('favorites and the current model are never legacy', () => {
        const opus3 = anthropic.models![2];
        const tabs = build({
            providers: [anthropic],
            favorites: [{ providerID: 'anthropic', model: opus3 }],
            current: { providerID: 'anthropic', modelID: 'haiku-2' },
        });
        const providerTab = tabs.find((tab) => tab.id === 'anthropic')!;
        expect(providerTab.legacy).toEqual([]);
        expect(providerTab.primary.map((row) => row.modelID)).toContain('opus-3');
        expect(providerTab.primary.map((row) => row.modelID)).toContain('haiku-2');
    });

    test('adds a favorites tab first, in user order', () => {
        const favorites = [
            { providerID: 'anthropic', model: anthropic.models![0] },
            { providerID: 'anthropic', model: anthropic.models![1] },
        ];
        const before = structuredClone(favorites);
        const tabs = build({ providers: [anthropic], favorites });
        expect(favorites).toEqual(before);
        expect(tabs[1].primary.map((row) => row.modelID)).toEqual(['opus-5-5', 'sonnet-5', 'mystery']);
        expect(tabs[0].id).toBe(FAVORITES_MODEL_PICKER_TAB_ID);
        expect(tabs[0].primary.map((row) => row.modelID)).toEqual(['sonnet-5', 'opus-5-5']);
        expect(tabs[0].primary[0].providerName).toBe('Claude');
    });

    test('a provider whose models are all legacy shows them in primary', () => {
        const [tab] = build({
            providers: [{ id: 'old', name: 'Old', models: [model('y', 'Y', daysAgo(800)), model('x', 'X', daysAgo(900))] }],
        });
        expect(tab.primary.map((row) => row.modelID)).toEqual(['x', 'y']);
        expect(tab.primary.every((row) => !row.isLegacy)).toBe(true);
        expect(tab.legacy).toEqual([]);
    });

    test('skips providers without models', () => {
        expect(build({ providers: [{ id: 'empty', name: 'Empty', models: [] }] })).toEqual([]);
    });
});

describe('model picker search and views', () => {
    const tabs = build({
        providers: [
            { id: 'anthropic', name: 'Claude', models: [model('opus-5-5', 'Claude Opus 5.5', daysAgo(120)), model('opus-3', 'Claude Opus 3', daysAgo(900))] },
            { id: 'openai', name: 'OpenAI', models: [model('gpt-6', 'GPT-6', daysAgo(20))] },
        ],
        favorites: [{ providerID: 'openai', model: model('gpt-6', 'GPT-6', daysAgo(20)) }],
    });

    test('search spans every provider, includes legacy, and skips the favorites duplicate', () => {
        expect(searchModelPickerTabs(tabs, 'opus', contains, label).map((row) => row.modelID)).toEqual(['opus-5-5', 'opus-3']);
        const chatgptResults = searchModelPickerTabs(tabs, 'chatgpt', contains, label);
        expect(chatgptResults.map((row) => row.modelID)).toEqual(['gpt-6']);
        expect(chatgptResults[0]?.providerID).toBe('openai');
        expect(chatgptResults[0]?.providerName).toBe('ChatGPT');
    });

    test('resolves search, tab, and legacy views', () => {
        const search = resolveModelPickerView({ tabs, activeTabId: 'anthropic', legacyOpen: true, query: 'gpt', matches: contains, getModelLabel: label });
        expect(search?.mode).toBe('search');

        const tabView = resolveModelPickerView({ tabs, activeTabId: 'anthropic', legacyOpen: false, query: '', matches: contains, getModelLabel: label });
        expect(tabView?.mode).toBe('tab');
        expect(tabView?.rows.map((row) => row.modelID)).toEqual(['opus-5-5']);
        expect(tabView?.legacyCount).toBe(1);

        const legacyView = resolveModelPickerView({ tabs, activeTabId: 'anthropic', legacyOpen: true, query: '', matches: contains, getModelLabel: label });
        expect(legacyView?.mode).toBe('legacy');
        expect(legacyView?.rows.map((row) => row.modelID)).toEqual(['opus-3']);

        const missingTab = resolveModelPickerView({ tabs, activeTabId: 'gone', legacyOpen: false, query: '', matches: contains, getModelLabel: label });
        expect(missingTab?.tab?.id).toBe(FAVORITES_MODEL_PICKER_TAB_ID);
    });

    test('default tab prefers favorites, then the current model provider, then the first tab', () => {
        expect(resolveDefaultModelPickerTabId(tabs, 'anthropic', 'opus-5-5')).toBe(FAVORITES_MODEL_PICKER_TAB_ID);
        const withoutFavorites = tabs.filter((tab) => tab.kind === 'provider');
        expect(resolveDefaultModelPickerTabId(withoutFavorites, 'openai', 'gpt-6')).toBe('openai');
        expect(resolveDefaultModelPickerTabId(withoutFavorites, 'unknown', 'x')).toBe('openai');
        expect(resolveDefaultModelPickerTabId([], 'openai', 'gpt-6')).toBeNull();
    });

    test('adjacent tab wraps in both directions', () => {
        expect(getAdjacentModelPickerTabId(tabs, FAVORITES_MODEL_PICKER_TAB_ID, -1)).toBe('anthropic');
        expect(getAdjacentModelPickerTabId(tabs, 'anthropic', 1)).toBe(FAVORITES_MODEL_PICKER_TAB_ID);
        expect(getAdjacentModelPickerTabId(tabs, 'openai', 1)).toBe('anthropic');
    });
});
