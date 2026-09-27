import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  BOT_DATABASE_NAME,
  BOT_DB_SCHEMA_HEAD,
  assertBotDatabaseName,
  classifyBotDatabaseHistory,
  renderMigrationTransaction,
} from '@openchamber/bot-db';

// Host lifecycle for the local Bot catalog: volume ownership, one-off cluster
// initialization, identity checks, reviewed migrations and loopback REST
// tokens. Every mutation runs inside the runtime manager's lifecycle queue.

export const BOT_DATABASE_STATE_VERSION = 1;
export const BOT_DATABASE_SERVICE = 'database';
export const BOT_DATABASE_REST_SERVICE = 'database-rest';
export const BOT_DATABASE_REST_PORT = '3000';
export const BOT_DATABASE_TOKEN_AUDIENCE = 'devryan-bots-local';
export const BOT_DATABASE_TOKEN_TTL_SECONDS = 300;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYSTEM_IDENTIFIER_PATTERN = /^[0-9]{1,20}$/;
const DEPLOYMENT_ID_PATTERN = /^deployment-[0-9a-f]{24}$/;
const VOLUME_ROLE = 'database-data';
const HEALTH_POLL_INTERVAL_MS = 500;
const DATABASE_HEALTH_TIMEOUT_MS = 90_000;
const PSQL_OUTPUT_LIMIT = 16 * 1024 * 1024;

// A catalog that needs owner action rather than an automatic repair. Each code
// maps to one recovery path in the UI (restore, start empty or update).
export const BOT_DATABASE_RECOVERY_CODES = Object.freeze([
  'bot_database_volume_missing',
  'bot_database_volume_foreign',
  'bot_database_identity_changed',
  'bot_database_cluster_missing',
  'bot_database_state_ambiguous',
  'bot_database_schema_newer',
  'bot_database_schema_unknown',
]);

export class BotDatabaseManagerError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'BotDatabaseManagerError';
    this.code = code;
    this.recoveryRequired = BOT_DATABASE_RECOVERY_CODES.includes(code);
    Object.assign(this, details);
  }
}

const fail = (message, code, details) => {
  throw new BotDatabaseManagerError(message, code, details);
};

const atomicWriteJson = async (filePath, value, fsPromises) => {
  const directory = path.dirname(filePath);
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsPromises.chmod(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fsPromises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(temporaryPath, filePath);
    await fsPromises.chmod(filePath, 0o600);
    let directoryHandle;
    try {
      directoryHandle = await fsPromises.open(directory, 'r');
      await directoryHandle.sync();
    } catch {
      // Some filesystems do not permit directory fsync.
    } finally {
      await directoryHandle?.close().catch(() => undefined);
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fsPromises.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

const validateExpectation = (raw) => {
  if (raw === null) return null;
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
  if (!exact(raw, ['version', 'deploymentId', 'volume', 'cluster', 'schema', 'updatedAt'])
    || raw.version !== BOT_DATABASE_STATE_VERSION
    || !DEPLOYMENT_ID_PATTERN.test(raw.deploymentId)
    || !exact(raw.volume, ['name', 'nonce'])
    || typeof raw.volume.name !== 'string' || !/^[a-z][a-z0-9-]{0,80}-bot-database-data$/.test(raw.volume.name)
    || !UUID_PATTERN.test(raw.volume.nonce)
    || !exact(raw.cluster, ['systemIdentifier', 'databaseId'])
    || !SYSTEM_IDENTIFIER_PATTERN.test(raw.cluster.systemIdentifier)
    || !UUID_PATTERN.test(raw.cluster.databaseId)
    || !exact(raw.schema, ['head', 'appliedCount'])
    || typeof raw.schema.head !== 'string' || !Number.isSafeInteger(raw.schema.appliedCount)
    || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))) {
    fail('Bot database host state is invalid', 'bot_database_state_ambiguous');
  }
  return raw;
};

// The initialized-cluster expectation. It is written before REST is exposed
// and never removed automatically: a missing volume or a changed cluster with
// this record present requires the owner to choose a recovery.
export const createFileBotDatabaseStateStore = ({ dataDirectory, fsPromises = fs } = {}) => {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) {
    fail('Bot database state requires an absolute data directory', 'bot_database_state_ambiguous');
  }
  const statePath = path.join(dataDirectory, 'bots', 'runtime', 'database.v1.json');
  return {
    async read() {
      let contents;
      try {
        contents = await fsPromises.readFile(statePath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        fail('Bot database host state cannot be read', 'bot_database_state_ambiguous');
      }
      try {
        return validateExpectation(JSON.parse(contents));
      } catch (error) {
        if (error instanceof BotDatabaseManagerError) throw error;
        fail('Bot database host state is invalid', 'bot_database_state_ambiguous');
      }
    },
    async write(value) {
      await atomicWriteJson(statePath, validateExpectation(value), fsPromises);
    },
    path: statePath,
  };
};

const base64url = (value) => Buffer.from(value).toString('base64url');

// Short-lived PostgREST service tokens. The secret never leaves the Electron
// process; the in-process web server receives only a token and loopback URL.
export function mintBotDatabaseToken(secret, {
  now = Date.now,
  ttlSeconds = BOT_DATABASE_TOKEN_TTL_SECONDS,
} = {}) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)
    || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 900) {
    fail('Bot database token input is invalid', 'bot_database_token_invalid');
  }
  const issuedAt = Math.floor(now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    role: 'service_role',
    aud: BOT_DATABASE_TOKEN_AUDIENCE,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    jti: crypto.randomUUID(),
  }));
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return Object.freeze({
    token: `${header}.${payload}.${signature}`,
    expiresAt: new Date((issuedAt + ttlSeconds) * 1000).toISOString(),
  });
}

