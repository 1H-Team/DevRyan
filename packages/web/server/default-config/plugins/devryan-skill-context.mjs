import { createHash } from 'node:crypto';

export const SKILL_CONTEXT_POLICY_MARKER = '[DevRyan skill-context reuse policy]';
export const SKILL_CONTEXT_REUSE_MARKER = '<devryan_skill_reuse>';
export const EXTERNAL_SKILL_REFERENCE_POLICY_MARKER = '[DevRyan external skill reference policy]';
export const ANTHROPIC_SKILL_CATALOG_DESCRIPTION_LIMIT = 240;

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

const SKILL_CONTEXT_REUSE_OUTPUT = `${SKILL_CONTEXT_REUSE_MARKER}The byte-identical completed skill content is already present earlier in this active context. Continue following that existing content; this result intentionally omits the duplicate body.</devryan_skill_reuse>`;

const EXTERNAL_SKILL_REFERENCE_POLICY = `${EXTERNAL_SKILL_REFERENCE_POLICY_MARKER}
When a loaded skill references a supporting file whose resolved path is outside the active project/worktree, use the native read tool for that file instead of ctx_execute_file. DevRyan grants native read access only to external skill directories authorized for the active agent. Do not create or modify global OpenCode/Claude permission files or add host allow rules for skill directories. Continue using ctx_execute_file normally for files contained by the active project.`;

const appendPolicy = (description, marker, policy) => (
  description.includes(marker) ? description : `${description.trimEnd()}\n\n${policy}`
);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const getCompletedSkill = (part) => {
  if (!isRecord(part) || part.type !== 'tool' || part.tool !== 'skill') return null;
  if (!isRecord(part.state) || part.state.status !== 'completed') return null;
  if (!isRecord(part.state.input)) return null;

  const name = typeof part.state.input.name === 'string' ? part.state.input.name.trim() : '';
  const output = typeof part.state.output === 'string' ? part.state.output : '';
  if (!name || !output.trim() || output.includes(SKILL_CONTEXT_REUSE_MARKER)) return null;

  const compactedAt = isRecord(part.state.time) ? part.state.time.compacted : undefined;
  if (typeof compactedAt === 'number' && Number.isFinite(compactedAt)) return null;

  return { name, output };
};

const hashSkillOutput = (output) => createHash('sha256').update(output).digest('hex');

const compactRepeatedSkillOutputs = (messages) => {
  const activeVersionBySkill = new Map();
  let transformedMessages = null;

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    let transformedParts = null;

    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      const skill = getCompletedSkill(part);
      if (!skill) continue;

      const version = hashSkillOutput(skill.output);
      if (activeVersionBySkill.get(skill.name) !== version) {
        activeVersionBySkill.set(skill.name, version);
        continue;
      }

      transformedParts ||= [...message.parts];
      transformedParts[index] = {
        ...part,
        state: {
          ...part.state,
          output: SKILL_CONTEXT_REUSE_OUTPUT,
        },
      };
    }

    if (transformedParts) {
      transformedMessages ||= [...messages];
      transformedMessages[messageIndex] = { ...message, parts: transformedParts };
    }
  }

  return transformedMessages || messages;
};

export const DevRyanSkillContextPlugin = async () => ({
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
      return;
    }

    if (input?.toolID === 'ctx_execute_file') {
      output.description = appendPolicy(
        output.description,
        EXTERNAL_SKILL_REFERENCE_POLICY_MARKER,
        EXTERNAL_SKILL_REFERENCE_POLICY,
      );
    }
  },
  'experimental.chat.messages.transform': async (_input, output) => {
    if (!Array.isArray(output?.messages)) return;
    output.messages = compactRepeatedSkillOutputs(output.messages);
  },
  'experimental.chat.system.transform': async (input, output) => {
    if (input?.model?.providerID !== 'anthropic' || !Array.isArray(output?.system)) return;
    output.system = compactAnthropicSkillCatalog(output.system);
  },
});

export const __test = Object.freeze({
  compactRepeatedSkillOutputs,
  compactAnthropicSkillCatalog,
  getCompletedSkill,
  hashSkillOutput,
  reuseOutput: SKILL_CONTEXT_REUSE_OUTPUT,
});

export default DevRyanSkillContextPlugin;
