type HastLikeNode = {
  type?: string;
  value?: unknown;
  children?: HastLikeNode[];
};

const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const TRAILING_OPEN_COMMENT_PATTERN = /<!--[\s\S]*$/;

/**
 * Removes HTML comments from raw hast nodes before react-markdown's
 * raw-to-text pass turns them into visible literal text (react-markdown v10
 * renders raw nodes as text unless skipHtml deletes them wholesale).
 *
 * Only comments are removed: other raw HTML keeps rendering as literal text
 * exactly as before, and code blocks are untouched because their content is
 * never parsed as a raw node. A trailing unterminated `<!--` is also dropped
 * so partially streamed comments never flash on screen.
 */
export const rehypeStripHtmlComments = () => (tree: HastLikeNode): void => {
  const walk = (node: HastLikeNode): void => {
    const children = node.children;
    if (!Array.isArray(children)) return;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (!child || typeof child !== 'object') continue;
      if (child.type === 'raw' && typeof child.value === 'string') {
        const stripped = child.value
          .replace(HTML_COMMENT_PATTERN, '')
          .replace(TRAILING_OPEN_COMMENT_PATTERN, '');
        if (stripped === child.value) continue;
        if (stripped.trim() === '') {
          children.splice(i, 1);
        } else {
          child.value = stripped;
        }
      } else {
        walk(child);
      }
    }
  };
  walk(tree);
};
