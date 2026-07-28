export type UserProfileProvisionResult = {
  ok: boolean;
  changed: boolean;
  conflicts: string[];
  written: string[];
  updated: string[];
  removed: string[];
  install: { ok: boolean; exitCode: number | null; stdout: string; stderr: string } | null;
  warnings?: string[];
  meridianPolicy?: {
    ok: boolean;
    changed: boolean;
    settingsChanged?: boolean;
    markerChanged?: boolean;
    migrated?: boolean;
    promptMode?: 'client-only' | 'claude-only' | 'combined' | 'none' | 'custom';
    managedFields?: string[];
    preservedFields?: string[];
    warning?: string | null;
    code?: string;
    error?: string;
  } | null;
  error?: string;
};

export function createUserProfileProvisioningRuntime(options?: Record<string, unknown>): {
  configDirectory: string;
  meridianConfigDirectory: string;
  provision(): Promise<UserProfileProvisionResult>;
};
