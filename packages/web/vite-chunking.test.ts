import { describe, expect, it } from 'vitest';

import {
  resolveDependencyPackageName,
  resolveVendorChunkName,
} from './vite-chunking';

describe('resolveDependencyPackageName', () => {
  it.each([
    ['/repo/node_modules/react/index.js', 'react'],
    ['/repo/node_modules/@opencode-ai/sdk/dist/v2/client.js', '@opencode-ai/sdk'],
    ['/repo/node_modules/lodash/node_modules/zustand/middleware.js', 'zustand'],
    ['/repo/node_modules/.bun/react@19.1.1/node_modules/react/jsx-runtime.js', 'react'],
    ['/repo/node_modules/.pnpm/@base-ui+react@1.4.0/node_modules/@base-ui/react/index.js', '@base-ui/react'],
    ['C:\\repo\\node_modules\\.bun\\zustand@5.0.8\\node_modules\\zustand\\middleware.js', 'zustand'],
    ['/repo/node_modules/react/index.js?commonjs-proxy', 'react'],
    ['/repo/node_modules/@opencode-ai/sdk/dist/v2/client.js#vite-module', '@opencode-ai/sdk'],
    ['/repo/node_modules/react/index.js?redirect=/node_modules/zustand/index.js', 'react'],
    ['/repo/node_modules/react/index.js#source=/node_modules/@base-ui/react/index.js', 'react'],
  ])('selects the innermost dependency package from %s', (id, expected) => {
    expect(resolveDependencyPackageName(id)).toBe(expected);
  });

  it.each([
    '',
    '/repo/src/node_modules-helper.ts',
    '/repo/node_modules/',
    '/repo/node_modules/@scope',
    '/repo/node_modules/@scope/',
    '/repo/node_modules/@scope//index.js',
    '/repo/node_modules/@/package/index.js',
    '/repo/node_modules/@scope/@nested/index.js',
    '/repo/node_modules/@scope/.hidden/index.js',
    '/repo/node_modules/.bin/vite',
    '/repo/node_modules/.bun/react@19.1.1/index.js',
    '/repo/node_modules/.pnpm/react@19.1.1/index.js',
  ])('rejects malformed or non-dependency id %s', (id) => {
    expect(resolveDependencyPackageName(id)).toBeUndefined();
  });
});

describe('resolveVendorChunkName', () => {
  it.each([
    ['react', 'vendor-react'],
    ['react-dom', 'vendor-react'],
    ['zustand', 'vendor-zustand'],
    ['@opencode-ai/sdk', 'vendor-opencode-sdk'],
    ['react-markdown', 'vendor-markdown'],
    ['remark-gfm', 'vendor-markdown'],
    ['rehype-raw', 'vendor-markdown'],
    ['@base-ui/react', 'vendor-base-ui'],
    ['react-syntax-highlighter', 'vendor-syntax'],
    ['highlight.js', 'vendor-syntax'],
  ])('maps %s to the intentional %s group', (packageName, expected) => {
    expect(resolveVendorChunkName(`/repo/node_modules/${packageName}/index.js`)).toBe(expected);
  });

  it.each([
    '\0vite/preload-helper.js',
    'vite/preload-helper.js',
  ])('pins the Vite preload helper %s to its own chunk', (id) => {
    expect(resolveVendorChunkName(id)).toBe('vendor-vite-preload');
  });

  it.each([
    '/repo/node_modules/lodash/index.js',
    '/repo/node_modules/@remixicon/react/index.js',
    '/repo/node_modules/.bun/lodash@4.17.21/index.js',
    '/repo/src/main.tsx',
  ])('leaves %s under Rollup ownership', (id) => {
    expect(resolveVendorChunkName(id)).toBeUndefined();
  });
});
