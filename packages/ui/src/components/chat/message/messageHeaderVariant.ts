import { resolveThinkingVariant } from '@/lib/providers/variantControls';

interface MessageHeaderVariantDisplayInput {
    recordedVariant: string | null | undefined;
    modelVariantOptions: string[];
    fastEnabled: boolean;
    /** Catalog default level, shown when the turn ran at the model default. */
    modelDefaultThinkingLevel?: string;
}

export interface MessageHeaderVariantDisplay {
    variant: string | undefined;
    fastEnabled: boolean;
}

const isFastOnlyVariant = (variant: string | null | undefined) => variant?.trim().toLowerCase() === 'fast';

export const resolveMessageHeaderVariant = (
    recordedVariant: string | null | undefined,
    modelVariantOptions: string[],
    modelDefaultThinkingLevel?: string,
): string | undefined => {
    return resolveMessageHeaderVariantDisplay({
        recordedVariant,
        modelVariantOptions,
        fastEnabled: false,
        modelDefaultThinkingLevel,
    }).variant;
};

export const resolveMessageHeaderVariantDisplay = ({
    recordedVariant,
    modelVariantOptions,
    fastEnabled,
    modelDefaultThinkingLevel,
}: MessageHeaderVariantDisplayInput): MessageHeaderVariantDisplay => {
    const recordedEffort = isFastOnlyVariant(recordedVariant) ? undefined : recordedVariant?.trim() || undefined;
    if (!recordedEffort) {
        // No recorded effort means the turn ran at the model default. Name that
        // level only when the catalog reports one for a model with thinking levels.
        const defaultLevel = modelDefaultThinkingLevel?.trim();
        return {
            variant: defaultLevel && modelVariantOptions.length > 0
                ? resolveThinkingVariant(defaultLevel, modelVariantOptions)
                : undefined,
            fastEnabled,
        };
    }
    return {
        // Catalogs describe today's selectable values, not the effort used by a
        // historical turn. Keep recorded values through catalog refresh/removal.
        variant: resolveThinkingVariant(
            recordedEffort,
            modelVariantOptions,
        ) ?? recordedEffort,
        fastEnabled,
    };
};
