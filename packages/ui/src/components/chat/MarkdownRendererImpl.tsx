import React from 'react';
import 'katex/dist/katex.min.css';
import { renderMermaidASCII, renderMermaidSVG } from 'beautiful-mermaid';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { rehypeStripHtmlComments } from './rehypeStripHtmlComments';
import { FadeInOnReveal } from './message/FadeInOnReveal';
import type { Part } from '@opencode-ai/sdk/v2';
import { cn } from '@/lib/utils';
import { RiFileCopyLine, RiCheckLine, RiDownloadLine, RiEyeLine, RiCodeLine } from '@remixicon/react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { toast } from '@/components/ui';
import { copyRichTextToClipboard, copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';

import { isExternalHttpUrl, isLoopbackHttpUrl, openExternalUrl } from '@/lib/url';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { getDefaultTheme } from '@/lib/theme/themes';
import { generateSyntaxTheme } from '@/lib/theme/syntaxThemeGenerator';
import type { ToolPopupContent } from './message/types';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { EditorAPI, FilesAPI } from '@/lib/api/types';
import {
  buildFileReferenceStatRequest,
  getResolvedReference,
  isLikelyFilePath,
  normalizePath,
} from './fileReferenceHelpers';
import { streamMarkdownBlocks, type MarkdownStreamBlock } from './markdownStreamingBlocks';

const useCurrentMermaidTheme = () => {
  const themeSystem = useOptionalThemeSystem();
  const fallbackLight = getDefaultTheme(false);
  const fallbackDark = getDefaultTheme(true);

  return themeSystem?.currentTheme
    ?? (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? fallbackDark
      : fallbackLight);
};

const useExternalLinkInteractions = ({
  containerRef,
  enabled,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  enabled?: boolean;
}) => {
  React.useEffect(() => {
    if (enabled === false) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }

      if (anchor.getAttribute('data-openchamber-file-link') === 'true') {
        return;
      }

      const href = anchor.getAttribute('href') ?? '';
      if (!isExternalHttpUrl(href)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void openExternalUrl(href);
    };

    container.addEventListener('click', handleClick);
    return () => {
      container.removeEventListener('click', handleClick);
    };
  }, [containerRef, enabled]);
};

// Table utility functions
const extractTableData = (tableEl: HTMLTableElement): { headers: string[]; rows: string[][] } => {
  const headers: string[] = [];
  const rows: string[][] = [];
  
  const thead = tableEl.querySelector('thead');
  if (thead) {
    const headerCells = thead.querySelectorAll('th');
    headerCells.forEach(cell => headers.push(cell.innerText.trim()));
  }
  
  const tbody = tableEl.querySelector('tbody');
  if (tbody) {
    const rowEls = tbody.querySelectorAll('tr');
    rowEls.forEach(row => {
      const cells = row.querySelectorAll('td');
      const rowData: string[] = [];
      cells.forEach(cell => rowData.push(cell.innerText.trim()));
      rows.push(rowData);
    });
  }
  
  return { headers, rows };
};

const tableToCSV = ({ headers, rows }: { headers: string[]; rows: string[][] }): string => {
  const escapeCell = (cell: string): string => {
    if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
      return `"${cell.replace(/"/g, '""')}"`;
    }
    return cell;
  };
  
  const lines: string[] = [];
  if (headers.length > 0) {
    lines.push(headers.map(escapeCell).join(','));
  }
  rows.forEach(row => lines.push(row.map(escapeCell).join(',')));
  return lines.join('\n');
};

const tableToTSV = ({ headers, rows }: { headers: string[]; rows: string[][] }): string => {
  const escapeCell = (cell: string): string => {
    return cell.replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  };
  
  const lines: string[] = [];
  if (headers.length > 0) {
    lines.push(headers.map(escapeCell).join('\t'));
  }
  rows.forEach(row => lines.push(row.map(escapeCell).join('\t')));
  return lines.join('\n');
};

