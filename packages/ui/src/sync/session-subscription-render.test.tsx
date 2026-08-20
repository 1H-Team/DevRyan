import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { createStore, type StoreApi } from 'zustand/vanilla';

import {
  selectSessionById,
  selectSessionChildren,
  selectSessionDirectoryById,
  subscribeToSessionBranch,
} from './session-selectors';

type TestState = {
  session: Session[];
  unrelatedRevision: number;
};

const session = (id: string, parentID?: string): Session => ({
  id,
  parentID,
  directory: '/workspace',
  title: id,
  time: { created: 1, updated: 1 },
} as Session);

class TestElement {
  readonly nodeType = 1;
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml';
  readonly style: Record<string, string> = {};

  constructor(
    readonly ownerDocument: TestDocument,
    tagName = 'div',
  ) {
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  removeAttribute() {}
}

class TestDocument {
  readonly nodeType = 9;
  readonly documentElement = new TestElement(this, 'html');
  readonly body = new TestElement(this, 'body');
  activeElement: TestElement | null = this.body;
  defaultView: Record<string, unknown> | null = null;

  addEventListener() {}
  removeEventListener() {}
  createElement(tagName: string) {
    return new TestElement(this, tagName);
  }
}

const useSessionStoreSnapshot = <T,>(
  store: StoreApi<TestState>,
  getSnapshot: () => T,
): T => React.useSyncExternalStore(
  React.useCallback(
    (notify) => subscribeToSessionBranch(store, notify),
    [store],
  ),
  getSnapshot,
  getSnapshot,
);

const useExactSession = (store: StoreApi<TestState>, sessionID: string): Session | undefined => {
  const getSnapshot = React.useCallback(
    () => selectSessionById(store.getState().session, sessionID),
    [sessionID, store],
  );
  return useSessionStoreSnapshot(store, getSnapshot);
};

const useExactDirectory = (store: StoreApi<TestState>, sessionID: string): string | undefined => {
  const getSnapshot = React.useCallback(
    () => selectSessionDirectoryById(store.getState().session, sessionID),
    [sessionID, store],
  );
  return useSessionStoreSnapshot(store, getSnapshot);
};

const useExactChildren = (store: StoreApi<TestState>, parentID: string): Session[] => {
  const childrenRef = React.useRef<Session[] | undefined>(undefined);
  const getSnapshot = React.useCallback(() => {
    const next = selectSessionChildren(store.getState().session, parentID, childrenRef.current);
    childrenRef.current = next;
    return next;
  }, [parentID, store]);
  return useSessionStoreSnapshot(store, getSnapshot);
};

describe('session leaf render isolation', () => {
  test('unrelated lifecycle and directory-store events commit no mounted hot-chat leaves', async () => {
    const parent = session('parent');
    const child = session('child', parent.id);
    const unrelated = session('unrelated');
    const store = createStore<TestState>(() => ({
      session: [parent, child, unrelated],
      unrelatedRevision: 0,
    }));
    const commits = {
      message: 0,
      markdown: 0,
      tool: 0,
      permission: 0,
      question: 0,
    };

    const MessageLeaf = () => {
      commits.message += 1;
      useExactSession(store, child.id);
      return null;
    };
    const MarkdownLeaf = () => {
      commits.markdown += 1;
      useExactDirectory(store, child.id);
      return null;
    };
    const ToolLeaf = () => {
      commits.tool += 1;
      useExactChildren(store, parent.id);
      return null;
    };
    const PermissionLeaf = () => {
      commits.permission += 1;
      useExactSession(store, child.id);
      return null;
    };
    const QuestionLeaf = () => {
      commits.question += 1;
      useExactSession(store, child.id);
      return null;
    };

    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    const testDocument = new TestDocument();
    const testWindow = {
      document: testDocument,
      Element: TestElement,
      HTMLElement: TestElement,
      HTMLIFrameElement: class {},
    };
    testDocument.defaultView = testWindow;

    Object.defineProperties(globalThis, {
      window: { configurable: true, value: testWindow, writable: true },
      document: { configurable: true, value: testDocument, writable: true },
      IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true },
    });

    const restore = (
      key: 'window' | 'document' | 'IS_REACT_ACT_ENVIRONMENT',
      descriptor?: PropertyDescriptor,
    ) => {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    };

    const { createRoot } = await import('react-dom/client');
    const root = createRoot(new TestElement(testDocument) as unknown as Element);
    try {
      await act(async () => {
        root.render(
          <>
            <MessageLeaf />
            <MarkdownLeaf />
            <ToolLeaf />
            <PermissionLeaf />
            <QuestionLeaf />
          </>,
        );
      });
      expect(commits).toEqual({ message: 1, markdown: 1, tool: 1, permission: 1, question: 1 });

      await act(async () => {
        store.setState({ unrelatedRevision: 1 });
        store.setState({ session: [...store.getState().session, session('created')] });
        store.setState({
          session: store.getState().session.map((candidate) => (
            candidate.id === unrelated.id ? { ...candidate, title: 'updated' } : candidate
          )),
        });
        store.setState({
          session: store.getState().session.filter((candidate) => candidate.id !== 'created'),
        });
      });

      expect(commits).toEqual({ message: 1, markdown: 1, tool: 1, permission: 1, question: 1 });

      await act(async () => {
        store.setState({
          session: store.getState().session.map((candidate) => (
            candidate.id === child.id ? { ...candidate, title: 'target updated' } : candidate
          )),
        });
      });
      expect(commits).toEqual({ message: 2, markdown: 1, tool: 2, permission: 2, question: 2 });
    } finally {
      await act(async () => root.unmount());
      restore('window', previousWindow);
      restore('document', previousDocument);
      restore('IS_REACT_ACT_ENVIRONMENT', previousActEnvironment);
    }
  });
});
