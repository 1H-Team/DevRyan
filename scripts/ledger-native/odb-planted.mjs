#!/usr/bin/env node
// Planted bugs in the native object database (plan package L3a): each is one
// small change to the Rust in a copy of the workspace, and each must be
// caught by the tracked tests, its unit tests (`cargo test`) or the
// differential tests named beside it (odb-differential.mjs, which then run
// against the mutated probe). The unchanged copy must pass the same tests
// first. Outside the gate: it rebuilds the probe once per bug.
//
//   node scripts/ledger-native/odb-planted.mjs [--only='<name>;<name>']
//
// Like the build script it is started without the isolation preload (it needs
// the owner's Rust toolchain); every test it runs gets the preload.
//
// Exit status 0 when every bug was caught, 1 otherwise; a JSON summary is the last line.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { ODB_PROBE_VARIABLE, workspaceCopy } from '../build-ledger-native.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const DIFFERENTIAL = 'scripts/ledger-native/odb-differential.mjs';
const ODB = 'ledger-io/src/git/odb';

/** name, file under the workspace, the text replaced (exactly once), its replacement, the differential tests that must catch it too. */
export const PLANTED = Object.freeze([
  { name: 'fan-out off by one', file: `${ODB}/pack.rs`, find: 'be32(&self.data, 8 + 4 * (first - 1)) as usize', replace: 'be32(&self.data, 8 + 4 * first) as usize', tests: '^a\\. .*sha1, repack-a-d' },
  { name: 'OFS delta base one byte off', file: `${ODB}/pack.rs`, find: 'EntryKind::Ofs(offset - base)', replace: 'EntryKind::Ofs(offset - base + 1)', tests: '^a\\. .*sha1, deep-delta' },
  { name: 'a miss does not list the packs again', file: `${ODB}/mod.rs`, find: '        let (packs, unknown) = self.rescan()?;\n        if let Some(found) = find_packed(&packs, oid)? {', replace: '        let (packs, unknown) = (self.current_packs()?, None::<AskGit>);\n        if let Some(found) = find_packed(&packs, oid)? {', tests: '^e\\. ' },
  { name: 'loose refs read from the wrong place', file: `${ODB}/refs.rs`, find: 'let path = format!("{}/{name}", repo.git_dir());', replace: 'let path = format!("{}/refs/{name}", repo.git_dir());', tests: '^a\\. .*sha1, loose' },
  { name: 'packed refs never read', file: `${ODB}/refs.rs`, find: 'Ok(read_packed(self)?.get(name).copied())', replace: 'Ok(None)', tests: '^a\\. .*sha1, repack-d' },
  { name: 'subtrees ordered without their slash', file: `${ODB}/walk.rs`, find: "    if entry.mode == TREE_MODE {\n        name.push(b'/');\n    }\n    name", replace: '    name', tests: '^a\\. .*sha1, loose' },
  { name: 'a delta\'s size from the base size in its header', file: `${ODB}/mod.rs`, find: '"delta header"))?\n                    .1\n', replace: '"delta header"))?\n                    .0\n', tests: '^a\\. .*sha1, deep-delta' },
  { name: 'a loose header one byte short', file: `${ODB}/loose.rs`, find: 'Some((kind, size, at + 1))', replace: 'Some((kind, size, at))', tests: '^a\\. .*sha1, loose' },
  { name: 'large offsets read one entry off', file: `${ODB}/pack.rs`, find: 'let at = offsets + 4 * self.count + 8 * large;', replace: 'let at = offsets + 4 * self.count + 8 * large + 8;', tests: '^a\\. .*sha1, large-offset' },
  { name: 'a copy of size 0 copies 0x1000', file: `${ODB}/delta.rs`, find: 'size = 0x10000;', replace: 'size = 0x1000;', tests: null },
  { name: 'no REF delta cycle detection', file: `${ODB}/mod.rs`, find: '            if !seen.insert((current.0.id, current.1)) {\n                return ask(\n                    Reason::DeltaCycle,\n                    format!("entry at {} visited twice", current.1),\n                );\n            }\n            let entry = current.0.entry(current.1)?;\n            match entry.kind {\n                EntryKind::Object(kind) => {', replace: '            let _ = &seen;\n            let entry = current.0.entry(current.1)?;\n            match entry.kind {\n                EntryKind::Object(kind) => {', tests: null },
  { name: 'alternates ignored on a miss', file: `${ODB}/repo.rs`, find: 'Ok(_) => return Some(AskGit::new(Reason::Alternates, "objects/info/alternates")),', replace: 'Ok(_) => {}', tests: '^b\\. .*alternates' },
  { name: 'a multi-pack index ignored', file: `${ODB}/pack.rs`, find: 'if name.starts_with("multi-pack-index") {', replace: 'if name.starts_with("multi-pack-index-never") {', tests: '^b\\. .*multi-pack index' },
  { name: 'index checksum not checked', file: `${ODB}/pack.rs`, find: 'if format.hash(&[&data[..data.len() - hash]]).raw() != checksum {', replace: 'if false && format.hash(&[&data[..data.len() - hash]]).raw() != checksum {', tests: '^b\\. .*a corrupt index' },
  { name: 'pack trailer not checked against its index', file: `${ODB}/pack.rs`, find: 'if trailer != index.pack_checksum() {', replace: 'if false && trailer != index.pack_checksum() {', tests: '^b\\. .*a corrupt index' },
  { name: 'garbage after a loose stream accepted', file: `${ODB}/loose.rs`, find: 'if inflated.consumed != self.source.size() {', replace: 'if false && inflated.consumed != self.source.size() {', tests: '^b\\. .*corrupt loose objects' },
  { name: 'a gitlink name answered "missing", not "submodule"', file: `${ODB}/mod.rs`, find: 'Some((oid, mode)) => (oid, mode == b"160000"),', replace: 'Some((oid, mode)) => (oid, mode == b"160644"),', tests: '^a\\. .*sha1, loose' },
  { name: 'a paged listing\'s paths without the prefix\'s slash', file: `${ODB}/walk.rs`, find: "    let mut path = prefix.as_bytes().to_vec();\n    path.push(b'/');\n", replace: '    let path = prefix.as_bytes().to_vec();\n', tests: '^a\\. .*sha1, loose' },
  { name: 'a REF delta base looked up outside its pack', file: `${ODB}/mod.rs`, find: '                    current.1 = ref_base_in_pack(&current.0, &base)?;\n', replace: '                    match self.locate(&base)? {\n                        Some(Located::Packed(other, base_offset)) => current = (other, base_offset),\n                        Some(Located::Loose(file)) => break file.read(&self.options)?,\n                        None => return ask(Reason::CorruptPack, "missing"),\n                    }\n', tests: '^b\\. .*REF delta whose base' },
  { name: 'the writer stops after four attempts', file: `${ODB}/write.rs`, find: 'const ATTEMPTS: u32 = 5;', replace: 'const ATTEMPTS: u32 = 4;', tests: '^d\\. ' },
  { name: 'the writer retries EINVAL in the same directory', file: `${ODB}/write.rs`, find: '&& !same_directory(created.as_ref(), current.as_ref())', replace: '&& same_directory(created.as_ref(), current.as_ref())', tests: '^d\\. ' },
]);

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...options });
  return { ok: result.status === 0, status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

export function main(argv = process.argv.slice(2)) {
  const only = argv.find((arg) => arg.startsWith('--only='))?.slice(7).split(';');
  const planted = PLANTED.filter((bug) => !only || only.includes(bug.name));
  const copy = workspaceCopy();
  let failed = true;
  const rows = [];
  try {
    const unit = () => run(copy.cargo, ['test', '--locked', '--offline', '--package', 'ledger-io', '--lib', '--', 'git::odb'], { cwd: copy.workspace, env: copy.env });
    const differential = (pattern) => run(process.execPath, ['--import=./scripts/test-isolation-preload.mjs', '--test', `--test-name-pattern=${pattern}`, DIFFERENTIAL],
      { cwd: root, env: { ...process.env, [ODB_PROBE_VARIABLE]: copy.odbProbe } });
    // The unchanged copy passes everything the bugs are checked against.
    copy.build();
    const baseline = unit();
    if (!baseline.ok) throw new Error(`the unchanged unit tests fail:\n${baseline.output.slice(-4000)}`);
    for (const pattern of new Set(planted.map((bug) => bug.tests).filter(Boolean))) {
      const result = differential(pattern);
      if (!result.ok) throw new Error(`the unchanged differential tests fail (${pattern}):\n${result.output.slice(-4000)}`);
    }
    for (const bug of planted) {
      const file = path.join(copy.workspace, bug.file);
      const original = readFileSync(file, 'utf8');
      const count = original.split(bug.find).length - 1;
      if (count !== 1) throw new Error(`planted bug "${bug.name}": its text occurs ${count} times in ${bug.file}`);
      writeFileSync(file, original.replace(bug.find, bug.replace));
      try {
        const built = run(copy.cargo, ['build', '--locked', '--offline', '--package', 'ledger-io', '--features', 'probe', '--bin', 'odb-probe'], { cwd: copy.workspace, env: copy.env });
        if (!built.ok) throw new Error(`planted bug "${bug.name}" does not build:\n${built.output.slice(-3000)}`);
        const unitCaught = !unit().ok;
        const differentialCaught = bug.tests ? !differential(bug.tests).ok : null;
        const caught = unitCaught || differentialCaught === true;
        rows.push({ name: bug.name, unit: unitCaught, differential: differentialCaught, caught });
        console.log(`${caught ? 'caught  ' : 'SURVIVED'} ${bug.name}: unit tests ${unitCaught ? 'failed' : 'passed'}${bug.tests ? `, differential (${bug.tests}) ${differentialCaught ? 'failed' : 'passed'}` : ''}`);
      } finally {
        writeFileSync(file, original);
      }
    }
    failed = rows.some((row) => !row.caught);
    console.log(JSON.stringify({ planted: rows.length, caught: rows.filter((row) => row.caught).length, byUnit: rows.filter((row) => row.unit).length, byDifferential: rows.filter((row) => row.differential).length }));
    return failed ? 1 : 0;
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
