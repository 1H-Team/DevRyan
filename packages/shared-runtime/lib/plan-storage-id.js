// Project IDs remain public compatibility identifiers. Only their plan-storage
// directory component needs a bounded representation for long project paths.
export const resolvePlanProjectStorageId = async (projectID) => {
  if (projectID.length <= 255) return projectID;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(projectID));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `path_sha256_${hex}`;
};
