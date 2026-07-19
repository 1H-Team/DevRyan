export type PlanSendAction = 'improve' | 'implement';

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
