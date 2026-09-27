import crypto from 'node:crypto';
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

import {
  BOT_DATABASE_NAME,
  assertBotDatabaseName,
  classifyBotDatabaseHistory,
} from '@openchamber/bot-db';

// Backups of the recoverable local Bot unit: the database, every live
// encrypted object, the Bot credential/environment/Telegram vaults, signing
// state, speech credentials, computer-resource manifests and purge journals.
// Authentication sessions and tunnel grants are never included.
//
// Standard authenticated encryption only: AES-256-GCM over each stream with a
// per-backup HKDF key derived from a domain-separated backup root key, and an
// HMAC-SHA256 over the canonical manifest. A backup is usable only after it
// was restored into an inaccessible candidate and verified. Restore content is
// authenticated completely before pg_restore ever reads it.

export const BOT_CATALOG_BACKUP_VERSION = 1;
export const BOT_CATALOG_BACKUP_KINDS = Object.freeze([
  'daily', 'manual', 'pre_migration', 'pre_import', 'pre_restore', 'pre_start_empty',
]);
const PRE_CHANGE_KINDS = new Set(['manual', 'pre_migration', 'pre_import', 'pre_restore', 'pre_start_empty']);
const DAILY_RETENTION_COUNT = 7;
const PRE_CHANGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PARTIAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const BACKUP_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin$/;
const MAX_HOST_FILE_BYTES = 16 * 1024 * 1024;
const MAX_HOST_STATE_BYTES = 64 * 1024 * 1024;
const MAX_HOST_STATE_FILES = 10_000;
const REPLACEMENT_JOURNAL_VERSION = 1;

// Host state restored with the catalog, relative to the data directory.
export const BOT_CATALOG_HOST_STATE = Object.freeze([
  Object.freeze({ path: 'bots/vault/credentials.v1.json', kind: 'file' }),
  Object.freeze({ path: 'bots/vault/environment-secrets.v1.json', kind: 'file' }),
  Object.freeze({ path: 'bots/signing', kind: 'directory' }),
  Object.freeze({ path: 'bots/speech-credentials', kind: 'directory' }),
  Object.freeze({ path: 'bots/computer-resources', kind: 'directory' }),
  Object.freeze({ path: 'bots/purge', kind: 'directory' }),
  Object.freeze({ path: 'bot-integrations/telegram/bots/vault/credentials.v1.json', kind: 'file' }),
]);

export class BotCatalogBackupError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'BotCatalogBackupError';
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (message, code, details) => {
  throw new BotCatalogBackupError(message, code, details);
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const deriveKey = (rootKey, salt, purpose) => Buffer.from(crypto.hkdfSync(
  'sha256',
  rootKey,
  salt,
  Buffer.from(`devryan-bot-catalog-backup/v${BOT_CATALOG_BACKUP_VERSION}/${purpose}`, 'utf8'),
  32,
));

const backupAad = (backupId, purpose) => Buffer.from(`devryan-bot-catalog-backup:${backupId}:${purpose}`, 'utf8');

const privateDirectory = async (directory) => {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('A Bot backup directory is not a real directory', 'bot_backup_storage_invalid');
  }
  await fs.chmod(directory, 0o700);
};

const syncDirectory = async (directory) => {
  let handle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    await handle.sync();
  } catch {
    // Some filesystems do not permit directory fsync.
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const writePrivateFile = async (file, bytes) => {
  const handle = await fs.open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const readBoundedFile = async (file, maximumBytes) => {
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximumBytes) {
      fail('A Bot backup file exceeds its bound', 'bot_backup_file_invalid');
    }
    return { bytes: await handle.readFile(), mode: stat.mode & 0o777 };
  } finally {
    await handle.close();
  }
};

const hashFile = async (file) => {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  await pipeline(createReadStream(file, { flags: fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) }), new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback();
    },
  }));
  return { sha256: hash.digest('hex'), bytes };
};

const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

// Every table the catalog owns, fingerprinted row-by-row in a stable order.
const FINGERPRINT_SQL = `
select format(
  'select %L || ''|'' || encode(extensions.digest(coalesce(string_agg(h, '''' order by h), ''''), ''sha256''), ''hex'') from (select encode(extensions.digest(to_jsonb(x)::text, ''sha256''), ''hex'') as h from %I.%I x) s',
  schemaname || '.' || tablename, schemaname, tablename)
from pg_catalog.pg_tables
where schemaname in ('public', 'devryan_local', 'auth', 'storage')
order by schemaname, tablename
\\gexec
`;

