// DevRyan test support: the upstream interview tests drive the service with
// the original document functions over the real filesystem, standing in for
// the host's confined interview owner.
import * as fs from 'node:fs/promises';
import {
  appendInterviewAnswers,
  claimInterviewDocument,
  ensureInterviewFile,
  markInterviewDocumentComplete,
  markInterviewDocumentIncomplete,
  readInterviewDocument,
  resolveExistingInterviewPath,
  rewriteInterviewDocument,
  rewriteInterviewDocumentWithFinalSpec,
  withInterviewDocumentLock,
} from './document';
import type { InterviewDocuments } from './owned-documents';
import { createV1InterviewSessionRuntime } from './runtime';
import { createInterviewService as createOwnedInterviewService } from './service';

export const nodeInterviewDocuments: InterviewDocuments = {
  withLock: withInterviewDocumentLock,
  ensure: ensureInterviewFile,
  claim: claimInterviewDocument,
  read: readInterviewDocument,
  rewrite: rewriteInterviewDocument,
  rewriteFinal: rewriteInterviewDocumentWithFinalSpec,
  markComplete: markInterviewDocumentComplete,
  markIncomplete: markInterviewDocumentIncomplete,
  appendAnswers: appendInterviewAnswers,
  readText: (file, encoding) => fs.readFile(file, encoding),
  list: (directory) => fs.readdir(directory),
  stat: (file) => fs.stat(file),
  resolveExisting: async (directory, outputFolder, value) =>
    resolveExistingInterviewPath(directory, outputFolder, value),
};

type Context = Parameters<typeof createOwnedInterviewService>[0];
type Config = Parameters<typeof createOwnedInterviewService>[1];
type Dependencies = Parameters<typeof createOwnedInterviewService>[2];

export function createInterviewService(
  ctx: Context,
  config?: Config,
  deps?: Partial<Dependencies>,
): ReturnType<typeof createOwnedInterviewService> {
  return createOwnedInterviewService(ctx, config, {
    documents: nodeInterviewDocuments,
    runtime: deps?.runtime ?? createV1InterviewSessionRuntime(ctx),
    openBrowser: deps?.openBrowser ?? (() => {}),
    ...(deps?.env ? { env: deps.env } : {}),
  });
}
export { MAX_RETAINED_ABANDONED } from './service';
