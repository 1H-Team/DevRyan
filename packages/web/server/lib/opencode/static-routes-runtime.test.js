import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createStaticRoutesRuntime,
  IMMUTABLE_ASSET_CACHE_CONTROL,
  INDEX_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  SERVICE_WORKER_CACHE_CONTROL,
} from './static-routes-runtime.js';

const createRuntimeFixture = () => {
  const app = {
    get: vi.fn(),
    use: vi.fn(),
  };
  let staticOptions;
  const express = {
    static: vi.fn((_directory, options) => {
      staticOptions = options;
      return vi.fn();
    }),
  };
  const runtime = createStaticRoutesRuntime({
    fs: { existsSync: vi.fn(() => true) },
    path,
    process: { env: { OPENCHAMBER_DIST_DIR: '/tmp/devryan-dist' } },
    __dirname: '/tmp/server',
    express,
    resolveProjectDirectory: vi.fn(),
    buildOpenCodeUrl: vi.fn(),
    getOpenCodeAuthHeaders: vi.fn(),
    readSettingsFromDiskMigrated: vi.fn(),
    normalizePwaAppName: vi.fn(),
    normalizePwaOrientation: vi.fn(),
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  runtime.registerStaticRoutes(app);
  return { app, staticOptions };
};

const cacheControlFor = (setHeaders, filePath) => {
  const headers = new Map();
  setHeaders({ setHeader: (name, value) => headers.set(name, value) }, filePath);
  return headers.get('Cache-Control');
};

describe('static route caching', () => {
  it('keeps versioned assets immutable while revalidating mutable entry files', () => {
    const { staticOptions } = createRuntimeFixture();

    expect(cacheControlFor(staticOptions.setHeaders, path.join('/tmp/devryan-dist', 'assets', 'app-a1b2.js')))
      .toBe(IMMUTABLE_ASSET_CACHE_CONTROL);
    expect(cacheControlFor(staticOptions.setHeaders, path.join('/tmp/devryan-dist', 'index.html')))
      .toBe(INDEX_CACHE_CONTROL);
    expect(cacheControlFor(staticOptions.setHeaders, path.join('/tmp/devryan-dist', 'sw.js')))
      .toBe(SERVICE_WORKER_CACHE_CONTROL);
    expect(cacheControlFor(staticOptions.setHeaders, path.join('/tmp/devryan-dist', 'favicon.svg')))
      .toBe(REVALIDATE_CACHE_CONTROL);
  });

  it('marks the SPA fallback shell for revalidation', () => {
    const { app } = createRuntimeFixture();
    const fallbackHandler = app.get.mock.calls.at(-1)?.[1];
    const response = {
      setHeader: vi.fn(),
      sendFile: vi.fn(),
    };

    fallbackHandler({}, response);

    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', INDEX_CACHE_CONTROL);
    expect(response.sendFile).toHaveBeenCalledWith(path.join('/tmp/devryan-dist', 'index.html'));
  });
});
