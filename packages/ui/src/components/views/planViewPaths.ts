export interface PlanViewCandidatePathOptions {
  explicitTargetPath?: string | null;
  sessionPlanPath?: string | null;
  repoPlanPath?: string | null;
  homePlanPath?: string | null;
}

export const getPlanViewCandidatePaths = ({
  explicitTargetPath,
  sessionPlanPath,
  repoPlanPath,
  homePlanPath,
}: PlanViewCandidatePathOptions): string[] => {
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const candidate of [explicitTargetPath, sessionPlanPath, repoPlanPath, homePlanPath]) {
    const path = typeof candidate === 'string' ? candidate.trim() : '';
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }

  return paths;
};
