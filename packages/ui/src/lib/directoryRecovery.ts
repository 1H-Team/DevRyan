import { getAuthPrincipal } from '@/lib/authSession'
import { isVSCodeRuntime } from '@/lib/desktop'
import { opencodeClient } from '@/lib/opencode/client'
import { probeDirectoryAvailability, type DirectoryAvailability } from '@/lib/directoryStatus'
import type { ProjectEntry } from '@/lib/api/types'
import { useDirectoryStore } from '@/stores/useDirectoryStore'
import { useProjectsStore } from '@/stores/useProjectsStore'
import { useSessionUIStore } from '@/sync/session-ui-store'
import { getSyncChildStoresIfInitialized } from '@/sync/sync-refs'

export const normalizeRecoveryDirectory = (value: string | null | undefined): string => {
  if (typeof value !== 'string') return ''
  const normalized = value.trim().replaceAll('\\', '/').replace(/^([a-z]):/, (_, letter: string) => `${letter.toUpperCase()}:`)
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '')
}

type RecoveryProject = Pick<ProjectEntry, 'id' | 'path' | 'branches'>

export type DirectoryRecoveryDependencies = {
  isManaged: () => boolean
  isVSCode: () => boolean
  getCurrentDirectory: () => string
  getHomeDirectory: () => string
  getProjects: () => RecoveryProject[]
  getActiveProjectId: () => string | null
  getRegisteredWorktrees: () => Map<string, Array<{ path: string }>>
  probe: (directory: string) => Promise<DirectoryAvailability>
  commit: (missingDirectory: string, fallbackDirectory: string) => boolean
  disposeDirectory: (directory: string) => void
  invalidateLocalDirectory: (directory: string) => void
}

const defaultDependencies: DirectoryRecoveryDependencies = {
  isManaged: () => getAuthPrincipal().scope === 'managed',
  isVSCode: () => isVSCodeRuntime(),
  getCurrentDirectory: () => useDirectoryStore.getState().currentDirectory,
  getHomeDirectory: () => useDirectoryStore.getState().homeDirectory,
  getProjects: () => useProjectsStore.getState().projects,
  getActiveProjectId: () => useProjectsStore.getState().activeProjectId,
  getRegisteredWorktrees: () => useSessionUIStore.getState().availableWorktreesByProject,
  probe: probeDirectoryAvailability,
  commit: (missingDirectory, fallbackDirectory) => (
    useDirectoryStore.getState().recoverMissingDirectory(missingDirectory, fallbackDirectory)
  ),
  disposeDirectory: (directory) => {
    getSyncChildStoresIfInitialized()?.discardDirectory(directory)
  },
  invalidateLocalDirectory: (directory) => opencodeClient.invalidateLocalDirectory(directory),
}

const projectOwnsDirectory = (
  project: RecoveryProject,
  missingDirectory: string,
  registered: Map<string, Array<{ path: string }>>,
): boolean => {
  const projectPath = normalizeRecoveryDirectory(project.path)
  const registeredForProject = registered.get(projectPath) ?? []
  if (registeredForProject.some((worktree) => normalizeRecoveryDirectory(worktree.path) === missingDirectory)) return true
  return (project.branches ?? []).some((branch) => normalizeRecoveryDirectory(branch.directory) === missingDirectory)
}

export async function recoverMissingActiveDirectory(
  missingDirectory: string,
  dependencies: DirectoryRecoveryDependencies = defaultDependencies,
  preferredProjectRoot?: string,
): Promise<{ recovered: boolean; fallback?: string; reason?: string }> {
  if (dependencies.isManaged()) return { recovered: false, reason: 'managed' }
  if (dependencies.isVSCode()) return { recovered: false, reason: 'vscode' }

  const missing = normalizeRecoveryDirectory(missingDirectory)
  if (!missing || normalizeRecoveryDirectory(dependencies.getCurrentDirectory()) !== missing) {
    return { recovered: false, reason: 'inactive' }
  }

  const missingStatus = await dependencies.probe(missing)
  if (missingStatus !== 'missing') return { recovered: false, reason: missingStatus }

  const projects = dependencies.getProjects()
  const activeProjectId = dependencies.getActiveProjectId()
  const registered = dependencies.getRegisteredWorktrees()
  const owner = projects.find((project) => projectOwnsDirectory(project, missing, registered))
  const active = projects.find((project) => project.id === activeProjectId)
  const candidates = [
    preferredProjectRoot,
    owner?.path,
    active?.path,
    ...projects.map((project) => project.path),
    dependencies.getHomeDirectory(),
  ]

  const seen = new Set<string>([missing])
  let fallback = ''
  for (const candidate of candidates) {
    const normalized = normalizeRecoveryDirectory(candidate)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    const status = await dependencies.probe(normalized)
    if (status === 'unknown') return { recovered: false, reason: 'unknown' }
    if (status === 'exists') {
      fallback = normalized
      break
    }
  }
  if (!fallback) return { recovered: false, reason: 'no-fallback' }

  if (normalizeRecoveryDirectory(dependencies.getCurrentDirectory()) !== missing) {
    return { recovered: false, reason: 'inactive' }
  }
  if (!dependencies.commit(missing, fallback)) {
    return { recovered: false, reason: 'inactive' }
  }

  dependencies.disposeDirectory(missing)
  dependencies.invalidateLocalDirectory(missing)
  return { recovered: true, fallback }
}
