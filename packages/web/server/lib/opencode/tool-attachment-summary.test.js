import { describe, expect, it } from 'vitest';

import {
  estimateDataUriBytes,
  isToolAttachmentOmissionEnabled,
  stripBrowserEventPayload,
  stripEventToolAttachmentData,
  stripMessageToolAttachmentData,
  stripToolPartAttachmentData,
  TOOL_ATTACHMENT_INLINE_LIMIT,
  TOOL_ATTACHMENT_OMIT_ENV,
} from './tool-attachment-summary.js';

const ON = {};
const largeBase64 = 'A'.repeat(TOOL_ATTACHMENT_INLINE_LIMIT + 4);
const largeUri = `data:image/png;base64,${largeBase64}`;
const smallUri = 'data:image/png;base64,iVBORw0KGgo=';

const attachment = (index, url, mime = 'image/png') => ({
  id: `prt_msg_1:call_1:attachment:${index}`, sessionID: 'ses_1', messageID: 'msg_1', type: 'file', mime, url,
});

const toolPart = (attachments) => ({
  id: 'prt_tool', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', callID: 'call_1', tool: 'browser_screenshot',
  state: { status: 'completed', input: {}, output: 'ok', title: '', metadata: {}, time: { start: 1, end: 2 }, attachments },
});

describe('tool attachment trim', () => {
  it('replaces large data URIs with a size placeholder and keeps small ones inline', () => {
    const part = toolPart([attachment(0, largeUri), attachment(1, smallUri)]);
    const stripped = stripToolPartAttachmentData(part, ON);
    expect(stripped).not.toBe(part);
    expect(stripped.state.attachments[0]).toEqual({
      ...attachment(0, ''), devryanOmitted: { bytes: (largeBase64.length * 3) / 4 },
    });
    expect(stripped.state.attachments[1]).toBe(part.state.attachments[1]);
    expect(stripped.state.output).toBe('ok');
    // The source part is never mutated.
    expect(part.state.attachments[0].url).toBe(largeUri);
  });

  it('returns the same reference when nothing is trimmed', () => {
    const remote = toolPart([attachment(0, `https://example.test/${'a'.repeat(TOOL_ATTACHMENT_INLINE_LIMIT + 10)}`)]);
    for (const part of [toolPart([attachment(0, smallUri)]), toolPart([]), remote, { type: 'text', text: largeUri }, null]) {
      expect(stripToolPartAttachmentData(part, ON)).toBe(part);
    }
  });

  it('honours the kill switch on every call', () => {
    const part = toolPart([attachment(0, largeUri)]);
    for (const value of ['off', 'OFF', '0', 'false']) {
      expect(isToolAttachmentOmissionEnabled({ [TOOL_ATTACHMENT_OMIT_ENV]: value })).toBe(false);
      expect(stripToolPartAttachmentData(part, { [TOOL_ATTACHMENT_OMIT_ENV]: value })).toBe(part);
    }
    expect(isToolAttachmentOmissionEnabled({ [TOOL_ATTACHMENT_OMIT_ENV]: 'on' })).toBe(true);
    expect(stripToolPartAttachmentData(part, ON)).not.toBe(part);
  });

  it('trims message records and live part events but leaves other events alone', () => {
    const part = toolPart([attachment(0, largeUri)]);
    const record = { info: { id: 'msg_1', role: 'assistant' }, parts: [{ type: 'text', text: 'hi' }, part] };
    const strippedRecord = stripMessageToolAttachmentData(record, ON);
    expect(strippedRecord.parts[0]).toBe(record.parts[0]);
    expect(strippedRecord.parts[1].state.attachments[0].url).toBe('');

    const event = { type: 'message.part.updated', properties: { sessionID: 'ses_1', part, time: 3 } };
    const strippedEvent = stripEventToolAttachmentData(event, ON);
    expect(strippedEvent.properties.part.state.attachments[0].devryanOmitted.bytes).toBeGreaterThan(0);
    expect(strippedEvent.properties.time).toBe(3);

    const other = { type: 'message.updated', properties: { info: { id: 'msg_1' } } };
    expect(stripEventToolAttachmentData(other, ON)).toBe(other);
  });

  it('composes with the diff trim for the browser fan-out', () => {
    const event = { type: 'message.part.updated', properties: { part: toolPart([attachment(0, largeUri)]) } };
    expect(stripBrowserEventPayload(event).properties.part.state.attachments[0].url).toBe('');
    const message = { type: 'message.updated', properties: { info: { id: 'm', summary: { diffs: [{ file: 'a', patch: 'x' }] } } } };
    expect(stripBrowserEventPayload(message).properties.info.summary.diffs[0]).toEqual({ file: 'a' });
  });

  it('estimates decoded sizes without decoding', () => {
    expect(estimateDataUriBytes('data:image/png;base64,QUJD')).toBe(3);
    expect(estimateDataUriBytes('data:image/png;base64,QUI=')).toBe(2);
    expect(estimateDataUriBytes('data:image/png;base64,QQ==')).toBe(1);
    expect(estimateDataUriBytes('data:text/plain,hello')).toBe(5);
    expect(estimateDataUriBytes('data:broken')).toBe(0);
  });
});
