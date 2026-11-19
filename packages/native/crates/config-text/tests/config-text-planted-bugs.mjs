#!/usr/bin/env node
// Planted bugs: each entry changes one thing in the crate's Rust, and the
// tracked vectors must catch it (cargo test of the vector suite fails). The
// run copies the crate into a private scratch folder under the OS temp dir
// (removed on success, failure and interruption; --keep-artifacts keeps it),
// plants one bug at a time and runs the vectors there with the pinned
// toolchain (cargo on PATH, as scripts/check-native.mjs sets it up).
//
//   node config-text-planted-bugs.mjs [--only <id>,...] [--keep-artifacts]
//
// Exit code 1 when a planted bug survives or a planting site no longer exists.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRunRoot, scratchParent } from '../../../../../scripts/qa/run-root.mjs';
import { REPOSITORY_ROOT } from './config-text-format.mjs';

/** One bug each: [id, file under src, exact text, replacement, what it breaks]. */
export const PLANTED_BUGS = Object.freeze([
  ['jsonc-unclosed-comment-length', 'jsonc/scanner.rs', '                        self.pos += 1;\n                        self.error = ScanError::UnexpectedEndOfComment;', '                        self.error = ScanError::UnexpectedEndOfComment;', 'an unclosed block comment one unit short'],
  ['jsonc-trailing-comma-refused', 'jsonc/mod.rs', 'parser::parse(text, &mut graph, true)?', 'parser::parse(text, &mut graph, false)?', 'parse without allowTrailingComma'],
  ['jsonc-proto-as-key', 'value.rs', 'let proto_setter = key == js::units("__proto__") &&', 'let proto_setter = key == js::units("__proto_x") &&', '`__proto__` defines a property instead of the prototype'],
  ['jsonc-proto-null-chain', 'value.rs', '                        Proto::Null => return false,', '                        Proto::Null => return true,', '`__proto__` set as the prototype under a null prototype (found by the differential run)'],
  ['jsonc-indent-cache-fixed', 'jsonc/format.rs', 'if amount == MAX_CACHED as i64 {', 'if amount == -1 {', 'the 200-space cache miss no longer throws'],
  ['jsonc-eol-from-option', 'jsonc/format.rs', 'let eol = get_eol(document, eol_option);', 'let eol = get_eol(&[], eol_option);', "the document's own line break ignored"],
  ['jsonc-format-end-blanks', 'jsonc/format.rs', '        if second_token == Kind::Eof {\n            replace = Some(Vec::new());', '        if second_token == Kind::Eof && false {\n            replace = Some(Vec::new());', 'blanks before the end of the formatted line kept or replaced'],
  ['jsonc-first-removal-comma', 'jsonc/edit.rs', 'remove_end = tree.nodes[parent_node.children[1]].offset;', 'remove_end = tree.nodes[parent_node.children[1]].offset - 1;', 'removing the first member leaves a unit'],
  ['jsonc-last-duplicate', 'jsonc/edit.rs', '                    found = Some(children[1]);\n                    break;', '                    found = Some(children[1]);', 'findNodeAtLocation takes the last duplicate'],
  ['jsonc-error-message', 'jsonc/edit.rs', 'Error: Can not add index to parent of type', 'Error: Can not add property to parent of type', "the package's inverted message corrected"],
  ['yaml-flow-colon', 'yaml/lexer.rs', 'if is_empty(next) || (in_flow && is_flow_indicator(next)) {', 'if is_empty(next) {', 'a plain scalar in flow runs through `:,`'],
  ['yaml-escape-next-line', 'yaml/scalars.rs', '0x4e => 0x85,', '0x4e => 0x84,', '`\\N` decodes to the wrong unit'],
  ['yaml-int-sign', 'yaml/scalars.rs', 'CoreTag::Int => digits(strip_sign(b)),', 'CoreTag::Int => digits(b),', '`+12` and `-1` stop being integers'],
  ['yaml-unique-keys-off', 'yaml/compose.rs', 'fn map_includes(ctx: &Ctx, items: &[(usize, Option<usize>)], search: usize) -> bool {\n', 'fn map_includes(ctx: &Ctx, items: &[(usize, Option<usize>)], search: usize) -> bool {\n    if search < usize::MAX {\n        return false;\n    }\n', 'duplicate keys accepted'],
  ['yaml-alias-limit', 'yaml/tojs.rs', 'const MAX_ALIAS_COUNT: f64 = 100.0;', 'const MAX_ALIAS_COUNT: f64 = 1000.0;', 'the alias-count limit raised'],
  ['yaml-context-width', 'yaml/mod.rs', '    if line_str.len() > 80 {', '    if line_str.len() > 81 {', 'error context cut one unit later'],
  ['yaml-keep-chomping', 'yaml/scalars.rs', '        0x2b => {', '        0x2e => {', '`|+` and `>+` clip instead of keep'],
  ['yaml-trailing-indent-bound', 'yaml/scalars.rs', '    while i >= chomp_start as i64 {', '    let bound = chomp_start as i64;\n    while i >= bound {', 'the trailing-line loop keeps its first bound (found by the differential run)'],
  ['yaml-tag-parts', 'yaml/directives.rs', '                    if parts.len() < 2 {', '                    if parts.len() != 2 {', '%TAG with extra parts ignored'],
  ['yaml-quote-core-strings', 'yaml/stringify.rs', 'if ctx.actual_string && CoreTag::TESTED.iter().any(|tag| tag.test(&text)) {', 'if ctx.actual_string && CoreTag::TESTED[1..].iter().any(|tag| tag.test(&text)) {', '"null" and "~" written unquoted'],
  ['yaml-line-width', 'yaml/stringify.rs', 'const LINE_WIDTH: i64 = 80;', 'const LINE_WIDTH: i64 = 100;', 'folding at 100 columns'],
  ['yaml-quote-both', 'yaml/stringify.rs', 'if has_double && !has_single {', 'if has_double {', "a string holding both quote kinds written single-quoted (found by review)"],
  ['yaml-fold-early', 'yaml/stringify.rs', 'let mut end = line_width - indent_len;', 'let mut end = line_width - indent_len - 1;', 'folding one column early (found by review)'],
  ['yaml-min-content-width', 'yaml/stringify.rs', 'const MIN_CONTENT_WIDTH: i64 = 20;', 'const MIN_CONTENT_WIDTH: i64 = 19;', 'the fold step past column 60 one unit short (found by review)'],
  ['yaml-long-key-start', 'yaml/stringify.rs', 'if indent_at_start > line_width - 2i64.max(min_content_width) {', 'if indent_at_start >= line_width - 2i64.max(min_content_width) {', 'a value after a 58-unit key moved to the next line'],
  ['yaml-fold-after-tab', 'yaml/stringify.rs', 'if ch == 0x20 && prev.is_some_and(|p| p != 0x20 && p != 0x0a && p != 0x09) {', 'if ch == 0x20 && prev.is_some_and(|p| p != 0x20 && p != 0x0a) {', 'a fold point after a tab'],
  ['yaml-escape-fold-point', 'yaml/stringify.rs', 'let j = if i > esc_end + 1 { i - 2 } else { esc_start - 1 };', 'let j = if i > esc_end { i - 2 } else { esc_start - 1 };', 'a double-quoted line folded inside the unit after an escape'],
  ['yaml-single-break-blank', 'yaml/stringify.rs', '.any(|pair| (is_ws(pair[0]) && pair[1] == 0x0a) || (pair[0] == 0x0a && is_ws(pair[1])));', '.any(|pair| is_ws(pair[0]) && pair[1] == 0x0a);', 'single quotes kept for a line break followed by a blank'],
  ['yaml-anchor-names', 'yaml/stringify.rs', 'format!("a{}", self.next_anchor)', 'format!("b{}", self.next_anchor)', 'anchors named b1, b2'],
  ['js-exponent-layout', 'js.rs', 'if k <= n && n <= 21 {', 'if k <= n && n <= 20 {', '1e20 written in exponent form'],
  ['js-trim-bom', 'js.rs', '0x3000 | 0xfeff', '0x3000', 'trim keeps a byte-order mark'],
  ['front-crlf-opening', 'front_matter.rs', '(Some(0x0d), Some(0x0a)) => Some(5),', '(Some(0x0d), Some(0x0a)) => None,', 'a CRLF opening line no longer matches'],
]);

