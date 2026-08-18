import { rangeToMarkdown, wrapSelectionMarkdownForComposer } from './selectionMarkdown';

const MESSAGE_SELECTOR = '[data-chat-message="true"]';
const IGNORED_SELECTOR = [
  '.terminal-viewport-container',
  '[data-terminal-hidden-input="true"]',
  '[role="dialog"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="select-content"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[data-radix-popper-content-wrapper]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
].join(',');

export interface SendSelectionToComposerOptions {
  activeMainTab: string;
  eventTarget: EventTarget | null;
  append: (text: string) => void;
  documentRef?: Document;
  windowRef?: Window;
}

const elementForNode = (node: Node | null): Element | null => {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
};

const isUnrelatedFormControl = (element: Element): boolean => {
  if (element.matches('input[type="password"], input, textarea, select, button')) {
    return true;
  }
  return element.matches('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
};

const focusComposer = (composer: HTMLTextAreaElement, moveCaretToEnd: boolean): void => {
  try {
    composer.focus({ preventScroll: true });
  } catch {
    composer.focus();
  }

  if (!moveCaretToEnd) return;
  const end = composer.value.length;
  composer.setSelectionRange(end, end);
};

export const sendSelectionToComposer = ({
  activeMainTab,
  eventTarget,
  append,
  documentRef = document,
  windowRef = window,
}: SendSelectionToComposerOptions): boolean => {
  if (activeMainTab !== 'chat') return false;

  const surface = documentRef.querySelector<HTMLElement>('[data-chat-surface="true"]');
  const composer = surface?.querySelector<HTMLTextAreaElement>('textarea[data-chat-input="true"]') ?? null;
  if (!surface || !composer || composer.disabled || composer.getClientRects().length === 0) {
    return false;
  }

  const target = eventTarget instanceof Element ? eventTarget : null;
  if (target === composer || (target && composer.contains(target))) {
    focusComposer(composer, false);
    return true;
  }
  if (target?.closest(IGNORED_SELECTOR) || (target && isUnrelatedFormControl(target))) {
    return false;
  }
  if (target && target !== documentRef.body && target !== documentRef.documentElement && !surface.contains(target)) {
    return false;
  }

  const selection = windowRef.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !selection.toString().trim()) {
    focusComposer(composer, false);
    return true;
  }

  const range = selection.getRangeAt(0);
  const selectionElement = elementForNode(range.commonAncestorContainer);
  if (selectionElement && (selectionElement === composer || composer.contains(selectionElement))) {
    focusComposer(composer, false);
    return true;
  }
  if (!selectionElement || selectionElement.closest(IGNORED_SELECTOR)) {
    return false;
  }

  const message = selectionElement.closest<HTMLElement>(MESSAGE_SELECTOR);
  if (!message || !surface.contains(message)) {
    return false;
  }

  const markdown = rangeToMarkdown(range, selection.toString());
  if (!markdown) return false;

  append(wrapSelectionMarkdownForComposer(markdown));
  selection.removeAllRanges();
  windowRef.requestAnimationFrame(() => {
    windowRef.requestAnimationFrame(() => focusComposer(composer, true));
  });
  return true;
};
