// Test wrapper, never part of the product: runs a sequence of calls on one controller made by
// `createPromptAdmissionController` and returns every result. `acquire` returns the hold's index;
// `release` calls the release function of the hold with that index.
import { createPromptAdmissionController } from '../../../../../harness-runtime/lib/prompt-admission.js';

/**
 * @param {{ op: string, name?: unknown, block?: unknown, hold?: number }[]} steps
 * @returns {unknown[]}
 */
export function runPromptAdmission(steps) {
  const controller = createPromptAdmissionController();
  const releases = [];
  return steps.map((step) => {
    if (step.op === 'acquire') return releases.push(controller.acquireHold(step.name, step.block)) - 1;
    if (step.op === 'release') return releases[step.hold]();
    if (step.op === 'markReady') return controller.markReady();
    if (step.op === 'beginDrain') return controller.beginDrain();
    if (step.op === 'isReady') return controller.isReady();
    if (step.op === 'isAccepting') return controller.isAccepting();
    return controller.getBlock();
  });
}
