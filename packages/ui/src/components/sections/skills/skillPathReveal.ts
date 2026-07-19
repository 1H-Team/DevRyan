import type { FilesAPI } from '@/lib/api/types';

type RevealPath = NonNullable<FilesAPI['revealPath']>;

export async function revealSkillPath(
  revealPath: RevealPath,
  skillPath: string,
  onFailure: () => void,
): Promise<boolean> {
  try {
    const result = await revealPath(skillPath);
    if (result.success) {
      return true;
    }
  } catch {
    // The caller owns user-facing error presentation.
  }

  onFailure();
  return false;
}
