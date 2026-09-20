import React from 'react';
import { importWithChunkRecovery } from '@/lib/chunkLoadRecovery';

type SettingsComponentModule<Props extends object> = {
  default: React.ComponentType<Props>;
};

type PreparedSettingsComponent<Props extends object> = {
  Component: React.ComponentType<Props>;
  isReady: () => boolean;
  load: () => Promise<SettingsComponentModule<Props>>;
};

const SETTINGS_CHUNK_OPTIONS = { timeoutMs: 10_000 } as const;

export function createPreparedSettingsComponent<Props extends object>(
  importComponent: () => Promise<SettingsComponentModule<Props>>,
): PreparedSettingsComponent<Props> {
  let loadedModule: SettingsComponentModule<Props> | null = null;
  let inFlight: Promise<SettingsComponentModule<Props>> | null = null;
  let rejectedError: unknown;

  const load = (): Promise<SettingsComponentModule<Props>> => {
    if (loadedModule) return Promise.resolve(loadedModule);
    if (inFlight) return inFlight;

    rejectedError = undefined;
    const next = importWithChunkRecovery(importComponent, SETTINGS_CHUNK_OPTIONS).then(
      (module) => {
        loadedModule = module;
        return module;
      },
      (error: unknown) => {
        inFlight = null;
        rejectedError = error;
        throw error;
      },
    );
    inFlight = next;
    return next;
  };

  const Component: React.FC<Props> = (props) => {
    if (loadedModule) {
      return React.createElement(loadedModule.default, props);
    }
    if (rejectedError !== undefined) {
      const error = rejectedError;
      rejectedError = undefined;
      throw error;
    }
    throw load();
  };

  Component.displayName = 'PreparedSettingsComponent';
  return { Component, isReady: () => loadedModule !== null, load };
}
