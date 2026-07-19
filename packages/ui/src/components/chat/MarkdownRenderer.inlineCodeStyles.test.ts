import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const styles = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

const getRuleBody = (selector: string): string => {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`));

  expect(match).not.toBeNull();
  return match?.[1] ?? '';
};

describe('MarkdownRenderer inline code wrapping', () => {
  test('prefers normal line breaks and wraps only tokens wider than the container', () => {
    const inlineCodeRule = getRuleBody('.markdown-content code[data-markdown="inline-code"]');

    expect(inlineCodeRule).toContain('word-break: normal;');
    expect(inlineCodeRule).toContain('overflow-wrap: anywhere;');
    expect(inlineCodeRule).not.toContain('word-break: break-all;');
  });

  test('keeps fenced code wrapping behavior unchanged', () => {
    const codeBlockRule = getRuleBody('.markdown-content [data-markdown="code-block-body"] code');

    expect(codeBlockRule).toContain('white-space: pre;');
    expect(codeBlockRule).toContain('overflow-wrap: normal;');
    expect(codeBlockRule).toContain('word-break: normal;');
  });
});
