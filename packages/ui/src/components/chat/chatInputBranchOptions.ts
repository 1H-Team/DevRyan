const DRAFT_BRANCH_OPTION_PREFIX = 'branch:';

export type DraftLocalBranchOption = {
  value: string;
  label: string;
  remoteOnly: boolean;
};

const logicalBranchName = (value: string): string => value
  .replace(/^refs\/heads\//, '')
  .replace(/^refs\/remotes\/[^/]+\//, '')
  .replace(/^remotes\/[^/]+\//, '')
  .trim();

export function encodeDraftBranchOptionValue(branch: string): string {
  return `${DRAFT_BRANCH_OPTION_PREFIX}${branch}`;
}

export function decodeDraftBranchOptionValue(value: string): string | null {
  if (!value.startsWith(DRAFT_BRANCH_OPTION_PREFIX)) {
    return null;
  }
  const branch = value.slice(DRAFT_BRANCH_OPTION_PREFIX.length).trim();
  return branch || null;
}

export function buildDraftLocalBranchOptions(input: {
  allBranches: string[];
  currentBranch: string;
}): DraftLocalBranchOption[] {
  const localBranches = new Set(input.allBranches
    .filter((branch) => branch && !/^(?:refs\/)?remotes\//.test(branch))
    .map(logicalBranchName)
    .filter(Boolean));

  const remoteByName = new Map<string, string[]>();
  input.allBranches
    .filter((branch) => /^(?:refs\/)?remotes\//.test(branch))
    .forEach((branch) => {
      const name = logicalBranchName(branch);
      if (!name || name === 'HEAD') return;
      const refs = remoteByName.get(name) ?? [];
      refs.push(branch.replace(/^refs\//, ''));
      remoteByName.set(name, refs);
    });

  const locals = [...localBranches].sort((a, b) => a.localeCompare(b)).map((branch) => ({
    value: encodeDraftBranchOptionValue(branch),
    label: branch,
    remoteOnly: false,
  }));
  const remoteOnly = [...remoteByName.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, refs]) => {
      const sorted = [...refs].sort((left, right) => left.localeCompare(right));
      const preferred = sorted.find((ref) => ref === `remotes/origin/${name}`) ?? sorted[0];
      return { value: encodeDraftBranchOptionValue(preferred), label: name, remoteOnly: true };
    });
  return [...locals, ...remoteOnly];
}
