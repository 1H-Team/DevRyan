// DevRyan: model fallback is owned by the host (primary recovery). Slim's
// selection algorithm is reproduced here as a pure function over the host's
// persisted state; it mirrors ForegroundFallbackManager.resolveChain,
// rearmIfFreshDescent and selectFallbackModel in hooks/foreground-fallback.
import { isFailoverError } from '../hooks/foreground-fallback';
import { parseModelReference } from '../utils/session';

export type ReviewedFallbackEntry = string | { readonly id: string; readonly variant?: string };

export interface ReviewedSlimFallbackInput {
  readonly chains: Readonly<Record<string, readonly ReviewedFallbackEntry[]>>;
  readonly agent?: string;
  readonly currentModel?: string;
  readonly tried: readonly string[];
  readonly exhaustion: 0 | 1 | 2;
}

export type ReviewedSlimFallbackSelection =
  | null
  | 'exhausted'
  | {
      readonly agentName?: string;
      readonly currentModel?: string;
      readonly nextModel: string;
      readonly ref: { readonly providerID: string; readonly modelID: string };
      readonly variant?: string;
    };

export interface ReviewedSlimFallbackResult {
  readonly selection: ReviewedSlimFallbackSelection;
  readonly tried: readonly string[];
  readonly exhaustion: 0 | 1 | 2;
}

function resolveChain(
  chains: Readonly<Record<string, readonly string[]>>,
  agentName: string | undefined,
  currentModel: string | undefined,
): { chain: readonly string[]; source?: string } {
  if (agentName) {
    const chain = chains[agentName];
    if (chain) {
      if (currentModel && chain.length > 0 && !chain.includes(currentModel)) {
        return { chain: [currentModel, ...chain], source: agentName };
      }
      return { chain, source: agentName };
    }
    return { chain: [] };
  }
  if (currentModel) {
    for (const [name, chain] of Object.entries(chains)) {
      if (chain.includes(currentModel)) return { chain, source: name };
    }
  }
  const all: string[] = [];
  const seen = new Set<string>();
  for (const chain of Object.values(chains)) {
    for (const model of chain) {
      if (!seen.has(model)) {
        seen.add(model);
        all.push(model);
      }
    }
  }
  return { chain: all };
}

export function selectReviewedSlimFallback(input: ReviewedSlimFallbackInput): ReviewedSlimFallbackResult {
  const entries = Object.fromEntries(
    Object.entries(input.chains).map(([name, list]) => [
      name,
      list.map((entry) =>
        typeof entry === 'string' ? { id: entry } : { id: entry.id, variant: entry.variant },
      ),
    ]),
  );
  const ids = Object.fromEntries(
    Object.entries(entries).map(([name, list]) => [name, list.map((entry) => entry.id)]),
  );
  const agentName = input.agent;
  const observedModel = input.currentModel;
  let currentModel = observedModel;
  let tried = new Set(input.tried);
  let exhaustion: 0 | 1 | 2 = input.exhaustion;
  const result = (selection: ReviewedSlimFallbackSelection): ReviewedSlimFallbackResult => ({
    selection,
    tried: [...tried],
    exhaustion,
  });

  const { chain, source } = resolveChain(ids, agentName, currentModel);
  if (!chain.length) return result(null);
  if (!currentModel && agentName) currentModel = chain[0];
  // A return to the OBSERVED configured primary starts a new descent.
  if (observedModel !== undefined && tried.size > 1) {
    const configured = agentName === undefined ? undefined : ids[agentName];
    const rearmHead = configured?.[0] ?? resolveChain(ids, agentName, observedModel).chain[0];
    if (observedModel === rearmHead) {
      tried = new Set();
      exhaustion = 0;
    }
  }
  if (exhaustion === 2) return result(null);
  if (currentModel) {
    tried.add(currentModel);
    const index = chain.indexOf(currentModel);
    for (let i = 0; i < index; i++) tried.add(chain[i] as string);
  }
  let nextModel = chain.find((model) => !tried.has(model));
  if (!nextModel) {
    if (chain.length > 1 && exhaustion < 1) {
      exhaustion = 1;
      const primary = chain[0] as string;
      tried = new Set([primary]);
      if (currentModel && currentModel !== primary) tried.add(currentModel);
      nextModel = chain[chain.length - 1] as string;
    } else {
      exhaustion = 2;
      return result('exhausted');
    }
  }
  tried.add(nextModel);
  const ref = parseModelReference(nextModel);
  if (!ref) return result(null);
  const variant = source ? entries[source]?.find((entry) => entry.id === nextModel)?.variant : undefined;
  return result({ agentName, currentModel, nextModel, ref, ...(variant ? { variant } : {}) });
}

export { isFailoverError as isReviewedSlimFailoverError };
