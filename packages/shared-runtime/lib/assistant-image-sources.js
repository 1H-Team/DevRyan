const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const SUPPORTED_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp)(?:;|,)/i;

const isEscaped = (value, index) => {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
};

const decodeUrlComponent = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const unescapeMarkdownDestination = (value) => value.replace(/\\([\\()[\]<> ])/g, '$1');

export const canonicalizeAssistantImageSource = (value) => {
  let source = unescapeMarkdownDestination(typeof value === 'string' ? value.trim() : '');
  if (source.startsWith('<') && source.endsWith('>')) {
    source = source.slice(1, -1).trim();
  }
  if (!source) return null;

  try {
    const url = new URL(source, 'https://devryan.invalid');
    if (url.protocol === 'file:') {
      const pathname = decodeUrlComponent(url.pathname).replace(/\\/g, '/');
      return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    }
    if (url.origin === 'https://devryan.invalid' && url.pathname === '/api/fs/raw') {
      const rawPath = url.searchParams.get('path');
      return rawPath ? decodeUrlComponent(rawPath).replace(/\\/g, '/') : null;
    }
    if (
      (url.protocol === 'http:' || url.protocol === 'https:')
      && url.origin !== 'https://devryan.invalid'
    ) {
      url.hash = '';
      return url.href;
    }
  } catch {
    // Plain filesystem paths and data URLs are handled below.
  }

  if (SUPPORTED_DATA_IMAGE.test(source)) return source;
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(source) && !/^[A-Za-z]:[\\/]/.test(source)) {
    return null;
  }
  return decodeUrlComponent(source).replace(/\\/g, '/');
};

