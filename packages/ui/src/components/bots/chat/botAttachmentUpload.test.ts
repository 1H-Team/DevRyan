import { describe, expect, test } from 'bun:test';

import {
  BOT_ATTACHMENT_MAX_BYTES,
  BOT_ATTACHMENT_MAX_COUNT,
  collectBotAttachmentFiles,
  hasBotAttachmentFiles,
  nextBotAttachmentDragDepth,
  resolveBotAttachmentContentType,
  uploadBotAttachmentFiles,
} from './botAttachmentUpload';

const file = (
  name: string,
  type = 'text/plain',
  contents = 'content',
): File => new File([contents], name, { type });

describe('Bot attachment uploads', () => {
  test('keeps nested drag targets active until the final leave and resets terminal paths', () => {
    let depth = nextBotAttachmentDragDepth(0, 'enter');
    depth = nextBotAttachmentDragDepth(depth, 'enter');
    expect(depth).toBe(2);
    depth = nextBotAttachmentDragDepth(depth, 'leave');
    expect(depth).toBe(1);
    depth = nextBotAttachmentDragDepth(depth, 'leave');
    expect(depth).toBe(0);
    expect(nextBotAttachmentDragDepth(depth, 'leave')).toBe(0);
    expect(nextBotAttachmentDragDepth(3, 'reset')).toBe(0);
  });

  test('recognizes file drags before browsers expose the actual file list', () => {
    expect(hasBotAttachmentFiles({ files: [], types: ['text/plain', 'Files'] })).toBe(true);
    expect(hasBotAttachmentFiles({ files: [], types: ['FILES'] })).toBe(true);
    expect(hasBotAttachmentFiles({ files: [file('ready.txt')], types: [] })).toBe(true);
    expect(hasBotAttachmentFiles({ files: [], types: ['text/plain'] })).toBe(false);
    expect(hasBotAttachmentFiles(null)).toBe(false);
  });

  test('collects direct dropped files and falls back to file-kind transfer items', () => {
    const direct = file('direct.txt');
    const fallback = file('fallback.txt');
    const ignored = file('ignored.txt');

    expect(collectBotAttachmentFiles({
      files: [direct],
      items: [{ kind: 'file', getAsFile: () => ignored }],
    })).toEqual([direct]);
    expect(collectBotAttachmentFiles({
      files: [],
      items: [
        { kind: 'string', getAsFile: () => ignored },
        { kind: 'file', getAsFile: () => null },
        { kind: 'file', getAsFile: () => fallback },
      ],
    })).toEqual([fallback]);
    expect(collectBotAttachmentFiles(undefined)).toEqual([]);
  });

  test('normalizes PNG MIME declarations and generic browser fallbacks', () => {
    for (const candidate of [
      file('image.png', 'image/png'),
      file('image.png', 'image/x-png'),
      file('image.png', ''),
      file('image.png', 'application/octet-stream'),
      file('IMAGE.PNG', ''),
    ]) {
      expect(resolveBotAttachmentContentType(candidate)).toBe('image/png');
    }
  });

  test('preserves the existing supported types and lets allowlisted extensions correct MIME declarations', () => {
    expect(resolveBotAttachmentContentType(file('report.pdf', ''))).toBe('application/pdf');
    expect(resolveBotAttachmentContentType(file('data.xlsx', 'application/octet-stream')))
      .toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(resolveBotAttachmentContentType(file('notes.md', 'text/x-markdown')))
      .toBe('text/markdown');
    expect(resolveBotAttachmentContentType(file('image.png', 'text/plain'))).toBe('image/png');
    expect(resolveBotAttachmentContentType(file('program.exe', ''))).toBeNull();
  });

  test('uploads a selection in order, keeps successes, and reads the latest draft for each result', async () => {
    let draft = { text: 'Initial text', attachmentIds: ['existing'] as string[] };
    const uploadedNames: string[] = [];
    const result = await uploadBotAttachmentFiles({
      files: [file('one.txt'), file('broken.txt'), file('three.txt')],
      getAttachmentCount: () => draft.attachmentIds.length,
      upload: async ({ file: selected }) => {
        uploadedNames.push(selected.name);
        if (selected.name === 'broken.txt') {
          draft = { ...draft, text: 'Edited while files were uploading' };
          throw Object.assign(new Error('network unavailable'), { code: 'network_error' });
        }
        return `object-${selected.name}`;
      },
      onUploaded: ({ objectId }) => {
        draft = { ...draft, attachmentIds: [...draft.attachmentIds, objectId] };
      },
    });

    expect(uploadedNames).toEqual(['one.txt', 'broken.txt', 'three.txt']);
    expect(result.successes).toEqual([
      { filename: 'one.txt', objectId: 'object-one.txt' },
      { filename: 'three.txt', objectId: 'object-three.txt' },
    ]);
    expect(result.failures).toEqual([{ filename: 'broken.txt', reason: 'upload_failed' }]);
    expect(draft).toEqual({
      text: 'Edited while files were uploading',
      attachmentIds: ['existing', 'object-one.txt', 'object-three.txt'],
    });
  });

  test('rejects unsupported and oversized files before reading or uploading them', async () => {
    let oversizedReadCount = 0;
    let unsupportedReadCount = 0;
    let uploadCount = 0;
    const result = await uploadBotAttachmentFiles({
      files: [
        {
          name: 'huge.png',
          type: 'image/png',
          size: BOT_ATTACHMENT_MAX_BYTES + 1,
          arrayBuffer: async () => {
            oversizedReadCount += 1;
            return new ArrayBuffer(0);
          },
        },
        {
          name: 'program.exe',
          type: '',
          size: 10,
          arrayBuffer: async () => {
            unsupportedReadCount += 1;
            return new ArrayBuffer(0);
          },
        },
      ],
      getAttachmentCount: () => 0,
      upload: async () => {
        uploadCount += 1;
        return 'unused';
      },
      onUploaded: () => undefined,
    });

    expect(result.failures).toEqual([
      { filename: 'huge.png', reason: 'too_large' },
      { filename: 'program.exe', reason: 'unsupported_type' },
    ]);
    expect(oversizedReadCount).toBe(0);
    expect(unsupportedReadCount).toBe(0);
    expect(uploadCount).toBe(0);
  });

  test('fills only the remaining attachment slots and reports overflow files', async () => {
    let count = BOT_ATTACHMENT_MAX_COUNT - 1;
    const result = await uploadBotAttachmentFiles({
      files: [file('last.txt'), file('overflow.txt')],
      getAttachmentCount: () => count,
      upload: async ({ file: selected }) => `object-${selected.name}`,
      onUploaded: () => { count += 1; },
    });

    expect(result.successes).toEqual([{ filename: 'last.txt', objectId: 'object-last.txt' }]);
    expect(result.failures).toEqual([
      { filename: 'overflow.txt', reason: 'attachment_limit' },
    ]);
  });

  test('allows the same file to be selected again after an earlier selection settles', async () => {
    let count = 0;
    let sequence = 0;
    const upload = async () => `object-${++sequence}`;
    const onUploaded = () => { count += 1; };

    const first = await uploadBotAttachmentFiles({
      files: [file('again.txt')],
      getAttachmentCount: () => count,
      upload,
      onUploaded,
    });
    const second = await uploadBotAttachmentFiles({
      files: [file('again.txt')],
      getAttachmentCount: () => count,
      upload,
      onUploaded,
    });

    expect(first.successes[0]?.objectId).toBe('object-1');
    expect(second.successes[0]?.objectId).toBe('object-2');
  });
});

