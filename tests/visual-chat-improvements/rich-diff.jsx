import React from 'react';
import { PatchDiff as ProductionPatchDiff } from '@pierre/diffs/react';

export function PatchDiff(props) {
    globalThis.__fixtureRichDiffCalls = (globalThis.__fixtureRichDiffCalls ?? 0) + 1;
    if (props.patch.includes('fixture-renderer-error')) throw new Error('Deliberate fixture diff renderer failure');
    return <ProductionPatchDiff {...props} />;
}
