import fs from 'fs';
import path from 'path';
import { OPENCODE_CONFIG_DIR } from '../../opencode/shared.js';
import { OPENCODE_DATA_DIR } from '../../opencode/auth.js';


export const ANTIGRAVITY_ACCOUNTS_PATHS = [
  path.join(OPENCODE_CONFIG_DIR, 'antigravity-accounts.json'),
  path.join(OPENCODE_DATA_DIR, 'antigravity-accounts.json')
];

const RUNTIME_AGENT_OVERLAY_ROOTS = ['.devryan', '.openchamber']
  .map(name => path.join(OPENCODE_CONFIG_DIR, name, 'runtime-agent-overlays'));

// The Antigravity plugin stores accounts under OPENCODE_CONFIG_DIR, which a
// managed runtime points at its per-project overlay directory, so account files
// also live one level below the overlay root.
export const listAntigravityAccountsPaths = ({ overlayRoot, overlayRoots = RUNTIME_AGENT_OVERLAY_ROOTS } = {}) => {
  const overlayPaths = [];
  for (const root of overlayRoot ? [overlayRoot] : overlayRoots) {
    try {
      overlayPaths.push(...fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name, 'antigravity-accounts.json')));
    } catch {
      // A missing overlay generation has no accounts to discover.
    }
  }
  return [...ANTIGRAVITY_ACCOUNTS_PATHS, ...overlayPaths];
};

export const readJsonFile = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch (error) {
    console.warn(`Failed to read JSON file: ${filePath}`, error);
    return null;
  }
};

export const getAuthEntry = (auth, aliases) => {
  for (const alias of aliases) {
    if (auth[alias]) {
      return auth[alias];
    }
  }
  return null;
};

export const normalizeAuthEntry = (entry) => {
  if (!entry) return null;
  if (typeof entry === 'string') {
    return { token: entry };
  }
  if (typeof entry === 'object') {
    return entry;
  }
  return null;
};
