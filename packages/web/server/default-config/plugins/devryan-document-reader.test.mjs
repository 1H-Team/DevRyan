import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DevRyanDocumentReaderPlugin,
  __test,
} from './devryan-document-reader.mjs';

const originalConfigDirectory = process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR;
let temporaryRoot = null;

const dataUrl = (buffer, mime) => `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`;

const filePart = ({
  name,
  mime,
  contents,
  sessionID = 'ses_parent',
}) => ({
  id: `part_${name.replace(/\W/g, '_')}`,
  sessionID,
  messageID: `msg_${sessionID}`,
  type: 'file',
  mime,
  filename: name,
  url: dataUrl(contents, mime),
});

const outputWith = (parts, sessionID = 'ses_parent') => ({
  messages: [{
    info: { id: `msg_${sessionID}`, role: 'user', sessionID },
    parts,
  }],
});

const makePdf = (text = 'Hello from PDF') => {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET` : 'q Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
};

const makeDocx = (text = 'Hello from DOCX') => {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
    </w:document>`));
  return zip.toBuffer();
};

const makeZip = (files) => {
  const zip = new AdmZip();
  for (const [name, contents] of Object.entries(files)) zip.addFile(name, Buffer.from(contents));
  return zip.toBuffer();
};

beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-document-reader-'));
  process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR = temporaryRoot;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalConfigDirectory === undefined) delete process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR;
  else process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR = originalConfigDirectory;
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = null;
});

describe('DevRyan document reader parsing', () => {
  it('decodes BOM text and falls back to Windows-1252', () => {
    expect(__test.decodeTextBuffer(Buffer.from([0xef, 0xbb, 0xbf, 0x61])).text).toBe('a');
    expect(__test.decodeTextBuffer(Buffer.from([0x63, 0x61, 0x66, 0xe9])).text).toBe('café');
  });

  it('extracts text from real PDF and DOCX containers', async () => {
    const pdf = await __test.parseAttachmentPayload({
      bytes: makePdf(),
      name: 'sample.pdf',
      type: 'pdf',
    });
    const docx = await __test.parseAttachmentPayload({
      bytes: makeDocx(),
      name: 'sample.docx',
      type: 'docx',
    });

    expect(pdf.documents[0].text).toContain('[Page 1]');
    expect(pdf.documents[0].text).toContain('Hello from PDF');
    expect(docx.documents[0].text).toContain('Hello from DOCX');
  });

  it('reports scanned PDFs instead of returning empty text', async () => {
    await expect(__test.parseAttachmentPayload({
      bytes: makePdf(''),
      name: 'scan.pdf',
      type: 'pdf',
    })).rejects.toMatchObject({ code: 'DOCUMENT_PDF_OCR_REQUIRED' });
  });

  it('reads supported ZIP entries and reports nested, unsupported, and corrupt entries explicitly', async () => {
    const result = await __test.parseAttachmentPayload({
      bytes: makeZip({
        'reports/data.csv': 'name,value\nalpha,1\n',
        'reports/note.docx': makeDocx('Archived DOCX'),
        'reports/bad.pdf': 'not a pdf',
        'reports/nested.zip': makeZip({ 'inner.csv': 'a,b\n1,2\n' }),
        'reports/image.bin': 'binary',
      }),
      name: 'reports.zip',
      type: 'zip',
    });

    expect(result.documents.map((document) => document.name)).toEqual(expect.arrayContaining([
      'reports.zip!/reports/data.csv',
      'reports.zip!/reports/note.docx',
    ]));
    expect(result.manifest).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'reports/bad.pdf', status: 'failed' }),
      expect.objectContaining({ name: 'reports/nested.zip', status: 'skipped' }),
      expect.objectContaining({ name: 'reports/image.bin', status: 'skipped' }),
    ]));
  });

  it('rejects unsafe, encrypted, and symlink archive entries', () => {
    const traversal = new AdmZip(makeZip({ 'safe.csv': 'a,b\n' }));
    traversal.getEntries()[0].entryName = '../escape.csv';
    expect(() => __test.preflightArchive(traversal.toBuffer())).toThrow(expect.objectContaining({
      code: 'DOCUMENT_ARCHIVE_INVALID_PATH',
    }));

    const encrypted = new AdmZip(makeZip({ 'safe.csv': 'a,b\n' }));
    encrypted.getEntries()[0].header.flags |= 0x1;
    expect(() => __test.preflightArchive(encrypted.toBuffer())).toThrow(expect.objectContaining({
      code: 'DOCUMENT_ARCHIVE_ENCRYPTED',
    }));

    const symlink = new AdmZip();
    const link = symlink.addFile('link.csv', Buffer.from('target'));
    link.header.made = 0x0314;
    link.header.attr = (0xa1ff << 16) >>> 0;
    expect(() => __test.preflightArchive(symlink.toBuffer())).toThrow(expect.objectContaining({
      code: 'DOCUMENT_ARCHIVE_UNSAFE_ENTRY',
    }));

    const collision = new AdmZip();
    collision.addFile('Readme.csv', Buffer.from('one'));
    collision.addFile('README.csv', Buffer.from('two'));
    expect(() => __test.preflightArchive(collision.toBuffer())).toThrow(expect.objectContaining({
      code: 'DOCUMENT_ARCHIVE_PATH_COLLISION',
    }));
  });

  it('terminates stalled workers and maps isolated parser failures to stable errors', async () => {
    class SilentWorker extends EventEmitter {
      terminate() { return Promise.resolve(); }
    }
    class FailedWorker extends EventEmitter {
      constructor() {
        super();
        queueMicrotask(() => this.emit('error', new Error('out of memory')));
      }
      terminate() { return Promise.resolve(); }
    }

    await expect(__test.runWorkerParse(
      { bytes: Buffer.from('a,b\n'), name: 'data.csv', type: 'text' },
      { WorkerClass: SilentWorker, timeoutMs: 5 },
    )).rejects.toMatchObject({ code: 'DOCUMENT_EXTRACTION_TIMEOUT' });
    await expect(__test.runWorkerParse(
      { bytes: Buffer.from('a,b\n'), name: 'data.csv', type: 'text' },
      { WorkerClass: FailedWorker, timeoutMs: 100 },
    )).rejects.toMatchObject({ code: 'DOCUMENT_WORKER_FAILED' });
  });
});

