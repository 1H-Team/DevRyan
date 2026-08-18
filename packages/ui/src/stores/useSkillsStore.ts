import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { devtools } from './utils/devtoolsGate';
import { emitConfigChange, scopeMatches, subscribeToConfigChanges } from "@/lib/configSync";
import { recordConfigMutationResponse } from '@/stores/useConfigApplyStore';
import { getSafeStorage } from "./utils/safeStorage";

import { opencodeClient } from '@/lib/opencode/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

const getCurrentDirectory = (): string | null => {
  const opencodeDirectory = opencodeClient.getDirectory();
  if (typeof opencodeDirectory === 'string' && opencodeDirectory.trim().length > 0) {
    return opencodeDirectory;
  }

  const dir = useDirectoryStore.getState().currentDirectory;
  return dir?.trim() ? dir.trim() : null;
};

export type SkillScope = 'user' | 'project';
export type SkillSource = 'opencode' | 'agents';

export interface SupportingFile {
  name: string;
  path: string;
  fullPath: string;
}

export interface SkillSources {
  md: {
    exists: boolean;
    path: string | null;
    dir: string | null;
    fields: string[];
    scope?: SkillScope | null;
    source?: SkillSource | null;
    supportingFiles: SupportingFile[];
    // Actual content values
    name?: string;
    description?: string;
    instructions?: string;
  };
  projectMd?: { exists: boolean; path: string | null };
  claudeMd?: { exists: boolean; path: string | null };
  userMd?: { exists: boolean; path: string | null };
}

export interface DiscoveredSkill {
  name: string;
  path: string;
  scope: SkillScope;
  source: SkillSource;
  description?: string;
  /** Domain folder parsed from file path, e.g. "automation-ai", "lark-ecosystem" */
  group?: string;
}

export type HiddenSkill = DiscoveredSkill;
export type SkillIdentity = Pick<DiscoveredSkill, 'name' | 'path' | 'scope' | 'source'>;

export function getSkillIdentity(skill: SkillIdentity): string {
  return [skill.name, skill.path, skill.scope, skill.source].join('\u001f');
}

/** Parse the domain group folder from a skill file path.
 *  e.g. "~/.config/opencode/skills/automation-ai/ai-production/SKILL.md" → "automation-ai"
 *  e.g. "~/.config/opencode/skills/theme-system/SKILL.md"                → undefined (flat)
 */
function parseSkillGroup(path: string): string | undefined {
  const normalizedPath = path.replace(/\\/g, '/');
  const idx = normalizedPath.lastIndexOf('/skills/');
  if (idx === -1) return undefined;
  const relative = normalizedPath.substring(idx + '/skills/'.length);
  const parts = relative.split('/');
  // Grouped layout: <group>/<name>/SKILL.md → parts.length >= 3
  // Flat layout:    <name>/SKILL.md         → parts.length == 2
  return parts.length >= 3 ? parts[0] : undefined;
}

// Raw skill response from API before transformation
interface RawSkillResponse {
  name: string;
  path: string;
  scope?: SkillScope;
  source?: SkillSource;
  description?: string;
  sources?: {
    md?: {
      description?: string;
    };
  };
}

export interface SkillConfig {
  name: string;
  description: string;
  instructions?: string;
  scope?: SkillScope;
  source?: SkillSource;
  supportingFiles?: Array<{ path: string; content: string }>;
}

export interface PendingFile {
  path: string;
  content: string;
}

export interface SkillDraft {
  name: string;
  scope: SkillScope;
  source?: SkillSource;
  description: string;
  instructions?: string;
  pendingFiles?: PendingFile[];
}

export interface SkillDetail {
  name: string;
  sources: SkillSources;
  scope?: SkillScope | null;
  source?: SkillSource | null;
}

interface SkillsStore {
  selectedSkillName: string | null;
  selectedSkillIdentity: string | null;
  skills: DiscoveredSkill[];
  isLoading: boolean;
  skillDraft: SkillDraft | null;

