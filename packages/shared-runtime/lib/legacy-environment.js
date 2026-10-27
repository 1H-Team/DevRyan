// DevRyan names are canonical; OpenChamber names stay accepted aliases.
// Portable: works on any plain object, never touches process by itself.

export const ENVIRONMENT_PREFIX = 'DEVRYAN_';
export const LEGACY_ENVIRONMENT_PREFIX = 'OPENCHAMBER_';

const suffixOf = (name) => {
  if (name.startsWith(ENVIRONMENT_PREFIX)) return name.slice(ENVIRONMENT_PREFIX.length);
  if (name.startsWith(LEGACY_ENVIRONMENT_PREFIX)) return name.slice(LEGACY_ENVIRONMENT_PREFIX.length);
  return name;
};

/** The canonical DEVRYAN_* name for a DEVRYAN_*, OPENCHAMBER_* or bare suffix. */
export const devRyanEnvironmentName = (name) => `${ENVIRONMENT_PREFIX}${suffixOf(name)}`;

/** The accepted OPENCHAMBER_* alias for a DEVRYAN_*, OPENCHAMBER_* or bare suffix. */
export const legacyEnvironmentName = (name) => `${LEGACY_ENVIRONMENT_PREFIX}${suffixOf(name)}`;

/** Maps an OPENCHAMBER_* name to DEVRYAN_*; any other name is returned unchanged. */
export const canonicalEnvironmentName = (name) => (
  name.startsWith(LEGACY_ENVIRONMENT_PREFIX) ? devRyanEnvironmentName(name) : name
);

/** The DEVRYAN_* value, else the OPENCHAMBER_* alias, else undefined. */
export function readDevRyanEnv(env, name) {
  const value = env?.[devRyanEnvironmentName(name)];
  return value !== undefined ? value : env?.[legacyEnvironmentName(name)];
}

/**
 * Copies every OPENCHAMBER_* value whose DEVRYAN_* name is unset. Never
 * deletes and never overrides: the new name wins. Returns the adopted names.
 */
export function adoptLegacyEnvironment(env) {
  const adopted = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith(LEGACY_ENVIRONMENT_PREFIX) || env[name] === undefined) continue;
    const canonical = devRyanEnvironmentName(name);
    if (env[canonical] !== undefined) continue;
    env[canonical] = env[name];
    adopted.push(canonical);
  }
  return adopted;
}

/** Writes both names, or removes both for undefined, so aliases never diverge. */
export function setDevRyanEnv(env, name, value) {
  for (const key of [devRyanEnvironmentName(name), legacyEnvironmentName(name)]) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
