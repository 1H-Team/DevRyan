import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const normalizeScope = (value) => {
  const normalized = String(value || 'dev')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'dev';
};

export const resolveDevDataDirectory = (options = {}) => {
  const env = options.env ?? process.env;
  const configured = typeof env.OPENCHAMBER_DATA_DIR === 'string'
    ? env.OPENCHAMBER_DATA_DIR.trim()
    : '';
  if (configured) return path.resolve(configured);

  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const checkoutId = crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
  const temporaryRoot = path.resolve(options.temporaryRoot ?? os.tmpdir());
  return path.join(
    temporaryRoot,
    'devryan-development',
    checkoutId,
    normalizeScope(options.scope),
  );
};
