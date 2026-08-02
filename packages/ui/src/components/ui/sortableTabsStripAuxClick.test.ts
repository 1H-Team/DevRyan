import { describe, expect, test } from 'bun:test';

import { handleClosableTabAuxClick } from './sortableTabsStripAuxClick';

const createAuxClickHarness = (button: number) => {
  let preventDefaultCalls = 0;
  let stopPropagationCalls = 0;
  const closedTabIDs: string[] = [];

  return {
    event: {
      button,
      preventDefault: () => {
        preventDefaultCalls += 1;
      },
      stopPropagation: () => {
        stopPropagationCalls += 1;
      },
    },
    onClose: (tabID: string) => {
      closedTabIDs.push(tabID);
    },
    result: () => ({
      preventDefaultCalls,
      stopPropagationCalls,
      closedTabIDs,
    }),
  };
};

describe('handleClosableTabAuxClick', () => {
  test('closes once and consumes a middle click', () => {
    const harness = createAuxClickHarness(1);

    expect(handleClosableTabAuxClick(harness.event, 'plan', harness.onClose)).toBe(true);
    expect(harness.result()).toEqual({
      preventDefaultCalls: 1,
      stopPropagationCalls: 1,
      closedTabIDs: ['plan'],
    });
  });

  test('ignores left and right mouse buttons', () => {
    for (const button of [0, 2]) {
      const harness = createAuxClickHarness(button);

      expect(handleClosableTabAuxClick(harness.event, 'preview', harness.onClose)).toBe(false);
      expect(harness.result()).toEqual({
        preventDefaultCalls: 0,
        stopPropagationCalls: 0,
        closedTabIDs: [],
      });
    }
  });

  test('leaves tabs without a close action untouched', () => {
    const harness = createAuxClickHarness(1);

    expect(handleClosableTabAuxClick(harness.event, 'usage', undefined)).toBe(false);
    expect(harness.result()).toEqual({
      preventDefaultCalls: 0,
      stopPropagationCalls: 0,
      closedTabIDs: [],
    });
  });
});
