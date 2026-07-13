# Grocery price archive context

## Ubiquitous language

- **Product**: retailer-identifiable grocery item metadata, shared independently of a price. A `Product Revision` is a distinct SHA-256-hashed version of that metadata (for example, a renamed product or changed image).
- **Store**: the physical or online price scope at which an offer is collected. A `Store Revision` preserves changes to that identity/scope.
- **Offer**: one product's price and promotion at one store. Its identity is `productId + storeId`; a new offer revision is written only when its price, promotion, or source changes.
- **Special listing snapshot**: a compact daily statement of the offers currently returned by an advertised-specials collection for one store. It records only added and removed offer IDs and is the authority for whether an offer is still ongoing.
- **Observation**: the read-model projection of product, store, and offer revisions used by sale analytics. It retains the original offer-change time and, when known, the latest special-listing confirmation time.
