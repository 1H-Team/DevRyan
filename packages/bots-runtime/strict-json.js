const DEFAULT_MAXIMUM_BYTES = 512 * 1024;
const DEFAULT_MAXIMUM_DEPTH = 32;
const DEFAULT_MAXIMUM_NODES = 100_000;

export class StrictJsonError extends SyntaxError {
  constructor(message, code = 'strict_json_invalid') {
    super(message);
    this.name = 'StrictJsonError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new StrictJsonError(message, code);
};

export function parseStrictJson(source, {
  maximumBytes = DEFAULT_MAXIMUM_BYTES,
  maximumDepth = DEFAULT_MAXIMUM_DEPTH,
  maximumNodes = DEFAULT_MAXIMUM_NODES,
} = {}) {
  if (typeof source !== 'string'
    || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1
    || !Number.isSafeInteger(maximumDepth) || maximumDepth < 1
    || !Number.isSafeInteger(maximumNodes) || maximumNodes < 1) {
    fail('Strict JSON parser input is invalid');
  }
  if (Buffer.byteLength(source, 'utf8') > maximumBytes) {
    fail('JSON input is too large', 'strict_json_too_large');
  }
  let index = 0;
  let nodes = 0;

  const whitespace = () => {
    while (/[\u0009\u000a\u000d\u0020]/u.test(source[index] || '')) index += 1;
  };

  const stringToken = () => {
    if (source[index] !== '"') fail('JSON string is invalid');
    const start = index;
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index));
        } catch {
          fail('JSON string is invalid');
        }
      }
      if (character === '\\') {
        index += 1;
        if (source[index] === 'u') {
          if (!/^[0-9a-f]{4}$/iu.test(source.slice(index + 1, index + 5))) {
            fail('JSON unicode escape is invalid');
          }
          index += 5;
          continue;
        }
        if (!/["\\/bfnrt]/u.test(source[index] || '')) fail('JSON escape is invalid');
        index += 1;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) fail('JSON string contains a control character');
      index += 1;
    }
    fail('JSON string is unterminated');
  };

  const value = (depth) => {
    nodes += 1;
    if (nodes > maximumNodes) fail('JSON input has too many values', 'strict_json_too_complex');
    if (depth > maximumDepth) fail('JSON input is nested too deeply', 'strict_json_too_complex');
    whitespace();
    const character = source[index];
    if (character === '"') {
      stringToken();
      return;
    }
    if (character === '{') {
      index += 1;
      whitespace();
      const keys = new Set();
      if (source[index] === '}') {
        index += 1;
        return;
      }
      while (index < source.length) {
        const key = stringToken();
        if (keys.has(key)) fail('JSON object contains a duplicate key', 'strict_json_duplicate_key');
        keys.add(key);
        whitespace();
        if (source[index] !== ':') fail('JSON object is missing a colon');
        index += 1;
        value(depth + 1);
        whitespace();
        if (source[index] === '}') {
          index += 1;
          return;
        }
        if (source[index] !== ',') fail('JSON object is missing a comma');
        index += 1;
        whitespace();
      }
      fail('JSON object is unterminated');
    }
    if (character === '[') {
      index += 1;
      whitespace();
      if (source[index] === ']') {
        index += 1;
        return;
      }
      while (index < source.length) {
        value(depth + 1);
        whitespace();
        if (source[index] === ']') {
          index += 1;
          return;
        }
        if (source[index] !== ',') fail('JSON array is missing a comma');
        index += 1;
      }
      fail('JSON array is unterminated');
    }
    const remainder = source.slice(index);
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(remainder);
    if (!primitive) fail('JSON value is invalid');
    index += primitive[0].length;
  };

  value(0);
  whitespace();
  if (index !== source.length) fail('JSON input has trailing data');
  try {
    return JSON.parse(source);
  } catch {
    fail('JSON input is invalid');
  }
}
