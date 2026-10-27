/** Reviewed built-in origins, active wherever the bundle registers them without
 * a legacy plugin entry. The browser is additionally gated by verified managed
 * assets and the host browser-control setting before controller registration. */
export const NATIVE_CORE_REGISTRATION_IDS = Object.freeze(['devryan.slim', 'devryan.slim-commands', 'devryan.slim-lifecycle', 'devryan.browser']);
