export interface HelperModelSelection {readonly providerID:string;readonly modelID:string;readonly revision:string}
export const DEFAULT_HELPER_MODEL_SELECTION: Readonly<HelperModelSelection>;
export function parseHelperModelSelection(value:unknown):HelperModelSelection|undefined;
