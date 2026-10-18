# Text-only image context comparison

Run alone after builds and tests finish, using a fresh, source-consistent native
artifact inside the repository:

```sh
node scripts/perf/image-context-comparison.mjs \
  --artifact-root .cache/v2-validation/<fresh-artifact> \
  --files 6000 --pairs 3 --keep-artifacts
```

The baseline is `native-image-runtime.js` from Git `HEAD`; the candidate is the
working file. Both use the same verified compiled image writer and execution
launcher, the real execution host, supervisor, mutation ledger and private view.
Only canonical context and authorization are constructor-owned fixture data.
There is no provider request or installed app access.

The command above creates one synthetic tree of 6,000 files, each 4,096 bytes
(24,576,000 bytes total). Both arms use identical text-only context and that same
tree, with a fresh ledger for every arm. Three pairs alternate baseline/candidate,
candidate/baseline, baseline/candidate. The runner checks identical outputs and
unchanged file inventory and content after each arm.

`elapsedMs` is **synthetic cold-ledger context-transform duration**. It includes
baseline reconciliation, ledger initialization, preparation, actual worker
execution and publication. `viewFilesMs` separately measures the real
`view_files` phase. Neither measures provider/model latency, token savings, or
the reported user's end-to-end delay. Millisecond results describe this machine
and fixture; they are not a release speed threshold.

The ten-minute deadline cancels through the existing execution owners and waits
for their cleanup. Heavy fixture files and ledgers are removed even when
`--keep-artifacts` retains the bounded report and run manifest. Without that
flag, the OS-temp run directory is removed. Failed arms keep bounded phase
diagnostics in the report when retention is requested.
