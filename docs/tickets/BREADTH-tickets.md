# BREADTH-0 — Shared polite crawl kit

Parent plan: `docs/plans/full-catalogue-plan.md`. Blocks BREADTH-1..4.

## Goal
One reusable crawler core so every retailer breadth collector shares pacing,
retries, resume, and observability — no per-retailer copies.

## Approach
`scripts/lib/crawler.js` (zero-dep, node:test): per-host token-bucket pacing
(default ≥1s, configurable), retry with exponential backoff honoring
Retry-After, resumable manifest (JSON checkpoint per store: pages done, ETag),
structured progress events → `data/collection-health.jsonl`, hard per-run
request budget. Injectable fetch for tests. Warehouse lane must route via
`execFile curl` (TLS fingerprint rule).

## Gate
Unit tests with fake fetch: pacing honored, resume after simulated crash,
budget stops cleanly. No live requests in CI.

# BREADTH-1 — Foodstuffs full catalogue

Blocked by BREADTH-0. Pilot-gated before estate rollout.

> **Status: PILOT RUNNING (2026-08-25).** Kit (`a4436f5`), adapter
> (`ce04180`), collector (`09fc3a0`), manifest race fix (`c0c8e61`), and
> review hardening (`f512c54`) landed — suite 667/667. Hostile review
> (Luna): no blocker; all five concerns fixed pre-pilot. Pilot: 2 stores →
> `data/breadth-pilot.jsonl`, gate = 7 days of reconciliation within 0.5%,
> zero rate-limit responses, growth within ±30% of model.
>
> **Day-1 finding:** 1s pacing tarpits the Foodstuffs API — after a burst
> of ~13 discovery requests the server hangs >15s per call (timeouts, not
> 429s); slower-spaced requests before/after succeeded. Run aborted at
> 298/11111 + 310/13858 coverage. Resume machinery worked as designed.
> Iteration 2: --delay-ms 5000.

## Goal
Every product at every PAK'nSAVE/New World store daily (~2.5M points).

## Approach
Add optional `extraFilters` to `FoodstuffsClient.searchProducts` (tiny change,
probes proved need). Collector: unfiltered page-0 → facet counts → recursive
`category0NI`/`category1NI` drill-down where count > 900 → dedup productId →
reconcile against `tobacco:false` total; reuse existing observation mapping.
Snapshot scope stays "specials"; breadth writes offer revisions only.

## Pilot gate
2 stores (one PNS, one NW) daily × 7 days: unique-count reconciliation within
0.5%, zero rate-limit responses, archive growth matches model ±30%.

# BREADTH-2 — FreshChoice full catalogue

Blocked by BREADTH-0. Pilot: Queenstown + Avondale.

## Goal
Full catalogue across all 76 storefronts (~530k points).

## Approach
Per store: fetch sitemap.xml → walk `/category/*?page=N` (terminate on zero
ProductCards; parser already handles markup) → map via existing
`toFreshChoiceObservation`. Skip `/lines` direct URLs (no listing page).

# BREADTH-3 — The Warehouse grocery catalogue

Blocked by BREADTH-0.

## Goal
Grocery tree (1,123 products) nationally; flat pricing = one crawl.

## Approach
`search/updategrid?cgid=…` walks only (Cloudflare 403s `q=` search — verified);
via execFile curl; ≥3s pacing; 32-tile server cap → offset stepping + dedupe;
terminate on 0-tile page.

# BREADTH-4 — Woolworths breadth + multi-store (spike)

Blocked by BREADTH-0. ISOLATED SPIKE: undocumented session-rebinding.

## Goal
~18–22k SKUs per Woolworths store; multi-store via anonymous rebind.

## Approach
Extend client: `listProducts({target:'browse', dasFilter, sort, page, size})`,
`switchStore(addressId)` (PUT /api/v1/fulfilment/my/pickup-addresses),
`getStoreMeta(id)` (GET /api/v1/fulfilment/stores/{id}). Department-facet walk
(every department « 10k query cap). Pilot 3 stores × 7 days at ≥2–3s pacing,
honest UA, Akamai-aware backoff; measure ban signals before estate rollout.
Documented ToS-care position in DECISIONLOG before estate run.

# BREADTH-5 — Projection & storage scale pass

Blocked by BREADTH-1..4 pilots; gates estate rollout.

## Goal
App stays fast when offers grow from 9k to millions of records/day.

## Approach
Measure rebuild + query at synthetic 50M-record archive; set compaction cadence
(weekly?), index tuning if needed, API pagination guards, archive backup
strategy resize (baseline day ≈ 4 GB JSONL). Two-DB rule untouched.

# BREADTH-6 — Orchestration rollout

Blocked by BREADTH-5.

## Goal
"Every product every store every day" runs itself.

## Approach
Replace single-shot daily script with per-retailer crawl plans sharing
`<archive>.lock`; continuous low-rate scheduling (Woolworths staggered across
week until measured); launchd registration via updated wizard; alerting from
collection-health failures; docs/agent updates.
