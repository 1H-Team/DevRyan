import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCompiledDocumentInputs } from './package-document-lane.mjs';
import { buildV2PromptContent } from '../../packages/web/server/lib/opencode/v2/admission.js';
const require = createRequire(new URL('../../packages/web/package.json', import.meta.url));
const mammoth = require('mammoth');

test('actual DOCX extraction retains the long fixture text and native admission retains both canonical files', async () => {
  const { text, inputs } = createCompiledDocumentInputs();
  assert.equal(inputs.length, 2); assert.ok(text.length > 32768 && text.length < 3 * 16384);
  const long = await mammoth.extractRawText({ buffer: inputs[0].bytes });
  const short = await mammoth.extractRawText({ buffer: inputs[1].bytes });
  assert.equal(long.value, text); assert.equal(short.value, 'Compiled original DOCX verified\n\n');
  assert.equal(long.messages.length, 0); assert.equal(short.messages.length, 0);
  const content = buildV2PromptContent(inputs.map(({ filename, mime, bytes }) => ({ type: 'file', filename, mime,
    url: `data:${mime};base64,${bytes.toString('base64')}` })));
  assert.equal(content.files.length, 2); assert.equal(content.text, '');
  assert.deepEqual(content.files.map(file => file.name), ['continuity.docx', 'compiled.docx']);
  const inline = buildV2PromptContent([{ type: 'file', filename: 'continuity.txt', mime: 'text/plain',
    url: 'data:text/plain;base64,' + Buffer.from(text).toString('base64') }]);
  assert.equal(inline.files.length, 0); assert.equal(inline.segments[0].kind, 'attachment');
});
