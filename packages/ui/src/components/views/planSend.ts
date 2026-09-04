import {
  findSelectableAgentByName,
  isHiddenBuiltinAgentOption,
  resolveDefaultAgentName,
  resolveSelectableAgentOptions,
  type AgentSelectionOption,
} from '@/lib/agentSelection';
import { buildPlanImplementationRequestMarker } from '@/lib/messages/actionablePlan';

export type PlanSendAction = 'improve' | 'implement';

/** OpenCode's built-in build agent — the last-resort implementer when no agent catalog is known. */
export const DEFAULT_PLAN_IMPLEMENTATION_AGENT = 'build';

const cleanAgentName = (value: string | null | undefined): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * The agent an Implement Plan turn is dispatched to. Always explicit: sending
 * `undefined` lets OpenCode reuse the session's last agent, which after a
 * plan-mode turn is `plan` — hidden from the selector and without edit tools,
 * so the implementation stalls. Precedence: the session's explicit selection,
 * then the draft / last-used agent, then the default build agent. A candidate
 * that resolves to `plan` (or, when the catalog is known, to a non-selectable
 * agent) is skipped.
 */
export const resolvePlanImplementationAgent = ({
  sessionAgent,
  draftAgent,
  agents,
  settingsDefaultAgent,
}: {
  sessionAgent?: string | null;
  draftAgent?: string | null;
  agents?: readonly AgentSelectionOption[];
  settingsDefaultAgent?: string | null;
}): string => {
  const selectableAgents = resolveSelectableAgentOptions([...(agents ?? [])], []);
  const pick = (candidate: string | null | undefined): string | undefined => {
    const name = cleanAgentName(candidate);
    if (!name || isHiddenBuiltinAgentOption(name)) return undefined;
    if (selectableAgents.length === 0) return name;
    return findSelectableAgentByName(selectableAgents, name)?.name;
  };

  const explicit = pick(sessionAgent) ?? pick(draftAgent);
  if (explicit) return explicit;

  const buildAgent = findSelectableAgentByName(selectableAgents, DEFAULT_PLAN_IMPLEMENTATION_AGENT)?.name;
  if (buildAgent) return buildAgent;

  const defaultAgent = cleanAgentName(resolveDefaultAgentName(cleanAgentName(settingsDefaultAgent), selectableAgents));
  if (defaultAgent && !isHiddenBuiltinAgentOption(defaultAgent)) return defaultAgent;

  return DEFAULT_PLAN_IMPLEMENTATION_AGENT;
};

export type PlanSendSyntheticPart = {
  synthetic: true;
  text: string;
};

export const getPlanSendVisiblePromptId = (action: PlanSendAction) =>
  action === 'improve' ? 'plan.improve.visible' : 'plan.implement.visible';

export const getPlanSendInstructionsPromptId = (action: PlanSendAction) =>
  action === 'improve' ? 'plan.improve.instructions' : 'plan.implement.instructions';

export const buildPlanSendPromptVariables = ({
  action,
  title,
  path,
}: {
  action: PlanSendAction;
  title: string;
  path: string;
  body?: string;
}) => {
  const planPath = path.trim();
  if (action === 'implement' && !planPath) {
    throw new Error('A saved plan file path is required to implement a plan');
  }

  return {
    plan_title: title,
    plan_path: planPath,
  };
};

export const getPlanSendPlanMode = (action: PlanSendAction): boolean | undefined =>
  action === 'implement' ? false : undefined;

export const buildPlanImplementationSyntheticParts = ({
  sourceSessionId,
  sourceMessageId,
  instructions,
}: {
  sourceSessionId: string;
  sourceMessageId: string;
  instructions: string;
}): PlanSendSyntheticPart[] => [
  {
    synthetic: true,
    text: buildPlanImplementationRequestMarker({
      sourceSessionId,
      sourceMessageId,
      planIndex: 0,
    }),
  },
  { synthetic: true, text: instructions },
];
