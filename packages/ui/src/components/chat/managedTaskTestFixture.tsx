// Test-only mounted host; production components never import this module.
import React, { act } from 'react';
import { createStore } from 'zustand/vanilla';
import { formatManagedTaskDisplayName } from '@openchamber/orchestration-runtime';
import { HostElement, HostNode, withDom } from '../bots/chat/botMountedDom';

export const managedTitleFixture = createStore(() => ({
  session: [{ id: 'ses_child', title: 'Map the Workspace' }],
}));

const markup = (node: HostNode): string => {
  if (!(node instanceof HostElement)) return node.textContent;
  const attributes = Object.entries(node.attributes).map(([key, value]) => ` ${key}="${value}"`).join('');
  const tag = node.tagName.toLowerCase();
  return `<${tag}${attributes}>${node.ownText}${node.childNodes.map(markup).join('')}</${tag}>`;
};

export const renderManagedTaskMarkup = async (
  element: React.ReactNode,
  tasks?: readonly { childSessionId: string | null; label: string }[],
): Promise<string> => {
  if (tasks) managedTitleFixture.setState({ session: tasks.flatMap((task) => task.childSessionId
    ? [{ id: task.childSessionId, title: formatManagedTaskDisplayName(task.label) }] : []) });
  let result = '';
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => { root.render(element); });
      result = markup(container);
    } finally {
      await act(async () => { root.unmount(); });
    }
  });
  return result;
};
