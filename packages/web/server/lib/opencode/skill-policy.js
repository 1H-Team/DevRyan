import path from 'node:path';
import fs from 'node:fs';

const RETIRED_DEVRYAN_SKILL_NAMES = Object.freeze([
  'test-driven-development',
  'subagent-driven-development',
]);
const RETIRED_DEVRYAN_SKILL_NAME_SET = new Set(RETIRED_DEVRYAN_SKILL_NAMES);

const isRetiredDevRyanSkillName = (value) => (
  typeof value === 'string'
  && RETIRED_DEVRYAN_SKILL_NAME_SET.has(value.trim().toLowerCase())
);

const isPlainObject = (value) => (
  value
  && typeof value === 'object'
  && !Array.isArray(value)
);

const normalizeSkillPath = (skillPath) => {
  if (typeof skillPath !== 'string' || !skillPath.trim()) {
    return '';
  }
  const resolved = path.resolve(skillPath.trim());
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
};

const getHiddenSkillPathSet = (hiddenSkills = []) => new Set(
  hiddenSkills
    .map((skill) => normalizeSkillPath(skill?.path))
    .filter(Boolean)
);

const isPackageCacheSkillPath = (skillPath) => {
  const normalized = normalizeSkillPath(skillPath).replace(/\\/g, '/');
  return /\/(\.cache\/opencode|Library\/Caches\/opencode)\/(packages|skills)\//.test(normalized)
    || /\/plugins?\/cache\//.test(normalized);
};

const isUnsupportedSkillRootPath = (skillPath) => {
  const normalized = normalizeSkillPath(skillPath).replace(/\\/g, '/');
  return /\/(\.cursor|\.codex|\.claude)(\/|$)/.test(normalized);
};

const isApprovedSkillSource = (source) => (
  source === undefined
  || source === null
  || source === 'opencode'
  || source === 'agents'
);

const filterVisibleSkills = (skills = [], hiddenSkills = []) => {
  const hiddenPaths = getHiddenSkillPathSet(hiddenSkills);
  const seenPaths = new Set();
  const visibleSkills = [];
  let changed = false;

  for (const skill of skills) {
    if (isRetiredDevRyanSkillName(skill?.name)) {
      changed = true;
      continue;
    }
    if (
      !isApprovedSkillSource(skill?.source)
      || isPackageCacheSkillPath(skill?.path)
      || isUnsupportedSkillRootPath(skill?.path)
    ) {
      changed = true;
      continue;
    }
    const skillPath = normalizeSkillPath(skill?.path);
    if (skillPath && hiddenPaths.has(skillPath)) {
      changed = true;
      continue;
    }
    if (skillPath && seenPaths.has(skillPath)) {
      changed = true;
      continue;
    }
    if (skillPath) {
      seenPaths.add(skillPath);
    }
    visibleSkills.push(skill);
  }

  return changed ? visibleSkills : skills;
};

const resolveApprovedSkills = ({
  discoveredSkills = [],
  runtimeSkills = [],
  hiddenSkills = [],
} = {}) => {
  const runtimeByPath = new Map();
  for (const skill of runtimeSkills) {
    const skillPath = normalizeSkillPath(skill?.path);
    if (skillPath) {
      runtimeByPath.set(skillPath, skill);
    }
  }

  const enrichedSkills = discoveredSkills.map((skill) => {
    const skillPath = normalizeSkillPath(skill?.path);
    const runtimeSkill = skillPath ? runtimeByPath.get(skillPath) : null;
    if (!runtimeSkill) {
      return skill;
    }
    return {
      ...runtimeSkill,
      ...skill,
      description: typeof runtimeSkill.description === 'string' && runtimeSkill.description.trim()
        ? runtimeSkill.description
        : skill.description,
    };
  });

  return filterVisibleSkills(enrichedSkills, hiddenSkills);
};

