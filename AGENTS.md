# Agent Instructions — `nz-grocery-prices`

NZ grocery price archive + SQLite-backed price·minder app. ESM Node, zero
dependencies, `node:test`. **Node 26.3.1+** for the app server / SQLite; Node
20+ for collectors and the legacy dashboard.

## Start here

1. Read this file.
2. Read `docs/agent/project-map.md` — structure and ownership boundaries.
3. Read `docs/agent/command-map.md` — install/build/test/run commands.
4. Read `docs/agent/verification.md` — required checks and test seams.
5. Skim `HANDOFF.md` for current state and gotchas.
6. For architecture decisions, read `DECISIONLOG.md`.

## Default workflow

1. **Inspect** relevant files and their adjacent tests before editing.
2. **Reuse** existing canonical helpers, fixtures, adapters, and patterns.
3. **Smallest coherent change** in the layer that owns the concept (see
   `project-map.md` ownership table). Don't patch the wrong layer.
4. **Add or update focused tests** for meaningful behavior, failure modes, and
   data transforms. Use the seams in `verification.md`.
5. **Verify**: run `npm run check` first, then the targeted test for the layer,
   then `npm test` before handoff.
6. **Maintain**: if you changed commands, structure, ownership, env vars, or
   verification paths, update the relevant `docs/agent/*` file in the same
   change (see `docs/agent/maintenance.md`).

## Hard rules (load-bearing — violating these is a bug)

- **Two-DB separation.** `data/prices.db` (projection, rebuildable, no user
  data) and `data/app.db` (persistent user data, never rebuilt) are separate.
  A rebuild script that opens `app.db` is a critical bug.
- **Never confirm fuzzy matches.** Fuzzy candidates are `review_state:
  'candidate'`, returned separately. Only `auto_gtin`, `auto_source_id`, and
  `human_reviewed` are confirmed. Don't relax this.
- **Async scrypt only.** Password hashing uses `crypto.scrypt` (async), never
  `scryptSync` — the sync variant blocks the event loop on request paths.
- **`collector.env` is gitignored and may contain `WOOLWORTHS_COOKIE` (a
  secret).** Never commit it. Never put secrets in the plist or logs.
- **`npm run archive:local` and `npm run <retailer>` are NOT tests.** They hit
  live retailer APIs and mutate `data/prices.jsonl`. Never run them to verify a
  change.
- **No FTS5.** Search uses `LIKE` + `COLLATE NOCASE` on `products.name`. Don't
  assume FTS5 exists.
- **Dead tables.** Projection DB `deal_signals` and `product_matches` are not
  populated. Deals = runtime `src/analytics.js`; match truth =
  `app.db.product_match_pairs`.
- **Warehouse adapter uses `curl` via `execFile`** (anti-bot TLS fingerprint),
  never shell strings. Don't switch to shell-string execution.

## Design rules

- Keep orchestration (`src/app/server.js`) separate from business rules
  (`src/analytics.js`, `src/matching/`).
- Keep side effects behind seams (injectable `fetch`, `clock`, `getDb` closure).
- Optional fields must be genuinely optional.
- Dependencies are passed by closure/parameter, not globals.
- Split files that become hard to scan; filenames act as context pointers.

## Handoff requirements

End every task with:
- changed files
- behavior changed
- verification run (`npm run check` + `npm test`), with output summary
- risks or assumptions
- `docs/agent/*` updated, or why none were needed

## Lessons learned

(Capture codebase-specific lessons here as dated atomic bullets. Global
behavior lessons go in `~/.config/opencode/rules/lessons.md`.)
