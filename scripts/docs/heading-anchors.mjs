// Docs drift check `anchor`: `file.md#anchor` and in-page `#anchor` links must
// name a heading (or an explicit `id`/`name` attribute) of the target document.
// Headings are ATX (`## Title`) or setext (a paragraph over `===`/`---`); the
// slug is taken from the rendered heading text (code spans verbatim, emphasis
// markers, tags and link syntax removed). Slugs follow GitHub's rules
// (github-slugger): lower-case, drop everything but letters, marks, numbers,
// `_`, `-` and spaces, turn spaces into `-`, and number repeated slugs `-1`,
// `-2`, ... in document order.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { documentReferences, withoutCodeBlocks } from './repository-links.mjs';

export function githubSlug(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
}

// Pairs of `*`/`_` runs around non-space text, as GitHub renders emphasis. An
// underscore run only delimits at a word edge, so `snake_case` keeps its `_`
// and an unpaired `_` (as in `DEVRYAN_*`) stays literal.
const EMPHASIS = [
  /(?<![\p{L}\p{N}])(_{1,3})(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}])/u,
  /(\*{1,3})(?=\S)([\s\S]*?\S)\1/u,
];

function renderInline(raw) {
  let text = raw.replace(/<[^>]+>/g, '');
  for (const pattern of EMPHASIS) {
    for (let previous = null; previous !== text;) { previous = text; text = text.replace(pattern, '$2'); }
  }
  return text;
}

/**
 * Rendered text of an inline-markdown heading. Links and images reduce to their
 * label first (a label may hold code); then code spans keep their text verbatim
 * (`` `<name>` `` stays `<name>`), and outside them tags are dropped and
 * emphasis markers removed.
 */
export function headingText(raw) {
  let rendered = '';
  let rest = raw.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  for (let span; (span = /(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest));) {
    rendered += renderInline(rest.slice(0, span.index)) + span[2].replace(/^ (.*) $/, '$1');
    rest = rest.slice(span.index + span[0].length);
  }
  return (rendered + renderInline(rest)).trim();
}

const ATX = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
// Lines that end a setext heading's paragraph (blank, list item, quote), and
// lines that cannot start one (indented code, HTML, table row).
const ENDS_PARAGRAPH = /^(?:\s*$| {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>))/;
const NO_PARAGRAPH_START = /^(?: {4,}| {0,3}[<|])/;

/** Heading texts in document order: ATX (`## Title`) and setext (a paragraph over `===` or `---`). */
export function headingTexts(source) {
  const lines = withoutCodeBlocks(source).split('\n');
  // Frontmatter is not content: blank it so its closing `---` is not an underline.
  if (/^---[ \t]*$/.test(lines[0] ?? '')) {
    const close = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line));
    if (close > 0) lines.fill('', 0, close + 1);
  }
  const headings = [];
  let paragraph = [];
  for (const line of lines) {
    const atx = ATX.exec(line);
    if (atx) { headings.push(atx[1]); paragraph = []; continue; }
    if (paragraph.length && SETEXT_UNDERLINE.test(line)) { headings.push(paragraph.join('\n')); paragraph = []; continue; }
    if (ENDS_PARAGRAPH.test(line) || (!paragraph.length && NO_PARAGRAPH_START.test(line))) { paragraph = []; continue; }
    paragraph.push(line.trim());
  }
  return headings;
}

export function headingAnchors(source) {
  const anchors = new Set();
  const counts = new Map();
  for (const heading of headingTexts(source)) {
    const base = githubSlug(headingText(heading));
    let slug = base;
    let count = counts.get(base) ?? 0;
    while (anchors.has(slug)) slug = `${base}-${++count}`;
    counts.set(base, count);
    anchors.add(slug);
  }
  for (const match of withoutCodeBlocks(source).matchAll(/<[a-z][\w-]*\s[^>]*\b(?:id|name)=["']([^"']+)["']/gi)) anchors.add(match[1]);
  return anchors;
}

/** Violations `{ check: 'anchor', doc, token }`, `token` being the link target as written. */
export function validateHeadingAnchors(root, files) {
  const violations = [];
  const cache = new Map();
  const anchorsOf = (file) => {
    if (!cache.has(file)) cache.set(file, headingAnchors(readFileSync(file, 'utf8')));
    return cache.get(file);
  };
  for (const doc of files) {
    const source = readFileSync(path.join(root, doc), 'utf8');
    for (const { target, kind } of documentReferences(source)) {
      if (kind !== 'link' || !target.includes('#')) continue;
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
      const [rawPath, ...rest] = target.split('#');
      const rawFragment = rest.join('#');
      if (!rawFragment) continue;
      let local, fragment;
      try { local = decodeURIComponent(rawPath.split('?')[0]); fragment = decodeURIComponent(rawFragment); }
      catch { continue; } // repository-links reports malformed encoding
      // Site routes (`/page/#x`) in the docs site are resolved by the site, not here.
      if (local.startsWith('/') && doc.startsWith('packages/docs/content/')) continue;
      const resolved = !local ? path.join(root, doc)
        : path.resolve(root, local.startsWith('/') ? local.slice(1) : path.join(path.dirname(doc), local));
      // Missing targets are repository-links' finding; only Markdown targets have headings.
      if (!/\.mdx?$/i.test(resolved) || !existsSync(resolved)) continue;
      if (!anchorsOf(resolved).has(fragment)) violations.push({ check: 'anchor', doc, token: target });
    }
  }
  return violations;
}