const crate = path.join(REPOSITORY_ROOT, 'packages', 'native', 'crates', 'config-text');

/** Each planting site must exist exactly once (a Rust-free check the contract runs too). */
export function plantingProblems(read = (file) => readFileSync(path.join(crate, 'src', file), 'utf8')) {
  const problems = [];
  for (const [id, file, find] of PLANTED_BUGS) {
    const text = read(file);
    const count = text.split(find).length - 1;
    if (count !== 1) problems.push(`${id}: ${file} holds the planting site ${count} times`);
  }
  return problems;
}

function main() {
  const argv = process.argv.slice(2);
  const onlyAt = argv.indexOf('--only');
  const only = onlyAt >= 0 ? new Set(argv[onlyAt + 1].split(',')) : null;
  const problems = plantingProblems();
  if (problems.length) throw new Error(problems.join('\n'));
  const run = createRunRoot({ parent: scratchParent('qa'), prefix: 'config-text-planted-', owner: 'config-text-planted-bugs' });
  let status = 'failed';
  try {
    const workspace = path.join(run.dir, 'native');
    mkdirSync(path.join(workspace, 'crates'), { recursive: true });
    const native = path.join(REPOSITORY_ROOT, 'packages', 'native');
    for (const file of ['Cargo.lock', 'rust-toolchain.toml']) cpSync(path.join(native, file), path.join(workspace, file));
    const manifest = readFileSync(path.join(native, 'Cargo.toml'), 'utf8').replace(/^members = \[[^\]]*\]/m, 'members = ["crates/config-text"]');
    writeFileSync(path.join(workspace, 'Cargo.toml'), manifest);
    const copy = path.join(workspace, 'crates', 'config-text');
    cpSync(crate, copy, { recursive: true });
    const cargo = (args) => spawnSync('cargo', args, { cwd: workspace, encoding: 'utf8', env: { ...process.env, CARGO_TARGET_DIR: path.join(run.dir, 'target') } });
    const baseline = cargo(['test', '--offline', '--quiet', '--test', 'config_vectors']);
    if (baseline.status !== 0) throw new Error(`the unmodified copy fails its vectors:\n${baseline.stdout}\n${baseline.stderr}`);
    const survivors = [];
    for (const [id, file, find, replacement, effect] of PLANTED_BUGS) {
      if (only && !only.has(id)) continue;
      const target = path.join(copy, 'src', file);
      const original = readFileSync(target, 'utf8');
      writeFileSync(target, original.replace(find, replacement));
      const result = cargo(['test', '--offline', '--quiet', '--test', 'config_vectors']);
      writeFileSync(target, original);
      const output = `${result.stdout}${result.stderr}`;
      if (/error\[E\d+\]|could not compile/.test(output)) throw new Error(`${id}: the planted copy does not build:\n${output.slice(0, 2000)}`);
      // A differing row or a panic both fail the vector suite.
      const failed = result.status !== 0 && /test result: FAILED/.test(output);
      const caught = [...output.matchAll(/^---- (\S+) stdout ----$/gm)].map((match) => match[1]);
      console.log(`${failed ? 'caught  ' : 'SURVIVED'} ${id} (${effect})${caught.length ? `: ${caught.join(', ')}` : ''}`);
      if (!failed) survivors.push(id);
    }
    if (survivors.length) throw new Error(`planted bugs the vectors miss: ${survivors.join(', ')}`);
    console.log(`Every planted bug is caught (${only ? only.size : PLANTED_BUGS.length}).`);
    status = 'passed';
  } finally {
    run.finish(status);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
