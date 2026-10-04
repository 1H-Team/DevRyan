import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureReviewedSkill, reviewedSkillAliases } from './reviewed-skills.js';
import {translateNativeSkillPermissions} from './native-skill-permissions.js';
import { nativeModelSelection, translateNativeConfiguration } from './native-configuration-data.js';
import { captureConfigurationSourceStamp } from './configuration-source-stamps.js';
import {captureNativePonytailDefault} from './native-ponytail-default.js';
import { captureNativeTextSettings, verifyNativeTextSettings } from './native-text-settings.js';
import {configuredNativeSkillDirectories,discoverConfiguredNativeSkills} from './native-configured-skills.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code, status: 503 });
const within = (root, file) => { const relative = path.relative(root, file); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const pluginSpec = value => typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;

/** Effective routes retain every source even when several roles share a tuple. */
export function nativeCatalogSelections(configuration, compatibility, explicit = []) {
  const selections = [];
  const add = (source, selection, variant, hasVariant = false) => {
    if (selection === undefined) return;
    const normalized = nativeModelSelection(selection, variant, hasVariant);
    selections.push({ source, providerID: normalized.providerID, modelID: normalized.model,
      variant: normalized.variant === 'default' ? null : normalized.variant ?? null });
  };
  const translated = (source, selection) => {
    if (selection !== undefined) add(source, selection, selection.variant, Object.hasOwn(selection, 'variant'));
  };
  explicit.forEach((ref, index) => add({ kind: 'requirement', index }, { providerID: ref.providerID, model: ref.id }, ref.variant, Object.hasOwn(ref, 'variant')));
  translated({ kind: 'model' }, configuration.model);
  for (const [name, agent] of Object.entries(configuration.agents ?? {})) if (agent.disabled !== true) {
    translated({ kind: 'agent', id: name }, agent.model ?? configuration.model);
    const backup = compatibility.agents?.[name]?.backupModel;
    if (backup !== undefined && backup !== null) add({ kind: 'backup', id: name }, backup, backup.variant, Object.hasOwn(backup, 'variant'));
  }
  for (const [name, command] of Object.entries(configuration.commands ?? {})) translated({ kind: 'command', id: name }, command.model
    ?? configuration.agents?.[command.agent ?? configuration.default_agent]?.model ?? configuration.model);
  const council = compatibility.agents?.council;
  if (configuration.agents?.council?.disabled !== true) {
    (council?.councillors ?? []).forEach((entry, index) => add({ kind: 'councillor', id: 'council', index }, entry.model, entry.variant, Object.hasOwn(entry, 'variant')));
  }
  const runtime = compatibility.slim?.nativeRuntime;
  for (const [agent, chain] of Object.entries(runtime?.runtimeChains ?? {})) {
    if (!Array.isArray(chain)) throw fail('native_catalog_routes_invalid');
    const array = runtime.modelArrays?.[agent] ?? [];
    chain.forEach((route, index) => {
      const entries = array.filter(entry => entry.id === route);
      if (entries.length) for (const entry of entries) add({ kind: 'slim-route', id: agent, index }, entry.id, entry.variant, Object.hasOwn(entry, 'variant'));
      else add({ kind: 'slim-route', id: agent, index }, route);
      // The fallback owner intentionally selects the same model's provider default.
      if (runtime.fallback?.enabled !== false) add({ kind: 'slim-fallback', id: agent, index }, route);
    });
  }
  return selections;
}

/** Legacy capability inventory remains deduplicated; availability keeps source rows. */
export function nativeCatalogModels(configuration, compatibility, explicit = []) {
  return [...new Map(nativeCatalogSelections(configuration, compatibility, explicit).map(selection => {
    const ref = { providerID: selection.providerID, id: selection.modelID, variant: selection.variant ?? 'default' };
    return [JSON.stringify(ref), ref];
  })).values()];
}

async function loadCurrentLocation({ directory, launch }) {
  const shared = await import('../shared.js'), agentModule = await import('../agents.js'), skillModule = await import('../skills.js'), slimModule = await import('../slim-config.js');
  if (shared.OPENCODE_CONFIG_DIR !== launch.opencodeConfigDirectory) throw fail('native_configuration_binding_mismatch');
  const layers = shared.readConfigLayers(directory);
  // The UI parser tolerates malformed layers. A native snapshot must refuse
  // them rather than replace the user's saved route with a default.
  for (const file of Object.values(layers.paths).filter(Boolean)) {
    if (!within(launch.opencodeConfigDirectory, file) && !within(directory, file)) throw fail('native_configuration_source_unreviewed');
    shared.readConfigFile(file);
  }
  const options = { userConfigPath: layers.paths.userPath, slimConfigDirectory: launch.opencodeConfigDirectory };
  const agents = Object.fromEntries(agentModule.listConfigAgents(directory, options).map(agent => [agent.name, agentModule.getAgentConfig(agent.name, directory, options).config]));
  const commands = { ...(layers.mergedConfig.command ?? {}) };
  for (const folder of [path.join(launch.opencodeConfigDirectory, 'command'), path.join(launch.opencodeConfigDirectory, 'commands'),
    path.join(directory, '.opencode', 'command'), path.join(directory, '.opencode', 'commands')]) {
    async function walk(current) {
      let entries; try { entries = await fs.readdir(current, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(current, entry.name);
        if (entry.isSymbolicLink()) throw fail('native_command_source_unreviewed');
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && entry.name.endsWith('.md')) { const parsed = shared.parseMdFile(file); commands[path.relative(folder, file).slice(0, -3).split(path.sep).join('/')] = { ...parsed.frontmatter, template: parsed.body }; }
      }
    }
    await walk(folder);
  }
  return { legacy: layers.mergedConfig, agents, commands, skills: skillModule.discoverSkills(directory),
    slim: slimModule.resolveSlimConfig(directory, options), parseMarkdown: shared.parseMdFile };
}

/** Constructor-only loader seam permits deterministic fixtures; production uses the existing settings owners. */
export function createNativeConfigurationSnapshotResolver({ loadLocation = loadCurrentLocation, resolveSlimAgents, ponytailCommands, ponytailDefaultMode = process.env.PONYTAIL_DEFAULT_MODE, getRuntimeLocations } = {}) {
  return async function resolveNativeConfigurationSnapshot({ binding, revision, expectedRegistrationDigest }) {
    const descriptor = binding?.descriptor, launch = descriptor?.launch;
    if (descriptor?.generation !== 2 || !Number.isSafeInteger(revision) || revision < 1 || !/^[a-f0-9]{64}$/.test(expectedRegistrationDigest)) throw fail('native_snapshot_identity_invalid');
    const registrationBytes = await fs.readFile(launch.reviewedPluginManifestPath);
    if (registrationBytes.length > 4 * 1024 * 1024 || hash(registrationBytes) !== expectedRegistrationDigest) throw fail('native_registration_revision_mismatch');
    const policyBytes = await fs.readFile(launch.reviewedNativeConfigPath);
    if (policyBytes.length > 4 * 1024 * 1024) throw fail('native_snapshot_policy_invalid');
    const registrations = JSON.parse(registrationBytes.toString('utf8')), policy = JSON.parse(policyBytes.toString('utf8'));
    if (registrations.schema !== 1 || !Array.isArray(registrations.plugins) || policy.schema !== 1 || !Array.isArray(policy.locations)) throw fail('native_snapshot_policy_invalid');
    const explicitAgents = policy.catalogRequirements?.agents;
    if (!policy.catalogRequirements || typeof policy.catalogRequirements !== 'object' || Array.isArray(policy.catalogRequirements)
      || explicitAgents !== undefined && (!Array.isArray(explicitAgents) || explicitAgents.some(id => typeof id !== 'string' || !id))) throw fail('native_snapshot_policy_invalid');
    const requiredAgents = explicitAgents ?? [];
    const runtimeLocations=typeof getRuntimeLocations==='function'?await getRuntimeLocations():policy.locations;
    if(!Array.isArray(runtimeLocations)||!runtimeLocations.length||runtimeLocations.length>128)throw fail('native_snapshot_location_unreviewed');
    const sources = { launch, directories: runtimeLocations.map(location => location.directory), skillSources: policy.skillSources };
    for (let attempt = 0; attempt < 3; attempt++) {
    const sourceStamp = await captureConfigurationSourceStamp(sources);
    const additionalStamps = [];
    const locations = [];
    for (const location of runtimeLocations) {
      const directory = await fs.realpath(location.directory);
      if (directory !== location.directory || (typeof getRuntimeLocations!=='function'&&!descriptor.projectMap.some(value => value.targetDirectory === directory))
        || locations.some(value => value.directory === directory)) throw fail('native_snapshot_location_unreviewed');
      const loaded = await loadLocation({ directory, launch });
      const additionalPaths = await configuredNativeSkillDirectories({settings:loaded.legacy.skills,directory,launch});
      const additionalSources = {...sources,additionalPaths};
      const additionalStamp = await captureConfigurationSourceStamp(additionalSources);
      additionalStamps.push({sources:additionalSources,stamp:additionalStamp});
      loaded.skills.push(...await discoverConfiguredNativeSkills({directories:additionalPaths,directory,parseMarkdown:loaded.parseMarkdown}));
      const specs = loaded.legacy.plugin ?? loaded.legacy.plugins ?? [];
      if (!Array.isArray(specs)) throw fail('native_plugin_settings_invalid');
      const activePlugins = specs.map(pluginSpec);
      if (activePlugins.some(spec => !spec || !registrations.plugins.some(origin => origin.legacySpecs?.includes(spec)))) throw fail('native_plugin_registration_unreviewed');
      const activeRegistrationIDs=registrations.plugins.filter(origin=>origin.legacySpecs?.some(spec=>activePlugins.includes(spec))).map(origin=>origin.id);
      if(activeRegistrationIDs.some(id=>typeof id!=='string')||new Set(activeRegistrationIDs).size!==activeRegistrationIDs.length)throw fail('native_registration_revision_mismatch');
      if(activeRegistrationIDs.includes('devryan.ponytail')){
        if(!ponytailCommands||typeof ponytailCommands!=='object'||Array.isArray(ponytailCommands)||Object.keys(ponytailCommands).length!==6)throw fail('native_ponytail_commands_owner_required');
        for(const [name,value] of Object.entries(ponytailCommands)){
          if(!/^ponytail(?:-(audit|debt|gain|help|review))?$/.test(name)||typeof value?.description!=='string'||typeof value.template!=='string')throw fail('native_ponytail_commands_invalid');
          // Original config hook intentionally overwrites matching saved commands.
          loaded.commands[name]=structuredClone(value);
        }
      }
      const allowedRoots = [directory, launch.opencodeConfigDirectory, launch.global.home];
      for (const source of policy.skillSources ?? []) {
        if (!registrations.plugins.some(origin => origin.id === source.pluginID && origin.legacySpecs?.some(spec => activePlugins.includes(spec)))) continue;
        // Additional package data roots must be part of immutable reviewed
        // evidence. They do not become generic native read roots.
        allowedRoots.push(source.directory);
        if (Array.isArray(source.skills)) loaded.skills.push(...source.skills);
      }
      const skills = [];
      for (const skill of loaded.skills) {
        if (skills.length >= 256) throw fail('native_skill_catalog_too_large');
        const captured = await captureReviewedSkill({ directory, skill, allowedRoots, parseMarkdown: loaded.parseMarkdown });
        if (skills.some(value => value.id === captured.id)) continue;
        skills.push(captured);
      }
      const activeSlim=registrations.plugins.some(origin=>origin.id==='devryan.slim'&&origin.legacySpecs?.some(spec=>activePlugins.includes(spec)));
      if(activeSlim&&typeof resolveSlimAgents!=='function')throw fail('native_slim_configuration_owner_required');
      const textSettings = await captureNativeTextSettings({loaded,directory,launch,captureSlimPrompts:activeSlim});
      if(activeSlim){
        if(!loaded.slim?.mergedConfig||typeof loaded.slim.mergedConfig!=='object'||Array.isArray(loaded.slim.mergedConfig))throw fail('native_slim_snapshot_invalid');
        const resolved=await resolveSlimAgents({directory,configuration:structuredClone(loaded.slim.mergedConfig),hostConfiguration:{...structuredClone(loaded.legacy),agent:structuredClone(textSettings.agents)},prompts:textSettings.slimPrompts,localSkills:skills.map(value=>value.name),
          ...(typeof loaded.slim.activePreset==='string'?{activePreset:loaded.slim.activePreset}:{})});
        if(!resolved?.agents||typeof resolved.agents!=='object'||Array.isArray(resolved.agents)||resolved.defaultAgent!==undefined&&typeof resolved.defaultAgent!=='string')throw fail('native_slim_agents_invalid');
        textSettings.agents=structuredClone(resolved.agents);
        loaded.slim.nativeRuntime={runtimeChains:structuredClone(resolved.runtimeChains ?? {}),modelArrays:structuredClone(resolved.modelArrays ?? {}),fallback:structuredClone(resolved.fallback ?? {}),...resolved.backgroundJobs===undefined?{}:{backgroundJobs:structuredClone(resolved.backgroundJobs)}};
        if(resolved.defaultAgent!==undefined)loaded.legacy.default_agent=resolved.defaultAgent;
      }
      const ponytail=await captureNativePonytailDefault({launch,environmentDefaultMode:ponytailDefaultMode});
      textSettings.textReferences.push(...ponytail.references);
      const aliases = reviewedSkillAliases(skills);
      const mcp = loaded.legacy.mcp ?? {};
      const requiredMCPs = Object.entries(mcp).filter(([, value]) => value?.enabled !== false).map(([id]) => id);
      const configuration = translateNativeSkillPermissions(translateNativeConfiguration({...loaded,agents:textSettings.agents,commands:textSettings.commands}),directory,skills);
      const compatibility = { legacy: loaded.legacy, agents: activeSlim?textSettings.agents:loaded.agents, commands: loaded.commands, slim: loaded.slim, mcp,ponytail:{defaultMode:ponytail.defaultMode,source:ponytail.source} };
      locations.push({ directory, configuration, skills, aliases,
        instructions:textSettings.instructions,textReferences:textSettings.textReferences,
        activePlugins,activeRegistrationIDs, compatibility,
        requiredCatalogs: { ...structuredClone(policy.catalogRequirements),models:nativeCatalogModels(configuration,compatibility,policy.catalogRequirements.models),
          selections:nativeCatalogSelections(configuration,compatibility,policy.catalogRequirements.models),plugins:activeRegistrationIDs,
          agents:[...new Set([...requiredAgents,...Object.entries(configuration.agents).filter(([,agent])=>agent.disabled!==true).map(([name])=>name)])],
          skills: skills.map(value => value.id), commands: Object.keys(loaded.commands), mcp: requiredMCPs } });
    }
    if (!locations.length || locations.length !== runtimeLocations.length) throw fail('native_snapshot_location_unreviewed');
    try { await Promise.all(locations.map(location => verifyNativeTextSettings(location.textReferences))); }
    catch(error) { if(error.code==='native_configuration_sources_changed') continue; throw error; }
    if (typeof getRuntimeLocations==='function'&&JSON.stringify(runtimeLocations)!==JSON.stringify(await getRuntimeLocations()))continue;
    if (sourceStamp !== await captureConfigurationSourceStamp(sources)) continue;
    if ((await Promise.all(additionalStamps.map(async value=>value.stamp===await captureConfigurationSourceStamp(value.sources)))).some(value=>!value)) continue;
    if (hash(await fs.readFile(launch.reviewedNativeConfigPath)) !== hash(policyBytes)) throw fail('native_configuration_policy_changed');
    if (hash(await fs.readFile(launch.reviewedPluginManifestPath)) !== expectedRegistrationDigest) throw fail('native_registration_revision_mismatch');
    const body = { schema: 1, revision, sourceStamp:hash(JSON.stringify([sourceStamp,...additionalStamps.map(value=>value.stamp)])), registrationManifestDigest: expectedRegistrationDigest, locations };
    const digest = hash(JSON.stringify(body));
    if (Buffer.byteLength(JSON.stringify(body)) > 4 * 1024 * 1024) throw fail('native_configuration_snapshot_too_large');
    return freeze({ ...body, digest });
    }
    throw fail('native_configuration_sources_changed');
  };
}
export const resolveNativeConfigurationSnapshot = createNativeConfigurationSnapshotResolver();
