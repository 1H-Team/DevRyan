/** Compare the submitted bytes with one current Git-produced hunk. Matching
 * Git's headers as well as the hunk prevents path, mode and multi-file injection. */
export function currentHunkPatch(current, submitted) {
  const invalid = () => Object.assign(new Error('Hunk changed or is unsupported. Refresh and try again.'), {
    code: 'GIT_HUNK_STALE', statusCode: 409,
  });
  if (typeof submitted !== 'string' || Buffer.byteLength(submitted) > 4 * 1024 * 1024
    || (submitted.match(/^diff --git /gm) ?? []).length !== 1
    || (submitted.match(/^@@ /gm) ?? []).length !== 1
    || /^(?:old mode|new mode|new file mode|deleted file mode|rename from|rename to|copy from|copy to|GIT binary patch|Binary files)/m.test(current)) throw invalid();
  const first = current.search(/^@@ /m);
  if (first < 0) throw invalid();
  const header = current.slice(0, first), bodies = current.slice(first).split(/(?=^@@ )/m);
  const canonical = bodies.map((body) => header + (body.endsWith('\n') ? body : `${body}\n`));
  if (!canonical.includes(submitted)) throw invalid();
  return submitted;
}
