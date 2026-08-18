const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'ul',
]);

export const normalizeLineBreaks = (value: string): string => value.replace(/\r\n?/g, '\n');

export const trimSelectionValue = (value: string): string => normalizeLineBreaks(value).trim();

export const textToMarkdownInline = (value: string): string => value.replace(/\s+/g, ' ').trim();

export const renderInlineMarkdownNode = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) {
    return textToMarkdownInline(node.textContent || '');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  const childText = Array.from(element.childNodes)
    .map((child) => renderInlineMarkdownNode(child))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  if (!childText && tag !== 'br') {
    return '';
  }

  if (tag === 'br') return '\n';
  if (tag === 'strong' || tag === 'b') return `**${childText}**`;
  if (tag === 'em' || tag === 'i') return `*${childText}*`;
  if (tag === 'code') return `\`${childText.replace(/`/g, '\\`')}\``;
  if (tag === 'a') {
    const href = element.getAttribute('href');
    return href ? `[${childText}](${href})` : childText;
  }

  return childText;
};

export const renderListMarkdown = (list: HTMLElement, ordered: boolean): string => {
  const items = Array.from(list.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.tagName.toLowerCase() === 'li'
  );

  return items
    .map((item, index) => {
      const prefix = ordered ? `${index + 1}. ` : '- ';
      const body = Array.from(item.childNodes)
        .map((child) => renderInlineMarkdownNode(child))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      return body ? `${prefix}${body}` : '';
    })
    .filter(Boolean)
    .join('\n');
};

export const renderBlockMarkdownNode = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) {
    return trimSelectionValue(node.textContent || '');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();

  if (tag === 'pre') {
    const codeElement = element.querySelector('code');
    const languageClass = codeElement?.className || '';
    const language = (languageClass.match(/language-([\w-]+)/)?.[1] || '').trim();
    const code = normalizeLineBreaks(codeElement?.textContent || element.textContent || '').replace(/\n$/, '');
    return `\`\`\`${language}\n${code}\n\`\`\``;
  }

  if (tag === 'code') {
    const code = normalizeLineBreaks(element.textContent || '').trim();
    return code ? `\`${code.replace(/`/g, '\\`')}\`` : '';
  }

  if (tag === 'ul') return renderListMarkdown(element, false);
  if (tag === 'ol') return renderListMarkdown(element, true);

  if (tag === 'blockquote') {
    const content = trimSelectionValue(
      Array.from(element.childNodes).map((child) => renderBlockMarkdownNode(child)).join('\n')
    );
    return content
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => `> ${line}`)
      .join('\n');
  }

  if (/^h[1-6]$/.test(tag)) {
    const level = Number.parseInt(tag[1], 10);
    const text = trimSelectionValue(Array.from(element.childNodes).map((child) => renderInlineMarkdownNode(child)).join(''));
    return text ? `${'#'.repeat(level)} ${text}` : '';
  }

  if (tag === 'p' || tag === 'div' || tag === 'li') {
    return trimSelectionValue(Array.from(element.childNodes).map((child) => renderInlineMarkdownNode(child)).join(''));
  }

  const blockChildren = Array.from(element.childNodes)
    .map((child) => renderBlockMarkdownNode(child))
    .filter((child) => child.length > 0);
  if (blockChildren.length > 0) {
    return blockChildren.join('\n\n');
  }

  return trimSelectionValue(Array.from(element.childNodes).map((child) => renderInlineMarkdownNode(child)).join(''));
};

export const isInlineSelectionFragment = (fragment: DocumentFragment): boolean => {
  return Array.from(fragment.childNodes).every((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      return true;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return true;
    }

    const element = node as HTMLElement;
    return !BLOCK_TAGS.has(element.tagName.toLowerCase());
  });
};

export const rangeToMarkdown = (range: Range, plainText: string): string => {
  const fragment = range.cloneContents();

  if (isInlineSelectionFragment(fragment)) {
    const inlineMarkdown = trimSelectionValue(
      Array.from(fragment.childNodes)
        .map((node) => renderInlineMarkdownNode(node))
        .join('')
    );
    if (inlineMarkdown) {
      return inlineMarkdown;
    }
  }

  const markdown = Array.from(fragment.childNodes)
    .map((node) => renderBlockMarkdownNode(node))
    .filter((value) => value.length > 0)
    .join('\n\n')
    .trim();

  return markdown || trimSelectionValue(plainText);
};

export const wrapSelectionMarkdownForComposer = (markdown: string): string => (
  `\`\`\`md\n${markdown}\n\`\`\``
);
