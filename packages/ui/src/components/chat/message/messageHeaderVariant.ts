import { resolveThinkingVariant } from '@/lib/providers/variantControls';

interface MessageHeaderVariantDisplayInput {
    recordedVariant: string | null | undefined;
    modelVariantOptions: string[];
    fastEnabled: boolean;
}

export interface MessageHeaderVariantDisplay {
    variant: string | undefined;
    fastEnabled: boolean;
}

const isFastOnlyVariant = (variant: string | null | undefined) => variant?.trim().toLowerCase() === 'fast';

export const resolveMessageHeaderVariant = (
    recordedVariant: string | null | undefined,
    modelVariantOptions: string[],
): string | undefined => {
    return resolveMessageHeaderVariantDisplay({
        recordedVariant,
        modelVariantOptions,
        fastEnabled: false,
    }).variant;
};

export const resolveMessageHeaderVariantDisplay = ({
    recordedVariant,
    modelVariantOptions,
    fastEnabled,
}: MessageHeaderVariantDisplayInput): MessageHeaderVariantDisplay => {
    const recordedEffort = isFastOnlyVariant(recordedVariant) ? undefined : recordedVariant?.trim() || undefined;
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