const parseFingerprints = (stdout) => {
  const fingerprints = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-z_]+\.[a-z0-9_]+)\|([0-9a-f]{64})$/.exec(line.trim());
    if (!match) fail('Bot catalog fingerprint output is invalid', 'bot_backup_verification_failed');
    fingerprints[match[1]] = match[2];
  }
  if (Object.keys(fingerprints).length < 10) {
    fail('Bot catalog fingerprint output is incomplete', 'bot_backup_verification_failed');
  }
  return fingerprints;
};

export function createBotCatalogBackups({
  dataDirectory,
  loadBackupKey,
  databaseManager,
  streamProcess,
  composeArgs,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  recordEvent = () => {},
} = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)
    || typeof loadBackupKey !== 'function' || typeof databaseManager?.exec !== 'function'
    || typeof streamProcess !== 'function' || typeof composeArgs !== 'function') {
    fail('Bot catalog backups are misconfigured', 'bot_backup_configuration_invalid');
  }
  const backupsDirectory = path.join(dataDirectory, 'bots', 'backups');
  const stagingDirectory = path.join(dataDirectory, 'bots', 'restore');
  const objectsDirectory = path.join(dataDirectory, 'bots', 'objects');
  const journalPath = path.join(dataDirectory, 'bots', 'runtime', 'replacement.v1.json');

  const withRootKey = async (operation) => {
    const key = Buffer.from(await loadBackupKey());
    if (key.byteLength !== 32) {
      key.fill(0);
      fail('The Bot backup key is unavailable', 'bot_backup_key_unavailable');
    }
    try {
      return await operation(key);
    } finally {
      key.fill(0);
    }
  };

  const macFor = (rootKey, manifest) => {
    const key = deriveKey(rootKey, Buffer.from(manifest.salt, 'base64'), 'manifest');
    try {
      return crypto.createHmac('sha256', key).update(JSON.stringify(canonicalize(manifest))).digest('hex');
    } finally {
      key.fill(0);
    }
  };

  const newBackupId = () => {
    const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    return `${stamp}-${Buffer.from(randomBytes(4)).toString('hex')}`;
  };

  const dockerStream = (context, action, { input = null, output = null } = {}) => streamProcess(
    context.dockerPath,
    composeArgs(action),
    context.environment,
    { input, output, deadlineAt: context.deadlineAt },
  );

  const sql = (context, database, statement, failureCode = 'bot_backup_database_failed') => (
    databaseManager.exec(context, database, statement, { failureCode })
  );

  const fingerprint = async (context, database) => parseFingerprints(
    await sql(context, database, FINGERPRINT_SQL, 'bot_backup_verification_failed'),
  );

  const historyOf = async (context, database) => JSON.parse(String(await sql(context, database, `
    select coalesce(json_agg(json_build_object('ordinal', ordinal, 'name', name, 'sha256', sha256) order by ordinal), '[]'::json)
    from devryan_local.schema_migrations;
  `)).trim());

  const liveObjects = async (context, database) => {
    const rows = JSON.parse(String(await sql(context, database, `
      select coalesce(json_agg(json_build_object(
        'id', id::text, 'name', storage_object_name, 'bytes', ciphertext_size::text, 'sha256', ciphertext_hash
      ) order by id), '[]'::json)
      from public.bot_objects where deleted_at is null;
    `)).trim());
    return rows.map((row) => {
      const file = typeof row?.name === 'string' ? /^objects\/(.+\.bin)$/.exec(row.name)?.[1]?.toLowerCase() : null;
      if (!UUID_PATTERN.test(row?.id || '') || !file || !OBJECT_FILE_PATTERN.test(file)
        || !/^\d{1,12}$/.test(row.bytes) || !/^[0-9a-f]{64}$/.test(row.sha256 || '')) {
        fail('A Bot object row is invalid', 'bot_backup_object_invalid');
      }
      return { id: row.id, file, bytes: Number(row.bytes), sha256: row.sha256 };
    });
  };

  const copyVerifiedObject = async (source, destination, expected) => {
    await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    await fs.chmod(destination, 0o600);
    const actual = await hashFile(destination);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      fail('A Bot object does not match its catalog record', 'bot_backup_object_mismatch');
    }
  };

  const collectHostState = async () => {
    const files = [];
    let total = 0;
    const add = async (relativePath) => {
      const absolute = path.join(dataDirectory, relativePath);
      const { bytes, mode } = await readBoundedFile(absolute, MAX_HOST_FILE_BYTES);
      total += bytes.byteLength;
      if (total > MAX_HOST_STATE_BYTES || files.length >= MAX_HOST_STATE_FILES) {
        fail('Bot host state exceeds the backup bound', 'bot_backup_host_state_too_large');
      }
      files.push({ path: relativePath, mode, data: bytes.toString('base64') });
    };
    for (const entry of BOT_CATALOG_HOST_STATE) {
      const absolute = path.join(dataDirectory, entry.path);
      let stat;
      try {
        stat = await fs.lstat(absolute);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (stat.isSymbolicLink()) fail('Bot host state must not be a symlink', 'bot_backup_host_state_invalid');
      if (entry.kind === 'file') {
        if (!stat.isFile()) fail('Bot host state entry is invalid', 'bot_backup_host_state_invalid');
        await add(entry.path);
        continue;
      }
      if (!stat.isDirectory()) fail('Bot host state entry is invalid', 'bot_backup_host_state_invalid');
      const walk = async (relativeDirectory) => {
        const entries = await fs.readdir(path.join(dataDirectory, relativeDirectory), { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const child of entries) {
          const relativeChild = path.posix.join(relativeDirectory, child.name);
          if (child.isSymbolicLink()) fail('Bot host state must not contain symlinks', 'bot_backup_host_state_invalid');
          if (child.isDirectory()) await walk(relativeChild);
          else if (child.isFile() && !/\.tmp$/.test(child.name)) await add(relativeChild);
        }
      };
      await walk(entry.path);
    }
    return files;
  };

  const encryptBuffer = (rootKey, salt, backupId, purpose, plaintext) => {
    const key = deriveKey(rootKey, salt, purpose);
    try {
      const iv = randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(backupAad(backupId, purpose));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { ciphertext, iv: Buffer.from(iv).toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    } finally {
      key.fill(0);
    }
  };

  const decryptBuffer = (rootKey, manifest, purpose, ciphertext, metadata) => {
    const key = deriveKey(rootKey, Buffer.from(manifest.salt, 'base64'), purpose);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(metadata.iv, 'base64'));
      decipher.setAAD(backupAad(manifest.id, purpose));
      decipher.setAuthTag(Buffer.from(metadata.tag, 'base64'));
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      fail('A Bot backup failed authentication', 'bot_backup_authentication_failed');
    } finally {
      key.fill(0);
    }
  };

  // Streams pg_dump through AES-256-GCM into the backup directory.
  const dumpDatabase = async (context, rootKey, salt, backupId, file) => {
    const key = deriveKey(rootKey, salt, 'database');
    const iv = randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(backupAad(backupId, 'database'));
    key.fill(0);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
    });
    const output = createWriteStream(file, { flags: 'wx', mode: 0o600 });
    const done = pipeline(cipher, counter, output);
    const result = await dockerStream(context, [
      'exec', '-T', '--user', 'postgres', 'database',
      'pg_dump', '--format=custom', '--compress=6', '--dbname', BOT_DATABASE_NAME,
    ], { output: cipher });
    await done;
    if (result.exitCode !== 0) fail('The Bot database dump failed', 'bot_backup_dump_failed');
    return { bytes, sha256: hash.digest('hex'), iv: Buffer.from(iv).toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  };

  // Authenticates the whole dump before any byte reaches pg_restore.
  const decryptDatabaseToFile = async (rootKey, manifest, backupDirectory, destination) => {
    const source = path.join(backupDirectory, manifest.database.file);
    const actual = await hashFile(source);
    if (actual.sha256 !== manifest.database.sha256 || actual.bytes !== manifest.database.bytes) {
      fail('The Bot backup database file does not match its manifest', 'bot_backup_authentication_failed');
    }
    const key = deriveKey(rootKey, Buffer.from(manifest.salt, 'base64'), 'database');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(manifest.database.iv, 'base64'));
    key.fill(0);
    decipher.setAAD(backupAad(manifest.id, 'database'));
    decipher.setAuthTag(Buffer.from(manifest.database.tag, 'base64'));
    try {
      await pipeline(
        createReadStream(source, { flags: fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) }),
        decipher,
        createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
      );
    } catch {
      await fs.rm(destination, { force: true });
      fail('A Bot backup failed authentication', 'bot_backup_authentication_failed');
    }
  };

  const createCandidateDatabase = async (context, name) => {
    assertBotDatabaseName(name);
    await sql(context, 'postgres', `create database ${quoteIdentifier(name)} template template0;`);
    await sql(context, 'postgres', `revoke all on database ${quoteIdentifier(name)} from public;`);
  };

  const dropDatabase = async (context, name) => {
    assertBotDatabaseName(name);
    if (name === BOT_DATABASE_NAME) fail('The live Bot database cannot be dropped', 'bot_backup_database_failed');
    await sql(context, 'postgres', `
      select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity
      where datname = '${name}' and pid <> pg_catalog.pg_backend_pid();
    `);
    await sql(context, 'postgres', `drop database if exists ${quoteIdentifier(name)};`);
  };

  const restoreDumpInto = async (context, database, plaintextFile) => {
    const result = await dockerStream(context, [
      'exec', '-T', '--user', 'postgres', 'database',
      'pg_restore', '--exit-on-error', '--single-transaction', '--dbname', database,
    ], { input: createReadStream(plaintextFile, { flags: fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) }) });
    if (result.exitCode !== 0) fail('The Bot backup could not be restored', 'bot_backup_restore_failed');
  };

  const readManifest = async (rootKey, backupDirectory) => {
    const { bytes } = await readBoundedFile(path.join(backupDirectory, 'manifest.json'), 8 * 1024 * 1024);
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('The Bot backup manifest is invalid', 'bot_backup_manifest_invalid');
    }
    const manifest = parsed?.manifest;
    if (!manifest || manifest.version !== BOT_CATALOG_BACKUP_VERSION || typeof parsed.mac !== 'string'
      || !BACKUP_ID_PATTERN.test(manifest.id || '') || typeof manifest.salt !== 'string') {
      fail('The Bot backup manifest is invalid', 'bot_backup_manifest_invalid');
    }
    const expected = Buffer.from(macFor(rootKey, manifest), 'hex');
    const actual = Buffer.from(parsed.mac, 'hex');
    if (expected.byteLength !== actual.byteLength || !crypto.timingSafeEqual(expected, actual)) {
      fail('The Bot backup manifest failed authentication', 'bot_backup_authentication_failed');
    }
    return manifest;
  };

  const writeManifest = async (rootKey, backupDirectory, manifest) => {
    const document = { manifest, mac: macFor(rootKey, manifest) };
    const target = path.join(backupDirectory, 'manifest.json');
    const temporary = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await writePrivateFile(temporary, `${JSON.stringify(document)}\n`);
    await fs.rename(temporary, target);
    await syncDirectory(backupDirectory);
  };

  const candidateName = (kind) => `devryan_bots_${kind}_${Buffer.from(randomBytes(8)).toString('hex')}`;

  // Restores a backup into an inaccessible scratch database and compares every
  // table fingerprint and every object hash with the manifest.
  const verifyInto = async (context, rootKey, manifest, backupDirectory, { keepCandidate = false } = {}) => {
    const scratch = path.join(stagingDirectory, `verify-${manifest.id}-${Buffer.from(randomBytes(4)).toString('hex')}`);
    await privateDirectory(stagingDirectory);
    await privateDirectory(scratch);
    const database = candidateName('candidate');
    let created = false;
    try {
      const plaintext = path.join(scratch, 'database.dump');
      await decryptDatabaseToFile(rootKey, manifest, backupDirectory, plaintext);
      await createCandidateDatabase(context, database);
      created = true;
      await restoreDumpInto(context, database, plaintext);
      await fs.rm(plaintext, { force: true });
      const fingerprints = await fingerprint(context, database);
      if (JSON.stringify(canonicalize(fingerprints)) !== JSON.stringify(canonicalize(manifest.fingerprints))) {
        fail('The restored Bot catalog does not match its backup', 'bot_backup_verification_failed');
      }
      const history = classifyBotDatabaseHistory(await historyOf(context, database));
      if (!['current', 'behind'].includes(history.state)) {
        fail('The Bot backup has an unsupported schema history', 'bot_backup_schema_unsupported');
      }
      for (const object of manifest.objects.entries) {
        const actual = await hashFile(path.join(backupDirectory, 'objects', object.file));
        if (actual.bytes !== object.bytes || actual.sha256 !== object.sha256) {
          fail('A Bot backup object does not match its manifest', 'bot_backup_verification_failed');
        }
      }
      const hostState = await readHostState(rootKey, manifest, backupDirectory);
      return { database, scratch, history, hostState };
    } catch (error) {
      if (created) await dropDatabase(context, database).catch(() => undefined);
      await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      if (!keepCandidate && created) await dropDatabase(context, database).catch(() => undefined);
      if (!keepCandidate) await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const readHostState = async (rootKey, manifest, backupDirectory) => {
    const { bytes } = await readBoundedFile(path.join(backupDirectory, manifest.hostState.file), MAX_HOST_STATE_BYTES * 2);
    if (sha256Hex(bytes) !== manifest.hostState.sha256) {
      fail('The Bot backup host state does not match its manifest', 'bot_backup_authentication_failed');
    }
    const plaintext = decryptBuffer(rootKey, manifest, 'host-state', bytes, manifest.hostState);
    const parsed = JSON.parse(plaintext.toString('utf8'));
    plaintext.fill(0);
    if (parsed?.version !== 1 || !Array.isArray(parsed.files)) {
      fail('The Bot backup host state is invalid', 'bot_backup_host_state_invalid');
    }
    const allowed = BOT_CATALOG_HOST_STATE;
    for (const file of parsed.files) {
      const normalized = typeof file?.path === 'string' ? path.posix.normalize(file.path) : '';
      if (normalized !== file.path || normalized.startsWith('../') || path.posix.isAbsolute(normalized)
        || !allowed.some((entry) => (entry.kind === 'file' ? normalized === entry.path : normalized.startsWith(`${entry.path}/`)))
        || typeof file.data !== 'string' || !Number.isInteger(file.mode)) {
        fail('The Bot backup host state is invalid', 'bot_backup_host_state_invalid');
      }
    }
    return parsed;
  };

  const listBackupDirectories = async () => {
    await privateDirectory(backupsDirectory);
    const entries = await fs.readdir(backupsDirectory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && BACKUP_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name).sort();
  };

  const summary = (manifest) => Object.freeze({
    id: manifest.id,
    kind: manifest.kind,
    createdAt: manifest.createdAt,
    verifiedAt: manifest.verifiedAt,
    schemaHead: manifest.schema.head,
    objectCount: manifest.objects.count,
    bytes: manifest.database.bytes + manifest.objects.bytes + manifest.hostState.bytes,
  });

  const listBackups = () => withRootKey(async (rootKey) => {
    const backups = [];
    for (const id of await listBackupDirectories()) {
      try {
        const manifest = await readManifest(rootKey, path.join(backupsDirectory, id));
        if (manifest.verifiedAt && manifest.id === id) backups.push(summary(manifest));
      } catch {
        // Unreadable backups are ignored for restore, never deleted by listing.
      }
    }
    return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  });

  // Creates and verifies one backup. The caller holds the maintenance fence
  // (or, before migration, REST is stopped), so the dump, object inventory and
  // host files describe one consistent state.
  const createBackup = (context, { kind }) => withRootKey(async (rootKey) => {
    if (!BOT_CATALOG_BACKUP_KINDS.includes(kind)) fail('The Bot backup kind is invalid', 'bot_backup_request_invalid');
    await privateDirectory(backupsDirectory);
    const id = newBackupId();
    const partial = path.join(backupsDirectory, `.${id}.partial`);
    await privateDirectory(partial);
    await privateDirectory(path.join(partial, 'objects'));
    const salt = Buffer.from(randomBytes(32));
    try {
      const [history, objects, fingerprints] = [
        await historyOf(context, BOT_DATABASE_NAME),
        await liveObjects(context, BOT_DATABASE_NAME),
        await fingerprint(context, BOT_DATABASE_NAME),
      ];
      const classification = classifyBotDatabaseHistory(history);
      if (!['current', 'behind'].includes(classification.state)) {
        fail('The Bot catalog history cannot be backed up by this release', 'bot_backup_schema_unsupported');
      }
      const database = await dumpDatabase(context, rootKey, salt, id, path.join(partial, 'database.dump.enc'));
      const missing = [];
      let objectBytes = 0;
      for (const object of objects) {
        const source = path.join(objectsDirectory, object.file);
        try {
          await copyVerifiedObject(source, path.join(partial, 'objects', object.file), object);
          objectBytes += object.bytes;
        } catch (error) {
          if (error?.code === 'ENOENT') missing.push(object.id);
          else throw error;
        }
      }
      if (missing.length > 0) {
        fail(`${missing.length} live Bot objects are missing from local storage`, 'bot_backup_object_missing', {
          missingObjectCount: missing.length,
        });
      }
      const hostFiles = await collectHostState();
      const hostPlaintext = Buffer.from(JSON.stringify({ version: 1, files: hostFiles }), 'utf8');
      const host = encryptBuffer(rootKey, salt, id, 'host-state', hostPlaintext);
      hostPlaintext.fill(0);
      await writePrivateFile(path.join(partial, 'host-state.enc'), host.ciphertext);
      const manifest = {
        version: BOT_CATALOG_BACKUP_VERSION,
        id,
        kind,
        createdAt: new Date(now()).toISOString(),
        verifiedAt: null,
        deploymentId: context.environment.DEVRYAN_BOT_DEPLOYMENT_ID,
        salt: salt.toString('base64'),
        schema: { head: history.at(-1)?.name || '', history },
        database: { file: 'database.dump.enc', ...database },
        hostState: {
          file: 'host-state.enc',
          bytes: host.ciphertext.byteLength,
          sha256: sha256Hex(host.ciphertext),
          iv: host.iv,
          tag: host.tag,
          files: hostFiles.map((file) => file.path),
        },
        objects: {
          count: objects.length,
          bytes: objectBytes,
          entries: objects.map(({ id: objectId, file, bytes, sha256 }) => ({ id: objectId, file, bytes, sha256 })),
        },
        fingerprints,
      };
      await writeManifest(rootKey, partial, manifest);
      await verifyInto(context, rootKey, manifest, partial);
      const verified = { ...manifest, verifiedAt: new Date(now()).toISOString() };
      await writeManifest(rootKey, partial, verified);
      await fs.rename(partial, path.join(backupsDirectory, id));
      await syncDirectory(backupsDirectory);
      recordEvent({ event: 'bot.catalog.backup_verified', kind, objectCount: objects.length });
      return summary(verified);
    } catch (error) {
      await fs.rm(partial, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      salt.fill(0);
    }
  });

  // Keeps seven verified daily backups and every pre-change backup for 30
  // days; never deletes the newest verified backup of any kind.
  const pruneBackups = () => withRootKey(async (rootKey) => {
    const entries = [];
    for (const id of await listBackupDirectories()) {
      try {
        const manifest = await readManifest(rootKey, path.join(backupsDirectory, id));
        if (manifest.verifiedAt) entries.push(manifest);
      } catch {
        // Unverifiable directories are left for the owner to inspect.
      }
    }
    entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const keep = new Set(entries.slice(0, 1).map((manifest) => manifest.id));
    for (const manifest of entries.filter((entry) => entry.kind === 'daily').slice(0, DAILY_RETENTION_COUNT)) {
      keep.add(manifest.id);
    }
    const cutoff = now() - PRE_CHANGE_RETENTION_MS;
    for (const manifest of entries) {
      if (PRE_CHANGE_KINDS.has(manifest.kind) && Date.parse(manifest.createdAt) >= cutoff) keep.add(manifest.id);
    }
    const removed = [];
    for (const manifest of entries) {
      if (keep.has(manifest.id)) continue;
      await fs.rm(path.join(backupsDirectory, manifest.id), { recursive: true, force: true });
      removed.push(manifest.id);
    }
    for (const entry of await fs.readdir(backupsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\.\d{8}T\d{6}Z-[0-9a-f]{8}\.partial$/.test(entry.name)) continue;
      const stat = await fs.stat(path.join(backupsDirectory, entry.name));
      if (now() - stat.mtimeMs > PARTIAL_RETENTION_MS) {
        await fs.rm(path.join(backupsDirectory, entry.name), { recursive: true, force: true });
      }
    }
    return Object.freeze({ kept: keep.size, removed });
  });

  // Prepares an inaccessible restore candidate: the database restored and
  // verified, objects copied and verified, host state decrypted into staging.
  const prepareRestore = (context, backupId) => withRootKey(async (rootKey) => {
    if (!BACKUP_ID_PATTERN.test(backupId || '')) fail('The Bot backup identifier is invalid', 'bot_backup_request_invalid');
    const backupDirectory = path.join(backupsDirectory, backupId);
    const manifest = await readManifest(rootKey, backupDirectory);
    if (manifest.id !== backupId || !manifest.verifiedAt) {
      fail('Only verified Bot backups can be restored', 'bot_backup_unverified');
    }
    if (manifest.deploymentId !== context.environment.DEVRYAN_BOT_DEPLOYMENT_ID) {
      fail('The Bot backup belongs to another deployment key', 'bot_backup_foreign');
    }
    const verified = await verifyInto(context, rootKey, manifest, backupDirectory, { keepCandidate: true });
    try {
      const objects = path.join(verified.scratch, 'objects');
      await privateDirectory(objects);
      for (const object of manifest.objects.entries) {
        await copyVerifiedObject(path.join(backupDirectory, 'objects', object.file), path.join(objects, object.file), object);
      }
      const host = path.join(verified.scratch, 'host-state');
      await privateDirectory(host);
      for (const file of verified.hostState.files) {
        const destination = path.join(host, file.path);
        await privateDirectory(path.dirname(destination));
        const bytes = Buffer.from(file.data, 'base64');
        await writePrivateFile(destination, bytes);
        bytes.fill(0);
      }
      return Object.freeze({
        operationId: crypto.randomUUID(),
        backupId,
        database: verified.database,
        scratch: verified.scratch,
        objectsDirectory: objects,
        hostStateDirectory: host,
        hostStatePaths: Object.freeze(verified.hostState.files.map((file) => file.path)),
        history: verified.history,
        manifest: Object.freeze({ id: manifest.id, kind: manifest.kind, createdAt: manifest.createdAt }),
      });
    } catch (error) {
      await dropDatabase(context, verified.database).catch(() => undefined);
      await fs.rm(verified.scratch, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });

  const discardCandidate = async (context, candidate) => {
    if (candidate?.database) await dropDatabase(context, candidate.database).catch(() => undefined);
    if (candidate?.scratch && candidate.scratch.startsWith(`${stagingDirectory}${path.sep}`)) {
      await fs.rm(candidate.scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const readJournal = async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(journalPath, 'utf8'));
      if (parsed?.version !== REPLACEMENT_JOURNAL_VERSION) fail('The Bot replacement journal is invalid', 'bot_database_state_ambiguous');
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof BotCatalogBackupError) throw error;
      fail('The Bot replacement journal is unreadable', 'bot_database_state_ambiguous');
    }
  };

  const writeJournal = async (journal) => {
    await privateDirectory(path.dirname(journalPath));
    const temporary = `${journalPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await writePrivateFile(temporary, `${JSON.stringify({ version: REPLACEMENT_JOURNAL_VERSION, ...journal })}\n`);
    await fs.rename(temporary, journalPath);
    await syncDirectory(path.dirname(journalPath));
  };

  const databaseNames = async (context) => new Set(JSON.parse(String(await sql(context, 'postgres', `
    select coalesce(json_agg(datname), '[]'::json) from pg_catalog.pg_database where datname like 'devryan\\_bots%';
  `)).trim()));

  const renameDatabase = (context, from, to) => {
    assertBotDatabaseName(from);
    assertBotDatabaseName(to);
    return sql(context, 'postgres', `alter database ${quoteIdentifier(from)} rename to ${quoteIdentifier(to)};`);
  };

  const exists = async (target) => {
    try {
      await fs.lstat(target);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  };

  const hostStateTargets = (candidate) => BOT_CATALOG_HOST_STATE.map((entry) => ({
    live: path.join(dataDirectory, entry.path),
    staged: path.join(candidate.hostStateDirectory, entry.path),
    retired: `${path.join(dataDirectory, entry.path)}.retired-${candidate.operationId}`,
  }));

  // Swaps the live database, objects and host state for the verified
  // candidate. Every phase is journaled so an interrupted replacement rolls
  // back on the next start; the old unit stays recoverable until the caller's
  // post-verification commits it.
  const replaceWithCandidate = async (context, candidate, { stopRest, startRest }) => {
    const retiredDatabase = `devryan_bots_retired_${candidate.operationId.replaceAll('-', '').slice(0, 24)}`;
    const journal = {
      operationId: candidate.operationId,
      phase: 'swapping',
      candidateDatabase: candidate.database,
      retiredDatabase,
      objects: {
        live: objectsDirectory,
        staged: candidate.objectsDirectory,
        retired: `${objectsDirectory}.retired-${candidate.operationId}`,
      },
      hostState: hostStateTargets(candidate),
      scratch: candidate.scratch,
    };
    await writeJournal(journal);
    await stopRest();
    await sql(context, 'postgres', `
      select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity
      where datname in ('${BOT_DATABASE_NAME}', '${candidate.database}') and pid <> pg_catalog.pg_backend_pid();
    `);
    await renameDatabase(context, BOT_DATABASE_NAME, retiredDatabase);
    await renameDatabase(context, candidate.database, BOT_DATABASE_NAME);
    await sql(context, 'postgres', `
      revoke all on database ${quoteIdentifier(retiredDatabase)} from public, authenticator;
      grant connect on database ${BOT_DATABASE_NAME} to authenticator;
    `);
    if (await exists(journal.objects.live)) await fs.rename(journal.objects.live, journal.objects.retired);
    await fs.rename(journal.objects.staged, journal.objects.live);
    for (const target of journal.hostState) {
      if (await exists(target.live)) await fs.rename(target.live, target.retired);
      if (await exists(target.staged)) {
        await privateDirectory(path.dirname(target.live));
        await fs.rename(target.staged, target.live);
      }
    }
    await writeJournal({ ...journal, phase: 'swapped' });
    await startRest();
    return Object.freeze({ operationId: candidate.operationId, retiredDatabase });
  };

  // Rolls an uncommitted replacement back to the retained unit.
  const rollbackReplacement = async (context, { stopRest, startRest } = {}) => {
    const journal = await readJournal();
    if (!journal || journal.phase === 'committed') return false;
    await stopRest?.();
    const names = await databaseNames(context);
    if (names.has(journal.retiredDatabase)) {
      if (names.has(BOT_DATABASE_NAME)) {
        await sql(context, 'postgres', `
          select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity
          where datname = '${BOT_DATABASE_NAME}' and pid <> pg_catalog.pg_backend_pid();
        `);
        await renameDatabase(context, BOT_DATABASE_NAME, journal.candidateDatabase);
      }
      await renameDatabase(context, journal.retiredDatabase, BOT_DATABASE_NAME);
      await sql(context, 'postgres', `grant connect on database ${BOT_DATABASE_NAME} to authenticator;`);
    }
    if (await exists(journal.objects.retired)) {
      if (await exists(journal.objects.live)) {
        if (!(await exists(journal.objects.staged))) await fs.rename(journal.objects.live, journal.objects.staged);
        else await fs.rm(journal.objects.live, { recursive: true, force: true });
      }
      await fs.rename(journal.objects.retired, journal.objects.live);
    }
    for (const target of journal.hostState) {
      if (await exists(target.retired)) {
        if (await exists(target.live)) await fs.rm(target.live, { recursive: true, force: true });
        await fs.rename(target.retired, target.live);
      }
    }
    if ((await databaseNames(context)).has(journal.candidateDatabase)) {
      await dropDatabase(context, journal.candidateDatabase).catch(() => undefined);
    }
    if (journal.scratch?.startsWith(`${stagingDirectory}${path.sep}`)) {
      await fs.rm(journal.scratch, { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.rm(journalPath, { force: true });
    await startRest?.();
    recordEvent({ event: 'bot.catalog.replacement_rolled_back' });
    return true;
  };

  // Retires the old unit once post-verification succeeded.
  const commitReplacement = async (context) => {
    const journal = await readJournal();
    if (!journal) return;
    await writeJournal({ ...journal, phase: 'committed' });
    await dropDatabase(context, journal.retiredDatabase).catch(() => undefined);
    await fs.rm(journal.objects.retired, { recursive: true, force: true }).catch(() => undefined);
    for (const target of journal.hostState) {
      await fs.rm(target.retired, { recursive: true, force: true }).catch(() => undefined);
    }
    if (journal.scratch?.startsWith(`${stagingDirectory}${path.sep}`)) {
      await fs.rm(journal.scratch, { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.rm(journalPath, { force: true });
    recordEvent({ event: 'bot.catalog.replacement_committed' });
  };

  // Called before the catalog starts: an interrupted replacement is rolled
  // back (or its committed cleanup finished) before REST can be exposed.
  const recoverInterruptedReplacement = async (context, handlers = {}) => {
    const journal = await readJournal();
    if (!journal) return 'none';
    if (journal.phase === 'committed') {
      await commitReplacement(context);
      return 'committed';
    }
    await rollbackReplacement(context, handlers);
    return 'rolled_back';
  };

  return Object.freeze({
    backupsDirectory,
    listBackups,
    createBackup,
    pruneBackups,
    prepareRestore,
    discardCandidate,
    replaceWithCandidate,
    rollbackReplacement,
    commitReplacement,
    recoverInterruptedReplacement,
    fingerprintLive: (context) => fingerprint(context, BOT_DATABASE_NAME),
    fingerprintDatabase: (context, database) => fingerprint(context, assertBotDatabaseName(database)),
    createCandidateDatabase,
    dropDatabase,
    databaseNames,
    readJournal,
  });
}
