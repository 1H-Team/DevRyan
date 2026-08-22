import { describe, expect, test } from 'bun:test';

import { assistantImageSyntaxFixtures } from '../testing/assistant-image-fixtures.js';
import {
  extractAssistantImageReferences,
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
});
