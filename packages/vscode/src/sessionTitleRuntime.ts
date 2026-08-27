import type { OpenCodeManager } from './opencode';
import { getVsCodeHarnessRuntime } from './harness-runtime-access';
import { fetchFreeZenModels, getFreeZenModelCatalogSnapshot, prewarmFreeZenModels } from './zenModelCatalogRuntime';
import { createStandardSessionTitleRuntime } from '../../web/server/lib/opencode/standard-session-title-runtime.js';

export type StandardSessionTitleScheduleInput = {
  sessionID: string;
  directory?: string;
  text?: string;
  providerID?: string;
  modelID?: string;
  variant?: string;
};

type StandardSessionTitleRuntime = {
  schedule(input: StandardSessionTitleScheduleInput): Promise<boolean>;
  schedulePlaceholderRecovery(input?: { directory?: string }): Promise<boolean>;
  processOpenCodeEvent(payload: unknown): Promise<boolean>;
  cleanupStaleHelpers(input?: { directory?: string }): Promise<number>;
};

let activeManager: OpenCodeManager | null = null;
let activeRuntime: StandardSessionTitleRuntime | null = null;

const buildOpenCodeUrl = (manager: OpenCodeManager, requestPath: string, fallback = ''): string => {
  const apiUrl = manager.getApiUrl();
  if (!apiUrl) return fallback;
  const base = `${apiUrl.replace(/\/+$/, '')}/`;
  return new URL(requestPath.replace(/^\/+/, ''), base).toString();
};

export const initializeSessionTitleRuntime = (
  manager: OpenCodeManager,
  options: { publishEvent?: (event: unknown) => void | Promise<void> } = {},
): StandardSessionTitleRuntime => {
  if (activeRuntime && activeManager === manager) return activeRuntime;
  activeManager = manager;
  activeRuntime = createStandardSessionTitleRuntime({
    fetchImpl: fetch,
    buildOpenCodeUrl: (requestPath: string, fallback: string) => buildOpenCodeUrl(manager, requestPath, fallback),
    getOpenCodeAuthHeaders: () => manager.getOpenCodeAuthHeaders(),
    fetchFreeZenModels,
    getCachedZenModels: getFreeZenModelCatalogSnapshot,
    onTitleGenerated: ({ session, title }: { session: Record<string, unknown>; title: string }) => (
      options.publishEvent?.({
        type: 'session.updated',
        properties: {
          sessionID: session.id,
          info: {
            ...session,
            title,
          },
        },
      })
    ),
    recordDiagnostic: (entry: Record<string, unknown>) => getVsCodeHarnessRuntime()?.record(entry),
    logger: console,
  }) as StandardSessionTitleRuntime;
  prewarmFreeZenModels();
  return activeRuntime;
};

export const getSessionTitleRuntime = (): StandardSessionTitleRuntime | null => activeRuntime;

export const scheduleSessionTitle = (input: StandardSessionTitleScheduleInput): Promise<boolean> => (
  activeRuntime?.schedule(input) ?? Promise.resolve(false)
);

export const scheduleSessionTitleRecovery = (directory?: string): Promise<boolean> => (
  activeRuntime?.schedulePlaceholderRecovery({ directory }) ?? Promise.resolve(false)
);

export const processSessionTitleEvent = (payload: unknown): Promise<boolean> => (
  activeRuntime?.processOpenCodeEvent(payload) ?? Promise.resolve(false)
);

export const cleanupStaleSessionTitleHelpers = (directory?: string): Promise<number> => (
  activeRuntime?.cleanupStaleHelpers({ directory }) ?? Promise.resolve(0)
);

export const disposeSessionTitleRuntime = (): void => {
  activeRuntime = null;
  activeManager = null;
};