describe('DevRyan document reader plugin', () => {
  it('removes a historical ZIP from provider-visible history and reuses its cache', async () => {
    const parseAttachment = vi.fn(__test.parseAttachmentPayload);
    const plugin = await DevRyanDocumentReaderPlugin({ parseAttachment });
    const archive = makeZip({
      'Chart.csv': 'label,value\nA,1\n',
      'Metadata.csv': 'field,value\nsite,example.test\n',
    });
    const canonical = () => outputWith([
      filePart({ name: 'coverage.zip', mime: 'application/zip', contents: archive }),
      { type: 'text', text: 'try again' },
    ]);

    const first = canonical();
    await plugin['experimental.chat.messages.transform']({}, first);
    expect(first.messages[0].parts.every((part) => part.type !== 'file')).toBe(true);
    expect(first.messages[0].parts[0].text).toContain('Chart.csv');
    expect(first.messages[0].parts[0].text).toContain('site,example.test');

    const second = canonical();
    await plugin['experimental.chat.messages.transform']({}, second);
    expect(second.messages[0].parts[0].text).toContain('site,example.test');
    expect(parseAttachment).toHaveBeenCalledTimes(1);

    const cacheDirectory = __test.getSessionCacheDirectory('ses_parent');
    const documentFile = fs.readdirSync(cacheDirectory).find((name) => name.startsWith('doc_'));
    fs.writeFileSync(path.join(cacheDirectory, documentFile), '{}\n', 'utf8');
    const recovered = canonical();
    await plugin['experimental.chat.messages.transform']({}, recovered);
    expect(recovered.messages[0].parts[0].text).toContain('site,example.test');
    expect(parseAttachment).toHaveBeenCalledTimes(2);
  });

  it('keeps images native and replaces unsupported binaries with a bounded notice', async () => {
    const plugin = await DevRyanDocumentReaderPlugin({ parseAttachment: __test.parseAttachmentPayload });
    const output = outputWith([
      filePart({ name: 'photo.png', mime: 'image/png', contents: Buffer.from([1, 2, 3]) }),
      filePart({ name: 'sheet.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contents: Buffer.from([1, 2, 3]) }),
    ]);

    await plugin['experimental.chat.messages.transform']({}, output);
    expect(output.messages[0].parts[0].type).toBe('file');
    expect(output.messages[0].parts[1]).toMatchObject({ type: 'text', synthetic: true });
    expect(output.messages[0].parts[1]).not.toHaveProperty('url');
    expect(output.messages[0].parts[1].text).toContain('DOCUMENT_UNSUPPORTED_TYPE');
  });

  it('uses an isolated worker for ordinary CSV extraction', async () => {
    const plugin = await DevRyanDocumentReaderPlugin();
    const output = outputWith([
      filePart({ name: 'sample.csv', mime: 'text/csv', contents: 'name,value\nalpha,1\n' }),
    ]);

    await plugin['experimental.chat.messages.transform']({}, output);
    expect(output.messages[0].parts[0].text).toContain('alpha,1');
  });

  it('provides bounded read/search access to current and verified parent documents only', async () => {
    const sessions = {
      ses_parent: { id: 'ses_parent' },
      ses_child: { id: 'ses_child', parentID: 'ses_parent' },
      ses_unrelated: { id: 'ses_unrelated' },
    };
    const client = {
      session: {
        get: vi.fn(async (request) => sessions[request?.path?.id || request?.sessionID] || null),
      },
    };
    const plugin = await DevRyanDocumentReaderPlugin({ client, parseAttachment: __test.parseAttachmentPayload });
    const contents = `${'prefix '.repeat(10_000)}needle value`;
    const output = outputWith([
      filePart({ name: 'large.csv', mime: 'text/csv', contents }),
    ]);
    await plugin['experimental.chat.messages.transform']({}, output);
    expect(output.messages[0].parts[0].text).toContain('Use devryan_document read or search');

    const documentTool = plugin.tool.devryan_document;
    const listed = JSON.parse(await documentTool.execute({ action: 'list' }, { sessionID: 'ses_child' }));
    expect(listed.documents).toHaveLength(1);
    expect(listed.documents[0]).toMatchObject({ scope: 'parent', parent_depth: 1 });
    const documentID = listed.documents[0].id;

    const read = JSON.parse(await documentTool.execute({
      action: 'read', document_id: documentID, offset: 0, limit: 50_000,
    }, { sessionID: 'ses_child' }));
    expect(read.text.length).toBeLessThanOrEqual(__test.constants.MAX_READ_CHARS);
    expect(Buffer.byteLength(JSON.stringify(read), 'utf8')).toBeLessThanOrEqual(__test.constants.MAX_TOOL_OUTPUT_BYTES);

    const search = JSON.parse(await documentTool.execute({
      action: 'search', document_id: documentID, query: 'needle', max_results: 20,
    }, { sessionID: 'ses_child' }));
    expect(search.matches[0].excerpt).toContain('needle value');
    await expect(documentTool.execute({
      action: 'read', document_id: documentID,
    }, { sessionID: 'ses_unrelated' })).rejects.toThrow('unavailable');
  });

  it('deletes the session-scoped cache when OpenCode deletes the task', async () => {
    const plugin = await DevRyanDocumentReaderPlugin({ parseAttachment: __test.parseAttachmentPayload });
    const output = outputWith([
      filePart({ name: 'sample.csv', mime: 'text/csv', contents: 'a,b\n1,2\n' }),
    ]);
    await plugin['experimental.chat.messages.transform']({}, output);
    const cacheDirectory = __test.getSessionCacheDirectory('ses_parent');
    expect(fs.existsSync(cacheDirectory)).toBe(true);

    await plugin.event({ event: { type: 'session.deleted', properties: { sessionID: 'ses_parent' } } });
    expect(fs.existsSync(cacheDirectory)).toBe(false);
  });

  it('prunes cache files that exceed the seven-day retention window', async () => {
    const cacheDirectory = __test.getSessionCacheDirectory('ses_stale');
    fs.mkdirSync(cacheDirectory, { recursive: true });
    const stalePath = path.join(cacheDirectory, `doc_${'a'.repeat(64)}.json`);
    fs.writeFileSync(stalePath, '{}\n', 'utf8');
    const staleTime = new Date(Date.now() - __test.constants.CACHE_TTL_MS - 1_000);
    fs.utimesSync(stalePath, staleTime, staleTime);

    await __test.pruneCache();
    expect(fs.existsSync(stalePath)).toBe(false);
  });
});
