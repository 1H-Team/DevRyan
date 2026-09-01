import React from 'react';
import { describe, expect, test } from 'bun:test';

import {
  ChunkLoadTimeoutError,
  importWithChunkRecovery,
  retryableLazyWithChunkRecovery,
} from './chunkLoadRecovery';

const rejectionMessage = async (operation: () => Promise<unknown>): Promise<string> => {
  try {
    await operation();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe('importWithChunkRecovery', () => {
  test('recovers a corrupt marker, retries once, and reloads at most once for the same failure', async () => {
    const globalWithWindow = globalThis as unknown as { window?: unknown };
    const previousWindow = globalWithWindow.window;
    let storedMarker: string | null = '{not json';
    let reloadCount = 0;
    let loadCount = 0;

    globalWithWindow.window = {
      sessionStorage: {
        getItem: () => storedMarker,
        setItem: (_key: string, value: string) => { storedMarker = value; },
      },
      setTimeout: (callback: () => void) => {
        callback();
        return 0;
      },
      location: { reload: () => { reloadCount += 1; } },
    };

    const load = async () => {
      loadCount += 1;
      throw new Error('ChunkLoadError: Loading chunk settings failed');
    };
    try {
      expect(await rejectionMessage(() => importWithChunkRecovery(load))).toContain('ChunkLoadError');
      expect(await rejectionMessage(() => importWithChunkRecovery(load))).toContain('ChunkLoadError');
      expect(loadCount).toBe(4);
      expect(storedMarker).not.toBeNull();
      expect(reloadCount).toBe(1);
    } finally {
      if (previousWindow === undefined) delete globalWithWindow.window;
      else globalWithWindow.window = previousWindow;
    }
  });

  test('does not retry or reload ordinary import failures', async () => {
    let loadCount = 0;
    const message = await rejectionMessage(() => importWithChunkRecovery(async () => {
      loadCount += 1;
      throw new Error('module initialization failed');
    }));
    expect(message).toContain('module initialization failed');
    expect(loadCount).toBe(1);
  });

  test('turns a stalled import into a bounded error without reloading', async () => {
    const globalWithWindow = globalThis as unknown as { window?: unknown };
    const previousWindow = globalWithWindow.window;
    let reloadCount = 0;

    globalWithWindow.window = {
      sessionStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
      setTimeout,
      location: { reload: () => { reloadCount += 1; } },
    };

    try {
      let received: unknown;
      try {
        await importWithChunkRecovery(
          () => new Promise<never>(() => undefined),
          { timeoutMs: 5 },
        );
      } catch (error) {
        received = error;
      }

      expect(received).toBeInstanceOf(ChunkLoadTimeoutError);
      expect(reloadCount).toBe(0);
    } finally {
      if (previousWindow === undefined) delete globalWithWindow.window;
      else globalWithWindow.window = previousWindow;
    }
  });

});

class TestElement {
  readonly nodeType = 1;
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml';
  readonly style: Record<string, string> = {};

  constructor(readonly ownerDocument: TestDocument, tagName = 'div') {
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

class RetryBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {}

  reset = () => this.setState({ failed: false });

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

describe('retryableLazyWithChunkRecovery', () => {
  test('keeps the lazy payload stable while an initial load is suspended', async () => {
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
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    };

    let resolveModule: ((module: { default: React.ComponentType }) => void) | undefined;
    let loadCount = 0;
    let mountedCount = 0;
    const modulePromise = new Promise<{ default: React.ComponentType }>((resolve) => {
      resolveModule = resolve;
    });
    const Retryable = retryableLazyWithChunkRecovery(() => {
      loadCount += 1;
      return modulePromise;
    });

    const { createRoot } = await import('react-dom/client');
    const { flushSync } = await import('react-dom');
    const root = createRoot(new TestElement(testDocument) as unknown as Element);
    try {
      React.act(() => {
        flushSync(() => {
          root.render(
            React.createElement(
              React.Suspense,
              { fallback: null },
              React.createElement(Retryable),
            ),
          );
        });
      });
      expect(loadCount).toBe(1);

      await React.act(async () => {
        resolveModule?.({
          default: () => {
            mountedCount += 1;
            return null;
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      for (let attempt = 0; attempt < 20 && mountedCount === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(loadCount).toBe(1);
      expect(mountedCount).toBe(1);
    } finally {
      React.act(() => root.unmount());
      await new Promise((resolve) => setTimeout(resolve, 0));
      restore('window', previousWindow);
      restore('document', previousDocument);
      restore('IS_REACT_ACT_ENVIRONMENT', previousActEnvironment);
    }
  });

  test('creates a fresh React.lazy payload after an error boundary reset', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    const previousConsoleError = console.error;
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
    console.error = () => undefined;

    const restore = (
      key: 'window' | 'document' | 'IS_REACT_ACT_ENVIRONMENT',
      descriptor?: PropertyDescriptor,
    ) => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    };

    let loadCount = 0;
    let mountedCount = 0;
    let allowSuccess = false;
    const Retryable = retryableLazyWithChunkRecovery(async () => {
      loadCount += 1;
      if (!allowSuccess) {
        throw new Error('module initialization failed');
      }
      return {
        default: () => {
          mountedCount += 1;
          return null;
        },
      };
    });
    const boundaryRef = React.createRef<RetryBoundary>();

    const { createRoot } = await import('react-dom/client');
    const { flushSync } = await import('react-dom');
    const root = createRoot(new TestElement(testDocument) as unknown as Element);
    try {
      flushSync(() => {
        root.render(
          React.createElement(
            RetryBoundary,
            { ref: boundaryRef },
            React.createElement(
              React.Suspense,
              { fallback: null },
              React.createElement(Retryable),
            ),
          ),
        );
      });
      for (let attempt = 0; attempt < 20 && !boundaryRef.current?.state.failed; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const failedLoadCount = loadCount;
      expect(failedLoadCount).toBeGreaterThan(0);
      expect(mountedCount).toBe(0);
      expect(boundaryRef.current?.state.failed).toBe(true);

      allowSuccess = true;
      flushSync(() => {
        boundaryRef.current?.reset();
      });
      for (let attempt = 0; attempt < 20 && mountedCount === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(loadCount).toBeGreaterThan(failedLoadCount);
      expect(mountedCount).toBe(1);
    } finally {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
      console.error = previousConsoleError;
      restore('window', previousWindow);
      restore('document', previousDocument);
      restore('IS_REACT_ACT_ENVIRONMENT', previousActEnvironment);
    }
  });
});
