import {
  createHarnessError,
  createHarnessSuccess,
  createHarnessWarning,
  withHarnessResult,
} from './harness-result.js';
import {
  isBlockedManagedRuntimeMcpName,
  isForbiddenManagedRuntimeToolId,
} from './runtime-surface-policy.js';
import { buildHarnessContextBudget } from './harness-context-budget.js';
import { createHarnessToolManifestReader } from './harness-tool-manifest.js';

const KNOWN_PERMISSION_KEYS = new Set([
  '*',
  'ask',
  'bash',
  'clarification',
  'clarification_*',
  'context7_*',
  'council_session',
  'doom_loop',
  'edit',
  'external_directory',
  'ast_grep_search',
  'glob',
  'grep',
  'grep_app_*',
  'input',
  'apply_patch',
  'patch',
  'plan_enter',
  'plan_exit',
  'question',
  'question_*',
  'read',
  'skill',
  'supabase_*',
  'task',
  'webfetch',
  'websearch_*',
  'write',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function maybePromise(value) {
  return value && typeof value.then === 'function';
}

function normalizePath(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function formatErrorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function readRequestString(req, key) {
  const value = typeof req.query?.[key] === 'string'
    ? req.query[key]
    : req.body?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getAgentFrontmatter(agent) {
  if (!isObject(agent)) return {};
  return isObject(agent.frontmatter) ? agent.frontmatter : agent;
}

function getAgentPath(agent) {
  return normalizePath(agent?.path) || normalizePath(agent?.sourcePath);
}

function getAgentName(agent) {
  return typeof agent?.name === 'string' && agent.name.trim() ? agent.name.trim() : '(unnamed)';
}

function getAgentPromptContent(agent) {
  if (!isObject(agent)) return '';
  for (const key of ['content', 'prompt', 'body']) {
    if (typeof agent[key] === 'string' && agent[key].trim()) {
      return agent[key];
    }
  }
  return '';
}

function getSkillContent(skill) {
  if (!isObject(skill)) return '';
  for (const key of ['content', 'prompt', 'body', 'description']) {
    if (typeof skill[key] === 'string' && skill[key].trim()) {
      return skill[key];
    }
  }
  return '';
}

function isAllowedPermissionValue(value) {
  return value === 'allow' || value === true;
}

function hasSkillPermission(agent) {
  const frontmatter = getAgentFrontmatter(agent);
  const skillPermissions = frontmatter.permission?.skill;
  if (skillPermissions === 'allow' || skillPermissions === true) return true;
  if (!isObject(skillPermissions)) return false;
  return Object.entries(skillPermissions)
    .some(([skillName, value]) => skillName !== '*' && isAllowedPermissionValue(value));
}

function hasSkillAnnouncementPolicy(agent) {
  const content = getAgentPromptContent(agent);
  return /Skill announcements are tool activity only/i.test(content)
    && /do not write assistant text to announce skill use/i.test(content);
}

function hasSilentSkillAnnouncementInstruction(agent) {
  const content = getAgentPromptContent(agent);
  return /Do not write assistant prose announcing that you are loading a skill, using a skill, or about to invoke a specialist/i.test(content)
    || /Do not write assistant (?:prose|text).*announc(?:ing|e).*skill/i.test(content);
}

function skillRequiresVisibleAnnouncement(skill) {
  const content = getSkillContent(skill);
  return /Announce at start/i.test(content)
    || /Announce:\s*["“]/i.test(content)
    || /MUST\s+(?:write|say|announce)/i.test(content)
    || /Announce[^.\n]{0,80}using[^.\n]{0,80}skill/i.test(content);
}

function getAllowedSkillNamesForAgent(agent, skills) {
  const frontmatter = getAgentFrontmatter(agent);
  const skillPermissions = frontmatter.permission?.skill;
  const visibleNames = new Set(
    skills
      .map((skill) => (typeof skill?.name === 'string' ? skill.name.trim() : ''))
      .filter(Boolean),
  );

  if (skillPermissions === 'allow' || skillPermissions === true) {
    return visibleNames;
  }

  if (!isObject(skillPermissions)) {
    return new Set();
  }

  if (skillPermissions['*'] !== 'deny') {
    return visibleNames;
  }

  return new Set(
    Object.entries(skillPermissions)
      .filter(([skillName, value]) => skillName !== '*' && visibleNames.has(skillName) && isAllowedPermissionValue(value))
      .map(([skillName]) => skillName),
  );
}

function createFinding({
  ruleId,
  severity = 'warning',
  summary,
  artifact,
  suggestedNextAction,
  stopCondition,
}) {
  return {
    ruleId,
    severity,
    summary,
    artifact,
    suggestedNextAction,
    stopCondition,
  };
}

function buildPermissionKeySet(toolManifest) {
  const keys = new Set(KNOWN_PERMISSION_KEYS);
  const aliases = isObject(toolManifest?.aliases) ? toolManifest.aliases : {};
  for (const [key, values] of Object.entries(aliases)) {
    keys.add(key);
    for (const value of asArray(values)) {
      if (typeof value === 'string' && value.trim()) keys.add(value.trim());
    }
  }
  for (const tool of asArray(toolManifest?.tools)) {
    if (typeof tool?.id === 'string' && tool.id.trim()) keys.add(tool.id.trim());
    for (const alias of asArray(tool?.aliases)) {
      if (typeof alias === 'string' && alias.trim()) keys.add(alias.trim());
    }
  }
  return keys;
}

function lintDelegatedAgents({ findings, agentsByName, agent }) {
  const frontmatter = getAgentFrontmatter(agent);
  const taskPermissions = frontmatter.permission?.task;
  if (!isObject(taskPermissions)) return;

  for (const [delegatedName, value] of Object.entries(taskPermissions)) {
    if (delegatedName === '*' || !isAllowedPermissionValue(value)) continue;
    if (agentsByName.has(delegatedName)) continue;
    findings.push(createFinding({
      ruleId: 'unavailable-delegated-agent',
      severity: 'error',
      summary: `Agent "${getAgentName(agent)}" allows unavailable delegated agent "${delegatedName}"`,
      artifact: { type: 'agent', name: getAgentName(agent), path: getAgentPath(agent) },
      suggestedNextAction: `Remove "${delegatedName}" from permission.task or add a matching agent`,
      stopCondition: `Stop delegation to "${delegatedName}" until an agent with that name exists`,
    }));
  }
}

function lintPermissionKeys({ findings, permissionKeys, agent }) {
  const frontmatter = getAgentFrontmatter(agent);
  const permissions = frontmatter.permission;
  if (!isObject(permissions)) return;

  for (const key of Object.keys(permissions)) {
    if (permissionKeys.has(key)) continue;
    findings.push(createFinding({
      ruleId: 'invalid-permission-key',
      severity: 'warning',
      summary: `Agent "${getAgentName(agent)}" uses unknown permission key "${key}"`,
      artifact: { type: 'agent', name: getAgentName(agent), path: getAgentPath(agent) },
      suggestedNextAction: `Check whether "${key}" should be a runtime tool ID, alias, or removed permission`,
      stopCondition: `Stop relying on "${key}" until it appears in the tool manifest or documented permission keys`,
    }));
  }
}

function lintHiddenSkillAllows({ findings, hiddenSkills, agent }) {
  const frontmatter = getAgentFrontmatter(agent);
  const skillPermissions = frontmatter.permission?.skill;
  if (!isObject(skillPermissions)) return;

  const hiddenNames = new Set(hiddenSkills.map((skill) => skill?.name).filter(Boolean));
  const hiddenPaths = new Set(hiddenSkills.map((skill) => normalizePath(skill?.path)).filter(Boolean));

  for (const [skillName, value] of Object.entries(skillPermissions)) {
    if (!isAllowedPermissionValue(value)) continue;
    if (!hiddenNames.has(skillName) && !hiddenPaths.has(skillName)) continue;
    findings.push(createFinding({
      ruleId: 'hidden-skill-allowed',
      severity: 'warning',
      summary: `Agent "${getAgentName(agent)}" still allows hidden skill "${skillName}"`,
      artifact: { type: 'agent', name: getAgentName(agent), path: getAgentPath(agent) },
      suggestedNextAction: `Remove "${skillName}" from the agent skill allow list or unhide the skill`,
      stopCondition: `Stop assuming "${skillName}" can be loaded while it remains hidden`,
    }));
  }
}

function isHiddenSkill(skill, hiddenSkills) {
  const skillName = typeof skill?.name === 'string' ? skill.name.trim() : '';
  const skillPath = normalizePath(skill?.path);
  const hiddenNames = new Set(hiddenSkills.map((hiddenSkill) => hiddenSkill?.name).filter(Boolean));
  const hiddenPaths = new Set(hiddenSkills.map((hiddenSkill) => normalizePath(hiddenSkill?.path)).filter(Boolean));

  return (skillName && hiddenNames.has(skillName)) || (skillPath && hiddenPaths.has(skillPath));
}

function lintSkillAnnouncementPolicy({ findings, skills, hiddenSkills, agent }) {
  if (!hasSkillPermission(agent)) return;

  const promptContent = getAgentPromptContent(agent);
  if (!promptContent) return;

  const agentName = getAgentName(agent);
  const artifact = { type: 'agent', name: agentName, path: getAgentPath(agent) };
  const hasPolicy = hasSkillAnnouncementPolicy(agent);

  if (!hasPolicy) {
    findings.push(createFinding({
      ruleId: 'skill-announcement-policy-missing',
      severity: 'warning',
      summary: `Agent "${agentName}" allows skills but is missing the platform skill-announcement policy`,
      artifact,
      suggestedNextAction: 'Add the prompt rule: Skill announcements are tool activity only; do not write assistant text to announce skill use.',
      stopCondition: `Stop relying on "${agentName}" to suppress visible skill announcements until the policy is present`,
    }));
  }

  if (!hasSilentSkillAnnouncementInstruction(agent) || hasPolicy) {
    return;
  }

  const allowedSkillNames = getAllowedSkillNamesForAgent(agent, skills);
  const conflictingSkill = skills.find((skill) => {
    const skillName = typeof skill?.name === 'string' ? skill.name.trim() : '';
    return skillName
      && allowedSkillNames.has(skillName)
      && !isHiddenSkill(skill, hiddenSkills)
      && skillRequiresVisibleAnnouncement(skill);
  });

  if (!conflictingSkill) {
    return;
  }

  findings.push(createFinding({
    ruleId: 'skill-announcement-conflict',
    severity: 'warning',
    summary: `Agent "${agentName}" prompt conflicts with announcement-requiring skill "${conflictingSkill.name}"`,
    artifact,
    suggestedNextAction: 'Replace silent-skill-announcement wording with the platform tool-activity-only policy',
    stopCondition: `Stop exposing "${conflictingSkill.name}" to "${agentName}" until the prompt resolves skill announcements deterministically`,
  }));
}

function lintSkills({ findings, skills }) {
  const byName = new Map();

  for (const skill of skills) {
    const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
    const skillPath = normalizePath(skill?.path);
    if (skill?.parseOk === false || !name) {
      findings.push(createFinding({
        ruleId: 'malformed-skill-frontmatter',
        severity: 'error',
        summary: `Skill frontmatter is malformed${skillPath ? ` at ${skillPath}` : ''}`,
        artifact: { type: 'skill', name: name || '(unnamed)', path: skillPath },
        suggestedNextAction: skill?.error || 'Fix SKILL.md frontmatter so it contains a valid name',
        stopCondition: 'Stop exposing this skill until its frontmatter parses cleanly',
      }));
      continue;
    }
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(skillPath);
  }

  for (const [name, paths] of byName.entries()) {
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    if (uniquePaths.length < 2) continue;
    findings.push(createFinding({
      ruleId: 'duplicate-skill-name',
      severity: 'warning',
      summary: `Skill name "${name}" appears in multiple paths`,
      artifact: { type: 'skill', name, path: uniquePaths[0], paths: uniquePaths },
      suggestedNextAction: 'Rename or hide duplicate skills so agent skill permissions resolve predictably',
      stopCondition: `Stop relying on skill "${name}" until one canonical path is selected`,
    }));
  }
}

function lintStaleOverrides({ findings, staleOverrides }) {
  for (const agentName of staleOverrides) {
    findings.push(createFinding({
      ruleId: 'stale-model-override',
      severity: 'warning',
      summary: `Model override exists for missing agent "${agentName}"`,
      artifact: { type: 'agent-override', name: agentName },
      suggestedNextAction: 'Remove the stale override or restore the agent',
      stopCondition: `Stop expecting override "${agentName}" to affect runtime behavior until the agent exists`,
    }));
  }
}

function lintWarmup({ findings, latestWarmup }) {
  if (!latestWarmup) return;
  if (latestWarmup.timedOut) {
    findings.push(createFinding({
      ruleId: 'warmup-timeout',
      severity: 'warning',
      summary: 'Latest agent runtime warmup reported a timeout',
      artifact: { type: 'warmup', name: latestWarmup.directory || 'global' },
      suggestedNextAction: 'Review the timed-out warmup task before starting latency-sensitive agent work',
      stopCondition: 'Stop retrying warmup if OpenCode stays unavailable after restart',
    }));
  }
  for (const error of asArray(latestWarmup.errors)) {
    findings.push(createFinding({
      ruleId: 'warmup-task-error',
      severity: error.status === 'timeout' ? 'warning' : 'error',
      summary: `Warmup task "${error.name}" reported ${error.status}`,
      artifact: { type: 'warmup-task', name: error.name },
      suggestedNextAction: error.error || 'Inspect the latest warmup diagnostics',
      stopCondition: `Stop relying on task "${error.name}" readiness until the next warmup succeeds`,
    }));
  }
}

function lintSlimRuntime({ findings, slimRuntime }) {
  if (!isObject(slimRuntime)) return;
  if (slimRuntime.expectedMode !== 'devryan-wrapper') return;
  if (slimRuntime.rawPluginEnabled !== true || slimRuntime.wrapperPluginEnabled === true) return;
  findings.push(createFinding({
    ruleId: 'slim-raw-mode-active',
    severity: 'warning',
    summary: 'Raw oh-my-opencode-slim is active while DevRyan wrapper mode is expected',
    artifact: { type: 'plugin', name: 'oh-my-opencode-slim' },
    suggestedNextAction: 'Run the Slim runtime repair action so DevRyan registers its wrapper plugin',
    stopCondition: 'Stop relying on DevRyan prompt preservation until the raw Slim plugin is replaced by the wrapper',
  }));
}

function readToolManifestToolIds(toolManifest) {
  const ids = [];
  for (const tool of asArray(toolManifest?.tools)) {
    if (typeof tool?.id === 'string' && tool.id.trim()) {
      ids.push(tool.id.trim());
    }
  }
  for (const id of asArray(toolManifest?.toolIds)) {
    if (typeof id === 'string' && id.trim()) {
      ids.push(id.trim());
    }
  }
  return [...new Set(ids)];
}

function readToolManifestMcpNames(toolManifest) {
  const names = [];
  const readArray = (value) => {
    for (const entry of asArray(value)) {
      const name = typeof entry === 'string'
        ? entry
        : typeof entry?.name === 'string'
          ? entry.name
          : typeof entry?.id === 'string'
            ? entry.id
            : '';
      if (name.trim()) {
        names.push(name.trim());
      }
    }
  };
  const readObjectKeys = (value) => {
    if (!isObject(value)) return;
    for (const name of Object.keys(value)) {
      if (name.trim()) {
        names.push(name.trim());
      }
    }
  };

  readArray(toolManifest?.mcps);
  readArray(toolManifest?.mcpServers);
  if (Array.isArray(toolManifest?.mcp)) {
    readArray(toolManifest.mcp);
  } else {
    readObjectKeys(toolManifest?.mcp);
  }
  return [...new Set(names)];
}

function lintForbiddenRuntimeSurface({ findings, toolManifest }) {
  for (const toolId of readToolManifestToolIds(toolManifest)) {
    if (!isForbiddenManagedRuntimeToolId(toolId)) {
      continue;
    }
    findings.push(createFinding({
      ruleId: 'forbidden-runtime-tool-surface',
      severity: 'error',
      summary: `Managed runtime exposes forbidden tool "${toolId}"`,
      artifact: { type: 'tool', name: toolId },
      suggestedNextAction: 'Restart managed OpenCode after runtime plugin filtering and MCP tombstones are applied',
      stopCondition: `Stop delegating to subagents while forbidden tool "${toolId}" remains exposed`,
    }));
  }

  for (const mcpName of readToolManifestMcpNames(toolManifest)) {
    if (!isBlockedManagedRuntimeMcpName(mcpName)) {
      continue;
    }
    findings.push(createFinding({
      ruleId: 'forbidden-runtime-mcp-surface',
      severity: 'error',
      summary: `Managed runtime exposes blocked MCP server "${mcpName}"`,
      artifact: { type: 'mcp', name: mcpName },
      suggestedNextAction: 'Restart managed OpenCode after the generated overlay disables this ambient MCP server',
      stopCondition: `Stop relying on managed runtime isolation while blocked MCP "${mcpName}" remains exposed`,
    }));
  }
}

function lintToolManifestAvailability({ findings, toolManifest }) {
  if (toolManifest?.availability?.ids?.availability === 'unavailable') {
    findings.push(createFinding({
      ruleId: 'runtime-tool-ids-unavailable',
      severity: 'warning',
      summary: 'Live OpenCode tool IDs are unavailable',
      artifact: { type: 'tool-manifest', name: 'runtime-tool-ids' },
      suggestedNextAction: 'Retry preflight after OpenCode tool discovery is available',
      stopCondition: 'Stop treating an unavailable tool ID measurement as an empty runtime catalog',
    }));
  }
  if (toolManifest?.availability?.catalog?.availability === 'unavailable') {
    findings.push(createFinding({
      ruleId: 'runtime-tool-catalog-unavailable',
      severity: 'warning',
      summary: 'The selected OpenCode provider/model tool catalog is unavailable',
      artifact: { type: 'tool-manifest', name: 'runtime-tool-catalog' },
      suggestedNextAction: 'Retry preflight after the selected provider and model can resolve tools',
      stopCondition: 'Stop treating an unavailable catalog measurement as a zero-byte catalog',
    }));
  }
}

function lintAgentHarness(options = {}) {
  const agents = asArray(options.agents);
  const skills = asArray(options.skills);
  const hiddenSkills = asArray(options.hiddenSkills);
  const staleOverrides = asArray(options.staleOverrides);
  const agentsByName = new Set(agents.map(getAgentName));
  const permissionKeys = buildPermissionKeySet(options.toolManifest);
  const findings = [];

  for (const agent of agents) {
    lintDelegatedAgents({ findings, agentsByName, agent });
    lintPermissionKeys({ findings, permissionKeys, agent });
    lintHiddenSkillAllows({ findings, hiddenSkills, agent });
    lintSkillAnnouncementPolicy({ findings, skills, hiddenSkills, agent });
  }
  lintSkills({ findings, skills });
  lintStaleOverrides({ findings, staleOverrides });
  lintWarmup({ findings, latestWarmup: options.latestWarmup });
  lintSlimRuntime({ findings, slimRuntime: options.slimRuntime });
  lintForbiddenRuntimeSurface({ findings, toolManifest: options.toolManifest });
  lintToolManifestAvailability({ findings, toolManifest: options.toolManifest });

  return findings;
}

function countDuplicateLines(lines, predicate) {
  const counts = new Map();
  for (const line of lines) {
    const normalized = line.trim().replace(/\s+/g, ' ');
    if (!normalized || !predicate(normalized)) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

function classifyAudit(candidates) {
  if (candidates.some((candidate) => candidate.classification === 'do-not-touch')) {
    return 'do-not-touch';
  }
  if (candidates.some((candidate) => candidate.classification === 'needs-human-review')) {
    return 'needs-human-review';
  }
  if (candidates.some((candidate) => candidate.classification === 'safe-to-extract')) {
    return 'safe-to-extract';
  }
  return 'do-not-touch';
}

function auditPackagedPromptContext(options = {}) {
  return asArray(options.agents).map((agent) => {
    const content = typeof agent?.content === 'string'
      ? agent.content
      : `${typeof agent?.prompt === 'string' ? agent.prompt : ''}`;
    const lines = content.split(/\r?\n/);
    const repeatedRoutingRules = countDuplicateLines(lines, (line) => /route|delegat|agent|explorer/i.test(line));
    const duplicatedToolSafetyText = countDuplicateLines(lines, (line) => /tool|permission|runtime exposes/i.test(line));
    const candidates = [];

    if (duplicatedToolSafetyText > 0 || repeatedRoutingRules > 0) {
      candidates.push({
        classification: 'needs-human-review',
        summary: 'Repeated routing or tool-safety guidance could potentially move into a skill',
      });
    }
    if (Buffer.byteLength(content, 'utf8') > 16_000) {
      candidates.push({
        classification: 'safe-to-extract',
        summary: 'Prompt is large enough to audit for skill extraction candidates',
      });
    }
    if (/plan_enter|plan_exit|permission:|modelRefs:/i.test(content)) {
      candidates.push({
        classification: 'do-not-touch',
        summary: 'Prompt contains frontmatter, permission, or plan-mode sentinel requirements',
      });
    }
    if (candidates.length === 0) {
      candidates.push({
        classification: 'do-not-touch',
        summary: 'No safe extraction candidate detected',
      });
    }

    return {
      agent: getAgentName(agent),
      path: getAgentPath(agent),
      byteCount: Buffer.byteLength(content, 'utf8'),
      repeatedRoutingRules,
      duplicatedToolSafetyText,
      guidanceCandidates: candidates.length,
      classification: classifyAudit(candidates),
      candidates,
    };
  });
}

function buildPreflightResult({
  context,
  directory,
  agents,
  skills,
  hiddenSkills,
  staleOverrides,
  latestWarmup,
  toolManifest,
  packagedAgents,
  slimRuntime,
  readSkillBody,
}) {
  const findings = lintAgentHarness({
    agents,
    skills,
    hiddenSkills,
    staleOverrides,
    latestWarmup,
    toolManifest,
    slimRuntime,
  });
  const promptAudit = auditPackagedPromptContext({ agents: packagedAgents });
  const contextBudget = buildHarnessContextBudget({
    toolManifest,
    packagedAgents,
    skills,
    hiddenSkills,
    readSkillBody,
    context,
  });
  const harness = findings.length > 0
    ? createHarnessWarning({
      summary: `Harness preflight completed with ${findings.length} finding${findings.length === 1 ? '' : 's'}`,
      nextActions: ['Review findings before relying on agent delegation or hidden skills'],
      artifacts: [
        ...findings.map((finding) => finding.artifact?.path).filter(Boolean),
        ...promptAudit.map((entry) => entry.path).filter(Boolean),
      ],
      recovery: {
        rootCauseHint: 'One or more harness contracts may be stale or unavailable',
        safeRetry: 'Retry preflight after updating agent permissions, skills, or runtime tools',
        stopCondition: 'Stop when preflight still reports error severity findings',
        retryable: true,
      },
    })
    : createHarnessSuccess({
      summary: 'Harness preflight completed with 0 findings',
      nextActions: [],
      artifacts: promptAudit.map((entry) => entry.path).filter(Boolean),
    });

  const finish = (resolvedContextBudget) => withHarnessResult({
    ok: true,
    directory: directory || null,
    findings,
    toolManifest,
    latestWarmup,
    slimRuntime,
    promptAudit,
    contextBudget: resolvedContextBudget,
  }, harness);
  return maybePromise(contextBudget) ? contextBudget.then(finish) : finish(contextBudget);
}

function createHarnessPreflight(dependencies = {}) {
  const read = (name, context) => (
    typeof dependencies[name] === 'function' ? dependencies[name](context) : []
  );
  const runtimeToolManifestReader = (
    typeof dependencies.fetchImpl === 'function'
    && typeof dependencies.buildOpenCodeUrl === 'function'
  )
    ? createHarnessToolManifestReader(dependencies)
    : null;

  return {
    run(context = {}) {
      const hasModelSelector = Boolean(context.providerID && context.modelID);
      const values = {
        agents: read('getAgents', context),
        skills: read('getSkills', context),
        hiddenSkills: read('getHiddenSkills', context),
        staleOverrides: read('getStaleOverrides', context),
        latestWarmup: typeof dependencies.getLatestWarmup === 'function' ? dependencies.getLatestWarmup(context) : null,
        toolManifest: typeof dependencies.getToolManifest === 'function'
          ? dependencies.getToolManifest(context)
          : runtimeToolManifestReader
            ? runtimeToolManifestReader(context)
            : {
                tools: [],
                toolIds: [],
                aliases: {},
                sourceRuntime: 'server',
                directory: context.directory || null,
                selector: {
                  mode: hasModelSelector ? 'providerModel' : 'idsOnly',
                  providerID: context.providerID || null,
                  modelID: context.modelID || null,
                },
                availability: {
                  ids: {
                    availability: 'unavailable',
                    error: { kind: 'sourceUnavailable' },
                  },
                  catalog: hasModelSelector
                    ? {
                        availability: 'unavailable',
                        error: { kind: 'sourceUnavailable' },
                      }
                    : { availability: 'notRequested' },
                },
              },
        packagedAgents: read('getPackagedAgents', context),
        slimRuntime: typeof dependencies.getSlimRuntime === 'function' ? dependencies.getSlimRuntime(context) : null,
      };

      const pending = Object.entries(values).filter(([, value]) => maybePromise(value));
      if (pending.length === 0) {
        return buildPreflightResult({
          context,
          directory: context.directory,
          readSkillBody: dependencies.readSkillBody,
          ...values,
        });
      }

      return Promise.all(pending.map(([, value]) => value)).then((resolved) => {
        const nextValues = { ...values };
        pending.forEach(([key], index) => {
          nextValues[key] = resolved[index];
        });
        return buildPreflightResult({
          context,
          directory: context.directory,
          readSkillBody: dependencies.readSkillBody,
          ...nextValues,
        });
      });
    },
  };
}

function registerHarnessPreflightRoute(app, preflight) {
  const handle = async (req, res) => {
    const directory = readRequestString(req, 'directory');
    const providerID = readRequestString(req, 'providerID');
    const modelID = readRequestString(req, 'modelID');
    if (Boolean(providerID) !== Boolean(modelID)) {
      const message = 'providerID and modelID must be provided together';
      res.status(400).json(withHarnessResult({
        ok: false,
        directory: directory || null,
        error: {
          kind: 'invalidModelSelector',
          message,
        },
      }, createHarnessError({
        summary: 'Harness preflight model selector is incomplete',
        nextActions: ['Provide both providerID and modelID, or omit both'],
        recovery: {
          rootCauseHint: message,
          safeRetry: 'Retry with a complete provider/model selector',
          stopCondition: 'Stop retrying until both selector values are available',
          retryable: true,
        },
      })));
      return;
    }
    try {
      const result = await preflight.run({ directory, providerID, modelID });
      res.json(result);
    } catch (error) {
      const message = formatErrorMessage(error, 'Harness preflight failed');
      res.status(500).json(withHarnessResult({
        ok: false,
        directory: directory || null,
        error: {
          kind: 'preflightFailed',
          message,
        },
      }, createHarnessError({
        summary: 'Harness preflight failed',
        nextActions: ['Fix the reported preflight dependency failure and retry'],
        recovery: {
          rootCauseHint: message,
          safeRetry: 'Retry preflight after agent, skill, or runtime metadata can be read',
          stopCondition: 'Stop retrying if the same preflight dependency keeps failing',
          retryable: true,
        },
      })));
    }
  };

  app.get('/api/diagnostics/harness/preflight', handle);
  app.post('/api/diagnostics/harness/preflight', handle);
}

export {
  auditPackagedPromptContext,
  createHarnessPreflight,
  lintAgentHarness,
  registerHarnessPreflightRoute,
};
