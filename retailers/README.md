# NZ retailer scraper campaign — 100 retailers

Goal: price & product scrapers for 50 major New Zealand retailers, each in
its own subfolder (`retailers/<slug>/`), built on the retailer's own
web/mobile APIs, emitting the repo's canonical `PriceObservation` records.

**Status vocabulary**

- *existing* — predates the campaign, lives in `src/adapters/` + `scripts/`
- *implemented* — adapter in `retailers/<slug>/`, live-verified (see its README)
- *planned* — locked target for the campaign's 50
- *backup* — swap-in candidate if a planned retailer proves inaccessible
- *blocked* — probed and inaccessible (evidence in the table)

The 5 pre-existing adapters count toward the 50 (they cover woolworths,
paknsave, newworld, freshchoice, warehouse with full collectors already wired
into the nightly breadth pipeline).

## The 50

| # | Retailer | Slug | Category | Platform / API | Status |
|---|---|---|---|---|---|
| 1 | Woolworths NZ | `woolworths` | grocery | web API + cookie session | existing — `src/adapters/woolworths.js` |
| 2 | PAK'nSAVE | `paknsave` | grocery | Foodstuffs mobile API | existing — `src/adapters/foodstuffs.js` |
| 3 | New World | `newworld` | grocery | Foodstuffs mobile API | existing — `src/adapters/foodstuffs.js` |
| 4 | FreshChoice | `freshchoice` | grocery | storefront JSON API | existing — `src/adapters/freshchoice.js` |
| 5 | The Warehouse | `warehouse` | dept store | SFCC `updategrid` (curl transport) | existing — `src/adapters/warehouse.js` |
| 6 | HealthPost | `healthpost` | pharmacy/health | Shopify products.json | implemented 2026-09-06 |
| 7 | GoodFor | `goodfor` | wholefoods | Shopify products.json | implemented 2026-09-06 |
| 8 | Huckleberry | `huckleberry` | organic grocery | Shopify products.json | implemented 2026-09-06 |
| 9 | Bargain Chemist | `bargain-chemist` | pharmacy | Shopify products.json | implemented 2026-09-06 |
| 10 | Health 2000 | `health2000` | natural health | Shopify products.json | implemented 2026-09-06 |
| 11 | Net Pharmacy | `net-pharmacy` | pharmacy | Shopify products.json | implemented 2026-09-06 |
| 12 | Unichem | `unichem` | pharmacy | Shopify products.json | implemented 2026-09-06 |
| 13 | JB Hi-Fi NZ | `jb-hifi` | electronics | Shopify products.json | implemented 2026-09-06 |
| 14 | Life Pharmacy | `life-pharmacy` | pharmacy | Shopify products.json | implemented 2026-09-06 |
| 15 | Smiths City | `smiths-city` | appliances | Shopify products.json | implemented 2026-09-06 |
| 16 | Playtech | `playtech` | PC hardware | Shopify products.json | implemented 2026-09-06 |
| 17 | Bed Bath & Beyond | `bed-bath-beyond` | homeware | Shopify products.json | implemented 2026-09-06 |
| 18 | Computer Lounge | `computer-lounge` | PC hardware | Shopify products.json | implemented 2026-09-06 |
| 19 | Kathmandu | `kathmandu` | outdoor | Shopify products.json | implemented 2026-09-06 |
| 20 | Shoe Clinic | `shoe-clinic` | footwear | Shopify products.json | implemented 2026-09-06 |
| 21 | Babycity | `babycity` | baby | Odoo SSR grids (cookie session) | implemented 2026-09-06 |
| 22 | Shosha | `shosha` | Asian grocery | Shopify products.json | implemented 2026-09-06 |
| 23 | Moore Wilson's | `moore-wilsons` | grocery (Wellington) | Hydrogen SSR PDPs + sitemap | implemented 2026-09-06 |
| 24 | Commonsense Organics | `commonsense-organics` | organic grocery | SilverStripe sitemap + JSON-LD PDPs | implemented 2026-09-06 |
| 25 | Hammer Hardware | `hammer-hardware` | hardware | Shopify products.json | implemented 2026-09-06 |
| 26 | Liquorland | `liquorland` | liquor | window.category JSON (?p=N) | implemented 2026-09-06 |
| 27 | The Bottle-O | `the-bottle-o` | liquor | Rails SSR talker tiles | implemented 2026-09-06 |
| 28 | Super Liquor | `super-liquor` | liquor | Algolia index (Id-sliced walk) | implemented 2026-09-06 |
| 29 | Citta Design | `citta-design` | homeware | Shopify products.json | implemented 2026-09-06 |
| 30 | The Body Shop NZ | `the-body-shop-nz` | beauty | Shopify products.json | implemented 2026-09-06 |
| 31 | Icebreaker | `icebreaker` | merino apparel | Shopify products.json | implemented 2026-09-06 |
| 32 | PB Tech | `pbtech` | electronics | SSR tiles (page-1 per category) | implemented 2026-09-06 |
| 33 | Noel Leeming | `noel-leeming` | electronics | SFCC updategrid (curl transport) | implemented 2026-09-06 |
| 34 | Harvey Norman NZ | `harvey-norman` | electronics | CS-Cart SSR tiles | implemented 2026-09-06 |
| 35 | Mitre 10 | `mitre-10` | hardware | SAP Commerce OCC + sitemap shards | implemented 2026-09-06 |
| 36 | Bunnings NZ | `bunnings` | hardware | Next.js __NEXT_DATA__ (Coveo results) | implemented 2026-09-06 |
| 37 | Briscoes | `briscoes` | homeware | Magento GraphQL (shared w/ Rebel) | implemented 2026-09-06 |
| 38 | Rebel Sport | `rebel-sport` | sports | Magento GraphQL (Store: rebelsport) | implemented 2026-09-06 |
| 39 | Hunting & Fishing | `hunting-fishing` | outdoor | Magento HTML grids (GraphQL dead) | implemented 2026-09-06 |
| 40 | Macpac | `macpac` | outdoor | SFCC HTML grids (offset paging) | implemented 2026-09-06 |
| 41 | Supercheap Auto NZ | `supercheap-auto` | auto parts | SFCC HTML grids (offset paging) | implemented 2026-09-06 |
| 42 | Glassons | `glassons` | apparel | Black Pepper window.category JSON | implemented 2026-09-06 |
| 43 | Animates | `animates` | pet supplies | Magento HTML grids | implemented 2026-09-06 |
| 44 | Postie | `postie` | apparel | Black Pepper window.category JSON | implemented 2026-09-06 |
| 45 | Karen Walker | `karen-walker` | fashion | Shopify products.json | implemented 2026-09-06 |
| 46 | Paper Plus | `paper-plus` | books/stationery | ASP.NET SSR tiles (tracking attrs) | implemented 2026-09-06 |
| 47 | Whitcoulls | `whitcoulls` | books/stationery | eStar window.category JSON | implemented 2026-09-06 |
| 48 | OfficeMax NZ | `officemax` | office supplies | sitemap + JSON-LD PDPs | implemented 2026-09-06 |
| 49 | Baby Factory | `baby-factory` | baby | eStar window.category JSON | implemented 2026-09-06 |
| 50 | Petdirect | `pet-direct` | pet supplies | BigCommerce Stencil HTML cards | implemented 2026-09-06 |
| 53 | Ruby | `ruby` | fashion | Shopify products.json | implemented 2026-09-06 |
| 54 | Commoners | `commoners` | fashion | Shopify products.json | implemented 2026-09-06 |
| 55 | Kate Sylvester | `kate-sylvester` | fashion | Shopify products.json | implemented 2026-09-06 |
| 56 | Mocka | `mocka` | kids furniture | Shopify products.json | implemented 2026-09-06 |
| 57 | Twenty Seven Names | `twenty-seven-names` | fashion | Shopify products.json | implemented 2026-09-06 |
| 58 | Sabato | `sabato` | gourmet grocery | Shopify products.json | implemented 2026-09-06 |
| 59 | Merchant 1948 | `merchant-1948` | footwear | Shopify products.json | implemented 2026-09-06 |
| 60 | Beds R Us | `beds-r-us` | bedding | Shopify products.json | implemented 2026-09-06 |
| 61 | Huffer | `huffer` | streetwear | Shopify products.json | implemented 2026-09-06 |
| 62 | The Fabric Store | `the-fabric-store` | fabric | Shopify products.json | implemented 2026-09-06 |
| 63 | Stolen Girlfriends Club | `stolen-girlfriends-club` | streetwear | Shopify products.json | implemented 2026-09-06 |
| 64 | My Ride | `my-ride` | bikes | Shopify products.json | implemented 2026-09-06 |
| 65 | Milly's Kitchen | `millys-kitchen` | kitchenware | Shopify products.json | implemented 2026-09-06 |
| 66 | Palmers | `palmers` | garden | Shopify products.json | implemented 2026-09-06 |
| 67 | NOOD | `nood` | furniture | Shopify products.json | implemented 2026-09-06 |
| 68 | Blackmarket | `blackmarket` | wine deals | Shopify products.json | implemented 2026-09-06 |
| 69 | Design55 | `design55` | homeware | Shopify products.json | implemented 2026-09-06 |
| 70 | Wixii | `wixii` | fashion | Shopify products.json | implemented 2026-09-06 |
| 71 | Aleph Beauty | `aleph-beauty` | beauty | Shopify products.json | implemented 2026-09-06 |
| 72 | Lewis Road Creamery | `lewis-road-creamery` | gourmet food | Shopify products.json — blocked — products.json carries $0.00 prices (subscription-app pricing); needs PDP-level capture | implemented 2026-09-06 |
| 73 | Trilogy | `trilogy` | skincare | Shopify products.json | implemented 2026-09-06 |
| 74 | ilabb | `ilabb` | outdoor apparel | Shopify products.json | implemented 2026-09-06 |
| 75 | Iko Iko | `iko-iko` | gifts & homeware | Shopify products.json | implemented 2026-09-06 |
| 76 | Coffee Supreme | `coffee-supreme` | coffee | Shopify products.json | implemented 2026-09-06 |
| 77 | Regional Wines & Spirits | `regional-wines` | liquor | Shopify products.json | implemented 2026-09-06 |
| 78 | Kokako | `kokako` | coffee | Shopify products.json | implemented 2026-09-06 |
| 79 | Small Acorns | `small-acorns` | gifts & homeware | Shopify products.json | implemented 2026-09-06 |
| 80 | Comvita | `comvita` | natural health | Shopify products.json | implemented 2026-09-06 |
| 81 | Rembrandt | `rembrandt` | menswear | Shopify products.json | implemented 2026-09-06 |
| 82 | Atomic Coffee Roasters | `atomic-coffee` | coffee | Shopify products.json | implemented 2026-09-06 |
| 83 | Merinomink | `merinomink` | merino apparel | Shopify products.json | implemented 2026-09-06 |
| 84 | Linden Leaves | `linden-leaves` | skincare | Shopify products.json | implemented 2026-09-06 |
| 85 | Stirling Sports | `stirling-sports` | sports | Shopify products.json | implemented 2026-09-06 |
| 86 | Ceres Organics | `ceres-organics` | organic grocery | Shopify products.json | implemented 2026-09-06 |
| 87 | Alpine Sports | `alpine-sports` | snow sports | Shopify products.json | implemented 2026-09-06 |
| 88 | Saben | `saben` | bags & accessories | Shopify products.json | implemented 2026-09-06 |
| 89 | Flight Coffee | `flight-coffee` | coffee | Shopify products.json | implemented 2026-09-06 |
| 90 | Bendon Lingerie | `bendon-lingerie` | lingerie | Shopify products.json | implemented 2026-09-06 |
| 91 | Wellington Chocolate Factory | `wellington-chocolate-factory` | chocolate | Shopify products.json | implemented 2026-09-06 |
| 92 | Ripe Maternity | `ripe-maternity` | maternity | Shopify products.json | implemented 2026-09-06 |
| 93 | Peoples Coffee | `peoples-coffee` | coffee | Shopify products.json | implemented 2026-09-06 |
| 94 | Emma Lewisham | `emma-lewisham` | beauty | Shopify products.json | implemented 2026-09-06 |
| 95 | Tea Total | `tea-total` | tea | Shopify products.json | implemented 2026-09-06 |
| 96 | Untouched World | `untouched-world` | merino apparel | Shopify products.json | implemented 2026-09-06 |
| 97 | Allbirds NZ | `allbirds` | footwear | Shopify products.json | implemented 2026-09-06 |
| 98 | Nature Baby | `naturebaby` | baby clothing | Shopify products.json | implemented 2026-09-06 |
| 99 | Workshop | `workshop` | denim & menswear | Shopify products.json | implemented 2026-09-06 |
| 100 | Moochi | `moochi` | fashion | Shopify products.json | implemented 2026-09-06 |
| 101 | 99 Bikes | `99-bikes` | general retail | Shopify products.json | implemented 2026-09-06 |
| 102 | Aje NZ | `aje-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 103 | Amazon Surf | `amazon-surf` | general retail | Shopify products.json | implemented 2026-09-06 |
| 104 | Aurelium Jewellery | `aurelium` | general retail | Shopify products.json | implemented 2026-09-06 |
| 105 | Ballantynes | `ballantynes` | general retail | Shopify products.json | implemented 2026-09-06 |
| 106 | Base NZ | `base-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 107 | BePure | `bepure` | general retail | Shopify products.json | implemented 2026-09-06 |
| 108 | Bicycle Superstore | `bicycle-superstore` | general retail | Shopify products.json | implemented 2026-09-06 |
| 109 | Bloke & Co | `bloke-and-co` | general retail | Shopify products.json | implemented 2026-09-06 |
| 110 | Boh Runga Jewellery | `boh-runga` | general retail | Shopify products.json | implemented 2026-09-06 |
| 111 | Burkes Cycles | `burkes-cycles` | general retail | Shopify products.json | implemented 2026-09-06 |
| 112 | Chapman Store | `chapman-store` | general retail | Shopify products.json | implemented 2026-09-06 |
| 113 | ComplEat Wellness | `compleat-wellness` | general retail | Shopify products.json | implemented 2026-09-06 |
| 114 | Cutthroat NZ | `cutthroat` | general retail | Shopify products.json | implemented 2026-09-06 |
| 115 | Deadly Ponies | `deadly-ponies` | general retail | Shopify products.json | implemented 2026-09-06 |
| 116 | DK & Co | `dk-and-co` | general retail | Shopify products.json | implemented 2026-09-06 |
| 117 | Drop Out Store | `drop-out` | general retail | Shopify products.json | implemented 2026-09-06 |
| 118 | Easy Tiger | `easy-tiger` | general retail | Shopify products.json | implemented 2026-09-06 |
| 119 | Ecostore | `ecostore` | general retail | Shopify products.json | implemented 2026-09-06 |
| 120 | The Fantail House | `fantail-house` | general retail | Shopify products.json | implemented 2026-09-06 |
| 121 | Fix & Fogg | `fix-and-fogg` | general retail | Shopify products.json | implemented 2026-09-06 |
| 122 | Flo & Frankie | `flo-and-frankie` | general retail | Shopify products.json | implemented 2026-09-06 |
| 123 | Fluffy Puppy | `fluffy-puppy` | general retail | Shopify products.json | implemented 2026-09-06 |
| 124 | Folklore Home | `folklore-home` | general retail | Shopify products.json | implemented 2026-09-06 |
| 125 | Freeride Surf & Skate | `freeride-surf-skate` | general retail | Shopify products.json | implemented 2026-09-06 |
| 126 | Furniture Now NZ | `furniture-now` | general retail | Shopify products.json | implemented 2026-09-06 |
| 127 | Furniture World NZ | `furniture-world` | general retail | Shopify products.json | implemented 2026-09-06 |
| 128 | Gearshop NZ | `gearshop` | general retail | Shopify products.json | implemented 2026-09-06 |
| 129 | Gordon Harris | `gordon-harris` | general retail | Shopify products.json | implemented 2026-09-06 |
| 130 | Hyde Boutique | `hyde-boutique` | general retail | Shopify products.json | implemented 2026-09-06 |
| 131 | Hyper Ride | `hyper-ride` | general retail | Shopify products.json | implemented 2026-09-06 |
| 132 | Icon Haircare & Beauty | `icon-haircare-beauty` | general retail | Shopify products.json | implemented 2026-09-06 |
| 133 | IKEA New Zealand | `ikea` | general retail | Shopify products.json | implemented 2026-09-06 |
| 134 | Juliette Hogan | `juliette-hogan` | general retail | Shopify products.json | implemented 2026-09-06 |
| 135 | Kiwivelo | `kiwivelo` | general retail | Shopify products.json | implemented 2026-09-06 |
| 136 | Kmart NZ | `kmart` | general retail | Shopify products.json | implemented 2026-09-06 |
| 137 | KNOWEAR | `knowear` | general retail | Shopify products.json | implemented 2026-09-06 |
| 138 | Kookai NZ | `kookai-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 139 | KOOP | `koop` | general retail | Shopify products.json | implemented 2026-09-06 |
| 140 | Kowtow NZ | `kowtow-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 141 | Lissom Beauty | `lissom-beauty` | general retail | Shopify products.json | implemented 2026-09-06 |
| 142 | LOADED | `loaded` | general retail | Shopify products.json | implemented 2026-09-06 |
| 143 | Made Good | `made-good` | general retail | Shopify products.json | implemented 2026-09-06 |
| 144 | ManCave NZ | `man-cave` | general retail | Shopify products.json | implemented 2026-09-06 |
| 145 | Marle | `marle` | general retail | Shopify products.json | implemented 2026-09-06 |
| 146 | Meadowlark Jewellery | `meadowlark` | general retail | Shopify products.json | implemented 2026-09-06 |
| 147 | NOAH Grooming | `noah-grooming` | general retail | Shopify products.json | implemented 2026-09-06 |
| 148 | Nutrition Warehouse NZ | `nutrition-warehouse` | general retail | Shopify products.json | implemented 2026-09-06 |
| 149 | NZ Liquor Online | `nz-liquor-online` | general retail | Shopify products.json | implemented 2026-09-06 |
| 150 | NZ Muscle | `nz-muscle` | general retail | Shopify products.json | implemented 2026-09-06 |
| 151 | NZ Shred | `nz-shred` | general retail | Shopify products.json | implemented 2026-09-06 |
| 152 | Outfitters NZ | `outfitters-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 153 | Overland Footwear | `overland-footwear` | general retail | Shopify products.json | implemented 2026-09-06 |
| 154 | Paper Plane Store | `paper-plane-store` | general retail | Shopify products.json | implemented 2026-09-06 |
| 155 | Paulas Home & Living | `paulas-home-living` | general retail | Shopify products.json | implemented 2026-09-06 |
| 156 | Pet Connect NZ | `pet-connect` | general retail | Shopify products.json | implemented 2026-09-06 |
| 157 | Pet Essentials Warehouse | `pet-essentials-warehouse` | general retail | Shopify products.json | implemented 2026-09-06 |
| 158 | Pet Factory | `pet-factory` | general retail | Shopify products.json | implemented 2026-09-06 |
| 159 | Pilgrim Jewellery NZ | `pilgrim-jewellery` | general retail | Shopify products.json | implemented 2026-09-06 |
| 160 | Playcentre Shop | `playcentre-shop` | general retail | Shopify products.json | implemented 2026-09-06 |
| 161 | Quest Store NZ | `quest-store` | general retail | Shopify products.json | implemented 2026-09-06 |
| 162 | Scorpion Supplements | `scorpion-supplements` | general retail | Shopify products.json | implemented 2026-09-06 |
| 163 | Sealand Gear | `sealand-gear` | general retail | Shopify products.json | implemented 2026-09-06 |
| 164 | Silk & Steel | `silk-and-steel` | general retail | Shopify products.json | implemented 2026-09-06 |
| 165 | Six Barrel Soda | `six-barrel-soda` | general retail | Shopify products.json | implemented 2026-09-06 |
| 166 | Sportsfuel Supplements | `sportsfuel` | general retail | Shopify products.json | implemented 2026-09-06 |
| 167 | Standard Issue | `standard-issue` | general retail | Shopify products.json | implemented 2026-09-06 |
| 168 | Superette NZ | `superette-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 169 | Supplements NZ | `supplements-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 170 | Taylorson | `taylorson` | general retail | Shopify products.json | implemented 2026-09-06 |
| 171 | Te Uru Shop | `te-uru-shop` | general retail | Shopify products.json | implemented 2026-09-06 |
| 172 | Thirsty Liquor | `thirsty-liquor` | general retail | Shopify products.json | implemented 2026-09-06 |
| 173 | Triumph & Disaster | `triumph-and-disaster` | general retail | Shopify products.json | implemented 2026-09-06 |
| 174 | Two Dudes | `two-dudes` | general retail | Shopify products.json | implemented 2026-09-06 |
| 175 | Ultimate Surf & Skate | `ultimate-surf-skate` | general retail | Shopify products.json | implemented 2026-09-06 |
| 176 | WhiskeyOnline | `whiskey-online` | general retail | Shopify products.json | implemented 2026-09-06 |
| 177 | Whisky and More | `whisky-and-more` | general retail | Shopify products.json | implemented 2026-09-06 |
| 178 | White & Co | `white-and-co` | general retail | Shopify products.json | implemented 2026-09-06 |
| 179 | Ziwi Peak | `ziwi-peak` | general retail | Shopify products.json | implemented 2026-09-06 |
| 180 | Zoe & Morgan | `zoe-and-morgan` | general retail | Shopify products.json | implemented 2026-09-06 |
| 101 | Endemic World | `endemicworld` | art prints | Shopify products.json | implemented 2026-09-06 (bonus) |
| 102 | Cheapskates | `cheapskates` | skate/surf | Shopify products.json | implemented 2026-09-06 (bonus) |
| 51 | Bivouac Outdoor | `bivouac` | outdoor | Shopify products.json | implemented 2026-09-06 (bonus) |
| 52 | Number One Shoes + Hannahs | `number-one-shoes` | footwear | Black Pepper window.category JSON (?p=N) | implemented 2026-09-06 (bonus) |

## Backups (swap in if a planned retailer proves inaccessible)

| Retailer | Domain | Platform / note |
|---|---|---|
| Bin Inn | bininn.co.nz | category pages are marketing-only; no online product prices |
| Hallenstein Brothers | hallensteins.co.nz | custom/headless; /graphql 301s to .com 404, deep links redirect — needs browser-level capture |
| The Sleep Store | thesleepstore.co.nz | Shopify (products.json blocked) |
| Merchant 1948 | overlandfootwear.co.nz | Shopify (products.json blocked) |
| Spotlight | spotlight.co.nz | DNS/dead domain — find real domain |
| Mighty Ape | mightyape.co.nz | 403 bot-block on homepage (Cloudflare) |
| Warehouse Stationery | warehousestationery.co.nz | 403 bot-block (Cloudflare) |
| Repco NZ | repco.co.nz | 403 bot-block (Cloudflare) |
| Pharmacy Direct | pharmacydirect.co.nz | 403 bot-block (Cloudflare) |

## Blocked during the campaign (probe evidence)

- **Four Square** (foursquare.co.nz) — Next.js storefront, no discoverable
  product API in page source; the Foodstuffs NI mobile API
  (api-prod.prod.fsniwaikato.kiwi) served only 150 MNW stores for every
  banner value probed (PNS/FS/FOURSQUARE with a fresh guest token,
  2026-09-06). Needs browser-level capture.
- **Gilmours** (gilmours.co.nz) — B2B wholesale storefront, no public
  product API found; wholesale pricing is likely login-gated.
- **Moore Wilson's** (moorewilsons.co.nz) — headless Shopify Oxygen:
  /products.json, /collections/*/products.json and /search/suggest.json all
  return the Hydrogen app shell. Needs browser-level capture.

## Blocked during the campaign (probe evidence)

- **Oderings** (oderings.co.nz) — Konstruk CMS brochure site; category
  pages (`/plants/…-__I.710716__C.<id>`) are subcategory hubs with no
  product tiles or prices. No online pricing to collect.
- **Bin Inn** (bininn.co.nz) — Craft CMS; `/products/<slug>` pages are
  marketing landing pages without prices.
- **Chemist Warehouse** — grid API (searchapiv2/search, FredHopper) returns
  HTTP 500 to curl even with exact browser URL/headers; in-browser fetch
  succeeds (session/TLS dependent). Needs browser-graded collection.
- **Kmart NZ / Farmers** — Akamai bot manager 403/404s all non-browser
  requests (verified 2026-09-06).

## Excluded after probing

- **Kitchen Things** — site live but title says "Receivership"; not a going
  retail target.
- **1-day.co.nz, Torpedo7, TheMarket** — closed retail brands.
- **Fuel boards (Z, Gull, Waitomo, Allied)** — price-only, no product
  catalog; out of scope for the product+price scraper shape.

## Shared machinery (`retailers/_lib/`)

- `observation.js` — `buildObservation` (canonical `PriceObservation` from
  one source), price parsing (`toCents`, `minorUnitsToCents`), promotion
  derivation (`promotionFor`)
- `http.js` — hardened `getJson`/`getText` on top of
  `src/adapters/fetch-with-retry.js` (retries, timeouts, body cap)
- `shopify.js` — `ShopifyCatalogClient` + pure transforms
  (`parseShopifyProducts`, `toShopifyObservations`)
- `runner.js` — the per-retailer `collect.js` CLI flow (validates every
  observation with `parseObservation`, writes JSONL only to explicit
  `--out` paths, refuses the live archive via `assertNotLiveArchive`)

## Rules of the campaign

1. Adapters are **zero-dependency ESM Node**, reusing `_lib` and the
   existing `src/adapters` seams; no Playwright/SDK in shipped code.
2. Every emitted record must pass `parseObservation` (validated by the
   runner and by tests).
3. Each retailer folder documents its endpoints, mapping, verification
   evidence, and quirks in its own `README.md`.
4. Product ids are `<slug>:<retailerProductId>`; store ids are
   `<slug>:<scope>`; `store.retailer` is the slug.
5. Campaign collectors never touch `data/prices.jsonl` (runner enforces).
6. `test/retailers/retailer-registry.test.js` gates every folder's shape
   and, once 50 adapters exist, the campaign total.

Progress: **GOAL MET 2026-09-06 (raised to 100, then +80)** — **181 working adapters** (5 existing + 176 campaign) across 182 tracked retailers (1 tracked target, Lewis Road Creamery, is blocked with evidence). Registry gate: `test/retailers/retailer-registry.test.js` enforces ≥181.
