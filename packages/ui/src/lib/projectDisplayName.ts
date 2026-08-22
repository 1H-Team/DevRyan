export type ProjectDisplayIdentity = {
  label?: string | null
  path: string
}

export const getExactProjectBasename = (projectPath: string, rootFallback = "Root"): string => {
  const normalized = projectPath.replaceAll("\\", "/").replace(/\/+$/, "")
  if (!normalized) return rootFallback
  const segments = normalized.split("/").filter(Boolean)
  return segments.at(-1) ?? rootFallback
}

export const resolveProjectDisplayName = (
  project: ProjectDisplayIdentity,
  rootFallback = "Root",
): string => {
  if (typeof project.label === "string" && project.label.trim().length > 0) {
    return project.label
  }
  return getExactProjectBasename(project.path, rootFallback)
}
