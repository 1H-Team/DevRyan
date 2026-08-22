import {
  createXaiToolCatalogCache,
  isXaiProviderID,
  listXaiModelIds,
  type ProviderToolCatalogEntry,
} from '@openchamber/orchestration-runtime';

const cache = createXaiToolCatalogCache();
const inflight = new Map<string, Promise<void>>();

const normalize = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const buildUrl = (
  apiUrl: string,
  directory: string | undefined,
  providerID: string,
  modelID: string,
): string => {
  const url = new URL('experimental/tool', `${apiUrl.replace(/\/+$/, '')}/`);
  if (directory) url.searchParams.set('directory', directory);
  url.searchParams.set('provider', providerID);
  url.searchParams.set('model', modelID);
  return url.toString();
};

export const getXaiPromptToolOverrides = (input: {
  directory?: string;
  providerID: string;
  modelID: string;
}): Record<string, false> | null => cache.get(input);

export const supportsXaiProvider = (providerID: unknown): boolean => isXaiProviderID(providerID);

export const refreshXaiToolModel = ({
  apiUrl,
  directory,
  providerID = 'xai',
  modelID,
  headers,
}: {
  apiUrl: string;
  directory?: string;
  providerID?: string;
  modelID: string;
  headers?: Record<string, string>;
}): Promise<void> => {
  const normalizedModelID = normalize(modelID);
  if (!normalizedModelID) return Promise.resolve();
  const key = [apiUrl, directory ?? '', providerID.toLowerCase(), normalizedModelID].join('\n');
  const existing = inflight.get(key);
  if (existing) return existing;

  const job = fetch(buildUrl(apiUrl, directory, providerID, normalizedModelID), {
    method: 'GET',
    headers: { Accept: 'application/json', ...headers },
  })
    .then(async (response) => response.ok ? response.json().catch(() => null) : null)
    .then((catalog: unknown) => {
      if (!Array.isArray(catalog)) return;
      cache.remember({
        directory,
        providerID,
        modelID: normalizedModelID,
        catalog: catalog as ProviderToolCatalogEntry[],
      });
    })
    .catch(() => undefined)
    .finally(() => {
      if (inflight.get(key) === job) inflight.delete(key);
    });
  inflight.set(key, job);
  return job;
};

export const refreshXaiProviderPayload = async ({
  apiUrl,
  directory,
  payload,
  headers,
}: {
  apiUrl: string;
  directory?: string;
  payload: unknown;
  headers?: Record<string, string>;
}): Promise<void> => {
  await Promise.all(listXaiModelIds(payload).map((modelID) => refreshXaiToolModel({
    apiUrl,
    directory,
    providerID: 'xai',
    modelID,
    headers,
  })));
};
