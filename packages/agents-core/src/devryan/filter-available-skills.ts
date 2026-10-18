// DevRyan: Slim 3.x dropped this hook in favour of in-process skill
// registration, but DevRyan serves skills through its own reviewed skill
// owner, so the per-agent filtering of the <available_skills> block is kept.
// Ported unchanged from Oh My OpenCode Slim 2.2.25
// (src/hooks/filter-available-skills/index.ts).
import { getSkillPermissionsForAgent } from '../cli/skills';
import { AGENT_ALIASES } from '../config/constants';
import {
  isMessageWithParts,
  isUserMessageWithParts,
  type MessageWithParts,
} from '../hooks/types';

const AVAILABLE_SKILLS_BLOCK_REGEX = /<available_skills>\s*([\s\S]*?)\s*<\/available_skills>/g;
const SKILL_NAME_REGEX = /<name>([^<]+)<\/name>/;

type PermissionRules = Record<string, 'allow' | 'ask' | 'deny'>;

function getCurrentAgent(messages: readonly MessageWithParts[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isUserMessageWithParts(message)) {
      return message.info.agent ?? 'orchestrator';
    }
  }
  return 'orchestrator';
}

function extractSkillEntries(blockContent: string): { name: string; block: string }[] {
  const entries: { name: string; block: string }[] = [];
  const skillEntryRegex = /<skill>\s*([\s\S]*?)\s*<\/skill>/g;
  for (const match of blockContent.matchAll(skillEntryRegex)) {
    const block = match[0];
    const nameMatch = block.match(SKILL_NAME_REGEX);
    if (!nameMatch?.[1]) continue;
    entries.push({ name: nameMatch[1].trim(), block });
  }
  return entries;
}

function isSkillAllowed(skillName: string, permissionRules: PermissionRules): boolean {
  const specificRule = permissionRules[skillName];
  if (specificRule !== undefined) return specificRule === 'allow';
  return permissionRules['*'] === 'allow';
}

function filterAvailableSkillsText(text: string, permissionRules: PermissionRules): string {
  return text.replace(AVAILABLE_SKILLS_BLOCK_REGEX, (_fullMatch, blockContent: string) => {
    const allowedEntries = extractSkillEntries(blockContent).filter((entry) =>
      isSkillAllowed(entry.name, permissionRules),
    );
    if (allowedEntries.length === 0) {
      return '<available_skills>\nNo skills available.\n</available_skills>';
    }
    return `<available_skills>\n${allowedEntries.map((entry) => entry.block).join('\n')}\n</available_skills>`;
  });
}

export function createFilterAvailableSkillsHook(
  _ctx: unknown,
  runtime: {
    readonly agents: () => Readonly<Record<string, unknown>>;
    readonly disabledSkills: readonly string[];
  },
) {
  const permissionRulesByAgent = new Map<string, PermissionRules>();
  const getPermissionRules = (agentName: string): PermissionRules => {
    const cached = permissionRulesByAgent.get(agentName);
    if (cached) return cached;
    const agents = runtime.agents();
    const alias = Object.keys(AGENT_ALIASES).find((key) => AGENT_ALIASES[key] === agentName) ?? '';
    const agentConfig = (agents[agentName] ?? agents[alias]) as { skills?: readonly string[] } | undefined;
    const permissionRules = getSkillPermissionsForAgent(agentName, agentConfig?.skills, runtime.disabledSkills);
    permissionRulesByAgent.set(agentName, permissionRules);
    return permissionRules;
  };
  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, unknown>,
      output: Record<string, unknown>,
    ): Promise<void> => {
      const messages = (Array.isArray(output.messages) ? output.messages : []).filter(isMessageWithParts);
      if (messages.length === 0) return;
      const permissionRules = getPermissionRules(getCurrentAgent(messages));
      for (const message of messages) {
        for (const part of message.parts) {
          if (part.type !== 'text' || !part.text || !part.text.includes('<available_skills>')) continue;
          part.text = filterAvailableSkillsText(part.text, permissionRules);
        }
      }
    },
  };
}
