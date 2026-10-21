import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { canReadSettingsPage, getAuthPrincipal, hasAuthCapability } from '@/lib/authSession';
import { isRuntimeFeatureAvailable } from '@/lib/opencode/runtime-capabilities';
import { botsApi } from '@/lib/botsApi';
import { BotsEventOwner } from './BotsEventOwner';

test('retired Bots stay inaccessible to the local administrator and do not fetch or subscribe', async () => withDom(async container => {
  expect(isRuntimeFeatureAvailable('bots')).toBe(false);
  expect(hasAuthCapability(getAuthPrincipal(), 'bots')).toBe(false);
  expect(canReadSettingsPage(getAuthPrincipal(), 'bots')).toBe(false);
  const capabilities = spyOn(botsApi, 'getCapabilities');
  const catalog = spyOn(botsApi, 'getAssignedCatalog');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => { root.render(<BotsEventOwner />); });
    expect(capabilities).toHaveBeenCalledTimes(0);
    expect(catalog).toHaveBeenCalledTimes(0);
  } finally {
    await act(async () => root.unmount());
    capabilities.mockRestore(); catalog.mockRestore();
  }
}));
