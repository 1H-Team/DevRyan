import type {
  BotLegacyRevisionContract,
  BotManagedMembership,
  BotMembershipRole,
  BotRevisionContract,
  BotRuntimeTool,
  BotSummary,
} from '@/lib/botsApi';
import { botRevisionModelPolicy } from '@/lib/botsApi';

import { BOT_SOUL_MAX_BYTES, buildStarterBotSoul } from './botSoulTemplate';

const PLACEHOLDER_CREDENTIAL_ID = '00000000-0000-4000-8000-000000000001';
export const AUTONOMOUS_FILE_TOOLS = ['read', 'glob', 'grep', 'edit', 'write'] as const;
export const AUTONOMOUS_RUNTIME_TOOLS: readonly BotRuntimeTool[] = ['bash', 'terminal', 'git', 'task'];

export type BotRevisionValidation = {
  valid: boolean;
  errors: readonly string[];
};

export type PendingBotMutation = Readonly<{
  action: string;
  token: number;
}>;

export const getPendingBotAction = (
  pending: Readonly<Record<string, PendingBotMutation>>,
  botId: string | null,
): string | null => botId ? pending[botId]?.action || null : null;

export const removeBotFromCatalog = (
  catalog: readonly BotSummary[],
  botId: string,
): readonly BotSummary[] => catalog.filter((bot) => bot.id !== botId);

export const createDefaultBotRevisionContract = (
  title = 'Untitled Bot',
): BotLegacyRevisionContract => ({
  identity: { title, avatar: '🤖' },
  objectives: ['Help people complete their requests.'],
  soul: buildStarterBotSoul({ name: title, title }),
  tone: '',
  operatingInstructions: '',
  prohibitedInstructions: '',
  advancedPrompt: '',
  // Every Bot runs one shared computer.
  tenancy: 'team',
  standingRole: 'You are a capable DevRyan Bot.',
  models: {
    primary: {
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      credentialId: PLACEHOLDER_CREDENTIAL_ID,
      egressHosts: ['auth.openai.com:443', 'chatgpt.com:443'],
    },
    fallbacks: [],
  },
  reasoning: { maxOutputTokens: 16_384 },
  fileTools: AUTONOMOUS_FILE_TOOLS,
  runtimeTools: AUTONOMOUS_RUNTIME_TOOLS,
  gatewayPluginVersion: 'devryan-bot-tools@1.2.0',
  libraryVersionIds: [],
  skillBindings: [],
  mcpBindings: [],
  memoryPolicy: {
    automaticExtraction: true,
    retrievalLimit: 12,
  },
  actionPolicy: { defaultEffect: 'allow', defaultRisk: 'low', rules: [] },
  browserPolicy: { allowedOrigins: [], deniedOrigins: [] },
});

export const validateBotRevisionConfiguration = (value: BotRevisionContract): BotRevisionValidation => {
  const errors: string[] = [];
  const models = botRevisionModelPolicy(value);
  if (!value.identity.title.trim()) errors.push('Identity title is required.');
  if (!value.standingRole.trim()) errors.push('Standing role is required.');
  if (value.objectives.length === 0) errors.push('At least one objective is required.');
  if (models) {
    if (!models.primary.providerId.trim() || !models.primary.modelId.trim()) {
      errors.push('Primary provider and model are required.');
    }
    if (!/^[0-9a-f-]{36}$/i.test(models.primary.credentialId)) {
      errors.push('Primary credential ID must be a UUID.');
    }
    if (models.primary.egressHosts.length === 0) {
      errors.push('Primary model needs at least one reviewed egress host.');
    }
  } else {
    errors.push('Bots must use an OpenCode model.');
  }
  // gatewayPluginVersion and libraryVersionIds are server-derived, so there is
  // nothing here for a person to get wrong.
  if (new TextEncoder().encode(value.soul || '').length > BOT_SOUL_MAX_BYTES) {
    errors.push('Soul is too long. Keep it to identity and voice.');
  }
  return { valid: errors.length === 0, errors };
};

export const applyAutonomousBotDefaults = (value: BotRevisionContract): BotRevisionContract => ({
  ...value,
  fileTools: AUTONOMOUS_FILE_TOOLS,
  runtimeTools: AUTONOMOUS_RUNTIME_TOOLS,
  actionPolicy: {
    ...value.actionPolicy,
    defaultEffect: 'allow',
    defaultRisk: 'low',
  },
});

export const usesAutonomousBotDefaults = (value: BotRevisionContract): boolean => (
  AUTONOMOUS_FILE_TOOLS.every((tool) => value.fileTools.includes(tool))
  && AUTONOMOUS_RUNTIME_TOOLS.every((tool) => value.runtimeTools?.includes(tool))
  && value.actionPolicy.defaultEffect === 'allow'
);

export const canRevokeBotMembership = (
  memberships: readonly BotManagedMembership[],
  userId: string,
): { allowed: boolean; reason: string | null } => {
  const target = memberships.find((membership) => (
    membership.userId === userId && membership.revokedAt === null
  ));
  if (!target) return { allowed: false, reason: 'Membership is already inactive.' };
  if (target.role !== 'manager') return { allowed: true, reason: null };
  const activeManagers = memberships.filter((membership) => (
    membership.role === 'manager' && membership.revokedAt === null
  ));
  return activeManagers.length > 1
    ? { allowed: true, reason: null }
    : { allowed: false, reason: 'At least one person must retain access to Bot settings.' };
};

export const botLifecycleAllowsDispatch = (lifecycle: string): boolean => lifecycle === 'active';

export type BotMembershipAssignment = {
  userId: string;
  role: BotMembershipRole;
  expectedUpdatedAt?: string;
};
