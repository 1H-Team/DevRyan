#!/usr/bin/env node
// Planted bugs in the native ledger's Git runner and store
// (ledger-native/src/git.rs, store.rs): each is one small change to the Rust
// in a copy of the workspace, run against what the verify runs for them:
// the runner's library tests (`cargo test -p ledger-native --lib git::`),
// all of store-differential.mjs and child-differential.mjs (whose named
// programs call the ported runner at the trace level), against the mutated
// probe. The unchanged copy must pass first. Each bug is reported with what
// caught it; `named` is the test the bug is planted for, which must be among
// those that fail. Outside the gate: it rebuilds the probe once per bug.
//
//   node scripts/ledger-native/store-planted.mjs [--only='<name>;<name>']
//
// Exit status 0 when every bug was caught by its named test, 1 otherwise; a
// JSON summary is the last line. `--dry` only checks that every plant's text
// occurs once in the worktree. Besides the builder's R and S plants: the L3b
// review's P plants on the fixed code, and F plants that undo each fix of
// the review's first fix round. Only the runner's plants (R) and those that
// name it run child-differential.mjs too.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { LEDGER_PROBE_VARIABLE, workspaceCopy } from '../build-ledger-native.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const DIFFERENTIALS = ['scripts/ledger-native/store-differential.mjs', 'scripts/ledger-native/child-differential.mjs'];
const G = 'ledger-native/src/git.rs';
const S = 'ledger-native/src/store.rs';
const D = 'ledger-native/src/durability.rs';
const O = 'ledger-native/src/node/odb.rs';
const C = 'ledger-native/src/node/child.rs';
const F = 'ledger-native/src/node/fs.rs';
const P = 'ledger-io/src/git/odb/pack.rs';
const I = 'ledger-io/src/git/odb/inflate.rs';
const B = 'ledger-native/src/bin/ledger-native-probe.rs';

/**
 * `{ name, file, find, replace, extra?, named, equivalent? }`: `named` matches
 * the failing test that must catch it; `extra` is a second edit of the same
 * bug; `equivalent` marks a plant no test can tell from the code (it is run
 * and reported, and does not fail the run when it survives).
 */
