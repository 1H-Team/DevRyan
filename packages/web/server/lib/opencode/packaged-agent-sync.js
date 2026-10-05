import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { withCrossProcessFileLock, writeFileAtomic } from '@openchamber/harness-runtime';

import { AGENT_DIR, OPENCODE_CONFIG_DIR } from './shared.js';
import {
  getEffectivePackagedAgentRuntimeFrontmatter,
  listAgentModelOverrides,
} from './agents.js';
import { sanitizeAgentSkillPolicy } from './skill-policy.js';
import { RELEASED_PACKAGED_AGENT_HASHES } from './packaged-agent-baselines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_DIR = path.resolve(__dirname, '../../default-config');
const DEFAULT_PACKAGED_AGENT_DIR = path.join(DEFAULT_CONFIG_DIR, 'agents');
const DEFAULT_MANIFEST_PATH = path.join(OPENCODE_CONFIG_DIR, '.openchamber', 'packaged-agents.json');
// The retired v1 user-profile provisioner kept its own baseline beside this manifest.
const PROFILE_MANIFEST_FILE_NAME = 'user-profile-manifest.json';
const PACKAGED_AGENT_BACKUP_DIRECTORY = path.join('backups', 'packaged-agents');

const hashContent = (content) => crypto.createHash('sha256').update(content).digest('hex');

const hashPackagedAgentSet = (agents) => {
  const hash = crypto.createHash('sha256');
  for (const agent of [...agents].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(agent.name);
    hash.update('\0');
    hash.update(agent.hash);
    hash.update('\n');
  }
  return hash.digest('hex');
};

const parseAgentMarkdownContent = (content) => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  return {
    frontmatter: yaml.parse(match[1]) || {},
    body: match[2].trim(),
  };
};

const formatAgentMarkdownContent = (frontmatter, body) => {
  const yamlContent = yaml.stringify(frontmatter).trimEnd();
  return `---\n${yamlContent}\n---\n\n${body.trim()}\n`;
};

const isPlainObject = (value) => (
  value
  && typeof value === 'object'
  && !Array.isArray(value)
);

const isManagedManifestEntry = (entry) => (
  isPlainObject(entry)
  && (
    typeof entry.hash === 'string'
    || typeof entry.packagedHash === 'string'
  )
);

const getManifestHash = (entry) => {
  if (!isManagedManifestEntry(entry)) {
    return null;
  }
  return typeof entry.hash === 'string' ? entry.hash : entry.packagedHash;
};

const createManifestEntry = (hash) => ({
  hash,
  packagedHash: hash,
});

const sortObjectByKey = (value) => Object.fromEntries(
  Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
);

const readManifestFile = async (filePath) => {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const trimmed = content.trim();
    if (!trimmed) {
      return { version: 1, packagedSetHash: null, agents: {} };
    }
    const parsed = JSON.parse(trimmed);
    if (!isPlainObject(parsed)) {
      return { version: 1, packagedSetHash: null, agents: {} };
    }

    if (isPlainObject(parsed.agents)) {
      return {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        packagedSetHash: typeof parsed.packagedSetHash === 'string' ? parsed.packagedSetHash : null,
        agents: parsed.agents,
      };
    }

    const legacyEntries = {};
    for (const [name, entry] of Object.entries(parsed)) {
      if (isManagedManifestEntry(entry)) {
        legacyEntries[name] = entry;
      }
    }
    return { version: 1, packagedSetHash: null, agents: legacyEntries };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version: 1, packagedSetHash: null, agents: {} };
    }
    throw new Error(`Failed to read packaged agent sync manifest: ${error.message}`);
  }
};

// Agent hashes recorded by the retired user-profile provisioner, keyed by agent name.
const readProfileAgentHashes = async (filePath) => {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const files = isPlainObject(parsed) && isPlainObject(parsed.files) ? parsed.files : {};
    const hashes = {};
    for (const [relativePath, entry] of Object.entries(files)) {
      const match = /^agents\/([^/]+)\.md$/.exec(relativePath);
      if (match && isPlainObject(entry) && typeof entry.hash === 'string') {
        hashes[match[1]] = entry.hash;
      }
    }
    return hashes;
  } catch {
    // A missing or unreadable legacy manifest only removes one baseline source.
    return {};
  }
};

