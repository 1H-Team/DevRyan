import { requireReviewedWebfetchOwner } from '../devryan/owners';

export type JsdomModule = typeof import('jsdom');
type JsdomLoader = () => Promise<JsdomModule>;

// DevRyan: the reviewed DOM closure is lent per invocation by its owner;
// no package is resolved from the host filesystem.
async function importJSDOM(): Promise<JsdomModule> {
  return (await requireReviewedWebfetchOwner().loadJSDOM()) as JsdomModule;
}

export function createJSDOMLoader(loader: JsdomLoader): JsdomLoader {
  let promise: Promise<JsdomModule> | undefined;

  return () => {
    if (promise) return promise;

    const pending = loader().catch((error) => {
      if (promise === pending) promise = undefined;
      throw error;
    });
    promise = pending;
    return pending;
  };
}

/** Not memoized: every invocation asks its own owner. */
export function loadJSDOM(): Promise<JsdomModule> {
  return importJSDOM();
}

/**
 * Probe jsdom without making it a prerequisite for the rest of the plugin.
 * The optional loader is a test seam for the non-fatal failure contract.
 */
export async function probeJSDOM(
  load: JsdomLoader = loadJSDOM,
): Promise<string | null> {
  try {
    const { JSDOM } = await load();
    const dom = new JSDOM('<!DOCTYPE html><html><body>test</body></html>');
    dom.window.close();
    return null;
  } catch (err) {
    return String(err);
  }
}
