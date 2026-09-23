import fs from 'node:fs';
import path from 'node:path';

import { isInvalidJsoncError, parseConfigJsonc } from './jsonc-config.js';
import { getProjectLegacyConfigPaths, getProjectOfficialConfigPaths } from './mcp-sources.js';
import { CONFIG_FILE, CUSTOM_CONFIG_FILE, OPENCODE_CONFIG_DIR } from './shared.js';

// Report-only scan of raw (pre-substitution) OpenCode config layers for
// credentials written as literal values. {env:...} and {file:...} references
// are the supported way to supply secrets and are never flagged. Results carry
// only layer paths, key paths, and a credential kind; values never leave here.

const CREDENTIAL_KINDS = Object.freeze([
  ['anthropic-api-key', /(?:^|[^A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/],
  ['api-key', /(?:^|[^A-Za-z0-9])sk-(?!ant-)[A-Za-z0-9_-]{20,}/],
  ['github-token', /(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/],
  ['slack-token', /(?:^|[^A-Za-z0-9])xox[abp]-[A-Za-z0-9-]{10,}/],
  ['aws-access-key-id', /(?:^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Z])/],
  ['bearer-token', /(?:^|[^A-Za-z0-9])Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
]);

const REFERENCE_PATTERN = /\{(?:env|file):[^}]*\}/g;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const classifyCredential = (value) => {
  if (typeof value !== 'string') return null;
  const literal = value.replace(REFERENCE_PATTERN, ' ');
  const match = CREDENTIAL_KINDS.find(([, pattern]) => pattern.test(literal));
  return match ? match[0] : null;
};

// Narrow, explicit field coverage: credential-bearing maps and keys only.
const collectCandidateValues = (config) => {
  const candidates = [];
  const pushMap = (prefix, map) => {
    if (!isRecord(map)) return;
    for (const [key, value] of Object.entries(map)) candidates.push([`${prefix}.${key}`, value]);
  };
  if (isRecord(config.mcp)) {
    for (const [name, server] of Object.entries(config.mcp)) {
      if (!isRecord(server)) continue;
      pushMap(`mcp.${name}.environment`, server.environment);
      pushMap(`mcp.${name}.headers`, server.headers);
    }
  }
  if (isRecord(config.provider)) {
    for (const [id, provider] of Object.entries(config.provider)) {
      const options = isRecord(provider) ? provider.options : null;
      if (!isRecord(options)) continue;
      if ('apiKey' in options) candidates.push([`provider.${id}.options.apiKey`, options.apiKey]);
      pushMap(`provider.${id}.options.headers`, options.headers);
    }
  }
  return candidates;
};

const getConfigCredentialSources = ({ directory } = {}) => {
  const sources = [
    { origin: 'user-legacy', path: CONFIG_FILE },
    { origin: 'user', path: path.join(OPENCODE_CONFIG_DIR, 'opencode.json') },
    { origin: 'user', path: path.join(OPENCODE_CONFIG_DIR, 'opencode.jsonc') },
    ...(CUSTOM_CONFIG_FILE ? [{ origin: 'custom', path: CUSTOM_CONFIG_FILE }] : []),
    ...getProjectLegacyConfigPaths(directory).map((sourcePath) => ({ origin: 'project-legacy', path: sourcePath })),
    ...getProjectOfficialConfigPaths(directory).map((sourcePath) => ({ origin: 'project', path: sourcePath })),
  ];
  const seen = new Set();
  return sources.filter((source) => !seen.has(source.path) && seen.add(source.path));
};

const scanConfigCredentialSources = (sources, { readFile = (filePath) => fs.readFileSync(filePath, 'utf8') } = {}) => {
  const coverage = [];
  const findings = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    let content;
    try {
      content = readFile(source.path);
    } catch (error) {
      coverage.push({ origin: source.origin, path: source.path,
        availability: error?.code === 'ENOENT' ? 'absent' : 'unavailable',
        ...(error?.code === 'ENOENT' ? {} : { reason: 'readFailed' }) });
      continue;
    }
    let config;
    try {
      config = parseConfigJsonc(content, source.path);
    } catch (error) {
      // Parser messages are never forwarded: they could quote file content.
      coverage.push({ origin: source.origin, path: source.path, availability: 'unavailable',
        reason: isInvalidJsoncError(error) ? 'invalidJsonc' : 'parseFailed' });
      continue;
    }
    coverage.push({ origin: source.origin, path: source.path, availability: 'scanned' });
    for (const [keyPath, value] of collectCandidateValues(config)) {
      const kind = classifyCredential(value);
      if (kind) findings.push({ origin: source.origin, path: source.path, keyPath, kind });
    }
  }
  const unavailable = coverage.some((entry) => entry.availability === 'unavailable');
  const scanned = coverage.some((entry) => entry.availability === 'scanned');
  return {
    availability: unavailable ? (scanned ? 'partial' : 'unavailable') : 'complete',
    sources: coverage,
    findings,
  };
};

const readConfigCredentialScan = (context = {}, options = {}) => scanConfigCredentialSources(
  getConfigCredentialSources(context),
  options,
);

export {
  classifyCredential,
  getConfigCredentialSources,
  readConfigCredentialScan,
  scanConfigCredentialSources,
};
