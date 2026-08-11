import type { DiscoveredSkill } from "@/stores/useSkillsStore";
import { locationValueFrom, type SkillLocationValue } from "./skillLocations";

export interface SkillFolderGroup {
  key: string;
  label: string;
  skills: DiscoveredSkill[];
}

export interface SkillLocationGroup {
  key: SkillLocationValue;
  label: string;
  directSkills: DiscoveredSkill[];
  folderGroups: SkillFolderGroup[];
  count: number;
}

type MutableLocationGroup = Omit<SkillLocationGroup, "directSkills" | "folderGroups" | "count"> & {
  directSkills: DiscoveredSkill[];
  folderGroups: Map<string, SkillFolderGroup>;
};

const sortSkills = (a: DiscoveredSkill, b: DiscoveredSkill) => {
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return a.path.localeCompare(b.path);
};

export const formatSkillFolderLabel = (folder: string): string => {
  return folder
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

/** Filter skills for the sidebar search box. Every whitespace-separated term must
 *  match somewhere in the skill's name, description, folder group or path. */
export function filterSkillsForSidebar(skills: DiscoveredSkill[], query: string): DiscoveredSkill[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return skills;

  return skills.filter((skill) => {
    const haystack = [skill.name, skill.description ?? "", skill.group ?? "", skill.path]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Flat, name-sorted list used while the sidebar search box is active. */
export function sortSkillsForSidebar(skills: DiscoveredSkill[]): DiscoveredSkill[] {
  return [...skills].sort(sortSkills);
}

export function groupSkillsForSidebar(
  skills: DiscoveredSkill[],
  locationLabelText: (value: SkillLocationValue) => string,
): SkillLocationGroup[] {
  const locationGroups = new Map<SkillLocationValue, MutableLocationGroup>();

  for (const skill of skills) {
    const location = locationValueFrom(skill.scope, skill.source);
    let locationGroup = locationGroups.get(location);
    if (!locationGroup) {
      locationGroup = {
        key: location,
        label: locationLabelText(location),
        directSkills: [],
        folderGroups: new Map(),
      };
      locationGroups.set(location, locationGroup);
    }

    if (!skill.group) {
      locationGroup.directSkills.push(skill);
      continue;
    }

    let folderGroup = locationGroup.folderGroups.get(skill.group);
    if (!folderGroup) {
      folderGroup = {
        key: skill.group,
        label: formatSkillFolderLabel(skill.group),
        skills: [],
      };
      locationGroup.folderGroups.set(skill.group, folderGroup);
    }
    folderGroup.skills.push(skill);
  }

  return Array.from(locationGroups.values())
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((group) => {
      const directSkills = [...group.directSkills].sort(sortSkills);
      const folderGroups = Array.from(group.folderGroups.values())
        .map((folderGroup) => ({
          ...folderGroup,
          skills: [...folderGroup.skills].sort(sortSkills),
        }))
        .sort((a, b) => {
          const byLabel = a.label.localeCompare(b.label);
          if (byLabel !== 0) return byLabel;
          return a.key.localeCompare(b.key);
        });

      return {
        key: group.key,
        label: group.label,
        directSkills,
        folderGroups,
        count: directSkills.length + folderGroups.reduce((total, folderGroup) => total + folderGroup.skills.length, 0),
      };
    });
}
