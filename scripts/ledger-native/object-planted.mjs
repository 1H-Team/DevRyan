#!/usr/bin/env node
// Planted bugs in the native ledger's content object store
// (ledger-native/src/objects.rs, durability.rs, and the copy of
// ledger-io/src/fs.rs that views use): each is one small change to the Rust
// in a copy of the workspace, run against what the verify runs for them:
// the store's library tests (`cargo test -p ledger-native --lib objects::`)
// and object-differential.mjs, against the mutated probe. The unchanged copy
// must pass first. Each bug is reported with what caught it; `named` is the
// test the bug is planted for, which must be among those that fail. Outside
// the gate: it rebuilds the probe once per bug, one build or one run at a
// time.
//
//   node scripts/ledger-native/object-planted.mjs [--only='<name>;<name>'] [--dry]
//
// Exit status 0 when every bug was caught by its named test, 1 otherwise; a
// JSON summary is the last line. `--dry` only checks that every plant's text
// occurs once in the worktree.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { LEDGER_PROBE_VARIABLE, workspaceCopy } from '../build-ledger-native.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const DIFFERENTIAL = 'scripts/ledger-native/object-differential.mjs';
const O = 'ledger-native/src/objects.rs';
const D = 'ledger-native/src/durability.rs';
const L = 'ledger-io/src/fs.rs';

const SYNC_AND_CLOSE = `            let synced = handle.sync().await;
            crate::seams::content_outcome("sync", &temporary, synced)?;
            let closed = handle.close().await;
            crate::seams::content_outcome("close", &temporary, closed)?;
            *output.borrow_mut() = None;
`;

/**
 * `{ name, edits: [{ file, find, replace }], named }`: `named`
 * matches the failing test that must catch it.
 */
