import React, { act } from 'react';
import { describe, expect, spyOn, test } from 'bun:test';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

const mount = async (element: React.ReactElement, run: (container: HostElement) => void | Promise<void>) => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  // React logs caught render errors; the assertions below are about what stays on screen.
  const consoleError = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => { root.render(element); });
    await run(container);
  } finally {
    await act(async () => { root.unmount(); });
    consoleError.mockRestore();
  }
});

describe('Tooltip safety boundary', () => {
  test('keeps the trigger children on screen when the trigger part throws', async () => {
    // A trigger rendered outside any Tooltip root has no context, so Base UI throws.
    await mount(<TooltipTrigger><span>still visible</span></TooltipTrigger>, (container) => {
      expect(container.textContent).toContain('still visible');
    });
  });

  test('renders nothing instead of crashing the tree when the content part throws', async () => {
    await mount(
      <div>
        <span>sibling</span>
        <TooltipContent>orphan tip</TooltipContent>
      </div>,
      (container) => {
        expect(container.textContent).toBe('sibling');
      },
    );
  });

  test('renders a trigger normally inside a Tooltip root', async () => {
    await mount(
      <Tooltip><TooltipTrigger><span>normal trigger</span></TooltipTrigger></Tooltip>,
      (container) => {
        expect(container.textContent).toContain('normal trigger');
      },
    );
  });
});
