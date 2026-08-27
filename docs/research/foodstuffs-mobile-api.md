# Foodstuffs MOBILE app backend — full-catalogue feasibility

**Date:** 2026-08-26 · Method: live probes against the Android-app API,
reverse-engineered spec at gist Arefu/b94ea1942c7fa898c2e473a75c5c67cf
(OpenAPI 3.0, app version 4.32.0).

## Why this backend

The web/edge Algolia API (`api-prod.paknsave.co.nz/v1/edge/search/…`)
intermittently tarpits whole time-windows — see BREADTH-tickets iterations
1–3: 0–100% of requests hang >15 s regardless of pacing (1–10 s), cooldowns
(26 h), session, body, headers, or client process. The daily SPECIALS
collector uses the *mobile* path (`/mobile/ecomm-products/{banner}/{storeId}/specials`)
reliably at scale and was never observed blocked.

## Backend & auth

- **Base:** `https://api-prod.prod.fsniwaikato.kiwi/prod`
- **Guest login:** `POST /mobile/user/login/guest` body `{"banner":"PNS"}`
  (enum PNS | MNW) → `{access_token, refresh_token, expires_in}`
- **User-Agent:** `PAKnSAVEApp/4.32.0 (App Version)` (spec requires this form
  for refresh; used throughout probes)
- All requests: `Authorization: Bearer <token>`

## Verified endpoints (all measured 2026-08-26)

| Endpoint | Notes |
|---|---|
| `GET /mobile/v1/products/category?storeId&banner=paknsave&region=NI` | Full nested category tree: **787 nodes** (name/code/children). Top level matches web facets. |
| `POST /mobile/store/physical?banner=PNS` | All **60 PNS stores** in one call. |
| `POST /mobile/ecomm-products/PNS/{storeId}/category?cat0=<Name>&sortOrder=Popularity&page=0` | **Full catalogue browse.** 200 OK, ~120–340 ms, 117 KB/page. |

Key parameters learned from live 400 messages:

- `sortOrder`: `Popularity` validated (web-style `POPULARITY_ASC` rejected).
- Banner path segment on this host is the enum `PNS` (not `paknsave`;
  `paknsave` → `Unknown Banner : paknsave`).
- Category params are NAME-based (`cat0`, `cat1`, `cat2`), combinable;
  `cat1` drill-down verified: Pantry ∩ "Chips, Nuts & Snacks" → 482 hits /
  5 pages.
- Response shape IDENTICAL to the specials endpoint the repo already parses:
  `{tobaccoFiltered, totalHits, hitsPerPage, numberOfPages, page, products[]}`
  with `products[]` carrying productId, brand, name, units, categories[],
  price (cents), unitPrice, productImageUrls — i.e. the existing
  Foodstuffs observation mapping applies nearly verbatim.
- Pagination clamp: totalHits caps at 1,000 per query (page 9 of Pantry =
  100 products; page 10 → `totalHits: 0, numberOfPages: 0` — clean empty,
  no error). Escape hatch = cat1/cat2 name drill-down, same as planned for
  the edge API, but here the tree (with codes) comes from one endpoint.
- `hitsPerPage` defaults to 100 (vs 50 on web edge) — half the requests.

## Cost model (per store, full catalogue)

~11k products ≈ 110 pages @100/page + ~30 tree/drill requests ≈ **140
requests ≈ 16 MB per store**. Estate of 60 PNS ≈ 8.4k requests ≈ 1 GB.
At the observed ~150–350 ms and polite 3–5 s spacing: **~12–25 min/store**.

## Open questions (next probes)

- ~~Whether prices differ per store for identical productId~~ **RESOLVED
  2026-08-27:** Kilbirnie (NI) vs Dunedin (SI) Pantry page — 20 shared SKUs,
  **14 priced differently** (UHT milk 209¢ vs 235¢). storeId scoping
  confirmed; closes the reviewer prerequisite before estate rollout.
- New World via `banner=MNW` / path segment `MNW` + its 148 stores.
- Full `sortOrder` enum (only `Popularity` verified).
- Long-run rate tolerance of THIS host (single evening probe set only; the
  specials path has months of evidence it is block-free).

## Recommendation

Pivot BREADTH-1 to this backend: new small `MobileFoodstuffsClient`
(guest-login, category-tree, category-pages, store-list), reuse the crawler
kit for pacing/resume, reuse the specials product→observation mapping.
Keep the edge-API collector as fallback for healthy windows.
