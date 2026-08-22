import { opencodeClient } from '@/lib/opencode/client'

export type DirectoryAvailability = 'unknown' | 'exists' | 'missing'

type DirectoryProbeDependencies = {
  listLocalDirectory: (directory: string) => Promise<unknown>
  probeDirectory: (directory: string) => Promise<boolean>
}

const errorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const direct = (error as { status?: unknown }).status
  if (typeof direct === 'number') return direct
  const nested = (error as { response?: { status?: unknown } }).response?.status
  return typeof nested === 'number' ? nested : undefined
}

export const isDefinitivelyMissingDirectoryError = (error: unknown): boolean => {
  const status = errorStatus(error)
  if (status === 404 || status === 410) return true
  if (status === 401 || status === 403 || status === 408 || status === 429 || (status !== undefined && status >= 500)) {
    return false
  }
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  if (code === 'ENOENT' || code === 'ENOTDIR') return true
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase()
  return message.includes('enoent')
    || message.includes('not found')
    || message.includes('does not exist')
    || message.includes('no such file')
}

const looksLikeSdkWorktree = (directory: string): boolean => (
  directory.includes('/opencode/worktree/')
  || directory.includes('/.opencode/data/worktree/')
  || directory.includes('/.local/share/opencode/worktree/')
)

const defaultDependencies: DirectoryProbeDependencies = {
  listLocalDirectory: (directory) => opencodeClient.listLocalDirectory(directory),
  probeDirectory: (directory) => opencodeClient.probeDirectory(directory),
}

export async function probeDirectoryAvailability(
  directory: string,
  dependencies: DirectoryProbeDependencies = defaultDependencies,
): Promise<DirectoryAvailability> {
  try {
    await dependencies.listLocalDirectory(directory)
    return 'exists'
  } catch (listError) {
    try {
      if (await dependencies.probeDirectory(directory)) return 'exists'
      if (isDefinitivelyMissingDirectoryError(listError) || looksLikeSdkWorktree(directory)) return 'missing'
      return 'unknown'
    } catch (probeError) {
      if (isDefinitivelyMissingDirectoryError(listError) || isDefinitivelyMissingDirectoryError(probeError)) {
        return 'missing'
      }
      return 'unknown'
    }
  }
}
