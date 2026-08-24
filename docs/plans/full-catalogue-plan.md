# Full-catalogue collection plan ("every product, every store, every day")

Status: PROPOSED — evidence from live probes in `docs/research/` (2026-08-25).
Nothing here changes collection behavior until its tickets land.

## Verified feasibility per retailer

| Retailer | Stores | Catalogue/store | Mechanism (verified) | Req/day full |
|---|---|---|---|---|
| PAK'nSAVE + New World | 57 + 148 | 9.4k–13.9k | Algolia search, `stores:{id}` filter, category-facet drill-down (blind pagination caps at 1,000) | ~56k |
| FreshChoice | 76 | 3k–15k | sitemap → `/category/*?page=N` (existing parser fits) | ~25–35k |
| Woolworths | ~180 (est.) | ~18–22k unique SKUs | `target=browse` + `dasFilter=Department;…`; multi-store via anonymous `PUT /fulfilment/my/pickup-addresses` session rebind | ~155–185 pages/store |
| The Warehouse | national flat | 1,123 (grocery tree) | `search/updategrid?cgid=…` walks (Cloudflare-safe path) | ~36 |

Per-location pricing proven live for Foodstuffs (bananas 369¢/349¢ across two
PAK'nSAVEs), FreshChoice (was-prices differ), Woolworths (milk $7.19/$7.23
Glenfield vs Howick). Warehouse is national flat by nature.

## Volume model

Monitored points if everything, daily: ~2.5M (Foodstuffs) + ~530k (FreshChoice)
+ ~3.6M (Woolworths est. 180 stores) + 1.1k ≈ **6.6M price points**.

Storage rides on the archive's change-only rule: an offer revision is written
only when content differs from the revision effective at that time. So:

- **Baseline day (one-time):** ~6.6M offer revisions ≈ 4 GB JSONL
- **Steady state:** grocery churn ≈ 1–2%/day → ~60–130k records/day ≈
  **40–80 MB/day**, plus per-store catalogue snapshots
- Compaction (already built) bounds long-term growth

Runtime is the binding constraint, not storage: Foodstuffs ≈ 5–9 h at polite
pacing; Woolworths ≈ 8–10 min/store → 24–30 h sequential for ~180 stores.
Design consequence: a **continuous low-rate background crawler** (not a nightly
batch), with per-store scheduling spread across the week for Woolworths until
measured.

## Staged rollout (tracer bullets, each gated)

0. **BREADTH-0 shared crawl kit** — polite worker pool (per-host pacing,
   retry/backoff, resumable manifests, health-log integration). Blocks all.
1. **BREADTH-1 Foodstuffs breadth** — `searchProducts(extraFilters)` +
   facet-drill-down collector. Pilot: 2 stores daily × 1 week before estate.
2. **BREADTH-2 FreshChoice breadth** — sitemap-driven category walker.
   Pilot: Queenstown + Avondale.
3. **BREADTH-3 Warehouse breadth** — cgid walk, grocery tree, ≥3 s pacing.
4. **BREADTH-4 Woolworths breadth + multi-store** — client additions
   (`listProducts`, `switchStore`, `getStoreMeta`); pilot 3 stores; ToS-careful
   pacing; isolate as its own spike because session-rebinding is undocumented.
5. **BREADTH-5 projection/storage scale pass** — `snapshotScope: "catalogue"`
   semantics, compaction cadence, rebuild timing at 50M+ records, API query
   guards. Gates estate-wide rollout.
6. **BREADTH-6 orchestration** — replace single-run daily script with the
   multi-retailer crawl plan under the existing `<archive>.lock`; launchd
   registration; alerting off `collection-health.jsonl`.

Specials snapshots continue unchanged throughout — history continuity for
existing sales detection is never broken.
