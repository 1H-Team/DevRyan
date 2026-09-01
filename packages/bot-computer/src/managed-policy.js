import fs from 'node:fs/promises';

export const REQUIRED_BROWSER_POLICY = Object.freeze({
  BlockThirdPartyCookies: false,
  DefaultCookiesSetting: 1,
  DefaultJavaScriptSetting: 1,
});

export class ManagedBrowserPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManagedBrowserPolicyError';
    this.code = 'DEVRYAN_BOT_BROWSER_POLICY_INVALID';
    this.statusCode = 500;
  }
}

export async function verifyManagedBrowserPolicy({
  policyPath = '/etc/chromium/policies/managed/devryan-browser.json',
  fsPromises = fs,
} = {}) {
  try {
    const [raw, stat] = await Promise.all([
      fsPromises.readFile(policyPath, 'utf8'),
      fsPromises.stat(policyPath),
    ]);
    const policy = JSON.parse(raw);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0
      || JSON.stringify(policy) !== JSON.stringify(REQUIRED_BROWSER_POLICY)) {
      throw new Error('policy mismatch');
    }
  } catch {
    throw new ManagedBrowserPolicyError('Managed Chromium policy is missing or invalid');
  }
  return Object.freeze({
    managedPolicy: 'enforced',
    javascript: 'enabled',
    firstPartyCookies: 'enabled',
    thirdPartyCookies: 'enabled',
  });
}