  setSelectedSkill: (skill: string | SkillIdentity | null) => void;
  setSkillDraft: (draft: SkillDraft | null) => void;
  loadSkills: (options?: { refresh?: boolean }) => Promise<boolean>;
  getSkillDetail: (name: string) => Promise<SkillDetail | null>;
  createSkill: (config: SkillConfig) => Promise<boolean>;
  updateSkill: (name: string, config: Partial<SkillConfig>) => Promise<boolean>;
  hideSkill: (skill: string | Pick<DiscoveredSkill, 'name' | 'path' | 'scope' | 'source'>) => Promise<boolean>;
  deleteSkill: (skill: string | Pick<DiscoveredSkill, 'name' | 'path' | 'scope' | 'source'>) => Promise<boolean>;
  listHiddenSkills: () => Promise<HiddenSkill[]>;
  restoreHiddenSkill: (path: string) => Promise<boolean>;
  getSkillByName: (name: string) => DiscoveredSkill | undefined;
  getSelectedSkill: () => DiscoveredSkill | undefined;
  
  // Supporting files
  readSupportingFile: (skillName: string, filePath: string) => Promise<string | null>;
  writeSupportingFile: (skillName: string, filePath: string, content: string) => Promise<boolean>;
  deleteSupportingFile: (skillName: string, filePath: string) => Promise<boolean>;
}

declare global {
  interface Window {
    __zustand_skills_store__?: UseBoundStore<StoreApi<SkillsStore>>;
  }
}

const CONFIG_EVENT_SOURCE = "useSkillsStore";
const SKILLS_LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_SKILLS_CACHE_KEY = '__default__';
const DEFAULT_SKILLS_SCOPE: SkillScope = 'user';
const skillsLastLoadedAt = new Map<string, number>();
const skillsLoadInFlight = new Map<string, Promise<boolean>>();

const getSkillsCacheKey = (directory: string | null): string => {
  return directory?.trim() || DEFAULT_SKILLS_CACHE_KEY;
};

