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
    const model = provider?.models?.find((entry) => entry.id === modelId);
    if (variant?.toLowerCase() === 'fast' && Object.hasOwn(model?.variants ?? {}, variant)) {
        return { levels: [], selected: undefined };
    }
    const cursor = getCursorAcpVariantState(provider, modelId, variant);
    const levels = getOrderedThinkingVariants(cursor?.visibleVariantOptions ?? model?.variants, { providerId: provider?.id });
    const explicit = typeof variant === 'string' && variant.trim() ? variant.trim() : undefined;
    const effort = cursor && explicit ? parseCursorAcpVariantKey(explicit)?.effort ?? explicit : explicit;
    const selected = variant === null ? null : effort
        ? levels.find(level => level.toLowerCase() === effort.toLowerCase()) ?? effort
        : resolveChatThinkingLevel(undefined, levels);
    return { levels, selected };
}

export function resolveChatThinkingVariant(provider: ThinkingProvider | undefined, modelId: string | undefined, variant?: string | null): string | undefined {
    if (variant === null) return undefined;
    if (!modelId || !provider?.models?.some((model) => model.id === modelId)) return variant ?? undefined;
    const existing = resolveProviderModelVariant(provider, modelId, variant);
    if (typeof variant === 'string' && variant.trim()) return existing ?? variant.trim();
    // A native fast-only variant is a separate mode, not a thinking stop.
    if (existing?.toLowerCase() === 'fast') return existing;
    const cursor = getCursorAcpVariantState(provider, modelId, variant);
    const { selected } = getChatThinkingState(provider, modelId, existing ?? variant);
    if (cursor) {
        if (cursor.normalizedVariant && parseCursorAcpVariantKey(cursor.normalizedVariant)?.effort) return cursor.normalizedVariant;
        if (!selected) return existing;
        return resolveCursorAcpVariantSelection(provider, modelId, variant, { effort: selected }).variant ?? undefined;
    }
    return resolveThinkingVariant(existing, getChatThinkingState(provider, modelId).levels, { providerId: provider.id }) ?? selected ?? undefined;
}
