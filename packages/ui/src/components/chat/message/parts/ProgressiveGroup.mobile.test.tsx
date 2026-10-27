import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, mock, test } from 'bun:test';
import type { TurnActivityRecord } from '../../lib/turns/types';

const realReasoningGroup = { ...(await import('./ReasoningGroup')) };
afterAll(() => {
  mock.module('./ReasoningGroup', () => realReasoningGroup);
});

// The reasoning renderer is replaced by a probe that reports exactly what ProgressiveGroup forwards.
mock.module('./ReasoningGroup', () => ({
  default: (props: { entries: unknown[]; isMobile?: boolean; isMessageCompleted?: boolean; isTrailingLiveRun?: boolean }) => (
    <i
      data-reasoning-probe="true"
      data-entries={props.entries.length}
      data-mobile={String(props.isMobile)}
      data-completed={String(props.isMessageCompleted)}
      data-trailing={String(props.isTrailingLiveRun)}
    />
  ),
}));

const { default: ProgressiveGroup } = await import('./ProgressiveGroup');

const clippedXaiPreview = `${'x'.repeat(200)}...`;

const reasoning = (id: string, text: string, providerID?: string, ended = true): TurnActivityRecord => ({
  id,
  turnId: 'turn_1',
  messageId: 'msg_1',
  partIndex: 0,
  kind: 'reasoning',
  providerID,
  part: { id, type: 'reasoning', text, ...(ended ? { time: { start: 1, end: 2 } } : {}) } as unknown as Part,
});

const render = (
  parts: TurnActivityRecord[],
  overrides: Partial<React.ComponentProps<typeof ProgressiveGroup>> = {},
) => renderToStaticMarkup(
  <ProgressiveGroup
    parts={parts}
    isExpanded
    onToggle={() => undefined}
    syntaxTheme={{}}
    isMobile={false}
    expandedTools={new Set()}
    onToggleTool={() => undefined}
    onShowPopup={() => undefined}
    streamPhase="completed"
    showHeader={false}
    animateRows={false}
    {...overrides}
  />,
);

const probes = (html: string) => [...html.matchAll(/<i data-reasoning-probe="true" data-entries="(\d+)" data-mobile="(\w+)" data-completed="(\w+)" data-trailing="(\w+)"/g)]
  .map((match) => ({ entries: Number(match[1]), mobile: match[2], completed: match[3], trailing: match[4] }));

describe('ProgressiveGroup mobile reasoning', () => {
  test('forwards mobile, terminal, and trailing-run state to every reasoning group renderer', () => {
    const single = probes(render([reasoning('r1', 'Thinking about it.')], { isMobile: true, streamPhase: 'completed' }));
    expect(single).toEqual([{ entries: 1, mobile: 'true', completed: 'true', trailing: 'true' }]);

    const grouped = probes(render(
      [reasoning('r1', 'First thought.'), reasoning('r2', 'Second thought.')],
      { isMobile: true, streamPhase: 'streaming' },
    ));
    expect(grouped).toEqual([{ entries: 2, mobile: 'true', completed: 'false', trailing: 'true' }]);

    expect(probes(render([reasoning('r1', 'Desktop thought.')]))[0]?.mobile).toBe('false');
  });

  test('removes clipped xAI reasoning before activity rows and preview counts are derived', () => {
    const clipped = reasoning('clipped', clippedXaiPreview, 'xai');
    const visible = reasoning('visible', 'Complete reasoning.', 'xai');

    // Only the visible reasoning survives, so a single row (not a two-entry group) is rendered.
    expect(probes(render([clipped, visible]))).toEqual([
      { entries: 1, mobile: 'false', completed: 'true', trailing: 'true' },
    ]);
    // Other providers keep the same text.
    expect(probes(render([reasoning('a', clippedXaiPreview, 'openai'), visible]))[0]?.entries).toBe(2);
    // A group whose only content was clipped renders nothing at all.
    expect(render([clipped])).toBe('');
    // The collapsed preview does not count the clipped row either.
    const collapsed = render([clipped, visible], {
      showHeader: true,
      isExpanded: false,
      collapsedPreviewCount: 1,
    });
    expect(probes(collapsed)).toHaveLength(1);
    expect(collapsed).not.toContain('More...');
  });
});
