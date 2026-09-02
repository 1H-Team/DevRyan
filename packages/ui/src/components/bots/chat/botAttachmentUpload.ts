export const BOT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const BOT_ATTACHMENT_MAX_COUNT = 32;
// Photos straight off a phone are 12–48 MP; the Bot never needs more than this
// to read them, and the smaller upload is what keeps a multi-photo send snappy.
export const BOT_ATTACHMENT_MAX_IMAGE_PIXELS = 4_000_000;
export const BOT_ATTACHMENT_UPLOAD_CONCURRENCY = 2;

const HEIC_CONTENT_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);
const DOWNSCALABLE_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const GENERIC_CONTENT_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
]);

const CONTENT_TYPE_ALIASES = new Map([
  ['image/jpg', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
  ['image/x-png', 'image/png'],
  ['text/x-markdown', 'text/markdown'],
  ['text/x-yaml', 'text/yaml'],
]);

const CONTENT_TYPE_BY_EXTENSION = new Map([
  ['.csv', 'text/csv'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.text', 'text/plain'],
  ['.txt', 'text/plain'],
  ['.webp', 'image/webp'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.xml', 'application/xml'],
  ['.yaml', 'text/yaml'],
  ['.yml', 'text/yaml'],
  ['.zip', 'application/zip'],
]);

const ALLOWED_CONTENT_TYPES = new Set(CONTENT_TYPE_BY_EXTENSION.values());

export const BOT_ATTACHMENT_ACCEPT = [
  ...new Set([
    ...CONTENT_TYPE_BY_EXTENSION.keys(),
    ...ALLOWED_CONTENT_TYPES,
  ]),
].join(',');

export type BotAttachmentUploadFailureReason =
  | 'attachment_limit'
  | 'too_large'
  | 'unsupported_type'
  | 'upload_failed';

export type BotAttachmentUploadFailure = Readonly<{
  filename: string;
  reason: BotAttachmentUploadFailureReason;
}>;

export type BotAttachmentUploadSuccess = Readonly<{
  filename: string;
  objectId: string;
}>;

export type BotAttachmentUploadResult = Readonly<{
  successes: readonly BotAttachmentUploadSuccess[];
  failures: readonly BotAttachmentUploadFailure[];
}>;

type UploadableFile = Pick<File, 'arrayBuffer' | 'name' | 'size' | 'type'>;

export type BotAttachmentPreparedFile = Readonly<{ file: UploadableFile; contentType: string }>;

export type BotAttachmentImageConverters = Readonly<{
  // HEIC/HEIF → JPEG. Returns null when conversion is unavailable.
  convertHeic?: (file: UploadableFile) => Promise<UploadableFile | null>;
  // Downscale an oversized raster image. Returns null to keep the original.
  downscaleImage?: (file: UploadableFile, contentType: string) => Promise<UploadableFile | null>;
}>;

type BotAttachmentDataTransfer = Readonly<{
  files?: ArrayLike<File> | null;
  items?: ArrayLike<Pick<DataTransferItem, 'getAsFile' | 'kind'>> | null;
  types?: ArrayLike<string> | null;
}>;

export const nextBotAttachmentDragDepth = (
  currentDepth: number,
  action: 'enter' | 'leave' | 'reset',
): number => {
  if (action === 'reset') return 0;
  if (action === 'enter') return Math.max(0, currentDepth) + 1;
  return Math.max(0, currentDepth - 1);
};

export const hasBotAttachmentFiles = (
  dataTransfer: BotAttachmentDataTransfer | null | undefined,
): boolean => {
  if (!dataTransfer) return false;
  if ((dataTransfer.files?.length ?? 0) > 0) return true;
  return Array.from(dataTransfer.types ?? [])
    .some((type) => type.toLowerCase() === 'files');
};

export const collectBotAttachmentFiles = (
  dataTransfer: BotAttachmentDataTransfer | null | undefined,
): File[] => {
  if (!dataTransfer) return [];
  const directFiles = Array.from(dataTransfer.files ?? []);
  if (directFiles.length > 0) return directFiles;

  return Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
};

const fileExtension = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
};

export const resolveBotAttachmentContentType = (
  file: Pick<UploadableFile, 'name' | 'type'>,
): string | null => {
  const declared = file.type.split(';', 1)[0]?.trim().toLowerCase() || '';
  const normalized = CONTENT_TYPE_ALIASES.get(declared) || declared;
  const extensionType = CONTENT_TYPE_BY_EXTENSION.get(fileExtension(file.name));
  if (extensionType) return extensionType;
  if (ALLOWED_CONTENT_TYPES.has(normalized)) return normalized;
  if (!GENERIC_CONTENT_TYPES.has(normalized)) return null;
  return null;
};

const isBlobLike = (file: unknown): file is Blob => (
  typeof Blob === 'function' && file instanceof Blob
);

const fileToBase64ViaArrayBuffer = async (file: Pick<UploadableFile, 'arrayBuffer'>): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

// FileReader encodes natively instead of building a 25 MB binary string on the
// JS thread, which is what used to freeze the composer for a multi-file send.
const fileToBase64 = async (file: Pick<UploadableFile, 'arrayBuffer'>): Promise<string> => {
  if (typeof FileReader !== 'function' || !isBlobLike(file)) {
    return fileToBase64ViaArrayBuffer(file);
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Attachment could not be read'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma < 0) {
        reject(new Error('Attachment could not be encoded'));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
};

const replaceExtension = (filename: string, extension: string): string => {
  const dot = filename.lastIndexOf('.');
  return `${dot > 0 ? filename.slice(0, dot) : filename}${extension}`;
};

const blobToUploadable = (blob: Blob, name: string, type: string): UploadableFile => (
  typeof File === 'function'
    ? new File([blob], name, { type })
    : Object.assign(blob, { name, type }) as unknown as UploadableFile
);

const isHeicFile = (file: Pick<UploadableFile, 'name' | 'type'>): boolean => (
  HEIC_CONTENT_TYPES.has(file.type.split(';', 1)[0]?.trim().toLowerCase() || '')
  || HEIC_EXTENSIONS.has(fileExtension(file.name))
);

const defaultConvertHeic = async (file: UploadableFile): Promise<UploadableFile | null> => {
  if (!isBlobLike(file)) return null;
  const heic2any = (await import('heic2any')).default;
  const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  const blob = Array.isArray(converted) ? converted[0] : converted;
  if (!(blob instanceof Blob)) return null;
  return blobToUploadable(blob, replaceExtension(file.name, '.jpg'), 'image/jpeg');
};

const defaultDownscaleImage = async (
  file: UploadableFile,
  contentType: string,
): Promise<UploadableFile | null> => {
  if (!isBlobLike(file) || typeof createImageBitmap !== 'function'
    || typeof OffscreenCanvas !== 'function') return null;
  const bitmap = await createImageBitmap(file);
  try {
    const pixels = bitmap.width * bitmap.height;
    if (pixels <= BOT_ATTACHMENT_MAX_IMAGE_PIXELS) return null;
    const scale = Math.sqrt(BOT_ATTACHMENT_MAX_IMAGE_PIXELS / pixels);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    // PNG keeps transparency; everything else becomes JPEG.
    const outputType = contentType === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await canvas.convertToBlob({ type: outputType, quality: 0.88 });
    if (blob.size >= file.size) return null;
    const name = outputType === 'image/jpeg' && contentType !== 'image/jpeg'
      ? replaceExtension(file.name, '.jpg')
      : file.name;
    return blobToUploadable(blob, name, outputType);
  } finally {
    bitmap.close?.();
  }
};

// Convert HEIC to JPEG and downscale huge rasters before the size and type
// checks, so a phone photo is accepted rather than refused as unsupported.
export const prepareBotAttachmentFile = async (
  file: UploadableFile,
  converters: BotAttachmentImageConverters = {},
): Promise<BotAttachmentPreparedFile | BotAttachmentUploadFailure> => {
  let prepared = file;
  if (isHeicFile(file)) {
    try {
      const converted = await (converters.convertHeic ?? defaultConvertHeic)(file);
      if (!converted) return { filename: file.name, reason: 'unsupported_type' };
      prepared = converted;
    } catch {
      return { filename: file.name, reason: 'unsupported_type' };
    }
  }
  const contentType = resolveBotAttachmentContentType(prepared);
  if (!contentType) return { filename: file.name, reason: 'unsupported_type' };
  if (DOWNSCALABLE_CONTENT_TYPES.has(contentType)) {
    try {
      const smaller = await (converters.downscaleImage ?? defaultDownscaleImage)(prepared, contentType);
      if (smaller) {
        return { file: smaller, contentType: resolveBotAttachmentContentType(smaller) ?? contentType };
      }
    } catch {
      // A failed downscale is not a failed attachment; upload the original.
    }
  }
  if (prepared.size > BOT_ATTACHMENT_MAX_BYTES) return { filename: file.name, reason: 'too_large' };
  return { file: prepared, contentType };
};

const uploadFailureReason = (error: unknown): BotAttachmentUploadFailureReason => {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
  if (code === 'bot_object_too_large') return 'too_large';
  if (code === 'bot_object_mime_forbidden' || code === 'bot_object_mime_mismatch') {
    return 'unsupported_type';
  }
  return 'upload_failed';
};

export const uploadBotAttachmentFiles = async ({
  files,
  getAttachmentCount,
  upload,
  onUploaded,
  converters = {},
  concurrency = BOT_ATTACHMENT_UPLOAD_CONCURRENCY,
}: {
  files: readonly UploadableFile[];
  getAttachmentCount: () => number;
  upload: (input: {
    file: UploadableFile;
    contentType: string;
    dataBase64: string;
  }) => Promise<string>;
  onUploaded: (success: BotAttachmentUploadSuccess) => void;
  converters?: BotAttachmentImageConverters;
  concurrency?: number;
}): Promise<BotAttachmentUploadResult> => {
  const results: (BotAttachmentUploadSuccess | BotAttachmentUploadFailure | undefined)[] = files.map(() => undefined);
  const settled = files.map(() => {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  });
  const finish = (index: number, result: BotAttachmentUploadSuccess | BotAttachmentUploadFailure) => {
    results[index] = result;
    settled[index].resolve();
  };

  // Reserve slots up front so the count limit is exact even while uploads
  // overlap; files that can never be accepted do not take a slot.
  let reserved = 0;
  const admitted: { index: number; file: UploadableFile }[] = [];
  files.forEach((file, index) => {
    if (getAttachmentCount() + reserved >= BOT_ATTACHMENT_MAX_COUNT) {
      finish(index, { filename: file.name, reason: 'attachment_limit' });
      return;
    }
    if (file.size > BOT_ATTACHMENT_MAX_BYTES && !isHeicFile(file)
      && !DOWNSCALABLE_CONTENT_TYPES.has(resolveBotAttachmentContentType(file) ?? '')) {
      finish(index, { filename: file.name, reason: 'too_large' });
      return;
    }
    reserved += 1;
    admitted.push({ index, file });
  });

  // A small pool overlaps encoding and network time for one file with the next
  // without keeping every raw buffer and base64 copy resident at once.
  const limit = Math.max(1, Math.min(admitted.length || 1, Math.trunc(concurrency) || 1));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < admitted.length) {
      const { index, file } = admitted[cursor];
      cursor += 1;
      const prepared = await prepareBotAttachmentFile(file, converters);
      if ('reason' in prepared) {
        finish(index, prepared);
        continue;
      }
      try {
        const objectId = await upload({
          file: prepared.file,
          contentType: prepared.contentType,
          dataBase64: await fileToBase64(prepared.file),
        });
        finish(index, { filename: file.name, objectId });
      } catch (error) {
        finish(index, { filename: file.name, reason: uploadFailureReason(error) });
      }
    }
  };
  const pool: Promise<void>[] = [];
  for (let slot = 0; slot < limit; slot += 1) pool.push(worker());

  // Report in selection order as each file's turn settles, so the composer
  // chips appear in the order the user picked them.
  const successes: BotAttachmentUploadSuccess[] = [];
  const failures: BotAttachmentUploadFailure[] = [];
  for (let index = 0; index < files.length; index += 1) {
    await settled[index].promise;
    const result = results[index];
    if (!result) continue;
    if ('objectId' in result) {
      successes.push(result);
      onUploaded(result);
    } else {
      failures.push(result);
    }
  }
  await Promise.all(pool);

  return { successes, failures };
};
