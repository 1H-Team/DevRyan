import { validateRequiredChecks } from './required-checks.js';

export function validateTaskPrerequisites(value = []) {
  if (!Array.isArray(value) || value.length > 8) throw new TypeError('Invalid task prerequisites');
  const keys = new Set();
  for (const ref of value) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)
      || Object.keys(ref).sort().join() !== 'checkName,contentHash,paths,taskId'
      || typeof ref.taskId !== 'string' || !/^dvr_task_[a-zA-Z0-9_-]{1,247}$/.test(ref.taskId)
      || typeof ref.checkName !== 'string' || !ref.checkName.trim() || ref.checkName.length > 128
      || typeof ref.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(ref.contentHash)) throw new TypeError('Invalid task prerequisite reference');
    validateRequiredChecks([{ name: ref.checkName, command: 'interface', paths: ref.paths }]);
    const key = `${ref.taskId}\0${ref.checkName}`;
    if (keys.has(key)) throw new TypeError('Duplicate task prerequisite');
    keys.add(key);
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 32 * 1024) throw new RangeError('Task prerequisites exceed 32 KiB');
  return value;
}