export const BUGS = Object.freeze([
  // --- the runner ---
  { name: 'R01 ECANCELED swallowed too (F1 fixed, not reproduced)', file: G, find: 'if code != "EPIPE" && code != "ERR_STREAM_PREMATURE_CLOSE" {', replace: 'if code != "EPIPE" && code != "ERR_STREAM_PREMATURE_CLOSE" && code != "ECANCELED" {', named: /goes away with input waiting/ },
  { name: 'R02 EPIPE not swallowed', file: G, find: 'if code != "EPIPE" && code != "ERR_STREAM_PREMATURE_CLOSE" {', replace: 'if code != "ERR_STREAM_PREMATURE_CLOSE" {', named: /goes away with input waiting/ },
  { name: 'R03 the timeoutMs option ignored (always 30 s)', file: G, find: 'host::set_timeout(options.timeout_ms.unwrap_or(30_000.0), move || {', replace: 'host::set_timeout(30_000.0, move || {', named: /a lock, an abort/ },
  { name: 'R04 a timeout not marked timed out (its kill classed as a signal)', file: G, find: '            timed_out.set(true);\n', replace: '', named: /a lock, an abort/ },
  { name: 'R05 no abort listener (an aborted call\'s child lives on)', file: G, find: 'signal.add_listener(move |_| {', replace: 'signal.add_listener_with(true, move |_| {\n            return;\n            #[allow(unreachable_code)]', named: /a lock, an abort|tokens/ },
  { name: 'R06 the abort reason replaced by the close\'s class', file: G, find: 'if let Some(signal) = signal.as_ref().filter(|signal| signal.aborted()) {', replace: 'if let Some(signal) = signal.as_ref().filter(|signal| signal.aborted() && false) {', named: /a lock, an abort|tokens/ },
  { name: 'R07 no admission check before the spawn', file: G, find: '    let signal = execution_signal(ctx);\n    if let Some(signal) = &signal {\n        signal.throw_if_aborted()?;\n    }', replace: '    let signal = execution_signal(ctx);', named: /a lock, an abort|aborted/ },
  { name: 'R08 stderr\'s head cut at 16 units', file: G, find: 'units[..units.len().min(1024)]', replace: 'units[..units.len().min(16)]', named: /a lock, an abort/ },
  { name: 'R09 stderr\'s tail keeps the head', file: G, find: '*tail.borrow_mut() = JsStr::from_units(units[keep..].to_vec());', replace: '*tail.borrow_mut() = JsStr::from_units(units[..units.len() - keep].to_vec());', named: /a lock, an abort/ },
  { name: 'R10 not a repository is 503', file: G, find: 'resolvers.reject(failed("capture_not_git", 409.0));', replace: 'resolvers.reject(failed("capture_not_git", 503.0));', named: /stdout, limits|a lock, an abort/ },
  { name: 'R11 acceptExitCodes ignored', file: G, find: '.any(|accepted| matches!(code, W::Number(number) if number == *accepted));', replace: '.any(|accepted| matches!(code, W::Number(number) if number == *accepted) && false);', named: /stdout, limits|a lock, an abort/ },
  { name: 'R12 the ".lock\': File exists" alternative dropped', file: G, find: '|| contains_folded(hay, ".lock\': file exists")', replace: '', named: /failure classes/ },
  { name: 'R13 no case folding (/i lost)', file: G, find: 'fn fold(unit: u16) -> u16 {\n', replace: 'fn fold(unit: u16) -> u16 {\n    #[allow(clippy::needless_return)]\n    return unit;\n    #[allow(unreachable_code)]\n', named: /failure classes/ },
  { name: 'R14 "Unable to create \'…\\.lock\'" matched past its quote', file: G, find: '.is_some_and(|length| length >= 5 && at_folded(hay, from + length - 5, ".lock"))', replace: '.is_some_and(|_| hay[from..].windows(5).any(|window| window.iter().zip(".lock".bytes()).all(|(unit, byte)| fold(*unit) == u16::from(byte))))', named: /failure classes/ },
  { name: 'R15 "unable to read" needs 6 hex digits, not 7', file: G, find: '.count() >= 7', replace: '.count() >= 6', named: /failure classes/ },
  { name: 'R16 `.*` crosses line terminators', file: G, find: 'if index >= hay.len() || line_terminator(hay[index]) {', replace: 'if index >= hay.len() {', named: /failure classes/ },
  { name: 'R17 corrupt classed before lock', file: G, find: '    if lock_failure(stderr) {\n        return String::from("lock");\n    }\n    if corrupt_failure(stderr) {\n        return String::from("corrupt");\n    }', replace: '    if corrupt_failure(stderr) {\n        return String::from("corrupt");\n    }\n    if lock_failure(stderr) {\n        return String::from("lock");\n    }', named: /failure classes/ },
  { name: 'R18 exit 255 classed unknown (code < 255)', file: G, find: '&& *code < 256.0', replace: '&& *code < 255.0', named: /failure classes/ },
  { name: 'R19 -C\'s value not skipped by gitCommand', file: G, find: '["--git-dir", "--work-tree", "--namespace", "-C", "-c"];', replace: '["--git-dir", "--work-tree", "--namespace", "-C\\0", "-c"];', named: /stdout, limits|command_is_the_first_word/ },
  { name: 'R20 the limit off by one (>= instead of >)', file: G, find: 'if bytes > limit {', replace: 'if bytes >= limit {', named: /stdout, limits/ },
  { name: 'R21 git() awaits done before writing', file: G, find: '            process.writing.clone().await?;\n            process.done.clone().await?;\n            Ok(chunks)', replace: '            process.done.clone().await?;\n            process.writing.clone().await?;\n            Ok(chunks)', named: /goes away with input waiting/ },
  { name: 'R22 git() does not await writing', file: G, find: '            process.writing.clone().await?;\n            process.done.clone().await?;\n            Ok(chunks)', replace: '            process.done.clone().await?;\n            Ok(chunks)', named: /goes away with input waiting/ },
  { name: 'R23 gitTokens allows a 2 MiB token', file: G, find: 'if tail.len() > 1024 * 1024 {', replace: 'if tail.len() > 2 * 1024 * 1024 {', named: /gitTokens/ },
  { name: 'R24 gitTokens drops its last token', file: G, find: '            if !tail.is_empty() {\n', replace: '            if false && !tail.is_empty() {\n', named: /gitTokens|ported gitTokens/ },
  { name: 'R25 gitRecords batches at 4,097 rows', file: G, find: 'batch.len() >= 4096', replace: 'batch.len() > 4096', named: /gitRecords/ },
  { name: 'R26 gitRecords batches at 8 MiB', file: G, find: 'bytes + number > 4.0 * 1024.0 * 1024.0', replace: 'bytes + number > 8.0 * 1024.0 * 1024.0', named: /gitRecords/ },
  { name: 'R27 gitRecords takes a row over 512 KiB', file: G, find: 'number > 512.0 * 1024.0 {', replace: 'number > 1024.0 * 1024.0 {', named: /gitRecords/ },
  { name: 'R28 a gitlink fails only its own read (the shared reader not closed)', file: G, find: '            Answered::Close(error) => {\n                close_reader(reader, error);\n                return;\n            }', replace: '            Answered::Close(error) => {\n                reader.pending.borrow_mut().pop_front();\n                head.resolvers.reject(error.unwrap_or_else(|| change_error("capture_git_failed", 503.0)));\n            }', named: /persistent reader/ },
  { name: 'R29 a missing object rejects instead of null', file: G, find: 'odb::Lookup::Missing => Promise::resolve(Resolution::Value(Answered::Null)),', replace: 'odb::Lookup::Missing => Promise::resolve(Resolution::Value(Answered::Close(None))),', named: /persistent reader/ },
  { name: 'R30 a checked read carries the data', file: G, find: '    if let Some(data) = data {\n        fields.push(("data", W::Bytes(data)));\n    }', replace: '    fields.push(("data", data.map_or(W::Null, W::Bytes)));', named: /persistent reader/ },
  { name: 'R31 a name with a newline reaches the reader', file: G, find: '.any(|unit| matches!(*unit, 0x0a | 0x0d | 0x00))', replace: '.any(|unit| matches!(*unit, 0x00))', named: /persistent reader/ },
  { name: 'R32 an "ask Git" answer read as absent (no hand-back)', file: G, find: 'odb::Lookup::Ask(_) => ask_git(&reader, &name),', replace: 'odb::Lookup::Ask(_) => Promise::<Answered, W>::resolve(Resolution::Value(Answered::Null)),', named: /persistent reader/ },
  { name: 'R33 GIT_DIR not scrubbed', file: G, find: '    "GIT_DIR",\n', replace: '    "GIT_DIR_UNSCRUBBED",\n', named: /a lock, an abort/ },
  { name: 'R34 GIT_OPTIONAL_LOCKS not set', file: G, find: '    entries.push((String::from("GIT_OPTIONAL_LOCKS"), Some(String::from("0"))));', replace: '', named: /a lock, an abort/ },
  { name: 'R35 an await merged: git() returns its rejection as a promise (two jobs late)', file: G, find: '        let process = started?;', replace: '        let process = match started {\n            Ok(process) => process,\n            Err(error) => return Ok(Resolution::Promise(Promise::reject(error))),\n        };', named: /ported git\(\)|named programs/ },
  { name: 'R36 an await added: gitTokens awaits before it starts', file: G, find: '        let process = start(&ctx, &cwd, &args, &options)?;\n        let delimiter', replace: '        js::value::<W, W>(W::Undefined).await?;\n        let process = start(&ctx, &cwd, &args, &options)?;\n        let delimiter', named: /ported gitTokens|named programs/ },
  { name: 'R37 progress recorded on failure too', file: G, find: '                } else if refused {\n                    resolvers.reject(failed("capture_git_failed", 503.0));', replace: '                } else if refused {\n                    execution_progress(&ctx);\n                    resolvers.reject(failed("capture_git_failed", 503.0));', named: /progress_is_recorded/ },
  // --- the store ---
  { name: 'S01 a ref update without its compare-and-swap', file: S, find: '&[js("update-ref"), inner.ref_.clone(), next.clone(), old],', replace: '&[js("update-ref"), inner.ref_.clone(), next.clone()],', named: /named scenarios|scripts/ },
  { name: 'S02 the guard not asked again after the swap', file: S, find: '            if let Err(cause) = await_guard(&guard).await {', replace: '            if let Err(cause) = Ok::<W, W>(W::Undefined) {', named: /guards/ },
  { name: 'S03 a revoked guard not undone (no rollback)', file: S, find: 'if let Err(rollback) = store.run(&ctx, &back, &GitOptions::default()).await {', replace: 'if let Err(rollback) = store.run(&ctx, &back[..0], &GitOptions::default()).await {', named: /guards/ },
  { name: 'S04 a failed rollback not marked committed', file: S, find: 'error.set_field("committed", W::Bool(true));', replace: 'error.set_field("committed", W::Bool(false));', named: /guards/ },
  { name: 'S05 the object directory not synced before a commit', file: S, find: '            (inner.sync_objects)(&inner.cwd).await?;', replace: '', named: /guards/ },
  { name: 'S06 one listing cached instead of two', file: S, find: 'while listings.len() > 2 {', replace: 'while listings.len() > 1 {', named: /two whole listings/ },
  { name: 'S07 an oversized store not remembered', file: S, find: '                                OVERSIZED.with(|set| {', replace: '                                OVERSIZED.with(|_set| {}); (|set: &RefCell<HashSet<String>>| {', named: /named scenarios|scripts/ },
  { name: 'S08 lowerBound one past an equal key', file: S, find: 'if row_key(&rows[middle]).units() < key.units() {', replace: 'if row_key(&rows[middle]).units() <= key.units() {', named: /named scenarios|scripts|lost and corrupt/ },
  { name: 'S09 no write suppression (an unchanged value staged)', file: S, find: '&& inner.baseline.borrow().get(key) == Some(&Some(data.clone()));', replace: '&& false;', named: /named scenarios|scripts/ },
  { name: 'S10 a removal of a key read as absent staged', file: S, find: '!inner.pending.borrow().has(&key) && inner.baseline.borrow().get(&key) == Some(&None);', replace: 'false;', named: /named scenarios|scripts/ },
  { name: 'S11 staged keys unsorted (a listing unsorted)', file: S, find: '        selected.sort_by(|(a, _), (b, _)| a.units().cmp(b.units()));\n', replace: '', named: /D25|named scenarios|scripts/ },
  { name: 'S12 staged keys in reverse order', file: S, find: 'selected.sort_by(|(a, _), (b, _)| a.units().cmp(b.units()));', replace: 'selected.sort_by(|(a, _), (b, _)| b.units().cmp(a.units()));', named: /D25|named scenarios|scripts/ },
  { name: 'S13 entries yields tree rows a write replaced', file: S, find: 'if !store.inner().pending.borrow().has(&row_key(&row)) {', replace: 'if true {', named: /named scenarios|scripts/ },
  { name: 'S14 pages of 127 values', file: S, find: 'page.len() >= 128', replace: 'page.len() >= 127', named: /named scenarios|scripts/ },
  { name: 'S15 pages of 128 KiB', file: S, find: 'bytes + size > 256.0 * 1024.0', replace: 'bytes + size > 128.0 * 1024.0', named: /scripts/ },
  { name: 'S16 setListObjects takes an id of any length', file: S, find: 'matches!(oid, W::String(text) if keys::valid_list_object(text.units(), inner.oid_length))', replace: 'matches!(oid, W::String(_))', named: /named scenarios/ },
  { name: 'S17 importPrefix keeps the slash', file: S, find: 'let rest = &key.units()[prefix.len().min(key.len())..];', replace: 'let rest = &key.units()[(prefix.len() + 1).min(key.len())..];', named: /named scenarios|scripts/ },
  { name: 'S18 committedIdentity answers a blob\'s id', file: S, find: 'let is_tree = matches!(found.get("type"), W::String(kind) if kind == js("tree"));', replace: 'let is_tree = !matches!(found, W::Null);', named: /named scenarios/ },
  { name: 'S19 prefixIdentity with writes staged', file: S, find: '            if store.pending_count() > 0 {\n                return Err(invalid());\n            }\n            Ok(Resolution::Promise(store.committed_identity(&ctx, &prefix)))', replace: '            Ok(Resolution::Promise(store.committed_identity(&ctx, &prefix)))', named: /named scenarios|scripts/ },
  { name: 'S20 a failed stage not restored', file: S, find: '                    pending.set(key, value);', replace: '                    let _ = (key, value);', named: /named scenarios|scripts/ },
  { name: 'S21 the staging flag left set', file: S, find: '            inner.staging.set(false);', replace: '', named: /named scenarios|scripts/ },
  { name: 'S22 a snapshot store (at) commits', file: S, find: 'if inner.staging.get() || inner.at.is_some() {', replace: 'if inner.staging.get() {', named: /named scenarios/ },
  { name: 'S23 pin without its commit', file: S, find: '            store.commit(&ctx, None).await?;', replace: '', named: /named scenarios|scripts/ },
  { name: 'S24 release without -d', file: S, find: '&[js("update-ref"), js("-d"), lease],', replace: '&[js("update-ref"), lease],', named: /named scenarios|scripts/ },
  { name: 'S25 an emptied subtree kept', file: S, find: 'if entries.borrow().len() == 0 && !is_root {', replace: 'if false && entries.borrow().len() == 0 && !is_root {', named: /named scenarios|scripts/ },
  { name: 'S26 a kept index never read again', file: S, find: 'if !kept || indexed.as_ref() != Some(&expected) {', replace: 'if !kept {', named: /named scenarios|scripts|guards/ },
  { name: 'S27 the loose ref not used (for-each-ref every open)', file: S, find: 'let refs = match loose_ref.filter(object_id_text) {', replace: 'let refs = match loose_ref.filter(|_| false) {', named: /named scenarios|scripts/ },
  { name: 'S28 the id width fixed at 40', file: S, find: '            Some(tree) => tree.len(),', replace: '            Some(_) => 40,', named: /sha256/ },
  { name: 'S29 `at` not validated', file: S, find: '                if !object_id_text(&text) {', replace: '                if false && !object_id_text(&text) {', named: /open: refusals/ },
  { name: 'S30 listingLimitBytes not checked positive', file: S, find: '                    && number > 0.0 =>', replace: '                    && number >= 0.0 =>', named: /open: refusals/ },
  { name: 'S31 the loose ref not trimmed', file: S, find: '|value| Ok(Resolution::Value(Some(trim(&value)))),\n                        |cause| {\n                            if ["ENOENT", "ENOTDIR"]', replace: '|value| Ok(Resolution::Value(Some(value))),\n                        |cause| {\n                            if ["ENOENT", "ENOTDIR"]', named: /named scenarios|scripts|open/ },
  { name: 'S32 DEVRYAN_LEDGER_DIRECT_LISTINGS ignored', file: S, find: 'self.0.reader && host::env("DEVRYAN_LEDGER_DIRECT_LISTINGS").as_deref() != Some("0")', replace: 'self.0.reader', named: /paged-git|scripts|lost and corrupt/ },
  { name: 'S33 DEVRYAN_LEDGER_DIRECT_TREES ignored', file: S, find: 'self.0.reader && host::env("DEVRYAN_LEDGER_DIRECT_TREES").as_deref() != Some("0")', replace: 'self.0.reader', named: /named scenarios|scripts|guards/ },
  { name: 'S34 a direct listing does not see the abort (its failed read taken for an empty listing)', file: S, find: '                    .catch(|_| Ok(Resolution::Value(W::Null)))\n                    .await?', replace: '                    .catch(|_| Ok(Resolution::Value(W::Array(Vec::new()))))\n                    .await?', named: /aborted|guards/ },
  { name: 'S35 get without a reader takes a missing answer as a record', file: S, find: '            if header.last() == Some(&"missing") {', replace: '            if false {', named: /named scenarios|scripts|lost and corrupt/ },
  // Equivalent, kept to record it: `cat-file --batch` answers a last name without its newline at the end of its input.
  { name: 'S36 get without a reader sends no newline (equivalent: Git reads the last line at EOF)', file: S, find: '            line.push_str("\\n");', replace: '', named: /named scenarios|scripts/, equivalent: true },
  // --- the L3b review's own plants (reports/L3b-review-probes/plants.mjs), on the fixed code ---
  { name: 'P01 GIT_INDEX_FILE not scrubbed from the inherited environment', file: G, find: '    "GIT_INDEX_FILE",\n    "GIT_WORK_TREE",', replace: '    "GIT_WORK_TREE",', extra: { file: G, find: 'const SCRUBBED: [&str; 6]', replace: 'const SCRUBBED: [&str; 5]' }, named: /a lock, an abort|stdout, limits/ },
  { name: 'P03 a failing Git with an empty stderr is a success (a killed update-ref)', file: G, find: '                } else if refused {\n                    resolvers.reject(failed("capture_git_failed", 503.0));', replace: '                } else if refused && !(head.borrow().is_empty() && tail.borrow().is_empty()) {\n                    resolvers.reject(failed("capture_git_failed", 503.0));', named: /progress_is_recorded|stdout, limits/ },
  { name: 'P04 git() ignores done (a refused update-ref reads as success)', file: G, find: '            process.writing.clone().await?;\n            process.done.clone().await?;\n            Ok(chunks)', replace: '            process.writing.clone().await?;\n            let _ = process.done.clone().await;\n            Ok(chunks)', named: /progress_is_recorded|stdout, limits|named/ },
  { name: 'P05 git() output limit ignored', file: G, find: '                if bytes > limit {', replace: '                if bytes > limit && false {', named: /stdout, limits/ },
  { name: 'P06 the abort kills nothing (the close decides)', file: G, find: '        signal.add_listener(move |_| {\n            let _ = child.kill(Signal::Kill);\n        })', replace: '        signal.add_listener(move |_| {\n            let _ = &child;\n        })', named: /a lock, an abort|tokens/ },
  { name: 'P07 reader answers settle as they arrive (no head-of-line order)', file: G, find: '        let Some(answered) = head.answer.borrow_mut().take() else {\n            return;\n        };', replace: '        let Some(answered) = head.answer.borrow_mut().take() else {\n            let later: Vec<Rc<Request>> = reader.pending.borrow().iter().skip(1).cloned().collect();\n            for request in later { if let Some(Answered::Object(object)) = request.answer.borrow_mut().take() { reader.pending.borrow_mut().retain(|known| !Rc::ptr_eq(known, &request)); request.resolvers.fulfill(object); } }\n            return;\n        };', named: /persistent reader|named|scripts/ },
  { name: 'P08 a corrupt object (the database asks Git) read as absent', file: G, find: '                odb::Lookup::Ask(_) => ask_git(&reader, &name),', replace: '                odb::Lookup::Ask("corrupt_object") => Promise::resolve(Resolution::Value(Answered::Null)),\n                odb::Lookup::Ask(_) => ask_git(&reader, &name),', named: /persistent reader|hangs/ },
  { name: 'P09 a hand-back parsed as --batch even for --batch-check', file: G, find: 'parse_next(&process.buffer.borrow(), reader.check)', replace: 'parse_next(&process.buffer.borrow(), { let _ = reader.check; false })', named: /GIT_REPLACE_REF_BASE|M2|persistent reader/ },
  { name: 'P10 a gitlink answered in-process (the installed Git\'s answer not asked, S4)', file: O, find: '                        ask_gitlinks: true,', replace: '                        ask_gitlinks: false,', named: /persistent reader|gitlink/ },
  { name: 'P11 a closing reader fails only the head request', file: G, find: '    let pending: Vec<Rc<Request>> = reader.pending.borrow_mut().drain(..).collect();', replace: '    let pending: Vec<Rc<Request>> = reader.pending.borrow_mut().pop_front().into_iter().collect();', named: /persistent reader|hangs|FIFO/ },
  { name: 'P12 a hand-back whose Git died is an absent object (a dead Git read as missing)', file: G, find: '    for resolvers in waiting {\n        resolvers.fulfill(Answered::Close(None));\n    }', replace: '    for resolvers in waiting {\n        resolvers.fulfill(Answered::Null);\n    }', named: /persistent reader/ },
  { name: 'P13 the store settles before update-ref answers', file: S, find: '            let tree = inner.tree.borrow().clone();\n            let old = tree\n                .clone()\n                .unwrap_or_else(|| js(&"0".repeat(inner.oid_length)));', replace: '            let tree = inner.tree.borrow().clone();\n            let old = tree\n                .clone()\n                .unwrap_or_else(|| js(&"0".repeat(inner.oid_length)));\n            store.settle(next.clone());', named: /guards|scripts|S5/ },
  { name: 'P14 the guard\'s rollback without compare-and-swap', file: S, find: '                        js("update-ref"),\n                        inner.ref_.clone(),\n                        tree.clone(),\n                        next.clone(),\n                    ],', replace: '                        js("update-ref"),\n                        inner.ref_.clone(),\n                        tree.clone(),\n                    ],', named: /guards/ },
  { name: 'P15 a failed rollback reported without committed: true', file: S, find: '                    error.set_field("committed", W::Bool(true));', replace: '                    error.set_field("committed", W::Bool(false));', named: /guards/ },
  { name: 'P16 the compare-and-swap without its old value', file: S, find: '                    &[js("update-ref"), inner.ref_.clone(), next.clone(), old],', replace: '                    &[js("update-ref"), inner.ref_.clone(), next.clone()],', named: /named scenarios/ },
  { name: 'P17 objects not synced before a direct-tree commit', file: S, find: '        (inner.sync_objects)(&inner.cwd).await?;\n            if store.direct_trees() {', replace: '        if !store.direct_trees() { (inner.sync_objects)(&inner.cwd).await?; }\n            if store.direct_trees() {', named: /guards|sync/ },
  { name: 'P18 the object sync after the direct commit\'s publication', file: S, find: '        (inner.sync_objects)(&inner.cwd).await?;\n            if store.direct_trees() {\n                return Ok(Resolution::Promise(store.commit_direct(&ctx, guard)));\n            }', replace: '        if store.direct_trees() {\n                store.commit_direct(&ctx, guard).await?;\n                (inner.sync_objects)(&inner.cwd).await?;\n                return Ok(Resolution::Value(W::Undefined));\n            }\n            (inner.sync_objects)(&inner.cwd).await?;', named: /guards|sync|system calls/ },
  { name: 'P19 a failed sync swallowed by commit', file: S, find: '        (inner.sync_objects)(&inner.cwd).await?;\n            if store.direct_trees() {', replace: '        let _ = (inner.sync_objects)(&inner.cwd).await;\n            if store.direct_trees() {', named: /guards|sync/ },
  { name: 'P20 a failed directory sync not marked pending again', file: D, find: '            if outcome.is_err() {\n                mark_object_directory_pending(&directory);\n            }', replace: '            if outcome.is_err() {\n                let _ = &directory;\n            }', named: /failed sync leaves the directory pending|waits for the sync/ },
  { name: 'P21 an in-flight sync not waited for', file: D, find: '            if let Some(current) = current {\n                let _ = current.catch(|_| Ok(Resolution::Value(W::Undefined))).await;\n                continue;\n            }', replace: '            if let Some(current) = current {\n                let _ = current;\n            }', named: /waits for the sync in flight/ },
  { name: 'P22 the directory opened and closed but never synced', file: D, find: '                    let body = handle.sync().await;', replace: '                    let body: Result<(), W> = Ok(());', named: /one sync per commit|system calls/ },
  { name: 'P23 the sync of <root> instead of <root>/objects', file: D, find: '    let directory = odb::join(&[root, "objects"]);', replace: '    let directory = odb::join(&[root]);', named: /one sync per commit|system calls|sync/ },
  { name: 'P24 a close failure after a failed sync hides the sync error (the sync\'s error first)', file: D, find: '                    closed?;\n                    body?;', replace: '                    body?;\n                    closed?;', named: /both fail/ },
  { name: 'P25 the kept index record removed only after the commit', file: S, find: '            if kept {\n                nfs::rm(\n                    &record,', replace: '            if kept && false {\n                nfs::rm(\n                    &record,', named: /guards|kept index|scripts/ },
  { name: 'P26 the kept index record written before the ref moves', file: S, find: '            let next = trim(&JsStr::from_utf8_lossy(&bytes_of(&written)));\n            self.publish(ctx, next.clone(), guard.clone()).await?;', replace: '            let next = trim(&JsStr::from_utf8_lossy(&bytes_of(&written)));\n            if kept { let _ = nfs::write_file(&record, &Data::Text(next.clone()), WriteOptions { mode: 0o600, flag: Flags::Str("w") }).await; }\n            self.publish(ctx, next.clone(), guard.clone()).await?;', named: /guards|scripts/ },
  { name: 'P27 the temporary index left behind', file: S, find: '        if !kept {\n            nfs::rm(\n                &index,', replace: '        if !kept && false {\n            nfs::rm(\n                &index,', named: /named scenarios|scripts/ },
  { name: 'P28 the staged blob directory left behind', file: S, find: '            nfs::rm(\n                &staged,\n                RmOptions {\n                    recursive: true,', replace: '            nfs::rm(\n                &format!("{staged}.never"),\n                RmOptions {\n                    recursive: true,', named: /named scenarios|scripts|128 at a time/ },
  { name: 'P29 a removal written as a blob row', file: S, find: '                                js("0 ").units(),', replace: '                                js("100644 ").units(),', named: /named scenarios|scripts/ },
  { name: 'P30 hash-object batches of 129', file: S, find: '                            if batch.len() == 128 {', replace: '                            if batch.len() == 129 {', named: /128 at a time/ },
  { name: 'P31 the direct commit keeps the kept index\'s record', file: S, find: '            if inner.persistent_index && inner.ref_ == js(STATE_REF) {\n                let record = odb::join(&[', replace: '            if inner.persistent_index && inner.ref_ == js(STATE_REF) && false {\n                let record = odb::join(&[', named: /kept index/ },
  { name: 'P32 a blob may replace a directory', file: S, find: '                if existing\n                    .as_ref()\n                    .is_some_and(|entry| entry.mode == js(TREE_MODE))\n                {\n                    return Err(invalid());\n                }', replace: '', named: /refusals|commitTreeChanges/ },
  { name: 'P33 an emptied root returns no tree', file: S, find: '        if entries.borrow().len() == 0 && !is_root {', replace: '        if entries.borrow().len() == 0 && { let _ = is_root; true } {', named: /emptied root|scripts|named|commitTreeChanges/ },
  { name: 'P34 an imported or listed object recorded with mode 100755', file: S, find: '                        .set(name.clone(), TreeEntry::new(BLOB_MODE, name.clone(), oid)),', replace: '                        .set(name.clone(), TreeEntry::new("100755", name.clone(), oid)),', named: /named scenarios|scripts/ },
  { name: 'P35 a directory over an existing file kept', file: S, find: '                    if existing\n                        .as_ref()\n                        .is_some_and(|entry| entry.mode != js(TREE_MODE))\n                    {\n                        return Err(invalid());\n                    }', replace: '', named: /refusals|commitTreeChanges/ },
  { name: 'P36 the whole listing sorted in reverse', file: S, find: '                        rows.sort_by(|a, b| row_key(a).units().cmp(row_key(b).units()));', replace: '                        rows.sort_by(|a, b| row_key(b).units().cmp(row_key(a).units()));', named: /named scenarios|scripts/ },
  { name: 'P37 a paged Git listing without --literal-pathspecs', file: S, find: '                &[\n                    js("--literal-pathspecs"),\n                    js("ls-tree"),\n                    js("-r"),\n                    js("-l"),', replace: '                &[\n                    js("ls-tree"),\n                    js("-r"),\n                    js("-l"),', named: /named scenarios|lost and corrupt|paged/ },
  { name: 'P38 get of a staged object id reads the tree\'s value', file: S, find: '                let object = staged_oid(staged.as_ref())\n                    .unwrap_or_else(|| concat(&[tree.units(), &[u16::from(b\':\')], key.units()]));', replace: '                let object = concat(&[tree.units(), &[u16::from(b\':\')], key.units()]);', named: /named scenarios|scripts/ },
  { name: 'P39 values read in batches of 257', file: S, find: '                    if batch.borrow().len() >= 256 {', replace: '                    if batch.borrow().len() >= 257 {', named: /256 at a time/ },
  { name: 'P40 a record over 512 KiB accepted', file: S, find: '        if byte_length(&data) > 512 * 1024 {\n            return Err(change_error("change_record_too_large", 503.0));\n        }\n        let unchanged', replace: '        let unchanged', named: /refusals/ },
  { name: 'P41 setListObjects takes capital hex ids', file: S, find: '                matches!(oid, W::String(text) if keys::valid_list_object(text.units(), inner.oid_length))', replace: '                matches!(oid, W::String(text) if text.len() == inner.oid_length)', named: /refusals|named/ },
  { name: 'P42 writeList writes its pages as tree objects', file: S, find: '                let written = odb::write_loose_object(\n                    &objects_dir,\n                    "blob",', replace: '                let written = odb::write_loose_object(\n                    &objects_dir,\n                    "tree",', named: /named scenarios|scripts/ },
  { name: 'P43 a successful stage discards its writes', file: S, find: '            if outcome.is_err() {\n                let mut pending = inner.pending.borrow_mut();', replace: '            if outcome.is_err() || true {\n                let mut pending = inner.pending.borrow_mut();', named: /named scenarios|scripts/ },
  { name: 'P44 a commit with nothing staged still runs', file: S, find: '            if inner.pending.borrow().len() == 0 {\n                return Ok(Resolution::Value(W::Undefined));\n            }\n            (inner.sync_objects)', replace: '            (inner.sync_objects)', named: /named scenarios|scripts/ },
  { name: 'P45 a submodule row listed with size 0 instead of `-`', file: S, find: '                W::string("-")\n', replace: '                W::Number(0.0)\n', named: /gitlink|lost and corrupt/ },
  { name: 'P46 the loose ref shortcut takes a directory as absent (EISDIR)', file: S, find: '                            if ["ENOENT", "ENOTDIR"].contains(&code_of(&cause).as_str()) {', replace: '                            if ["ENOENT", "ENOTDIR", "EISDIR"].contains(&code_of(&cause).as_str()) {', named: /open: refusals/ },
  { name: 'P47 a hand-back started with an empty environment', file: G, find: '    let env = git_environment(&process_env(), &[]);\n    if let Some(refused)', replace: '    let env = git_environment(&[(String::from("PATH"), std::env::var("PATH").unwrap_or_default())], &[]);\n    if let Some(refused)', named: /GIT_REPLACE_REF_BASE|256 at a time/ },
  // --- fix round 1: each fix, undone ---
  { name: 'F01 S1: the watchdog never fires (its deadline a thousand times later)', file: G, find: '            && host::now() - started > READER_TIMEOUT_MS', replace: '            && host::now() - started > READER_TIMEOUT_MS * 1000.0', named: /hangs|FIFO|blocked_reads/ },
  { name: 'F02 S1: a closed reader leaves its hand-back running', file: G, find: '        let _ = process.child.kill(Signal::Kill);\n    }\n    if let Some(database)', replace: '        let _ = &process.child;\n    }\n    if let Some(database)', named: /reader's life|hangs/ },
  { name: 'F03 S1: the database opens a FIFO blocking (no O_NONBLOCK)', file: I, find: '        .custom_flags(libc::O_NONBLOCK)\n', replace: '', named: /reader's life|FIFO/ },
  { name: 'F04 S1/S5: an idle reader never closes', file: G, find: '                    && reader.pending.borrow().is_empty()\n                {\n                    close_reader(&reader, None);', replace: '                    && reader.pending.borrow().is_empty() && false\n                {\n                    close_reader(&reader, None);', named: /reader's life|S5|an_idle_reader/ },
  { name: 'F05 S2: no NUL check before the spawn (the old assert)', file: C, find: '    if let Some(refused) = refused_arguments(&options) {\n        return Err(refused);\n    }', replace: '    assert!(refused_arguments(&options).is_none(), "a NUL byte in a spawn argument");', named: /random bytes|NUL/, differentials: DIFFERENTIALS },
  { name: 'F06 S2: inspect splits past 124 characters', file: F, find: '    if length > 80 - 4 {', replace: '    if length > 128 - 4 {', named: /random bytes|NUL in a 77/, differentials: DIFFERENTIALS },
  { name: 'F07 S3: GIT_REPLACE_REF_BASE not seen by the reader', file: G, find: '    let ask_all = env.iter().any(|(name, _)| name == "GIT_REPLACE_REF_BASE");', replace: '    let ask_all = env.is_empty();', named: /GIT_REPLACE_REF_BASE|256 at a time/ },
  { name: 'F08 S5: a vanished pack dropped at the next listing', file: P, find: '        if old.index_open.load(Ordering::SeqCst) {\n            packs.push(Arc::clone(old));\n        }', replace: '        let _ = old;', named: /S5/ },
  { name: 'F09 S6: one job more per tree read (the readTree arrow awaits twice)', file: S, find: '            let found = Promise::resolve(read_object(&W::String(oid))?).await?;', replace: '            let found = Promise::resolve(read_object(&W::String(oid))?).await?;\n            js::value::<W, W>(W::Undefined).await?;', extra: { file: S, find: 'use crate::js::{Promise, Resolution, async_fn};', replace: 'use crate::js::{self, Promise, Resolution, async_fn};' }, named: /named programs|commitTreeChanges/, differentials: ['scripts/ledger-native/child-differential.mjs'] },
  { name: 'F10 M1: records() reads the tree at its first next', file: S, find: '        let snapshot = snapshot.or_else(|| self.inner().tree.borrow().clone());', replace: '        let given = snapshot;', extra: { file: S, find: '            let Some(snapshot) = snapshot.filter(|text| !text.is_empty()) else {', replace: '            let snapshot = given.or_else(|| inner.tree.borrow().clone());\n            let Some(snapshot) = snapshot.filter(|text| !text.is_empty()) else {' }, named: /M1/ },
  { name: 'F11 M2: paged listings left to ls-tree whenever the database would ask Git', file: S, find: '            if !simple {\n                return Ok(Resolution::Value(W::Null));', replace: '            if !simple || store.inner().args.is_empty() || true {\n                return Ok(Resolution::Value(W::Null));', named: /M2|paged/ },
  { name: 'F12 M4: the store probe prints through the line codec (own __proto__ dropped)', file: B, find: 'ledger_native::store_program::serve(lines, print_json, |line| decode_line(line).ok());', replace: 'ledger_native::store_program::serve(lines, print, |line| decode_line(line).ok());', named: /scripts|named/ },
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
    for (const edit of [bug, ...(bug.extra ? [bug.extra] : [])]) {
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
  // `--dry`: every plant's text occurs exactly once in the worktree; nothing built or run.
  if (argv.includes('--dry')) {
    const native = path.join(root, 'packages/harness-runtime/native/ledger');
    const wrong = [];
    for (const bug of bugs) for (const edit of [bug, ...(bug.extra ? [bug.extra] : [])]) {
      const count = readFileSync(path.join(native, edit.file), 'utf8').split(edit.find).length - 1;
      if (count !== 1) wrong.push(`${bug.name}: ${count} in ${edit.file}`);
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
    const unit = () => run(copy.cargo, ['test', '--locked', '--offline', '--package', 'ledger-native', '--lib', 'git::'], { cwd: copy.workspace, env: copy.env, timeout: 600_000, killSignal: 'SIGKILL' });
    const differential = (files = DIFFERENTIALS) => run(process.execPath, ['--import=./scripts/test-isolation-preload.mjs', '--test', ...files],
      { cwd: root, env: { ...process.env, [LEDGER_PROBE_VARIABLE]: probe, LEDGER_NATIVE_ODB_EXTENDED: '' }, timeout: 1_200_000, killSignal: 'SIGKILL' });
    if (!build().ok) throw new Error('the unchanged probe does not build');
    if (!unit().ok) throw new Error('the unchanged cargo tests fail');
    const baseline = differential();
    if (!baseline.ok) throw new Error(`the unchanged differentials fail: ${failures(baseline.output).join('; ')}`);
    for (const bug of bugs) {
      const row = withBug(copy, bug, build, () => {
        const started = Date.now(), u = unit(), d = differential(bug.differentials ?? (bug.name.startsWith('R') ? DIFFERENTIALS : DIFFERENTIALS.slice(0, 1)));
        const failing = [...failures(u.output), ...failures(d.output)];
        const named = failing.filter((name) => bug.named.test(name));
        return { name: bug.name, caught: !u.ok || !d.ok, byNamed: named.length > 0, seconds: Math.round((Date.now() - started) / 1000), by: (named.length ? named : failing).slice(0, 3).join('; ').slice(0, 300) };
      });
      rows.push(row);
      console.log(`${row.byNamed ? 'caught  ' : row.caught ? 'OTHER   ' : 'SURVIVED'} ${row.name} (${row.seconds} s)${row.by ? `: ${row.by}` : ''}`);
    }
    failed = false;
    console.log(JSON.stringify({ planted: rows.length, caughtByNamed: rows.filter((row) => row.byNamed).length, caught: rows.filter((row) => row.caught).length, survived: rows.filter((row) => !row.caught).map((row) => row.name) }));
    return rows.every((row) => row.byNamed || BUGS.find((bug) => bug.name === row.name)?.equivalent) ? 0 : 1;
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
