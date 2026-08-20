import { invokeDesktop } from '@/lib/desktop';

// Cross-runtime annotation screenshot capture for the preview/browser panes.
//
// Capture order (each strategy hands off on null/throw):
//   1. Native desktop capture (`desktop_capture_page_rect` via the desktop shim)
//   2. snapDOM DOM capture (fixed-element pinning + nested-scroll re-bake)
//   3. html-to-image fallback
// `null` is returned only after every applicable strategy failed.
//
// Deliberately excluded from this module (adapted from openchamber ref commit
// 2c23bc36): proxy-target caching, URL-token handling, and external-resource
// proxy registration. The fork's preview proxy is loopback-only with an
// HttpOnly cookie model; cross-origin assets degrade to a transparent
// placeholder instead of being proxied.

export type PreviewElementMetadata = {
  frame: 'top';
  tag: string;
  text: string;
  outerHTML: string;
  selector: string;
  path: string;
  bounds: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
  attributes: Record<string, string>;
  computedStyle: Record<string, string>;
  ancestry: Array<{ tag: string; id?: string; className?: string; selectorPart: string }>;
};

const MAX_PREVIEW_OUTER_HTML_LENGTH = 6_000;
export const PREVIEW_ANNOTATION_CROP_PADDING = 12;

export const isPreviewElementMetadata = (value: unknown): value is PreviewElementMetadata => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PreviewElementMetadata>;
  const bounds = record.bounds;
  const center = record.center;
  return typeof record.tag === 'string'
    && typeof record.text === 'string'
    && typeof record.outerHTML === 'string'
    && record.outerHTML.length <= MAX_PREVIEW_OUTER_HTML_LENGTH
    && typeof record.selector === 'string'
    && typeof record.path === 'string'
    && Boolean(bounds)
    && [bounds?.x, bounds?.y, bounds?.width, bounds?.height, center?.x, center?.y].every(Number.isFinite)
    && Boolean(record.attributes) && typeof record.attributes === 'object'
    && Boolean(record.computedStyle) && typeof record.computedStyle === 'object'
    && Array.isArray(record.ancestry)
    && record.ancestry.every((entry) => Boolean(entry) && typeof entry.selectorPart === 'string');
};

