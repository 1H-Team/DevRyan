export const ONE_CALL_PAGE: string;
export function runOneCallVerification(input: { readonly launcher: string; readonly root: string; readonly node: string }): Promise<{
  readonly receipt: { readonly terminated: boolean; readonly confined: boolean; readonly cancelled: boolean; readonly exitCode: number };
  readonly stdout: string; readonly stderr: string; readonly directory: string; readonly artifactDirectory: string | null;
  readonly published: readonly { readonly path: string; readonly status: string }[];
}>;