const extensionForSource = (source) => {
  if (SUPPORTED_DATA_IMAGE.test(source)) return '.data';
  let pathname = source;
  try {
    const url = new URL(source, 'https://devryan.invalid');
    if (url.origin === 'https://devryan.invalid' && url.pathname === '/api/fs/raw') {
      pathname = url.searchParams.get('path') || '';
    } else {
      pathname = url.pathname;
    }
  } catch {
    pathname = source.split(/[?#]/, 1)[0] || '';
  }
  const match = pathname.toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match?.[1] || '';
};

export const isSupportedAssistantImageSource = (value) => {
  const source = canonicalizeAssistantImageSource(value);
  if (!source) return false;
  if (SUPPORTED_DATA_IMAGE.test(source)) return true;
  return SUPPORTED_IMAGE_EXTENSIONS.has(extensionForSource(source));
};

const maskCode = (markdown) => {
  const masked = markdown.split('');
  let fence = null;
  let offset = 0;
  for (const line of markdown.split(/(?<=\n)/)) {
    const body = line.endsWith('\n') ? line.slice(0, -1) : line;
    const marker = body.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    const markerValue = marker?.[1] || '';
    const closesFence = fence
      && markerValue[0] === fence.character
      && markerValue.length >= fence.length;
    if (fence || markerValue) {
      for (let index = 0; index < body.length; index += 1) masked[offset + index] = ' ';
      if (closesFence) fence = null;
      else if (!fence && markerValue) fence = { character: markerValue[0], length: markerValue.length };
      offset += line.length;
      continue;
    }

    let cursor = 0;
    while (cursor < body.length) {
      if (body[cursor] !== '`' || isEscaped(body, cursor)) {
        cursor += 1;
        continue;
      }
      let runEnd = cursor;
      while (body[runEnd] === '`') runEnd += 1;
      const delimiter = body.slice(cursor, runEnd);
      const close = body.indexOf(delimiter, runEnd);
      const maskedEnd = close === -1 ? body.length : close + delimiter.length;
      for (let index = cursor; index < maskedEnd; index += 1) masked[offset + index] = ' ';
      cursor = maskedEnd;
    }
    offset += line.length;
  }
  return masked.join('');
};

const findClosingBracket = (masked, start) => {
  for (let index = start; index < masked.length; index += 1) {
    if (masked[index] === ']' && !isEscaped(masked, index)) return index;
    if (masked[index] === '\n') return -1;
  }
  return -1;
};

const parseInlineDestination = (markdown, masked, openIndex) => {
  let cursor = openIndex + 1;
  while (/[ \t\n]/.test(masked[cursor] || '')) cursor += 1;
  let source = '';
  if (masked[cursor] === '<') {
    const closeAngle = masked.indexOf('>', cursor + 1);
    if (closeAngle === -1) return null;
    source = markdown.slice(cursor + 1, closeAngle);
    cursor = closeAngle + 1;
  } else {
    const sourceStart = cursor;
    let nested = 0;
    for (; cursor < masked.length; cursor += 1) {
      const character = masked[cursor];
      if (character === '\n' || (/[ \t]/.test(character) && nested === 0)) break;
      if (character === '(' && !isEscaped(masked, cursor)) nested += 1;
      if (character === ')' && !isEscaped(masked, cursor)) {
        if (nested === 0) break;
        nested -= 1;
      }
    }
    source = markdown.slice(sourceStart, cursor);
  }

  let quote = null;
  let nested = 0;
  for (; cursor < masked.length; cursor += 1) {
    const character = masked[cursor];
    if (character === '\n') return null;
    if ((character === '"' || character === "'") && !isEscaped(masked, cursor)) {
      quote = quote === character ? null : (quote || character);
      continue;
    }
    if (quote) continue;
    if (character === '(' && !isEscaped(masked, cursor)) nested += 1;
    if (character === ')' && !isEscaped(masked, cursor)) {
      if (nested === 0) {
        return { source, end: cursor + 1 };
      }
      nested -= 1;
    }
  }
  return null;
};

const normalizeReferenceLabel = (value) => value.trim().replace(/\s+/g, ' ').toLowerCase();

const collectDefinitions = (markdown, masked) => {
  const definitions = new Map();
  let offset = 0;
  for (const line of masked.split(/(?<=\n)/)) {
    const match = line.match(/^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*/);
    if (match) {
      const destinationStart = offset + match[0].length;
      let source = '';
      if (masked[destinationStart] === '<') {
        const close = masked.indexOf('>', destinationStart + 1);
        if (close !== -1 && close < offset + line.length) {
          source = markdown.slice(destinationStart + 1, close);
        }
      } else {
        let end = destinationStart;
        let nested = 0;
        while (end < offset + line.length) {
          const character = masked[end];
          if (/[ \t\n]/.test(character) && nested === 0) break;
          if (character === '(' && !isEscaped(masked, end)) nested += 1;
          if (character === ')' && !isEscaped(masked, end) && nested > 0) nested -= 1;
          end += 1;
        }
        source = markdown.slice(destinationStart, end);
      }
      const canonical = canonicalizeAssistantImageSource(source);
      if (canonical && isSupportedAssistantImageSource(canonical)) {
        definitions.set(normalizeReferenceLabel(match[1]), canonical);
      }
    }
    offset += line.length;
  }
  return definitions;
};

export const extractAssistantImageReferences = (markdown) => {
  if (typeof markdown !== 'string' || !markdown) return [];
  const masked = maskCode(markdown);
  const definitions = collectDefinitions(markdown, masked);
  const references = [];

  for (let index = 0; index < masked.length; index += 1) {
    const image = masked[index] === '!' && masked[index + 1] === '[' && !isEscaped(masked, index);
    const link = masked[index] === '[' && masked[index - 1] !== '!' && !isEscaped(masked, index);
    if (!image && !link) continue;
    const bracketStart = image ? index + 1 : index;
    const bracketEnd = findClosingBracket(masked, bracketStart + 1);
    if (bracketEnd === -1) continue;
    const caption = markdown.slice(bracketStart + 1, bracketEnd).replace(/\\([\\[\]])/g, '$1').trim();
    let end = bracketEnd + 1;
    let source = null;
    let kind = image ? 'markdown-image' : 'markdown-link';

    if (masked[end] === '(') {
      const parsed = parseInlineDestination(markdown, masked, end);
      if (!parsed) continue;
      source = canonicalizeAssistantImageSource(parsed.source);
      end = parsed.end;
    } else if (image && masked[end] === '[') {
      const referenceEnd = findClosingBracket(masked, end + 1);
      if (referenceEnd === -1) continue;
      const label = markdown.slice(end + 1, referenceEnd) || caption;
      source = definitions.get(normalizeReferenceLabel(label)) || null;
      end = referenceEnd + 1;
      kind = 'reference-image';
    } else if (image) {
      source = definitions.get(normalizeReferenceLabel(caption)) || null;
      kind = 'reference-image';
    }

    if (!source || !isSupportedAssistantImageSource(source)) continue;
    references.push({
      source,
      caption: caption || source.split('/').pop() || 'image',
      kind,
      start: index,
      end,
    });
    index = Math.max(index, end - 1);
  }
  return references;
};

export const stripAssistantImageMarkdown = (markdown) => {
  const references = extractAssistantImageReferences(markdown);
  if (references.length === 0) return markdown;
  let result = '';
  let cursor = 0;
  for (const reference of references) {
    result += markdown.slice(cursor, reference.start);
    result += reference.caption.replace(/([\\`*_[\]<>])/g, '\\$1');
    cursor = reference.end;
  }
  return result + markdown.slice(cursor);
};

export { SUPPORTED_IMAGE_EXTENSIONS };
