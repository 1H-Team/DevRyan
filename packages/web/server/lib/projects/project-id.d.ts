export function createProjectIdFromPath(projectPath: string): string;

export function resolveProjectPlansDirectory(
  projectPath?: string | null,
  homeDirectory?: string | null,
): Promise<string>;
