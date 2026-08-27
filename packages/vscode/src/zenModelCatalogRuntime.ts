import { createFreeZenModelCatalog, type FreeZenModel } from '@openchamber/shared-runtime';

const catalog = createFreeZenModelCatalog();

export const fetchFreeZenModels = async (): Promise<FreeZenModel[]> => catalog.fetchModels();

export const getCachedFreeZenModels = (): FreeZenModel[] => catalog.getCachedModels();

export const getFreeZenModelCatalogSnapshot = () => catalog.getSnapshot();

export const prewarmFreeZenModels = (): void => catalog.prewarm();
