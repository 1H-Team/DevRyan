export type MarkdownStreamBlock = {
  key: string;
  raw: string;
  src: string;
  mode: 'full' | 'live';
};

export const buildMarkdownRenderBlockKey = (baseKey: string, index: number): string => {
  return `${baseKey}:block:${index}`;
};

export const streamMarkdownBlocks = (
  text: string,
  live: boolean,
  baseKey: string,
): MarkdownStreamBlock[] => [{
  // Keep the rendered subtree mounted while text grows and when a streamed
  // response becomes terminal. Re-keying by mode/content remounted every code
  // block, list, and paragraph at completion, briefly changing the measured
  // transcript height and making pinned output appear to jump.
  key: buildMarkdownRenderBlockKey(baseKey, 0),
  raw: text,
  src: text,
  mode: live ? 'live' : 'full',
}];
