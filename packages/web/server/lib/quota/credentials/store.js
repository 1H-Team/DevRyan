import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES = 16 * 1024;
export const MANAGED_QUOTA_PROVIDER_IDS = Object.freeze([
  'opencode',
  'ollama-cloud',
  'cursor-acp',
]);

const providerAliases = new Map([
  ['cursor', 'cursor-acp'],
]);
const managedProviderIds = new Set(MANAGED_QUOTA_PROVIDER_IDS);

export class QuotaCredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QuotaCredentialError';
    this.code = code;
  }
}

export const canonicalizeManagedQuotaProviderId = (providerId) => {
  const value = typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
  const canonical = providerAliases.get(value) ?? value;
  if (!managedProviderIds.has(canonical)) {
    throw new QuotaCredentialError('UNSUPPORTED_PROVIDER', 'Unsupported credential provider');
  }
  return canonical;
};

export const getQuotaCredentialsDirectory = ({
  env = process.env,
  homedir = os.homedir,
  pathImpl = path,
} = {}) => pathImpl.join(
  env.OPENCHAMBER_DATA_DIR
    ? pathImpl.resolve(env.OPENCHAMBER_DATA_DIR)
    : pathImpl.join(homedir(), '.config', 'openchamber'),
  'quota',
);

export const getQuotaCredentialPath = (providerId, options = {}) => {
  const canonical = canonicalizeManagedQuotaProviderId(providerId);
  const pathImpl = options.pathImpl ?? path;
  return pathImpl.join(getQuotaCredentialsDirectory(options), `${canonical}.json`);
};

export const readQuotaCredential = (providerId, normalize, options = {}) => {
  const fsImpl = options.fsImpl ?? fs;
  const target = getQuotaCredentialPath(providerId, options);
  try {
    const stat = fsImpl.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES) {
      throw new QuotaCredentialError('INVALID_CREDENTIAL', 'Stored credential is invalid');
    }
    const parsed = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
    return normalize(parsed);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // Deliberately omit the provider payload and error details: parser and
      // filesystem errors can include sensitive fragments or local paths.
      console.warn('[quota-credentials] Managed credential could not be read');
    }
    return null;
  }
};

export const writeQuotaCredential = (providerId, credential, options = {}) => {
  const fsImpl = options.fsImpl ?? fs;
  const pathImpl = options.pathImpl ?? path;
  const target = getQuotaCredentialPath(providerId, options);
  const directory = pathImpl.dirname(target);
  const serialized = `${JSON.stringify(credential, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES) {
    throw new QuotaCredentialError('INVALID_CREDENTIAL', 'Credential is too large');
  }

  const randomUUID = options.randomUUID ?? crypto.randomUUID;
  const temporary = pathImpl.join(
    directory,
    `.${pathImpl.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fsImpl.chmodSync(directory, 0o700);

  try {
    fsImpl.writeFileSync(temporary, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fsImpl.chmodSync(temporary, 0o600);
    fsImpl.renameSync(temporary, target);
    fsImpl.chmodSync(target, 0o600);
  } finally {
    try {
      fsImpl.unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('[quota-credentials] Temporary credential cleanup failed');
      }
    }
  }
};

export const deleteQuotaCredential = (providerId, options = {}) => {
  const fsImpl = options.fsImpl ?? fs;
  try {
    const target = getQuotaCredentialPath(providerId, options);
    const stat = fsImpl.lstatSync(target);
    if (stat.isDirectory()) {
      throw new QuotaCredentialError('INVALID_CREDENTIAL', 'Stored credential is invalid');
    }
    fsImpl.unlinkSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
};

export const deleteLegacyOpenCodeGoQuotaCredential = (options = {}) => {
  const fsImpl = options.fsImpl ?? fs;
  const pathImpl = options.pathImpl ?? path;
  const target = pathImpl.join(getQuotaCredentialsDirectory(options), 'opencode-go.json');
  try {
    fsImpl.unlinkSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
};
