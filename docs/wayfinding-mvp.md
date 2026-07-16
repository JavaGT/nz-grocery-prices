# Wayfinding decisions and MVP

## Product outcome

Help an everyday New Zealand shopper find groceries they care about at a price
they can trust, at stores they prefer, with enough history to judge whether a
deal is genuinely good value.

The archive is also a high-quality, provenance-preserving research asset, but
academic use does not drive the first interaction design.

## Intended first release

### Public

- Search for products by ordinary text; semantic meaning search is a later
  enhancement behind the same search interface.
- Open a product and compare its current offers across collected retailers and
  locations.
- Inspect price history, promotion context, and history-backed signals such as
  an all-time low or lowest price in four months.
- Explore the public "Best deals right now" homepage, using only collected,
  provenance-backed information.

### Signed in

- Select and rank preferred stores.
- Maintain one **watch list** containing products, categories, and saved
  searches.
- Use a personalised deal dashboard that prioritises watch-list items and
  selected stores while retaining clearly labelled alternatives.
- Discover newly observed retailer products, filtered by store, category, or a
  saved search.

## Explicitly deferred

Notifications; public reviews and notes; friends and follows; public/private
lists; want-to-try and tried states; voice reviews; ranking/tier lists; weekly
activations; public trends explorer; and purchase links. These remain valid
product directions, but do not block the price-intelligence MVP.

## Experience decisions

- **Homepage:** an image-led public "Best deals right now" view. It is broad,
  friendly, and social-ready, but does not require social data in MVP.
- **Dashboard:** a denser signed-in deal ledger for watch lists, saved searches,
  new products, and data-heavy comparison.
- Show retailer identity and the exact price context, for example "PAK'nSAVE ·
  Royal Oak store price" or "Woolworths · Glenfield pickup price".
- Show price history signals as compact, human-readable labels. Do not expose
  internal observation counts in the primary interface.
- Use shelf prices by default. A normalised unit-price view is a later setting.
- When product matches are not strong, retain them as alternatives with a clear
  match label rather than presenting them as identical products.

## Trust and archive rules

- The system MUST preserve retailer, store/price context, collection time,
  source identity, price kind, and promotion metadata for every displayed
  price.
- The system MUST NOT imply that physical-store, pickup/fulfilment, store-site,
  and national-online prices are interchangeable.
- The system MUST distinguish an advertised promotion from a history-backed
  bargain.
- The system MUST label an offer or deal feed stale when its latest collection
  is outside the configured freshness window or collection has failed.
- The system MUST NOT describe a listing as a cross-retailer product match
  without a GTIN, shared source identity, or an explicitly reviewed match.
- The system MUST show that history is insufficient when a product does not yet
  meet the configured baseline requirement; it MUST NOT fabricate a baseline.
- Collection failures MUST retain previous data and its collection time; they
  MUST NOT silently remove historical offers or make stale data appear current.

## Account and privacy boundary

Public visitors can browse all public price/search/history views. Sign-in is
required only for preferences and the private watch list in MVP. The first app
uses Workbench's built-in username/password login and server-side `sid` session
cookie; it deliberately has no email verification or password-recovery flow
until an email service exists. Social content is absent from MVP, so
private/friends/public publication controls are not yet implemented. When social
features are introduced, friends are mutual, following is one-way public
discovery, and blocks override all discovery.

## MVP acceptance scenarios

1. A visitor can search, open a product, and understand both its cheapest
   collected offer and the price context that produced it.
2. A product without sufficient history can still show its current price and
   advertised special, but cannot claim a history-backed deal.
3. A signed-in user can rank stores and add a product, category, or saved search
   to their watch list; their dashboard uses those choices.
4. An unavailable or stale collector result is visibly dated rather than
   silently treated as current.
5. A product with no collected offers, a single offer, and multiple offers each
   render deliberate states rather than an empty or broken comparison screen.
