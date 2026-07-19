import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';

import { DeferredChatDialog } from './lazyChatDialogs';
import { DeferredSessionDialog } from '@/components/session/sidebar/lazySessionDialogs';
import { DeferredLazyView } from '@/components/views/lazyViews';

const captureTestGlobalDescriptors = () => ({
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  IS_REACT_ACT_ENVIRONMENT: Object.getOwnPropertyDescriptor(
    globalThis,
    'IS_REACT_ACT_ENVIRONMENT',
  ),
});

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

const testDocument = new TestDocument();
const testWindow = {
  document: testDocument,
  Element: TestElement,
  HTMLElement: TestElement,
  HTMLIFrameElement: class {},
};
testDocument.defaultView = testWindow;

type TestGlobalDescriptors = ReturnType<typeof captureTestGlobalDescriptors>;

const restoreTestGlobalProperty = (
  key: keyof TestGlobalDescriptors,
  descriptor: PropertyDescriptor | undefined,
) => {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
    return;
  }

  Reflect.deleteProperty(globalThis, key);
};

const restoreTestGlobalDescriptors = (descriptors: TestGlobalDescriptors) => {
  restoreTestGlobalProperty('window', descriptors.window);
  restoreTestGlobalProperty('document', descriptors.document);
  restoreTestGlobalProperty(
    'IS_REACT_ACT_ENVIRONMENT',
    descriptors.IS_REACT_ACT_ENVIRONMENT,
  );
};

const installTestDomGlobals = () => {
  Object.defineProperties(globalThis, {
    window: {
      configurable: true,
      enumerable: true,
      value: testWindow,
      writable: true,
    },
    document: {
      configurable: true,
      enumerable: true,
      value: testDocument,
      writable: true,
    },
    IS_REACT_ACT_ENVIRONMENT: {
      configurable: true,
      enumerable: true,
      value: true,
      writable: true,
    },
  });
};

const withTestDomGlobals = async <Result,>(run: () => Promise<Result>) => {
  const previousDescriptors = captureTestGlobalDescriptors();

  try {
    installTestDomGlobals();
    return await run();
  } finally {
    restoreTestGlobalDescriptors(previousDescriptors);
  }
};

const expectTestGlobalDescriptorsToMatch = (expected: TestGlobalDescriptors) => {
  const actual = captureTestGlobalDescriptors();

  expect(actual).toEqual(expected);
  expect(actual.window?.value).toBe(expected.window?.value);
  expect(actual.document?.value).toBe(expected.document?.value);
  expect(actual.IS_REACT_ACT_ENVIRONMENT?.value).toBe(
    expected.IS_REACT_ACT_ENVIRONMENT?.value,
  );
};

const withSentinelTestGlobals = async (run: () => Promise<void>) => {
  const processDescriptors = captureTestGlobalDescriptors();
  const sentinelDescriptors = {
    window: {
      configurable: true,
      enumerable: false,
      value: { sentinel: 'window' },
      writable: false,
    },
    document: {
      configurable: true,
      enumerable: true,
      value: { sentinel: 'document' },
      writable: false,
    },
    IS_REACT_ACT_ENVIRONMENT: {
      configurable: true,
      enumerable: false,
      value: false,
      writable: true,
    },
  } satisfies Record<keyof TestGlobalDescriptors, PropertyDescriptor>;

  try {
    Object.defineProperties(globalThis, sentinelDescriptors);
    const expectedDescriptors = captureTestGlobalDescriptors();

    await run();

    expectTestGlobalDescriptorsToMatch(expectedDescriptors);
  } finally {
    restoreTestGlobalDescriptors(processDescriptors);
  }

  expectTestGlobalDescriptorsToMatch(processDescriptors);
};

type DeferredDialogComponent = React.ComponentType<React.PropsWithChildren<{ active: boolean }>>;

