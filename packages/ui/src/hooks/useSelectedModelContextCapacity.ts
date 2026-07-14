import * as React from "react";
import { useConfigStore } from "@/stores/useConfigStore";
import { resolveModelContextCapacity } from "@/stores/utils/modelContextCapacity";

type ConfigStoreState = ReturnType<typeof useConfigStore.getState>;

export const selectSelectedModelForContextCapacity = (state: ConfigStoreState) => {
    const provider = state.providers.find((entry) => entry.id === state.currentProviderId);
    return provider?.models.find((entry) => entry.id === state.currentModelId);
};

export const getSelectedModelContextCapacitySnapshot = () => {
    const state = useConfigStore.getState();
    return resolveModelContextCapacity(selectSelectedModelForContextCapacity(state), state.currentVariant);
};

export const useSelectedModelContextCapacity = () => {
    const currentProviderId = useConfigStore((state) => state.currentProviderId);
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const currentVariant = useConfigStore((state) => state.currentVariant);
    const selectedModel = useConfigStore(selectSelectedModelForContextCapacity);

    return React.useMemo(
        () => resolveModelContextCapacity(
            currentProviderId && currentModelId ? selectedModel : undefined,
            currentVariant,
        ),
        [currentModelId, currentProviderId, currentVariant, selectedModel],
    );
};
