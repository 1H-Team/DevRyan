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
    return {
        variant: resolveThinkingVariant(
            isFastOnlyVariant(recordedVariant) ? undefined : recordedVariant,
            modelVariantOptions,
        ),
        fastEnabled,
    };
};
