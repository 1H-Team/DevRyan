import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const POLICY_VERSION = 1;
const MIGRATION_VERSION = 2;

const MANAGED_OPEN_CODE_FEATURES = Object.freeze({
  codeSystemPrompt: true,
  clientSystemPrompt: true,
});

const CLAUDE_COMPATIBILITY_FEATURES = Object.freeze({
  codeSystemPrompt: true,
  clientSystemPrompt: false,
});

const LEGACY_OPEN_CODE_DEFAULTS = Object.freeze({
  codeSystemPrompt: true,
  clientSystemPrompt: true,
  claudeMd: 'off',
  memory: false,
  dreaming: false,
});

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readObjectFile = (fsApi, filePath, label) => {
  try {
    const value = JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
    if (!isRecord(value)) {
      return {
        ok: false,
        code: 'invalid_object',
        error: `${label} must contain a JSON object`,
      };
    }
    return { ok: true, exists: true, value };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, exists: false, value: {} };
    }
    return {
      ok: false,
      code: 'invalid_json',
      error: `${label} is not valid JSON`,
    };
  }
};

const writeObjectFile = (fsApi, pathApi, filePath, value) => {
  fsApi.mkdirSync(pathApi.dirname(filePath), { recursive: true });
  fsApi.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const resolvePromptFeaturePaths = (options = {}) => {
  const pathApi = options.path || path;
  const homedir = options.homedir || (() => os.homedir());
  const configDirectory = options.configDirectory
    || pathApi.join(homedir(), '.config', 'opencode');
  const meridianConfigDirectory = options.meridianConfigDirectory
    || pathApi.join(homedir(), '.config', 'meridian');
  return {
    fs: options.fs || fs,
    path: pathApi,
    settingsPath: options.settingsPath
      || pathApi.join(meridianConfigDirectory, 'sdk-features.json'),
    markerPath: options.markerPath
      || pathApi.join(
        configDirectory,
        '.openchamber',
        'meridian-sdk-features-policy.json',
      ),
  };
};

const isExactLegacyOpenCodeDefaults = (value) => (
  isRecord(value)
  && Object.keys(value).length === Object.keys(LEGACY_OPEN_CODE_DEFAULTS).length
  && Object.entries(LEGACY_OPEN_CODE_DEFAULTS)
    .every(([key, expected]) => value[key] === expected)
);

const getPromptMode = (openCode) => {
  const codeSystemPrompt = openCode.codeSystemPrompt;
  const clientSystemPrompt = openCode.clientSystemPrompt;
  if (codeSystemPrompt === false && clientSystemPrompt === true) return 'client-only';
  if (codeSystemPrompt === true && clientSystemPrompt === false) return 'claude-only';
  if (codeSystemPrompt === true && clientSystemPrompt === true) return 'combined';
  if (codeSystemPrompt === false && clientSystemPrompt === false) return 'none';
  return 'custom';
};

const validatePromptFields = (openCode) => {
  for (const field of Object.keys(MANAGED_OPEN_CODE_FEATURES)) {
    if (
      Object.prototype.hasOwnProperty.call(openCode, field)
      && typeof openCode[field] !== 'boolean'
    ) {
      return {
        ok: false,
        code: 'invalid_prompt_field',
        error: `Meridian OpenCode setting "${field}" must be a boolean`,
      };
    }
  }
  return { ok: true };
};

const readManagedFields = (marker) => {
  if (!isRecord(marker.fields)) return {};
  return Object.fromEntries(
    Object.entries(marker.fields)
      .filter(([key, value]) => (
        Object.prototype.hasOwnProperty.call(MANAGED_OPEN_CODE_FEATURES, key)
        && typeof value === 'boolean'
      )),
  );
};

const applyManagedMeridianSdkFeaturePolicy = ({
  fs: fsApi,
  path: pathApi,
  settingsPath,
  markerPath,
}) => {
  const settingsResult = readObjectFile(fsApi, settingsPath, 'Meridian SDK features');
  if (!settingsResult.ok) {
    return {
      ok: false,
      changed: false,
      code: `meridian_sdk_features_${settingsResult.code}`,
      error: settingsResult.error,
    };
  }

  const markerResult = readObjectFile(fsApi, markerPath, 'DevRyan Meridian policy marker');
  if (!markerResult.ok) {
    return {
      ok: false,
      changed: false,
      code: `meridian_policy_marker_${markerResult.code}`,
      error: markerResult.error,
    };
  }
  if (markerResult.exists && markerResult.value.version !== POLICY_VERSION) {
    return {
      ok: false,
      changed: false,
      code: 'meridian_policy_marker_unsupported_version',
      error: 'DevRyan Meridian policy marker has an unsupported version',
    };
  }

  const settings = settingsResult.value;
  if (
    Object.prototype.hasOwnProperty.call(settings, 'opencode')
    && !isRecord(settings.opencode)
  ) {
    return {
      ok: false,
      changed: false,
      code: 'meridian_sdk_features_invalid_opencode',
      error: 'Meridian SDK features "opencode" setting must contain a JSON object',
    };
  }

  const currentOpenCode = isRecord(settings.opencode) ? settings.opencode : {};
  const validation = validatePromptFields(currentOpenCode);
  if (!validation.ok) {
    return {
      ok: false,
      changed: false,
      code: `meridian_sdk_features_${validation.code}`,
      error: validation.error,
    };
  }

  const previousMarker = markerResult.value;
  const previousManagedFields = readManagedFields(previousMarker);
  const migrationPending = !markerResult.exists
    || previousMarker.migrationVersion !== MIGRATION_VERSION;
  const migrateLegacyDefaults = migrationPending
    && isExactLegacyOpenCodeDefaults(currentOpenCode);
  const nextOpenCode = { ...currentOpenCode };
  const nextManagedFields = {};
  const managedFields = [];
  const preservedFields = [];

  for (const [field, desiredValue] of Object.entries(MANAGED_OPEN_CODE_FEATURES)) {
    const hasCurrentValue = Object.prototype.hasOwnProperty.call(currentOpenCode, field);
    const ownsCurrentValue = (
      Object.prototype.hasOwnProperty.call(previousManagedFields, field)
      && currentOpenCode[field] === previousManagedFields[field]
    );
    if (!hasCurrentValue || ownsCurrentValue || migrateLegacyDefaults) {
      nextOpenCode[field] = desiredValue;
      nextManagedFields[field] = desiredValue;
      managedFields.push(field);
      continue;
    }
    preservedFields.push(field);
  }

  const nextSettings = {
    ...settings,
    opencode: nextOpenCode,
  };
  const nextMarker = {
    version: POLICY_VERSION,
    migrationVersion: MIGRATION_VERSION,
    fields: nextManagedFields,
  };
  const settingsChanged = !settingsResult.exists
    || JSON.stringify(settings) !== JSON.stringify(nextSettings);
  const markerChanged = !markerResult.exists
    || JSON.stringify(previousMarker) !== JSON.stringify(nextMarker);

  if (settingsChanged) {
    writeObjectFile(fsApi, pathApi, settingsPath, nextSettings);
  }
  if (markerChanged) {
    writeObjectFile(fsApi, pathApi, markerPath, nextMarker);
  }

  const promptMode = getPromptMode(nextOpenCode);
  return {
    ok: true,
    changed: settingsChanged || markerChanged,
    settingsChanged,
    markerChanged,
    migrated: migrateLegacyDefaults,
    promptMode,
    managedFields,
    preservedFields,
    warning: null,
  };
};

const readMeridianPromptMode = (options = {}) => {
  const resolved = resolvePromptFeaturePaths(options);
  const settingsResult = readObjectFile(
    resolved.fs,
    resolved.settingsPath,
    'Meridian SDK features',
  );
  if (!settingsResult.ok) {
    return {
      ok: false,
      code: `meridian_sdk_features_${settingsResult.code}`,
      error: settingsResult.error,
    };
  }
  const settings = settingsResult.value;
  if (
    Object.prototype.hasOwnProperty.call(settings, 'opencode')
    && !isRecord(settings.opencode)
  ) {
    return {
      ok: false,
      code: 'meridian_sdk_features_invalid_opencode',
      error: 'Meridian SDK features "opencode" setting must contain a JSON object',
    };
  }
  const openCode = isRecord(settings.opencode) ? settings.opencode : {};
  const validation = validatePromptFields(openCode);
  if (!validation.ok) {
    return {
      ok: false,
      code: `meridian_sdk_features_${validation.code}`,
      error: validation.error,
    };
  }
  const mode = getPromptMode(openCode);
  return {
    ok: true,
    mode,
    compatibilityMode: mode === 'claude-only',
  };
};

const setMeridianPromptCompatibilityMode = (compatibilityMode, options = {}) => {
  if (typeof compatibilityMode !== 'boolean') {
    return {
      ok: false,
      changed: false,
      code: 'invalid_compatibility_mode',
      error: 'compatibilityMode must be a boolean',
    };
  }

  const resolved = resolvePromptFeaturePaths(options);
  const settingsResult = readObjectFile(
    resolved.fs,
    resolved.settingsPath,
    'Meridian SDK features',
  );
  if (!settingsResult.ok) {
    return {
      ok: false,
      changed: false,
      code: `meridian_sdk_features_${settingsResult.code}`,
      error: settingsResult.error,
    };
  }
  const markerResult = readObjectFile(
    resolved.fs,
    resolved.markerPath,
    'DevRyan Meridian policy marker',
  );
  if (!markerResult.ok) {
    return {
      ok: false,
      changed: false,
      code: `meridian_policy_marker_${markerResult.code}`,
      error: markerResult.error,
    };
  }
  if (markerResult.exists && markerResult.value.version !== POLICY_VERSION) {
    return {
      ok: false,
      changed: false,
      code: 'meridian_policy_marker_unsupported_version',
      error: 'DevRyan Meridian policy marker has an unsupported version',
    };
  }

  const settings = settingsResult.value;
  if (
    Object.prototype.hasOwnProperty.call(settings, 'opencode')
    && !isRecord(settings.opencode)
  ) {
    return {
      ok: false,
      changed: false,
      code: 'meridian_sdk_features_invalid_opencode',
      error: 'Meridian SDK features "opencode" setting must contain a JSON object',
    };
  }
  const currentOpenCode = isRecord(settings.opencode) ? settings.opencode : {};
  const validation = validatePromptFields(currentOpenCode);
  if (!validation.ok) {
    return {
      ok: false,
      changed: false,
      code: `meridian_sdk_features_${validation.code}`,
      error: validation.error,
    };
  }

  const desired = compatibilityMode
    ? CLAUDE_COMPATIBILITY_FEATURES
    : MANAGED_OPEN_CODE_FEATURES;
  const nextSettings = {
    ...settings,
    opencode: {
      ...currentOpenCode,
      ...desired,
    },
  };
  // An explicit UI choice is user-owned. Empty managed fields prevent startup
  // provisioning from undoing compatibility mode or a later explicit disable.
  const nextMarker = {
    version: POLICY_VERSION,
    migrationVersion: MIGRATION_VERSION,
    fields: {},
  };
  const settingsChanged = !settingsResult.exists
    || JSON.stringify(settings) !== JSON.stringify(nextSettings);
  const markerChanged = !markerResult.exists
    || JSON.stringify(markerResult.value) !== JSON.stringify(nextMarker);

  try {
    if (settingsChanged) {
      writeObjectFile(resolved.fs, resolved.path, resolved.settingsPath, nextSettings);
    }
    if (markerChanged) {
      writeObjectFile(resolved.fs, resolved.path, resolved.markerPath, nextMarker);
    }
  } catch (error) {
    if (settingsChanged) {
      try {
        if (settingsResult.exists) {
          writeObjectFile(resolved.fs, resolved.path, resolved.settingsPath, settings);
        } else {
          resolved.fs.rmSync(resolved.settingsPath, { force: true });
        }
      } catch {
        // Preserve the original write failure; the next policy read remains fail-visible.
      }
    }
    return {
      ok: false,
      changed: false,
      code: 'meridian_prompt_mode_write_failed',
      error: error instanceof Error ? error.message : 'Failed to write Meridian prompt mode',
    };
  }

  const mode = getPromptMode(nextSettings.opencode);
  return {
    ok: true,
    changed: settingsChanged || markerChanged,
    mode,
    compatibilityMode: mode === 'claude-only',
  };
};

export {
  CLAUDE_COMPATIBILITY_FEATURES,
  LEGACY_OPEN_CODE_DEFAULTS,
  MANAGED_OPEN_CODE_FEATURES,
  MIGRATION_VERSION,
  POLICY_VERSION,
  applyManagedMeridianSdkFeaturePolicy,
  getPromptMode,
  isExactLegacyOpenCodeDefaults,
  readMeridianPromptMode,
  setMeridianPromptCompatibilityMode,
};
