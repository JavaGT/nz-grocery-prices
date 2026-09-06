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
| 181 | HyperDrive | `hyperdrive` | tyres & wheels | N2 ERP SSR grids | implemented 2026-09-06 |
| 345 | The Good Wine Co | `the-good-wine-co` | general retail | Shopify products.json | implemented 2026-09-06 |
| 346 | Vino Fino | `vino-fino` | general retail | Shopify products.json | implemented 2026-09-06 |
| 347 | Winebox | `winebox` | general retail | Shopify products.json | implemented 2026-09-06 |
| 344 | Alcohol Delivery NZ | `alcohol-delivery-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 340 | Green With Envy | `green-with-envy` | general retail | Shopify products.json | implemented 2026-09-06 |
| 341 | Indie Home Collective | `indie-home-collective` | general retail | Shopify products.json | implemented 2026-09-06 |
| 342 | Little & Fox | `little-and-fox` | general retail | Shopify products.json | implemented 2026-09-06 |
| 343 | Notting Hill Interiors | `notting-hill-interiors` | general retail | Shopify products.json | implemented 2026-09-06 |
| 338 | Little & Loved | `little-and-loved` | general retail | Shopify products.json | implemented 2026-09-06 |
| 339 | Toyworld New Zealand | `toyworld-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 335 | Greenstone Shop | `greenstone-shop` | general retail | Shopify products.json | implemented 2026-09-06 |
| 336 | HAPA | `hapa` | general retail | Shopify products.json | implemented 2026-09-06 |
| 337 | Maori Arts Gallery | `maori-arts-gallery` | general retail | Shopify products.json | implemented 2026-09-06 |
| 331 | Art Collective NZ | `art-collective` | general retail | Shopify products.json | implemented 2026-09-06 |
| 332 | Earth Sea Sky | `earth-sea-sky` | general retail | Shopify products.json | implemented 2026-09-06 |
| 333 | Nevalea Alpacas | `nevalea-alpacas` | general retail | Shopify products.json | implemented 2026-09-06 |
| 334 | Zealong Tea Estate | `zealong-tea` | general retail | Shopify products.json | implemented 2026-09-06 |
| 326 | The Coffee Collective | `coffee-collective` | general retail | Shopify products.json | implemented 2026-09-06 |
| 327 | Havana Coffee Works | `havana-coffee` | general retail | Shopify products.json | implemented 2026-09-06 |
| 328 | Rabbit Island Coffee Co | `rabbit-island-coffee` | general retail | Shopify products.json | implemented 2026-09-06 |
| 329 | Slow Coffee Roasters | `slow-coffee` | general retail | Shopify products.json | implemented 2026-09-06 |
| 330 | TOB Coffee | `tob-coffee` | general retail | Shopify products.json | implemented 2026-09-06 |
| 324 | Blush Merchants | `blush-merchants` | general retail | Shopify products.json | implemented 2026-09-06 |
| 325 | Juno Gin | `juno-gin` | general retail | Shopify products.json | implemented 2026-09-06 |
| 318 | GoGoKids | `gogokids` | general retail | Shopify products.json | implemented 2026-09-06 |
| 319 | Kidzstuffonline | `kidzstuffonline` | general retail | Shopify products.json | implemented 2026-09-06 |
| 320 | Little Reef and Friends | `little-reef-and-friends` | general retail | Shopify products.json | implemented 2026-09-06 |
| 321 | Tahi Toy | `tahi-toy` | general retail | Shopify products.json | implemented 2026-09-06 |
| 322 | The Toy Box | `the-toy-box` | general retail | Shopify products.json | implemented 2026-09-06 |
| 323 | Wee Little Ones | `wee-little-ones` | general retail | Shopify products.json | implemented 2026-09-06 |
| 315 | Health New Zealand | `health-new-zealand` | general retail | Shopify products.json | implemented 2026-09-06 |
| 316 | Lifestream | `lifestream` | general retail | Shopify products.json | implemented 2026-09-06 |
| 317 | My Natural Health | `my-natural-health` | general retail | Shopify products.json | implemented 2026-09-06 |
| 311 | Devold New Zealand | `devold-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 312 | Wild South Clothing | `wild-south-clothing` | general retail | Shopify products.json | implemented 2026-09-06 |
| 313 | Wild Wool Gallery | `wild-wool-gallery` | general retail | Shopify products.json | implemented 2026-09-06 |
| 314 | Wools of Wanaka | `wools-of-wanaka` | general retail | Shopify products.json | implemented 2026-09-06 |
| 305 | DECJUBA NZ | `decjuba-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 306 | Ebony Boutique | `ebony-boutique` | general retail | Shopify products.json | implemented 2026-09-06 |
| 307 | Kōnei Aotearoa | `konei` | general retail | Shopify products.json | implemented 2026-09-06 |
| 308 | Max NZ | `max-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 309 | Shop 9 Boutique | `shop9` | general retail | Shopify products.json | implemented 2026-09-06 |
| 310 | Trouble & Fox | `trouble-and-fox` | general retail | Shopify products.json | implemented 2026-09-06 |
| 301 | Loft Furniture | `loft-furniture` | general retail | Shopify products.json | implemented 2026-09-06 |
| 302 | Mooch NZ | `mooch-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 303 | The Homestore | `the-homestore` | general retail | Shopify products.json | implemented 2026-09-06 |
| 304 | The Living Styles | `the-living-styles` | general retail | Shopify products.json | implemented 2026-09-06 |
| 300 | Watches of New Zealand | `watches-of-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 296 | BBQs and More | `bbqs-and-more` | general retail | Shopify products.json | implemented 2026-09-06 |
| 297 | Bull BBQ NZ | `bull-bbq` | general retail | Shopify products.json | implemented 2026-09-06 |
| 298 | Grill King BBQs | `grill-king-bbqs` | general retail | Shopify products.json | implemented 2026-09-06 |
| 299 | Outdoor Concepts | `outdoor-concepts` | general retail | Shopify products.json | implemented 2026-09-06 |
| 292 | Foxtrot Home | `foxtrot-home` | general retail | Shopify products.json | implemented 2026-09-06 |
| 293 | Linen King | `linen-king` | general retail | Shopify products.json | implemented 2026-09-06 |
| 294 | M.M Linen | `mm-linen` | general retail | Shopify products.json | implemented 2026-09-06 |
| 295 | The Foxes Den | `the-foxes-den` | general retail | Shopify products.json | implemented 2026-09-06 |
| 289 | The Bond Store | `bond-store` | general retail | Shopify products.json | implemented 2026-09-06 |
| 290 | Kiwi Spirit Distillery | `kiwi-spirit-distillery` | general retail | Shopify products.json | implemented 2026-09-06 |
| 291 | SIP Distilling Co. | `sip-distilling` | general retail | Shopify products.json | implemented 2026-09-06 |
| 285 | Living Nature | `living-nature` | general retail | Shopify products.json | implemented 2026-09-06 |
| 286 | Nellie Tier | `nellie-tier` | general retail | Shopify products.json | implemented 2026-09-06 |
| 287 | PureNature NZ | `pure-nature` | general retail | Shopify products.json | implemented 2026-09-06 |
| 288 | Wild Ferns | `wild-ferns` | general retail | Shopify products.json | implemented 2026-09-06 |
| 282 | Electric Bike Team | `ebike-team` | general retail | Shopify products.json | implemented 2026-09-06 |
| 283 | Electrify NZ | `electrify-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 284 | Sinch Bikes | `sinch-bikes` | general retail | Shopify products.json | implemented 2026-09-06 |
| 278 | Noble & Sunday Tea Merchants | `noble-and-sunday` | general retail | Shopify products.json | implemented 2026-09-06 |
| 279 | Tea Store Aotearoa | `tea-store-aotearoa` | general retail | Shopify products.json | implemented 2026-09-06 |
| 280 | Ti Ani | `ti-ani` | general retail | Shopify products.json | implemented 2026-09-06 |
| 281 | Websters Tea | `websters-tea` | general retail | Shopify products.json | implemented 2026-09-06 |
| 275 | Honeys of New Zealand | `honeys-of-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 276 | Manuka Doctor | `manuka-doctor` | general retail | Shopify products.json | implemented 2026-09-06 |
| 277 | Manuka Honey of NZ | `manuka-honey-of-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 273 | Glenn Jones Art | `glenn-jones-art` | general retail | Shopify products.json | implemented 2026-09-06 |
| 274 | Love Print NZ | `print-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 270 | Ao Cacao | `ao-cacao` | general retail | Shopify products.json | implemented 2026-09-06 |
| 271 | Foundry Chocolate | `foundry-chocolate` | general retail | Shopify products.json | implemented 2026-09-06 |
| 272 | Hogarth Chocolate | `hogarth-chocolate` | general retail | Shopify products.json | implemented 2026-09-06 |
| 268 | Saucy | `saucy` | general retail | Shopify products.json | implemented 2026-09-06 |
| 269 | ShopNZ | `shopnz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 263 | Glowing Sky | `glowing-sky` | general retail | Shopify products.json | implemented 2026-09-06 |
| 264 | Mons Royale NZ | `mons-royale-nz` | general retail | Shopify products.json | implemented 2026-09-06 |
| 265 | NZ Natural Clothing | `nz-natural-clothing` | general retail | Shopify products.json | implemented 2026-09-06 |
| 266 | Swanndri | `swanndri` | general retail | Shopify products.json | implemented 2026-09-06 |
| 267 | The Tin Shed | `tin-shed` | general retail | Shopify products.json | implemented 2026-09-06 |
| 261 | Lure Me | `lure-me` | general retail | Shopify products.json | implemented 2026-09-06 |
| 262 | Mom Store | `mom-store` | general retail | Shopify products.json | implemented 2026-09-06 |
| 254 | Flex Fitness Equipment | `flex-equipment` | general retail | Shopify products.json | implemented 2026-09-06 |
| 255 | Johnny Jungle | `johnny-jungle` | general retail | Shopify products.json | implemented 2026-09-06 |
| 256 | Moffatts Flower Company | `moffatts` | general retail | Shopify products.json | implemented 2026-09-06 |
| 257 | PlantHouse | `planthouse` | general retail | Shopify products.json | implemented 2026-09-06 |
| 258 | The Green Grower | `the-green-grower` | general retail | Shopify products.json | implemented 2026-09-06 |
| 259 | The Indoor Oasis | `the-indoor-oasis` | general retail | Shopify products.json | implemented 2026-09-06 |
| 260 | The Lily Pot | `the-lily-pot` | general retail | Shopify products.json | implemented 2026-09-06 |
| 250 | Amberjack Candle Company | `amberjack` | general retail | Shopify products.json | implemented 2026-09-06 |
| 251 | Living Light Candles | `living-light-candles` | general retail | Shopify products.json | implemented 2026-09-06 |
| 252 | LucyKing | `lucy-king` | general retail | Shopify products.json | implemented 2026-09-06 |
| 253 | NOLA Candles | `nola-candles` | general retail | Shopify products.json | implemented 2026-09-06 |
| 244 | Love Knot War | `love-knot-war` | general retail | Shopify products.json | implemented 2026-09-06 |
| 245 | Penny Sage | `penny-sage` | general retail | Shopify products.json | implemented 2026-09-06 |
| 246 | Sophie Divett Jewellery | `sophie-divett` | general retail | Shopify products.json | implemented 2026-09-06 |
| 247 | Tonic & Cloth | `tonic-and-cloth` | general retail | Shopify products.json | implemented 2026-09-06 |
| 248 | Velvet Heartbeat | `velvet-heartbeat` | general retail | Shopify products.json | implemented 2026-09-06 |
| 249 | Yumei Brand | `yumei-brand` | general retail | Shopify products.json | implemented 2026-09-06 |
| 238 | Aka Aka Brewing | `aka-aka-brewing` | general retail | Shopify products.json | implemented 2026-09-06 |
| 239 | Beer Cellar NZ | `beer-cellar` | general retail | Shopify products.json | implemented 2026-09-06 |
| 240 | Beer Hug | `beer-hug` | general retail | Shopify products.json | implemented 2026-09-06 |
| 241 | Beer Jerk | `beer-jerk` | general retail | Shopify products.json | implemented 2026-09-06 |
| 242 | MoreBeer NZ | `morebeer` | general retail | Shopify products.json | implemented 2026-09-06 |
| 243 | Prestige Botanicals | `prestige-botanicals` | general retail | Shopify products.json | implemented 2026-09-06 |
| 224 | 86 Parts | `86-parts` | general retail | Shopify products.json | implemented 2026-09-06 |
| 225 | Baby HQ | `baby-hq` | general retail | Shopify products.json | implemented 2026-09-06 |
| 226 | Barefoot Kiwi | `barefoot-kiwi` | general retail | Shopify products.json | implemented 2026-09-06 |
| 227 | Beardy Curls | `beardy-curls` | general retail | Shopify products.json | implemented 2026-09-06 |
| 228 | Cupcake Sweeties | `cupcake-sweeties` | general retail | Shopify products.json | implemented 2026-09-06 |
| 229 | Jadiez | `jadiez` | general retail | Shopify products.json | implemented 2026-09-06 |
| 230 | Lamplight Books | `lamplight-books` | general retail | Shopify products.json | implemented 2026-09-06 |
| 231 | Moa Grey Lynn | `moa-grey-lynn` | general retail | Shopify products.json | implemented 2026-09-06 |
| 232 | O Care | `o-care` | general retail | Shopify products.json | implemented 2026-09-06 |
| 233 | PC Store | `pcstore` | general retail | Shopify products.json | implemented 2026-09-06 |
| 234 | Spacecraft Creative | `spacecraft-creative` | general retail | Shopify products.json | implemented 2026-09-06 |
| 235 | Tea Pea | `tea-pea` | general retail | Shopify products.json | implemented 2026-09-06 |
| 236 | Ten Point One | `ten-point-one` | general retail | Shopify products.json | implemented 2026-09-06 |
| 237 | Tom & Bridget | `tom-and-bridget` | general retail | Shopify products.json | implemented 2026-09-06 |
| 210 | Clever Poppy | `clever-poppy` | general retail | Shopify products.json | implemented 2026-09-06 |
| 211 | ILoveUgly | `iloveugly` | general retail | Shopify products.json | implemented 2026-09-06 |
| 212 | Kids Ride Shotgun | `kids-ride-shotgun` | general retail | Shopify products.json | implemented 2026-09-06 |
| 213 | Little Bird Organics | `little-bird-organics` | general retail | Shopify products.json | implemented 2026-09-06 |
| 214 | Love That Leaf | `love-that-leaf` | general retail | Shopify products.json | implemented 2026-09-06 |
| 215 | Moodi Blends | `moodi-blends` | general retail | Shopify products.json | implemented 2026-09-06 |
| 216 | Nothing Naughty | `nothing-naughty` | general retail | Shopify products.json | implemented 2026-09-06 |
| 217 | The New Zealand Honey Co | `nz-honey-co` | general retail | Shopify products.json | implemented 2026-09-06 |
| 218 | Porter James Sports | `porter-james-sports` | general retail | Shopify products.json | implemented 2026-09-06 |
| 219 | Question Beauty | `question-beauty` | general retail | Shopify products.json | implemented 2026-09-06 |
| 220 | The Sewing Revival | `sewing-revival` | general retail | Shopify products.json | implemented 2026-09-06 |
| 221 | Swiftpoint | `swiftpoint` | general retail | Shopify products.json | implemented 2026-09-06 |
| 222 | UP Dairy | `up-dairy` | general retail | Shopify products.json | implemented 2026-09-06 |
| 223 | Wilson & Dorset | `wilson-dorset` | general retail | Shopify products.json | implemented 2026-09-06 |
| 209 | Book Hound | `book-hound` | general retail | Shopify products.json | implemented 2026-09-06 |
| 207 | Unity Books | `unity-books` | general retail | Shopify products.json | implemented 2026-09-06 |
| 208 | Wardini Books | `wardini` | general retail | Shopify products.json | implemented 2026-09-06 |
| 205 | Book Haven | `book-haven` | general retail | Shopify products.json | implemented 2026-09-06 |
| 206 | Hard to Find | `hard-to-find` | general retail | Shopify products.json | implemented 2026-09-06 |
| 204 | Page & Blackmore Booksellers | `page-blackmore` | general retail | Shopify products.json | implemented 2026-09-06 |
| 199 | Bea DnD Games | `bea-dnd-games` | general retail | Shopify products.json | implemented 2026-09-06 |
| 200 | Dice Goblin | `dice-goblin` | general retail | Shopify products.json | implemented 2026-09-06 |
| 201 | Game Roost | `game-roost` | general retail | Shopify products.json | implemented 2026-09-06 |
| 202 | Goblin Games | `goblin-games` | general retail | Shopify products.json | implemented 2026-09-06 |
| 203 | Scorpio Books | `scorpio-books` | general retail | Shopify products.json | implemented 2026-09-06 |
| 184 | A&C Homestore | `ac-homestore` | general retail | Shopify products.json | implemented 2026-09-06 |
| 185 | Appliance World NZ | `appliance-world` | general retail | Shopify products.json | implemented 2026-09-06 |
| 186 | AwaMae | `awamae` | general retail | Shopify products.json | implemented 2026-09-06 |
| 187 | Babu Basics | `babu` | general retail | Shopify products.json | implemented 2026-09-06 |
| 188 | Coops Clothing | `coops-clothing` | general retail | Shopify products.json | implemented 2026-09-06 |
| 189 | Devonport Chocolates | `devonport-chocolates` | general retail | Shopify products.json | implemented 2026-09-06 |
| 190 | Elite Fitness Equipment | `elite-fitness` | general retail | Shopify products.json | implemented 2026-09-06 |
| 191 | Flux Boutique | `flux-boutique` | general retail | Shopify products.json | implemented 2026-09-06 |
| 192 | Handcrafted Modern | `handcrafted-modern` | general retail | Shopify products.json | implemented 2026-09-06 |
| 193 | Hoopla Kids | `hoopla-kids` | general retail | Shopify products.json | implemented 2026-09-06 |
| 194 | Jamie Kay | `jamie-kay` | general retail | Shopify products.json | implemented 2026-09-06 |
| 195 | Nest | `nest` | general retail | Shopify products.json | implemented 2026-09-06 |
| 196 | Ozone Coffee | `ozone-coffee` | general retail | Shopify products.json | implemented 2026-09-06 |
| 197 | RE:FORM Home | `reform-home` | general retail | Shopify products.json | implemented 2026-09-06 |
| 198 | Snuggle Hunny NZ | `snuggle-hunny` | general retail | Shopify products.json | implemented 2026-09-06 |
| 182 | Endemic World | `endemicworld` | art prints | Shopify products.json | implemented 2026-09-06 (bonus) |
| 183 | Cheapskates | `cheapskates` | skate/surf | Shopify products.json | implemented 2026-09-06 (bonus) |
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
  requests (verified 2026-09-06). Kmart later cracked via Constructor.io.
- **HyperDrive** — listing data was client-rendered; cracked 2026-09-06 via
  the server-rendered category grids (adapter now implemented).

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

Progress: **GOAL EXCEEDED 2026-09-06 (raised to 100, then +80)** — **197 working adapters** (5 existing + 192 campaign) across 193 tracked retailers (1 tracked target, Lewis Road Creamery, is blocked with evidence). Registry gate enforces the 181 minimum from the +80 round. Registry gate: `test/retailers/retailer-registry.test.js` enforces ≥181.
