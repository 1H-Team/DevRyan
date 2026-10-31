export type UserProfileNotice = {
  code: 'legacy_cursor_plugin_conflict';
  files: string[];
  message: string;
  error?: string;
};

export type UserProfileProvisionResult = {
  ok: boolean;
  changed: boolean;
  conflicts: string[];
  written: string[];
  updated: string[];
  removed: string[];
  install: { ok: boolean; exitCode: number | null; stdout: string; stderr: string } | null;
  managedPluginIssues?: Array<{
    pluginId: string;
    kind: 'missing-package' | 'version-mismatch' | 'missing-entrypoint';
    path: string;
    expectedVersion: string;
    installedVersion: string | null;
  }>;
  warnings?: string[];
  /** Non-blocking problems surfaced to the user; OpenCode still starts. */
  profileNotices?: UserProfileNotice[];
  imagegenModelHotfix?: {
    ok: boolean;
    changed: boolean;
    version?: string;
    model?: string;
    reasoningEffort?: string;
    sourceSha256?: string;
    code?: string;
    error?: string;
  };
  error?: string;
};

export function createUserProfileProvisioningRuntime(options?: Record<string, unknown>): {
  configDirectory: string;
  provision(): Promise<UserProfileProvisionResult>;
};