const buildVisibleSkillPolicy = (input = {}) => {
  const { skills = [], hiddenSkills = [], runtimeExternalDirectories: rawRuntimeExternalDirectories = [] } = input;
  const visibleSkills = filterVisibleSkills(skills, hiddenSkills);
  const seenNames = new Set();
  const skillNames = [];
  const skillDirectoriesByName = {};
  const seenDirectories = new Set();
  const skillDirectories = [];
  const seenRuntimeExternalDirectories = new Set();
  const runtimeExternalDirectories = [];

  for (const skill of visibleSkills) {
    const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
    if (name && !seenNames.has(name)) {
      seenNames.add(name);
      skillNames.push(name);
    }

    const skillPath = normalizeSkillPath(skill?.path);
    if (skillPath) {
      const dir = path.dirname(skillPath);
      if (name) {
        const dirs = skillDirectoriesByName[name] || [];
        if (!dirs.includes(dir)) {
          skillDirectoriesByName[name] = [...dirs, dir];
        }
      }
      if (!seenDirectories.has(dir)) {
        seenDirectories.add(dir);
        skillDirectories.push(dir);
      }
    }
  }

  const sortedDirectoriesByName = {};
  for (const [name, dirs] of Object.entries(skillDirectoriesByName).sort(([a], [b]) => a.localeCompare(b))) {
    sortedDirectoriesByName[name] = [...dirs].sort((a, b) => a.localeCompare(b));
  }

  const addRuntimeExternalDirectory = (dir) => {
    if (typeof dir !== 'string' || !dir.trim()) {
      return;
    }
    const resolved = path.resolve(dir.trim());
    const candidates = [resolved];
    try {
      const real = fs.realpathSync(resolved);
      if (real && real !== resolved) {
        candidates.push(real);
      }
    } catch {
    }

    for (const candidate of candidates) {
      if (!candidate || seenRuntimeExternalDirectories.has(candidate)) {
        continue;
      }
      seenRuntimeExternalDirectories.add(candidate);
      runtimeExternalDirectories.push(candidate);
    }
  };

  if (Array.isArray(rawRuntimeExternalDirectories)) {
    for (const dir of rawRuntimeExternalDirectories) {
      addRuntimeExternalDirectory(dir);
    }
  }

  return {
    skillNames: [...skillNames].sort((a, b) => a.localeCompare(b)),
    skillDirectories: [...skillDirectories].sort((a, b) => a.localeCompare(b)),
    skillDirectoriesByName: sortedDirectoriesByName,
    runtimeExternalDirectories: [...runtimeExternalDirectories].sort((a, b) => a.localeCompare(b)),
  };
};

const isAllow = (value) => value === 'allow';

const hasExplicitSkillGrant = (skillPermission) => (
  skillPermission === 'allow'
  || skillPermission === true
  || (
    isPlainObject(skillPermission)
    && Object.entries(skillPermission).some(([name, value]) => name !== '*' && isAllow(value))
  )
);

const isSkillUseExplicitlyDenied = (permission) => {
  const skillPermission = permission.skill;
  if (skillPermission === 'deny' || skillPermission === false) {
    return true;
  }
  if (isPlainObject(skillPermission)) {
    return skillPermission['*'] === 'deny' && !hasExplicitSkillGrant(skillPermission);
  }
  return skillPermission === undefined && permission['*'] === 'deny';
};

const getAllowedSkillNames = (permission, visibleSkillNames) => {
  if (isSkillUseExplicitlyDenied(permission)) {
    return [];
  }
  return [...visibleSkillNames].sort((a, b) => a.localeCompare(b));
};

const normalizeExternalDirectoryPattern = (pattern) => {
  if (typeof pattern !== 'string' || !pattern.trim()) {
    return '';
  }
  return pattern.trim().replace(/\/\*$/, '');
};

const isSkillDirectoryPattern = (pattern) => {
  const normalized = normalizeExternalDirectoryPattern(pattern);
  return /(^|[/\\])(\.config[/\\]opencode[/\\]skills?|\.opencode[/\\]skills?|\.claude[/\\]skills|\.agents[/\\]skills|\.cursor[/\\]skills)([/\\]|$)/.test(normalized)
    || /(^|[/\\])(\.cache|Caches)[/\\]opencode[/\\]skills([/\\]|$)/.test(normalized)
    || /(^|[/\\])skills([/\\]|$)/.test(normalized);
};

const toDirectoryAllowPattern = (dir) => `${dir.replace(/\/+$/, '')}/*`;

const normalizeRuntimeExternalDirectories = (directories) => {
  const normalizedDirectories = [];
  const seenDirectories = new Set();
  if (!Array.isArray(directories)) {
    return normalizedDirectories;
  }

  for (const dir of directories) {
    if (typeof dir !== 'string' || !dir.trim()) {
      continue;
    }
    const resolved = path.resolve(dir.trim());
    const candidates = [resolved];
    try {
      const real = fs.realpathSync(resolved);
      if (real && real !== resolved) {
        candidates.push(real);
      }
    } catch {
      // Missing runtime directories still need a normalized allow pattern.
    }

    for (const candidate of candidates) {
      if (!candidate || seenDirectories.has(candidate)) {
        continue;
      }
      seenDirectories.add(candidate);
      normalizedDirectories.push(candidate);
    }
  }

  return normalizedDirectories.sort((a, b) => a.localeCompare(b));
};

