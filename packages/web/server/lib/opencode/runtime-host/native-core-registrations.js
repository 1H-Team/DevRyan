/** Reviewed origins that are part of DevRyan itself, not plugins: the built-in
 * agent orchestration (formerly the Oh My OpenCode Slim plugin). They are active in
 * every location whenever the bundle registers them; no `plugin` entry selects them. */
export const NATIVE_CORE_REGISTRATION_IDS = Object.freeze(['devryan.slim', 'devryan.slim-commands', 'devryan.slim-lifecycle']);
