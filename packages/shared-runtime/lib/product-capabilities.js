// Product retirement is independent of saved settings, roles and host capabilities.
// Keep the implementation/data available for a deliberate future product change.
export const BOTS_ENABLED = false;
export const BOTS_RETIRED = Object.freeze({ code: 'bots_retired', error: 'Bots are retired.' });

export function assertBotsEnabled() {
  if (!BOTS_ENABLED) throw Object.assign(new Error(BOTS_RETIRED.error), { code: BOTS_RETIRED.code, status: 410 });
}
