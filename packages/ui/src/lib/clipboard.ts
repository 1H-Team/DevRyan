import {
  recordProgrammaticCopy,
  suppressNextNativeCopy,
  type InteractionContext,
} from '@/lib/interactionAnalytics';

export type ClipboardCopyResult =
  | { ok: true; method: 'clipboard' | 'execCommand' }
  | { ok: false; error: string };

export async function copyTextToClipboard(
  text: string,
  analytics: InteractionContext = {},
): Promise<ClipboardCopyResult> {
  let clipboardError: string | null = null;

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      recordProgrammaticCopy(text, analytics);
      return { ok: true, method: 'clipboard' };
    } catch (error) {
      clipboardError = error instanceof Error ? error.message : String(error);
    }
  }

  if (typeof document !== 'undefined' && document.body) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.left = '-1000px';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    suppressNextNativeCopy();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);

    if (copied) {
      recordProgrammaticCopy(text, analytics);
      return { ok: true, method: 'execCommand' };
    }
  }

  return {
    ok: false,
    error: clipboardError ?? 'Clipboard access denied in current context',
  };
}

export async function copyRichTextToClipboard(
  text: string,
  html: string,
  analytics: InteractionContext = {},
): Promise<ClipboardCopyResult> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      recordProgrammaticCopy(text, analytics);
      return { ok: true, method: 'clipboard' };
    } catch {
      // Preserve plain-text copy semantics when rich clipboard access fails.
    }
  }
  return copyTextToClipboard(text, analytics);
}
