import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  finishConfigUpdate,
  getConfigUpdateSnapshot,
  startConfigUpdate,
} from '@/lib/configUpdate';
import { ConfigUpdateOverlay } from './ConfigUpdateOverlay';

const clearUpdates = () => {
  while (getConfigUpdateSnapshot().isUpdating) {
    finishConfigUpdate();
  }
};

beforeEach(clearUpdates);
afterEach(clearUpdates);

describe('ConfigUpdateOverlay', () => {
  test('stays absent when no authoritative restart is active', () => {
    expect(renderToStaticMarkup(<ConfigUpdateOverlay />)).toBe('');
  });

  test('uses the shared opaque whole-app loading screen during restart', () => {
    startConfigUpdate('Restarting OpenCode and restoring configuration…');

    const markup = renderToStaticMarkup(<ConfigUpdateOverlay />);
    expect(markup).toContain('data-runtime-loading-screen=""');
    expect(markup).toContain('data-mode="overlay"');
    expect(markup).toContain('fixed inset-0 z-[9999]');
    expect(markup).toContain('bg-background');
    expect(markup).not.toContain('bg-background/90');
    expect(markup).toContain('Restarting OpenCode and restoring configuration…');
  });
});