const exerciseDeferredLifecycle = async (DeferredDialog: DeferredDialogComponent) =>
  withTestDomGlobals(async () => {
    const { createRoot } = await import('react-dom/client');
    const container = new TestElement(testDocument);
    const root = createRoot(container as unknown as Element);
    let loadCount = 0;
    let mountCount = 0;
    let unmountCount = 0;
    let setTimelineSearch: React.Dispatch<React.SetStateAction<string>> | undefined;
    let setStashRestoreAfter: React.Dispatch<React.SetStateAction<boolean>> | undefined;
    let latest = {
      active: false,
      timelineSearch: '',
      stashRestoreAfter: true,
    };

    const StatefulDialogProbe: React.FC<{ active: boolean }> = ({ active }) => {
      const [timelineSearch, updateTimelineSearch] = React.useState('');
      const [stashRestoreAfter, updateStashRestoreAfter] = React.useState(true);
      setTimelineSearch = updateTimelineSearch;
      setStashRestoreAfter = updateStashRestoreAfter;
      latest = { active, timelineSearch, stashRestoreAfter };

      React.useEffect(() => {
        mountCount += 1;
        return () => {
          unmountCount += 1;
        };
      }, []);

      return null;
    };
    const LazyDialogProbe = React.lazy(async () => {
      loadCount += 1;
      return { default: StatefulDialogProbe };
    });
    const render = async (active: boolean) => {
      await act(async () => {
        root.render(
          <DeferredDialog active={active}>
            <React.Suspense fallback={null}>
              <LazyDialogProbe active={active} />
            </React.Suspense>
          </DeferredDialog>,
        );
      });
    };

    try {
      await render(false);
      const initiallyClosed = { loadCount, mountCount, unmountCount };

      await render(true);
      await act(async () => {
        setTimelineSearch?.('needle');
        setStashRestoreAfter?.(false);
      });
      const afterInteraction = { ...latest, loadCount, mountCount, unmountCount };

      await render(false);
      const afterClose = { ...latest, loadCount, mountCount, unmountCount };

      await render(true);
      const afterReopen = { ...latest, loadCount, mountCount, unmountCount };

      return { initiallyClosed, afterInteraction, afterClose, afterReopen };
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

describe('deferred lazy dialog lifecycle', () => {
  for (const [label, DeferredDialog] of [
    ['chat', DeferredChatDialog],
    ['session', DeferredSessionDialog],
    ['multi-run', DeferredLazyView],
  ] as const) {
    test(`${label} dialogs defer their first load and remain mounted across close and reopen`, async () => {
      const result = await exerciseDeferredLifecycle(DeferredDialog);

      expect(result.initiallyClosed).toEqual({ loadCount: 0, mountCount: 0, unmountCount: 0 });
      expect(result.afterInteraction).toEqual({
        active: true,
        timelineSearch: 'needle',
        stashRestoreAfter: false,
        loadCount: 1,
        mountCount: 1,
        unmountCount: 0,
      });
      expect(result.afterClose).toEqual({
        active: false,
        timelineSearch: 'needle',
        stashRestoreAfter: false,
        loadCount: 1,
        mountCount: 1,
        unmountCount: 0,
      });
      expect(result.afterReopen).toEqual({
        active: true,
        timelineSearch: 'needle',
        stashRestoreAfter: false,
        loadCount: 1,
        mountCount: 1,
        unmountCount: 0,
      });
    });
  }

  test('restores exact prior global descriptors and values after a successful lifecycle exercise', async () => {
    await withSentinelTestGlobals(async () => {
      await exerciseDeferredLifecycle(DeferredChatDialog);
    });
  });

  test('restores exact prior global descriptors and values when the lifecycle render throws', async () => {
    await withSentinelTestGlobals(async () => {
      const renderError = new Error('expected lifecycle render failure');
      const ThrowingDeferredDialog: DeferredDialogComponent = () => {
        throw renderError;
      };

      try {
        await exerciseDeferredLifecycle(ThrowingDeferredDialog);
        throw new Error('expected the lifecycle render to throw');
      } catch (error) {
        expect(error).toBe(renderError);
      }
    });
  });
});
