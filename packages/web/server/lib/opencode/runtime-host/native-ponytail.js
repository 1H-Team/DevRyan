import fs from 'node:fs/promises';
import path from 'node:path';
import { constants, lstatSync, realpathSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const MODES = ['off', 'lite', 'full', 'ultra', 'review'];
const normalize = value => typeof value === 'string' && MODES.includes(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null;
const fail = code => Object.assign(new Error(code), { code, status: 403 });

/** State is the copied OpenCode state file; instruction bytes come from the reviewed package builder. */
export function createNativePonytailOwner({ configDirectory, directories, defaultMode, instructions, assertCommand }) {
  if (!path.isAbsolute(configDirectory) || !['off', 'lite', 'full', 'ultra'].includes(defaultMode)
    || typeof assertCommand !== 'function' || MODES.filter(mode => mode !== 'off').some(mode => typeof instructions[mode] !== 'string')) throw fail('native_ponytail_configuration_invalid');
  const statePath = path.join(configDirectory, '.ponytail-active');
  const assertDirectory = async () => { if (await fs.realpath(configDirectory) !== path.resolve(configDirectory)) throw fail('native_ponytail_directory_changed'); };
  const assertState = async () => {
    let file;
    try { file = await fs.open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try { if (!(await file.stat()).isFile()) throw fail('native_ponytail_state_invalid'); } finally { await file.close(); }
  };
  const scoped = directory => { if (!directories.includes(directory)) throw fail('native_ponytail_location_unreviewed'); };
  async function readMode(directory) {
    scoped(directory);
    await assertDirectory();
    let file;
    try { file = await fs.open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return defaultMode; throw error; }
    try { if (!(await file.stat()).isFile() || (await file.stat()).size > 128) throw fail('native_ponytail_state_invalid'); return normalize(await file.readFile('utf8')) ?? defaultMode; }
    finally { await file.close(); }
  }
  return {
    statePath,
    readMode,
    async contextInstructions(directory) { const mode = await readMode(directory); return mode === 'off' ? '' : instructions[mode]; },
    async applyCommand(input) {
      scoped(input.directory);
      if (input.command !== 'ponytail') return { kind: 'ignored' };
      const args = typeof input.arguments === 'string' ? input.arguments.trim() : '';
      // Informational aliases and unrelated text never alter persistent state.
      if (args === 'status' || args === 'help') return { kind: args, mode: await readMode(input.directory) };
      const deactivation = args.toLowerCase().replace(/[.!?\s]+$/, '');
      const mode = ['stop ponytail', 'normal mode'].includes(deactivation) ? 'off' : args ? normalize(args) : defaultMode;
      if (!mode) return { kind: 'ignored' };
      await assertCommand(input);
      await assertDirectory(); await assertState();
      const temporary = path.join(configDirectory, `.ponytail-active.tmp-${randomUUID()}`);
      let file;
      try {
        file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await file.writeFile(mode, 'utf8'); await file.sync(); await file.close(); file = undefined;
        await assertDirectory(); await assertState();
        // Recheck after staging all bytes. Readers see the previous complete
        // mode until this authorized same-directory rename commits the new one.
        await assertCommand(input);
        // These bounded checks do not suspend after the fresh grant. Rename
        // itself never follows the destination symlink.
        if (realpathSync(configDirectory) !== path.resolve(configDirectory)) throw fail('native_ponytail_directory_changed');
        try {
          const state=lstatSync(statePath);
          if(state.isSymbolicLink()) throw Object.assign(new Error('native_ponytail_state_symlink'), {code:'ELOOP'});
          if(!state.isFile()) throw fail('native_ponytail_state_invalid');
        } catch(error) { if(error.code!=='ENOENT') throw error; }
        renameSync(temporary, statePath);
        const directory = await fs.open(configDirectory, constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
        return { kind: 'changed', mode };
      } finally {
        await file?.close();
        await fs.rm(temporary, { force: true });
      }
    },
  };
}
