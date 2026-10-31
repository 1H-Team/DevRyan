import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Claude Code's keychain item name for a config directory. Bundles from the
 * Meridian era recorded Claude profiles by this name; clone and setup migration
 * still compare it. DevRyan never reads the item. */
export const claudeKeychainService = (account, home = os.homedir()) => {
  const absolute = path.resolve(account);
  if (absolute === path.resolve(home, '.claude')) return KEYCHAIN_SERVICE;
  return `${KEYCHAIN_SERVICE}-${createHash('sha256').update(absolute).digest('hex').slice(0, 8)}`;
};
