// Content-addressed Bot runtime image inputs: an image whose Dockerfile, ignore
// rules, build recipe and copied repository files are unchanged is reused from a
// previous signed release instead of being rebuilt.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  BOT_RUNTIME_IMAGE_KEYS,
  BOT_RUNTIME_RELEASE_PLATFORM_KEYS,
} from '../packages/electron/bot-runtime-manifest.mjs';
import {
  BOT_RUNTIME_IMAGE_DEFINITIONS,
  BotRuntimeImageBuildError,
  collectBotRuntimeImageMetadata,
  createBotRuntimeImageBuildPlan,
  createBotRuntimeImageResult,
  defaultCommandRunner,
  loadAttestationDocuments,
  readBotRuntimeReleaseMetadata,
} from './build-bot-runtime-images.mjs';
import { defaultRegistryProbe, registryFailureKind } from './verify-bot-runtime-images.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PINNED_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/:-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const IMAGE_REPOSITORY_PATTERN = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const INPUTS_SCHEMA = 'devryan-bot-runtime-image-inputs/v1';
const KNOWN_INSTRUCTIONS = new Set([
  'FROM', 'RUN', 'CMD', 'LABEL', 'EXPOSE', 'ENV', 'ADD', 'COPY', 'ENTRYPOINT', 'VOLUME',
  'USER', 'WORKDIR', 'ARG', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL', 'MAINTAINER',
]);
const ADDRESSABLE_RUN_MOUNTS = new Set(['cache', 'tmpfs', 'secret', 'ssh']);

export const BOT_RUNTIME_IMAGE_SIGNER_ISSUER = 'https://token.actions.githubusercontent.com';

// The release workflow's docker/build-push-action inputs that shape image content;
// scripts/release-workflow.test.mjs pins the workflow to these values.
export const BOT_RUNTIME_IMAGE_BUILD_RECIPE = Object.freeze({
  context: '.',
  platforms: BOT_RUNTIME_RELEASE_PLATFORM_KEYS,
  provenance: 'mode=max',
  sbom: true,
});

const fail = (message, code, options) => {
  throw new BotRuntimeImageBuildError(message, code, options);
};
const unaddressable = (message) => fail(message, 'bot_runtime_image_inputs_unaddressable');
const sha256 = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const byFile = (left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0);
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function botRuntimeImageInputTag(digest) {
  if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
    fail('Bot runtime image input digest is invalid', 'bot_runtime_image_digest_invalid');
  }
  return `in-${digest.slice('sha256:'.length)}`;
}

// Keyless signatures are accepted only from release.yml in this repository at a v* tag.
export function botRuntimeImageSignerIdentity(repository) {
  if (typeof repository !== 'string' || !GITHUB_REPOSITORY_PATTERN.test(repository)) {
    fail('Bot runtime image signer repository is invalid', 'bot_runtime_image_build_input_invalid');
  }
  return `^https://github\\.com/${escapeRegExp(repository)}/\\.github/workflows/release\\.yml@refs/tags/v[0-9A-Za-z][0-9A-Za-z.+-]*$`;
}

// --- Dockerfile parsing -----------------------------------------------------

const logicalInstructions = (text, dockerfile) => {
  const lines = text.split(/\r?\n/);
  let index = 0;
  for (; index < lines.length; index += 1) {
    const directive = /^\s*#\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.*?)\s*$/.exec(lines[index]);
    if (!directive) break;
    if (['syntax', 'escape'].includes(directive[1].toLowerCase())) {
      unaddressable(`${dockerfile} uses the unsupported ${directive[1]} parser directive`);
    }
  }
  const instructions = [];
  let current = '';
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*#/.test(line)) continue;
    if (!current && !line.trim()) continue;
    const continued = /\\\s*$/.exec(line);
    if (continued) {
      current += `${line.slice(0, continued.index)} `;
      continue;
    }
    instructions.push(`${current}${line}`.trim());
    current = '';
  }
  if (current.trim()) instructions.push(current.trim());
  return instructions;
};

const splitFlags = (tokens) => {
  const flags = [];
  let index = 0;
  while (index < tokens.length && tokens[index].startsWith('--')) {
    const separator = tokens[index].indexOf('=');
    flags.push(separator === -1
      ? { name: tokens[index].slice(2), value: 'true' }
      : { name: tokens[index].slice(2, separator), value: tokens[index].slice(separator + 1) });
    index += 1;
  }
  return { flags, rest: tokens.slice(index) };
};

