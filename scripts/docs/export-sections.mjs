// Docs drift check `export`: a heading that ends with a parenthesized source
// file list, such as `## Public exports (env-runtime.js)`,
// `### Cache (`cache.js`)` or `### Shared text (re-exported from ../text/summarization.js)`,
// is an API contract for those files. Every backticked call-shaped name
// (`` `name(` ``) under it, until the next heading, must occur as a word in one
// of the named files. A named file that does not exist is itself a violation
// when the section lists names to check against it.
// Files resolve against the document's directory, then the repository root.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { withoutCodeBlocks } from './repository-links.mjs';

const SOURCE_FILE = /^[\w./-]+\.(?:[cm]?js|jsx|mts|cts|tsx?)$/;

/** File list of a heading's trailing parenthetical, or null when it names no source file. */
export function headingSourceFiles(heading) {
  const group = /\(([^()]*)\)\s*$/.exec(heading);
  if (!group) return null;
  const files = [];
  for (const part of group[1].split(',')) {
    const last = part.trim().split(/\s+/).pop()?.replace(/^`|`$/g, '') ?? '';
    if (SOURCE_FILE.test(last)) files.push(last);
  }
  return files.length ? files : null;
}

/** `{ files, names }` per export section of a document, in order. */
export function exportSections(source) {
  const sections = [];
  let current = null;
  for (const line of withoutCodeBlocks(source).split('\n')) {
    const heading = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*$/.exec(line);
    if (heading) {
      const files = headingSourceFiles(heading[1]);
      current = files ? { files, names: [] } : null;
      if (current) sections.push(current);
      continue;
    }
    if (!current) continue;
    for (const match of line.matchAll(/`([A-Za-z_$][\w$]*)\(/g)) {
      if (!current.names.includes(match[1])) current.names.push(match[1]);
    }
  }
  return sections;
}

const escapeRegExp = (value) => value.replace(/[$^.*+?()[\]{}|\\]/g, '\\$&');

/** Violations `{ check: 'export', doc, token }`, `token` being `<file as written>: <name>`. */
export function validateExportSections(root, files) {
  const violations = [];
  const sources = new Map();
  for (const doc of files) {
    const sections = exportSections(readFileSync(path.join(root, doc), 'utf8'));
    for (const section of sections) {
      if (!section.names.length) continue;
      const texts = [];
      for (const file of section.files) {
        const resolved = [path.resolve(root, path.dirname(doc), file), path.resolve(root, file)].find((candidate) => existsSync(candidate));
        if (!resolved) {
          violations.push({ check: 'export', doc, token: `${file}: (missing file)` });
          continue;
        }
        if (!sources.has(resolved)) sources.set(resolved, readFileSync(resolved, 'utf8'));
        texts.push(sources.get(resolved));
      }
      if (!texts.length) continue;
      for (const name of section.names) {
        const word = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
        if (!texts.some((text) => word.test(text))) violations.push({ check: 'export', doc, token: `${section.files.join(', ')}: ${name}` });
      }
    }
  }
  return violations;
}