const parseJsonOutput = (stdout, code) => {
  try {
    return JSON.parse(String(stdout || '').trim());
  } catch {
    fail('Bot database returned an invalid inspection result', code);
  }
};

const parseLoopbackEndpoint = (stdout) => {
  const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(String(stdout || '').trim());
  const port = match ? Number(match[1]) : 0;
  if (!port || port > 65535) {
    fail('Bot database REST is not published on loopback', 'bot_database_rest_unavailable');
  }
  return `http://127.0.0.1:${port}`;
};

export function createBotDatabaseManager({
  run,
  composeArgs,
  resourceNamespace,
  stateStore,
  loadSql,
  now = Date.now,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  randomUUID = () => crypto.randomUUID(),
  recordEvent = () => {},
} = {}) {
  if (typeof run !== 'function' || typeof composeArgs !== 'function' || typeof loadSql !== 'function'
    || typeof stateStore?.read !== 'function' || typeof stateStore?.write !== 'function'
    || typeof resourceNamespace !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(resourceNamespace)) {
    fail('Bot database manager dependencies are invalid', 'bot_database_configuration_invalid');
  }
  const volumeName = `${resourceNamespace}-bot-database-data`;
  let generation = 0;
  let restEndpoint = null;
  let ready = false;

  const exec = async (context, database, sql, { failureCode = 'bot_database_command_failed' } = {}) => {
    if (database !== 'postgres') assertBotDatabaseName(database);
    const result = await run(context.dockerPath, composeArgs([
      'exec', '-T', '--user', 'postgres', BOT_DATABASE_SERVICE,
      'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-d', database,
    ]), context.environment, context.deadlineAt, { input: sql, maxBuffer: PSQL_OUTPUT_LIMIT });
    if (result.exitCode !== 0) {
      fail('A Bot database command failed', failureCode);
    }
    return result.stdout;
  };

  const inspectVolume = async (context) => {
    const result = await run(context.dockerPath, [
      'volume', 'inspect', volumeName, '--format', '{{json .}}',
    ], context.baseEnvironment, context.deadlineAt);
    if (result.exitCode !== 0) {
      if (/no such volume/i.test(result.stderr || '')) return null;
      fail('Unable to inspect the Bot database volume', 'bot_database_volume_unavailable');
    }
    const volume = parseJsonOutput(result.stdout, 'bot_database_volume_unavailable');
    const labels = volume?.Labels && typeof volume.Labels === 'object' ? volume.Labels : {};
    return Object.freeze({
      name: volume?.Name,
      runtime: labels['devryan.runtime'] || null,
      role: labels['devryan.volume-role'] || null,
      deployment: labels['devryan.deployment'] || null,
      nonce: UUID_PATTERN.test(labels['devryan.volume-nonce'] || '') ? labels['devryan.volume-nonce'] : null,
    });
  };

  const requireOwnedVolume = (volume, deploymentId) => {
    if (volume.name !== volumeName || volume.runtime !== 'production-bots' || volume.role !== VOLUME_ROLE
      || volume.deployment !== deploymentId || !volume.nonce) {
      fail(
        'The Bot database volume belongs to another installation or was not created by DevRyan',
        'bot_database_volume_foreign',
      );
    }
  };

  const createVolume = async (context, deploymentId) => {
    const nonce = randomUUID();
    const result = await run(context.dockerPath, [
      'volume', 'create',
      '--label', 'devryan.runtime=production-bots',
      '--label', 'devryan.owner=electron',
      '--label', `devryan.deployment=${deploymentId}`,
      '--label', `devryan.volume-role=${VOLUME_ROLE}`,
      '--label', `devryan.volume-nonce=${nonce}`,
      volumeName,
    ], context.baseEnvironment, context.deadlineAt);
    if (result.exitCode !== 0) fail('Unable to create the Bot database volume', context.failureCode);
    const created = await inspectVolume(context);
    if (!created) fail('Docker did not create the Bot database volume', context.failureCode);
    requireOwnedVolume(created, deploymentId);
    if (created.nonce !== nonce) {
      fail('The Bot database volume was created concurrently by another process', 'bot_database_state_ambiguous');
    }
    return created;
  };

  const initializeCluster = async (context) => {
    context.publishProgress?.({ phase: 'initializing_database' });
    const result = await run(context.dockerPath, composeArgs([
      'run', '--rm', '--no-deps', '-T',
      '--env', 'DEVRYAN_BOT_DATABASE_INITIALIZE=allow',
      BOT_DATABASE_SERVICE, '--initialize-only',
    ]), context.environment, context.deadlineAt);
    if (result.exitCode !== 0) fail('Unable to initialize the Bot database', context.failureCode);
  };

  const inspectDatabaseContainer = async (context) => {
    const result = await run(context.dockerPath, composeArgs([
      'ps', '--all', '--format', 'json', BOT_DATABASE_SERVICE,
    ]), context.environment, context.deadlineAt);
    if (result.exitCode !== 0) return null;
    const text = String(result.stdout || '').trim();
    if (!text) return null;
    let row;
    try {
      const parsed = JSON.parse(text.split(/\r?\n/)[0]);
      row = Array.isArray(parsed) ? parsed[0] : parsed;
    } catch {
      return null;
    }
    return {
      state: String(row?.State || '').toLowerCase(),
      health: String(row?.Health || '').toLowerCase(),
      exitCode: Number.isInteger(row?.ExitCode) ? row.ExitCode : null,
    };
  };

  const startDatabase = async (context) => {
    context.publishProgress?.({ phase: 'starting_database' });
    const started = await run(context.dockerPath, composeArgs([
      'up', '--detach', '--no-deps', BOT_DATABASE_SERVICE,
    ]), context.environment, context.deadlineAt);
    if (started.exitCode !== 0) fail('Unable to start the Bot database', context.failureCode);
    const healthDeadline = Math.min(context.deadlineAt ?? Number.POSITIVE_INFINITY, now() + DATABASE_HEALTH_TIMEOUT_MS);
    while (true) {
      const container = await inspectDatabaseContainer(context);
      if (container?.state === 'running' && container.health === 'healthy') return;
      if (container && ['exited', 'dead'].includes(container.state)) {
        // 67: the volume holds no cluster although the host expected one.
        if (container.exitCode === 67) {
          await run(context.dockerPath, composeArgs(['stop', BOT_DATABASE_SERVICE]), context.environment, context.deadlineAt);
          fail('The Bot database volume holds no database cluster', 'bot_database_cluster_missing');
        }
        fail('The Bot database stopped during startup', context.failureCode);
      }
      if (now() >= healthDeadline) fail('The Bot database did not become healthy', context.failureCode);
      await wait(HEALTH_POLL_INTERVAL_MS);
    }
  };

  const inspectCluster = async (context) => {
    const output = await exec(context, 'postgres', `
      select json_build_object(
        'systemIdentifier', (pg_catalog.pg_control_system()).system_identifier::text,
        'databaseExists', exists (select from pg_catalog.pg_database where datname = '${BOT_DATABASE_NAME}')
      );
    `, { failureCode: 'bot_database_inspection_failed' });
    const cluster = parseJsonOutput(output, 'bot_database_inspection_failed');
    if (!SYSTEM_IDENTIFIER_PATTERN.test(cluster?.systemIdentifier || '') || typeof cluster.databaseExists !== 'boolean') {
      fail('Bot database cluster inspection is invalid', 'bot_database_inspection_failed');
    }
    return cluster;
  };

  const inspectDatabase = async (context, database = BOT_DATABASE_NAME) => {
    const output = await exec(context, database, `
      select json_build_object(
        'bootstrapped', to_regclass('devryan_local.installation') is not null,
        'databaseId', case when to_regclass('devryan_local.installation') is null then null
          else (select database_id::text from devryan_local.installation) end,
        'history', case when to_regclass('devryan_local.schema_migrations') is null then '[]'::json
          else coalesce((select json_agg(json_build_object('ordinal', ordinal, 'name', name, 'sha256', sha256) order by ordinal)
            from devryan_local.schema_migrations), '[]'::json) end
      );
    `, { failureCode: 'bot_database_inspection_failed' });
    const inspected = parseJsonOutput(output, 'bot_database_inspection_failed');
    if (typeof inspected?.bootstrapped !== 'boolean' || !Array.isArray(inspected.history)) {
      fail('Bot database inspection is invalid', 'bot_database_inspection_failed');
    }
    return inspected;
  };

  const bootstrap = async (context, database) => {
    const sql = await loadSql();
    await exec(context, 'postgres', sql.bootstrapCluster, { failureCode: context.failureCode });
    await exec(context, 'postgres', `create database ${assertBotDatabaseName(database)} template template0;`, {
      failureCode: context.failureCode,
    });
    await exec(context, 'postgres', database === BOT_DATABASE_NAME
      ? `revoke all on database ${database} from public; grant connect on database ${database} to authenticator;`
      : `revoke all on database ${database} from public;`, { failureCode: context.failureCode });
    await exec(context, database, sql.bootstrapDatabase, { failureCode: context.failureCode });
    const databaseId = randomUUID();
    await exec(context, database, `insert into devryan_local.installation (database_id, inventory_format) values ('${databaseId}', 1);`, {
      failureCode: context.failureCode,
    });
    return databaseId;
  };

  const migrate = async (context, database, pending) => {
    if (pending.length === 0) return;
    const sql = await loadSql();
    const byName = new Map(sql.migrations.map((migration) => [migration.name, migration]));
    for (const [index, migration] of pending.entries()) {
      context.publishProgress?.({ phase: 'migrating_database', completed: index, total: pending.length });
      const reviewed = byName.get(migration.name);
      if (!reviewed || reviewed.sha256 !== migration.sha256 || reviewed.ordinal !== migration.ordinal) {
        fail('Bot database migration inventory changed while migrating', 'bot_database_inventory_drift');
      }
      await exec(context, database, renderMigrationTransaction(reviewed), { failureCode: 'bot_database_migration_failed' });
    }
    context.publishProgress?.({ phase: 'migrating_database', completed: pending.length, total: pending.length });
  };

  const writeExpectation = async (deploymentId, volume, cluster, databaseId, appliedCount, head) => {
    await stateStore.write({
      version: BOT_DATABASE_STATE_VERSION,
      deploymentId,
      volume: { name: volume.name, nonce: volume.nonce },
      cluster: { systemIdentifier: cluster.systemIdentifier, databaseId },
      schema: { head, appliedCount },
      updatedAt: new Date(now()).toISOString(),
    });
  };

  // Verifies ownership and identity, then brings the catalog schema to the
  // release head. REST is not started here: callers expose it only after this
  // resolves. `allowInitialize` permits a brand-new cluster only when no
  // expectation exists and the volume is absent; `allowAdopt` (explicit Repair)
  // permits recording an owned, reviewed database whose host record was lost.
  const prepare = async (context, {
    allowInitialize = false,
    allowAdopt = false,
    beforeMigrate = null,
    // Finishes or rolls back a journaled replacement interrupted by a crash;
    // returns true when one existed.
    beforeStart = null,
    afterReplacementRecovery = null,
  } = {}) => {
    const deploymentId = context.environment?.DEVRYAN_BOT_DEPLOYMENT_ID;
    if (!DEPLOYMENT_ID_PATTERN.test(deploymentId || '')) {
      fail('Bot database deployment identity is invalid', 'bot_database_configuration_invalid');
    }
    ready = false;
    context.publishProgress?.({ phase: 'checking_database' });
    let expectation = await stateStore.read();
    if (expectation && expectation.deploymentId !== deploymentId) {
      fail('The Bot database belongs to another deployment key', 'bot_database_identity_changed');
    }
    let volume = await inspectVolume(context);
    let initialized = false;
    let bootstrapped = false;
    if (!volume) {
      if (expectation) fail('The Bot database volume is missing', 'bot_database_volume_missing');
      if (!allowInitialize) fail('The local Bot catalog has not been set up', 'bot_database_setup_required');
      volume = await createVolume(context, deploymentId);
      await initializeCluster(context);
      initialized = true;
    } else {
      requireOwnedVolume(volume, deploymentId);
      if (expectation && expectation.volume.nonce !== volume.nonce) {
        fail('The Bot database volume was replaced', 'bot_database_identity_changed');
      }
      if (!expectation && !allowAdopt && !allowInitialize) {
        fail('An existing Bot database has no matching host record', 'bot_database_state_ambiguous');
      }
    }

    try {
      await startDatabase(context);
    } catch (error) {
      // A first setup interrupted between creating the owned volume and
      // initializing it leaves an empty volume; only that case may continue.
      if (error?.code !== 'bot_database_cluster_missing' || expectation || !allowInitialize || initialized) throw error;
      await initializeCluster(context);
      initialized = true;
      await startDatabase(context);
    }
    if (expectation && typeof beforeStart === 'function' && await beforeStart()) {
      await afterReplacementRecovery?.();
      expectation = await stateStore.read();
    }
    const cluster = await inspectCluster(context);
    if (expectation && expectation.cluster.systemIdentifier !== cluster.systemIdentifier) {
      fail('The Bot database cluster changed', 'bot_database_identity_changed');
    }

    let databaseId;
    if (!cluster.databaseExists) {
      if (expectation) fail('The Bot database is missing from its cluster', 'bot_database_identity_changed');
      if (!allowInitialize) fail('An existing Bot database has no matching host record', 'bot_database_state_ambiguous');
      // An owned cluster without the Bot database holds no Bot data.
      databaseId = await bootstrap(context, BOT_DATABASE_NAME);
      bootstrapped = true;
      // Persist the expectation before any migration or REST exposure.
      await writeExpectation(deploymentId, volume, cluster, databaseId, 0, '');
    }

    const inspected = await inspectDatabase(context);
    if (!inspected.bootstrapped || !UUID_PATTERN.test(inspected.databaseId || '')) {
      fail('The Bot database has no DevRyan installation record', expectation ? 'bot_database_identity_changed' : 'bot_database_state_ambiguous');
    }
    databaseId = inspected.databaseId;
    if (expectation && expectation.cluster.databaseId !== databaseId) {
      fail('The Bot database was replaced outside DevRyan', 'bot_database_identity_changed');
    }
    // A bootstrapped catalog without a host record is adopted only by an
    // explicit owner Repair, never by setup or automatic startup.
    if (!expectation && !bootstrapped && !allowAdopt) {
      fail('An existing Bot database has no matching host record', 'bot_database_state_ambiguous');
    }
    const history = classifyBotDatabaseHistory(inspected.history);
    if (history.state === 'newer') {
      fail('The Bot database was upgraded by a newer DevRyan release', 'bot_database_schema_newer');
    }
    if (history.state === 'unknown') {
      fail('The Bot database has an unrecognized migration history', 'bot_database_schema_unknown');
    }
    if (!expectation) {
      await writeExpectation(deploymentId, volume, cluster, databaseId, history.appliedCount,
        history.appliedCount > 0 ? inspected.history.at(-1).name : '');
    }
    if (history.state === 'behind' && history.appliedCount > 0) {
      // An existing catalog is backed up and verified before its schema changes.
      if (typeof beforeMigrate !== 'function') {
        fail('A verified backup is required before the Bot database can be migrated', 'bot_database_backup_unavailable');
      }
      await beforeMigrate({ from: inspected.history.at(-1).name, pending: history.pending.length });
    }
    await migrate(context, BOT_DATABASE_NAME, history.state === 'current' ? [] : history.pending);
    await writeExpectation(deploymentId, volume, cluster, databaseId, history.appliedCount + (history.state === 'current' ? 0 : history.pending.length), BOT_DB_SCHEMA_HEAD);
    await exec(context, BOT_DATABASE_NAME, "notify pgrst, 'reload schema';");
    recordEvent({ event: 'bot.database.prepared', initialized, migrated: history.state === 'current' ? 0 : history.pending.length });
    return Object.freeze({
      state: 'ready',
      initialized,
      migrated: history.state === 'current' ? 0 : history.pending.length,
      schemaHead: BOT_DB_SCHEMA_HEAD,
      systemIdentifier: cluster.systemIdentifier,
      databaseId,
    });
  };

  // Read-only status: never starts, creates, initializes or migrates.
  const inspect = async (context) => {
    let expectation;
    try {
      expectation = await stateStore.read();
    } catch (error) {
      return Object.freeze({ state: 'recovery_required', code: error?.code || 'bot_database_state_ambiguous' });
    }
    const deploymentId = context.environment?.DEVRYAN_BOT_DEPLOYMENT_ID;
    if (expectation && expectation.deploymentId !== deploymentId) {
      return Object.freeze({ state: 'recovery_required', code: 'bot_database_identity_changed' });
    }
    const volume = await inspectVolume(context);
    if (!volume) {
      return Object.freeze(expectation
        ? { state: 'recovery_required', code: 'bot_database_volume_missing' }
        : { state: 'setup_required', code: 'bot_database_setup_required' });
    }
    try {
      requireOwnedVolume(volume, deploymentId);
    } catch (error) {
      return Object.freeze({ state: 'recovery_required', code: error.code });
    }
    if (!expectation) return Object.freeze({ state: 'recovery_required', code: 'bot_database_state_ambiguous' });
    if (expectation.volume.nonce !== volume.nonce) {
      return Object.freeze({ state: 'recovery_required', code: 'bot_database_identity_changed' });
    }
    const container = await inspectDatabaseContainer(context);
    if (!container || container.state !== 'running' || container.health !== 'healthy') {
      if (container?.exitCode === 67) return Object.freeze({ state: 'recovery_required', code: 'bot_database_cluster_missing' });
      return Object.freeze({ state: 'stopped', code: 'bot_database_unavailable' });
    }
    try {
      const cluster = await inspectCluster(context);
      if (cluster.systemIdentifier !== expectation.cluster.systemIdentifier || !cluster.databaseExists) {
        return Object.freeze({ state: 'recovery_required', code: 'bot_database_identity_changed' });
      }
      const inspected = await inspectDatabase(context);
      if (inspected.databaseId !== expectation.cluster.databaseId) {
        return Object.freeze({ state: 'recovery_required', code: 'bot_database_identity_changed' });
      }
      const history = classifyBotDatabaseHistory(inspected.history);
      if (history.state === 'newer') return Object.freeze({ state: 'recovery_required', code: 'bot_database_schema_newer' });
      if (history.state === 'unknown') return Object.freeze({ state: 'recovery_required', code: 'bot_database_schema_unknown' });
      if (history.state !== 'current') return Object.freeze({ state: 'migration_required', code: 'bot_database_migration_required' });
      return Object.freeze({ state: 'ready', code: null });
    } catch (error) {
      return Object.freeze({ state: 'unavailable', code: error?.code || 'bot_database_inspection_failed' });
    }
  };

  const resolveRestEndpoint = async (context) => {
    const result = await run(context.dockerPath, composeArgs([
      'port', BOT_DATABASE_REST_SERVICE, BOT_DATABASE_REST_PORT,
    ]), context.environment, context.deadlineAt);
    if (result.exitCode !== 0) fail('Bot database REST is unavailable', 'bot_database_rest_unavailable');
    return parseLoopbackEndpoint(result.stdout);
  };

  // Owner-confirmed Start Empty. Existing data is retired, never deleted: an
  // owned cluster keeps its old database under a retired name, and a missing
  // volume is recreated. A foreign volume is never touched.
  const startEmpty = async (context, { retiredSuffix }) => {
    if (!/^[0-9a-f]{16,32}$/.test(retiredSuffix || '')) {
      fail('Start Empty requires an operation identifier', 'bot_database_configuration_invalid');
    }
    const deploymentId = context.environment?.DEVRYAN_BOT_DEPLOYMENT_ID;
    if (!DEPLOYMENT_ID_PATTERN.test(deploymentId || '')) {
      fail('Bot database deployment identity is invalid', 'bot_database_configuration_invalid');
    }
    ready = false;
    generation += 1;
    let volume = await inspectVolume(context);
    if (!volume) {
      volume = await createVolume(context, deploymentId);
      await initializeCluster(context);
    } else {
      requireOwnedVolume(volume, deploymentId);
    }
    try {
      await startDatabase(context);
    } catch (error) {
      if (error?.code !== 'bot_database_cluster_missing') throw error;
      await initializeCluster(context);
      await startDatabase(context);
    }
    const cluster = await inspectCluster(context);
    let retiredDatabase = null;
    if (cluster.databaseExists) {
      retiredDatabase = assertBotDatabaseName(`devryan_bots_retired_${retiredSuffix}`);
      await exec(context, 'postgres', `
        select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity
        where datname = '${BOT_DATABASE_NAME}' and pid <> pg_catalog.pg_backend_pid();
      `);
      await exec(context, 'postgres', `alter database ${BOT_DATABASE_NAME} rename to ${retiredDatabase};`);
      await exec(context, 'postgres', `revoke all on database ${retiredDatabase} from public, authenticator;`);
    }
    const databaseId = await bootstrap(context, BOT_DATABASE_NAME);
    await writeExpectation(deploymentId, volume, cluster, databaseId, 0, '');
    const loaded = await loadSql();
    await migrate(context, BOT_DATABASE_NAME, loaded.migrations);
    await writeExpectation(deploymentId, volume, cluster, databaseId, loaded.migrations.length, BOT_DB_SCHEMA_HEAD);
    await exec(context, BOT_DATABASE_NAME, "notify pgrst, 'reload schema';");
    recordEvent({ event: 'bot.database.started_empty', retained: retiredDatabase !== null });
    return Object.freeze({ databaseId, retiredDatabase });
  };

  // A journaled replacement (restore, start empty, import) swapped the live
  // database inside the same owned cluster; the expectation follows it.
  const adoptLiveDatabaseId = async (databaseId) => {
    if (!UUID_PATTERN.test(databaseId || '')) {
      fail('The replaced Bot database has no installation record', 'bot_database_identity_changed');
    }
    const expectation = await stateStore.read();
    if (!expectation) fail('The Bot database host state is missing', 'bot_database_state_ambiguous');
    await stateStore.write({
      ...expectation,
      cluster: { ...expectation.cluster, databaseId },
      updatedAt: new Date(now()).toISOString(),
    });
  };

  return Object.freeze({
    volumeName,
    prepare,
    adoptLiveDatabaseId,
    startEmpty,
    migrateDatabase: (context, database, pending) => migrate(context, assertBotDatabaseName(database), pending),
    bootstrapDatabase: (context, database) => bootstrap(context, assertBotDatabaseName(database)),
    inspect,
    exec,
    inspectVolume,
    // Called by the lifecycle after REST is (re)started or the database is
    // replaced; any cached endpoint or token generation becomes stale.
    markReady(endpoint) {
      restEndpoint = endpoint;
      ready = true;
      generation += 1;
      return generation;
    },
    markUnavailable() {
      ready = false;
      restEndpoint = null;
      generation += 1;
    },
    resolveRestEndpoint,
    async context(context) {
      if (!ready || !restEndpoint) fail('The local Bot catalog is not ready', 'bot_database_unavailable');
      const secret = context.environment?.DEVRYAN_BOT_DATABASE_JWT_SECRET;
      const minted = mintBotDatabaseToken(secret, { now });
      return Object.freeze({ url: restEndpoint, token: minted.token, expiresAt: minted.expiresAt, generation });
    },
    get ready() { return ready; },
    get generation() { return generation; },
  });
}
