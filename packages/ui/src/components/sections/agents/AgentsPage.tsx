import React from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useShallow } from 'zustand/react/shallow';
import { useDirectorySync } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useDeviceInfo } from '@/lib/device';
import { opencodeClient } from '@/lib/opencode/client';
import { RiAddLine, RiArrowDownSLine, RiCloseLine, RiFlashlightFill, RiInformationLine, RiSaveLine, RiSubtractLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { ModelSelector } from './ModelSelector';
import { BehaviorPage } from '@/components/sections/behavior/BehaviorPage';
import { AgentRuntimeSection } from './AgentRuntimeSection';
import { SubagentLimitsSection } from './SubagentLimitsSection';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Switch } from '@/components/ui/switch';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import { formatAgentDisplayName } from '@/lib/agentDisplay';
import {
  canEditPersonalAgentModels,
  isAgentPermissionsUiHidden,
  isGlobalAgentBehaviorUiHidden,
  useAuthPrincipal,
} from '@/lib/authSession';
import {
  findAgentDefaultOverride,
  isSingleModelAgentDefault,
  resolveAgentDefaultSelection,
} from '@/lib/agentDefaultResolution';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { getModelVariantControlState, getModelVariantDisplayState, getOrderedThinkingVariants } from '@/lib/providers/variantControls';
import { resolveAgentVariantForModel, resolveAgentVariantForSave, resolveAgentVariantSelection } from './agentVariantSelection';
import { formatEffortLabel, formatVisibleEffortLabel } from '@/components/chat/mobileControlsUtils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type PermissionAction = 'allow' | 'ask' | 'deny';
type PermissionRule = { permission: string; pattern: string; action: PermissionAction };
type PermissionRuleKey = `${string}::${string}`;
type AgentMode = 'primary' | 'subagent' | 'all';
const NO_VARIANT_VALUE = '__no_variant__';
const COUNCIL_AGENT_NAME = 'council';

const isCouncilAgentName = (name?: string | null): boolean =>
  name?.trim().toLowerCase() === COUNCIL_AGENT_NAME;

const getRuntimeWarningDescription = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const candidate = payload as { warning?: unknown; runtimeMessage?: unknown };
  if (typeof candidate.warning === 'string' && candidate.warning.trim()) {
    return candidate.warning.trim();
  }
  if (typeof candidate.runtimeMessage === 'string' && candidate.runtimeMessage.trim()) {
    return candidate.runtimeMessage.trim();
  }
  return undefined;
};

const hasRuntimeWarning = (payload: unknown): boolean => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const candidate = payload as { reloadFailed?: unknown; runtimeApplied?: unknown };
  return candidate.reloadFailed === true || candidate.runtimeApplied === false;
};

const modelValueToRef = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value.trim() || null;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as { providerID?: unknown; modelID?: unknown; providerId?: unknown; modelId?: unknown };
  const providerId = typeof candidate.providerID === 'string'
    ? candidate.providerID
    : (typeof candidate.providerId === 'string' ? candidate.providerId : '');
  const modelId = typeof candidate.modelID === 'string'
    ? candidate.modelID
    : (typeof candidate.modelId === 'string' ? candidate.modelId : '');

  return providerId && modelId ? `${providerId}/${modelId}` : null;
};

const normalizeModelRefs = (value: unknown): string[] => {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map(modelValueToRef)
    .filter((entry): entry is string => Boolean(entry));
};

const normalizeModelRows = (models: string[]): string[] =>
  models.map((entry) => entry.trim()).filter(Boolean);

const toEditableModelRows = (models: string[]): string[] => {
  const normalized = normalizeModelRows(models);
  return normalized.length > 0 ? normalized : [''];
};

const getAgentModelRefs = (agent: unknown): string[] => {
  if (!agent || typeof agent !== 'object') {
    return [];
  }

  const candidate = agent as { modelRefs?: unknown; model?: unknown };
  const modelRefs = normalizeModelRefs(candidate.modelRefs);
  return modelRefs.length > 0 ? modelRefs : normalizeModelRefs(candidate.model);
};

const getAgentCouncillors = (agent: unknown): Array<{ model: string; variant?: string | null }> => {
  if (!agent || typeof agent !== 'object') {
    return [];
  }

  const candidate = agent as { councillors?: unknown };
  if (!Array.isArray(candidate.councillors)) {
    return [];
  }

  const councillors: Array<{ model: string; variant?: string | null }> = [];
  for (const entry of candidate.councillors) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
      const raw = entry as { model?: unknown; variant?: unknown };
      const modelRef = modelValueToRef(raw.model);
      if (!modelRef) {
      continue;
      }
    councillors.push({
        model: modelRef,
        variant: typeof raw.variant === 'string' ? raw.variant : null,
    });
  }
  return councillors;
};

const STANDARD_PERMISSION_KEYS = [
  '*',
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'skill',
  'lsp',
  'todoread',
  'todowrite',
  'webfetch',
  'websearch',
  'codesearch',
  'external_directory',
  'doom_loop',
  'question',
  'plan_enter',
  'plan_exit',
] as const;

const isPermissionAction = (value: unknown): value is PermissionAction =>
  value === 'allow' || value === 'ask' || value === 'deny';

const buildRuleKey = (permission: string, pattern: string): PermissionRuleKey =>
  `${permission}::${pattern}`;

const normalizeRuleset = (ruleset: PermissionRule[]): PermissionRule[] => {
  const map = new Map<PermissionRuleKey, PermissionRule>();
  for (const rule of ruleset) {
    if (!rule.permission || rule.permission === 'invalid') {
      continue;
    }
    if (!rule.pattern) {
      continue;
    }
    if (!isPermissionAction(rule.action)) {
      continue;
    }
    map.set(buildRuleKey(rule.permission, rule.pattern), {
      permission: rule.permission,
      pattern: rule.pattern,
      action: rule.action,
    });
  }
  return Array.from(map.values());
};

const buildRuleMap = (ruleset: PermissionRule[]): Map<PermissionRuleKey, PermissionRule> => {
  const map = new Map<PermissionRuleKey, PermissionRule>();
  for (const rule of normalizeRuleset(ruleset)) {
    map.set(buildRuleKey(rule.permission, rule.pattern), rule);
  }
  return map;
};

const getGlobalWildcardAction = (ruleset: PermissionRule[]): PermissionAction => {
  const globalRule = ruleset.find((rule) => rule.permission === '*' && rule.pattern === '*');
  return globalRule?.action ?? 'allow';
};

const filterRulesAgainstGlobal = (ruleset: PermissionRule[], globalAction: PermissionAction): PermissionRule[] => (
  normalizeRuleset(ruleset)
    .filter((rule) => !(rule.permission === '*' && rule.pattern === '*'))
    // Keep wildcard overrides only when they differ from global.
    .filter((rule) => rule.pattern !== '*' || rule.action !== globalAction)
);

