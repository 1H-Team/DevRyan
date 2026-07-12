import * as path from 'path';
import * as fs from 'fs';
import { createUserProfileProvisioningRuntime, type UserProfileProvisionResult } from '../../web/server/lib/opencode/user-profile-provisioning.js';

const packagedConfigCandidates = (): string[] => [
  path.resolve(__dirname, '..', '..', 'web', 'server', 'default-config'),
  path.resolve(__dirname, '..', 'web', 'server', 'default-config'),
  path.resolve(__dirname, 'default-config'),
];

export async function provisionManagedUserProfile(): Promise<UserProfileProvisionResult> {
  const configRoot = packagedConfigCandidates().find((candidate) => {
    try {
      return fs.existsSync(path.join(candidate, 'user-profile', 'opencode.json'));
    } catch {
      return false;
    }
  });
  if (!configRoot) {
    return {
      ok: false,
      changed: false,
      conflicts: [],
      written: [],
      updated: [],
      removed: [],
      install: null,
      error: 'Packaged OpenCode user profile is missing from the VS Code extension',
    };
  }
  return await createUserProfileProvisioningRuntime({
    configRoot,
    profileRoot: path.join(configRoot, 'user-profile'),
  }).provision();
}
