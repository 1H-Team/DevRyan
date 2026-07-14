let lastTimestamp = 0;
let counter = 0;

const RANDOM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RANDOM_LENGTH = 14;

const randomBase62 = (): string => {
  const bytes = new Uint8Array(RANDOM_LENGTH);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  return Array.from(bytes, (byte) => RANDOM_CHARS[byte % RANDOM_CHARS.length]).join('');
};

/** Creates an OpenCode-compatible, time-sortable client identity. */
export const createClientMessageId = (prefix: 'msg' | 'prt'): string => {
  const timestamp = Date.now();
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter += 1;

  const sortable = BigInt(timestamp) * BigInt(0x1000) + BigInt(counter);
  const bytes = new Uint8Array(6);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number((sortable >> BigInt(40 - 8 * index)) & BigInt(0xff));
  }

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}${randomBase62()}`;
};
