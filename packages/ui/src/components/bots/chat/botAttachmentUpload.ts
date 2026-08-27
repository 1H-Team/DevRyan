export const BOT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const BOT_ATTACHMENT_MAX_COUNT = 32;

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

const fileToBase64 = async (file: Pick<UploadableFile, 'arrayBuffer'>): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
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
}: {
  files: readonly UploadableFile[];
  getAttachmentCount: () => number;
  upload: (input: {
    file: UploadableFile;
    contentType: string;
    dataBase64: string;
  }) => Promise<string>;
  onUploaded: (success: BotAttachmentUploadSuccess) => void;
}): Promise<BotAttachmentUploadResult> => {
  const successes: BotAttachmentUploadSuccess[] = [];
  const failures: BotAttachmentUploadFailure[] = [];

  // Deliberately process one file at a time so a 32-file selection cannot keep
  // every raw buffer and base64 copy resident at once.
  for (const file of files) {
    if (getAttachmentCount() >= BOT_ATTACHMENT_MAX_COUNT) {
      failures.push({ filename: file.name, reason: 'attachment_limit' });
      continue;
    }
    if (file.size > BOT_ATTACHMENT_MAX_BYTES) {
      failures.push({ filename: file.name, reason: 'too_large' });
      continue;
    }
    const contentType = resolveBotAttachmentContentType(file);
    if (!contentType) {
      failures.push({ filename: file.name, reason: 'unsupported_type' });
      continue;
    }

    try {
      const objectId = await upload({
        file,
        contentType,
        dataBase64: await fileToBase64(file),
      });
      const success = { filename: file.name, objectId };
      successes.push(success);
      onUploaded(success);
    } catch (error) {
      failures.push({ filename: file.name, reason: uploadFailureReason(error) });
    }
  }

  return { successes, failures };
};
