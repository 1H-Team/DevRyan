import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import {
  ManagedBrowserPolicyError,
  REQUIRED_BROWSER_POLICY,
  verifyManagedBrowserPolicy,
} from './managed-policy.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policyPath = path.join(
  packageDirectory,
  'chromium-policies',
  'managed',
  'devryan-browser.json',
);

describe('managed Bot Chromium policy', () => {
  test('forces JavaScript, first- and third-party cookies, and session restore on', async () => {
    const policy = JSON.parse(await fs.readFile(policyPath, 'utf8'));

    expect(policy).toEqual(REQUIRED_BROWSER_POLICY);
    // "Continue where you left off" keeps session cookies across Chromium restarts.
    expect(policy.RestoreOnStartup).toBe(1);
    expect(Object.keys(policy)).toEqual([
      'BlockThirdPartyCookies', 'DefaultCookiesSetting', 'DefaultJavaScriptSetting', 'RestoreOnStartup',
    ]);
  });

  test('rejects the previous policy shape without session restore', async () => {
    const { RestoreOnStartup, ...withoutRestore } = REQUIRED_BROWSER_POLICY;
    expect(RestoreOnStartup).toBe(1);
    await expect(verifyManagedBrowserPolicy({
      fsPromises: {
        readFile: async () => JSON.stringify(withoutRestore),
        stat: async () => ({ isFile: () => true, uid: 0, mode: 0o100644 }),
      },
    })).rejects.toBeInstanceOf(ManagedBrowserPolicyError);
  });

  test('installs the root-owned policy before the image switches users', async () => {
    const dockerfile = await fs.readFile(path.join(packageDirectory, 'Dockerfile'), 'utf8');
    const copy = 'COPY --chown=0:0 packages/bot-computer/chromium-policies/managed/devryan-browser.json';

    expect(dockerfile).toContain(copy);
    expect(dockerfile).toContain('/etc/chromium/policies/managed/devryan-browser.json');
    expect(dockerfile.indexOf(copy)).toBeLessThan(dockerfile.indexOf('USER 10001:10001'));
    expect(dockerfile).toContain('xvfb');
  });

  test('requires the exact root-owned, non-writable managed policy', async () => {
    const validFs = {
      readFile: async () => JSON.stringify(REQUIRED_BROWSER_POLICY),
      stat: async () => ({ isFile: () => true, uid: 0, mode: 0o100644 }),
    };
    await expect(verifyManagedBrowserPolicy({ fsPromises: validFs })).resolves.toEqual({
      managedPolicy: 'enforced',
      javascript: 'enabled',
      firstPartyCookies: 'enabled',
      thirdPartyCookies: 'enabled',
    });
    await expect(verifyManagedBrowserPolicy({
      fsPromises: { ...validFs, stat: async () => ({ isFile: () => true, uid: 10001, mode: 0o100664 }) },
    })).rejects.toBeInstanceOf(ManagedBrowserPolicyError);
  });
});