const applyRuntimeExternalDirectoryPolicy = (frontmatter, runtimeExternalDirectories = []) => {
  const permission = isPlainObject(frontmatter?.permission) ? frontmatter.permission : null;
  const allowedDirectories = normalizeRuntimeExternalDirectories(runtimeExternalDirectories);
  if (!permission || allowedDirectories.length === 0) {
    return frontmatter;
  }

  const externalDirectory = isPlainObject(permission.external_directory)
    ? { ...permission.external_directory }
    : {};
  let changed = !isPlainObject(permission.external_directory);
  for (const dir of allowedDirectories) {
    const pattern = toDirectoryAllowPattern(dir);
    if (externalDirectory[pattern] === 'allow') {
      continue;
    }
    externalDirectory[pattern] = 'allow';
    changed = true;
  }

  if (!changed) {
    return frontmatter;
  }

  return {
    ...frontmatter,
    permission: {
      ...permission,
      external_directory: externalDirectory,
    },
  };
};

const sanitizeExternalDirectory = (externalDirectory, allowedSkillDirectories) => {
  const allowedDirectories = Array.isArray(allowedSkillDirectories)
    ? allowedSkillDirectories
    : [];
  if (!isPlainObject(externalDirectory)) {
    if (allowedDirectories.length === 0) {
      return externalDirectory;
    }
    const next = {};
    for (const dir of allowedDirectories) {
      next[toDirectoryAllowPattern(dir)] = 'allow';
    }
    return next;
  }

  const next = {};
  for (const [pattern, value] of Object.entries(externalDirectory)) {
    if (isSkillDirectoryPattern(pattern)) {
      continue;
    }
    next[pattern] = value;
  }

  for (const dir of allowedDirectories) {
    next[toDirectoryAllowPattern(dir)] = 'allow';
  }

  return next;
};

const sanitizeAgentSkillPolicy = (frontmatter, policy = null) => {
  if (!policy) {
    return frontmatter;
  }

  const frontmatterWithRuntimeDirectories = applyRuntimeExternalDirectoryPolicy(
    frontmatter,
    policy.runtimeExternalDirectories,
  );
  const permission = isPlainObject(frontmatterWithRuntimeDirectories?.permission)
    ? frontmatterWithRuntimeDirectories.permission
    : {};
  const skillNames = Array.isArray(policy.skillNames) ? policy.skillNames : [];
  const skillDirectoriesByName = isPlainObject(policy.skillDirectoriesByName) ? policy.skillDirectoriesByName : {};
  const allowedSkillNames = getAllowedSkillNames(permission, skillNames);
  const allowedDirectories = normalizeRuntimeExternalDirectories(policy.runtimeExternalDirectories);
  const seenAllowedDirectories = new Set();
  for (const dir of allowedDirectories) {
    seenAllowedDirectories.add(dir);
  }
  for (const name of allowedSkillNames) {
    const dirs = Array.isArray(skillDirectoriesByName[name]) ? skillDirectoriesByName[name] : [];
    for (const dir of dirs) {
      const normalizedDir = normalizeSkillPath(dir);
      if (!normalizedDir || seenAllowedDirectories.has(normalizedDir)) {
        continue;
      }
      seenAllowedDirectories.add(normalizedDir);
      allowedDirectories.push(normalizedDir);
    }
  }

  const nextSkill = { '*': 'deny' };
  for (const name of allowedSkillNames) {
    nextSkill[name] = 'allow';
  }

  return {
    ...frontmatterWithRuntimeDirectories,
    permission: {
      ...permission,
      external_directory: sanitizeExternalDirectory(permission.external_directory, allowedDirectories),
      skill: nextSkill,
    },
  };
};

export {
  RETIRED_DEVRYAN_SKILL_NAMES,
  applyRuntimeExternalDirectoryPolicy,
  buildVisibleSkillPolicy,
  filterVisibleSkills,
  isRetiredDevRyanSkillName,
  normalizeSkillPath,
  resolveApprovedSkills,
  sanitizeAgentSkillPolicy,
};
