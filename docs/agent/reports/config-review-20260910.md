# Config-review pass — 2026-09-10

Unattended scheduled run. Scope: agent-facing config/docs, not app code.
Owned paths only (`AGENTS.md`, `docs/**`, `ops/`, `README.md`). Single-threaded;
no subagents. This pass resumed after a prior attempt died to a transient model
rate limit (~5 min in).

## Findings and outcomes

### 1. Docs drift on `deal_signals` — FIXED (#49, commit `2abe03f`)

**Finding (Strong).** `docs/agent/verification.md` "Dead tables" footgun
(formerly lines 77–80) said `deal_signals` and `product_matches` are "not
populated" and that deals are computed at runtime. `docs/agent/project-map.md`
line 23 (analytics row) said "`/api/deals` calls this per-request. Not
pre-materialized." Both described the pre-2026-09-06 world and contradicted:

- the owner-approved pre-materialization (DECISIONLOG 2026-09-06; landed
  handler switch `e58303b`, confirmed 2026-09-09),
- `src/sqlite/migrations/projection/001_initial.sql:146-168` (creates and
  populates `deal_signals` via `src/sqlite/deal-materialization.js`),
- `project-map.md`'s own Two-DB section (lines 62–67), making the file
  internally contradictory,
- the AGENTS.md hard rule ("pre-materialization is APPROVED and FULLY LANDED").

Also stale in the same bullet: `product_matches` is not merely "not populated"
— it is **removed** from the projection schema entirely (`001_initial.sql:144`
comment: "product_matches stays removed"; rg confirms zero DDL). Real harm: an
agent following verification.md would avoid or flag assertions against the
landed materialization tests.

**Fix (commit `2abe03f`).**
- `verification.md`: bullet rewritten — `deal_signals` is rebuild-populated,
  parity pinned by `test/sqlite/deal-materialization.test.js`, assert freely;
  `product_matches` is removed entirely (match truth =
  `app.db.product_match_pairs`).
- `project-map.md`: analytics row now states analytics is the single source of
  deal logic, materialized by the rebuild into `deal_signals`, served by
  `/api/deals` with no runtime analytics on the request path.

