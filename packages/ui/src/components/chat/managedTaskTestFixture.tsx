// Test-only mounted host; production components never import this module.
import React, { act } from 'react';
import { createStore } from 'zustand/vanilla';
import { formatManagedTaskDisplayName } from '@openchamber/orchestration-runtime';
import { HostElement, HostNode, withDom } from '../bots/chat/botMountedDom';

const defaultTitleSessions = () => [{ id: 'ses_child', title: 'Map the Workspace' }];

export const managedTitleFixture = createStore(() => ({
  session: defaultTitleSessions(),
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
  // This fixture is one process-wide store, so a render that supplies no tasks
  // must start from the default rather than inheriting whatever the previous
  // test file left behind. Without the reset, titles leaked across test files
  // and only failed depending on bun's file ordering.
  managedTitleFixture.setState({
    session: tasks
      ? tasks.flatMap((task) => (task.childSessionId
        ? [{ id: task.childSessionId, title: formatManagedTaskDisplayName(task.label) }]
        : []))
      : defaultTitleSessions(),
  });
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
