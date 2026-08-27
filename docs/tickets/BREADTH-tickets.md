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

> **Status: IMPLEMENTATION VALIDATED — both banners (2026-08-27).**
> Kit (`a4436f5`), edge adapter (`ce04180`), edge collector (`09fc3a0`),
> manifest race fix (`c0c8e61`), review hardening (`f512c54`). Edge-API
> pilot hit a wall (iterations 1–3 below) → **PIVOT to the mobile app
> backend** (`docs/research/foodstuffs-mobile-api.md`, reverse-engineered
> OpenAPI): `MobileFoodstuffsClient` + `scripts/foodstuffs-mobile-breadth.js`
> (`6434f2d`; review fixes `c629b89`; store-list is GET `eb446e3`;
> per-request 20s timeout `a9a1a80`; client-side pacing, no crawler
> transport `6ef04d1`; online-active store filter `bd9e074`).
>
> **Live validation (both healthy, zero failures):**
> - PAK'nSAVE Kilbirnie: **11,061 unique products**, 984 requests,
>   22,120 records (~14 min at 5s pacing)
> - New World Albany: **13,703 unique products** (≥98.6% vs web facet
>   target 13,858), 1,032 requests, 27,407 records
>
> Next: nightly pilot gate (7 consecutive healthy days, growth within
> model ±30%) via `scripts/breadth-passes.sh` pattern; then BREADTH-5
> projection scale pass and BREADTH-6 orchestration before the 208-store
> estate rollout.

## Iteration history on the web/edge API (superseded by mobile pivot)

> **Day-1 finding:** 1s pacing tarpits the Foodstuffs API — after a burst
> of ~13 discovery requests the server hangs >15s per call (timeouts, not
> 429s); slower-spaced requests before/after succeeded. Run aborted at
> 298/11111 + 310/13858 coverage. Resume machinery worked as designed.
>
> **Iteration 2 (5s):** WORSE — only 2 requests/store succeeded before
> hard rejection. Found retries STACKED (adapter fetchWithRetry ×4 on top
> of crawler ×3 ≈ up to 16 attempts/task). Fixed in `2f12425`: breadth
> disables adapter-internal retries (crawler solely owns policy) and a
> circuit breaker aborts a store run after 5 consecutive failures with a
> ≥30-min-cooldown message. Also proven live: unchanged prices recorded
> ZERO duplicate records (content-hash dedup).
>
> **Iteration 3 (next day, 10s, single store):** identical 2-then-block
> pattern after a ~26h cooldown — kills cooldown/pacing/signature/session/
> cache theories. Bisect with live probes: bare client sequential =
> **14/14 OK in-process**; crawler+bridge topology same hour = 13/14 with
> one random 45s hang (Pantry). Conclusion: a persistent INTERMITTENT
> server-side hang (varies by hour; ~0% to ~100% of requests), independent
> of category, session, body, headers, and our code. Strategy: repeated
> resumable passes — breaker caps damage, manifest banks progress — until
> the catalogue completes; measure hang-rate by hour from pass logs.

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
