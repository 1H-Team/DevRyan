export type MarkdownStreamBlock = {
  key: string;
  raw: string;
  src: string;
  mode: 'full' | 'live';
};

export const buildMarkdownRenderBlockKey = (baseKey: string, index: number): string => {
  return `${baseKey}:block:${index}`;
};

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM_PATTERN = /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/;
// Reference/footnote definitions resolve across the whole document and raw
// HTML blocks may span blank lines, so either (outside code) keeps the text
// in one block.
const SINGLE_BLOCK_LINE_PATTERN = /^ {0,3}(?:\[[^\]\n]+\]:|<)/;

const countDisplayMathFences = (line: string): number => {
  let count = 0;
  let index = line.indexOf('$$');
  while (index !== -1) {
    count += 1;
    index = line.indexOf('$$', index + 2);
  }
  return count;
};

/**
 * Splits Markdown into top-level sections at blank lines that CommonMark also
 * treats as block boundaries: outside fenced code and `$$` math, before an
 * unindented line, and never between items of one (loose) list. Every section
 * keeps its trailing blank lines, so the sections concatenate to `text`.
 */
export const splitMarkdownSections = (text: string): string[] => {
  const sections: string[] = [];
  let sectionStart = 0;
  let sectionHasContent = false;
  let sectionHasListItem = false;
  let fence: { char: string; length: number } | null = null;
  let inMath = false;
  let sawBlankLine = false;
  let lineStart = 0;

  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const nextLineStart = newline === -1 ? text.length : newline + 1;

    if (fence) {
      const match = FENCE_PATTERN.exec(line);
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && line.slice(match[0].length).trim() === '') {
        fence = null;
      }
      lineStart = nextLineStart;
      continue;
    }

    if (line.trim() === '') {
      if (!inMath) sawBlankLine = true;
      lineStart = nextLineStart;
      continue;
    }

    if (!inMath && SINGLE_BLOCK_LINE_PATTERN.test(line)) {
      return [text];
    }

    const isListItem = LIST_ITEM_PATTERN.test(line);
    if (
      sawBlankLine
      && sectionHasContent
      && !inMath
      && line[0] !== ' '
      && line[0] !== '\t'
      && !(isListItem && sectionHasListItem)
    ) {
      sections.push(text.slice(sectionStart, lineStart));
      sectionStart = lineStart;
      sectionHasListItem = false;
    }
    sawBlankLine = false;
    sectionHasContent = true;
    if (isListItem) sectionHasListItem = true;

    const fenceMatch = FENCE_PATTERN.exec(line);
    // A backtick fence's info string cannot contain a backtick (```x``` is inline code).
    const isFence = fenceMatch !== null
      && !(fenceMatch[1][0] === '`' && line.slice(fenceMatch[0].length).includes('`'));
    if (isFence && fenceMatch && !inMath) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
    } else if (countDisplayMathFences(line) % 2 === 1) {
      inMath = !inMath;
    }

    lineStart = nextLineStart;
  }

  sections.push(text.slice(sectionStart));
  return sections;
};

export const streamMarkdownBlocks = (
  text: string,
  live: boolean,
  baseKey: string,
): MarkdownStreamBlock[] => {
  // Keys are positional, never derived from mode or content: a section keeps
  // its rendered subtree while it grows and when the response becomes
  // terminal. Re-keying remounted every code block, list, and paragraph at
  // completion, briefly changing the measured transcript height and making
  // pinned output appear to jump. Only the section whose source changed
  // re-parses, so streaming cost tracks the tail rather than the message.
  const sections = splitMarkdownSections(text);
  const mode = live ? 'live' : 'full';
  return sections.map((src, index) => ({
    key: buildMarkdownRenderBlockKey(baseKey, index),
    raw: src,
    src,
    mode,
  }));
};