const buildSkillsQueryString = (params: {
  directory?: string | null;
  includeHidden?: boolean;
  scope?: SkillScope;
  path?: string | null;
} = {}) => {
  const query = new URLSearchParams();
  if (params.directory) {
    query.set('directory', params.directory);
  }
  if (params.scope) {
    query.set('scope', params.scope);
  }
  if (params.includeHidden) {
    query.set('includeHidden', 'true');
  }
  if (params.path) {
    query.set('path', params.path);
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : '';
};

const buildSkillsSignature = (skills: DiscoveredSkill[]): string => {
  return skills
    .map((skill) => [
      skill.name,
      skill.path,
      skill.scope,
      skill.source,
      skill.description ?? '',
      skill.group ?? '',
    ].join('|'))
    .join('||');
};

const dedupeSkillsByPath = (skills: DiscoveredSkill[]): DiscoveredSkill[] => {
  const seenPaths = new Set<string>();
  const deduped: DiscoveredSkill[] = [];
  let changed = false;

  for (const skill of skills) {
    const skillPath = skill.path.trim();
    if (skillPath && seenPaths.has(skillPath)) {
      changed = true;
      continue;
    }
    if (skillPath) {
      seenPaths.add(skillPath);
    }
    deduped.push(skill);
  }

  return changed ? deduped : skills;
};

const isPackageCacheSkillPath = (skillPath: string): boolean => {
  const normalized = skillPath.replace(/\\/g, '/');
  return /\/(\.cache\/opencode|Library\/Caches\/opencode)\/packages\//.test(normalized);
};

const filterPackageCacheSkills = (skills: DiscoveredSkill[]): DiscoveredSkill[] => {
  const filtered = skills.filter((skill) => !isPackageCacheSkillPath(skill.path));
  return filtered.length === skills.length ? skills : filtered;
};

const getSkillRequestTarget = (
  store: Pick<SkillsStore, 'getSelectedSkill' | 'getSkillByName'>,
  name: string,
): DiscoveredSkill | undefined => {
  const selectedSkill = store.getSelectedSkill();
  if (selectedSkill?.name === name) {
    return selectedSkill;
  }
  return store.getSkillByName(name);
};

export const useSkillsStore = create<SkillsStore>()(
  devtools(
    persist(
      (set, get) => ({
        selectedSkillName: null,
        selectedSkillIdentity: null,
        skills: [],
        isLoading: false,
        skillDraft: null,

        setSelectedSkill: (skill: string | SkillIdentity | null) => {
          if (!skill) {
            set({ selectedSkillName: null, selectedSkillIdentity: null });
            return;
          }

          if (typeof skill === 'string') {
            const matched = get().skills.find((candidate) => candidate.name === skill);
            set({
              selectedSkillName: skill,
              selectedSkillIdentity: matched ? getSkillIdentity(matched) : null,
            });
            return;
          }

          set({
            selectedSkillName: skill.name,
            selectedSkillIdentity: getSkillIdentity(skill),
          });
        },

        setSkillDraft: (draft: SkillDraft | null) => {
          set({ skillDraft: draft });
        },

        loadSkills: async (options) => {
          const currentDirectory = getCurrentDirectory();
          const cacheKey = getSkillsCacheKey(currentDirectory);
          const now = Date.now();
          const loadedAt = skillsLastLoadedAt.get(cacheKey) ?? 0;
          const hasCachedSkills = get().skills.length > 0;

          if (!options?.refresh && hasCachedSkills && now - loadedAt < SKILLS_LOAD_CACHE_TTL_MS) {
            return true;
          }

          const inFlight = skillsLoadInFlight.get(cacheKey);
          if (!options?.refresh && inFlight) {
            return inFlight;
          }

          const request = (async () => {
            set({ isLoading: true });
            const previousSkills = get().skills;
            const previousSignature = buildSkillsSignature(previousSkills);
            let lastError: unknown = null;

            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const queryParams = buildSkillsQueryString({
                  directory: currentDirectory,
                });

                const response = await fetch(`/api/config/skills${queryParams}`);
                if (!response.ok) {
                  throw new Error(`Failed to list skills: ${response.status}`);
                }

                const data = await response.json();
                const rawSkills: RawSkillResponse[] = data.skills || [];
                const skills: DiscoveredSkill[] = filterPackageCacheSkills(dedupeSkillsByPath(rawSkills.map((s) => ({
                  name: s.name,
                  path: s.path,
                  scope: s.scope ?? DEFAULT_SKILLS_SCOPE,
                  source: s.source ?? 'opencode',
                  description: s.sources?.md?.description || s.description || '',
                  group: parseSkillGroup(s.path),
                }))));

                if (previousSignature === buildSkillsSignature(skills)) {
                  set({ isLoading: false });
                } else {
                  set({ skills, isLoading: false });
                }
                skillsLastLoadedAt.set(cacheKey, Date.now());
                return true;
              } catch (error) {
                lastError = error;
                const waitMs = 200 * (attempt + 1);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
              }
            }

            console.error("Failed to load skills:", lastError);
            set({ skills: previousSkills, isLoading: false });
            return false;
          })();

          skillsLoadInFlight.set(cacheKey, request);
          try {
            return await request;
          } finally {
            skillsLoadInFlight.delete(cacheKey);
          }
        },

        getSkillDetail: async (name: string) => {
          try {
            const currentDirectory = getCurrentDirectory();
            const selectedSkill = getSkillRequestTarget(get(), name);
            const queryParams = buildSkillsQueryString({
              directory: currentDirectory,
              scope: selectedSkill?.scope,
              path: selectedSkill?.path,
            });
            
            const response = await fetch(`/api/config/skills/${encodeURIComponent(name)}${queryParams}`);
            if (!response.ok) {
              return null;
            }
            
            return await response.json() as SkillDetail;
          } catch {
            return null;
          }
        },

        createSkill: async (config: SkillConfig) => {
          try {
            const currentDirectory = getCurrentDirectory();
            const skillConfig: Record<string, unknown> = {
              name: config.name,
              description: config.description,
            };

            if (config.instructions) skillConfig.instructions = config.instructions;
            if (config.scope) {
              skillConfig.scope = config.scope;
            } else if (currentDirectory) {
              skillConfig.scope = 'project';
            }
            if (config.source) skillConfig.source = config.source;
            if (config.supportingFiles) skillConfig.supportingFiles = config.supportingFiles;

            const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';

            const response = await fetch(`/api/config/skills/${encodeURIComponent(config.name)}${queryParams}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(skillConfig)
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to create skill';
              throw new Error(message);
            }

            recordConfigMutationResponse(payload);

            const loaded = await get().loadSkills({ refresh: true });
            if (loaded) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch {
            return false;
          }
        },

        updateSkill: async (name: string, config: Partial<SkillConfig>) => {
          try {
            const skillConfig: Record<string, unknown> = {};

            if (config.description !== undefined) skillConfig.description = config.description;
            if (config.instructions !== undefined) skillConfig.instructions = config.instructions;
            if (config.supportingFiles !== undefined) skillConfig.supportingFiles = config.supportingFiles;

            const currentDirectory = getCurrentDirectory();
            const selectedSkill = getSkillRequestTarget(get(), name);
            const queryParams = buildSkillsQueryString({
              directory: currentDirectory,
              scope: selectedSkill?.scope,
              path: selectedSkill?.path,
            });

            const response = await fetch(`/api/config/skills/${encodeURIComponent(name)}${queryParams}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(skillConfig)
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to update skill';
              throw new Error(message);
            }

            recordConfigMutationResponse(payload);

            const loaded = await get().loadSkills({ refresh: true });
            if (loaded) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch {
            return false;
          }
        },

        deleteSkill: async (skill) => {
          try {
            const currentDirectory = getCurrentDirectory();
            const skillName = typeof skill === 'string' ? skill : skill.name;
            const selectedSkill = typeof skill === 'string' ? getSkillRequestTarget(get(), skill) : skill;
            const queryParams = buildSkillsQueryString({
              directory: currentDirectory,
              scope: selectedSkill?.scope,
              path: selectedSkill?.path,
            });

            const response = await fetch(`/api/config/skills/${encodeURIComponent(skillName)}${queryParams}`, {
              method: 'DELETE'
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to delete skill';
              throw new Error(message);
            }
            recordConfigMutationResponse(payload);

            const selectedIdentity = get().selectedSkillIdentity;
            const targetIdentity = selectedSkill ? getSkillIdentity(selectedSkill) : null;
            set((state) => {
              const skills = targetIdentity
                ? state.skills.filter((entry) => getSkillIdentity(entry) !== targetIdentity)
                : state.skills.filter((entry) => entry.name !== skillName);
              const clearsSelection = (targetIdentity && selectedIdentity === targetIdentity)
                || (!selectedIdentity && state.selectedSkillName === skillName);

              return {
                skills,
                ...(clearsSelection
                  ? { selectedSkillName: null, selectedSkillIdentity: null }
                  : {}),
              };
            });

            emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            void get().loadSkills({ refresh: true });
            return true;
          } catch {
            return false;
          }
        },

        hideSkill: async (skill) => {
          try {
            const currentDirectory = getCurrentDirectory();
            const skillName = typeof skill === 'string' ? skill : skill.name;
            const selectedSkill = typeof skill === 'string' ? getSkillRequestTarget(get(), skill) : skill;
            const queryParams = buildSkillsQueryString({
              directory: currentDirectory,
              scope: selectedSkill?.scope,
              path: selectedSkill?.path,
            });

            const response = await fetch(`/api/config/skills/${encodeURIComponent(skillName)}/hide${queryParams}`, {
              method: 'POST',
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to hide skill';
              throw new Error(message);
            }

            recordConfigMutationResponse(payload);
            const selectedIdentity = get().selectedSkillIdentity;
            const targetIdentity = selectedSkill ? getSkillIdentity(selectedSkill) : null;
            if ((targetIdentity && selectedIdentity === targetIdentity)
              || (!selectedIdentity && get().selectedSkillName === skillName)) {
              set({ selectedSkillName: null, selectedSkillIdentity: null });
            }

            const loaded = await get().loadSkills({ refresh: true });
            if (loaded) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch {
            return false;
          }
        },

        listHiddenSkills: async () => {
          try {
            const currentDirectory = getCurrentDirectory();
            const queryParams = buildSkillsQueryString({
              directory: currentDirectory,
              includeHidden: true,
            });

            const response = await fetch(`/api/config/skills${queryParams}`);
            if (!response.ok) {
              return [];
            }

            const data = await response.json();
            const rawSkills: RawSkillResponse[] = Array.isArray(data?.hiddenSkills) ? data.hiddenSkills : [];
            return rawSkills.map((s) => ({
              name: s.name,
              path: s.path,
              scope: s.scope || DEFAULT_SKILLS_SCOPE,
              source: s.source || 'opencode',
              description: s.sources?.md?.description,
              group: parseSkillGroup(s.path),
            }));
          } catch {
            return [];
          }
        },

        restoreHiddenSkill: async (path: string) => {
          try {
            const currentDirectory = getCurrentDirectory();
            const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';

            const response = await fetch(`/api/config/skills/hidden/restore${queryParams}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path }),
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to restore skill';
              throw new Error(message);
            }

            recordConfigMutationResponse(payload);

            const loaded = await get().loadSkills({ refresh: true });
            if (loaded) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch {
            return false;
          }
        },

        getSkillByName: (name: string) => {
          const { skills } = get();
          return skills.find((s) => s.name === name);
        },

        getSelectedSkill: () => {
          const { skills, selectedSkillIdentity, selectedSkillName } = get();
          if (selectedSkillIdentity) {
            const exact = skills.find((skill) => getSkillIdentity(skill) === selectedSkillIdentity);
            if (exact) {
              return exact;
            }
          }
          return selectedSkillName ? skills.find((skill) => skill.name === selectedSkillName) : undefined;
        },

        readSupportingFile: async (skillName: string, filePath: string) => {
          try {
            const currentDirectory = getCurrentDirectory();
            const selectedSkill = getSkillRequestTarget(get(), skillName);
            const queryParams = buildSkillsQueryString({
              directory: currentDirectory,
              scope: selectedSkill?.scope,
              path: selectedSkill?.path,
            });
            
            const response = await fetch(
              `/api/config/skills/${encodeURIComponent(skillName)}/files/${encodeURIComponent(filePath)}${queryParams}`
            );
            if (!response.ok) {
              return null;
            }
            
            const data = await response.json();
            return data.content ?? null;
          } catch {
            return null;
          }
        },

        writeSupportingFile: async (skillName: string, filePath: string, content: string) => {
          try {
            const currentDirectory = getCurrentDirectory();
            const selectedSkill = getSkillRequestTarget(get(), skillName);
            const queryParams = buildSkillsQueryString({
              directory: currentDirectory,
              scope: selectedSkill?.scope,
              path: selectedSkill?.path,
            });
            
            const response = await fetch(
              `/api/config/skills/${encodeURIComponent(skillName)}/files/${encodeURIComponent(filePath)}${queryParams}`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
              }
            );
            const payload = await response.json().catch(() => null);
            if (response.ok) recordConfigMutationResponse(payload);
            return response.ok;
          } catch {
            return false;
          }
        },

        deleteSupportingFile: async (skillName: string, filePath: string) => {
          try {
            const currentDirectory = getCurrentDirectory();
            const selectedSkill = getSkillRequestTarget(get(), skillName);
            const queryParams = buildSkillsQueryString({
              directory: currentDirectory,
              scope: selectedSkill?.scope,
              path: selectedSkill?.path,
            });
            
            const response = await fetch(
              `/api/config/skills/${encodeURIComponent(skillName)}/files/${encodeURIComponent(filePath)}${queryParams}`,
              { method: 'DELETE' }
            );
            const payload = await response.json().catch(() => null);
            if (response.ok) recordConfigMutationResponse(payload);
            return response.ok;
          } catch {
            return false;
          }
        },
      }),
      {
        name: "skills-store",
        storage: createJSONStorage(() => getSafeStorage()),
        partialize: (state) => ({
          selectedSkillName: state.selectedSkillName,
          selectedSkillIdentity: state.selectedSkillIdentity,
        }),
      },
    ),
    {
      name: "skills-store",
    },
  ),
);

if (typeof window !== "undefined") {
  window.__zustand_skills_store__ = useSkillsStore;
}

// Subscribe to config changes from other stores
let unsubscribeSkillsConfigChanges: (() => void) | null = null;

if (!unsubscribeSkillsConfigChanges) {
  unsubscribeSkillsConfigChanges = subscribeToConfigChanges((event) => {
    if (event.source === CONFIG_EVENT_SOURCE) {
      return;
    }

    if (scopeMatches(event, "skills")) {
      const { loadSkills } = useSkillsStore.getState();
      void loadSkills({ refresh: true });
    }
  });
}