export const BUGS = Object.freeze([
  // --- the install path ---
  { name: 'C01 the content sync skipped', edits: [{ file: O, find: '            let synced = handle.sync().await;\n', replace: '            let synced: Result<(), W> = Ok(());\n' }], named: /durability|system calls/ },
  { name: 'C02 the temporary closed before its sync', edits: [{ file: O, find: SYNC_AND_CLOSE, replace: `            let closed = handle.close().await;
            crate::seams::content_outcome("close", &temporary, closed)?;
            let synced = handle.sync().await;
            crate::seams::content_outcome("sync", &temporary, synced)?;
            *output.borrow_mut() = None;
` }], named: /durability|system calls|inputs/ },
  { name: 'C03 the link before the sync', edits: [{ file: O, find: SYNC_AND_CLOSE, replace: '' }, { file: O, find: '            // The ledger commit that references this object syncs the\n', replace: `${SYNC_AND_CLOSE}            // The ledger commit that references this object syncs the\n` }], named: /durability|system calls/ },
  { name: 'C04 EEXIST at the link treated as a failure', edits: [{ file: O, find: '                        if code_of(&cause) != "EEXIST" {', replace: '                        if !code_of(&cause).is_empty() {' }], named: /concurrent installs|inputs/ },
  { name: 'C05 the temporary left behind (the finally without its unlink)', edits: [{ file: O, find: '        remove_temporary_file(&temporary).await?;\n        Ok(Resolution::Value(body?))', replace: '        Ok(Resolution::Value(body?))' }], named: /inputs|durability|observation/ },
  { name: 'C06 the identity recorded before the temporary is unlinked', edits: [{ file: O, find: '            if installed {\n                remove_temporary_file(&temporary).await?;\n                record_installed_object(&objects, &digest).await?;', replace: '            if installed {\n                record_installed_object(&objects, &digest).await?;' }], named: /inputs|system calls/ },
  { name: 'C07 the temporary made 0o644', edits: [{ file: O, find: 'nfs::open(&temporary, Flags::Str("wx"), Some(0o600))', replace: 'nfs::open(&temporary, Flags::Str("wx"), Some(0o644))' }], named: /inputs/ },
  { name: 'C08 the objects directory made 0o755', edits: [{ file: O, find: '                mode: 0o700,', replace: '                mode: 0o755,' }], named: /inputs|system calls/ },
  { name: 'C09 the installed object not recorded in verified-objects.v1', edits: [{ file: O, find: '                record_installed_object(&objects, &digest).await?;\n', replace: '' }], named: /inputs/ },
  { name: 'C10 an install leaves the directory not pending', edits: [{ file: O, find: '            mark_object_directory_pending(&objects);\n', replace: '' }], named: /durability|system calls/ },
  { name: 'C11 a reused object never marks the directory', edits: [{ file: O, find: '                mark_object_if_unsynced(&objects, existing.ctime_ms());\n', replace: '' }], named: /durability|system calls/ },
  { name: 'C12 a close failing in the finally swallowed (the temporary then removed)', edits: [{ file: O, find: '                let closed = handle.close().await;\n                crate::seams::content_outcome("close", &temporary, closed)?;\n            }\n            None => js::value::<W, W>(W::Undefined).await.map(|_| ())?,\n        }\n        remove_temporary_file(&temporary).await?;\n        Ok(Resolution::Value(body?))', replace: '                let closed = handle.close().await;\n                let _ = crate::seams::content_outcome("close", &temporary, closed);\n            }\n            None => js::value::<W, W>(W::Undefined).await.map(|_| ())?,\n        }\n        remove_temporary_file(&temporary).await?;\n        Ok(Resolution::Value(body?))' }], named: /durability/ },
  // --- the observation's checks ---
  { name: 'C13 the stamp check after the open skipped', edits: [{ file: O, find: '            if stamp(&input.stat(true).await?) != stamp(&stat) {\n                return Err(observation_changed());\n            }\n            loop {', replace: '            let _ = input.stat(true).await?;\n            loop {' }], named: /observation changes/ },
  { name: 'C14 the stamp check after the reads skipped (macOS: only one more lstat of the path before the same error, which only the trace sees)', edits: [{ file: O, find: '            if stamp(&input.stat(true).await?) != stamp(&stat) {\n                return Err(observation_changed());\n            }\n            Ok(())', replace: '            let _ = input.stat(true).await?;\n            Ok(())' }], named: /system calls/ },
  { name: 'C15 the path check after the hash skipped (first pass)', edits: [{ file: O, find: '            if mutation_file_stamp(&directory, &file, None).await? != Some(stamp(&stat)) {\n                return Err(observation_changed());\n            }\n            let digest = hash.borrow().clone().digest_hex();\n            if preview {', replace: '            let _ = mutation_file_stamp(&directory, &file, None).await?;\n            let digest = hash.borrow().clone().digest_hex();\n            if preview {' }], named: /observation changes/ },
  { name: 'C16 the path check after the copy skipped (second pass)', edits: [{ file: O, find: '            if mutation_file_stamp(&directory, &file, None).await? != Some(stamp(&stat)) {\n                return Err(observation_changed());\n            }\n            let handle =', replace: '            let _ = mutation_file_stamp(&directory, &file, None).await?;\n            let handle =' }], named: /observation changes/ },
  { name: 'C17 a NUL byte kept as text', edits: [{ file: O, find: '        if bytes.contains(&0) {', replace: '        if bytes.contains(&0) && false {' }], named: /inputs|classifier/ },
  { name: 'C18 a sequence left open at the end accepted', edits: [{ file: O, find: 'if !self.whole.get() && !std::mem::take(&mut *self.pending.borrow_mut()).is_empty() {', replace: 'if !self.whole.get() && std::mem::take(&mut *self.pending.borrow_mut()).is_empty() && false {' }], named: /inputs|classifier/ },
  { name: 'C19 the 8 MiB bound off by one', edits: [{ file: O, find: 'stat.big().size > GRANULAR_TEXT_BYTES', replace: 'stat.big().size >= GRANULAR_TEXT_BYTES' }], named: /inputs/ },
  { name: 'C20 an await merged: an unsafe path refused before the ancestors\' await', edits: [{ file: O, find: '        check_execution_admission(&ctx)?;\n        if !has_directory_ancestors(&directory, &file, None).await? {\n            return Ok(Resolution::Value(W::Null));', replace: '        check_execution_admission(&ctx)?;\n        if !safe_change_path(JsStr::from(file.as_str()).units()) {\n            return Err(unsupported_path());\n        }\n        if !has_directory_ancestors(&directory, &file, None).await? {\n            return Ok(Resolution::Value(W::Null));' }], named: /job order/ },
  // --- verification and verified-objects.v1 ---
  { name: 'C21 bytesFor without its re-hash', edits: [{ file: O, find: '        if odb::sha256_hex(&bytes) != hash {', replace: '        if odb::sha256_hex(&bytes) != hash && false {' }], named: /views/ },
  { name: 'C22 verification without its re-hash', edits: [{ file: O, find: '        if hash.digest_hex() != expected {', replace: '        if hash.digest_hex() != expected && false {' }], named: /views/ },
  { name: 'C23 a known hash trusted whatever its identity', edits: [{ file: O, find: '        if verified_identity(&expected).as_deref() == Some(identity.as_str()) {', replace: '        if verified_identity(&expected).is_some() {' }], named: /views/ },
  { name: 'C24 identities with the mode', edits: [{ file: O, find: '    stat.big().stamp(false)\n', replace: '    stat.big().stamp(true)\n' }], named: /views|inputs/ },
  { name: 'C25 a verified object not persisted', edits: [{ file: O, find: '            persist_verified(&root, &expected, &identity).await?;\n', replace: '' }], named: /views/ },
  { name: 'C26 verified-objects.v1 never compacted', edits: [{ file: O, find: 'if lines > 1_024 && lines > latest.len() * 2 {', replace: 'if lines > 1_024 && lines > latest.len() * 2_000 {' }], named: /views/ },
  { name: 'C27 the persistent-verify kill switch ignored', edits: [{ file: O, find: '    host::env("DEVRYAN_PERSISTENT_OBJECT_VERIFY").as_deref() != Some("0")', replace: '    host::env("DEVRYAN_PERSISTENT_OBJECT_VERIFY").as_deref() != Some("never")' }], named: /views/ },
  { name: 'C28 upper-case hex accepted as an object name', edits: [{ file: O, find: '.all(|byte| byte.is_ascii_digit() || (b\'a\'..=b\'f\').contains(&byte))', replace: '.all(|byte| byte.is_ascii_digit() || (b\'a\'..=b\'f\').contains(&byte.to_ascii_lowercase()))' }], named: /views|verified_lines/ },
  // --- views ---
  { name: 'C29 a view copy keeps the source\'s modification time (as a clone would)', edits: [{ file: L, find: '        remaining -= sent as i64;\n    }\n    Ok(())', replace: '        remaining -= sent as i64;\n    }\n    // SAFETY: as above.\n    unsafe { libc::futimens(fd, times.as_ptr()) };\n    Ok(())' }], named: /views/ },
  { name: 'C30 a view copy without libuv\'s futimens', edits: [{ file: L, find: '    if unsafe { libc::futimens(fd, times.as_ptr()) } == -1 {\n        return Err(Error::os(last_errno(), "futimens", None));\n    }', replace: '    let _ = &times;' }], named: /views/ },
  { name: 'C31 the materializer copies without COPYFILE_EXCL', edits: [{ file: O, find: 'COPYFILE_EXCL | COPYFILE_FICLONE).await?;', replace: 'COPYFILE_FICLONE).await?;' }], named: /views/ },
  { name: 'C32 the materializer\'s chmod skipped', edits: [{ file: O, find: '            nfs::chmod(&target, mode).await?;\n            execution_progress(&ctx);\n            Ok(Resolution::Promise(', replace: '            execution_progress(&ctx);\n            Ok(Resolution::Promise(' }], named: /views|seeded/ },
  { name: 'C33 ensure follows a link (stat for lstat)', edits: [{ file: O, find: '                let stat = nfs::lstat(&checked, false).await?;', replace: '                let stat = nfs::stat(&checked, false).await?;' }], named: /views/ },
  { name: 'C34 ensure keeps nothing (a new chain per call)', edits: [{ file: O, find: '    let known = state.directories.borrow().get(directory).cloned();', replace: '    let known = state.directories.borrow().get(directory).cloned().filter(|_| directory == state.view);' }], named: /job order/ },
  { name: 'C35 the materializer copies before it verifies', edits: [{ file: O, find: '                        verify_mutation_object(&ctx, &object, &hash).await?;\n                        check_execution_admission(&ctx)?;\n                        nfs::copy_file(&object, &target, COPYFILE_EXCL | COPYFILE_FICLONE).await?;', replace: '                        check_execution_admission(&ctx)?;\n                        nfs::copy_file(&object, &target, COPYFILE_EXCL | COPYFILE_FICLONE).await?;\n                        verify_mutation_object(&ctx, &object, &hash).await?;' }], named: /views/ },
  { name: 'C36 a link entry refused before its hash is checked', edits: [{ file: O, find: '            let hash = hash_of(&entry, true)?.to_string_lossy();\n            if !object_name(&hash) {\n                return Err(invalid_change_record());\n            }\n            if matches!(entry.get("mode"), W::String(mode) if mode.to_string_lossy() == "120000") {\n                return Ok(Resolution::Value(None));\n            }', replace: '            if matches!(entry.get("mode"), W::String(mode) if mode.to_string_lossy() == "120000") {\n                return Ok(Resolution::Value(None));\n            }\n            let hash = hash_of(&entry, true)?.to_string_lossy();\n            if !object_name(&hash) {\n                return Err(invalid_change_record());\n            }' }], named: /views/ },
  { name: 'C37 a durable copy not synced', edits: [{ file: O, find: '                let synced = opened.sync().await;\n', replace: '                let synced: Result<(), W> = Ok(());\n' }], named: /durability/ },
  { name: 'C38 a disposable copy ignores DEVRYAN_VIEW_CLONE', edits: [{ file: O, find: '        if !durable && host::env("DEVRYAN_VIEW_CLONE").as_deref() != Some("0") {', replace: '        if !durable {' }], named: /views/ },
  // --- the dual-run crash points ---
  { name: 'C39 the link\'s "before" point reached after the link', edits: [{ file: O, find: '            crate::seams::crash_point("content-object-link:before");\n', replace: '' }, { file: O, find: '                        crate::seams::crash_point("content-object-link:after");', replace: '                        crate::seams::crash_point("content-object-link:before");\n                        crate::seams::crash_point("content-object-link:after");' }], named: /crash at content-object-link:before/ },
  { name: 'C40 the directory sync\'s crash point never reached', edits: [{ file: D, find: '                    crate::seams::crash_point("directory-sync:before");\n', replace: '' }], named: /crash at directory-sync:before/ },
]);

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...options });
  return { ok: result.status === 0 && !result.error, status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}` };
}

/** The names of the tests a run reports failed. */
function failures(output) {
  return [...output.matchAll(/(?:^|\n)\s*✖ ([^\n]+?)(?: \(\d[^)]*\))?(?=\n)/g), ...output.matchAll(/test (\S+) \.\.\. FAILED/g)].map((match) => match[1].trim());
}

function withBug(copy, bug, build, check) {
  const originals = new Map();
  try {
    for (const edit of bug.edits) {
      const file = path.join(copy.workspace, edit.file);
      if (!originals.has(file)) originals.set(file, readFileSync(file, 'utf8'));
      const text = readFileSync(file, 'utf8');
      const count = text.split(edit.find).length - 1;
      if (count !== 1) throw new Error(`planted bug "${bug.name}": its text occurs ${count} times in ${edit.file}`);
      writeFileSync(file, text.replace(edit.find, edit.replace));
    }
    const built = build();
    if (!built.ok) throw new Error(`planted bug "${bug.name}" does not build:\n${built.output.slice(-3000)}`);
    return check();
  } finally {
    for (const [file, original] of originals) writeFileSync(file, original);
  }
}

export function main(argv = process.argv.slice(2)) {
  const only = argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length).split(';');
  const bugs = only ? BUGS.filter((bug) => only.some((name) => bug.name.includes(name))) : BUGS;
  if (argv.includes('--dry')) {
    const native = path.join(root, 'packages/harness-runtime/native/ledger');
    const wrong = [];
    for (const bug of bugs) {
      // Edits apply in order: each later text is looked up after the earlier ones.
      const texts = new Map();
      for (const edit of bug.edits) {
        const text = texts.get(edit.file) ?? readFileSync(path.join(native, edit.file), 'utf8');
        const count = text.split(edit.find).length - 1;
        if (count !== 1) wrong.push(`${bug.name}: ${count} in ${edit.file}`);
        texts.set(edit.file, text.replace(edit.find, edit.replace));
      }
    }
    console.log(wrong.length ? wrong.join('\n') : `every one of ${bugs.length} plants applies once`);
    return wrong.length ? 1 : 0;
  }
  const copy = workspaceCopy();
  const probe = path.join(copy.scratch, 'target', 'debug', 'ledger-native-probe');
  let failed = true;
  const rows = [];
  try {
    const build = () => run(copy.cargo, ['build', '--locked', '--offline', '--package', 'ledger-native', '--features', 'test-hooks', '--bin', 'ledger-native-probe'], { cwd: copy.workspace, env: copy.env });
    const unit = () => run(copy.cargo, ['test', '--locked', '--offline', '--package', 'ledger-native', '--features', 'test-hooks', '--lib', 'objects::'], { cwd: copy.workspace, env: copy.env, timeout: 600_000, killSignal: 'SIGKILL' });
    const differential = () => run(process.execPath, ['--import=./scripts/test-isolation-preload.mjs', '--test', DIFFERENTIAL],
      { cwd: root, env: { ...process.env, [LEDGER_PROBE_VARIABLE]: probe, LEDGER_NATIVE_ODB_EXTENDED: '' }, timeout: 600_000, killSignal: 'SIGKILL' });
    if (!build().ok) throw new Error('the unchanged probe does not build');
    if (!unit().ok) throw new Error('the unchanged cargo tests fail');
    const baseline = differential();
    if (!baseline.ok) throw new Error(`the unchanged differential fails: ${failures(baseline.output).join('; ')}`);
    for (const bug of bugs) {
      const row = withBug(copy, bug, build, () => {
        const started = Date.now(), u = unit(), d = differential();
        const failing = [...failures(u.output), ...failures(d.output)];
        const named = failing.filter((name) => bug.named.test(name));
        return { name: bug.name, caught: !u.ok || !d.ok, byNamed: named.length > 0, seconds: Math.round((Date.now() - started) / 1000), by: (named.length ? named : failing).slice(0, 3).join('; ').slice(0, 300) };
      });
      rows.push(row);
      console.log(`${row.byNamed ? 'caught  ' : row.caught ? 'OTHER   ' : 'SURVIVED'} ${row.name} (${row.seconds} s)${row.by ? `: ${row.by}` : ''}`);
    }
    failed = false;
    console.log(JSON.stringify({ platform: `${process.platform} ${process.arch}`, planted: rows.length, caughtByNamed: rows.filter((row) => row.byNamed).length, caught: rows.filter((row) => row.caught).length, survived: rows.filter((row) => !row.caught).map((row) => row.name) }));
    return rows.every((row) => row.byNamed) ? 0 : 1;
  } finally {
    copy.dispose(failed);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
