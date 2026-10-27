type DatabaseInfo = { name?: string }

export const selectIndexedDbName = async ({ canonical, legacy, listDatabases }: {
  canonical: string
  legacy: string
  listDatabases?: () => Promise<readonly DatabaseInfo[]>
}): Promise<string> => {
  if (!listDatabases) return legacy
  try {
    const names = new Set((await listDatabases()).map((database) => database.name))
    if (names.has(canonical)) return canonical
    if (names.has(legacy)) return legacy
    return canonical
  } catch {
    return legacy
  }
}
