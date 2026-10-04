import fs from 'node:fs/promises';
import { Credential } from '@opencode/core/credential';
import { Database } from '@opencode/core/database/database';
import { KV } from '@opencode/core/kv';
import { Global } from '@opencode/util/global';
import { LayerNode } from '@opencode/util/effect/layer-node';
import { Cause, Effect, Exit, Logger } from 'effect';
import type { NativeBundleCredentialBoot } from './native-bundle-credential-contract.js';
import { runNativeBundleCredentialAction } from './native-bundle-credentials.js';

const fail = () => Object.assign(new Error('bundle_credential_checkpoint_expired'), { code: 'bundle_credential_checkpoint_expired', status: 503 });

/** Private child of the held checkpoint owner; no server, model or session graph.
 * The parent validates its unforgeable in-process lease before and after this
 * child. Losing that parent invalidates work instead of admitting a new owner. */
export async function runNativeBundleCredentialMode(boot: NativeBundleCredentialBoot) {
  const parentPID = process.ppid;
  if (parentPID <= 1) throw fail();
  const environment = { HOME: boot.globals.home, XDG_CONFIG_HOME: boot.globals.config, XDG_DATA_HOME: boot.globals.data,
    XDG_STATE_HOME: boot.globals.state, XDG_CACHE_HOME: boot.globals.cache, TMPDIR: boot.globals.tmp };
  const database = await fs.lstat(boot.databasePath);
  if (!database.isFile() || database.isSymbolicLink()) throw fail();
  const assertHeld = async () => {
    if (process.ppid !== parentPID) throw fail();
    try { process.kill(parentPID, 0); } catch { throw fail(); }
    for (const [name, directory] of Object.entries(environment)) {
      if (process.env[name] !== directory || await fs.realpath(directory) !== directory) throw fail();
    }
    for (const directory of [...Object.values(boot.globals), boot.webDataDirectory]) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw fail();
    }
    const current = await fs.lstat(boot.databasePath);
    if (!current.isFile() || current.isSymbolicLink() || current.ino !== database.ino || current.dev !== database.dev
      || await fs.realpath(boot.databasePath) !== boot.databasePath) throw fail();
  };
  await assertHeld();
  const layer = LayerNode.compile(LayerNode.group([Credential.node, KV.node, Database.node]), { replacements: [
    Global.node.replace(Global.layerWith(boot.globals)),
    Database.node.replace(Database.configured({ path: boot.databasePath })),
  ] });
  const result = await Effect.runPromiseExit(Effect.scoped(runNativeBundleCredentialAction({ action: boot.action,
    webDataDirectory: boot.webDataDirectory, assertHeld }).pipe(Effect.provide(layer), Effect.provide(Logger.layer([], { mergeWithExisting: false })))));
  if (Exit.isFailure(result)) throw Cause.squash(result.cause);
  await assertHeld();
  return result.value;
}
