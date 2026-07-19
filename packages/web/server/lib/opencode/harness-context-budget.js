import crypto from 'node:crypto';

import { filterVisibleSkills } from './skill-policy.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function countUtf8Bytes(values) {
  return values.reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0);
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getEntryName(entry) {
  return normalizeString(entry?.name) || '(unnamed)';
}

function getEntryPath(entry) {
  return normalizeString(entry?.path) || normalizeString(entry?.sourcePath) || null;
}

function getPackagedPrompt(entry) {
  if (typeof entry?.prompt === 'string') {
    return { value: entry.prompt, source: 'prompt' };
  }
  if (typeof entry?.body === 'string') {
    return { value: entry.body, source: 'body' };
  }
  return {
    value: typeof entry?.content === 'string' ? entry.content : '',
    source: 'contentFallback',
  };
}

function buildByteMeasurement(items) {
  return {
    availability: 'available',
    itemCount: items.length,
    byteCount: items.reduce((total, item) => total + item.byteCount, 0),
    items,
  };
}

function buildPackagedPromptMeasurement(packagedAgents) {
  return buildByteMeasurement(asArray(packagedAgents).map((agent) => {
    const prompt = getPackagedPrompt(agent);
    return {
      name: getEntryName(agent),
      path: getEntryPath(agent),
      byteCount: Buffer.byteLength(prompt.value, 'utf8'),
      source: prompt.source,
    };
  }));
}

function buildSkillCatalogMeasurement(visibleSkills) {
  return buildByteMeasurement(visibleSkills.map((skill) => {
    const name = normalizeString(skill.name);
    const description = typeof skill.description === 'string' ? skill.description : '';
    return {
      name,
      path: getEntryPath(skill),
      byteCount: Buffer.byteLength(name, 'utf8') + Buffer.byteLength(description, 'utf8'),
    };
  }));
}

function getDirectSkillBody(skill) {
  for (const key of ['body', 'content', 'prompt']) {
    if (typeof skill?.[key] === 'string') return skill[key];
  }
  return null;
}

function unavailableSkillBody(skill) {
  return {
    name: getEntryName(skill),
    path: getEntryPath(skill),
    availability: 'unavailable',
    byteCount: null,
    error: { kind: 'readFailed' },
  };
}

function availableSkillBody(skill, body) {
  return {
    name: getEntryName(skill),
    path: getEntryPath(skill),
    availability: 'available',
    byteCount: Buffer.byteLength(body, 'utf8'),
  };
}

function readSkillBodyMeasurement(skill, readSkillBody, context) {
  const directBody = getDirectSkillBody(skill);
  if (directBody !== null) return availableSkillBody(skill, directBody);
  if (typeof readSkillBody !== 'function') return unavailableSkillBody(skill);

  try {
    const body = readSkillBody(skill, context);
    if (body && typeof body.then === 'function') {
      return body
        .then((value) => (
          typeof value === 'string'
            ? availableSkillBody(skill, value)
            : unavailableSkillBody(skill)
        ))
        .catch(() => unavailableSkillBody(skill));
    }
    return typeof body === 'string'
      ? availableSkillBody(skill, body)
      : unavailableSkillBody(skill);
  } catch {
    return unavailableSkillBody(skill);
  }
}

function buildSkillBodyMeasurement(items) {
  const availableItems = items.filter((item) => item.availability === 'available');
  let availability = 'partial';
  if (items.length === 0 || availableItems.length === items.length) {
    availability = 'available';
  } else if (availableItems.length === 0) {
    availability = 'unavailable';
  }
  return {
    availability,
    itemCount: items.length,
    byteCount: availability === 'unavailable'
      ? null
      : availableItems.reduce((total, item) => total + item.byteCount, 0),
    items,
  };
}

function findDuplicateIds(ids) {
  const counts = new Map();
  for (const id of ids) {
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, occurrences]) => occurrences > 1)
    .map(([id, occurrences]) => ({ id, occurrences }));
}

function stableJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJsonValue(value[key])]),
    );
  }
  return value;
}

