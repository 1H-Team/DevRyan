import { getProviderDisplayName } from '@/lib/providers/display';
import { comparePickerLabels, sortProvidersByDisplayName } from '@/lib/providers/sorting';

/**
 * Pure data layer for the composer model picker: provider tabs, the
 * favorites tab and the per-provider "Legacy models" split.
 */

export const FAVORITES_MODEL_PICKER_TAB_ID = '__favorites__';

const DAY_MS = 24 * 60 * 60 * 1000;
export const LEGACY_MODEL_AGE_MS = 365 * DAY_MS;

export type ModelPickerModelLike = { id?: string; name?: string; status?: unknown; release_date?: unknown };

export type ModelPickerProviderLike<M extends ModelPickerModelLike> = {
    id?: string;
    name?: string;
    models?: readonly M[];
};

export type ModelPickerFavoriteLike<M extends ModelPickerModelLike> = {
    model: M;
    providerID: string;
    modelID: string;
};

export interface ModelPickerRow<M extends ModelPickerModelLike> {
    model: M;
    /** Execution provider id (what a selection is applied with). */
    providerID: string;
    modelID: string;
    providerName: string;
    isLegacy: boolean;
}

export interface ModelPickerTab<M extends ModelPickerModelLike> {
    id: string;
    kind: 'favorites' | 'provider';
    /** Provider id shown in the rail (the logo source); undefined for favorites. */
    providerID?: string;
    label: string;
    primary: ModelPickerRow<M>[];
    legacy: ModelPickerRow<M>[];
}

export const parseModelReleaseTime = (value: unknown): number | null => {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return null;
    }
    const time = Date.parse(value.trim());
    return Number.isFinite(time) ? time : null;
};

export const isModelLegacyCandidate = (
    model: ModelPickerModelLike,
    releaseTime: number | null,
    now: number,
): boolean => {
    if (model.status === 'deprecated') {
        return true;
    }
    return releaseTime !== null && now - releaseTime > LEGACY_MODEL_AGE_MS;
};

const compareRowsNewestFirst = <M extends ModelPickerModelLike>(
    a: { row: ModelPickerRow<M>; releaseTime: number | null; label: string },
    b: { row: ModelPickerRow<M>; releaseTime: number | null; label: string },
): number => {
    if (a.releaseTime !== b.releaseTime) {
        if (a.releaseTime === null) return 1;
        if (b.releaseTime === null) return -1;
        return b.releaseTime - a.releaseTime;
    }
    const labelComparison = comparePickerLabels(a.label, b.label);
    if (labelComparison !== 0) {
        return labelComparison;
    }
    return a.row.modelID.localeCompare(b.row.modelID);
};

export const buildModelPickerRefKey = (providerID: string, modelID: string): string => `${providerID}/${modelID}`;

export interface BuildModelPickerTabsInput<M extends ModelPickerModelLike> {
    /** Visible providers, already filtered for hidden/unavailable models and display-named. */
    providers: readonly ModelPickerProviderLike<M>[];
    /** Favorites in user order, already filtered for visibility. */
    favorites: readonly ModelPickerFavoriteLike<M>[];
    now: number;
    favoritesLabel: string;
    getExecutionProviderId: (providerID: string, model: M) => string;
    getProviderName: (providerID: string) => string;
    getModelLabel: (model: M) => string;
    isCurrentModel: (providerID: string, modelID: string) => boolean;
    /** Fallback release date (e.g. models.dev metadata) when the model has none. */
    getFallbackReleaseDate?: (providerID: string, modelID: string) => string | undefined;
}

export const buildModelPickerTabs = <M extends ModelPickerModelLike>({
    providers,
    favorites,
    now,
    favoritesLabel,
    getExecutionProviderId,
    getProviderName,
    getModelLabel,
    isCurrentModel,
    getFallbackReleaseDate,
}: BuildModelPickerTabsInput<M>): ModelPickerTab<M>[] => {
    const favoriteKeys = new Set(favorites.map(({ providerID, modelID }) => buildModelPickerRefKey(providerID, modelID)));

    const resolveReleaseTime = (model: M, providerID: string, modelID: string): number | null => (
        parseModelReleaseTime(model.release_date)
        ?? parseModelReleaseTime(getFallbackReleaseDate?.(providerID, modelID))
    );

    const tabs: ModelPickerTab<M>[] = [];

    if (favorites.length > 0) {
        tabs.push({
            id: FAVORITES_MODEL_PICKER_TAB_ID,
            kind: 'favorites',
            label: favoritesLabel,
            primary: favorites.map(({ model, providerID, modelID }) => ({
                model,
                providerID,
                modelID,
                providerName: getProviderName(providerID),
                isLegacy: false,
            })),
            legacy: [],
        });
    }

    const orderedProviders = sortProvidersByDisplayName(providers.map((provider) => {
        const id = typeof provider.id === 'string' ? provider.id : '';
        return {
            ...provider,
            id,
            name: getProviderDisplayName({ id, name: provider.name || getProviderName(id) }),
        };
    }));

    for (const provider of orderedProviders) {
        const providerId = typeof provider.id === 'string' ? provider.id : '';
        if (!providerId) {
            continue;
        }
        const models = Array.isArray(provider.models) ? provider.models : [];
        const providerName = provider.name;
        const primary: Array<{ row: ModelPickerRow<M>; releaseTime: number | null; label: string }> = [];
        const legacy: Array<{ row: ModelPickerRow<M>; releaseTime: number | null; label: string }> = [];

        for (const model of models) {
            const modelID = typeof model.id === 'string' ? model.id : '';
            if (!modelID) {
                continue;
            }
            const executionProviderId = getExecutionProviderId(providerId, model);
            const releaseTime = resolveReleaseTime(model, executionProviderId, modelID);
            const pinned = favoriteKeys.has(buildModelPickerRefKey(executionProviderId, modelID))
                || isCurrentModel(executionProviderId, modelID);
            const isLegacy = !pinned && isModelLegacyCandidate(model, releaseTime, now);
            const entry = {
                row: {
                    model,
                    providerID: executionProviderId,
                    modelID,
                    providerName,
                    isLegacy,
                },
                releaseTime,
                label: getModelLabel(model),
            };
            (isLegacy ? legacy : primary).push(entry);
        }

        if (primary.length === 0 && legacy.length === 0) {
            continue;
        }

        // Never leave a tab empty: a provider whose models are all legacy shows them directly.
        const allLegacy = primary.length === 0;
        const primaryEntries = allLegacy ? legacy : primary;
        const legacyEntries = allLegacy ? [] : legacy;

        tabs.push({
            id: providerId,
            kind: 'provider',
            providerID: providerId,
            label: providerName,
            primary: primaryEntries.sort(compareRowsNewestFirst).map(({ row }) => (allLegacy ? { ...row, isLegacy: false } : row)),
            legacy: legacyEntries.sort(compareRowsNewestFirst).map(({ row }) => row),
        });
    }

    return tabs;
};