const permissionConfigToRuleset = (value: unknown): PermissionRule[] => {
  if (isPermissionAction(value)) {
    return [{ permission: '*', pattern: '*', action: value }];
  }

  if (Array.isArray(value)) {
    const rules: PermissionRule[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const candidate = entry as Partial<PermissionRule>;
      if (typeof candidate.permission === 'string' && typeof candidate.pattern === 'string' && isPermissionAction(candidate.action)) {
        rules.push({ permission: candidate.permission, pattern: candidate.pattern, action: candidate.action });
      }
    }
    return rules;
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  const rules: PermissionRule[] = [];
  for (const [permissionName, configValue] of Object.entries(value as Record<string, unknown>)) {
    if (permissionName === '__originalKeys') {
      continue;
    }
    if (isPermissionAction(configValue)) {
      rules.push({ permission: permissionName, pattern: '*', action: configValue });
      continue;
    }
    if (configValue && typeof configValue === 'object' && !Array.isArray(configValue)) {
      for (const [pattern, action] of Object.entries(configValue as Record<string, unknown>)) {
        if (isPermissionAction(action)) {
          rules.push({ permission: permissionName, pattern, action });
        }
      }
    }
  }

  return rules;
};

export const AgentsPage: React.FC = () => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const {
    selectedAgentName,
    getAgentByName,
    agents,
    staleModelOverrides,
    saveAgentModelOverride,
    saveAgentBackupModel,
    resetAgentBackupModel,
  } = useAgentsStore(useShallow((s) => ({
    selectedAgentName: s.selectedAgentName,
    getAgentByName: s.getAgentByName,
    agents: s.agents,
    staleModelOverrides: s.staleModelOverrides,
    saveAgentModelOverride: s.saveAgentModelOverride,
    saveAgentBackupModel: s.saveAgentBackupModel,
    resetAgentBackupModel: s.resetAgentBackupModel,
  })));

  const selectedAgent = selectedAgentName ? getAgentByName(selectedAgentName) : null;
  const providers = useConfigStore((state) => state.providers);
  const personalAgentSelections = useConfigStore((state) => state.agentModelSelections);
  const persistAgentModelSelection = useConfigStore((state) => state.persistAgentModelSelection);
  const resetAgentModelSelection = useConfigStore((state) => state.resetAgentModelSelection);
  const applyDefaultsToCurrent = useConfigStore((state) => state.applyDefaultsToCurrent);
  const isReadOnly = true;

  const [description, setDescription] = React.useState('');
  const [mode, setMode] = React.useState<AgentMode>('subagent');
  const [model, setModel] = React.useState('');
  const [councilModels, setCouncilModels] = React.useState<string[]>(['']);
  const [councilVariants, setCouncilVariants] = React.useState<Array<string | undefined>>([undefined]);
  const [variant, setVariant] = React.useState<string | undefined>(undefined);
  const [backupModel, setBackupModel] = React.useState('');
  const [backupVariant, setBackupVariant] = React.useState<string | undefined>(undefined);
  const [temperature, setTemperature] = React.useState<number | undefined>(undefined);
  const [prompt, setPrompt] = React.useState('');
  const [globalPermission, setGlobalPermission] = React.useState<PermissionAction>('allow');
  const [permissionBaseline, setPermissionBaseline] = React.useState<PermissionRule[]>([]);
  const [permissionRules, setPermissionRules] = React.useState<PermissionRule[]>([]);
  const [pendingRuleName, setPendingRuleName] = React.useState('');
  const [pendingRulePattern, setPendingRulePattern] = React.useState('*');
  const [isToolPermissionsOpen, setIsToolPermissionsOpen] = React.useState(false);
  const authPrincipal = useAuthPrincipal();
  const permissionsUiHidden = isAgentPermissionsUiHidden(authPrincipal);
  const behaviorUiHidden = isGlobalAgentBehaviorUiHidden(authPrincipal);
  const isPersonalModelEditor = canEditPersonalAgentModels(authPrincipal);
  const isHostModelEditor = authPrincipal.scope === 'local-admin' || authPrincipal.role === 'admin';
  const canEditSelectedModel = isHostModelEditor || (
    Boolean(selectedAgent)
    && !isCouncilAgentName(selectedAgentName)
    && isSingleModelAgentDefault(selectedAgent ?? undefined)
    && isPersonalModelEditor
  );
  const personalSelection = selectedAgentName
    ? findAgentDefaultOverride(personalAgentSelections, selectedAgentName)
    : null;
  const savedBackupModel = selectedAgent
    ? ((selectedAgent as { backupModel?: { providerID?: string; modelID?: string; variant?: string | null } | null }).backupModel ?? null)
    : null;
  const savedBackupModelRef = savedBackupModel?.providerID && savedBackupModel?.modelID
    ? `${savedBackupModel.providerID}/${savedBackupModel.modelID}`
    : '';
  const inheritedSelection = selectedAgentName && selectedAgent
    ? resolveAgentDefaultSelection({
      agentName: selectedAgentName,
      agents: [selectedAgent],
      providers,
    })
    : null;
  const [showPermissionEditor, setShowPermissionEditor] = React.useState(false);
  const [isSavingModelOverride, setIsSavingModelOverride] = React.useState(false);

  const currentDirectory = useDirectoryStore((state) => state.currentDirectory ?? null);
  const [toolIds, setToolIds] = React.useState<string[]>([]);

  const activeAgentNameForBehavior = selectedAgentName;
  const isCouncilAgent = isCouncilAgentName(activeAgentNameForBehavior);
  const getAvailableVariantsForModel = React.useCallback((modelRef: string) => {
    const parsedModel = parseModelIdentifier(modelRef);
    if (!parsedModel) return [];
    const provider = providers.find((entry) => entry.id === parsedModel.providerId);
    const providerModel = provider?.models.find((entry) => entry.id === parsedModel.modelId) as { variants?: Record<string, unknown> } | undefined;
    return getOrderedThinkingVariants(providerModel?.variants, { providerId: parsedModel.providerId });
  }, [providers]);
  const getProviderForModelRef = React.useCallback((modelRef: string) => {
    const parsedModel = parseModelIdentifier(modelRef);
    return parsedModel ? providers.find((entry) => entry.id === parsedModel.providerId) : undefined;
  }, [providers]);
  const resolveVariantForModel = React.useCallback((
    modelRef: string,
    currentVariant: string | undefined,
  ) => resolveAgentVariantForModel(
    getProviderForModelRef(modelRef),
    modelRef,
    currentVariant,
  ), [getProviderForModelRef]);
  const setCouncilModelAt = React.useCallback((index: number, value: string) => {
    setCouncilVariants((prev) => {
      const next = [...prev];
      while (next.length <= index) {
        next.push(undefined);
      }
      next[index] = resolveVariantForModel(value, next[index]);
      return next;
    });
    setCouncilModels((prev) => {
      const next = [...prev];
      while (next.length <= index) {
        next.push('');
      }
      const previousFirstModel = next[0] ?? '';
      next[index] = value;
      const nextFirstModel = next[0] ?? '';

      if (index === 0 && previousFirstModel !== nextFirstModel) {
        setModel(nextFirstModel);
        setVariant((currentVariant) => resolveVariantForModel(nextFirstModel, currentVariant));
      }

      return next;
    });
  }, [resolveVariantForModel]);

  const addCouncilModel = React.useCallback(() => {
    setCouncilModels((prev) => [...prev, '']);
    setCouncilVariants((prev) => [...prev, undefined]);
  }, []);

  const removeCouncilModelAt = React.useCallback((index: number) => {
    if (index <= 0) {
      return;
    }

    setCouncilModels((prev) => {
      if (prev.length <= 1) {
        return prev;
      }
      return prev.filter((_, entryIndex) => entryIndex !== index);
    });
    setCouncilVariants((prev) => prev.filter((_, entryIndex) => entryIndex !== index));
  }, []);

  const setCouncilVariantAt = React.useCallback((index: number, value: string | undefined) => {
    setCouncilVariants((prev) => {
      const next = [...prev];
      while (next.length <= index) {
        next.push(undefined);
      }
      next[index] = value;
      return next;
    });
  }, []);

  const permissionsBySession = useDirectorySync((state) => state.permission);

  React.useEffect(() => {
    let cancelled = false;

    const fetchToolIds = async () => {
      const ids = await opencodeClient.listToolIds({ directory: currentDirectory });
      if (cancelled) {
        return;
      }

      // OpenCode permissions are keyed by tool name, but some tools are grouped
      // under a single permission key. E.g. `edit` covers `write`, `patch`, and `multiedit`.
      const editCoveredToolIds = new Set(['write', 'patch', 'multiedit']);

      const normalized = ids
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter(Boolean)
        .filter((id) => id !== '*')
        .filter((id) => id !== 'invalid')
        .filter((id) => !editCoveredToolIds.has(id));

      setToolIds(Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b)));
    };

    void fetchToolIds();

    return () => {
      cancelled = true;
    };
  }, [currentDirectory]);

  const knownPermissionNames = React.useMemo(() => {
    const names = new Set<string>();

    for (const agent of agents) {
      const rules = normalizeRuleset(Array.isArray(agent.permission) ? agent.permission as PermissionRule[] : []);
      for (const rule of rules) {
        if (rule.permission && rule.permission !== '*' && rule.permission !== 'invalid') {
          names.add(rule.permission);
        }
      }
    }

    for (const permissions of Object.values(permissionsBySession)) {
      for (const request of permissions) {
        const permissionName = request.permission?.trim();
        if (permissionName && permissionName !== 'invalid') {
          names.add(permissionName);
        }
      }
    }

    for (const toolId of toolIds) {
      names.add(toolId);
    }

    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [agents, permissionsBySession, toolIds]);

  const baselineRuleMap = React.useMemo(() => buildRuleMap(permissionBaseline), [permissionBaseline]);
  const currentRuleMap = React.useMemo(() => buildRuleMap(permissionRules), [permissionRules]);

  const getWildcardOverride = React.useCallback((permissionName: string): PermissionAction | undefined => (
    currentRuleMap.get(buildRuleKey(permissionName, '*'))?.action
  ), [currentRuleMap]);


  const getPatternRules = React.useCallback((permissionName: string): PermissionRule[] => (
    permissionRules
      .filter((rule) => rule.permission === permissionName && rule.pattern !== '*')
      .sort((a, b) => a.pattern.localeCompare(b.pattern))
  ), [permissionRules]);

  const summaryPermissionNames = React.useMemo(() => {
    const names = new Set<string>();
    for (const key of STANDARD_PERMISSION_KEYS) {
      names.add(key);
    }
    for (const key of knownPermissionNames) {
      names.add(key);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [knownPermissionNames]);


  const getPermissionSummary = React.useCallback((permissionName: string) => {
    const defaultAction = permissionName === '*'
      ? globalPermission
      : (getWildcardOverride(permissionName) ?? globalPermission);
    const patternRules = getPatternRules(permissionName);
    const hasDefaultHint = false;
    const patternCounts = patternRules.reduce<Record<PermissionAction, number>>((acc, rule) => {
      acc[rule.action] = (acc[rule.action] ?? 0) + 1;
      return acc;
    }, { allow: 0, ask: 0, deny: 0 });
    const patternSummary = (['allow', 'ask', 'deny'] as const)
      .filter((action) => patternCounts[action] > 0)
      .map((action) => `${patternCounts[action]} ${action}`)
      .join(', ');
    return {
      defaultAction,
      patternRulesCount: patternRules.length,
      patternSummary,
      hasDefaultHint,
    };
  }, [getPatternRules, getWildcardOverride, globalPermission]);
  const permissionActionLabel = React.useCallback((value: PermissionAction): string => {
    if (value === 'allow') return t('settings.common.permission.allow');
    if (value === 'deny') return t('settings.common.permission.deny');
    return t('settings.common.permission.ask');
  }, [t]);
  const permissionScopeLabel = React.useCallback((value: PermissionAction | 'global'): string => {
    if (value === 'global') return t('settings.common.scope.global');
    return permissionActionLabel(value);
  }, [permissionActionLabel, t]);

  const availablePermissionNames = React.useMemo(() => {
    const names = new Set<string>();

    for (const key of STANDARD_PERMISSION_KEYS) {
      names.add(key);
    }

    for (const key of knownPermissionNames) {
      names.add(key);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [knownPermissionNames]);

  const upsertRule = React.useCallback((permissionName: string, pattern: string, action: PermissionAction) => {
    setPermissionRules((prev) => {
      const map = buildRuleMap(prev);
      map.set(buildRuleKey(permissionName, pattern), { permission: permissionName, pattern, action });
      return Array.from(map.values());
    });
  }, []);

  const removeRule = React.useCallback((permissionName: string, pattern: string) => {
    setPermissionRules((prev) => {
      const map = buildRuleMap(prev);
      map.delete(buildRuleKey(permissionName, pattern));
      return Array.from(map.values());
    });
  }, []);

  const revertRule = React.useCallback((permissionName: string, pattern: string) => {
    const baseline = baselineRuleMap.get(buildRuleKey(permissionName, pattern));
    if (baseline) {
      upsertRule(permissionName, pattern, baseline.action);
      return;
    }
    removeRule(permissionName, pattern);
  }, [baselineRuleMap, removeRule, upsertRule]);

  const setRuleAction = React.useCallback((permissionName: string, pattern: string, action: PermissionAction) => {
    upsertRule(permissionName, pattern, action);
  }, [upsertRule]);

  const setGlobalPermissionAndPrune = React.useCallback((next: PermissionAction) => {
    setGlobalPermission(next);
    setPermissionRules((prev) => prev.filter((rule) => !(rule.pattern === '*' && rule.action === next)));
  }, []);

  const applyPendingRule = React.useCallback((action: PermissionAction) => {
    const name = pendingRuleName.trim();
    if (!name) {
      toast.error(t('settings.agents.page.toast.permissionNameRequired'));
      return;
    }

    const pattern = pendingRulePattern.trim() || '*';
    if (name === '*' && pattern === '*') {
      setGlobalPermissionAndPrune(action);
      setPendingRuleName('');
      setPendingRulePattern('*');
      return;
    }
    if (pattern === '*' && name !== '*' && action === globalPermission) {
      removeRule(name, '*');
    } else {
      upsertRule(name, pattern, action);
    }
    setPendingRuleName('');
    setPendingRulePattern('*');
  }, [globalPermission, pendingRuleName, pendingRulePattern, removeRule, setGlobalPermissionAndPrune, t, upsertRule]);

  const formatPermissionLabel = React.useCallback((permissionName: string): string => {
    if (permissionName === '*') return t('settings.agents.page.permissions.defaultLabel');
    if (permissionName === 'webfetch') return 'WebFetch';
    if (permissionName === 'websearch') return 'WebSearch';
    if (permissionName === 'codesearch') return 'CodeSearch';
    if (permissionName === 'doom_loop') return 'Doom Loop';
    if (permissionName === 'external_directory') return 'External Directory';
    if (permissionName === 'todowrite') return 'TodoWrite';
    if (permissionName === 'todoread') return 'TodoRead';

    return permissionName
      .split(/[_-]+/g)
      .filter(Boolean)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(' ');
  }, [t]);

  React.useEffect(() => {
    setPendingRuleName('');
    setPendingRulePattern('*');

    const applyPermissionState = (rules: PermissionRule[]) => {
      const normalized = normalizeRuleset(rules);
      const nextGlobal = getGlobalWildcardAction(normalized);
      const filtered = filterRulesAgainstGlobal(normalized, nextGlobal);
      setGlobalPermission(nextGlobal);
      setPermissionBaseline(filtered);
      setPermissionRules(filtered);
      return { global: nextGlobal, rules: filtered };
    };

    if (selectedAgent && selectedAgentName === selectedAgent.name) {
      const descriptionValue = selectedAgent.description || '';
      const modeValue = selectedAgent.mode || 'subagent';
      const selectedModelRefs = getAgentModelRefs(selectedAgent);
      const selectedCouncillors = getAgentCouncillors(selectedAgent);
      const personalModelValue = isPersonalModelEditor && personalSelection && !isCouncilAgentName(selectedAgentName)
        ? `${personalSelection.providerId}/${personalSelection.modelId}`
        : '';
      const modelValue = personalModelValue || selectedModelRefs[0] || '';
      const councilModelValues = selectedCouncillors.length > 0
        ? selectedCouncillors.map((entry) => entry.model)
        : normalizeModelRows(selectedModelRefs);
      const councilVariantValues = selectedCouncillors.length > 0
        ? selectedCouncillors.map((entry) => resolveVariantForModel(
          entry.model,
          typeof entry.variant === 'string' ? entry.variant : undefined,
        ))
        : councilModelValues.map((entry) => resolveVariantForModel(entry, undefined));
      const savedVariantValue = personalModelValue
        ? personalSelection?.variant
        : (typeof (selectedAgent as { variant?: unknown }).variant === 'string'
          ? (selectedAgent as { variant: string }).variant
          : undefined);
      const variantValue = resolveVariantForModel(modelValue, savedVariantValue);
      const selectedBackup = (selectedAgent as { backupModel?: { providerID?: string; modelID?: string; variant?: string | null } | null }).backupModel ?? null;
      const backupModelValue = selectedBackup?.providerID && selectedBackup?.modelID
        ? `${selectedBackup.providerID}/${selectedBackup.modelID}`
        : '';
      const backupVariantValue = backupModelValue
        ? resolveVariantForModel(backupModelValue, typeof selectedBackup?.variant === 'string' ? selectedBackup.variant : undefined)
        : undefined;
      const temperatureValue = selectedAgent.temperature;
      const promptValue = selectedAgent.prompt || '';

      setDescription(descriptionValue);
      setMode(modeValue);

      setModel(modelValue);
      setCouncilModels(toEditableModelRows(councilModelValues));
      setCouncilVariants(councilVariantValues.length > 0 ? councilVariantValues : [undefined]);
      setVariant(variantValue);
      setBackupModel(backupModelValue);
      setBackupVariant(backupVariantValue);
      setTemperature(temperatureValue);
      setPrompt(promptValue);

      applyPermissionState(
        permissionConfigToRuleset(selectedAgent.permission),
      );
    }
  }, [isPersonalModelEditor, personalSelection, resolveVariantForModel, selectedAgent, selectedAgentName]);

  const handleSaveModelOverride = React.useCallback(async () => {
    if (!selectedAgentName) {
      return;
    }
    const trimmedModel = model.trim();
    if (!trimmedModel) {
      toast.error(t('settings.agents.page.toast.modelRequired'));
      return;
    }

    setIsSavingModelOverride(true);
    try {
      const resolvedVariant = resolveAgentVariantForSave(
        getProviderForModelRef(trimmedModel),
        trimmedModel,
        variant,
      );
      const resolvedCouncillors = councilModels
        .map((entry, index) => {
          const trimmedCouncilModel = entry.trim();
          return {
            model: trimmedCouncilModel,
            variant: resolveAgentVariantForSave(
              getProviderForModelRef(trimmedCouncilModel),
              trimmedCouncilModel,
              councilVariants[index],
            ),
          };
        })
        .filter((entry) => entry.model.length > 0);

      if (isPersonalModelEditor) {
        const parsed = parseModelIdentifier(trimmedModel);
        if (!parsed) {
          throw new Error(t('settings.agents.page.toast.modelRequired'));
        }
        await persistAgentModelSelection(
          selectedAgentName,
          parsed.providerId,
          parsed.modelId,
          resolvedVariant,
        );
        applyDefaultsToCurrent();
        toast.success(t('settings.agents.page.toast.modelOverrideSaved'));
        return;
      }

      const result = await saveAgentModelOverride(selectedAgentName, {
        name: selectedAgentName,
        model: trimmedModel,
        variant: resolvedVariant,
        councillors: isCouncilAgent
          ? resolvedCouncillors
          : undefined,
      });
      if (hasRuntimeWarning(result)) {
        const description = getRuntimeWarningDescription(result);
        toast.warning(t('settings.agents.page.toast.modelOverrideSavedRuntimeWarning'), description ? { description } : undefined);
      } else {
        toast.success(t('settings.agents.page.toast.modelOverrideSaved'));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.agents.page.toast.modelOverrideSaveFailed'));
    } finally {
      setIsSavingModelOverride(false);
    }
  }, [applyDefaultsToCurrent, councilModels, councilVariants, getProviderForModelRef, isCouncilAgent, isPersonalModelEditor, model, persistAgentModelSelection, saveAgentModelOverride, selectedAgentName, t, variant]);

  const handleResetPersonalModelOverride = React.useCallback(async () => {
    if (!selectedAgentName || !isPersonalModelEditor) return;
    setIsSavingModelOverride(true);
    try {
      await resetAgentModelSelection(selectedAgentName);
      applyDefaultsToCurrent();
      toast.success(`${formatAgentDisplayName(selectedAgentName)} now inherits the host default`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.agents.page.toast.modelOverrideSaveFailed'));
    } finally {
      setIsSavingModelOverride(false);
    }
  }, [applyDefaultsToCurrent, isPersonalModelEditor, resetAgentModelSelection, selectedAgentName, t]);

  const handleSaveBackupModel = React.useCallback(async () => {
    if (!selectedAgentName) {
      return;
    }
    const trimmedBackupModel = backupModel.trim();
    if (!trimmedBackupModel) {
      toast.error(t('settings.agents.page.toast.modelRequired'));
      return;
    }

    setIsSavingModelOverride(true);
    try {
      const resolvedVariant = resolveAgentVariantForSave(
        getProviderForModelRef(trimmedBackupModel),
        trimmedBackupModel,
        backupVariant,
      );
      await saveAgentBackupModel(selectedAgentName, {
        model: trimmedBackupModel,
        variant: resolvedVariant ?? null,
      });
      toast.success(t('settings.agents.page.toast.backupModelSaved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.agents.page.toast.backupModelSaveFailed'));
    } finally {
      setIsSavingModelOverride(false);
    }
  }, [backupModel, backupVariant, getProviderForModelRef, saveAgentBackupModel, selectedAgentName, t]);

  const handleClearBackupModel = React.useCallback(async () => {
    if (!selectedAgentName) {
      return;
    }
    setIsSavingModelOverride(true);
    try {
      await resetAgentBackupModel(selectedAgentName);
      setBackupModel('');
      setBackupVariant(undefined);
      toast.success(t('settings.agents.page.toast.backupModelCleared'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.agents.page.toast.backupModelClearFailed'));
    } finally {
      setIsSavingModelOverride(false);
    }
  }, [resetAgentBackupModel, selectedAgentName, t]);

  if (!selectedAgentName) {
    if (behaviorUiHidden) return null;
    // Host-wide scheduler pacing and runtime switches sit with the other
    // per-host policy, not inside one agent's editor.
    return (
      <BehaviorPage>
        <SubagentLimitsSection canEdit={isHostModelEditor} />
        <AgentRuntimeSection canEdit={isHostModelEditor} />
      </BehaviorPage>
    );
  }

  const renderThinkingLevelRow = (
    key?: React.Key,
    alignUnderModel = false,
    modelRef = model,
    value: string | undefined = variant,
    onChange: (value: string | undefined) => void = setVariant,
    onModelChange: (value: string) => void = setModel,
  ) => {
    const parsedRowModel = parseModelIdentifier(modelRef);
    const rowProvider = parsedRowModel ? providers.find((entry) => entry.id === parsedRowModel.providerId) : undefined;
    const rowVariantControlState = parsedRowModel
      ? getModelVariantControlState(rowProvider, parsedRowModel.modelId, value)
      : null;
    const rowAvailableVariants = rowVariantControlState?.visibleVariantOptions ?? getAvailableVariantsForModel(modelRef);
    const rowSupportsVariants = rowAvailableVariants.length > 0;
    const rowCanToggleFast = Boolean(rowVariantControlState?.canToggleFast);
    const selectedVariant = typeof value === 'string'
      ? rowAvailableVariants.find((entry) => entry === value.trim())
        ?? rowAvailableVariants.find((entry) => entry.trim().toLowerCase() === value.trim().toLowerCase())
      : undefined;
    const selectValue = selectedVariant ?? NO_VARIANT_VALUE;
    const rowVariantDisplayState = parsedRowModel
      ? getModelVariantDisplayState(rowProvider, parsedRowModel.modelId, value)
      : null;
    const rowFastEnabled = Boolean(rowVariantDisplayState?.fastEnabled);
    const rowEffortLabel = selectedVariant
      ? formatEffortLabel(selectedVariant, { providerId: parsedRowModel?.providerId })
      : (
        rowVariantDisplayState?.selectedVariant && rowAvailableVariants.length > 0
          ? formatVisibleEffortLabel(rowVariantDisplayState.selectedVariant, rowAvailableVariants, { providerId: parsedRowModel?.providerId })
          : formatEffortLabel(undefined, { providerId: parsedRowModel?.providerId })
      );
    const applyVariantUpdate = (updates: { fastEnabled?: boolean; variant?: string }) => {
      const selection = resolveAgentVariantSelection(rowProvider, modelRef, value, updates);
      if (selection.modelRef !== modelRef) {
        onModelChange(selection.modelRef);
      }
      onChange(selection.variant);
    };

    return (
      <div key={key} className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:gap-3">
        <div className={cn("flex min-w-0 flex-col sm:w-40 shrink-0", alignUnderModel && "hidden sm:block")}>
          <span className="typography-ui-label text-foreground">{t('settings.agents.page.field.thinkingLevel')}</span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:w-fit sm:flex-initial">
          {alignUnderModel && (
            <span className="typography-ui-label text-foreground sm:hidden">{t('settings.agents.page.field.thinkingLevel')}</span>
          )}
          <Select
            value={selectValue}
            onValueChange={(nextValue) => {
              if (nextValue === NO_VARIANT_VALUE) {
                onChange(undefined);
                return;
              }
              applyVariantUpdate({ variant: nextValue });
            }}
            disabled={!canEditSelectedModel || isSavingModelOverride || (!rowSupportsVariants && !rowCanToggleFast)}
          >
            <SelectTrigger className="w-fit min-w-[120px]">
              <SelectValue placeholder={t('settings.agents.page.field.thinkingPlaceholder')}>
                {(rowEffortLabel || rowFastEnabled) ? (
                  <span className="inline-flex items-center gap-1">
                    {rowEffortLabel ?? null}
                    {rowFastEnabled ? (
                      <RiFlashlightFill className="h-3.5 w-3.5 text-[var(--status-warning)]" aria-label="Fast Mode" />
                    ) : null}
                  </span>
                ) : t('settings.agents.page.field.thinkingPlaceholder')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {rowCanToggleFast ? (
                <>
                  <div className="flex items-center justify-between gap-4 rounded-lg px-2 py-1.5">
                    <span className="typography-ui-label text-foreground">Fast</span>
                    <Switch
                      checked={rowFastEnabled}
                      onCheckedChange={(checked) => applyVariantUpdate({ fastEnabled: checked })}
                      disabled={!canEditSelectedModel || isSavingModelOverride}
                      aria-label="Fast"
                    />
                  </div>
                  <SelectSeparator />
                </>
              ) : null}
              {rowAvailableVariants.map((availableVariant) => (
                <SelectItem key={availableVariant} value={availableVariant}>
                  {formatEffortLabel(availableVariant, { providerId: parsedRowModel?.providerId })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    );
  };

  const thinkingLevelRow = renderThinkingLevelRow();

  const renderCouncilModelRow = (councilModel: string, index: number) => {
    const parsedCouncilModel = parseModelIdentifier(councilModel);
    const modelNumber = index + 1;

    return (
      <div key={index} className="space-y-0">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
          <div className="flex min-w-0 flex-col sm:w-40 shrink-0">
            <span className="typography-ui-label text-foreground">
              {t('settings.agents.page.field.councilModelLabel', { number: modelNumber })}
            </span>
          </div>
          <div className="flex min-w-0 flex-1 items-center">
            <ModelSelector
              providerId={parsedCouncilModel?.providerId ?? ''}
              modelId={parsedCouncilModel?.modelId ?? ''}
              className="w-full sm:max-w-[360px]"
              disabled={!canEditSelectedModel || isSavingModelOverride}
              onChange={(providerId: string, modelId: string) => {
                setCouncilModelAt(index, providerId && modelId ? `${providerId}/${modelId}` : '');
              }}
            />
            {index > 0 && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="ml-1 shrink-0"
                onClick={() => removeCouncilModelAt(index)}
                disabled={!canEditSelectedModel || isSavingModelOverride}
                aria-label={t('settings.agents.page.field.removeCouncilModelAria', { number: modelNumber })}
              >
                <RiCloseLine className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
        {renderThinkingLevelRow(
          `council-thinking-${index}`,
          true,
          councilModel,
          councilVariants[index],
          (nextVariant) => setCouncilVariantAt(index, nextVariant),
          (nextModelRef) => setCouncilModelAt(index, nextModelRef),
        )}
      </div>
    );
  };

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">

        {/* Header */}
        <div className="mb-4 min-w-0">
          <h2 className="typography-ui-header font-semibold text-foreground truncate">
            {formatAgentDisplayName(selectedAgentName)}
          </h2>
        </div>

        {staleModelOverrides.length > 0 && (
          <div className="mb-4 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 py-2">
            <p className="typography-meta text-muted-foreground">
              {t('settings.agents.page.staleModelOverrides', { agents: staleModelOverrides.join(', ') })}
            </p>
          </div>
        )}

        {/* Identity & Role */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.agents.page.section.identityRole')}
            </h3>
          </div>

          <section className="px-2 pb-2 pt-0 space-y-0">

            <div className="pb-1.5 pt-0.5">
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="typography-ui-label text-foreground">{t('settings.agents.page.field.mode')}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent sideOffset={8} className="max-w-xs">
                      {t('settings.agents.page.field.modeTooltip')}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                <Button
                  variant="chip"
                  size="xs"
                  aria-pressed={mode === 'primary'}
                  onClick={() => setMode('primary')}
                  disabled={isReadOnly}
                  className="!font-normal"
                >
                  {t('settings.agents.page.mode.primary')}
                </Button>
                <Button
                  variant="chip"
                  size="xs"
                  aria-pressed={mode === 'subagent'}
                  onClick={() => setMode('subagent')}
                  disabled={isReadOnly}
                  className="!font-normal"
                >
                  {t('settings.agents.page.mode.subagent')}
                </Button>
                <Button
                  variant="chip"
                  size="xs"
                  aria-pressed={mode === 'all'}
                  onClick={() => setMode('all')}
                  disabled={isReadOnly}
                  className="!font-normal"
                >
                  {isCouncilAgent ? t('settings.agents.page.mode.multiAgent') : t('settings.agents.page.mode.all')}
                </Button>
                </div>
              </div>
            </div>

            {/* Model & Parameters */}
            <div className="py-1.5">
              <div className="mb-1">
                <h3 className="typography-ui-header font-medium text-foreground">
                  {t('settings.agents.page.section.modelParameters')}
                </h3>
              </div>

              <section className="pb-2 pt-0 space-y-0">

                {isPersonalModelEditor && !isCouncilAgent ? (
                  <div className="flex flex-wrap items-center gap-2 py-1.5 typography-meta text-muted-foreground">
                    <span className={personalSelection
                      ? 'rounded-full bg-primary/10 px-2 py-0.5 text-primary'
                      : 'rounded-full bg-muted px-2 py-0.5'}>
                      {personalSelection ? 'Personal' : 'Inherited'}
                    </span>
                    {inheritedSelection ? (
                      <span>
                        Host default: {inheritedSelection.providerId}/{inheritedSelection.modelId}
                        {inheritedSelection.variant ? ` · ${inheritedSelection.variant}` : ''}
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {isCouncilAgent ? (
                  <div className="space-y-1 py-1.5">
                    {renderCouncilModelRow(councilModels[0] ?? '', 0)}
                    {councilModels.slice(1).map((councilModel, offset) => renderCouncilModelRow(councilModel, offset + 1))}
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                      <div className="hidden sm:block sm:w-40 shrink-0" />
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          className="!font-normal"
                          onClick={addCouncilModel}
                          disabled={!canEditSelectedModel || isSavingModelOverride}
                        >
                          <RiAddLine className="h-3.5 w-3.5" />
                          {t('settings.agents.page.field.addCouncilModel')}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:gap-3">
                    <div className="flex min-w-0 flex-col sm:w-40 shrink-0">
                      <span className="typography-ui-label text-foreground">{t('settings.agents.page.field.overrideModel')}</span>
                    </div>
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <ModelSelector
                        providerId={parseModelIdentifier(model)?.providerId ?? ''}
                        modelId={parseModelIdentifier(model)?.modelId ?? ''}
                        className="w-full sm:max-w-[360px]"
                        disabled={!canEditSelectedModel || isSavingModelOverride}
                        onChange={(providerId: string, modelId: string) => {
                          const nextModel = providerId && modelId ? `${providerId}/${modelId}` : '';
                          setModel(nextModel);
                          setVariant((currentVariant) => resolveVariantForModel(nextModel, currentVariant));
                        }}
                      />
                    </div>
                  </div>
                )}

                {!isCouncilAgent && thinkingLevelRow}

                {!isCouncilAgent ? (
                  <div className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:gap-3">
                    <div className="flex min-w-0 flex-col sm:w-40 shrink-0">
                      <div className="flex items-center gap-1.5">
                        <span className="typography-ui-label text-foreground">{t('settings.agents.page.field.backupModel')}</span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent sideOffset={8} className="max-w-xs">
                            {t('settings.agents.page.field.backupModelTooltip')}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                    {isPersonalModelEditor ? (
                      <div className="flex min-w-0 flex-1 items-center typography-meta text-muted-foreground">
                        <span className="truncate">
                          {savedBackupModelRef
                            ? `${savedBackupModelRef}${savedBackupModel?.variant ? ` · ${savedBackupModel.variant}` : ''}`
                            : t('settings.agents.page.field.backupModelNone')}
                        </span>
                      </div>
                    ) : (
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <ModelSelector
                          providerId={parseModelIdentifier(backupModel)?.providerId ?? ''}
                          modelId={parseModelIdentifier(backupModel)?.modelId ?? ''}
                          className="w-full sm:max-w-[360px]"
                          disabled={!canEditSelectedModel || isSavingModelOverride}
                          onChange={(providerId: string, modelId: string) => {
                            const nextBackupModel = providerId && modelId ? `${providerId}/${modelId}` : '';
                            setBackupModel(nextBackupModel);
                            setBackupVariant((currentVariant) => resolveVariantForModel(nextBackupModel, currentVariant));
                          }}
                        />
                      </div>
                    )}
                  </div>
                ) : null}

                {!isCouncilAgent && !isPersonalModelEditor
                  ? renderThinkingLevelRow('backup-thinking', true, backupModel, backupVariant, setBackupVariant, setBackupModel)
                  : null}

                {!isCouncilAgent && !isPersonalModelEditor ? (
                  <div className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:gap-3">
                    <div className="hidden sm:block sm:w-40 shrink-0" />
                    <div className="flex min-w-0 flex-1 justify-end gap-2 sm:justify-start">
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        className="!font-normal normal-case"
                        onClick={() => void handleSaveBackupModel()}
                        disabled={!canEditSelectedModel || isSavingModelOverride || !backupModel.trim()}
                      >
                        <RiSaveLine className="h-3.5 w-3.5" />
                        {t('settings.agents.page.actions.saveBackupModel')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        className="!font-normal normal-case"
                        onClick={() => void handleClearBackupModel()}
                        disabled={!canEditSelectedModel || isSavingModelOverride || !savedBackupModelRef}
                      >
                        <RiCloseLine className="h-3.5 w-3.5" />
                        {t('settings.agents.page.actions.clearBackupModel')}
                      </Button>
                    </div>
                  </div>
                ) : null}

                <div className={cn("py-1", isMobile ? "flex flex-col gap-2" : "flex items-center gap-3")}>
                  <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "sm:w-40 shrink-0")}>
                    <div className="flex items-center gap-1.5">
                      <span className="typography-ui-label text-foreground">{t('settings.agents.page.field.temperature')}</span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent sideOffset={8} className="max-w-xs">
                          {t('settings.agents.page.field.temperatureTooltip')}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <span className="typography-meta text-muted-foreground">{t('settings.agents.page.field.temperatureRange')}</span>
                  </div>
                  <div className={cn("flex items-center gap-2", isMobile ? "w-full" : "w-fit")}>
                    <NumberInput
                      value={temperature}
                      fallbackValue={0.7}
                      onValueChange={setTemperature}
                      disabled={isReadOnly}
                      min={0}
                      max={2}
                      step={0.1}
                      inputMode="decimal"
                      placeholder="—"
                      emptyLabel="—"
                      className="w-16"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:gap-3">
                  <div className="hidden sm:block sm:w-40 shrink-0" />
                  <div className="flex min-w-0 flex-1 justify-end gap-2 sm:justify-start">
                    <Button
                      type="button"
                      variant="default"
                      size="xs"
                      className="!font-normal normal-case"
                      onClick={() => void handleSaveModelOverride()}
                      disabled={!canEditSelectedModel || isSavingModelOverride}
                    >
                      <RiSaveLine className="h-3.5 w-3.5" />
                      {t('settings.agents.page.actions.saveModelOverride')}
                    </Button>
                    {isPersonalModelEditor && !isCouncilAgent ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        className="!font-normal normal-case"
                        onClick={() => void handleResetPersonalModelOverride()}
                        disabled={!personalSelection || isSavingModelOverride}
                      >
                        Reset to Host
                      </Button>
                    ) : null}
                  </div>
                </div>

              </section>
            </div>

            <div className="py-1.5">
              <span className="typography-ui-label text-foreground">{t('settings.common.field.description')}</span>
              <div className="mt-1.5">
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  readOnly
                  aria-readonly="true"
                  placeholder={t('settings.agents.page.field.descriptionPlaceholder')}
                  rows={2}
                  className="w-full resize-none min-h-[60px] bg-transparent"
                />
              </div>
            </div>

            <div className="py-1.5">
              <span className="typography-ui-label text-foreground">{t('settings.agents.page.section.systemPrompt')}</span>
              <div className="mt-1.5">
                <Textarea
                  value={prompt}
                  readOnly
                  aria-readonly="true"
                  placeholder={t('settings.agents.page.field.systemPromptPlaceholder')}
                  rows={8}
                  outerClassName="bg-[var(--surface-muted)]"
                  className="w-full font-mono typography-meta min-h-[120px] max-h-[60vh] bg-transparent resize-y cursor-default"
                />
              </div>
            </div>

          </section>
        </div>

        {/* Tool Permissions */}
        {!permissionsUiHidden && (
        <Collapsible open={isToolPermissionsOpen} onOpenChange={setIsToolPermissionsOpen} className="mb-2">
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-4 rounded-md px-1 py-1 text-left hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.agents.page.section.toolPermissions')}
            </h3>
            <RiArrowDownSLine
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground",
                isToolPermissionsOpen && "rotate-180",
              )}
            />
          </CollapsibleTrigger>

          <CollapsibleContent className="pt-1">
            <div className="mb-1 flex justify-end px-1">
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => setShowPermissionEditor((prev) => !prev)}
              >
                {showPermissionEditor ? t('settings.agents.page.permissions.hideEditor') : t('settings.agents.page.permissions.advancedEditor')}
              </Button>
            </div>

            {!showPermissionEditor ? (
              <section className="px-2 pb-2 pt-0 space-y-0">
              {summaryPermissionNames.map((permissionName, index) => {
                const { defaultAction, patternRulesCount, patternSummary, hasDefaultHint } = getPermissionSummary(permissionName);
                const label = formatPermissionLabel(permissionName);
                const summary = hasDefaultHint ? `${defaultAction} (env blocked)` : defaultAction;
                return (
                  <div key={permissionName} className={cn("flex flex-col gap-1 py-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-8", index > 0 && "border-t border-[var(--surface-subtle)]")}>
                    <div className="flex items-center gap-2">
                      <span className="typography-ui-label text-foreground">{label}</span>
                      <span className="typography-micro text-muted-foreground/70 font-mono hidden sm:inline-block">{permissionName}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      {patternRulesCount > 0 ? (
                        <span className="typography-micro text-muted-foreground bg-[var(--surface-muted)] px-1.5 py-0.5 rounded">{t('settings.agents.page.permissions.globalSummary', { summary })}</span>
                      ) : (
                        <span className={cn("typography-micro capitalize px-1.5 py-0.5 rounded", summary === 'allow' ? "text-[var(--status-success)] bg-[var(--status-success)]/10" : summary === 'deny' ? "text-[var(--status-error)] bg-[var(--status-error)]/10" : "text-[var(--status-warning)] bg-[var(--status-warning)]/10")}>{summary}</span>
                      )}
                      {patternRulesCount > 0 && (
                        <span className="typography-micro text-muted-foreground bg-[var(--surface-muted)] px-1.5 py-0.5 rounded">{t('settings.agents.page.permissions.rulesSummary', { summary: patternSummary })}</span>
                      )}
                    </div>
                  </div>
                );
              })}
              </section>
            ) : (
              <div className="space-y-6 px-2">
              <div className="flex items-center justify-between gap-4 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="typography-ui-label text-foreground">{t('settings.agents.page.permissions.globalDefault')}</span>
                  <span className="typography-micro text-muted-foreground/70 font-mono">*</span>
                </div>
                <Select
                  value={globalPermission}
                  onValueChange={(value) => setGlobalPermissionAndPrune(value as PermissionAction)}
                  disabled={isReadOnly}
                >
                  <SelectTrigger className="w-[100px]">
                    <SelectValue>{permissionActionLabel(globalPermission)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="allow">{t('settings.common.permission.allow')}</SelectItem>
                    <SelectItem value="ask">{t('settings.common.permission.ask')}</SelectItem>
                    <SelectItem value="deny">{t('settings.common.permission.deny')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-4">
                {summaryPermissionNames.filter((name) => name !== '*').map((permissionName) => {
                  const label = formatPermissionLabel(permissionName);
                  const { defaultAction, patternRulesCount } = getPermissionSummary(permissionName);
                  const wildcardOverride = getWildcardOverride(permissionName);
                  const wildcardValue: string = wildcardOverride ?? 'global';
                  const patternRules = getPatternRules(permissionName);
                  const wildcardOptions = (['allow', 'ask', 'deny'] as const).filter((action) => action !== globalPermission);

                  return (
                    <div key={permissionName} className="border-t border-[var(--surface-subtle)] pt-2">
                      <div className="flex items-center justify-between py-1">
                        <div className="flex items-center gap-2">
                          <span className="typography-ui-label text-foreground">{label}</span>
                          <span className="typography-micro text-muted-foreground/70 font-mono">{permissionName}</span>
                        </div>
                        <div className="typography-micro text-muted-foreground">
                          {patternRulesCount > 0 ? t('settings.agents.page.permissions.globalSummary', { summary: defaultAction }) : defaultAction}
                        </div>
                      </div>

                      <div className="space-y-1 pl-2 mt-1">
                        <div className="flex flex-wrap items-center justify-between gap-2 py-0.5">
                          <div className="flex items-center gap-2">
                            <span className="typography-micro text-muted-foreground">{t('settings.agents.page.permissions.pattern')}</span>
                            <span className="typography-micro font-mono text-foreground bg-[var(--surface-muted)] px-1 rounded">*</span>
                            {wildcardOverride && (
                              <Button size="sm"
                                variant="ghost"
                                onClick={() => revertRule(permissionName, '*')}
                                className="px-1.5 py-0 h-5"
                              >
                                <RiSubtractLine className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                              </Button>
                            )}
                          </div>
                          <Select
                            value={wildcardValue}
                            onValueChange={(value) => {
                              if (value === 'global') {
                                removeRule(permissionName, '*');
                                return;
                              }
                              upsertRule(permissionName, '*', value as PermissionAction);
                            }}
                            disabled={isReadOnly}
                          >
                            <SelectTrigger className="w-[90px]">
                               <SelectValue>{permissionScopeLabel(wildcardValue as PermissionAction | 'global')}</SelectValue>
                             </SelectTrigger>
                             <SelectContent>
                               <SelectItem value="global">{t('settings.common.scope.global')}</SelectItem>
                              {wildcardOptions.map((action) => (
                                <SelectItem key={action} value={action}>
                                  {permissionActionLabel(action)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        {patternRules.map((rule) => {
                          const ruleKey = buildRuleKey(rule.permission, rule.pattern);
                          const baselineRule = baselineRuleMap.get(ruleKey);
                          const isAdded = !baselineRule;
                          const isModified = Boolean(baselineRule && baselineRule.action !== rule.action);

                          return (
                            <div key={ruleKey} className="flex flex-wrap items-center justify-between gap-2 py-0.5 border-t border-[var(--surface-subtle)]">
                              <div className="flex items-center gap-2">
                                <span className="typography-micro text-muted-foreground">{t('settings.agents.page.permissions.pattern')}</span>
                                <span className="typography-micro font-mono text-foreground bg-[var(--surface-muted)] px-1 rounded">{rule.pattern}</span>
                                {isAdded && <span className="typography-micro text-[var(--status-success)]">{t('settings.common.badge.new')}</span>}
                                {isModified && <span className="typography-micro text-[var(--status-warning)]">{t('settings.common.badge.modified')}</span>}
                                {(isAdded || isModified) && (
                                  <Button size="sm"
                                    variant="ghost"
                                    onClick={() => isAdded ? removeRule(rule.permission, rule.pattern) : revertRule(rule.permission, rule.pattern)}
                                    disabled={isReadOnly}
                                    className="px-1.5 py-0 h-5"
                                  >
                                    <RiSubtractLine className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                                  </Button>
                                )}
                              </div>
                              <Select
                                value={rule.action}
                                onValueChange={(value) => setRuleAction(rule.permission, rule.pattern, value as PermissionAction)}
                                disabled={isReadOnly}
                              >
                                 <SelectTrigger className="w-[90px]">
                                   <SelectValue>{permissionActionLabel(rule.action)}</SelectValue>
                                 </SelectTrigger>
                                 <SelectContent>
                                   <SelectItem value="allow">{t('settings.common.permission.allow')}</SelectItem>
                                  <SelectItem value="ask">{t('settings.common.permission.ask')}</SelectItem>
                                  <SelectItem value="deny">{t('settings.common.permission.deny')}</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="border-t border-[var(--surface-subtle)] pt-3">
                <h4 className="typography-ui-label text-foreground mb-2">{t('settings.agents.page.permissions.addCustomRule')}</h4>
                <div className="flex flex-col sm:flex-row items-end sm:items-center gap-2">
                  <Select value={pendingRuleName} onValueChange={setPendingRuleName} disabled={isReadOnly}>
                    <SelectTrigger className="w-full sm:w-[160px]">
                      {pendingRuleName ? (
                        <span className="truncate">{formatPermissionLabel(pendingRuleName)}</span>
                      ) : (
                        <span className="text-muted-foreground">{t('settings.agents.page.permissions.permissionPlaceholder')}</span>
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      {availablePermissionNames.map((name) => (
                        <SelectItem key={name} value={name}>
                          <div className="flex items-center justify-between gap-2 w-full">
                            <span>{formatPermissionLabel(name)}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Input
                    value={pendingRulePattern}
                    onChange={(e) => setPendingRulePattern(e.target.value)}
                    disabled={isReadOnly}
                    placeholder={t('settings.agents.page.permissions.patternPlaceholder')}
                    className="h-7 flex-1 font-mono text-xs"
                  />

                  <div className="flex gap-1">
                    <Button variant="outline" size="xs" className="!font-normal" onClick={() => applyPendingRule('allow')} disabled={isReadOnly}>{t('settings.common.permission.allow')}</Button>
                    <Button variant="outline" size="xs" className="!font-normal" onClick={() => applyPendingRule('ask')} disabled={isReadOnly}>{t('settings.common.permission.ask')}</Button>
                    <Button variant="outline" size="xs" className="!font-normal" onClick={() => applyPendingRule('deny')} disabled={isReadOnly}>{t('settings.common.permission.deny')}</Button>
                  </div>
                </div>
              </div>
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
        )}

      </div>
    </ScrollableOverlay>
  );
};