describe('Bot attachment preparation and concurrency', () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  };

  test('converts HEIC photos to JPEG through the injected converter and keeps the original name in reports', async () => {
    const uploads: Array<{ name: string; contentType: string }> = [];
    const result = await uploadBotAttachmentFiles({
      files: [file('IMG_0001.HEIC', 'image/heic', 'raw-heic')],
      getAttachmentCount: () => 0,
      upload: async ({ file: uploaded, contentType }) => {
        uploads.push({ name: uploaded.name, contentType });
        return 'object-1';
      },
      onUploaded: () => {},
      converters: {
        convertHeic: async (source) => new File(['jpeg-bytes'], source.name.replace(/\.heic$/iu, '.jpg'), { type: 'image/jpeg' }),
      },
    });
    expect(uploads).toEqual([{ name: 'IMG_0001.jpg', contentType: 'image/jpeg' }]);
    expect(result.successes).toEqual([{ filename: 'IMG_0001.HEIC', objectId: 'object-1' }]);
    expect(result.failures).toEqual([]);
  });

  test('reports a HEIC photo as unsupported when no converter is available', async () => {
    const result = await uploadBotAttachmentFiles({
      files: [file('IMG_0002.heic', 'image/heic')],
      getAttachmentCount: () => 0,
      upload: async () => { throw new Error('must not upload'); },
      onUploaded: () => {},
      converters: { convertHeic: async () => null },
    });
    expect(result.failures).toEqual([{ filename: 'IMG_0002.heic', reason: 'unsupported_type' }]);
  });

  test('downscales oversized rasters before the byte limit so a huge photo is accepted smaller', async () => {
    const huge = file('photo.png', 'image/png', 'x'.repeat(64));
    Object.defineProperty(huge, 'size', { value: BOT_ATTACHMENT_MAX_BYTES + 1 });
    const uploads: Array<{ name: string; contentType: string; size: number }> = [];
    const result = await uploadBotAttachmentFiles({
      files: [huge, file('notes.txt')],
      getAttachmentCount: () => 0,
      upload: async ({ file: uploaded, contentType }) => {
        uploads.push({ name: uploaded.name, contentType, size: uploaded.size });
        return `object-${uploads.length}`;
      },
      onUploaded: () => {},
      converters: {
        downscaleImage: async (source, contentType) => (
          contentType === 'image/png' ? new File(['small'], source.name, { type: 'image/png' }) : null
        ),
      },
    });
    expect(uploads.find((entry) => entry.name === 'photo.png')).toEqual({ name: 'photo.png', contentType: 'image/png', size: 5 });
    expect(result.successes.map((entry) => entry.filename)).toEqual(['photo.png', 'notes.txt']);
    expect(result.failures).toEqual([]);
  });

  test('overlaps uploads but reports attachments in selection order', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const order: string[] = [];
    const started: string[] = [];
    const run = uploadBotAttachmentFiles({
      files: [file('a.txt'), file('b.txt'), file('c.txt')],
      getAttachmentCount: () => order.length,
      upload: async ({ file: uploaded }) => {
        started.push(uploaded.name);
        if (uploaded.name === 'a.txt') return first.promise;
        if (uploaded.name === 'b.txt') return second.promise;
        return 'object-c';
      },
      onUploaded: ({ objectId }) => { order.push(objectId); },
      concurrency: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toEqual(['a.txt', 'b.txt']);
    second.resolve('object-b');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual([]);
    first.resolve('object-a');
    const result = await run;
    expect(order).toEqual(['object-a', 'object-b', 'object-c']);
    expect(result.successes.map((entry) => entry.objectId)).toEqual(['object-a', 'object-b', 'object-c']);
  });

  test('reserves count slots exactly while uploads overlap', async () => {
    const files = Array.from({ length: 4 }, (_, index) => file(`f${index}.txt`));
    const result = await uploadBotAttachmentFiles({
      files,
      getAttachmentCount: () => BOT_ATTACHMENT_MAX_COUNT - 2,
      upload: async ({ file: uploaded }) => `object-${uploaded.name}`,
      onUploaded: () => {},
      concurrency: 2,
    });
    expect(result.successes.map((entry) => entry.objectId)).toEqual(['object-f0.txt', 'object-f1.txt']);
    expect(result.failures).toEqual([
      { filename: 'f2.txt', reason: 'attachment_limit' },
      { filename: 'f3.txt', reason: 'attachment_limit' },
    ]);
  });
});
