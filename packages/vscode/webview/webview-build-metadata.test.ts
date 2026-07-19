import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import viteConfig from '../vite.config';

const BUILD_TIME_TOKEN = '__OPENCHAMBER_WEBVIEW_BUILD_TIME__';

const resolveViteConfig = async () => {
  if (typeof viteConfig !== 'function') throw new Error('Expected a Vite configuration factory');
  return viteConfig({
    command: 'build',
    mode: 'production',
    isPreview: false,
    isSsrBuild: false,
  });
};

const readWebviewStartupSource = () => readFileSync(
  new URL('./main.tsx', import.meta.url),
  'utf8',
);

describe('VS Code webview build metadata', () => {
  it.each([
    undefined,
    '1769338512',
  ])('does not inject build-time metadata for SOURCE_DATE_EPOCH=%s', async (sourceDateEpoch) => {
    const previousSourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
    if (sourceDateEpoch === undefined) {
      delete process.env.SOURCE_DATE_EPOCH;
    } else {
      process.env.SOURCE_DATE_EPOCH = sourceDateEpoch;
    }

    try {
      const config = await resolveViteConfig();
      expect(config.define).not.toHaveProperty(BUILD_TIME_TOKEN);
    } finally {
      if (previousSourceDateEpoch === undefined) {
        delete process.env.SOURCE_DATE_EPOCH;
      } else {
        process.env.SOURCE_DATE_EPOCH = previousSourceDateEpoch;
      }
    }
  });

  it('keeps the startup source free of build-time metadata', () => {
    const source = readWebviewStartupSource();

    expect(source).not.toContain(BUILD_TIME_TOKEN);
    expect(source).not.toContain('VS Code webview build:');
  });

  it('preserves startup diagnostics unrelated to build time', () => {
    const source = readWebviewStartupSource();

    expect(source).toContain('VS Code webview starting...');
    expect(source).toContain("console.log('[OpenChamber] Config:'");
  });
});
