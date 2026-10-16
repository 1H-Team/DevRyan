# Bounded GET-only release history diagnostic

The existing `scripts/release-ci.mjs` entrypoint ran with
`RELEASE_OPERATION=history-read`, `RELEASE_DRY_RUN=true`, the canonical repository,
and source `8dd32145509b08134c3a47248dd365cc6d84119e` (package version `2.0.12`).
The implementation was an uncommitted working-tree cohort; the source SHA is the
intended historical identity, not a claim that HEAD contains these repairs.

The diagnostic used the saved gh owner through GET-only requests without reading
credentials, writing tags/releases/assets, or downloading app payloads. It was
capped at 120 JSON API/artifact reads. The retained
[classification](history-classification.json) stopped **incomplete** after 28
requests, at the exact-source `package.json` endpoint recorded in `stoppedAt`.
An earlier superseded invocation also stopped incomplete, after seven requests.
The errors did not match a trusted assertion reason; raw CLI output was not
retained. This is an unavailable-evidence result, not a completed history scan.

No gate tally completed. The zero in `unexplainedGateFailures` is only an initial
counter and does not establish zero historical failures. Neither this diagnostic
nor deterministic test passes qualify release admission or hosted GUI behavior.

Later source revisions add explicit `failureTallyComplete` and bounded HTTP-status
reporting to the same diagnostic. Those additional fields were not observed in
this retained invocation. No identity fallback or admission bypass was added.

The finishing revision repeated the GET-only diagnostic twice with the new
explicit incomplete-tally fields. The [retained results](finishing-history-classification.json)
stopped after 8 and 31 requests at different source metadata reads. Independent
bounded readbacks subsequently resolved both endpoints (versions 2.0.12 and
2.0.8). These later reads do not complete the rolling history or establish why
the earlier reads failed. Release admission remains unqualified. The local
2.0.13 metadata is not represented by the referenced committed 2.0.12 HEAD.

An independent final GET-only invocation of the unchanged `history-read`
entrypoint also stopped **incomplete**. Its
[retained classification](independent-history-classification.json) records 11 of
120 permitted requests, exit status 1, and the unavailable source-metadata
endpoint `/contents/package.json?ref=aa5da4d80c86f6a1a1c9a6e992c40114043ef039`.
No HTTP status or trusted assertion reason was reported; the cause remains
unestablished. `failureTallyComplete` is false and no runs were tallied, so its
initial zero failure counter provides no failure-count evidence. This invocation
used the same HEAD identity and local 2.0.13 metadata noted above, with no current
workflow run excluded. It performed no release/tag/asset writes and made no
identity fallback or source change. Release-history completion and release
admission remain unqualified.

One subsequent isolated GET to that exact stopped endpoint succeeded through the
same authenticated gh transport in 873 ms and returned version 2.0.10. The small
[endpoint readback](independent-endpoint-readback.json) establishes current source
metadata availability, not the cause of the earlier failure. That isolated read
did not retry the whole history. The existing diagnostic retains HTTP status only when an
error's stderr contains `HTTP NNN`; timeout/abort, transport, JSON parsing, and
other evidence errors otherwise collapse to the same unavailable-evidence code.
The earlier error's discarded fields cannot be reconstructed from its retained
classification. No admission or retry behavior was changed.

A later authorized repeat ran the unchanged `history-read` entrypoint once on
2026-10-15. Its [separate classification](independent-repeat-history-classification.json)
stopped **incomplete** after 13 of 120 permitted requests, with exit status 1,
at `/contents/package.json?ref=00f47cafc5163b924aaf36fea8cfa53b62d2f5c7`.
The source identity, local 2.0.13 metadata, and absence of an excluded current
workflow run match the independent 11-request invocation. No HTTP status or
trusted assertion reason was retained. No gate tally completed:
`failureTallyComplete` is false and `runs` is empty, so the initial zero failure
counter still provides no historical failure-count evidence.

This repeat used the existing authenticated gh transport and GET-only 120-request
owner, including permission for its bounded qualification-receipt ZIP reads;
the owner removes temporary receipt archives after parsing. App/runtime asset
downloads and release/tag/workflow writes were excluded. No script, admission
rule, source identity fallback, or retry policy was changed. This result neither
explains the earlier failures nor qualifies release-history completion or release
admission. No additional endpoint probe or second history repeat was performed.

On 2026-10-16, a read-only review found no demonstrated source-state or diagnostic
change that would justify repeating the same full history calls. HEAD remains
`8dd32145509b08134c3a47248dd365cc6d84119e`; the diagnostic still collapses unknown
transport/parse/evidence failures as described above. No fresh history scan ran.
The previously used bounded command is:

```sh
RELEASE_OPERATION=history-read RELEASE_DRY_RUN=true \
GITHUB_REPOSITORY=1H-Team/DevRyan GITHUB_REPOSITORY_OWNER=1H-Team \
GITHUB_SHA=8dd32145509b08134c3a47248dd365cc6d84119e GITHUB_RUN_ID= \
RELEASE_ARTIFACT_DIR=.cache/sessions/2026-10-15-consensus-finishing/history-independent-repeat \
node scripts/release-ci.mjs
```

A separate [2.0.13 availability check](version-2.0.13-availability-2026-10-16.json)
used three bounded canonical GET requests at 2026-10-16T00:27:30.852Z. The exact
tag and direct release routes both returned known HTTP 404; the complete release
inventory succeeded with CLI exit 0 and no matching published or draft release visible
to the authenticated owner. The proposed version was available in that observed
tag/release state; this is time-specific evidence to recheck before a write.
These known statuses do not classify the earlier history failures. Availability
does not complete the ten-version history, establish a failure tally, bind the
uncommitted 2.0.13 metadata to a frozen source, or qualify hosted candidate/GUI,
platform, signing, or final release admission. No tags, drafts, uploads, workflow
dispatches, promotions, auth changes, or payload downloads were made.
