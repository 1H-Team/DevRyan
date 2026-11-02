export const DESIGNER_PRIMARY_STEP_WARNING = 180;
export const DESIGNER_PRIMARY_STEP_EMERGENCY = 260;

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,256}$/.test(value);
export const validatePrimaryStepBudget = value => {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['acceptedPrompts', 'userMessageID', 'assistantMessageIDs', 'warningClaimedAt', 'maintenanceParents', 'retiredPromptThrough'].includes(key))
    || !Array.isArray(value.acceptedPrompts) || value.acceptedPrompts.length > 32
    || value.acceptedPrompts.some(prompt => !prompt || Object.keys(prompt).some(key => !['userMessageID', 'createdAt'].includes(key))
      || !identifier(prompt.userMessageID) || !Number.isFinite(prompt.createdAt) || prompt.createdAt < 0)
    || new Set(value.acceptedPrompts.map(prompt => prompt.userMessageID)).size !== value.acceptedPrompts.length
    || value.retiredPromptThrough !== undefined && (!Number.isFinite(value.retiredPromptThrough) || value.retiredPromptThrough < 0)
    || value.maintenanceParents !== undefined && (!Array.isArray(value.maintenanceParents) || value.maintenanceParents.length > 32
      || value.maintenanceParents.some(parent => !parent || Object.keys(parent).some(key => !['parentID', 'userMessageID'].includes(key))
        || !identifier(parent.parentID) || !value.acceptedPrompts.some(prompt => prompt.userMessageID === parent.userMessageID))
      || new Set(value.maintenanceParents.map(parent => parent.parentID)).size !== value.maintenanceParents.length)
    || value.userMessageID !== null && !value.acceptedPrompts.some(prompt => prompt.userMessageID === value.userMessageID)
    || !Array.isArray(value.assistantMessageIDs) || value.assistantMessageIDs.length > DESIGNER_PRIMARY_STEP_EMERGENCY
    || value.assistantMessageIDs.some(id => !identifier(id))
    || new Set(value.assistantMessageIDs).size !== value.assistantMessageIDs.length
    || value.userMessageID === null && value.assistantMessageIDs.length !== 0
    || value.warningClaimedAt !== null && (!Number.isFinite(value.warningClaimedAt) || value.warningClaimedAt < 0)
    || value.warningClaimedAt !== null && value.assistantMessageIDs.length < DESIGNER_PRIMARY_STEP_WARNING) {
    throw new TypeError('Invalid managed primary step budget');
  }
};

export const designerStepBudgetNotice = (attempt, usedSteps) => ({
  code: 'designer_step_budget_warning', attempt, usedSteps, limit: DESIGNER_PRIMARY_STEP_EMERGENCY,
  message: `Designer has used ${usedSteps} primary steps for this accepted prompt. Finish the assigned work and run its exact required checks; avoid further broad discovery. The native prompt cap is 240 steps and the emergency stop is ${DESIGNER_PRIMARY_STEP_EMERGENCY}. Report remaining blockers honestly.`,
});
