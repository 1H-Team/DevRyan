import { getCursorAcpVariantState, parseCursorAcpVariantKey, resolveCursorAcpVariantSelection } from './cursorThinking';
import { getOrderedThinkingVariants, resolveProviderModelVariant, resolveThinkingVariant, type ProviderModelLike } from './variantControls';

type ThinkingProvider = { id?: string; models?: ProviderModelLike[] };

/** Chat policy only: settings and historical/default wire semantics remain untouched. */
export function resolveChatThinkingLevel(value: string | null | undefined, levels: readonly string[]): string | undefined {
    return resolveThinkingVariant(value, levels)
        ?? levels.find((level) => level.toLowerCase() === 'medium')
        ?? levels[Math.floor((levels.length - 1) / 2)];
}

export function getChatThinkingState(provider: ThinkingProvider | undefined, modelId: string | undefined, variant?: string | null) {
    // Native fast-only variants replace effort; do not label their provider-controlled
    // reasoning as Medium. Paired fast models still expose their native efforts.
    if (resolveProviderModelVariant(provider, modelId, variant)?.toLowerCase() === 'fast') {
        return { levels: [], selected: undefined };
    }
    const model = provider?.models?.find((entry) => entry.id === modelId);
    const cursor = getCursorAcpVariantState(provider, modelId, variant);
    const levels = getOrderedThinkingVariants(cursor?.visibleVariantOptions ?? model?.variants, { providerId: provider?.id });
    const selected = resolveChatThinkingLevel(cursor ? parseCursorAcpVariantKey(cursor.normalizedVariant)?.effort : variant, levels);
    return { levels, selected };
}

export function resolveChatThinkingVariant(provider: ThinkingProvider | undefined, modelId: string | undefined, variant?: string | null): string | undefined {
    if (!modelId || !provider?.models?.some((model) => model.id === modelId)) return variant ?? undefined;
    const existing = resolveProviderModelVariant(provider, modelId, variant);
    // A native fast-only variant is a separate mode, not a thinking stop.
    if (existing?.toLowerCase() === 'fast') return existing;
    const cursor = getCursorAcpVariantState(provider, modelId, variant);
    const { selected } = getChatThinkingState(provider, modelId, existing ?? variant);
    if (cursor) {
        if (cursor.normalizedVariant && parseCursorAcpVariantKey(cursor.normalizedVariant)?.effort) return cursor.normalizedVariant;
        if (!selected) return existing;
        return resolveCursorAcpVariantSelection(provider, modelId, variant, { effort: selected }).variant ?? undefined;
    }
    return resolveThinkingVariant(existing, getChatThinkingState(provider, modelId).levels, { providerId: provider.id }) ?? selected;
}
