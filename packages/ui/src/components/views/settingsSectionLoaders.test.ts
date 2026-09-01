import React from 'react';
import { describe, expect, test } from 'bun:test';

import { createPreparedSettingsComponent } from './settingsSectionLoaders';

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => { resolve = next; });
  return { promise, resolve };
};

describe('prepared settings components', () => {
  test('shares one import and renders synchronously after preload', async () => {
    const loaded = deferred<{ default: React.FC<{ label: string }> }>();
    let imports = 0;
    const Content: React.FC<{ label: string }> = ({ label }) => React.createElement('div', null, label);
    const resource = createPreparedSettingsComponent(() => {
      imports += 1;
      return loaded.promise;
    });

    const first = resource.load();
    const second = resource.load();
    expect(first).toBe(second);
    expect(imports).toBe(1);
    expect(resource.isReady()).toBe(false);

    loaded.resolve({ default: Content });
    await first;

    const render = resource.Component as React.FC<{ label: string }>;
    const element = render({ label: 'ready' });
    expect(resource.isReady()).toBe(true);
    expect(React.isValidElement(element)).toBe(true);
    if (!React.isValidElement(element)) throw new Error('Expected a prepared React element');
    expect(element?.type).toBe(Content);
    expect(element?.props).toEqual({ label: 'ready' });
  });

  test('surfaces a failed import once and retries through suspense', async () => {
    const failure = new Error('section unavailable');
    const Content: React.FC = () => React.createElement('div');
    let imports = 0;
    const resource = createPreparedSettingsComponent(async () => {
      imports += 1;
      if (imports === 1) throw failure;
      return { default: Content };
    });
    const render = resource.Component as React.FC;

    let loadError: unknown;
    try {
      await resource.load();
    } catch (error) {
      loadError = error;
    }
    expect(loadError).toBe(failure);

    let surfacedError: unknown;
    try {
      render({});
    } catch (error) {
      surfacedError = error;
    }
    expect(surfacedError).toBe(failure);

    let retry: unknown;
    try {
      render({});
    } catch (error) {
      retry = error;
    }
    expect(retry).toBeInstanceOf(Promise);
    await retry;
    expect(resource.isReady()).toBe(true);
    const element = render({});
    expect(React.isValidElement(element)).toBe(true);
    if (!React.isValidElement(element)) throw new Error('Expected a retried React element');
    expect(element.type).toBe(Content);
  });
});
