import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const source = readFileSync(
  fileURLToPath(new URL('./ProgressiveGroup.tsx', import.meta.url)),
  'utf8',
);

describe('ProgressiveGroup mobile reasoning', () => {
  test('forwards mobile, terminal, and trailing-run state to every reasoning group renderer', () => {
    expect(source).toContain('isMobile: boolean;')
    expect(source.match(/isMessageCompleted=\{isMessageCompleted\}\s+isTrailingLiveRun=\{index === visibleRows\.length - 1\}\s+isMobile=\{isMobile\}/g)).toHaveLength(2)
  })

  test('removes clipped xAI reasoning before activity rows and preview counts are derived', () => {
    const filterIndex = source.indexOf('const displayableParts = React.useMemo(')
    const aggregationIndex = source.indexOf('return aggregateRows(displayableParts)')
    const previewCountIndex = source.indexOf('const previewHiddenCount = React.useMemo(')

    expect(filterIndex).toBeGreaterThan(-1)
    expect(aggregationIndex).toBeGreaterThan(filterIndex)
    expect(previewCountIndex).toBeGreaterThan(aggregationIndex)
    expect(source).toContain('filterKnownClippedXaiReasoningActivities(sortedParts, providerID)')
    expect(source).toContain('if (shouldRenderRows && rows.length === 0)')
  })
})
