export type UserProfileProvisionResult = {
  ok: boolean;
  changed: boolean;
  conflicts: string[];
  written: string[];
  updated: string[];
  removed: string[];
  install: { ok: boolean; exitCode: number | null; stdout: string; stderr: string } | null;
  error?: string;
};

export function createUserProfileProvisioningRuntime(options?: Record<string, unknown>): {
  configDirectory: string;
  provision(): Promise<UserProfileProvisionResult>;
};
