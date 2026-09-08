# Evidence scripts — ingest lane, perf-trial 2026-09-09

One-shot parity / A-B scripts used to produce the numbers in
`../REPORT-ingest.md`. They read archive copies from `/tmp/ingest-perf/`
and compare against a baseline tree extracted from the trial's base commit:

```sh
mkdir -p /tmp/ingest-perf && cd /tmp/ingest-perf
cp /path/to/data/prices.jsonl /path/to/data/breadth-pilot.jsonl /tmp/ingest-perf/
git -C /path/to/worktree archive deb5e9f src scripts/compact-archive.js | tar -x -C /tmp/ingest-perf/baseline
```

- `parity-fp.mjs` — fingerprint digest parity (real payloads + edge cases)
- `compact-parity.mjs` — compact output bytes, baseline vs current
- `append-parity.mjs` — append output bytes, single + chunked batches
- `query-parity.mjs` — query/stats/productHistory output digests
- `ab-bench.mjs`, `ab-compact.mjs` — in-process A/B timings (edit the
  `jsonl` paths inside for the other archive)
