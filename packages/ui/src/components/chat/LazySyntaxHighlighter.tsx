import React from 'react';
import type { SyntaxHighlighterProps } from 'react-syntax-highlighter';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

// Drop-in replacement for `Prism as SyntaxHighlighter` from
// react-syntax-highlighter that keeps refractor out of the startup bundle.
// Same props, same markup once loaded; until then an unhighlighted stand-in
// with matching wrapper styles is rendered so nothing shifts on swap-in.

// Imported by its concrete path rather than `{ Prism }` off the package root so
// the emitted chunk is named `prism` and holds only the refractor build, and so
// no thin re-export module sits in between for Rollup's small-chunk merging to
// fold back into a startup chunk.
const PrismSyntaxHighlighter = lazyWithChunkRecovery(() => import('react-syntax-highlighter/dist/esm/prism'));

const PRE_THEME_KEY = 'pre[class*="language-"]';

// Mirrors the wrapper markup react-syntax-highlighter builds in highlight.js:
// theme pre style under customStyle on PreTag, codeTagProps (with the
// wrapLongLines whiteSpace default) on CodeTag, code as plain text.
const UnhighlightedCode: React.FC<SyntaxHighlighterProps> = ({
  children,
  style,
  customStyle,
  codeTagProps,
  wrapLongLines,
  language,
  PreTag = 'pre',
  CodeTag = 'code',
}) => {
  const theme = style ?? {};
  const Pre = PreTag as React.ElementType;
  const Code = CodeTag as React.ElementType;

  const preStyle: React.CSSProperties = {
    ...(theme[PRE_THEME_KEY] ?? { backgroundColor: '#fff' }),
    ...customStyle,
  };

  const resolvedCodeTagProps = codeTagProps ?? {
    className: language ? `language-${language}` : undefined,
    style: theme['code[class*="language-"]'],
  };

  const codeStyle: React.CSSProperties = {
    whiteSpace: wrapLongLines ? 'pre-wrap' : 'pre',
    ...resolvedCodeTagProps.style,
  };

  return (
    <Pre style={preStyle}>
      <Code {...resolvedCodeTagProps} style={codeStyle}>
        {children}
      </Code>
    </Pre>
  );
};

export const LazySyntaxHighlighter: React.FC<SyntaxHighlighterProps> = (props) => (
  <React.Suspense fallback={<UnhighlightedCode {...props} />}>
    <PrismSyntaxHighlighter {...props} />
  </React.Suspense>
);

export default LazySyntaxHighlighter;
