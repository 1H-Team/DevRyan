import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isBrowserPublicProjectEnvironmentKey,
  loadProjectPublicEnvironment,
  parseProjectEnvironment,
} from './project-environment.js';

const temporaryDirectories = [];

const createTemporaryDirectory = async (prefix) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});
describe('parseProjectEnvironment', () => {
  it('parses exports, quotes, escapes, comments, empty values, and later assignments', () => {
    const parsed = parseProjectEnvironment([
      '\uFEFF# project defaults',
      'export VITE_ORIGIN=https://example.test # comment',
      'NEXT_PUBLIC_LABEL="line\\nvalue # retained"',
      "PUBLIC_LITERAL='literal # retained'",
      'REACT_APP_EMPTY=',
      'INVALID KEY=ignored',
      'VITE_ORIGIN=https://override.test',
    ].join('\n'));

    expect(parsed).toEqual({
      VITE_ORIGIN: 'https://override.test',
      NEXT_PUBLIC_LABEL: 'line\nvalue # retained',
      PUBLIC_LITERAL: 'literal # retained',
      REACT_APP_EMPTY: '',
    });
  });
});

describe('isBrowserPublicProjectEnvironmentKey', () => {
  it('allows established public prefixes and the public Supabase compatibility keys', () => {
    for (const key of [
      'VITE_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_URL',
      'PUBLIC_ASSET_URL',
      'REACT_APP_API_URL',
      'GATSBY_API_URL',
      'NUXT_PUBLIC_API_URL',
      'EXPO_PUBLIC_API_URL',
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_PUBLISHABLE_KEY',
    ]) {
      expect(isBrowserPublicProjectEnvironmentKey(key), key).toBe(true);
    }
  });

  it('rejects server credentials even when a browser-public prefix is present', () => {
    for (const key of [
      'SUPABASE_SECRET_KEY',
      'VITE_SUPABASE_SERVICE_ROLE_KEY',
      'NEXT_PUBLIC_DATABASE_URL',
      'PUBLIC_OPENAI_API_KEY',
      'REACT_APP_GITHUB_ACCESS_TOKEN',
      'VITE_SESSION_SECRET',
      'OPENCHAMBER_UI_PASSWORD',
      'UNPREFIXED_VALUE',
    ]) {
      expect(isBrowserPublicProjectEnvironmentKey(key), key).toBe(false);
    }
  });
});

describe('loadProjectPublicEnvironment', () => {
  it('loads fixed development files in Vite precedence order and drops server-only values', async () => {
    const repositoryPath = await createTemporaryDirectory('devryan-public-env-');
    await Promise.all([
      fs.promises.writeFile(path.join(repositoryPath, '.env'), [
        'VITE_ORIGIN=https://base.test',
        'SUPABASE_URL=https://supabase.test',
        'SUPABASE_SECRET_KEY=server-secret',
      ].join('\n')),
      fs.promises.writeFile(path.join(repositoryPath, '.env.local'), 'VITE_ORIGIN=https://local.test\n'),
      fs.promises.writeFile(path.join(repositoryPath, '.env.development'), [
        'VITE_ORIGIN=https://development.test',
        'NEXT_PUBLIC_LABEL=development',
      ].join('\n')),
      fs.promises.writeFile(path.join(repositoryPath, '.env.development.local'), [
        'VITE_ORIGIN=https://development-local.test',
        'SUPABASE_ANON_KEY=anon-public',
        'VITE_SUPABASE_SERVICE_ROLE_KEY=server-secret-too',
      ].join('\n')),
    ]);

    const environment = await loadProjectPublicEnvironment({
      repositoryPath,
      fileSystem: fs,
      pathApi: path,
    });

    expect(environment).toEqual({
      VITE_ORIGIN: 'https://development-local.test',
      SUPABASE_URL: 'https://supabase.test',
      NEXT_PUBLIC_LABEL: 'development',
      SUPABASE_ANON_KEY: 'anon-public',
    });
  });

  it('allows an environment file symlink only when its real target stays inside the project root', async () => {
    const repositoryPath = await createTemporaryDirectory('devryan-contained-env-');
    const configDirectory = path.join(repositoryPath, 'config');
    await fs.promises.mkdir(configDirectory);
    await fs.promises.writeFile(path.join(configDirectory, 'public.env'), 'VITE_CONTAINED=yes\n');
    await fs.promises.symlink(path.join(configDirectory, 'public.env'), path.join(repositoryPath, '.env'));

    await expect(loadProjectPublicEnvironment({
      repositoryPath,
      fileSystem: fs,
      pathApi: path,
    })).resolves.toEqual({ VITE_CONTAINED: 'yes' });
  });

  it('rejects an environment file symlink that escapes the registered project root', async () => {
    const repositoryPath = await createTemporaryDirectory('devryan-escaping-env-');
    const outsidePath = await createTemporaryDirectory('devryan-outside-env-');
    await fs.promises.writeFile(path.join(outsidePath, 'external.env'), 'VITE_ESCAPED=no\n');
    await fs.promises.symlink(path.join(outsidePath, 'external.env'), path.join(repositoryPath, '.env'));

    await expect(loadProjectPublicEnvironment({
      repositoryPath,
      fileSystem: fs,
      pathApi: path,
    })).rejects.toMatchObject({ code: 'PROJECT_ENV_OUTSIDE_ROOT' });
  });

  it('rejects files above the configured byte limit without returning their contents', async () => {
    const repositoryPath = await createTemporaryDirectory('devryan-large-env-');
    const secretValue = 'do-not-return-this-value';
    await fs.promises.writeFile(path.join(repositoryPath, '.env'), `VITE_VALUE=${secretValue}\n`);

    let failure;
    try {
      await loadProjectPublicEnvironment({
        repositoryPath,
        fileSystem: fs,
        pathApi: path,
        maxFileBytes: 8,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'PROJECT_ENV_TOO_LARGE' });
    expect(failure.message).not.toContain(secretValue);
    expect(failure.message).not.toContain(repositoryPath);
  });
});
