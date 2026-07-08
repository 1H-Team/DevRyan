import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'bun:test';

import { ExactUserPromptText } from './ExactUserPromptText';

describe('ExactUserPromptText', () => {
  test('renders a single pasted newline without markdown paragraph wrappers', () => {
    const html = renderToStaticMarkup(<ExactUserPromptText text={'line one\nline two'} />);

    expect(html).not.toContain('<p');
    expect(html).toContain('line one\nline two');
    expect(html).not.toContain('line one\n\nline two');
  });

  test('normalizes clipboard CRLF and CR line endings to one newline', () => {
    const html = renderToStaticMarkup(<ExactUserPromptText text={'alpha\r\nbeta\rgamma'} />);

    expect(html).toContain('alpha\nbeta\ngamma');
    expect(html).not.toContain('\r');
    expect(html).not.toContain('alpha\n\nbeta');
    expect(html).not.toContain('beta\n\ngamma');
  });

  test('keeps agent mention links while preserving surrounding text and newlines', () => {
    const html = renderToStaticMarkup(
      <ExactUserPromptText
        text={'ask @builder\nthen continue'}
        agentMention={{ name: 'builder', token: '@builder' }}
      />,
    );

    expect(html).toContain('ask ');
    expect(html).toContain('<a');
    expect(html).toContain('href="https://opencode.ai/docs/agents/#builder"');
    expect(html).toContain('@builder');
    expect(html).toContain('\nthen continue');
    expect(html).not.toContain('\n\nthen continue');
  });
});