Claimed via issue comment before editing; fix cross-linked on
[#49](https://github.com/JavaGT/nz-grocery-prices/issues/49).

### 2. Managed-lane tooling documented but nonexistent — TICKETED (#51)

**Finding (Strong).** The user-global `~/.zcode/AGENTS.md` mandates
`pnpm lanes create/merge/close` and `pnpm gate:locked`. None exist:

- `pnpm lanes list` → `Command "lanes" not found` (pnpm 11.20.0 treats unknown
  commands as recursive exec); `pnpm gate:locked` → same.
- Not in `package.json` scripts (rg: no `lanes`/`gate:locked`), no `lanes`
  binary on PATH, no shell alias in `~/.zshrc`/`~/.zprofile`/`~/.zshenv`, no
  `pnpm-workspace.yaml`.
- Repo-wide rg for `pnpm lanes|gate:locked`: zero matches — the tooling is
  referenced **only** in the user-global AGENTS.md. The repo's own docs
  (workspace AGENTS.md, `docs/agent/*`) are clean, so there is nothing to fix
  on owned paths.

**Action.** [#51](https://github.com/JavaGT/nz-grocery-prices/issues/51) asks
the owner to pick: fix the user-global doc (remove/qualify the lanes section,
document the compliant fallback) or build the tooling. The user-global file is
explicitly out of repo-lane scope — implementation NOT the todo until the
direction is picked. Friction journaled in
`~/.config/opencode/pain-journals/nz-grocery-prices.md` (file seeded — it did
not exist; see finding 4).

### 3. Docs-vs-reality command audit — ALL GREEN (no action)

Every command, script, and test file documented in the agent docs exists:

- 14 npm scripts referenced by `command-map.md`/`verification.md`: all present.
- `npm run check` → exit 0. `npm run pack:check` → exit 0. `npm test` →
  **1041/1041 pass, 0 fail, ~3.1s** (docs say "~1,040 tests, ~3.5s" — accurate).
- `sh -n` clean on `scripts/archive-daily-local.sh`,
  `scripts/breadth-pilot-nightly.sh`, `ops/install-breadth-agent.sh`.
- All 21 test files/helpers referenced by `verification.md`'s targeted-verify
  table exist; all 7 targeted test dirs have tests (frontend 6, server 10,
  app 2, matching 6, adapters 7, sqlite 7, retailers 14).
- `verification.md` and `command-map.md` agree with each other (same suite
  counts, same seams, same footguns post-#49-fix).
- Live-API commands (`archive:local`, breadth:nightly) existence-checked only —
  never run, per the hard rule.

### 4. Pain journal missing for this repo — SEEDED, follow-up in #53

`~/.config/opencode/pain-journals/nz-grocery-prices.md` did not exist, while 6
sibling repos have journals. The directory exists, so the global instruction's
target was creatable — absence suggests repo agents never journal friction
rather than that they can't. Seeded with today's `pnpm lanes` friction line.
#53 asks whether adoption starts; if the file stays seed-only, evaluate whether
repo agents see the instruction.

### 5. Session friction scan — CLEAN (metadata only)

`opencode2 api get /api/session` (this project, recent window): 5 sessions —
4 coordinated review lanes on the same change (LIKE escaping / clock fixes,
verdicts on #47/#48 fixes — the designed hostile-review pattern, not churn)
plus one 0-token **failed** openrouter session (`meta/muse-spark-1.3-contributor`,
~300 ms to failure). That failure is the same transient-route class that killed
this lane's first attempt; no repeated rescues or re-asked questions found.
No repo-side fix available; #53 asks whether scheduled runs need a
fallback-model retry policy (evaluate-only).

## Tickets

| Issue | What | State |
|---|---|---|
| [#49](https://github.com/JavaGT/nz-grocery-prices/issues/49) | deal_signals docs drift | **fixed** in `2abe03f`, cross-linked, ready to close on review |
| [#51](https://github.com/JavaGT/nz-grocery-prices/issues/51) | user-global AGENTS.md documents nonexistent `pnpm lanes` tooling | open, owner decision (doc-fix vs build) |
| [#53](https://github.com/JavaGT/nz-grocery-prices/issues/53) | follow-up 2026-09-17: verify friction stopped (5 re-check items) | open |

## Changes applied

- `docs/agent/verification.md` — dead-tables bullet rewritten (#49).
- `docs/agent/project-map.md` — analytics ownership row rewritten (#49).
- `.gitignore` — `reports/` narrowed to `/reports/` (root-anchored). The
  un-anchored pattern matched any `reports/` dir at any depth, silently
  ignoring `docs/agent/reports/` — this report could only be committed with
  `git add -f` (the quick-scan lane hit the same wall and force-added its
  report at root `reports/`). Root-anchoring keeps the intended ignore (new
  run artifacts in root `reports/`) while making the agent-report path
  trackable normally. Tracked files under `reports/perf-trial/` are unaffected.
- `docs/agent/reports/config-review-20260910.md` — this report.
- (outside repo) `~/.config/opencode/pain-journals/nz-grocery-prices.md` — seeded.

## Commits

- `2abe03f` — docs: sync deal_signals docs to landed materialization (#49)
- (this commit) — config-review pass report + gitignore reports/ anchor fix (#49 #51 #53)

## Verification

`npm run check` exit 0 · `npm test` 1041 pass / 0 fail (~3.1s) ·
`npm run pack:check` exit 0 · `sh -n` clean on all three documented shell
scripts · every diff reviewed per-file before commit (only the four files
above touched; forbidden untracked `pnpm-lock.yaml` untouched).

## What I did not look at

- `src/`, `scripts/`, `test/`, `retailers/` app/code behavior (out of scope).
- `README.md` prose beyond command existence (it mirrors HANDOFF content).
- `ops/` plist contents beyond `sh -n` of the installer (HANDOFF says plutil
  lint already verified; no plist change was in scope).
- Live-API collectors (never run, per hard rule).
- Benchmarks (`npm run bench`, `bench:archive`) — existence-checked only; not
  needed for a docs-only change.
- Sessions in other projects (`scope` etc.) — friction scan limited to this repo.
- Whether `docs/apis/*` content is current (only existence of the index was
  implied via project-map; deeper API-doc currency review is a candidate for a
  future pass).
