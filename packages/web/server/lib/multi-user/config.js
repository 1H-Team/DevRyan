import fs from 'node:fs';
import path from 'node:path';

const readPrivateJson = (filePath) => {
  if (!fs.existsSync(filePath)) return {};
  const stats = fs.statSync(filePath);
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`Multi-user configuration must be private (chmod 600): ${filePath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
};

const firstString = (...values) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

export function resolveMultiUserConfig({ dataDirectory, env = process.env } = {}) {
  const root = path.resolve(dataDirectory || '.');
  const configPath = path.join(root, 'supabase.json');
  const stored = readPrivateJson(configPath);
  const url = firstString(env.OPENCHAMBER_SUPABASE_URL, env.SUPABASE_URL, stored.url);
  const publishableKey = firstString(
    env.OPENCHAMBER_SUPABASE_PUBLISHABLE_KEY,
    env.SUPABASE_PUBLISHABLE_KEY,
    env.SUPABASE_ANON_KEY,
    stored.publishableKey,
    stored.anonKey,
  );
  const secretKey = firstString(
    env.OPENCHAMBER_SUPABASE_SECRET_KEY,
    env.SUPABASE_SECRET_KEY,
    env.SUPABASE_SERVICE_ROLE_KEY,
    stored.secretKey,
    stored.serviceRoleKey,
  );

  const configuredValues = [url, publishableKey, secretKey].filter(Boolean).length;
  if (configuredValues > 0 && configuredValues < 3) {
    throw new Error('Supabase multi-user mode requires URL, publishable key, and secret key');
  }

  return {
    enabled: configuredValues === 3,
    url: url.replace(/\/+$/, ''),
    publishableKey,
    secretKey,
    configPath,
    dataDirectory: root,
  };
}