const tableToMarkdown = ({ headers, rows }: { headers: string[]; rows: string[][] }): string => {
  if (headers.length === 0) return '';
  
  const escapeCell = (cell: string): string => {
    return cell.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  };
  
  const lines: string[] = [];
  lines.push(`| ${headers.map(escapeCell).join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  rows.forEach(row => {
    const paddedRow = headers.map((_, i) => escapeCell(row[i] || ''));
    lines.push(`| ${paddedRow.join(' | ')} |`);
  });
  return lines.join('\n');
};

const downloadFile = (filename: string, content: string, mimeType: string) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// Table copy button with dropdown
const TableCopyButton: React.FC<{ tableRef: React.RefObject<HTMLDivElement | null> }> = ({ tableRef }) => {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);
  const [showMenu, setShowMenu] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCopy = async (format: 'csv' | 'tsv') => {
    const tableEl = tableRef.current?.querySelector('table');
    if (!tableEl) return;
    
    const data = extractTableData(tableEl);
    const content = format === 'csv' ? tableToCSV(data) : tableToTSV(data);

    try {
      const result = await copyRichTextToClipboard(content, tableEl.outerHTML, {
        sourceSurface: 'chat', copyKind: 'text',
      });
      if (!result.ok) throw new Error(result.error);
      setCopied(true);
      setShowMenu(false);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy table:', err);
    }
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
        title={t('markdownRenderer.table.actions.copyTitle')}
      >
        {copied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
      </button>
      {showMenu && (
        <div className="absolute top-full right-0 z-10 mt-1 min-w-[100px] overflow-hidden rounded-md border border-border bg-background shadow-none">
          <button
            className="w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-interactive-hover/40"
            onClick={() => handleCopy('csv')}
          >
            CSV
          </button>
          <button
            className="w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-interactive-hover/40"
            onClick={() => handleCopy('tsv')}
          >
            TSV
          </button>
        </div>
      )}
    </div>
  );
};

// Table download button with dropdown
const TableDownloadButton: React.FC<{ tableRef: React.RefObject<HTMLDivElement | null> }> = ({ tableRef }) => {
  const { t } = useI18n();
  const [showMenu, setShowMenu] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

   const handleDownload = (format: 'csv' | 'markdown') => {
      const tableEl = tableRef.current?.querySelector('table');
      if (!tableEl) return;

      const data = extractTableData(tableEl);
      const content = format === 'csv' ? tableToCSV(data) : tableToMarkdown(data);
      const filename = format === 'csv' ? 'table.csv' : 'table.md';
      const mimeType = format === 'csv' ? 'text/csv' : 'text/markdown';
      downloadFile(filename, content, mimeType);
      setShowMenu(false);
      toast.success(t('markdownRenderer.table.toast.downloadedAsFormat', { format: format.toUpperCase() }));
    };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
        title={t('markdownRenderer.table.actions.downloadTitle')}
      >
        <RiDownloadLine className="size-3.5" />
      </button>
      {showMenu && (
        <div className="absolute top-full right-0 z-10 mt-1 min-w-[100px] overflow-hidden rounded-md border border-border bg-background shadow-none">
          <button
            className="w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-interactive-hover/40"
            onClick={() => handleDownload('csv')}
          >
            CSV
          </button>
          <button
            className="w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-interactive-hover/40"
            onClick={() => handleDownload('markdown')}
          >
            Markdown
          </button>
        </div>
      )}
    </div>
  );
};

// Table wrapper with custom controls
const TableWrapper: React.FC<{ children?: React.ReactNode; className?: string }> = ({ children, className }) => {
  const tableRef = React.useRef<HTMLDivElement>(null);
  const { isMobile, isTablet } = useDeviceInfo();
  const alwaysShowActions = isMobile || isTablet;

  return (
    <div className="group my-4 flex flex-col space-y-2" data-markdown="table-wrapper" ref={tableRef}>
      <div className={cn(
        "flex items-center justify-end gap-1 transition-opacity",
        alwaysShowActions ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      )}>
        <TableCopyButton tableRef={tableRef} />
        <TableDownloadButton tableRef={tableRef} />
      </div>
      <div className="overflow-x-auto rounded-lg border border-border/80 bg-[var(--surface-elevated)]">
        <table className={cn('w-full border-collapse text-sm', className)} data-markdown="table">
          {children}
        </table>
      </div>
    </div>
  );
};

const MermaidBlock: React.FC<{ source: string; mode: 'svg' | 'ascii' }> = ({ source, mode }) => {
  const { t } = useI18n();
  const currentTheme = useCurrentMermaidTheme();
  const { isMobile, isTablet } = useDeviceInfo();
  const [copied, setCopied] = React.useState(false);
  const [downloaded, setDownloaded] = React.useState(false);

  const svg = React.useMemo(() => {
    if (mode !== 'svg') return '';
    try {
      return renderMermaidSVG(source, {
        bg: currentTheme.colors.surface.elevated,
        fg: currentTheme.colors.surface.foreground,
        line: currentTheme.colors.interactive.border,
        accent: currentTheme.colors.primary.base,
        muted: currentTheme.colors.surface.mutedForeground,
        surface: currentTheme.colors.surface.muted,
        border: currentTheme.colors.interactive.border,
        transparent: true,
        font: 'IBM Plex Sans, sans-serif',
      });
    } catch {
      return '';
    }
  }, [currentTheme, mode, source]);

  const ascii = React.useMemo(() => {
    if (mode !== 'ascii') return '';
    try {
      return renderMermaidASCII(source);
    } catch {
      return '';
    }
  }, [mode, source]);

  const copyVisibilityClass = isMobile || isTablet ? 'opacity-100' : 'opacity-0 group-hover:opacity-100';

  const handleCopyAscii = async (asciiText: string) => {
    if (!asciiText) return;
    const result = await copyTextToClipboard(asciiText);
    if (result.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCopyMermaidSource = async () => {
    if (!source) return;
    const result = await copyTextToClipboard(source);
    if (result.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownloadSvg = () => {
    if (!svg) return;
    try {
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `diagram-${Date.now()}.svg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 2000);
    } catch {
      toast.error(t('markdownRenderer.mermaid.toast.downloadFailed'));
    }
  };

  if (mode === 'ascii') {
    const asciiText = ascii || source;

    return (
      <div data-markdown="mermaid-block" className="group">
        <div data-markdown="mermaid-scroll">
          <pre data-markdown="mermaid-ascii">{asciiText}</pre>
        </div>
        <div
          className={cn(
            'absolute top-1 right-2 transition-opacity',
            copyVisibilityClass,
          )}
        >
          <button
            onClick={() => handleCopyAscii(asciiText)}
            className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
            title={t('markdownRenderer.mermaid.actions.copyTitle')}
          >
            {copied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
          </button>
        </div>
      </div>
    );
  }

  if (!svg) {
    return (
      <div data-markdown="mermaid-block" className="group">
        <div data-markdown="mermaid-scroll">
          <pre data-markdown="mermaid-ascii">{source}</pre>
        </div>
        <div
          className={cn(
            'absolute top-1 right-2 transition-opacity',
            copyVisibilityClass,
          )}
        >
          <button
            onClick={() => handleCopyAscii(source)}
            className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
            title={t('markdownRenderer.mermaid.actions.copyTitle')}
          >
            {copied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-markdown="mermaid-block" className="group">
      <div data-markdown="mermaid-scroll">
        <div data-markdown="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
      <div
        className={cn(
          'absolute top-1 right-2 flex items-center gap-1 transition-opacity',
          copyVisibilityClass,
        )}
      >
        <button
          onClick={handleCopyMermaidSource}
          className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
          title={t('markdownRenderer.mermaid.actions.copySourceTitle')}
        >
          {copied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
        </button>
        <button
          onClick={handleDownloadSvg}
          className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
          title={t('markdownRenderer.mermaid.actions.downloadSvgTitle')}
        >
          {downloaded ? <RiCheckLine className="size-3.5" /> : <RiDownloadLine className="size-3.5" />}
        </button>
      </div>
    </div>
  );
};

type MermaidControlOptions = {
  download: boolean;
  copy: boolean;
  fullscreen: boolean;
  panZoom: boolean;
};

const extractMermaidBlocks = (markdown: string): string[] => {
  if (!markdown.includes('mermaid')) return [];
  const blocks: string[] = [];
  const regex = /(?:^|\r?\n)(`{3,}|~{3,})mermaid[^\n\r]*\r?\n([\s\S]*?)\r?\n\1(?=\r?\n|$)/gi;
  let match: RegExpExecArray | null = regex.exec(markdown);

  while (match) {
    const block = (match[2] ?? '').replace(/\s+$/, '');
    blocks.push(block);
    match = regex.exec(markdown);
  }

  return blocks;
};

const stripLeadingFrontmatter = (markdown: string): string => {
  const frontmatterMatch = markdown.match(
    /^(?:\uFEFF)?(---|\+\+\+)[^\S\r\n]*\r?\n[\s\S]*?\r?\n\1[^\S\r\n]*(?:\r?\n|$)/,
  );

  if (!frontmatterMatch) {
    return markdown;
  }

  return markdown.slice(frontmatterMatch[0].length);
};

export type MarkdownVariant = 'assistant' | 'tool' | 'reasoning';

const useStableMarkdownBlocks = (text: string, live: boolean, baseKey: string): MarkdownStreamBlock[] => {
  const previousRef = React.useRef<MarkdownStreamBlock[]>([]);

  return React.useMemo(() => {
    const nextBlocks = streamMarkdownBlocks(text, live, baseKey);
    const previousBlocks = previousRef.current;
    const stabilized = nextBlocks.map((block, index) => {
      const previous = previousBlocks[index];
      if (previous && previous.key === block.key && previous.src === block.src) {
        return previous;
      }
      return block;
    });

    const unchanged = stabilized.length === previousBlocks.length
      && stabilized.every((block, index) => block === previousBlocks[index]);

    if (unchanged) {
      return previousBlocks;
    }

    previousRef.current = stabilized;
    return stabilized;
  }, [baseKey, live, text]);
};

const extractCodeText = (children: React.ReactNode): string => {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) {
    return children.map((child) => extractCodeText(child)).join('');
  }
  if (React.isValidElement(children)) {
    return extractCodeText((children.props as { children?: React.ReactNode }).children);
  }
  return '';
};

const getCodeLanguage = (className: string | undefined): string => {
  const match = className?.match(/language-([\w-]+)/);
  return match?.[1]?.toLowerCase() ?? 'text';
};

const decodeHtmlEntities = (value: string): string => {
  let decoded = value;
  for (let i = 0; i < 3; i += 1) {
    const next = decoded
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    if (next === decoded) {
      return decoded;
    }
    decoded = next;
  }
  return decoded;
};

const normalizeCodeBlockText = (code: string, language: string): string => {
  if (!['json', 'jsonc', 'json5'].includes(language)) {
    return code;
  }
  if (!/&(quot|#34|amp;quot|lt|gt|amp|apos|#39);/.test(code)) {
    return code;
  }
  return decodeHtmlEntities(code);
};

const CODE_HIGHLIGHT_SETTLE_MS = 300;
const CODE_SHARED_STYLE: React.CSSProperties = {
  margin: 0,
  background: 'transparent',
  padding: 0,
  fontSize: 'var(--text-code)',
  lineHeight: 'var(--markdown-code-block-line-height)',
};

const downloadTextFile = (content: string, filename: string, mimeType: string) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch {
    // Best-effort; callers can optionally toast.
  }
};

const MarkdownCodeBlock: React.FC<{
  code: string;
  language: string;
  syntaxTheme: { [key: string]: React.CSSProperties };
}> = ({ code, language, syntaxTheme }) => {
  const [copied, setCopied] = React.useState(false);
  const [highlight, setHighlight] = React.useState(true);
  const [viewMode, setViewMode] = React.useState<'code' | 'preview'>('code');
  const prevCodeRef = React.useRef<string>(code);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isMobile, isTablet } = useDeviceInfo();

  const canPreview = language === 'html' || language === 'htm';

  React.useEffect(() => {
    if (!canPreview && viewMode !== 'code') {
      setViewMode('code');
    }
  }, [canPreview, viewMode]);

  // Defer Prism highlighting while code is actively streaming.
  // Initial mount renders highlighted immediately (plays nice with finalized blocks).
  React.useEffect(() => {
    if (prevCodeRef.current === code) return;
    prevCodeRef.current = code;

    if (timerRef.current) clearTimeout(timerRef.current);
    setHighlight(false);
    timerRef.current = setTimeout(() => {
      setHighlight(true);
      timerRef.current = null;
    }, CODE_HIGHLIGHT_SETTLE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [code]);

  const handleCopy = React.useCallback(async () => {
    const result = await copyTextToClipboard(code);
    if (!result.ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [code]);

  const handleDownload = React.useCallback(() => {
    if (!canPreview) {
      return;
    }

    const safeSuffix = Date.now().toString(36);
    downloadTextFile(code, `preview-${safeSuffix}.html`, 'text/html;charset=utf-8');
  }, [canPreview, code]);

  return (
    <div data-component="markdown-code" className="my-4 group overflow-hidden rounded-2xl border border-border/80 bg-[var(--surface-elevated)]">
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-1.5">
        <span className="font-mono text-[13px] text-muted-foreground">{language}</span>
        <div className={cn(
          "flex items-center gap-1 transition-opacity",
          isMobile || isTablet ? "opacity-100" : "opacity-100 md:opacity-0 md:group-hover:opacity-100"
        )}>
          {canPreview ? (
            <button
              type="button"
              onClick={() => setViewMode((mode) => (mode === 'preview' ? 'code' : 'preview'))}
              className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
              title={viewMode === 'preview' ? 'Show Code' : 'Preview'}
              aria-pressed={viewMode === 'preview'}
              aria-label={viewMode === 'preview' ? 'Show Code' : 'Preview HTML'}
            >
              {viewMode === 'preview' ? <RiCodeLine className="size-3.5" /> : <RiEyeLine className="size-3.5" />}
            </button>
          ) : null}
          {canPreview ? (
            <button
              type="button"
              onClick={handleDownload}
              className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
              title="Download HTML"
              aria-label="Download HTML"
            >
              <RiDownloadLine className="size-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => { void handleCopy(); }}
            className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
            title={copied ? 'Copied' : 'Copy Code'}
            aria-label={copied ? 'Copied' : 'Copy Code'}
          >
            {copied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
          </button>
        </div>
      </div>
      {canPreview && viewMode === 'preview' ? (
        <div className="h-[320px] md:h-[420px] bg-background">
          <iframe
            srcDoc={code}
            title="HTML Preview"
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-forms"
          />
        </div>
      ) : (
        <div className="px-3 py-2.5">
          {highlight ? (
            <SyntaxHighlighter
              language={language}
              style={syntaxTheme}
              customStyle={CODE_SHARED_STYLE}
              codeTagProps={{ style: CODE_SHARED_STYLE }}
              PreTag="pre"
            >
              {code}
            </SyntaxHighlighter>
          ) : (
            <pre style={CODE_SHARED_STYLE}>
              <code style={CODE_SHARED_STYLE}>{code}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

const buildMarkdownComponents = ({
  syntaxTheme,
  onPreviewLoopback,
  previewLabel,
  previewTitle,
}: {
  syntaxTheme: { [key: string]: React.CSSProperties };
  onPreviewLoopback?: (url: string) => void;
  previewLabel?: string;
  previewTitle?: string;
}): Components => ({
  table({ children, ...props }) {
    return <TableWrapper className={props.className}>{children}</TableWrapper>;
  },
  h1({ children, ...props }) {
    return <h1 {...props} className={cn('typography-markdown-h1 mt-4 mb-2 text-[var(--markdown-heading1,var(--primary))] font-semibold', props.className)}>{children}</h1>;
  },
  h2({ children, ...props }) {
    return <h2 {...props} className={cn('typography-markdown-h2 mt-3.5 mb-1.5 text-[var(--markdown-heading2,var(--primary))] font-semibold', props.className)}>{children}</h2>;
  },
  h3({ children, ...props }) {
    return <h3 {...props} className={cn('typography-markdown-h3 mt-3 mb-1 text-[var(--markdown-heading3,var(--primary))] font-semibold', props.className)}>{children}</h3>;
  },
  h4({ children, ...props }) {
    return <h4 {...props} className={cn('typography-markdown-h4 mt-2.5 mb-1 text-[var(--markdown-heading4,var(--foreground))] font-semibold', props.className)}>{children}</h4>;
  },
  h5({ children, ...props }) {
    return <h5 {...props} className={cn('typography-markdown-h4 mt-2.5 mb-1 text-[var(--markdown-heading4,var(--foreground))] font-semibold', props.className)}>{children}</h5>;
  },
  h6({ children, ...props }) {
    return <h6 {...props} className={cn('typography-markdown-h4 mt-2.5 mb-1 text-[var(--markdown-heading4,var(--foreground))] font-semibold', props.className)}>{children}</h6>;
  },
  p({ children, ...props }) {
    return <p {...props} className={cn('typography-markdown-body my-2 text-foreground/90', props.className)}>{children}</p>;
  },
  thead({ children, ...props }) {
    return <thead {...props} className={cn('[&_tr]:border-b [&_tr]:border-border/80', props.className)}>{children}</thead>;
  },
  tbody({ children, ...props }) {
    return <tbody {...props} className={cn('[&_tr:last-child]:border-0', props.className)}>{children}</tbody>;
  },
  tr({ children, ...props }) {
    return <tr {...props} className={cn('border-b border-border/60', props.className)}>{children}</tr>;
  },
  th({ children, ...props }) {
    return <th {...props} className={cn('border-r border-border/60 px-4 py-2.5 text-left align-middle font-semibold text-foreground last:border-r-0', props.className)}>{children}</th>;
  },
  td({ children, ...props }) {
    return <td {...props} className={cn('border-r border-border/60 px-4 py-2.5 align-middle text-foreground/90 last:border-r-0', props.className)}>{children}</td>;
  },
  ul({ children, ...props }) {
    return <ul {...props} className={cn('typography-markdown-body my-2', props.className)}>{children}</ul>;
  },
  ol({ children, ...props }) {
    return <ol {...props} className={cn('typography-markdown-body my-2', props.className)}>{children}</ol>;
  },
  li({ children, ...props }) {
    return <li {...props} className={cn('typography-markdown-body my-0.5 text-foreground/90', props.className)}>{children}</li>;
  },
  blockquote({ children, ...props }) {
    return <blockquote {...props} className={cn('my-3 border-l-2 border-[var(--markdown-blockquote-border,var(--border))] pl-4 typography-markdown-body text-[var(--markdown-blockquote,var(--muted-foreground))]', props.className)}>{children}</blockquote>;
  },
  pre({ children, ...props }) {
    const child = React.Children.only(children) as React.ReactElement<{ className?: string; children?: React.ReactNode }>;
    const className = child.props.className;
    const language = getCodeLanguage(className);
    const code = normalizeCodeBlockText(extractCodeText(child.props.children).replace(/\n$/, ''), language);
    if (language === 'mermaid') {
      return <MermaidBlock source={code} mode={useUIStore.getState().mermaidRenderingMode} />;
    }
    return <MarkdownCodeBlock code={code} language={language} syntaxTheme={syntaxTheme} {...props} />;
  },
  code({ className, children, ...props }) {
    return (
      <code
        {...props}
        className={cn('rounded bg-[var(--surface-elevated)] px-1 py-0.5 font-mono text-[0.95em]', className)}
        data-markdown="inline-code"
      >
        {children}
      </code>
    );
  },
  a({ href, children, ...props }) {
    const targetHref = href ?? '';
    const isLoopback = onPreviewLoopback ? isLoopbackHttpUrl(targetHref) : false;
    return (
      <>
        <a
          {...props}
          href={href}
          target={isExternalHttpUrl(targetHref) ? '_blank' : undefined}
          rel={isExternalHttpUrl(targetHref) ? 'noopener noreferrer' : undefined}
        >
          {children}
        </a>
        {isLoopback && onPreviewLoopback ? (
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onPreviewLoopback(targetHref);
            }}
            className="ml-1 inline-flex h-5 items-center gap-0.5 rounded border border-[var(--border)] bg-[var(--surface-background)] px-1.5 align-middle text-[11px] leading-none text-[var(--muted-foreground)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]"
            aria-label={previewTitle ?? previewLabel ?? 'Open Preview Pane'}
            title={previewTitle ?? previewLabel ?? 'Open Preview Pane'}
            data-loopback-preview-trigger="true"
          >
            <RiEyeLine className="size-3" aria-hidden="true" />
            <span className="font-medium">{previewLabel ?? 'Preview'}</span>
          </button>
        ) : null}
      </>
    );
  },
});

const REMARK_PLUGINS: React.ComponentProps<typeof ReactMarkdown>['remarkPlugins'] = [remarkGfm, remarkMath];
const REHYPE_PLUGINS: React.ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  rehypeStripHtmlComments,
  [rehypeKatex, { throwOnError: false, errorColor: 'var(--destructive)' }],
];

const MarkdownBlockView: React.FC<{
  block: MarkdownStreamBlock;
  components: Components;
}> = React.memo(({ block, components }) => {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
      {block.src}
    </ReactMarkdown>
  );
}, (prev, next) => prev.block === next.block && prev.components === next.components);

MarkdownBlockView.displayName = 'MarkdownBlockView';

interface MarkdownRendererProps {
  content: string;
  part?: Part;
  messageId: string;
  isAnimated?: boolean;
  skipFadeIn?: boolean;
  className?: string;
  isStreaming?: boolean;
  disableStreamAnimation?: boolean;
  variant?: MarkdownVariant;
  onShowPopup?: (content: ToolPopupContent) => void;
  enableFileReferences?: boolean;
}

const MERMAID_BLOCK_SELECTOR = '[data-markdown="mermaid-block"]';
const FILE_LINK_SELECTOR = '[data-openchamber-file-link="true"]';
const BLOCK_PATH_TOKEN_ATTR = 'data-openchamber-block-path-token';
const BLOCK_PATH_TOKEN_SELECTOR = `[${BLOCK_PATH_TOKEN_ATTR}]`;
const CODE_BLOCK_PATH_SCANNED_ATTR = 'data-openchamber-block-paths-scanned';
// Matches `path[:line[:col]]` inside shell/grep-style output. Requires a file
// extension (1-8 alphanumerics) so plain words don't qualify; the path itself
// must contain at least one extension-bearing segment.
//
// Known limitation: backslash-separated Windows paths (e.g.
// `C:\Users\test\file.ts:12`) are not matched because the path character class
// does not include `\`. Compiler output inside fenced code blocks predominantly
// uses forward slashes, so this is a niche gap. The inline-code pipeline is not
// affected — it reads full text content rather than matching with a regex.
const BLOCK_PATH_TOKEN_RE = /(?:[A-Za-z]:[\\/])?[\w.\-/@+]*[\w\-/@+]\.[A-Za-z0-9]{1,8}(?::\d+){0,2}/g;
const MAX_BLOCK_CODE_SCAN_LENGTH = 200_000;
const FILE_REFERENCE_STAT_CONCURRENCY = 4;
const FILE_REFERENCE_STAT_CACHE = new Map<string, Promise<boolean>>();
let activeFileReferenceStatCount = 0;
const pendingFileReferenceStats: Array<() => void> = [];

const extractPathCandidateFromElement = (element: HTMLElement): string => {
  if (element.tagName.toLowerCase() === 'a') {
    const href = element.getAttribute('href')?.trim();
    if (href && isLikelyFilePath(href)) {
      return href;
    }
  }

  return (element.textContent || '').trim();
};

// Walks text nodes inside `<pre><code>` subtrees and wraps any substring that
// looks like a `path[:line[:col]]` reference in a span carrying
// `data-openchamber-block-path-token`. `annotateFileLinks` then promotes those
// spans into clickable file links via the same existing pipeline used for
// inline code (parseFileReference → fileReferenceExists → openFileReference).
//
// Idempotent: each `<code>` node is marked with
// `data-openchamber-block-paths-scanned` once processed so the walk is not
// repeated on the same element. When the renderer replaces the `<code>` subtree
// (e.g. on content change during streaming), the new element lacks the marker and
// will be rescanned on the next mutation-observer callback.
const wrapBlockCodePathTokens = (container: HTMLElement): void => {
  const codeBlocks = container.querySelectorAll<HTMLElement>('pre code');
  if (codeBlocks.length === 0) {
    return;
  }

  const doc = container.ownerDocument;
  if (!doc) {
    return;
  }

  for (const codeBlock of Array.from(codeBlocks)) {
    if (codeBlock.getAttribute(CODE_BLOCK_PATH_SCANNED_ATTR) === 'true') {
      continue;
    }

    // Skip absurdly large code blocks to keep DOM work bounded.
    if ((codeBlock.textContent ?? '').length > MAX_BLOCK_CODE_SCAN_LENGTH) {
      codeBlock.setAttribute(CODE_BLOCK_PATH_SCANNED_ATTR, 'true');
      continue;
    }

    const walker = doc.createTreeWalker(codeBlock, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let currentNode = walker.nextNode();
    while (currentNode) {
      textNodes.push(currentNode as Text);
      currentNode = walker.nextNode();
    }

    for (const textNode of textNodes) {
      // Skip nodes already inside one of our token spans.
      if (textNode.parentElement?.closest(BLOCK_PATH_TOKEN_SELECTOR)) {
        continue;
      }

      const text = textNode.data;
      if (!text || !text.includes('.')) {
        continue;
      }

      BLOCK_PATH_TOKEN_RE.lastIndex = 0;
      const matches: Array<{ start: number; end: number; raw: string }> = [];
      let match: RegExpExecArray | null = BLOCK_PATH_TOKEN_RE.exec(text);
      while (match) {
        const raw = match[0];
        if (raw && isLikelyFilePath(raw)) {
          matches.push({ start: match.index, end: match.index + raw.length, raw });
        }
        match = BLOCK_PATH_TOKEN_RE.exec(text);
      }

      if (matches.length === 0) {
        continue;
      }

      const fragment = doc.createDocumentFragment();
      let cursor = 0;
      for (const { start, end, raw } of matches) {
        if (start > cursor) {
          fragment.appendChild(doc.createTextNode(text.slice(cursor, start)));
        }
        const span = doc.createElement('span');
        span.setAttribute(BLOCK_PATH_TOKEN_ATTR, 'true');
        span.textContent = raw;
        fragment.appendChild(span);
        cursor = end;
      }
      if (cursor < text.length) {
        fragment.appendChild(doc.createTextNode(text.slice(cursor)));
      }

      textNode.parentNode?.replaceChild(fragment, textNode);
    }

    codeBlock.setAttribute(CODE_BLOCK_PATH_SCANNED_ATTR, 'true');
  }
};

const fileReferenceExists = (
  resolvedPath: string,
  effectiveDirectory: string,
  files?: FilesAPI,
): Promise<boolean> => {
  const requestDetails = buildFileReferenceStatRequest(resolvedPath, effectiveDirectory);
  if (!requestDetails || !files?.statFile) {
    return Promise.resolve(false);
  }

  const cacheKey = `${requestDetails.options.directory ?? ''}\n${requestDetails.path}`;
  const cached = FILE_REFERENCE_STAT_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const request = new Promise<boolean>((resolve) => {
    const run = () => {
      activeFileReferenceStatCount += 1;
      void files.statFile!(requestDetails.path, requestDetails.options)
        .then((stat) => resolve(stat.exists !== false && stat.isFile))
        .catch(() => resolve(false))
        .finally(() => {
          activeFileReferenceStatCount = Math.max(0, activeFileReferenceStatCount - 1);
          pendingFileReferenceStats.shift()?.();
        });
    };

    if (activeFileReferenceStatCount < FILE_REFERENCE_STAT_CONCURRENCY) {
      run();
      return;
    }

    pendingFileReferenceStats.push(run);
  });

  FILE_REFERENCE_STAT_CACHE.set(cacheKey, request);
  return request;
};

const getContextDirectory = (effectiveDirectory: string, resolvedPath: string): string => {
  const normalizedDirectory = normalizePath(effectiveDirectory);
  if (normalizedDirectory) {
    return normalizedDirectory;
  }

  const normalizedPath = normalizePath(resolvedPath);
  const parent = normalizedPath.replace(/\/[^/]*$/, '');
  return parent || normalizedPath;
};

const useFileReferenceInteractions = ({
  containerRef,
  effectiveDirectory,
  editor,
  files,
  preferRuntimeEditor,
  enabled,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  effectiveDirectory: string;
  editor?: EditorAPI;
  files?: FilesAPI;
  preferRuntimeEditor?: boolean;
  enabled: boolean;
}) => {
  const annotationDebounceRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let cancelled = false;

    const clearFileLinkAttributes = (candidate: HTMLElement) => {
      candidate.removeAttribute('data-openchamber-file-link');
      candidate.removeAttribute('data-openchamber-file-ref');
      candidate.removeAttribute('data-openchamber-file-path');
      if (candidate.getAttribute('title') === 'Open file') {
        candidate.removeAttribute('title');
      }
      if (candidate.tagName.toLowerCase() !== 'a') {
        candidate.removeAttribute('role');
        candidate.removeAttribute('tabindex');
      }
    };

    const annotateFileLinks = () => {
      if (enabled) {
        wrapBlockCodePathTokens(container);
      }
      const candidates = container.querySelectorAll<HTMLElement>(
        `[data-markdown="inline-code"], a, ${BLOCK_PATH_TOKEN_SELECTOR}`,
      );

      for (const candidate of Array.from(candidates)) {
        const rawCandidate = extractPathCandidateFromElement(candidate);
        const resolved = getResolvedReference(rawCandidate, effectiveDirectory);
        clearFileLinkAttributes(candidate);

        if (!enabled || !resolved) {
          continue;
        }

        void fileReferenceExists(resolved.resolvedPath, effectiveDirectory, files).then((exists) => {
          if (cancelled || !exists || !container.contains(candidate)) {
            return;
          }

          const latestRawCandidate = extractPathCandidateFromElement(candidate);
          const latestResolved = getResolvedReference(latestRawCandidate, effectiveDirectory);
          if (!latestResolved || latestResolved.resolvedPath !== resolved.resolvedPath) {
            return;
          }

          candidate.setAttribute('data-openchamber-file-link', 'true');
          candidate.setAttribute('data-openchamber-file-ref', latestRawCandidate);
          candidate.setAttribute('data-openchamber-file-path', latestResolved.resolvedPath);
          candidate.setAttribute('title', 'Open file');
          if (candidate.tagName.toLowerCase() !== 'a') {
            candidate.setAttribute('role', 'button');
            candidate.setAttribute('tabindex', '0');
          }
        });
      }
    };

    const openFileReference = (sourceElement: HTMLElement) => {
      const raw = sourceElement.getAttribute('data-openchamber-file-ref') || extractPathCandidateFromElement(sourceElement);
      const resolved = getResolvedReference(raw, effectiveDirectory);
      if (!resolved) {
        return;
      }

      const contextDirectory = getContextDirectory(effectiveDirectory, resolved.resolvedPath);
      if (preferRuntimeEditor && editor) {
        void editor.openFile(
          resolved.resolvedPath,
          Number.isFinite(resolved.line ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.line as number))
            : undefined,
          Number.isFinite(resolved.column ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.column as number))
            : undefined,
        );
        return;
      }

      const uiStore = useUIStore.getState();
      if (Number.isFinite(resolved.line ?? Number.NaN)) {
        uiStore.openContextFileAtLine(
          contextDirectory,
          resolved.resolvedPath,
          Math.max(1, Math.trunc(resolved.line as number)),
          Number.isFinite(resolved.column ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.column as number))
            : 1,
        );
      } else {
        uiStore.openContextFile(contextDirectory, resolved.resolvedPath);
      }
    };

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const fileRefElement = target.closest(FILE_LINK_SELECTOR);
      if (!(fileRefElement instanceof HTMLElement)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      openFileReference(fileRefElement);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      const target = event.target;
      if (!(target instanceof HTMLElement) || target.getAttribute('data-openchamber-file-link') !== 'true') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      openFileReference(target);
    };

    annotateFileLinks();

    const observer = new MutationObserver(() => {
      if (annotationDebounceRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(annotationDebounceRef.current);
      }
      if (typeof window === 'undefined') {
        annotateFileLinks();
        return;
      }
      annotationDebounceRef.current = window.setTimeout(() => {
        annotationDebounceRef.current = null;
        annotateFileLinks();
      }, 120);
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
    });

    container.addEventListener('click', handleClick);
    container.addEventListener('keydown', handleKeyDown);

    return () => {
      cancelled = true;
      if (annotationDebounceRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(annotationDebounceRef.current);
      }
      annotationDebounceRef.current = null;
      observer.disconnect();
      container.removeEventListener('click', handleClick);
      container.removeEventListener('keydown', handleKeyDown);
    };
  }, [containerRef, editor, effectiveDirectory, files, preferRuntimeEditor, enabled]);
};

const useMermaidInlineInteractions = ({
  containerRef,
  mermaidBlocks,
  onShowPopup,
  allowWheelZoom,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  mermaidBlocks: string[];
  onShowPopup?: (content: ToolPopupContent) => void;
  allowWheelZoom?: boolean;
}) => {
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleMermaidClick = (event: MouseEvent) => {
      if (!onShowPopup) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest('button, a, [role="button"]')) {
        return;
      }

      const block = target.closest(MERMAID_BLOCK_SELECTOR);
      if (!block) {
        return;
      }

      const renderedBlocks = Array.from(container.querySelectorAll(MERMAID_BLOCK_SELECTOR));
      const blockIndex = renderedBlocks.indexOf(block);
      if (blockIndex < 0) {
        return;
      }

      const source = mermaidBlocks[blockIndex];
      if (!source || source.trim().length === 0) {
        return;
      }

      const filename = `Diagram ${blockIndex + 1}`;
      onShowPopup({
        open: true,
        title: filename,
        content: '',
        metadata: {
          tool: 'mermaid-preview',
          filename,
        },
        mermaid: {
          url: `data:text/plain;charset=utf-8,${encodeURIComponent(source)}`,
          source,
          filename,
        },
      });
    };

    const handleInlineWheel = (event: WheelEvent) => {
      if (allowWheelZoom) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const block = target.closest(MERMAID_BLOCK_SELECTOR);
      if (!block) {
        return;
      }

      // Keep regular page scroll while preventing Streamdown inline wheel-zoom handlers.
      event.stopPropagation();
    };

    container.addEventListener('click', handleMermaidClick);
    container.addEventListener('wheel', handleInlineWheel, { capture: true, passive: true });

    return () => {
      container.removeEventListener('click', handleMermaidClick);
      container.removeEventListener('wheel', handleInlineWheel, true);
    };
  }, [allowWheelZoom, containerRef, mermaidBlocks, onShowPopup]);
};

const MarkdownRendererImpl: React.FC<MarkdownRendererProps> = ({
  content,
  part,
  messageId,
  isAnimated = true,
  skipFadeIn = false,
  className,
  isStreaming = false,
  disableStreamAnimation = false,
  variant = 'assistant',
  onShowPopup,
  enableFileReferences = true,
}) => {
  const currentTheme = useCurrentMermaidTheme();
  const { editor, files, runtime } = useRuntimeAPIs();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const mermaidBlocks = React.useMemo(() => extractMermaidBlocks(content), [content]);
  useMermaidInlineInteractions({ containerRef, mermaidBlocks, onShowPopup });
  useFileReferenceInteractions({
    containerRef,
    effectiveDirectory,
    editor,
    files,
    preferRuntimeEditor: runtime.isVSCode,
    enabled: enableFileReferences && !isStreaming,
  });
  useExternalLinkInteractions({ containerRef });
  const openContextPreview = useUIStore((state) => state.openContextPreview);
  const { t } = useI18n();
  const handlePreviewLoopback = React.useCallback((url: string) => {
    if (!effectiveDirectory) return;
    openContextPreview(effectiveDirectory, url);
  }, [effectiveDirectory, openContextPreview]);
  const previewLabel = t('terminalView.preview.open');
  const previewTitle = t('terminalView.preview.openTitle');
  const syntaxTheme = React.useMemo(() => generateSyntaxTheme(currentTheme), [currentTheme]);
  const markdownComponents = React.useMemo(
    () => buildMarkdownComponents({
      syntaxTheme,
      onPreviewLoopback: effectiveDirectory ? handlePreviewLoopback : undefined,
      previewLabel,
      previewTitle,
    }),
    [syntaxTheme, effectiveDirectory, handlePreviewLoopback, previewLabel, previewTitle],
  );
  const componentKey = `markdown-${part?.id ? `part-${part.id}` : `message-${messageId}`}`;
  const markdownBlocks = useStableMarkdownBlocks(content, isStreaming && !disableStreamAnimation, componentKey);

  const markdownClassName = variant === 'tool'
    ? 'markdown-content markdown-tool'
    : variant === 'reasoning'
      ? 'markdown-content markdown-reasoning'
      : 'markdown-content leading-relaxed';

  const markdownContent = (
    <div className={cn('break-words w-full min-w-0', className)} ref={containerRef}>
      <div className={markdownClassName}>
        {markdownBlocks.map((block) => (
          <MarkdownBlockView key={block.key} block={block} components={markdownComponents} />
        ))}
      </div>
    </div>
  );

  if (isAnimated) {
    return (
      <FadeInOnReveal key={componentKey} skipAnimation={skipFadeIn}>
        {markdownContent}
      </FadeInOnReveal>
    );
  }

  return markdownContent;
};

export const MarkdownRenderer = React.memo(MarkdownRendererImpl, (prev, next) => {
  return prev.content === next.content
    && prev.isStreaming === next.isStreaming
    && prev.disableStreamAnimation === next.disableStreamAnimation
    && prev.variant === next.variant
    && prev.isAnimated === next.isAnimated
    && prev.skipFadeIn === next.skipFadeIn
    && prev.className === next.className
    && prev.messageId === next.messageId
    && prev.onShowPopup === next.onShowPopup
    && prev.part?.id === next.part?.id;
});

const SimpleMarkdownRendererImpl: React.FC<{
  content: string;
  className?: string;
  variant?: MarkdownVariant;
  disableLinkSafety?: boolean;
  stripFrontmatter?: boolean;
  onShowPopup?: (content: ToolPopupContent) => void;
  mermaidControls?: MermaidControlOptions;
  allowMermaidWheelZoom?: boolean;
  enableFileReferences?: boolean;
}> = ({
  content,
  className,
  variant = 'assistant',
  disableLinkSafety,
  stripFrontmatter = false,
  onShowPopup,
  allowMermaidWheelZoom = false,
  enableFileReferences = true,
}) => {
  const { editor, files, runtime } = useRuntimeAPIs();
  const renderedContent = React.useMemo(
    () => (stripFrontmatter ? stripLeadingFrontmatter(content) : content),
    [content, stripFrontmatter],
  );
  const currentTheme = useCurrentMermaidTheme();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const mermaidBlocks = React.useMemo(() => extractMermaidBlocks(renderedContent), [renderedContent]);
  useMermaidInlineInteractions({
    containerRef,
    mermaidBlocks,
    onShowPopup,
    allowWheelZoom: allowMermaidWheelZoom,
  });
  useFileReferenceInteractions({
    containerRef,
    effectiveDirectory,
    editor,
    files,
    preferRuntimeEditor: runtime.isVSCode,
    enabled: enableFileReferences,
  });
  useExternalLinkInteractions({ containerRef, enabled: !disableLinkSafety });
  const syntaxTheme = React.useMemo(() => generateSyntaxTheme(currentTheme), [currentTheme]);
  const markdownComponents = React.useMemo(() => buildMarkdownComponents({ syntaxTheme }), [syntaxTheme]);
  const markdownBlocks = useStableMarkdownBlocks(renderedContent, false, `simple:${variant}`);

  const markdownClassName = variant === 'tool'
    ? 'markdown-content markdown-tool'
    : variant === 'reasoning'
      ? 'markdown-content markdown-reasoning'
      : 'markdown-content leading-relaxed';

  return (
    <div className={cn('break-words w-full min-w-0', className)} ref={containerRef}>
      <div className={markdownClassName}>
        {markdownBlocks.map((block) => (
          <MarkdownBlockView key={block.key} block={block} components={markdownComponents} />
        ))}
      </div>
    </div>
  );
};

export const SimpleMarkdownRenderer = React.memo(SimpleMarkdownRendererImpl, (prev, next) => {
  return prev.content === next.content
    && prev.variant === next.variant
    && prev.className === next.className
    && prev.disableLinkSafety === next.disableLinkSafety
    && prev.stripFrontmatter === next.stripFrontmatter
    && prev.onShowPopup === next.onShowPopup
    && prev.allowMermaidWheelZoom === next.allowMermaidWheelZoom
    && prev.enableFileReferences === next.enableFileReferences;
});
