import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createReviewedSetupSession } from './reviewed-setup.mjs';

const require = createRequire(new URL('../../packages/web/package.json', import.meta.url));
const AdmZip = require('adm-zip');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function createDocx(paragraphs) {
  const docx = new AdmZip();
  docx.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  docx.addFile('_rels/.rels', Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  const body = paragraphs.map(text => `<w:p><w:r><w:t>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</w:t></w:r></w:p>`).join('');
  docx.addFile('word/document.xml', Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`));
  return docx.toBuffer();
}
export function createCompiledDocumentInputs() {
  const paragraphs = [...Array(1600).fill('Native document continuity'), 'Final searchable marker'];
  // Mammoth's original raw-text contract separates paragraphs with two LFs.
  return { text: paragraphs.join('\n\n') + '\n\n', inputs: [
    { filename: 'continuity.docx', mime: docxMime, bytes: createDocx(paragraphs) },
    { filename: 'compiled.docx', mime: docxMime, bytes: createDocx(['Compiled original DOCX verified']) },
  ] };
}

/** Real canonical uploads and the compiled original parser/cache/tool path. */
export async function runCompiledDocuments({ invoke, client, directory, admitPrimary }) {
  const session = await createReviewedSetupSession({ client, directory, admitPrimary,
    input: { title: 'Compiled document attachments', agent: 'orchestrator', model: { providerID: 'devryan-smoke', modelID: 'smoke-write' } } });
  // Text/plain uploads deliberately become native prompt attachment segments,
  // so both parser-cache witnesses use canonical supported file containers.
  const { text, inputs } = createCompiledDocumentInputs();
  const invokeDocument = async (id, input, parts) => {
    const call = await invoke({ id, tool: 'devryan_document', control: true, input }, { sessionID: session.id, directory, ...(parts ? { parts } : {}) });
    assert.ok(Buffer.byteLength(call.state.output, 'utf8') <= 32768, 'Original document result exceeded its byte bound');
    return JSON.parse(call.state.output);
  };
  const listed = await invokeDocument('compiled-documents-list', { action: 'list' }, inputs.map(({ filename, mime, bytes }) => ({
    type: 'file', filename, mime, url: `data:${mime};base64,${bytes.toString('base64')}`,
  })));
  assert.equal(listed.truncated, false); assert.equal(listed.documents.length, 2);
  const continuity = listed.documents.find(row => row.name === 'continuity.docx'), office = listed.documents.find(row => row.name === 'compiled.docx');
  for (const document of [continuity, office]) { assert.ok(document?.id); assert.equal(document.scope, 'current'); assert.equal(document.parent_depth, 0); }
  assert.equal(continuity.characters, text.length);
  // The original result has a 32KiB JSON byte cap; a 16Ki-character request
  // leaves room for escaped newlines and metadata without fit truncation.
  const limit = 16384;
  const first = await invokeDocument('compiled-document-bounded-read', { action: 'read', document_id: continuity.id, offset: 0, limit });
  assert.equal(first.text, text.slice(0, limit)); assert.equal(first.next_offset, first.text.length); assert.equal(first.total_characters, text.length);
  assert.equal(first.end_offset, first.text.length); assert.equal(first.output_truncated, undefined);
  let assembled = first.text, offset = first.next_offset, reads = 1;
  while (offset !== null) {
    assert.ok(reads < 5, 'Document offset reads exceeded declared bound');
    const tail = await invokeDocument(`compiled-document-offset-read-${reads}`, { action: 'read', document_id: continuity.id, offset, limit });
    assert.equal(tail.offset, offset); assert.equal(tail.text, text.slice(offset, offset + limit)); assert.ok(tail.text.length > 0 && tail.text.length <= limit);
    assert.equal(tail.end_offset, offset + tail.text.length); assert.equal(tail.total_characters, text.length); assert.equal(tail.output_truncated, undefined);
    assert.equal(tail.next_offset, tail.end_offset < text.length ? tail.end_offset : null);
    assembled += tail.text; offset = tail.next_offset; reads++;
  }
  assert.ok(reads >= 3); assert.equal(assembled, text);
  const officeText = await invokeDocument('compiled-document-docx-read', { action: 'read', document_id: office.id });
  assert.match(officeText.text, /Compiled original DOCX verified/);
  const found = await invokeDocument('compiled-document-search', { action: 'search', document_id: continuity.id, query: 'Final searchable marker', max_results: 1 });
  assert.equal(found.matches.length, 1); assert.equal(found.matches[0].offset, text.indexOf('Final searchable marker'));
  return { id: 'compiled-document-attachments', status: 'passed', sessionID: session.id,
    source: 'canonical-native-uploads-compiled-original-parser-cache-and-owned-control-tools',
    inputs: inputs.map(({ filename, mime, bytes }) => ({ filename, mime, bytes: bytes.length, sha256: hash(bytes) })),
    documentIDs: [continuity.id, office.id], readChunks: reads, extractedCharacters: text.length,
    checks: ['list-two-documents', 'bounded-read', 'offset-read-exact-reassembly', 'docx-read', 'search'] };
}