const normalizeSource = (source, dockerfile) => {
  if (!source || source.includes('$')) unaddressable(`${dockerfile} copies a variable source`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^git@/i.test(source)) {
    unaddressable(`${dockerfile} adds a remote source`);
  }
  if (/[*?[\]]/.test(source)) unaddressable(`${dockerfile} copies a glob source`);
  const normalized = path.posix.normalize(source.replace(/^\/+/, '') || '.');
  if (normalized === '..' || normalized.startsWith('../')) {
    unaddressable(`${dockerfile} copies a source outside the build context`);
  }
  return normalized.replace(/\/+$/, '') || '.';
};

export function parseBotRuntimeDockerfile(text, dockerfile = 'Dockerfile') {
  const stages = [];
  const bases = [];
  const sources = [];
  for (const instruction of logicalInstructions(text, dockerfile)) {
    const match = /^([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(instruction);
    if (!match) unaddressable(`${dockerfile} contains an unparseable instruction`);
    const keyword = match[1].toUpperCase();
    const body = match[2] || '';
    if (!KNOWN_INSTRUCTIONS.has(keyword)) {
      unaddressable(`${dockerfile} uses the unsupported ${keyword} instruction`);
    }
    if (['RUN', 'COPY', 'ADD'].includes(keyword) && /<<-?\s*["']?[A-Za-z_]/.test(body)) {
      unaddressable(`${dockerfile} uses a heredoc`);
    }
    const tokens = body.trim().split(/\s+/).filter(Boolean);
    if (keyword === 'FROM') {
      const { flags, rest } = splitFlags(tokens);
      if (flags.some((flag) => flag.name !== 'platform')) unaddressable(`${dockerfile} uses an unsupported FROM flag`);
      const [image, as, name, ...extra] = rest;
      if (!image || extra.length || (as !== undefined && (as.toLowerCase() !== 'as' || !name))) {
        unaddressable(`${dockerfile} contains an unparseable FROM instruction`);
      }
      if (image !== 'scratch' && !stages.includes(image.toLowerCase())) {
        if (image.includes('$') || !PINNED_IMAGE_PATTERN.test(image)) {
          unaddressable(`${dockerfile} uses a base image that is not pinned by digest`);
        }
        bases.push(image);
      }
      stages.push(name ? name.toLowerCase() : `#${stages.length}`);
      continue;
    }
    if (keyword === 'RUN') {
      const { flags } = splitFlags(tokens);
      for (const flag of flags) {
        if (flag.name !== 'mount') continue;
        const options = Object.fromEntries(flag.value.split(',').map((part) => {
          const separator = part.indexOf('=');
          return separator === -1 ? [part, 'true'] : [part.slice(0, separator), part.slice(separator + 1)];
        }));
        if (!ADDRESSABLE_RUN_MOUNTS.has(options.type || 'bind') || options.from !== undefined || options.source !== undefined) {
          unaddressable(`${dockerfile} mounts build-context content into RUN`);
        }
      }
      continue;
    }
    if (keyword !== 'COPY' && keyword !== 'ADD') continue;
    let flags;
    let operands;
    const trimmed = body.trim();
    const jsonStart = splitFlags(tokens);
    if (jsonStart.rest.join(' ').startsWith('[')) {
      flags = jsonStart.flags;
      try {
        operands = JSON.parse(jsonStart.rest.join(' '));
      } catch (error) {
        unaddressable(`${dockerfile} contains an unparseable ${keyword} instruction`);
      }
      if (!Array.isArray(operands) || operands.some((value) => typeof value !== 'string')) {
        unaddressable(`${dockerfile} contains an unparseable ${keyword} instruction`);
      }
    } else {
      if (/["']/.test(trimmed)) unaddressable(`${dockerfile} quotes a ${keyword} operand`);
      ({ flags, rest: operands } = jsonStart);
    }
    if (operands.length < 2) unaddressable(`${dockerfile} contains an incomplete ${keyword} instruction`);
    const from = flags.find((flag) => flag.name === 'from');
    if (flags.some((flag) => !['chown', 'chmod', 'from', 'link'].includes(flag.name))) {
      unaddressable(`${dockerfile} uses an unsupported ${keyword} flag`);
    }
    if (from) {
      const value = from.value.toLowerCase();
      const stageIndex = /^\d+$/.test(value) ? Number(value) : -1;
      if (stages.includes(value) || (stageIndex >= 0 && stageIndex < stages.length)) continue;
      if (from.value.includes('$') || !PINNED_IMAGE_PATTERN.test(from.value)) {
        unaddressable(`${dockerfile} copies from an image that is not pinned by digest`);
      }
      bases.push(from.value);
      continue;
    }
    for (const source of operands.slice(0, -1)) sources.push(normalizeSource(source, dockerfile));
  }
  if (!stages.length) unaddressable(`${dockerfile} has no FROM instruction`);
  return { bases, sources: [...new Set(sources)].sort() };
}

// --- .dockerignore matching (BuildKit/moby pattern semantics) ----------------

const compileIgnorePattern = (pattern) => {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') index += 1;
        expression += index + 1 >= pattern.length ? '.*' : '(?:.*/)?';
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else if (character === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end === -1) unaddressable('A .dockerignore pattern has an unterminated character class');
      const body = pattern.slice(index + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
      expression += `[${body}]`;
      index = end;
    } else if (character === '\\' && index + 1 < pattern.length) {
      index += 1;
      expression += escapeRegExp(pattern[index]);
    } else {
      expression += escapeRegExp(character);
    }
  }
  return new RegExp(`${expression}$`);
};

export function parseDockerIgnore(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => {
    const exclusion = line.startsWith('!');
    let pattern = (exclusion ? line.slice(1) : line).trim();
    pattern = path.posix.normalize(pattern);
    if (pattern.length > 1 && pattern.startsWith('/')) pattern = pattern.slice(1);
    return { exclusion, pattern: compileIgnorePattern(pattern) };
  });
}

const isIgnored = (patterns, file) => {
  const parents = file.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
  let ignored = false;
  for (const { exclusion, pattern } of patterns) {
    if (pattern.test(file) || parents.some((parent) => pattern.test(parent))) ignored = !exclusion;
  }
  return ignored;
};

// --- Input digest -------------------------------------------------------------

const normalizedContent = (file, bytes) => {
  const name = path.posix.basename(file);
  if (name !== 'package.json' && name !== 'package-lock.json') return bytes;
  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    return bytes;
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return bytes;
  // The release version is rewritten every release; only the root field is ignored.
  delete document.version;
  if (name === 'package-lock.json' && document.packages?.[''] && typeof document.packages[''] === 'object') {
    delete document.packages[''].version;
  }
  return Buffer.from(JSON.stringify(document));
};

const describeFile = async (root, file, stats, fsPromises) => ({
  file,
  mode: stats.mode & 0o111 ? '100755' : '100644',
  sha256: sha256(normalizedContent(file, await fsPromises.readFile(path.join(root, file)))),
});

const collectSource = async ({ root, source, patterns, fsPromises, entries }) => {
  if (source !== '.' && isIgnored(patterns, source)) {
    // BuildKit refuses an explicitly named ignored source, so that build fails; record it.
    entries.set(source, { file: source, excluded: true });
    return;
  }
  // Without negations an ignored directory is pruned; with them its files are checked one by one.
  const negations = patterns.some((pattern) => pattern.exclusion);
  const visit = async (file) => {
    const stats = await fsPromises.lstat(path.join(root, file)).catch((error) => {
      if (error?.code === 'ENOENT') unaddressable(`Bot runtime image source ${file} does not exist`);
      throw error;
    });
    if (stats.isSymbolicLink()) unaddressable(`Bot runtime image source ${file} is a symbolic link`);
    const ignored = file !== source && isIgnored(patterns, file);
    if (stats.isFile()) {
      if (!ignored) entries.set(file, await describeFile(root, file, stats, fsPromises));
      return;
    }
    if (!stats.isDirectory()) unaddressable(`Bot runtime image source ${file} is not a regular file`);
    if (ignored && !negations) return;
    for (const child of (await fsPromises.readdir(path.join(root, file))).sort()) {
      await visit(file === '.' ? child : `${file}/${child}`);
    }
  };
  await visit(source);
};

const readOptional = async (root, file, fsPromises) => {
  try {
    const stats = await fsPromises.lstat(path.join(root, file));
    if (stats.isSymbolicLink() || !stats.isFile()) unaddressable(`${file} is not a regular file`);
    return { stats, bytes: await fsPromises.readFile(path.join(root, file)) };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

export async function readBotRuntimeImageInputs({ key, root = repositoryRoot, fsPromises = fs } = {}) {
  const definition = BOT_RUNTIME_IMAGE_DEFINITIONS[key];
  if (!BOT_RUNTIME_IMAGE_KEYS.includes(key) || !definition || typeof root !== 'string' || !path.isAbsolute(root)) {
    fail('Bot runtime image input request is invalid', 'bot_runtime_image_build_input_invalid');
  }
  const { dockerfile } = definition;
  const dockerfileInput = await readOptional(root, dockerfile, fsPromises);
  if (!dockerfileInput) unaddressable(`${dockerfile} does not exist`);
  const { bases, sources } = parseBotRuntimeDockerfile(dockerfileInput.bytes.toString('utf8'), dockerfile);
  const entries = new Map();
  entries.set(dockerfile, { file: dockerfile, mode: '100644', sha256: sha256(dockerfileInput.bytes) });
  // BuildKit prefers <Dockerfile>.dockerignore over the context .dockerignore; both are inputs.
  let patterns = [];
  for (const ignoreFile of ['.dockerignore', `${dockerfile}.dockerignore`]) {
    const input = await readOptional(root, ignoreFile, fsPromises);
    if (!input) continue;
    entries.set(ignoreFile, { file: ignoreFile, mode: '100644', sha256: sha256(input.bytes) });
    patterns = parseDockerIgnore(input.bytes.toString('utf8'));
  }
  const copied = new Map();
  for (const source of sources) await collectSource({ root, source, patterns, fsPromises, entries: copied });
  for (const [file, entry] of copied) if (!entries.has(file)) entries.set(file, entry);
  const files = [...entries.values()].sort(byFile);
  const digest = sha256(JSON.stringify({
    schema: INPUTS_SCHEMA,
    key,
    name: definition.name,
    dockerfile,
    recipe: BOT_RUNTIME_IMAGE_BUILD_RECIPE,
    files,
  }));
  return Object.freeze({ key, digest, dockerfile, bases: Object.freeze(bases), files: Object.freeze(files) });
}

// --- Registry resolution ------------------------------------------------------

const REGISTRY_REASONS = Object.freeze({
  missing: 'missing',
  'not anonymously accessible': 'not_public',
  unreachable: 'unreachable',
});

const parseJsonBytes = (bytes) => JSON.parse(Buffer.from(bytes).toString('utf8'));

const resolveReusableImage = async ({
  build, inputDigest, identity, runner, probe, anonymousEnvironment, commandOptions,
}) => {
  const registryReason = async (reference) => {
    const result = await probe(reference, { environment: anonymousEnvironment });
    return result?.exitCode === 0 ? null : REGISTRY_REASONS[registryFailureKind(result)] || 'unreachable';
  };
  const tag = `${build.repository}:${botRuntimeImageInputTag(inputDigest)}`;
  const tagReason = await registryReason(tag);
  if (tagReason) return { reason: tagReason };
  let indexBytes;
  try {
    indexBytes = runner.capture('docker', ['buildx', 'imagetools', 'inspect', '--raw', tag], commandOptions);
  } catch {
    return { reason: 'index_unreadable' };
  }
  const indexDigest = sha256(indexBytes);
  let metadata;
  try {
    const indexDocument = parseJsonBytes(indexBytes);
    metadata = collectBotRuntimeImageMetadata({
      repository: build.repository,
      indexDigest,
      indexDocument,
      attestationDocuments: loadAttestationDocuments(runner, build.repository, indexDocument, commandOptions),
    });
  } catch (error) {
    return { reason: error?.code === 'bot_runtime_image_attestation_missing' ? 'attestations_incomplete' : 'index_invalid' };
  }
  const digests = [metadata.indexDigest, ...Object.values(metadata.platforms).map((platform) => platform.digest)];
  for (const digest of digests) {
    try {
      const verified = parseJsonBytes(runner.capture('cosign', [
        'verify',
        '--certificate-identity-regexp', identity,
        '--certificate-oidc-issuer', BOT_RUNTIME_IMAGE_SIGNER_ISSUER,
        `${build.repository}@${digest}`,
      ], commandOptions));
      if (!Array.isArray(verified) || verified.length === 0) return { reason: 'signature_unverified' };
    } catch {
      return { reason: 'signature_unverified' };
    }
  }
  for (const digest of digests) {
    const reason = await registryReason(`${build.repository}@${digest}`);
    if (reason) return { reason };
  }
  return {
    image: {
      name: build.name,
      repository: build.repository,
      indexDigest: metadata.indexDigest,
      platforms: metadata.platforms,
    },
  };
};

export async function resolveBotRuntimeImages({
  version,
  revision,
  repositoryPrefix,
  workflowRepository,
  keys = BOT_RUNTIME_IMAGE_KEYS,
  rebuild = false,
  root = repositoryRoot,
  runner = defaultCommandRunner,
  probe = defaultRegistryProbe,
  environment = process.env,
  fsPromises = fs,
} = {}) {
  const plan = createBotRuntimeImageBuildPlan({ version, revision, repositoryPrefix, root });
  if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length
    || keys.some((key) => !BOT_RUNTIME_IMAGE_KEYS.includes(key)) || typeof rebuild !== 'boolean'
    || typeof runner?.capture !== 'function' || typeof probe !== 'function'
    || !environment || typeof environment !== 'object') {
    fail('Bot runtime image resolution input is invalid', 'bot_runtime_image_build_input_invalid');
  }
  const identity = botRuntimeImageSignerIdentity(workflowRepository);
  const ordered = BOT_RUNTIME_IMAGE_KEYS.filter((key) => keys.includes(key));
  const inputs = {};
  for (const key of ordered) inputs[key] = (await readBotRuntimeImageInputs({ key, root, fsPromises })).digest;
  if (rebuild) {
    return {
      inputs,
      build: ordered,
      reasons: Object.fromEntries(ordered.map((key) => [key, 'rebuild_requested'])),
      reused: [],
    };
  }
  const metadata = await readBotRuntimeReleaseMetadata({ root, version, fsPromises });
  const dockerConfig = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'devryan-bot-registry-'));
  const anonymousEnvironment = { ...environment, DOCKER_CONFIG: dockerConfig };
  delete anonymousEnvironment.DOCKER_AUTH_CONFIG;
  delete anonymousEnvironment.REGISTRY_AUTH_FILE;
  const commandOptions = { cwd: root, env: environment };
  const build = [];
  const reasons = {};
  const reused = [];
  try {
    for (const key of ordered) {
      const entry = plan.builds.find((candidate) => candidate.key === key);
      const outcome = await resolveReusableImage({
        build: entry, inputDigest: inputs[key], identity, runner, probe, anonymousEnvironment, commandOptions,
      });
      if (outcome.image) {
        reused.push(createBotRuntimeImageResult({ version, revision, repositoryPrefix, metadata, key, image: outcome.image }));
      } else {
        build.push(key);
        reasons[key] = outcome.reason;
      }
    }
  } finally {
    await fsPromises.rm(dockerConfig, { recursive: true, force: true }).catch(() => undefined);
  }
  return { inputs, build, reasons, reused };
}

// Tags a freshly signed image with its input digest. Only tag-triggered release.yml
// runs carry a signer identity a later release accepts; other runs are not tagged.
export async function tagBotRuntimeImageInputs({
  repository,
  indexDigest,
  inputDigest,
  environment = process.env,
  runner = defaultCommandRunner,
} = {}) {
  if (typeof repository !== 'string' || !IMAGE_REPOSITORY_PATTERN.test(repository)
    || typeof indexDigest !== 'string' || !DIGEST_PATTERN.test(indexDigest)
    || typeof runner?.run !== 'function' || typeof runner?.capture !== 'function'
    || !environment || typeof environment !== 'object') {
    fail('Bot runtime image input tag request is invalid', 'bot_runtime_image_build_input_invalid');
  }
  const tag = botRuntimeImageInputTag(inputDigest);
  const { GITHUB_REPOSITORY: workflowRepository, GITHUB_REF: ref, GITHUB_WORKFLOW_REF: workflowRef } = environment;
  if (typeof workflowRepository !== 'string' || !GITHUB_REPOSITORY_PATTERN.test(workflowRepository)
    || typeof ref !== 'string' || !ref.startsWith('refs/tags/v')
    || workflowRef !== `${workflowRepository}/.github/workflows/release.yml@${ref}`
    || !new RegExp(botRuntimeImageSignerIdentity(workflowRepository)).test(`https://github.com/${workflowRef}`)) {
    return null;
  }
  const reference = `${repository}:${tag}`;
  const commandOptions = { env: environment };
  runner.run('docker', ['buildx', 'imagetools', 'create', '--tag', reference, `${repository}@${indexDigest}`], commandOptions);
  const tagged = sha256(runner.capture('docker', ['buildx', 'imagetools', 'inspect', '--raw', reference], commandOptions));
  if (tagged !== indexDigest) {
    fail('Bot runtime image input tag does not resolve to the signed index', 'bot_runtime_image_input_tag_mismatch');
  }
  return reference;
}