function findDuplicateSchemas(tools) {
  const groups = new Map();
  for (const tool of tools) {
    const serialized = JSON.stringify(stableJsonValue(tool.parameters));
    const existing = groups.get(serialized) || [];
    existing.push(tool.id);
    groups.set(serialized, existing);
  }
  return [...groups.entries()]
    .filter(([, toolIds]) => toolIds.length > 1)
    .map(([serialized, toolIds]) => ({
      fingerprint: crypto.createHash('sha256').update(serialized).digest('hex'),
      occurrences: toolIds.length,
      toolIds,
    }));
}

function buildHarnessContextBudget({
  toolManifest,
  packagedAgents,
  skills,
  hiddenSkills,
  readSkillBody,
  context,
} = {}) {
  const toolIds = asArray(toolManifest?.toolIds).filter((toolId) => typeof toolId === 'string');
  const mode = toolManifest?.selector?.mode || 'idsOnly';
  const idsAvailability = toolManifest?.availability?.ids?.availability || 'unavailable';
  const catalogAvailability = toolManifest?.availability?.catalog?.availability
    || (mode === 'providerModel' ? 'unavailable' : 'notRequested');
  const idsError = toolManifest?.availability?.ids?.error
    || (idsAvailability === 'unavailable' ? { kind: 'sourceUnavailable' } : null);
  const catalogError = toolManifest?.availability?.catalog?.error
    || (catalogAvailability === 'unavailable' ? { kind: 'sourceUnavailable' } : null);
  const catalogTools = catalogAvailability === 'available'
    ? asArray(toolManifest?.tools)
    : [];
  const descriptions = catalogTools.map((tool) => tool.description);
  const serializedParameters = catalogTools.map((tool) => JSON.stringify(tool.parameters));
  const visibleSkills = filterVisibleSkills(asArray(skills), asArray(hiddenSkills)).filter((skill) => (
    skill?.parseOk !== false
    && normalizeString(skill?.name)
  ));
  const bodyItems = visibleSkills.map((skill) => readSkillBodyMeasurement(skill, readSkillBody, context));

  const finish = (resolvedBodyItems) => ({
    unit: 'utf8Bytes',
    packagedAgentPrompts: buildPackagedPromptMeasurement(packagedAgents),
    visibleSkillCatalogMetadata: buildSkillCatalogMeasurement(visibleSkills),
    visibleOnDemandSkillBodies: buildSkillBodyMeasurement(resolvedBodyItems),
    tools: {
      label: 'runtimeCatalogUpperBound',
      mode,
      duplicatesRetained: true,
      ids: {
        availability: idsAvailability,
        itemCount: idsAvailability === 'available' ? toolIds.length : null,
        byteCount: idsAvailability === 'available' ? countUtf8Bytes(toolIds) : null,
        duplicateIds: idsAvailability === 'available' ? findDuplicateIds(toolIds) : null,
        ...(idsError ? { error: { ...idsError } } : {}),
      },
      descriptions: {
        availability: catalogAvailability,
        itemCount: catalogAvailability === 'available' ? descriptions.length : null,
        byteCount: catalogAvailability === 'available' ? countUtf8Bytes(descriptions) : null,
        ...(catalogError ? { error: { ...catalogError } } : {}),
      },
      parameters: {
        availability: catalogAvailability,
        itemCount: catalogAvailability === 'available' ? serializedParameters.length : null,
        byteCount: catalogAvailability === 'available' ? countUtf8Bytes(serializedParameters) : null,
        ...(catalogError ? { error: { ...catalogError } } : {}),
      },
      duplicateCatalogIds: catalogAvailability === 'available'
        ? findDuplicateIds(catalogTools.map((tool) => tool.id))
        : null,
      duplicateSchemas: catalogAvailability === 'available'
        ? findDuplicateSchemas(catalogTools)
        : null,
    },
  });

  const pending = bodyItems.filter((item) => item && typeof item.then === 'function');
  return pending.length > 0 ? Promise.all(bodyItems).then(finish) : finish(bodyItems);
}

export { buildHarnessContextBudget, findDuplicateIds, findDuplicateSchemas };