const changed = () => Object.assign(new Error('The agent prompt changed. Refresh before restoring it.'), {
  code: 'packaged_agent_changed', status: 409,
});
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
const syncDirectory = async (directory) => {
  let handle;
  try { handle = await fs.open(directory, 'r'); await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', ...(process.platform === 'win32' ? ['EPERM', 'EISDIR'] : [])].includes(error.code)) throw error; }
  finally { await handle?.close(); }
};
const readTargetAgent = async (filePath) => {
  let handle;
  try {
    const before = await fs.lstat(filePath);
    if (!before.isFile() || before.nlink !== 1) throw changed();
    handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!sameFile(before, stat) || !stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw changed();
    const content = await handle.readFile('utf8');
    const after = await handle.stat();
    if (!sameFile(stat, await fs.lstat(filePath)) || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs
      || stat.ctimeMs !== after.ctimeMs || after.nlink !== 1) throw changed();
    return { content, hash: hashContent(content), stat: after };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close();
  }
};

// Move the observed file into its backup before publishing without overwrite.
// A racing external writer keeps its bytes, even when it replaces the path.
const replaceTargetAgent = async ({ targetPath, agent, observed, backupDirectory, content }) => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
  let backupPath;
  try {
    if (content !== null) {
      const handle = await fs.open(temporaryPath, 'wx', 0o600);
      try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    }
    if (observed) {
      await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      backupPath = path.join(backupDirectory, `${agent.name}.${crypto.randomUUID()}.md`);
      await fs.rename(targetPath, backupPath);
      const held = await readTargetAgent(backupPath);
      if (!held || !sameFile(held.stat, observed.stat) || held.hash !== observed.hash) throw changed();
      const handle = await fs.open(backupPath, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(backupDirectory);
    }
    if (content !== null) await fs.link(temporaryPath, targetPath);
    await syncDirectory(path.dirname(targetPath));
    return backupPath;
  } catch (error) {
    if (backupPath) {
      await fs.copyFile(backupPath, targetPath, constants.COPYFILE_EXCL).catch((restoreError) => {
        if (restoreError.code !== 'EEXIST') throw restoreError;
      });
    }
    if (['EEXIST', 'ENOENT', 'ELOOP'].includes(error?.code)) throw changed();
    throw error;
  } finally {
    await fs.unlink(temporaryPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
};

const listPackagedAgentFiles = async (packagedAgentDirectory) => {
  let entries = [];
  try {
    entries = await fs.readdir(packagedAgentDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const agents = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }
    const name = entry.name.slice(0, -3);
    const filePath = path.join(packagedAgentDirectory, entry.name);
    const content = await fs.readFile(filePath, 'utf8');
    agents.push({
      name,
      fileName: entry.name,
      path: filePath,
      content,
      hash: hashContent(content),
    });
  }

  return agents.sort((a, b) => a.name.localeCompare(b.name));
};

const managedTargetExists = async (targetAgentDirectory, agentName) => {
  try {
    const stat = await fs.stat(path.join(targetAgentDirectory, `${agentName}.md`));
    return stat.isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const canUsePackagedSetHashFastPath = async ({
  manifest,
  manifestAgents,
  packagedAgents,
  currentSetHash,
  targetAgentDirectory,
}) => {
  if (manifest.packagedSetHash !== currentSetHash) {
    return false;
  }

  const packagedNames = new Set(packagedAgents.map((agent) => agent.name));
  const manifestEntries = Object.entries(manifestAgents);
  if (manifestEntries.length !== packagedAgents.length) {
    return false;
  }
  if (manifestEntries.some(([name, entry]) => !packagedNames.has(name) || !isManagedManifestEntry(entry))) {
    return false;
  }

  const targetChecks = await Promise.all(
    manifestEntries.map(([name]) => managedTargetExists(targetAgentDirectory, name)),
  );
  return targetChecks.every(Boolean);
};

const applySkillPolicyToPackagedAgent = (agent, skillPolicy) => {
  if (!skillPolicy) {
    return agent;
  }

  const { frontmatter, body } = parseAgentMarkdownContent(agent.content);
  const content = formatAgentMarkdownContent(
    sanitizeAgentSkillPolicy(frontmatter, skillPolicy),
    body,
  );

  return {
    ...agent,
    content,
    hash: hashContent(content),
  };
};

const applyAgentOverridesToPackagedAgent = (agent, options) => {
  const { frontmatter, body } = parseAgentMarkdownContent(agent.content);
  const content = formatAgentMarkdownContent(
    getEffectivePackagedAgentRuntimeFrontmatter(agent.name, frontmatter, options),
    body,
  );

  return {
    ...agent,
    content,
    hash: hashContent(content),
  };
};

// DevRyan wrote a target with one of these exact contents, so replacing it loses no
// user edit: the last synced rendering, the raw packaged source (written by the
// retired provisioner or copied by the 2.0 setup seed), a prompt shipped by an
// earlier release, or the hash the retired provisioner recorded.
const isDevRyanWrittenTarget = ({ agent, targetHash, previousManagedHash, releasedAgentHashes, profileAgentHashes }) => (
  (previousManagedHash && targetHash === previousManagedHash)
  || targetHash === agent.sourceHash
  || Boolean(releasedAgentHashes?.[agent.name]?.has?.(targetHash))
  || profileAgentHashes[agent.name] === targetHash
);

const syncPackagedAgentFile = async ({
  agent,
  manifestAgents,
  targetAgentDirectory,
  releasedAgentHashes,
  profileAgentHashes,
  restoreAgentNames,
  expectedAgentHashes,
  backupDirectory,
  dryRun,
}) => {
  const targetPath = path.join(targetAgentDirectory, agent.fileName);
  const manifestEntry = manifestAgents[agent.name];
  const previousManagedHash = getManifestHash(manifestEntry);

  const observed = await readTargetAgent(targetPath);
  const targetContent = observed?.content ?? null;
  const prompt = { name: agent.name, currentHash: observed?.hash ?? null, packagedHash: agent.hash,
    state: !observed ? 'missing' : observed.hash === agent.hash ? 'current'
      : isDevRyanWrittenTarget({ agent, targetHash: observed.hash, previousManagedHash, releasedAgentHashes, profileAgentHashes }) ? 'outdated' : 'modified' };
  if (restoreAgentNames.has(agent.name) && expectedAgentHashes
    && observed?.hash !== expectedAgentHashes[agent.name]) throw changed();

  if (targetContent === null) {
    if (!dryRun) await replaceTargetAgent({ targetPath, agent, observed, backupDirectory, content: agent.content });
    return {
      type: 'written',
      name: agent.name,
      hash: agent.hash,
      prompt,
    };
  }

  const targetHash = hashContent(targetContent);
  if (targetHash === agent.hash) {
    const existingHash = getManifestHash(manifestEntry);
    if (existingHash !== agent.hash) {
      return {
        type: 'manifest',
        name: agent.name,
        hash: agent.hash,
        prompt,
      };
    }
    return {
      type: 'unchanged',
      name: agent.name,
      prompt,
    };
  }

  if (isDevRyanWrittenTarget({ agent, targetHash, previousManagedHash, releasedAgentHashes, profileAgentHashes })) {
    if (!dryRun) await replaceTargetAgent({ targetPath, agent, observed, backupDirectory, content: agent.content });
    return {
      type: 'updated',
      name: agent.name,
      hash: agent.hash,
      prompt,
    };
  }

  // User edits are kept unless the owner explicitly chose the packaged prompt;
  // the replaced file is kept as a backup first.
  if (!dryRun && restoreAgentNames.has(agent.name)) {
    const backupPath = await replaceTargetAgent({ targetPath, agent, observed, backupDirectory, content: agent.content });
    return {
      type: 'restored',
      name: agent.name,
      hash: agent.hash,
      backupPath,
      prompt,
    };
  }

  return {
    type: 'conflict',
    prompt,
    conflict: {
      name: agent.name,
      path: targetPath,
      reason: 'user-modified',
    },
  };
};

export const formatPackagedAgentSyncConflicts = (conflicts) => {
  if (!Array.isArray(conflicts) || conflicts.length === 0) {
    return '';
  }

  const names = conflicts
    .map((conflict) => conflict?.name)
    .filter(Boolean)
    .join(', ');
  return `Packaged agent sync conflict for ${names}. DevRyan will not overwrite user-modified runtime agent files.`;
};

const synchronizePackagedAgents = async (options) => {
  const packagedAgentDirectory = options.packagedAgentDirectory ?? DEFAULT_PACKAGED_AGENT_DIR;
  const targetAgentDirectory = options.targetAgentDirectory ?? AGENT_DIR;
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const excludedAgentNames = new Set(
    Array.isArray(options.excludedAgentNames)
      ? options.excludedAgentNames.filter((name) => typeof name === 'string' && name.trim())
      : [],
  );
  const agentOverrides = options.agentOverrides && isPlainObject(options.agentOverrides)
    ? options.agentOverrides
    : listAgentModelOverrides(options);
  const effectiveOptions = { ...options, agentOverrides };
  const dryRun = options.dryRun === true;
  const restoreAgentNames = new Set(
    Array.isArray(options.restoreAgentNames)
      ? options.restoreAgentNames.filter((name) => typeof name === 'string' && name.trim())
      : [],
  );
  const releasedAgentHashes = isPlainObject(options.releasedAgentHashes)
    ? options.releasedAgentHashes
    : RELEASED_PACKAGED_AGENT_HASHES;
  const profileAgentHashes = await readProfileAgentHashes(
    options.profileManifestPath ?? path.join(path.dirname(manifestPath), PROFILE_MANIFEST_FILE_NAME),
  );
  const backupDirectory = path.join(path.dirname(manifestPath), PACKAGED_AGENT_BACKUP_DIRECTORY);

  const result = {
    changed: false,
    written: [],
    updated: [],
    removed: [],
    restored: [],
    conflicts: [],
    prompts: [],
    manifestPath,
    targetAgentDirectory,
  };

  const packagedAgents = (await listPackagedAgentFiles(packagedAgentDirectory))
    .filter((agent) => !excludedAgentNames.has(agent.name))
    .map((agent) => ({ ...agent, sourceHash: agent.hash }))
    .map((agent) => applyAgentOverridesToPackagedAgent(agent, effectiveOptions))
    .map((agent) => applySkillPolicyToPackagedAgent(agent, options.skillPolicy));
  const packagedByName = new Map(packagedAgents.map((agent) => [agent.name, agent]));
  const currentSetHash = hashPackagedAgentSet(packagedAgents);
  if (options.restoreOnly && [...restoreAgentNames].some((name) => !packagedByName.has(name))) {
    throw Object.assign(new Error('Unknown packaged agent'), { code: 'packaged_agent_unknown', status: 404 });
  }
  const manifest = await readManifestFile(manifestPath);
  const manifestAgents = isPlainObject(manifest.agents) ? manifest.agents : {};
  const nextManifestAgents = { ...manifestAgents };
  let manifestChanged = false;

  if (!dryRun && restoreAgentNames.size === 0 && await canUsePackagedSetHashFastPath({
    manifest,
    manifestAgents,
    packagedAgents,
    currentSetHash,
    targetAgentDirectory,
  })) {
    return result;
  }

  if (!dryRun) await fs.mkdir(targetAgentDirectory, { recursive: true });

  const syncOutcomes = [];
  for (const agent of packagedAgents) {
    if (options.restoreOnly && !restoreAgentNames.has(agent.name)) continue;
    syncOutcomes.push(await syncPackagedAgentFile({
    agent,
    manifestAgents,
    targetAgentDirectory,
    releasedAgentHashes,
    profileAgentHashes,
    restoreAgentNames,
    expectedAgentHashes: options.expectedAgentHashes,
    backupDirectory,
    dryRun,
    }));
  }

  for (const outcome of syncOutcomes) {
    result.prompts.push(outcome.prompt);
    if (['written', 'updated', 'manifest', 'restored'].includes(outcome.type)) {
      nextManifestAgents[outcome.name] = createManifestEntry(outcome.hash);
      result.changed = true;
      manifestChanged = true;
    }
    if (outcome.type === 'written') {
      result.written.push(outcome.name);
    }
    if (outcome.type === 'updated') {
      result.updated.push(outcome.name);
    }
    if (outcome.type === 'restored') {
      result.restored.push({ name: outcome.name, backupPath: outcome.backupPath });
    }
    if (outcome.type === 'conflict') {
      result.conflicts.push(outcome.conflict);
    }
  }

  for (const [name, entry] of Object.entries(manifestAgents)) {
    if (options.restoreOnly || !isManagedManifestEntry(entry) || packagedByName.has(name)) {
      continue;
    }

    const targetPath = path.join(targetAgentDirectory, `${name}.md`);
    const previousManagedHash = getManifestHash(entry);
    const observed = await readTargetAgent(targetPath);
    const targetContent = observed?.content ?? null;

    if (targetContent === null) {
      delete nextManifestAgents[name];
      result.changed = true;
      manifestChanged = true;
      continue;
    }

    const targetHash = hashContent(targetContent);
    if (previousManagedHash && targetHash === previousManagedHash) {
      if (!dryRun) await replaceTargetAgent({ targetPath, agent: { name }, observed, backupDirectory, content: null });
      delete nextManifestAgents[name];
      result.removed.push(name);
      result.changed = true;
      manifestChanged = true;
      continue;
    }

    result.conflicts.push({
      name,
      path: targetPath,
      reason: 'stale-user-modified',
    });
  }

  const nextPackagedSetHash = !options.restoreOnly && result.conflicts.length === 0 ? currentSetHash : null;
  if (manifest.packagedSetHash !== nextPackagedSetHash) {
    manifestChanged = true;
  }

  if (manifestChanged && !dryRun) {
    await writeFileAtomic(manifestPath, `${JSON.stringify({
      version: 1,
      packagedSetHash: nextPackagedSetHash,
      agents: sortObjectByKey(nextManifestAgents),
    }, null, 2)}\n`);
  }

  result.written.sort((a, b) => a.localeCompare(b));
  result.updated.sort((a, b) => a.localeCompare(b));
  result.removed.sort((a, b) => a.localeCompare(b));
  result.restored.sort((a, b) => a.name.localeCompare(b.name));
  result.conflicts.sort((a, b) => a.name.localeCompare(b.name));

  return result;
};

export const syncPackagedAgents = async (options = {}) => options.dryRun === true
  ? synchronizePackagedAgents(options)
  : withCrossProcessFileLock(`${options.manifestPath ?? DEFAULT_MANIFEST_PATH}.lock`, () => synchronizePackagedAgents(options));

export {
  DEFAULT_MANIFEST_PATH,
  DEFAULT_PACKAGED_AGENT_DIR,
};
