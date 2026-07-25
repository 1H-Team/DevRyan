import { describe, expect, test } from "bun:test";

import { syncScrollShadowAttributes } from "./scrollShadowAttributes";

type FakeElement = Pick<HTMLElement, "getAttribute" | "hasAttribute" | "removeAttribute" | "setAttribute">;

const createFakeElement = () => {
  const attributes = new Map<string, string>();
  const writes: string[] = [];
  const element: FakeElement = {
    getAttribute: (name) => attributes.get(name) ?? null,
    hasAttribute: (name) => attributes.has(name),
    removeAttribute: (name) => {
      writes.push(`remove:${name}`);
      attributes.delete(name);
    },
    setAttribute: (name, value) => {
      writes.push(`set:${name}:${value}`);
      attributes.set(name, value);
    },
  };

  return { attributes, element: element as HTMLElement, writes };
};

describe("syncScrollShadowAttributes", () => {
  test("does not rewrite unchanged edge attributes", () => {
    const { element, writes } = createFakeElement();

    syncScrollShadowAttributes(element, false, true, "top", "bottom");
    const initialWriteCount = writes.length;
    syncScrollShadowAttributes(element, false, true, "top", "bottom");

    expect(writes.length).toBe(initialWriteCount);
  });

  test("switches between single-edge and combined attributes without stale values", () => {
    const { attributes, element } = createFakeElement();

    syncScrollShadowAttributes(element, false, true, "top", "bottom");
    syncScrollShadowAttributes(element, true, true, "top", "bottom");

    expect(attributes).toEqual(new Map([["data-top-bottom-scroll", "true"]]));

    syncScrollShadowAttributes(element, true, false, "top", "bottom");

    expect(attributes).toEqual(new Map([
      ["data-top-scroll", "true"],
      ["data-bottom-scroll", "false"],
    ]));
  });
});
