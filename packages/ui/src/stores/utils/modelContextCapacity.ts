export type ContextCapacityBasis = "input" | "context" | "unavailable";

export type ResolvedModelContextCapacity = {
    capacityLimit: number | null;
    capacityBasis: ContextCapacityBasis;
    inputLimit: number | null;
    contextLimit: number | null;
    outputLimit: number | null;
};

export const UNAVAILABLE_MODEL_CONTEXT_CAPACITY: ResolvedModelContextCapacity = {
    capacityLimit: null,
    capacityBasis: "unavailable",
    inputLimit: null,
    contextLimit: null,
    outputLimit: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === "object" && value !== null && !Array.isArray(value)
);

const positiveLimit = (value: unknown): number | null => (
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
);

const readLimit = (source: unknown): Record<string, unknown> | null => {
    if (!isRecord(source) || !isRecord(source.limit)) return null;
    return source.limit;
};

export const resolveModelContextCapacity = (
    model: unknown,
    variant?: string | null,
): ResolvedModelContextCapacity => {
    const modelLimit = readLimit(model);
    const normalizedVariant = typeof variant === "string" ? variant.trim() : "";
    const variants = isRecord(model) && isRecord(model.variants) ? model.variants : null;
    const variantLimit = normalizedVariant && variants
        ? readLimit(variants[normalizedVariant])
        : null;

    const inputLimit = positiveLimit(variantLimit?.input) ?? positiveLimit(modelLimit?.input);
    const contextLimit = positiveLimit(variantLimit?.context) ?? positiveLimit(modelLimit?.context);
    const outputLimit = positiveLimit(variantLimit?.output) ?? positiveLimit(modelLimit?.output);

    if (inputLimit !== null && (contextLimit === null || inputLimit <= contextLimit)) {
        return {
            capacityLimit: inputLimit,
            capacityBasis: "input",
            inputLimit,
            contextLimit,
            outputLimit,
        };
    }

    if (contextLimit !== null) {
        return {
            capacityLimit: contextLimit,
            capacityBasis: "context",
            inputLimit,
            contextLimit,
            outputLimit,
        };
    }

    if (inputLimit === null && contextLimit === null && outputLimit === null) {
        return UNAVAILABLE_MODEL_CONTEXT_CAPACITY;
    }

    return { ...UNAVAILABLE_MODEL_CONTEXT_CAPACITY, inputLimit, contextLimit, outputLimit };
};
