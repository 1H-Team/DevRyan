import { Effect } from 'effect';
import { Plugin } from '@opencode/plugin/effect';
import { Tool } from '@opencode/schema/tool';
import { reviewedBrowserDescription, reviewedBrowserInputSchema } from '../../../default-config/plugins/devryan-browser.mjs';

export const NATIVE_BROWSER_PLUGIN_ID = 'devryan.browser';
/** Registration only; the mandatory owner routes the whole original tool to one supervised worker. */
export const nativeBrowserPlugin = Plugin.define({ id: NATIVE_BROWSER_PLUGIN_ID, effect: ({ tool }) => tool.transform(editor => {
  editor.add({ name: 'devryan_browser', description: reviewedBrowserDescription, input: reviewedBrowserInputSchema,
    options: { codemode: false }, execute: () => Effect.fail(new Tool.Error({ message: 'native_browser_worker_required' })) });
}) });
