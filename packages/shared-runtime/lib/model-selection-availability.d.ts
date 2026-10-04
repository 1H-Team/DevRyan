export interface ModelSelection {
  readonly providerID: string;
  readonly modelID: string;
  readonly variant?: string | null;
}
export type ModelSelectionAvailability =
  | { readonly status: 'available'; readonly reason: null }
  | { readonly status: 'unavailable'; readonly reason: 'provider_missing' | 'model_missing' | 'variant_missing' }
  | { readonly status: 'unknown'; readonly reason: 'catalog_unavailable' };
export function inspectModelSelection(selection: ModelSelection, catalog: unknown,
  options?: { readonly variantsComplete?: boolean }): ModelSelectionAvailability;
