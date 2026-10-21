// Select registrations, never skip tests. Full local runs register every case.
export function testCaseShard(index, value) {
  if (value === undefined) return true;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) throw new Error('Invalid test case shard');
  return index % Number(match[2]) === Number(match[1]) - 1;
}
