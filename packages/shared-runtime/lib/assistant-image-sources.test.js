import { describe, expect, test } from 'bun:test';

import { assistantImageSyntaxFixtures } from '../testing/assistant-image-fixtures.js';
import {
  canonicalizeAssistantImageSource,
  extractAssistantImageReferences,
  isSupportedAssistantImageSource,
  stripAssistantImageMarkdown,
} from './assistant-image-sources.js';

describe('assistant image Markdown sources', () => {
  for (const fixture of assistantImageSyntaxFixtures) {
    test(fixture.name, () => {
      expect(extractAssistantImageReferences(fixture.markdown).map(({ start: _start, end: _end, ...entry }) => entry))
        .toEqual(fixture.expected);
    });
  }

  test('removes image loading syntax without erasing surrounding prose or code', () => {
    expect(stripAssistantImageMarkdown('See ![the chart](chart.png). `![code](code.png)`'))
      .toBe('See the chart. `![code](code.png)`');
  });

  for (const [name, markdown] of [
    ['punctuation', 'Plain prose! (parentheses), {braces}, <angles>, closing ] and \\ escapes.'],
    ['Unicode', 'مرحبا بالعالم — 中文 ［全角括号］ — α β γ 🙂'],
    ['inline code', 'The output is `chart.png` and `const value = (1 + 2);`.'],
    ['fenced code', '```js\nconst image = "chart.png";\n```\n~~~text\nphoto.webp\n~~~'],
    ['bare paths and URLs', '/tmp/chart.png file:///tmp/photo.jpg https://cdn.example/image.webp data:image/png;base64,aGVsbG8='],
    ['HTML images', '<img src="chart.png" alt="Chart"> <a href="photo.jpg">Photo</a>'],
  ]) {
    test(`leaves ${name} without Markdown image syntax unchanged`, () => {
      expect(extractAssistantImageReferences(markdown)).toEqual([]);
      expect(stripAssistantImageMarkdown(markdown)).toBe(markdown);
    });
  }

  test('preserves empty and non-string input handling', () => {
    for (const value of ['', null, undefined, 42, {}, []]) {
      expect(extractAssistantImageReferences(value)).toEqual([]);
      expect(stripAssistantImageMarkdown(value)).toBe(value);
    }
  });

  test('resolves shortcut reference images and keeps standalone source helpers independent', () => {
    const source = 'file:///tmp/hero%20image.png';
    const markdown = `![Hero]\n\n[Hero]: ${source}`;
    expect(extractAssistantImageReferences(markdown)).toEqual([
      { source: '/tmp/hero image.png', caption: 'Hero', kind: 'reference-image', start: 0, end: 7 },
    ]);
    expect(stripAssistantImageMarkdown(markdown)).toBe(`Hero\n\n[Hero]: ${source}`);
    expect(extractAssistantImageReferences(source)).toEqual([]);
    expect(canonicalizeAssistantImageSource(source)).toBe('/tmp/hero image.png');
    expect(isSupportedAssistantImageSource(source)).toBe(true);
  });

  test('keeps raw-file and remote Markdown destinations supported', () => {
    const markdown = '![Raw](/api/fs/raw?path=%2Ftmp%2Fchart.webp) [Remote](https://cdn.example/photo.jpg#preview)';
    expect(extractAssistantImageReferences(markdown).map(({ source, caption, kind }) => ({ source, caption, kind })))
      .toEqual([
        { source: '/tmp/chart.webp', caption: 'Raw', kind: 'markdown-image' },
        { source: 'https://cdn.example/photo.jpg', caption: 'Remote', kind: 'markdown-link' },
      ]);
    expect(stripAssistantImageMarkdown(markdown)).toBe('Raw Remote');
  });
});