/**
 * Flat search results across every provider tab (legacy included), in tab order.
 * The favorites tab is skipped because its rows also live in their provider tabs.
 */
export const searchModelPickerTabs = <M extends ModelPickerModelLike>(
    tabs: readonly ModelPickerTab<M>[],
    query: string,
    matches: (candidate: string, query: string) => boolean,
    getModelLabel: (model: M) => string,
): ModelPickerRow<M>[] => {
    const normalizedQuery = query.trim();
    const results: ModelPickerRow<M>[] = [];
    const seen = new Set<string>();
    for (const tab of tabs) {
        if (tab.kind !== 'provider') {
            continue;
        }
        for (const row of [...tab.primary, ...tab.legacy]) {
            const key = buildModelPickerRefKey(row.providerID, row.modelID);
            if (seen.has(key)) {
                continue;
            }
            const isMatch = normalizedQuery.length === 0
                || matches(getModelLabel(row.model), normalizedQuery)
                || matches(row.providerName, normalizedQuery)
                || matches(row.modelID, normalizedQuery);
            if (isMatch) {
                seen.add(key);
                results.push(row);
            }
        }
    }
    return results;
};

/** Favorites when present, otherwise the tab holding the current model, otherwise the first tab. */
export const resolveDefaultModelPickerTabId = <M extends ModelPickerModelLike>(
    tabs: readonly ModelPickerTab<M>[],
    currentProviderId: string | null | undefined,
    currentModelId: string | null | undefined,
): string | null => {
    if (tabs.length === 0) {
        return null;
    }
    const favoritesTab = tabs.find((tab) => tab.kind === 'favorites');
    if (favoritesTab) {
        return favoritesTab.id;
    }
    if (currentProviderId) {
        const holdsCurrent = tabs.find((tab) => (
            [...tab.primary, ...tab.legacy].some((row) => row.providerID === currentProviderId && row.modelID === currentModelId)
        ));
        if (holdsCurrent) {
            return holdsCurrent.id;
        }
        const byProvider = tabs.find((tab) => tab.providerID === currentProviderId);
        if (byProvider) {
            return byProvider.id;
        }
    }
    return tabs[0].id;
};

export type ModelPickerView<M extends ModelPickerModelLike> =
    | { mode: 'search'; tab: null; rows: ModelPickerRow<M>[]; legacyCount: 0 }
    | { mode: 'tab'; tab: ModelPickerTab<M>; rows: ModelPickerRow<M>[]; legacyCount: number }
    | { mode: 'legacy'; tab: ModelPickerTab<M>; rows: ModelPickerRow<M>[]; legacyCount: number };

export const resolveModelPickerView = <M extends ModelPickerModelLike>({
    tabs,
    activeTabId,
    legacyOpen,
    query,
    matches,
    getModelLabel,
}: {
    tabs: readonly ModelPickerTab<M>[];
    activeTabId: string | null;
    legacyOpen: boolean;
    query: string;
    matches: (candidate: string, query: string) => boolean;
    getModelLabel: (model: M) => string;
}): ModelPickerView<M> | null => {
    if (query.trim().length > 0) {
        return { mode: 'search', tab: null, rows: searchModelPickerTabs(tabs, query, matches, getModelLabel), legacyCount: 0 };
    }
    const tab = tabs.find((entry) => entry.id === activeTabId) ?? tabs[0];
    if (!tab) {
        return null;
    }
    if (legacyOpen && tab.legacy.length > 0) {
        return { mode: 'legacy', tab, rows: tab.legacy, legacyCount: tab.legacy.length };
    }
    return { mode: 'tab', tab, rows: tab.primary, legacyCount: tab.legacy.length };
};

/** Step through rail tabs, wrapping at both ends. */
export const getAdjacentModelPickerTabId = <M extends ModelPickerModelLike>(
    tabs: readonly ModelPickerTab<M>[],
    activeTabId: string | null,
    direction: 1 | -1,
): string | null => {
    if (tabs.length === 0) {
        return null;
    }
    const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    return tabs[(safeIndex + direction + tabs.length) % tabs.length].id;
};
