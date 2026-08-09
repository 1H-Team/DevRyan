const PROJECT_ENVIRONMENT_FILENAMES = Object.freeze([
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
]);

export const PROJECT_ENVIRONMENT_MAX_FILE_BYTES = 256 * 1024;

const PUBLIC_ENVIRONMENT_PREFIXES = Object.freeze([
  'VITE_',
  'NEXT_PUBLIC_',
  'PUBLIC_',
  'REACT_APP_',
  'GATSBY_',
  'NUXT_PUBLIC_',
  'EXPO_PUBLIC_',
]);

const PUBLIC_ENVIRONMENT_KEYS = new Set([
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
]);

const SERVER_CREDENTIAL_PATTERNS = Object.freeze([
  /(?:^|_)SUPABASE_(?:SERVICE_ROLE_KEY|SECRET_KEY)$/,
  /(?:^|_)(?:SERVICE_ROLE_KEY|SECRET_KEY|PRIVATE_KEY|CLIENT_SECRET|SESSION_SECRET|JWT_SECRET|DATABASE_URL|DIRECT_URL|PASSWORD)$/,
  /(?:^|_)(?:OPENAI|ANTHROPIC|GITHUB|GITLAB|STRIPE|AWS|CLOUDFLARE|VERCEL)_(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|SECRET_KEY)$/,
]);

const createProjectEnvironmentError = (code, message) => Object.assign(new Error(message), { code });

const parseQuotedValue = (rawValue, quote) => {
  let value = '';
  let escaped = false;

  for (let index = 1; index < rawValue.length; index += 1) {
    const character = rawValue[index];
    if (escaped) {
      if (quote === '"') {
        const escapedCharacters = {
          n: '\n',
          r: '\r',
          t: '\t',
          '"': '"',
          '\\': '\\',
        };
        value += escapedCharacters[character] ?? `\\${character}`;
      } else if (character === quote || character === '\\') {
        value += character;
      } else {
        value += `\\${character}`;
      }
      escaped = false;
      continue;
    }

    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === quote) {
      const remainder = rawValue.slice(index + 1).trim();
      if (remainder && !remainder.startsWith('#')) return null;
      return value;
    }
    value += character;
  }

  return null;
};
export const parseProjectEnvironment = (source) => {
  const environment = {};
  const lines = String(source || '').replace(/^\uFEFF/, '').split(/\r?\n/);

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/^export\s+/, '');

    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 1) continue;

    const key = line.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    const rawValue = line.slice(separatorIndex + 1).trim();
    const quote = rawValue[0];
    let value;
    if (quote === '"' || quote === "'" || quote === '`') {
      value = parseQuotedValue(rawValue, quote);
      if (value === null) continue;
    } else {
      const commentIndex = rawValue.indexOf('#');
      value = (commentIndex === -1 ? rawValue : rawValue.slice(0, commentIndex)).trim();
    }

    environment[key] = value;
  }

  return environment;
};

export const isBrowserPublicProjectEnvironmentKey = (key) => {
  if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return false;
  if (SERVER_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(key))) return false;
  return PUBLIC_ENVIRONMENT_KEYS.has(key)
    || PUBLIC_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix));
};

const isPathContained = (pathApi, root, candidate) => {
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative));
};

const readBoundedEnvironmentFile = async ({
  fileApi,
  filename,
  resolvedPath,
  maxFileBytes,
}) => {
  let handle;
  try {
    handle = await fileApi.open(resolvedPath, 'r');
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw createProjectEnvironmentError(
        'PROJECT_ENV_NOT_FILE',
        `Managed project environment source ${filename} must be a regular file`,
      );
    }
    if (stats.size > maxFileBytes) {
      throw createProjectEnvironmentError(
        'PROJECT_ENV_TOO_LARGE',
        `Managed project environment source ${filename} exceeds the ${maxFileBytes}-byte limit`,
      );
    }

    const buffer = Buffer.alloc(maxFileBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const readResult = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (readResult.bytesRead === 0) break;
      bytesRead += readResult.bytesRead;
    }
    if (bytesRead > maxFileBytes) {
      throw createProjectEnvironmentError(
        'PROJECT_ENV_TOO_LARGE',
        `Managed project environment source ${filename} exceeds the ${maxFileBytes}-byte limit`,
      );
    }
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle?.close();
  }
};

export const loadProjectPublicEnvironment = async ({
  repositoryPath,
  fileSystem,
  pathApi,
  maxFileBytes = PROJECT_ENVIRONMENT_MAX_FILE_BYTES,
}) => {
  const fileApi = fileSystem?.promises;
  if (!fileApi || !pathApi || typeof repositoryPath !== 'string' || !pathApi.isAbsolute(repositoryPath)) {
    throw createProjectEnvironmentError(
      'PROJECT_ENV_INVALID_ROOT',
      'Managed project environment root must be an absolute directory',
    );
  }
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw createProjectEnvironmentError(
      'PROJECT_ENV_INVALID_LIMIT',
      'Managed project environment size limit must be a positive integer',
    );
  }

  let canonicalRoot;
  try {
    canonicalRoot = await fileApi.realpath(repositoryPath);
    const rootStats = await fileApi.stat(canonicalRoot);
    if (!rootStats.isDirectory()) throw new Error('not a directory');
  } catch {
    throw createProjectEnvironmentError(
      'PROJECT_ENV_INVALID_ROOT',
      'Managed project environment root is not an accessible directory',
    );
  }

  const mergedEnvironment = {};
  for (const filename of PROJECT_ENVIRONMENT_FILENAMES) {
    const candidate = pathApi.join(canonicalRoot, filename);
    let resolvedPath;
    try {
      resolvedPath = await fileApi.realpath(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw createProjectEnvironmentError(
        'PROJECT_ENV_UNREADABLE',
        `Managed project environment source ${filename} is not readable`,
      );
    }

    if (!isPathContained(pathApi, canonicalRoot, resolvedPath)) {
      throw createProjectEnvironmentError(
        'PROJECT_ENV_OUTSIDE_ROOT',
        `Managed project environment source ${filename} must remain inside the registered project root`,
      );
    }

    let source;
    try {
      source = await readBoundedEnvironmentFile({
        fileApi,
        filename,
        resolvedPath,
        maxFileBytes,
      });
    } catch (error) {
      if (error?.code?.startsWith('PROJECT_ENV_')) throw error;
      throw createProjectEnvironmentError(
        'PROJECT_ENV_UNREADABLE',
        `Managed project environment source ${filename} is not readable`,
      );
    }

    let stableResolvedPath;
    try {
      stableResolvedPath = await fileApi.realpath(candidate);
    } catch {
      throw createProjectEnvironmentError(
        'PROJECT_ENV_CHANGED',
        `Managed project environment source ${filename} changed while it was being read`,
      );
    }
    if (stableResolvedPath !== resolvedPath || !isPathContained(pathApi, canonicalRoot, stableResolvedPath)) {
      throw createProjectEnvironmentError(
        'PROJECT_ENV_CHANGED',
        `Managed project environment source ${filename} changed while it was being read`,
      );
    }

    const parsedEnvironment = parseProjectEnvironment(source);
    for (const [key, value] of Object.entries(parsedEnvironment)) {
      if (isBrowserPublicProjectEnvironmentKey(key)) mergedEnvironment[key] = value;
    }
  }

  return mergedEnvironment;
};