export const normalizePreviewOuterHTML = (value: string): string => {
  const normalized = value.replace(/\0/g, '').trim();
  if (normalized.length <= MAX_PREVIEW_OUTER_HTML_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_PREVIEW_OUTER_HTML_LENGTH - 1)}…`;
};

const fencedHtml = (value: string): string | null => {
  const markup = normalizePreviewOuterHTML(value);
  if (!markup) return null;
  const longestBacktickRun = Math.max(0, ...(markup.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return [`${fence}html`, markup, fence].join('\n');
};

export type PreviewElementCropRect = { x: number; y: number; width: number; height: number };

export const resolvePreviewElementCropRect = ({
  bounds,
  viewportWidth,
  viewportHeight,
  padding = PREVIEW_ANNOTATION_CROP_PADDING,
}: {
  bounds: PreviewElementMetadata['bounds'];
  viewportWidth: number;
  viewportHeight: number;
  padding?: number;
}): PreviewElementCropRect | null => {
  if (![bounds.x, bounds.y, bounds.width, bounds.height, viewportWidth, viewportHeight, padding].every(Number.isFinite)) return null;
  if (bounds.width <= 0 || bounds.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return null;

  const visibleLeft = Math.max(0, bounds.x);
  const visibleTop = Math.max(0, bounds.y);
  const visibleRight = Math.min(viewportWidth, bounds.x + bounds.width);
  const visibleBottom = Math.min(viewportHeight, bounds.y + bounds.height);
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return null;

  const x = Math.max(0, Math.floor(visibleLeft - Math.max(0, padding)));
  const y = Math.max(0, Math.floor(visibleTop - Math.max(0, padding)));
  const right = Math.min(viewportWidth, Math.ceil(visibleRight + Math.max(0, padding)));
  const bottom = Math.min(viewportHeight, Math.ceil(visibleBottom + Math.max(0, padding)));
  return { x, y, width: right - x, height: bottom - y };
};

export const resolvePreviewElementPixelCrop = ({
  bounds,
  viewportWidth,
  viewportHeight,
  imageWidth,
  imageHeight,
  padding = PREVIEW_ANNOTATION_CROP_PADDING,
}: {
  bounds: PreviewElementMetadata['bounds'];
  viewportWidth: number;
  viewportHeight: number;
  imageWidth: number;
  imageHeight: number;
  padding?: number;
}): PreviewElementCropRect | null => {
  if (![imageWidth, imageHeight].every(Number.isFinite) || imageWidth <= 0 || imageHeight <= 0) return null;
  const crop = resolvePreviewElementCropRect({ bounds, viewportWidth, viewportHeight, padding });
  if (!crop) return null;
  const xScale = imageWidth / viewportWidth;
  const yScale = imageHeight / viewportHeight;
  const x = Math.max(0, Math.floor(crop.x * xScale));
  const y = Math.max(0, Math.floor(crop.y * yScale));
  const right = Math.min(imageWidth, Math.ceil((crop.x + crop.width) * xScale));
  const bottom = Math.min(imageHeight, Math.ceil((crop.y + crop.height) * yScale));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
};

export const formatPreviewAnnotationMarkdown = ({
  pageUrl,
  viewport,
  devicePixelRatio,
  target,
  screenshotAttached,
  intro,
}: {
  pageUrl: string;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  target: PreviewElementMetadata;
  screenshotAttached: boolean;
  intro: string;
}): string => {
  const text = target.text.trim();
  const attributes = Object.entries(target.attributes)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
  const styles = target.computedStyle;
  const bounds = target.bounds;
  const center = target.center;
  const introLabel = intro.replace(/[.:]+$/g, '');
  const ancestry = target.ancestry
    .map((entry) => entry.selectorPart)
    .join(' > ');
  const markup = fencedHtml(target.outerHTML);

  return [
    `${introLabel}:`,
    `Page: ${pageUrl || 'preview'}`,
    `Viewport: ${viewport.width}x${viewport.height}, DPR ${devicePixelRatio}`,
    `Screenshot: ${screenshotAttached ? 'attached' : 'not attached'}`,
    `Element: ${target.tag}`,
    text ? `Text: ${text}` : null,
    `- Selector: ${target.selector}`,
    `- Path: ${target.path}`,
    ancestry ? `- Ancestry: ${ancestry}` : null,
    attributes ? `- Attributes: ${attributes}` : null,
    `- Bounds: x=${Math.round(bounds.x)}, y=${Math.round(bounds.y)}, width=${Math.round(bounds.width)}, height=${Math.round(bounds.height)}`,
    `- Center: x=${Math.round(center.x)}, y=${Math.round(center.y)}`,
    `Styles: display=${styles.display}; position=${styles.position}; font=${styles.fontWeight} ${styles.fontSize} / ${styles.lineHeight} ${styles.fontFamily}; color=${styles.color}; background=${styles.backgroundColor}; z-index=${styles.zIndex}`,
    markup ? 'Rendered HTML:' : null,
    markup,
  ].filter((line): line is string => typeof line === 'string').join('\n');
};

const refreshPreviewTargetBounds = (
  iframe: HTMLIFrameElement,
  target: PreviewElementMetadata,
): PreviewElementMetadata => {
  try {
    const element = iframe.contentDocument?.querySelector(target.selector);
    if (!element || typeof element.getBoundingClientRect !== 'function') return target;
    const rect = element.getBoundingClientRect();
    return {
      ...target,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      outerHTML: normalizePreviewOuterHTML(element.outerHTML || target.outerHTML),
    };
  } catch {
    return target;
  }
};

const captureNativeDesktopScreenshot = async (
  iframe: HTMLIFrameElement,
  target: PreviewElementMetadata,
): Promise<File | null> => {
  try {
    const rect = iframe.getBoundingClientRect();
    const capture = await invokeDesktop<{ mime: string; base64: string; width: number; height: number }>('desktop_capture_page_rect', {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
    if (!capture) return null;
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Failed to load desktop preview screenshot'));
      image.src = `data:${capture.mime};base64,${capture.base64}`;
    });

    const width = Math.max(1, image.naturalWidth || capture.width || Math.floor(rect.width));
    const height = Math.max(1, image.naturalHeight || capture.height || Math.floor(rect.height));
    const cssWidth = iframe.contentWindow?.innerWidth || iframe.clientWidth || rect.width;
    const cssHeight = iframe.contentWindow?.innerHeight || iframe.clientHeight || rect.height;
    return desktopAnnotationToFile(capture.base64, width, height, cssWidth, cssHeight, target, capture.mime);
  } catch (error) {
    console.warn('[preview] failed to capture native annotation screenshot:', error);
    return null;
  }
};

export const renderPreviewScreenshot = async (
  iframe: HTMLIFrameElement,
  target: PreviewElementMetadata,
): Promise<File | null> => {
  if (typeof window === 'undefined') return null;
  const refreshedTarget = refreshPreviewTargetBounds(iframe, target);
  const native = await captureNativeDesktopScreenshot(iframe, refreshedTarget);
  if (native) return native;
  return captureIframeDomScreenshot(iframe, refreshedTarget);
};

export const desktopAnnotationToFile = async (
  base64: string,
  screenshotWidth: number,
  screenshotHeight: number,
  cssWidth: number,
  cssHeight: number,
  target: PreviewElementMetadata,
  mime = 'image/jpeg',
): Promise<File | null> => {
  if (!base64) return null;
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Failed to load desktop browser screenshot'));
      image.src = `data:${mime};base64,${base64}`;
    });

    const width = Math.max(1, image.naturalWidth || screenshotWidth);
    const height = Math.max(1, image.naturalHeight || screenshotHeight);
    const crop = resolvePreviewElementPixelCrop({
      bounds: target.bounds,
      viewportWidth: cssWidth || width,
      viewportHeight: cssHeight || height,
      imageWidth: width,
      imageHeight: height,
    });
    if (!crop) return null;
    const canvas = document.createElement('canvas');
    canvas.width = crop.width;
    canvas.height = crop.height;
    const context = canvas.getContext('2d');
    if (!context) return null;

    context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return null;
    return new File([blob], `browser-annotation-${Date.now()}.png`, { type: 'image/png' });
  } catch {
    return null;
  }
};

const TRANSPARENT_IMAGE_PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function getCaptureBackgroundColor(document: Document): string {
  const fallback = '#ffffff';
  const view = document.defaultView ?? window;
  try {
    const bodyColor = document.body ? view.getComputedStyle(document.body).backgroundColor : '';
    if (bodyColor && bodyColor !== 'rgba(0, 0, 0, 0)' && bodyColor !== 'transparent') return bodyColor;

    const rootColor = view.getComputedStyle(document.documentElement).backgroundColor;
    if (rootColor && rootColor !== 'rgba(0, 0, 0, 0)' && rootColor !== 'transparent') return rootColor;
  } catch {
    // Ignore style access failures and use a stable background.
  }
  return fallback;
}

const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : TRANSPARENT_IMAGE_PLACEHOLDER);
  reader.onerror = () => reject(reader.error ?? new Error('Failed to read image blob'));
  reader.readAsDataURL(blob);
});

const canvasToJpegBase64 = async (canvas: HTMLCanvasElement, quality = 0.82): Promise<string> => {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) return '';
  return (await blobToDataUrl(blob)).split(',', 2)[1] || '';
};

const isPreviewCaptureDebugEnabled = (): boolean => {
  try {
    return Boolean((window as unknown as { __previewCaptureDebug?: boolean }).__previewCaptureDebug);
  } catch {
    return false;
  }
};

const previewCaptureDebug = (...args: unknown[]): void => {
  if (!isPreviewCaptureDebugEnabled()) return;
  console.info('[preview-capture]', ...args);
};

type ScrolledElementInfo = {
  selector: string;
  scrollTop: number;
  scrollLeft: number;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
};

const describeScrolledElements = (doc: Document, limit = 8): ScrolledElementInfo[] => {
  const found: ScrolledElementInfo[] = [];
  try {
    const all = doc.querySelectorAll<HTMLElement>('*');
    for (const el of all) {
      const scrollTop = el.scrollTop || 0;
      const scrollLeft = el.scrollLeft || 0;
      if (scrollTop <= 0 && scrollLeft <= 0) continue;
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls = typeof el.className === 'string' && el.className
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
      found.push({
        selector: `${tag}${id}${cls}`,
        scrollTop,
        scrollLeft,
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
        scrollWidth: el.scrollWidth,
        scrollHeight: el.scrollHeight,
      });
      if (found.length >= limit) break;
    }
  } catch { /* best-effort diagnostics */ }
  return found;
};

const FIXED_PIN_ATTR = 'data-oc-fixed-pin';

// snapDOM repositions `position: sticky` (freezeSticky) but leaves `position: fixed`
// alone. In the full-document SVG foreignObject a fixed element resolves against the
// document box, not the viewport — so `top`/`bottom` anchors and sizes are wrong
// (e.g. a `top:nav; bottom:0` sidebar stretches to the full doc height) and cropping
// shifts/clips it. We can't fix this by mutating the LIVE element: changing its
// position/height resets the scrollTop of any overflow container (the sidebar jumps
// to the top during capture). Instead we only *tag* fixed elements here — a plain
// attribute write that never resets scroll — recording their measured viewport rect
// in document coordinates. The actual repositioning happens on snapDOM's CLONE via
// the afterClone plugin below, leaving the live DOM (and its scroll) untouched.
const tagFixedElementsForClonePinning = (doc: Document, scrollX: number, scrollY: number): (() => void) => {
  if (scrollX <= 0 && scrollY <= 0) return () => { /* nothing scrolled */ };
  const view = doc.defaultView;
  if (!view) return () => { /* no view */ };
  const tagged: HTMLElement[] = [];
  const debugInfo: Array<Record<string, number | string>> = [];
  try {
    for (const el of doc.querySelectorAll<HTMLElement>('*')) {
      if (view.getComputedStyle(el).position !== 'fixed') continue;
      const rect = el.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) continue;
      el.setAttribute(FIXED_PIN_ATTR, JSON.stringify({
        top: rect.top + scrollY,
        left: rect.left + scrollX,
        width: rect.width,
        height: rect.height,
      }));
      tagged.push(el);
      const tag = el.tagName.toLowerCase();
      const cls = typeof el.className === 'string' && el.className
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
      debugInfo.push({ selector: `${tag}${cls}`, top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) });
    }
  } catch { /* best-effort: leave fixed elements untagged */ }
  previewCaptureDebug('tagged fixed elements', debugInfo);
  return () => {
    for (const el of tagged) {
      try { el.removeAttribute(FIXED_PIN_ATTR); } catch { /* best-effort */ }
    }
  };
};

// Runs inside snapDOM after the clone is built (and after prepareClone has baked
// nested scroll via translate). We re-anchor tagged fixed elements on the CLONE to
// their measured viewport rect in document coordinates, so cropping at the scroll
// offset lands them in the right place at the right size — without ever touching the
// live DOM. snapDOM's own scroll-translate wrapper on the clone is preserved, so the
// sidebar's internal scroll position stays baked in.
const snapdomFixedPinPlugin = {
  name: 'oc-fixed-pin',
  afterClone(context: { clone?: Element | null }): void {
    const clone = context?.clone;
    if (!clone || typeof (clone as Element).querySelectorAll !== 'function') return;
    for (const el of (clone as Element).querySelectorAll<HTMLElement>(`[${FIXED_PIN_ATTR}]`)) {
      let spec: { top: number; left: number; width: number; height: number };
      try { spec = JSON.parse(el.getAttribute(FIXED_PIN_ATTR) || ''); } catch { continue; }
      el.style.setProperty('position', 'absolute', 'important');
      el.style.setProperty('top', `${spec.top}px`, 'important');
      el.style.setProperty('left', `${spec.left}px`, 'important');
      el.style.setProperty('right', 'auto', 'important');
      el.style.setProperty('bottom', 'auto', 'important');
      el.style.setProperty('width', `${spec.width}px`, 'important');
      el.style.setProperty('height', `${spec.height}px`, 'important');
      el.removeAttribute(FIXED_PIN_ATTR);
    }
  },
};

const NESTED_SCROLL_ATTR = 'data-oc-scroll-pin';

// Preparing the capture (asset inlining, layout reflows) resets the scrollTop of
// overflow containers like a fixed docs sidebar. snapDOM bakes nested scroll into
// the clone using the LIVE scrollTop *at clone time* — which by then has been reset
// to 0, so the sidebar renders from the top. We can't reliably keep the live scroll
// pinned through async asset inlining, so instead we snapshot each container's
// scroll up front (reliable values) and tag it with a data attribute.
// snapdomNestedScrollPlugin.afterClone then re-bakes the scroll on the CLONE from
// these snapshot values, independent of whatever the live scrollTop was. We skip the
// root/body — document scroll is handled by the viewport crop, not by baking.
const captureNestedScrollState = (doc: Document): { reapply: () => void; cleanup: () => void; snapshot: ScrolledElementInfo[] } => {
  const entries: Array<{ el: HTMLElement; top: number; left: number; tagged: boolean }> = [];
  const snapshot = describeScrolledElements(doc, 64);
  try {
    const root = doc.documentElement;
    const body = doc.body;
    for (const el of doc.querySelectorAll<HTMLElement>('*')) {
      const top = el.scrollTop || 0;
      const left = el.scrollLeft || 0;
      if (top <= 0 && left <= 0) continue;
      const tagged = el !== root && el !== body;
      if (tagged) el.setAttribute(NESTED_SCROLL_ATTR, JSON.stringify({ top, left }));
      entries.push({ el, top, left, tagged });
    }
  } catch { /* best-effort: no nested scroll preservation */ }
  const reapply = () => {
    for (const entry of entries) {
      try {
        void entry.el.scrollHeight;
        if (entry.el.scrollTop !== entry.top) entry.el.scrollTop = entry.top;
        if (entry.el.scrollLeft !== entry.left) entry.el.scrollLeft = entry.left;
      } catch { /* best-effort restore */ }
    }
  };
  const cleanup = () => {
    for (const entry of entries) {
      if (!entry.tagged) continue;
      try { entry.el.removeAttribute(NESTED_SCROLL_ATTR); } catch { /* best-effort */ }
    }
  };
  return { reapply, cleanup, snapshot };
};

// Re-bake nested scroll on the clone from the reliable snapshot values (see above).
// snapDOM wraps a scrolled element's children in a single inner div with
// `transform: translate(...)` + `will-change: transform`. We override that transform
// when present, or create the wrapper ourselves if snapDOM saw scrollTop 0 at clone
// time. Runs after the fixed-pin pass so sidebar gets both correct box and scroll.
const snapdomNestedScrollPlugin = {
  name: 'oc-nested-scroll',
  afterClone(context: { clone?: Element | null }): void {
    const clone = context?.clone;
    if (!clone || typeof (clone as Element).querySelectorAll !== 'function') return;
    const ownerDoc = (clone as Element).ownerDocument;
    if (!ownerDoc) return;
    for (const el of (clone as Element).querySelectorAll<HTMLElement>(`[${NESTED_SCROLL_ATTR}]`)) {
      let spec: { top: number; left: number };
      try { spec = JSON.parse(el.getAttribute(NESTED_SCROLL_ATTR) || ''); } catch { el.removeAttribute(NESTED_SCROLL_ATTR); continue; }
      const transform = `translate(${-spec.left}px, ${-spec.top}px)`;
      const existingWrapper = el.children.length === 1 && el.firstElementChild instanceof HTMLElement && el.firstElementChild.style.willChange === 'transform'
        ? el.firstElementChild
        : null;
      if (existingWrapper) {
        existingWrapper.style.transform = transform;
      } else {
        el.style.overflow = 'hidden';
        const inner = ownerDoc.createElement('div');
        inner.style.transform = transform;
        inner.style.willChange = 'transform';
        inner.style.display = 'inline-block';
        inner.style.width = '100%';
        while (el.firstChild) inner.appendChild(el.firstChild);
        el.appendChild(inner);
      }
      el.removeAttribute(NESTED_SCROLL_ATTR);
    }
  },
};

const fetchUrlAsDataUrl = async (url: string, credentials: RequestCredentials): Promise<string | null> => {
  try {
    const response = await fetch(url, { credentials });
    if (!response.ok) return null;
    return await blobToDataUrl(await response.blob());
  } catch {
    return null;
  }
};

// Same-origin (proxied) resources are inlined with credentials so the preview
// cookie rides along. Cross-origin resources get one direct CORS attempt and
// otherwise degrade to a transparent placeholder — this fork deliberately does
// not register external proxy targets for capture (loopback-only proxy model).
const fetchFrameResourceAsDataUrl = async (rawUrl: string, document: Document): Promise<string> => {
  if (!rawUrl || rawUrl.startsWith('data:')) return rawUrl;

  try {
    const url = new URL(rawUrl, document.baseURI);
    if (url.origin === window.location.origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      return await fetchUrlAsDataUrl(url.toString(), 'include') ?? TRANSPARENT_IMAGE_PLACEHOLDER;
    }

    return await fetchUrlAsDataUrl(url.toString(), 'omit') ?? TRANSPARENT_IMAGE_PLACEHOLDER;
  } catch {
    return TRANSPARENT_IMAGE_PLACEHOLDER;
  }
};

const inlineCssImageUrls = async (value: string, document: Document): Promise<string> => {
  if (!value || value === 'none' || !value.includes('url(')) return value;

  const matches = Array.from(value.matchAll(/url\((['"]?)(.*?)\1\)/g));
  let nextValue = value;
  for (const match of matches) {
    const rawUrl = match[2] || '';
    if (!rawUrl || rawUrl.startsWith('data:')) continue;
    const dataUrl = await fetchFrameResourceAsDataUrl(rawUrl, document);
    nextValue = nextValue.replace(match[0], `url("${dataUrl}")`);
  }
  return nextValue;
};

const waitForImage = (image: HTMLImageElement): Promise<void> => {
  if (image.complete) return Promise.resolve();
  return new Promise((resolve) => {
    image.addEventListener('load', () => resolve(), { once: true });
    image.addEventListener('error', () => resolve(), { once: true });
  });
};

const getElementStyleRestore = (element: HTMLElement): (() => void) => {
  const cssText = element.style.cssText;
  return () => { element.style.cssText = cssText; };
};

const getLineHeight = (style: CSSStyleDeclaration): number => {
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;
  const fontSize = Number.parseFloat(style.fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.2 : 16;
};

const preserveSingleLineTextElements = (
  document: Document,
  viewportWidth: number,
  viewportHeight: number,
): (() => void) => {
  const restoreCallbacks: Array<() => void> = [];
  const view = document.defaultView ?? window;
  const controlsSelector = 'button, a, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="tab"], nav *, header *';
  const elements = Array.from(document.querySelectorAll<HTMLElement>(controlsSelector));

  for (const element of elements) {
    const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    if (!text || !text.includes(' ')) continue;

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.right < 0 || rect.bottom < 0 || rect.left > viewportWidth || rect.top > viewportHeight) continue;

    const style = view.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;

    const textWrap = style.getPropertyValue('text-wrap');
    const textWrapMode = style.getPropertyValue('text-wrap-mode');
    const alreadyNoWrap = style.whiteSpace.includes('nowrap') || textWrap === 'nowrap' || textWrapMode === 'nowrap';
    const isSingleLine = rect.height <= getLineHeight(style) * 1.7;
    if (!alreadyNoWrap && (!isSingleLine || rect.width > viewportWidth * 0.72)) continue;

    restoreCallbacks.push(getElementStyleRestore(element));
    element.style.whiteSpace = 'nowrap';
    element.style.overflowWrap = 'normal';
    element.style.wordBreak = 'normal';
    element.style.setProperty('text-wrap', 'nowrap');
    element.style.setProperty('text-wrap-mode', 'nowrap');
  }

  return () => {
    for (let index = restoreCallbacks.length - 1; index >= 0; index -= 1) {
      restoreCallbacks[index]?.();
    }
  };
};

const freezeViewportPositionedElements = (
  document: Document,
  viewportWidth: number,
  viewportHeight: number,
  frozenElements?: WeakSet<HTMLElement>,
): (() => void) => {
  const restoreCallbacks: Array<() => void> = [];
  const view = document.defaultView ?? window;
  const scrollX = view.scrollX || document.documentElement.scrollLeft || document.body?.scrollLeft || 0;
  const scrollY = view.scrollY || document.documentElement.scrollTop || document.body?.scrollTop || 0;
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('*'))
    .filter((element) => {
      const style = view.getComputedStyle(element);
      if (style.position !== 'fixed') return false;
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0
        && rect.height > 0
        && rect.right >= 0
        && rect.bottom >= 0
        && rect.left <= viewportWidth
        && rect.top <= viewportHeight;
    })
    .filter((element, index, elements) => {
      return !elements.some((candidate, candidateIndex) => candidateIndex < index && candidate.contains(element));
    });

  for (const element of candidates) {
    const rect = element.getBoundingClientRect();
    const computed = view.getComputedStyle(element);
    const borderBoxWidth = Math.ceil(rect.width) + 8;
    const borderBoxHeight = Math.ceil(rect.height) + 2;
    frozenElements?.add(element);
    restoreCallbacks.push(getElementStyleRestore(element));
    element.style.position = 'absolute';
    element.style.top = `${rect.top + scrollY}px`;
    element.style.left = `${rect.left + scrollX}px`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
    element.style.width = `${borderBoxWidth}px`;
    element.style.minWidth = `${borderBoxWidth}px`;
    element.style.height = `${borderBoxHeight}px`;
    element.style.minHeight = `${borderBoxHeight}px`;
    element.style.margin = '0';
    element.style.boxSizing = 'border-box';
    element.style.transform = 'none';
    if (computed.zIndex !== 'auto') element.style.zIndex = computed.zIndex;
  }

  return () => {
    for (let index = restoreCallbacks.length - 1; index >= 0; index -= 1) {
      restoreCallbacks[index]?.();
    }
  };
};

const inlineIframeCaptureAssets = async (
  document: Document,
  viewportWidth: number,
  viewportHeight: number,
  options: { applyLayoutWorkarounds?: boolean } = {},
): Promise<() => void> => {
  const restoreCallbacks: Array<() => void> = [];
  const view = document.defaultView ?? window;
  const isVisibleInViewport = (element: Element): boolean => {
    if (element === document.documentElement || element === document.body) return true;
    try {
      const rect = element.getBoundingClientRect();
      return rect.width > 0
        && rect.height > 0
        && rect.right >= 0
        && rect.bottom >= 0
        && rect.left <= viewportWidth
        && rect.top <= viewportHeight;
    } catch {
      return false;
    }
  };

  if (options.applyLayoutWorkarounds) {
    const frozenElements = new WeakSet<HTMLElement>();
    restoreCallbacks.push(freezeViewportPositionedElements(document, viewportWidth, viewportHeight, frozenElements));
    restoreCallbacks.push(preserveSingleLineTextElements(document, viewportWidth, viewportHeight));
  }

  const imageSourceUrls = new Map<HTMLImageElement, string>();
  for (const image of Array.from(document.images)) {
    imageSourceUrls.set(image, image.currentSrc || image.src || image.getAttribute('src') || '');
  }

  const pictures = Array.from(document.querySelectorAll('picture'));
  for (const picture of pictures) {
    const sources = Array.from(picture.querySelectorAll('source'));
    if (sources.length === 0) continue;
    const previous = sources.map((source) => ({ source, srcset: source.getAttribute('srcset'), sizes: source.getAttribute('sizes') }));
    restoreCallbacks.push(() => {
      for (const item of previous) {
        if (item.srcset === null) item.source.removeAttribute('srcset');
        else item.source.setAttribute('srcset', item.srcset);
        if (item.sizes === null) item.source.removeAttribute('sizes');
        else item.source.setAttribute('sizes', item.sizes);
      }
    });
    for (const source of sources) {
      source.removeAttribute('srcset');
      source.removeAttribute('sizes');
    }
  }

  const images = Array.from(document.images).filter((image) => isVisibleInViewport(image));
  await Promise.all(images.map(async (image) => {
    const sourceUrl = imageSourceUrls.get(image) || image.currentSrc || image.src || image.getAttribute('src') || '';
    if (!sourceUrl) return;
    await waitForImage(image);
    const dataUrl = await fetchFrameResourceAsDataUrl(sourceUrl, document);
    const previous = {
      src: image.getAttribute('src'),
      srcset: image.getAttribute('srcset'),
      sizes: image.getAttribute('sizes'),
    };
    restoreCallbacks.push(() => {
      if (previous.src === null) image.removeAttribute('src');
      else image.setAttribute('src', previous.src);
      if (previous.srcset === null) image.removeAttribute('srcset');
      else image.setAttribute('srcset', previous.srcset);
      if (previous.sizes === null) image.removeAttribute('sizes');
      else image.setAttribute('sizes', previous.sizes);
    });
    image.removeAttribute('srcset');
    image.removeAttribute('sizes');
    image.setAttribute('src', dataUrl || TRANSPARENT_IMAGE_PLACEHOLDER);
    await waitForImage(image);
  }));

  const elements = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(isVisibleInViewport);
  await Promise.all(elements.map(async (element) => {
    const backgroundImage = view.getComputedStyle(element).backgroundImage;
    if (!backgroundImage || backgroundImage === 'none' || !backgroundImage.includes('url(')) return;
    const nextBackgroundImage = await inlineCssImageUrls(backgroundImage, document);
    if (nextBackgroundImage === backgroundImage) return;
    const previous = element.style.backgroundImage;
    restoreCallbacks.push(() => { element.style.backgroundImage = previous; });
    element.style.backgroundImage = nextBackgroundImage;
  }));

  return () => {
    for (let index = restoreCallbacks.length - 1; index >= 0; index -= 1) {
      try { restoreCallbacks[index]?.(); } catch { /* best-effort restore */ }
    }
  };
};

async function captureIframeSnapdomScreenshot(
  iframe: HTMLIFrameElement,
  target: PreviewElementMetadata,
): Promise<File | null> {
  try {
    // Loaded lazily so the capture stack stays out of the startup bundle.
    const { snapdom } = await import('@zumer/snapdom');
    const frameWindow = iframe.contentWindow;
    const document = iframe.contentDocument ?? frameWindow?.document;
    const root = document?.documentElement;
    if (!frameWindow || !document || !root) return null;

    const iframeRect = iframe.getBoundingClientRect();
    const viewportWidth = Math.max(1, Math.ceil(frameWindow.innerWidth || iframe.clientWidth || iframeRect.width));
    const viewportHeight = Math.max(1, Math.ceil(frameWindow.innerHeight || iframe.clientHeight || iframeRect.height));
    const body = document.body;
    const scrollingElement = document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
    const windowScrollX = frameWindow.scrollX || 0;
    const windowScrollY = frameWindow.scrollY || 0;
    const pageScrollX = frameWindow.pageXOffset || 0;
    const pageScrollY = frameWindow.pageYOffset || 0;
    const visualViewportScrollX = frameWindow.visualViewport?.pageLeft || frameWindow.visualViewport?.offsetLeft || 0;
    const visualViewportScrollY = frameWindow.visualViewport?.pageTop || frameWindow.visualViewport?.offsetTop || 0;
    const rootScrollX = root.scrollLeft || 0;
    const rootScrollY = root.scrollTop || 0;
    const bodyScrollX = body?.scrollLeft || 0;
    const bodyScrollY = body?.scrollTop || 0;
    const scrollingElementScrollX = scrollingElement?.scrollLeft || 0;
    const scrollingElementScrollY = scrollingElement?.scrollTop || 0;
    const scrollX = Math.max(windowScrollX, pageScrollX, visualViewportScrollX, rootScrollX, bodyScrollX, scrollingElementScrollX);
    const scrollY = Math.max(windowScrollY, pageScrollY, visualViewportScrollY, rootScrollY, bodyScrollY, scrollingElementScrollY);
    previewCaptureDebug('scroll sources', {
      windowScrollX, windowScrollY,
      pageScrollX, pageScrollY,
      visualViewportScrollX, visualViewportScrollY,
      rootScrollX, rootScrollY,
      bodyScrollX, bodyScrollY,
      scrollingElementScrollX, scrollingElementScrollY,
      scrollingElementTag: scrollingElement?.tagName?.toLowerCase() ?? null,
      resolvedScrollX: scrollX, resolvedScrollY: scrollY,
      nestedScrolledElements: describeScrolledElements(document),
    });
    const captureWidth = Math.max(viewportWidth, root.scrollWidth || 0, body?.scrollWidth || 0, Math.ceil(root.getBoundingClientRect().width || 0));
    const captureHeight = Math.max(viewportHeight, root.scrollHeight || 0, body?.scrollHeight || 0, Math.ceil(root.getBoundingClientRect().height || 0));
    // Prefer the frame's own DPR: the capture geometry is entirely in the
    // iframe's coordinate space, not the host application window's.
    const pixelRatio = Math.min(2, Math.max(1, frameWindow.devicePixelRatio || window.devicePixelRatio || 1));
    const previousRootScrollBehavior = root.style.scrollBehavior;
    const previousBodyScrollBehavior = body?.style.scrollBehavior ?? '';
    root.style.scrollBehavior = 'auto';
    if (body) body.style.scrollBehavior = 'auto';

    // Snapshot nested scroll positions before any mutation resets them.
    const nestedScroll = captureNestedScrollState(document);
    previewCaptureDebug('nested scroll snapshot', nestedScroll.snapshot);

    let restoreAssets = () => { /* no-op until capture preparation mutates DOM */ };
    let restoreFixedElements = () => { /* no-op until fixed elements are tagged */ };
    try {
      await document.fonts?.ready.catch(() => undefined);
      restoreAssets = await inlineIframeCaptureAssets(document, viewportWidth, viewportHeight, { applyLayoutWorkarounds: false });
      frameWindow.scrollTo(scrollX, scrollY);
      // Tag-only (no style mutation), so the sidebar's scroll is never disturbed; the
      // pinning happens on the clone via snapdomFixedPinPlugin.afterClone.
      restoreFixedElements = tagFixedElementsForClonePinning(document, scrollX, scrollY);
      // Defensive: undo any nested-scroll drift from asset inlining before capture.
      nestedScroll.reapply();

      const snapdomOptions = {
        backgroundColor: getCaptureBackgroundColor(document),
        cache: 'disabled' as const,
        dpr: pixelRatio,
        embedFonts: true,
        fast: false,
        height: captureHeight,
        outerShadows: true,
        outerTransforms: true,
        placeholders: true,
        plugins: [snapdomFixedPinPlugin, snapdomNestedScrollPlugin],
        quality: 0.82,
        width: captureWidth,
      };
      const capture = await snapdom(root, snapdomOptions);
      const fullCanvas = await capture.toCanvas();
      if (!fullCanvas.width || !fullCanvas.height) return null;

      const xScale = fullCanvas.width / Math.max(1, captureWidth);
      const yScale = fullCanvas.height / Math.max(1, captureHeight);
      const sourceWidth = Math.min(fullCanvas.width, Math.max(1, Math.round(viewportWidth * xScale)));
      const sourceHeight = Math.min(fullCanvas.height, Math.max(1, Math.round(viewportHeight * yScale)));
      const maxSourceX = Math.max(0, fullCanvas.width - sourceWidth);
      const maxSourceY = Math.max(0, fullCanvas.height - sourceHeight);
      // snapDOM bakes scroll into nested overflow containers via translate(), but
      // NOT into document-level scroll (documentElement/body): wrapping <html>'s
      // children in a translate <div> is invalid and renders no offset. So the
      // document scroll is never baked, and we always crop at the scroll offset.
      const sourceX = Math.min(maxSourceX, Math.max(0, Math.round(scrollX * xScale)));
      const sourceY = Math.min(maxSourceY, Math.max(0, Math.round(scrollY * yScale)));
      previewCaptureDebug('capture geometry', {
        viewportWidth, viewportHeight,
        captureWidth, captureHeight,
        canvasWidth: fullCanvas.width, canvasHeight: fullCanvas.height,
        xScale, yScale,
        sourceX, sourceY, sourceWidth, sourceHeight,
      });

      const viewportCanvas = document.createElement('canvas');
      viewportCanvas.width = sourceWidth;
      viewportCanvas.height = sourceHeight;
      const context = viewportCanvas.getContext('2d');
      if (!context) return null;

      context.drawImage(fullCanvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
      const base64 = await canvasToJpegBase64(viewportCanvas, 0.82);
      if (!base64) return null;

      return await desktopAnnotationToFile(base64, viewportWidth, viewportHeight, viewportWidth, viewportHeight, target);
    } finally {
      restoreFixedElements();
      nestedScroll.cleanup();
      restoreAssets();
      frameWindow.scrollTo(scrollX, scrollY);
      nestedScroll.reapply();
      root.style.scrollBehavior = previousRootScrollBehavior;
      if (body) body.style.scrollBehavior = previousBodyScrollBehavior;
    }
  } catch (error) {
    console.warn('[preview] failed to capture iframe DOM screenshot with snapDOM:', error);
    return null;
  }
}

async function captureIframeDomScreenshot(
  iframe: HTMLIFrameElement,
  target: PreviewElementMetadata,
): Promise<File | null> {
  const snapdomScreenshot = await captureIframeSnapdomScreenshot(iframe, target);
  if (snapdomScreenshot) return snapdomScreenshot;

  try {
    // Loaded lazily so the capture stack stays out of the startup bundle.
    const { getFontEmbedCSS, toJpeg } = await import('html-to-image');
    const frameWindow = iframe.contentWindow;
    const document = iframe.contentDocument ?? frameWindow?.document;
    const root = document?.documentElement;
    if (!frameWindow || !document || !root) return null;

    const iframeRect = iframe.getBoundingClientRect();
    const viewportWidth = Math.max(1, Math.ceil(frameWindow.innerWidth || iframe.clientWidth || iframeRect.width));
    const viewportHeight = Math.max(1, Math.ceil(frameWindow.innerHeight || iframe.clientHeight || iframeRect.height));
    const scrollX = frameWindow.scrollX || document.documentElement.scrollLeft || document.body?.scrollLeft || 0;
    const scrollY = frameWindow.scrollY || document.documentElement.scrollTop || document.body?.scrollTop || 0;
    const body = document.body;
    const captureHeight = Math.max(viewportHeight, root.scrollHeight || 0, body?.scrollHeight || 0);
    const pixelRatio = Math.min(2, Math.max(1, frameWindow.devicePixelRatio || window.devicePixelRatio || 1));
    const previousRootScrollBehavior = root.style.scrollBehavior;
    const previousBodyScrollBehavior = body?.style.scrollBehavior ?? '';
    root.style.scrollBehavior = 'auto';
    if (body) body.style.scrollBehavior = 'auto';

    let dataUrl = '';
    let restoreAssets = () => { /* no-op until capture preparation mutates DOM */ };
    try {
      await document.fonts?.ready.catch(() => undefined);
      restoreAssets = await inlineIframeCaptureAssets(document, viewportWidth, viewportHeight, { applyLayoutWorkarounds: true });
      frameWindow.scrollTo(scrollX, scrollY);
      const fontEmbedCSS = await getFontEmbedCSS(root).catch(() => '');

      dataUrl = await toJpeg(root, {
        quality: 0.82,
        pixelRatio,
        width: viewportWidth,
        height: viewportHeight,
        backgroundColor: getCaptureBackgroundColor(document),
        imagePlaceholder: TRANSPARENT_IMAGE_PLACEHOLDER,
        fontEmbedCSS: fontEmbedCSS || undefined,
        style: {
          transform: `translate(${-scrollX}px, ${-scrollY}px)`,
          transformOrigin: 'top left',
          minWidth: `${viewportWidth}px`,
          minHeight: `${captureHeight}px`,
        },
        cacheBust: true,
      });
    } finally {
      restoreAssets();
      frameWindow.scrollTo(scrollX, scrollY);
      root.style.scrollBehavior = previousRootScrollBehavior;
      if (body) body.style.scrollBehavior = previousBodyScrollBehavior;
    }

    const base64 = dataUrl.split(',', 2)[1] || '';
    if (!base64) return null;

    return await desktopAnnotationToFile(base64, viewportWidth, viewportHeight, viewportWidth, viewportHeight, target);
  } catch (error) {
    console.warn('[preview] failed to capture iframe DOM screenshot:', error);
    return null;
  }
}
