// NOTE: OpenCode's plugin loader iterates *every* named export of a plugin
// module and rejects the whole file if any of them is not a function (or an
// object exposing a `.server` function). Constants therefore must not be
// exported directly — they are re-exposed on the callable `__test` export at
// the bottom of this file instead. See default-plugins.test.js, which asserts
// the export shape of every shipped plugin.
const SKILL_CONTEXT_POLICY_MARKER = '[DevRyan skill-context reuse policy]';
const SKILL_CONTEXT_REUSE_MARKER = '<devryan_skill_reuse>';
const EXTERNAL_SKILL_REFERENCE_POLICY_MARKER = '[DevRyan external skill reference policy]';
const ANTHROPIC_SKILL_CATALOG_DESCRIPTION_LIMIT = 240;
const COMPACT_SKILL_CATALOG_PROVIDER_IDS = new Set(['anthropic', 'xai', 'grok', 'xai-oauth']);

const AVAILABLE_SKILLS_BLOCK_REGEX = /<available_skills>\s*([\s\S]*?)\s*<\/available_skills>/g;
const AVAILABLE_SKILLS_PREAMBLE_REGEX = /Skills provide specialized instructions and workflows for specific tasks\.\s*Use the skill tool to load a skill when a task matches its description\.\s*(?=<available_skills>)/g;
const SKILL_ENTRY_REGEX = /<skill>\s*([\s\S]*?)\s*<\/skill>/g;

