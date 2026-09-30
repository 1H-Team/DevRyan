export const PLAN_DRAFT_CONFLICT = 'The saved plan changed. Your draft is preserved; copy it before reloading.';

/** One revision's draft and acknowledged baseline; save callbacks never read a later identity. */
export const createPlanRevisionDraft = (
  write: (content: string, expectedVersion: string) => Promise<string>,
) => {
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach(listener => listener());
  let content = '';
  let baseline = '';
  let version: string | null = null;
  let conflict = false;
  let error: string | null = null;
  let saving: Promise<void> | null = null;
  const observedDuringSave = new Set<string>();
  const markConflict = () => { conflict = true; error = PLAN_DRAFT_CONFLICT; changed(); };
  const draft = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => ({ content, version, dirty: content !== baseline, conflict, error, saving: saving !== null }),
    load(text: string, nextVersion: string) {
      if (saving || content !== baseline) {
        if (nextVersion !== version) markConflict();
        return;
      }
      content = baseline = text;
      version = nextVersion;
      conflict = false;
      error = null;
      changed();
    },
    edit(text: string) {
      content = text;
      if (!conflict) error = null;
      changed();
    },
    observe(nextVersion: string): 'ignore' | 'pending' | 'reload' | 'conflict' {
      if (nextVersion === version) return 'ignore';
      if (saving) { observedDuringSave.add(nextVersion); return 'pending'; }
      if (content === baseline && !conflict) return 'reload';
      markConflict();
      return 'conflict';
    },
    save(): Promise<void> {
      if (saving) return saving;
      if (conflict || version === null || content === baseline) return Promise.resolve();
      const run = async () => {
        try {
          while (!conflict && version !== null && content !== baseline) {
            const text = content;
            const nextVersion = await write(text, version);
            baseline = text;
            version = nextVersion;
            if ([...observedDuringSave].some(observed => observed !== nextVersion)) markConflict();
            observedDuringSave.clear();
            changed();
          }
        } catch (failure) {
          if (failure && typeof failure === 'object' && 'status' in failure && failure.status === 409) markConflict();
          else error = failure instanceof Error ? failure.message : 'Failed to save plan';
        } finally { saving = null; observedDuringSave.clear(); changed(); }
      };
      saving = run();
      changed();
      return saving;
    },
  };
  return draft;
};

export type PlanRevisionDraft = ReturnType<typeof createPlanRevisionDraft>;
