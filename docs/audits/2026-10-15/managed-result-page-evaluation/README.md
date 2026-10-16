# Managed result page evaluation

This is a deterministic transport-volume result, **not a qualified latency
optimization or native release acceptance**. The controlled comparison did not
reach a 5% median latency improvement and did not make every pair faster. The v2
latency/CPU regression against scalar v1 remains visible.

The existing production owner/core/scheduler benchmark uses two retained 35 KiB
reports, 128 canonical references per task, the real disposable atomic ledger,
and the production bounded publication reader over cloned canonical pages.
Twenty worker samples per cohort cover five cold/warm v1/v2 pairs. Every worker
and parent verified source hashes before and after sampling. The controlled
cohorts differ only in `managed-result-projection.js`: the v2 page ceiling is
8 KiB in the baseline and 24 KiB in the candidate. All other measured source
hashes match. The comparison and full sanitized samples are retained here:

- [Controlled comparison](comparison.json)
- [8 KiB baseline](baseline-controlled-8k.json)
- [24 KiB candidate](candidate-controlled-24k.json)
- [Initial baseline, possible light-test overlap](baseline-initial-light-overlap.json)
- [Initial candidate observation](candidate-initial.json)

The initial baseline had no known heavy overlap, but another worker's roughly
1.3-second lightweight tests may have overlapped it. It is supplementary only.
The controlled baseline and final candidate held other test/build workers until
sampling finished. The shell session remained available; these are local process
observations and do not establish a universally quiet machine.

| Per v2 fixture | 8 KiB | 24 KiB |
| --- | ---: | ---: |
| Managed owner calls | 7 | 4 |
| Core RPCs | 10 | 7 |
| Publication reads / history pages | 28 | 19 |
| History bytes read | 2,048,844 | 1,418,037 |
| Fresh primary reads | 56 | 38 |
| Singular durable acknowledgements | 2 | 2 |
| Model output bytes | 92,500 | 90,153 |

These counts repeat across all corresponding controlled samples. Primary reads
remain two per publication read; fewer page invocations explain their reduction.
All reports and canonical references were reconstructed exactly, and each
singular acknowledgement retained its own durable commit. Four calls are this
fixture's result, not a two-call promise for arbitrary reports or metadata.

| Median | 8 KiB v2 | 24 KiB v2 | Scalar v1, final cohort |
| --- | ---: | ---: | ---: |
| Cold latency, ms | 43.182 | 41.076 | 30.346 |
| Warm latency, ms | 31.582 | 30.135 | 23.883 |
| Cold host CPU, ms | 41.108 | 40.132 | 26.723 |
| Warm host CPU, ms | 27.211 | 24.338 | 19.257 |

Cold/warm latency medians improve only 4.88%/4.58%. Five of ten paired v2 latency
observations were slower, including one warm pair about 27% slower. Sampled peak
RSS also does not establish a memory win. Full pair observations, queue/lock
timings, CPU and RSS remain in the JSON rather than being discarded as outliers.

V2's 24 KiB ceiling is still shrunk by the exact escaped minified JSON fitter,
including metadata, batch rows and framing. The full reply remains bounded by
`min(48 KiB, native byte limit - 2 KiB)`, with native defaults unchanged at
51,200 bytes / 2,000 lines. V1 keeps 8 KiB. Native collection chooses its limit
from the constructor-owned contract; a returned version flag cannot upgrade v1.
No synthetic `metadata.truncated` value was added. Fixed metadata refusal,
Unicode boundaries, retained references, publication and later-Step review remain
mandatory.

Publication payload caching is deferred. The constructor reader contract does
not carry an immutable canonical-history version receipt; completed output can
change while the primary revision stays the same. A new owning test proves that
repeated checks reread changed canonical output and refuse newly revoked
authority. Whole snapshots or authorization were not memoized. Existing
controller/primary/objective/generation/cancellation races and the selected
window in a 2,500-message session remain covered.

Focused source checks passed: 18 shared Bun tests and 132 web Vitest tests.
The subsequent native publication graph passed its separate source and compiled
cases (2/2, 33.28 seconds). Both reconstructed the actual canonical completed
`wait`/`read_result` outputs into the complete 35,840-byte escaped Unicode report.
The largest raw page was 24,576 bytes; the largest minified escaped reply was
27,367 bytes, below the 49,152-byte managed budget. The real native tool-output
policy supplied its own `truncated: false` receipt after enforcing its limits;
the DevRyan tool returned content only. The fixture did not inject that metadata.
Both cases refused same-Step disposition, requested pages dynamically from the
actual model input until cursor exhaustion, then committed `continue` in a later
Step. Publication checks use the production bounded canonical-message reader.
See [the sanitized native graph proof](native-publication-proof.json).

Three earlier graph attempts each failed both cases while adding these assertions:
the final page's absent cursor is `undefined`, native truncation metadata is a
native-owned `false` receipt, and a disposition response's fresh reference is not
a collected report page. The final assertions use those real API contracts;
report equality, byte caps and native nontruncation remain required. No production
code was changed in response to those fixture expectation errors.

Application resource/UI sampling, real database/HTTP page latency, providers,
descendant CPU/footprint and release qualification remain separate gates. The
historical benchmark JSON's native qualification field remains pending because
those samples preceded this graph extension. The graph pass does not satisfy
the failed latency acceptance thresholds or qualify a final frozen build.
