import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test';

const invokeDesktopCalls: Array<{ command: string; args?: Record<string, unknown> }> = [];
let invokeDesktopBehavior: () => Promise<unknown> = async () => null;

const invokeDesktopMock = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
  invokeDesktopCalls.push({ command, args });
  return invokeDesktopBehavior();
};

mock.module('@/lib/desktop', () => ({
  invokeDesktop: invokeDesktopMock,
}));

const {
  desktopAnnotationToFile,
  formatPreviewAnnotationMarkdown,
  isPreviewElementMetadata,
  renderPreviewScreenshot,
} = await import('@/lib/preview/screenshot-capture');

const sampleTarget = {
  frame: 'top' as const,
  tag: 'button',
  text: '  Save changes  ',
  selector: 'button.save',
  path: 'html > body > main > button.save',
  bounds: { x: 10.4, y: 20.6, width: 120.2, height: 32.8 },
  center: { x: 70.5, y: 37 },
  attributes: { type: 'submit', 'data-testid': 'save' },
  computedStyle: {
    display: 'inline-flex',
    position: 'relative',
    fontWeight: '600',
    fontSize: '14px',
    lineHeight: '20px',
    fontFamily: 'Inter',
    color: 'rgb(0, 0, 0)',
    backgroundColor: 'rgb(255, 255, 255)',
    zIndex: 'auto',
  },
  ancestry: [
    { tag: 'main', selectorPart: 'main' },
    { tag: 'button', className: 'save', selectorPart: 'button.save' },
  ],
};

describe('isPreviewElementMetadata', () => {
  test('accepts well-formed metadata', () => {
    expect(isPreviewElementMetadata(sampleTarget)).toBe(true);
  });

  test('rejects primitives, null, and missing fields', () => {
    expect(isPreviewElementMetadata(null)).toBe(false);
    expect(isPreviewElementMetadata('button')).toBe(false);
    expect(isPreviewElementMetadata({})).toBe(false);
    expect(isPreviewElementMetadata({ ...sampleTarget, selector: undefined })).toBe(false);
  });

  test('rejects malformed bounds', () => {
    expect(isPreviewElementMetadata({ ...sampleTarget, bounds: undefined })).toBe(false);
    expect(isPreviewElementMetadata({ ...sampleTarget, bounds: { x: 1, y: 2, width: '3', height: 4 } })).toBe(false);
  });
});

describe('formatPreviewAnnotationMarkdown', () => {
  const baseArgs = {
    pageUrl: 'http://127.0.0.1:3000/settings',
    viewport: { width: 1280, height: 800 },
    devicePixelRatio: 2,
    target: sampleTarget,
    screenshotAttached: true,
    intro: 'Annotated element (screenshot attached):',
  };

  test('renders the full annotation block with trimmed intro and text', () => {
    const output = formatPreviewAnnotationMarkdown(baseArgs);
    const lines = output.split('\n');

    expect(lines[0]).toBe('Annotated element (screenshot attached):');
    expect(output).toContain('Page: http://127.0.0.1:3000/settings');
    expect(output).toContain('Viewport: 1280x800, DPR 2');
    expect(output).toContain('Screenshot: attached');
    expect(output).toContain('Element: button');
    expect(output).toContain('Text: Save changes');
    expect(output).toContain('- Selector: button.save');
    expect(output).toContain('- Ancestry: main > button.save');
    expect(output).toContain('- Attributes: type="submit" data-testid="save"');
    expect(output).toContain('- Bounds: x=10, y=21, width=120, height=33');
    expect(output).toContain('- Center: x=71, y=37');
  });

  test('marks missing screenshots and omits empty optional lines', () => {
    const output = formatPreviewAnnotationMarkdown({
      ...baseArgs,
      screenshotAttached: false,
      target: { ...sampleTarget, text: '   ', attributes: {}, ancestry: [] },
    });

    expect(output).toContain('Screenshot: not attached');
    expect(output).not.toContain('Text:');
    expect(output).not.toContain('- Ancestry:');
    expect(output).not.toContain('- Attributes:');
  });

  test('falls back to a generic page label when the URL is empty', () => {
    const output = formatPreviewAnnotationMarkdown({ ...baseArgs, pageUrl: '' });
    expect(output).toContain('Page: preview');
  });
});

describe('renderPreviewScreenshot fallback order', () => {
  const hadWindow = 'window' in globalThis;
  const previousWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    invokeDesktopCalls.length = 0;
    invokeDesktopBehavior = async () => null;
  });

  afterEach(() => {
    if (hadWindow) (globalThis as { window?: unknown }).window = previousWindow;
    else delete (globalThis as { window?: unknown }).window;
  });

  const fakeIframe = {
    contentWindow: null,
    contentDocument: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  } as unknown as HTMLIFrameElement;

  test('returns null without trying any strategy when window is unavailable', async () => {
    delete (globalThis as { window?: unknown }).window;

    const result = await renderPreviewScreenshot(fakeIframe, sampleTarget);

    expect(result).toBeNull();
    expect(invokeDesktopCalls.length).toBe(0);
  });

  test('tries the native desktop strategy first, then continues to DOM capture on null', async () => {
    (globalThis as { window?: unknown }).window = {};

    const result = await renderPreviewScreenshot(fakeIframe, sampleTarget);

    // Native returned null; both DOM strategies bail on the detached iframe.
    expect(result).toBeNull();
    expect(invokeDesktopCalls.length).toBe(1);
    expect(invokeDesktopCalls[0]?.command).toBe('desktop_capture_page_rect');
  });

  test('recovers from a throwing native strategy instead of propagating', async () => {
    (globalThis as { window?: unknown }).window = {};
    invokeDesktopBehavior = async () => { throw new Error('IPC not available for this origin'); };

    const result = await renderPreviewScreenshot(fakeIframe, sampleTarget);

    expect(result).toBeNull();
    expect(invokeDesktopCalls.length).toBe(1);
  });
});

describe('desktopAnnotationToFile input handling', () => {
  test('returns null for an empty base64 payload', async () => {
    expect(await desktopAnnotationToFile('', 100, 100, 100, 100, sampleTarget)).toBeNull();
  });

  test('returns null instead of throwing when no DOM image support exists', async () => {
    expect(await desktopAnnotationToFile('not-a-real-jpeg', 100, 100, 100, 100, sampleTarget)).toBeNull();
  });
});
