# Offline diagnostics replay

Use this tool on a diagnostics export supplied by its owner. It reads local files only and does not upload observations. GPS fixes contain sensitive location history, so keep the export and generated report in a private workspace.

```sh
node scripts/replay-diagnostics.mjs --input recording.json > replay.json
node scripts/replay-diagnostics.mjs --input recording.json --html replay.html > replay.json
```

The runner uses `dist/data/roads.json` and `dist/data/local-roads.json` by default. To replay against archived data, pass `--roads archived-roads.json --local-roads archived-local-roads.json`. The manifest's `roadDataVersion` must equal SHA-256 of the exact roads JSON bytes followed by the exact local roads JSON bytes. A mismatch stops replay. `--allow-data-mismatch` permits exploratory analysis and marks the report `exploratoryDataMismatch: true`; timing and road differences in that mode may reflect changed map data.

Portable exports contain a schema 1 manifest and ordered base64 gzip NDJSON chunks. The runner validates manifest limits, chunk sizes, SHA-256 checksums, gzip expansion, event counts, and increasing sequence numbers before replay. It also reads the older local `{appVersion,buildId,events}` JSON export. Input is capped at 15 MiB, each road-data file at 64 MiB; the manifest caps compressed diagnostics at 10 MiB and expanded diagnostics at 50 MiB.

Replay runs the existing `Tracker` with a controlled clock from each event's `recordedAt`. Raw fix events call `update` once; following state events compare the recorded output to the replayed state without applying the fix again. Signal events call `invalidate`, and session start, stop, or reset events call `reset`. Error and visibility events do not mutate the tracker. The JSON report includes road changes, GPS gaps, session resets, recorded versus replayed state mismatches, and numeric delta differences. When recording began mid-session, timing comparisons are marked unavailable until reset or a new entry; road and display comparisons remain useful. The optional HTML shows raw observed GPS points, reference road geometry, and inferred road and timing rows separately. It uses no map API. Replays depend on the matching engine version as well as matching road data; compare the manifest's app and build IDs with the checkout when interpreting differences.

Run the replay tests with `node scripts/replay-diagnostics.test.mjs`.
