#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_CONFIG_URL = new URL('../supabase/config.toml', import.meta.url);
const MANAGEMENT_API_ORIGIN = 'https://api.supabase.com';

const authSection = (source) => {
  const lines = String(source).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '[auth]');
  if (start < 0) throw new Error('supabase/config.toml is missing the [auth] section');

  const section = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line)) break;
    section.push(line);
  }
  return section.join('\n');
};

const configValue = (section, key) => {
  const match = section.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`, 'm'));
  if (!match) throw new Error(`supabase/config.toml [auth] is missing ${key}`);
  return match[1];
};

export const parseAuthPasswordPolicy = (source) => {
  const section = authSection(source);
  const minimumPasswordLength = Number(configValue(section, 'minimum_password_length'));
  if (!Number.isInteger(minimumPasswordLength) || minimumPasswordLength < 6) {
    throw new Error('supabase/config.toml auth.minimum_password_length must be at least 6');
  }

  let passwordRequirements;
  try {
    passwordRequirements = JSON.parse(configValue(section, 'password_requirements'));
  } catch {
    throw new Error('supabase/config.toml auth.password_requirements must be a quoted string');
  }
  if (passwordRequirements !== '') {
    throw new Error('Only an empty auth.password_requirements value is supported by this focused sync');
  }

  return {
    minimumPasswordLength,
    passwordRequiredCharacters: '',
  };
};

const managementApiUrl = (projectId) => (
  `${MANAGEMENT_API_ORIGIN}/v1/projects/${encodeURIComponent(projectId)}/config/auth`
);

const requestAuthConfig = async ({ accessToken, fetchImpl, method, projectId, body }) => {
  const response = await fetchImpl(managementApiUrl(projectId), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error(`Supabase Auth configuration ${method} failed with HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`Supabase Auth configuration ${method} returned invalid JSON`);
  }
};

const matchesPolicy = (config, policy) => (
  config?.password_min_length === policy.minimumPasswordLength
  && config?.password_required_characters === policy.passwordRequiredCharacters
);

export const syncSupabaseAuthPasswordPolicy = async ({
  accessToken,
  projectId,
  policy,
  fetchImpl = globalThis.fetch,
}) => {
  if (!accessToken) throw new Error('SUPABASE_ACCESS_TOKEN is required');
  if (!projectId) throw new Error('SUPABASE_PROJECT_ID is required');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');

  const current = await requestAuthConfig({ accessToken, fetchImpl, method: 'GET', projectId });
  if (matchesPolicy(current, policy)) return { changed: false, policy };

  await requestAuthConfig({
    accessToken,
    fetchImpl,
    method: 'PATCH',
    projectId,
    body: {
      password_min_length: policy.minimumPasswordLength,
      password_required_characters: policy.passwordRequiredCharacters,
    },
  });

  const verified = await requestAuthConfig({ accessToken, fetchImpl, method: 'GET', projectId });
  if (!matchesPolicy(verified, policy)) {
    throw new Error('Supabase Auth password policy verification failed after update');
  }
  return { changed: true, policy };
};

export const run = async ({
  accessToken = process.env.SUPABASE_ACCESS_TOKEN,
  projectId = process.env.SUPABASE_PROJECT_ID,
  configUrl = DEFAULT_CONFIG_URL,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const policy = parseAuthPasswordPolicy(await readFile(configUrl, 'utf8'));
  const result = await syncSupabaseAuthPasswordPolicy({ accessToken, projectId, policy, fetchImpl });
  const action = result.changed ? 'updated and verified' : 'already matched';
  process.stdout.write(
    `Supabase Auth password policy ${action}: minimum ${policy.minimumPasswordLength}, no composition requirement.\n`,
  );
  return result;
};

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  run().catch((error) => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : 'Unknown failure'}\n`);
    process.exitCode = 1;
  });
}
