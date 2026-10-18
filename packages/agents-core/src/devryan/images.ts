// DevRyan: the original image attachment algorithm writes into the workspace,
// so it runs only in the confined image worker whose process cwd is the
// private workspace view (bound via bindReviewedSlimImageWorker). Slim 3.x keeps
// no per-directory state, so there is nothing to snapshot or restore between
// worker runs; the saved files themselves are the only memo.
import { processImageAttachments } from '../hooks/image-hook';
import { requireReviewedSlimImageWorker } from './owners';

export function processReviewedSlimImageAttachments(
  args: Parameters<typeof processImageAttachments>[0],
): boolean {
  requireReviewedSlimImageWorker(args.workDir);
  return processImageAttachments(args);
}
