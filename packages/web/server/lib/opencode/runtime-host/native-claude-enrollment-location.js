const fail=code=>Object.assign(new Error(code),{code,status:503,statusCode:503});

/** Claude accounts are global to the bundle: a request from a project that is
 * not a reviewed location binds to the default location instead of failing.
 * A bundle without a reviewed default still fails closed. */
export function resolveNativeClaudeEnrollmentDirectory({directory,locations,projectMap}){
 const reviewed=value=>typeof value==='string'&&locations.some(row=>row.directory===value)&&projectMap.some(row=>row.targetDirectory===value);
 if(reviewed(directory))return directory;
 const fallback=locations[0]?.directory;
 if(!reviewed(fallback))throw fail('native_claude_enrollment_location_unreviewed');
 return fallback;
}
