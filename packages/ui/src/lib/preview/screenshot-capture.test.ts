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
  normalizePreviewOuterHTML,
  renderPreviewScreenshot,
  resolvePreviewElementCropRect,
  resolvePreviewElementPixelCrop,
} = await import('@/lib/preview/screenshot-capture');

const sampleTarget = {
  frame: 'top' as const,
  tag: 'button',
  text: '  Save changes  ',
  outerHTML: '<button type="submit" data-testid="save">Save changes</button>',
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
    expect(isPreviewElementMetadata({ ...sampleTarget, outerHTML: 'x'.repeat(6_001) })).toBe(false);
    expect(isPreviewElementMetadata({ ...sampleTarget, ancestry: [{ selectorPart: 42 }] })).toBe(false);
  });

  test('rejects malformed bounds', () => {
    expect(isPreviewElementMetadata({ ...sampleTarget, bounds: undefined })).toBe(false);
    expect(isPreviewElementMetadata({ ...sampleTarget, bounds: { x: 1, y: 2, width: '3', height: 4 } })).toBe(false);
    expect(isPreviewElementMetadata({ ...sampleTarget, bounds: { x: Number.NaN, y: 2, width: 3, height: 4 } })).toBe(false);
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
    expect(output).toContain('Rendered HTML:\n```html\n<button type="submit" data-testid="save">Save changes</button>\n```');
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

  test('uses a safe fence when rendered markup contains backtick runs', () => {
    const output = formatPreviewAnnotationMarkdown({
      ...baseArgs,
      target: { ...sampleTarget, outerHTML: '<code>```example```</code>' },
    });

    expect(output).toContain('````html\n<code>```example```</code>\n````');
  });

  test('omits rendered markup when it is empty', () => {
    const output = formatPreviewAnnotationMarkdown({
      ...baseArgs,
      target: { ...sampleTarget, outerHTML: '   ' },
    });

    expect(output).not.toContain('Rendered HTML:');
  });
});

describe('preview element crop geometry', () => {
  test('adds padding around fractional bounds', () => {
    expect(resolvePreviewElementCropRect({
      bounds: { x: 40.4, y: 50.6, width: 100.2, height: 30.1 },
      viewportWidth: 800,
      viewportHeight: 600,
    })).toEqual({ x: 28, y: 38, width: 125, height: 55 });
  });

  test('clamps padding at viewport edges and crops oversized elements to the visible area', () => {
    expect(resolvePreviewElementCropRect({
      bounds: { x: -20, y: -10, width: 900, height: 650 },
      viewportWidth: 800,
      viewportHeight: 600,
    })).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  test('rejects invalid, empty, and offscreen bounds', () => {
    expect(resolvePreviewElementCropRect({ bounds: { x: 900, y: 0, width: 20, height: 20 }, viewportWidth: 800, viewportHeight: 600 })).toBeNull();
    expect(resolvePreviewElementCropRect({ bounds: { x: 1, y: 1, width: 0, height: 20 }, viewportWidth: 800, viewportHeight: 600 })).toBeNull();
    expect(resolvePreviewElementCropRect({ bounds: { x: Number.NaN, y: 1, width: 20, height: 20 }, viewportWidth: 800, viewportHeight: 600 })).toBeNull();
  });

  test('maps CSS coordinates to DPR 2 pixels', () => {
    expect(resolvePreviewElementPixelCrop({
      bounds: { x: 40, y: 50, width: 100, height: 30 },
      viewportWidth: 800,
      viewportHeight: 600,
      imageWidth: 1600,
      imageHeight: 1200,
    })).toEqual({ x: 56, y: 76, width: 248, height: 108 });
  });

  test('supports non-uniform image scaling', () => {
    expect(resolvePreviewElementPixelCrop({
      bounds: { x: 100, y: 100, width: 200, height: 100 },
      viewportWidth: 1000,
      viewportHeight: 500,
      imageWidth: 2000,
      imageHeight: 1500,
      padding: 0,
    })).toEqual({ x: 200, y: 300, width: 400, height: 300 });
  });
});

describe('normalizePreviewOuterHTML', () => {
  test('removes null bytes, trims, and caps markup', () => {
    expect(normalizePreviewOuterHTML('  <div>\0safe</div>  ')).toBe('<div>safe</div>');
    const longMarkup = `<div>${'x'.repeat(7_000)}</div>`;
    const normalized = normalizePreviewOuterHTML(longMarkup);
    expect(normalized.length).toBe(6_000);
    expect(normalized.endsWith('…')).toBe(true);
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
