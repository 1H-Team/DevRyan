import fs from 'node:fs/promises';import {expect,test} from 'vitest';
import {rewriteReviewedDocumentReader} from './reviewed-document-transform.js';
import {rewriteReviewedBrowser} from './reviewed-browser-transform.js';
test('exact original production document/tool and browser state machines gain only owned I/O seams',async()=>{
 const document=await fs.readFile(new URL('../../../default-config/plugins/devryan-document-reader.mjs',import.meta.url));
 const browser=await fs.readFile(new URL('../../../default-config/plugins/devryan-browser.mjs',import.meta.url));
 const docs=rewriteReviewedDocumentReader(document),browsers=rewriteReviewedBrowser(browser);
 expect(docs).toEqual(rewriteReviewedDocumentReader(document));expect(browsers).toEqual(rewriteReviewedBrowser(browser));
 expect(docs.transforms).toHaveLength(9);expect(browsers.transforms).toHaveLength(8);
 expect(docs.contents).toContain('const createDocumentTool = ({ client, directory }) => tool({');expect(docs.contents).toContain('const parseAttachmentPayload = async (payload) => {');
 expect(docs.contents).toContain('requireReviewedDocumentOwner().parseAttachment(payload)');expect(docs.contents).toContain('requireReviewedDocumentOwner().listAccessibleDocuments');
 expect(browsers.contents).toContain('const executeCommand = async (input, context, sequence) => {');expect(browsers.contents).toContain('parseBrowserInspectionResult(result, inspection, sensitiveValues)');
 expect(browsers.contents).toContain('const runReviewedBrowserBinary = ({');expect(browsers.contents).toContain('requireReviewedBrowserOwner().runBinary(input)');
 expect(browsers.contents).toContain('export const reviewedBrowserInputSchema=tool.schema.object(reviewedBrowserArguments)');
 expect(()=>rewriteReviewedDocumentReader(Buffer.concat([document,Buffer.from('\n')]))).toThrow('reviewed_document_source_changed');
 expect(()=>rewriteReviewedBrowser(Buffer.concat([browser,Buffer.from('\n')]))).toThrow('reviewed_browser_source_changed');
});