const extractTagValue = (value, tag) => {
  const match = value.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`));
  return match?.[1]?.trim() || '';
};

const compactDescription = (value) => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);
  if (characters.length <= ANTHROPIC_SKILL_CATALOG_DESCRIPTION_LIMIT) return normalized;
  return `${characters.slice(0, ANTHROPIC_SKILL_CATALOG_DESCRIPTION_LIMIT - 1).join('').trimEnd()}…`;
};

const compactAvailableSkillsBlock = (_fullMatch, content) => {
  const entries = [];
  for (const match of content.matchAll(SKILL_ENTRY_REGEX)) {
    const name = extractTagValue(match[1], 'name');
    const description = compactDescription(extractTagValue(match[1], 'description'));
    if (!name) {
      entries.push(match[0]);
      continue;
    }
    entries.push([
      '  <skill>',
      `    <name>${name}</name>`,
      ...(description ? [`    <description>${description}</description>`] : []),
      '  </skill>',
    ].join('\n'));
  }
  if (entries.length === 0) return '<available_skills>\nNo skills available.\n</available_skills>';
  return `<available_skills>\n${entries.join('\n')}\n</available_skills>`;
};

const compactAnthropicSkillCatalog = (systems) => {
  if (!Array.isArray(systems)) return systems;
  let transformed = null;
  for (let index = 0; index < systems.length; index += 1) {
    const value = systems[index];
    if (typeof value !== 'string' || !value.includes('<available_skills>')) continue;
    const next = value
      .replace(AVAILABLE_SKILLS_PREAMBLE_REGEX, '')
      .replace(AVAILABLE_SKILLS_BLOCK_REGEX, compactAvailableSkillsBlock);
    if (next === value) continue;
    transformed ||= [...systems];
    transformed[index] = next;
  }
  return transformed || systems;
};

const SKILL_CONTEXT_POLICY = `${SKILL_CONTEXT_POLICY_MARKER}
Before calling this tool, inspect the active transcript. If the same named skill already has a completed full result earlier in the current context, do not call the tool again; continue using that result. A workflow phase change, including moving from planning to implementation, is not a reason to reload it. Reload only when no full result remains after compaction, the skill content may have changed, or the user explicitly requests a refresh.`;

const EXTERNAL_SKILL_REFERENCE_POLICY = `${EXTERNAL_SKILL_REFERENCE_POLICY_MARKER}
When a loaded skill references a supporting file whose resolved path is outside the active project/worktree, use the native read tool for that file. DevRyan grants native read access only to external skill directories authorized for the active agent. Do not create or modify global OpenCode/Claude permission files or add host allow rules for skill directories.`;

const appendPolicy = (description, marker, policy) => (
  description.includes(marker) ? description : `${description.trimEnd()}\n\n${policy}`
);

/**
 * OpenCode registers skills under their frontmatter `name:` (often a Title Case
 * display name such as "1Health Vitest" or "Accessibility (a11y)"), but models
 * overwhelmingly call the directory slug they see in the repo — `1health-vitest`,
 * `accessibility`. The tool then fails with "Skill \"x\" not found" and lists only
 * display names, so the model cannot self-correct and simply retries the same
 * wrong name. Normalizing both sides to an alphanumeric key makes slug and display
 * name collide, which is all the resolution this needs.
 */
const normalizeSkillKey = (value) => (
  typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]+/g, '') : ''
);

const skillSlugFromLocation = (location) => {
  if (typeof location !== 'string' || !location.trim()) return '';
  const segments = location.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return '';
  const last = segments[segments.length - 1] ?? '';
  // `.../skills/<slug>/SKILL.md` -> `<slug>`; `.../skills/<slug>.md` -> `<slug>`.
  if (/\.mdx?$/i.test(last)) {
    if (/^skill\.mdx?$/i.test(last)) return segments[segments.length - 2] ?? '';
    return last.replace(/\.mdx?$/i, '');
  }
  return last;
};

/**
 * Maps every alias form of a skill onto its canonical registered name. Exact
 * canonical names win over normalized aliases, and normalized aliases win over
 * prefix matches, so an unambiguous exact hit is never shadowed.
 */
const buildSkillAliasIndex = (skills) => {
  const canonical = new Set();
  const byNormalized = new Map();
  const slugs = new Map();

  for (const skill of Array.isArray(skills) ? skills : []) {
    const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
    if (!name) continue;
    canonical.add(name);

    const slug = skillSlugFromLocation(skill?.location);
    if (slug) slugs.set(name, slug);

    for (const alias of [name, slug]) {
      const key = normalizeSkillKey(alias);
      if (key && !byNormalized.has(key)) byNormalized.set(key, name);
      else if (key && byNormalized.get(key) !== name) byNormalized.set(key, null);
    }
  }

  return { canonical, byNormalized, slugs };
};

const resolveSkillAlias = (requested, index) => {
  const raw = typeof requested === 'string' ? requested.trim() : '';
  if (!raw || !index) return null;
  if (index.canonical.has(raw)) return null; // already correct, leave it alone

  const key = normalizeSkillKey(raw);
  if (!key) return null;

  const exact = index.byNormalized.get(key);
  if (index.byNormalized.has(key) && exact === null) return null;
  if (exact) return exact;

  // "accessibility" -> "Accessibility (a11y)": the request is a prefix of the
  // registered key. Only accept an unambiguous single match.
  const prefixed = [];
  for (const [candidateKey, name] of index.byNormalized) {
    if (candidateKey.startsWith(key) || key.startsWith(candidateKey)) {
      if (name === null) return null;
      prefixed.push(name);
    }
  }
  const unique = Array.from(new Set(prefixed));
  return unique.length === 1 ? unique[0] : null;
};

const describeSkillCatalog = (index) => {
  if (!index || index.canonical.size === 0) return '';
  const entries = Array.from(index.canonical).sort().map((name) => {
    const slug = index.slugs.get(name);
    // Show the slug whenever it is a different literal string from the display
    // name — normalizing first would hide exactly the cases the model gets
    // wrong ("1health-vitest" vs "1Health Vitest" normalize identically).
    return slug && slug.toLowerCase() !== name.toLowerCase()
      ? `${slug} (${name})`
      : name;
  });
  return entries.join(', ');
};

// Only reached once alias resolution failed, so there is no single suggestion
// to offer — the slug-annotated catalog is what lets the model self-correct.
const formatSkillNotFound = (requested, index) => [
  `Skill "${requested}" not found.`,
  `Available skills (call them by the name shown before the parentheses, or the exact name when no slug is listed): ${describeSkillCatalog(index)}`,
].join('\n');

const SKILL_INDEX_TTL_MS = 60_000;

// Native plugins receive the legacy SDK client, whose App lacks skills() (that
// method exists only in SDK v2). Its request options accept a URL override, so
// reuse the authenticated agents() transport to read the same native /skill
// catalog — the approach resolveExecutionSkill in the managed-orchestration
// plugin already relies on.
const readSkillCatalog = async (client, directory) => {
  const response = typeof client?.app?.skills === 'function'
    ? await client.app.skills(directory ? { directory } : undefined)
    : typeof client?.app?.agents === 'function'
      ? await client.app.agents({ url: '/skill', ...(directory ? { query: { directory } } : {}) })
      : null;
  if (!response || response.error) return null;
  const skills = typeof response === 'object' && 'data' in response ? response.data : response;
  return Array.isArray(skills) ? skills : null;
};

export const DevRyanSkillContextPlugin = async (pluginContext = {}) => {
  const client = pluginContext?.client;
  const baseDirectory = typeof pluginContext?.directory === 'string' ? pluginContext.directory : undefined;
  let cachedIndex = null;
  let cachedAt = 0;
  let inFlight = null;

  const loadSkillIndex = async ({ refresh = false } = {}) => {
    if (typeof client?.app?.skills !== 'function' && typeof client?.app?.agents !== 'function') return null;
    const now = Date.now();
    if (!refresh && cachedIndex && now - cachedAt < SKILL_INDEX_TTL_MS) return cachedIndex;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const skills = await readSkillCatalog(client, baseDirectory);
        if (!skills) return cachedIndex;
        cachedIndex = buildSkillAliasIndex(skills);
        cachedAt = Date.now();
        return cachedIndex;
      } catch {
        // A catalog read failure must never break the skill tool — fall back to
        // whatever was cached, or to no rewriting at all.
        return cachedIndex;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  };

  return {
  'tool.definition': async (input, output) => {
    if (typeof output?.description !== 'string') return;

    if (input?.toolID === 'skill') {
      output.description = appendPolicy(
        output.description,
        SKILL_CONTEXT_POLICY_MARKER,
        SKILL_CONTEXT_POLICY,
      );
      output.description = appendPolicy(
        output.description,
        EXTERNAL_SKILL_REFERENCE_POLICY_MARKER,
        EXTERNAL_SKILL_REFERENCE_POLICY,
      );
    }
  },
  'experimental.chat.system.transform': async (input, output) => {
    const providerID = typeof input?.model?.providerID === 'string'
      ? input.model.providerID.trim().toLowerCase()
      : '';
    if (!COMPACT_SKILL_CATALOG_PROVIDER_IDS.has(providerID) || !Array.isArray(output?.system)) return;
    output.system = compactAnthropicSkillCatalog(output.system);
  },
  'tool.execute.before': async (input, output) => {
    if (input?.tool !== 'skill') return;
    const requested = output?.args?.name;
    if (typeof requested !== 'string' || !requested.trim()) return;

    const name = requested.trim();
    let index = await loadSkillIndex();
    // No catalog: leave the call alone so the native tool reports honestly.
    if (!index || index.canonical.size === 0) return;
    if (index.canonical.has(name)) return;

    let resolved = resolveSkillAlias(name, index);
    if (!resolved) {
      // A skill added within the cache TTL must not be rejected on stale data.
      index = await loadSkillIndex({ refresh: true });
      if (!index || index.canonical.size === 0 || index.canonical.has(name)) return;
      resolved = resolveSkillAlias(name, index);
    }
    if (resolved) {
      output.args.name = resolved;
      return;
    }

    // The native skill tool throws on an unknown name, so tool.execute.after
    // never sees that failure, and its error lists display names only — useless
    // to a model that called a directory slug. Reject here with slugs instead.
    throw new Error(formatSkillNotFound(name, index));
  },
  };
};

// Callable so the plugin loader (which requires every export to be a function)
// accepts it. Constants ride along as properties.
export const __test = Object.assign(() => ({}), {
  compactAnthropicSkillCatalog,
  resolveSkillAlias,
  buildSkillAliasIndex,
  normalizeSkillKey,
  SKILL_CONTEXT_POLICY_MARKER,
  SKILL_CONTEXT_REUSE_MARKER,
  EXTERNAL_SKILL_REFERENCE_POLICY_MARKER,
  ANTHROPIC_SKILL_CATALOG_DESCRIPTION_LIMIT,
});

export default DevRyanSkillContextPlugin;
