# Beauty Deal Finder

Compares beauty product prices across Sephora, Ulta, Amazon, Beautylish, Glossier, and Cult Beauty,
and earns affiliate commissions when a user clicks through and buys. Zero inventory, zero payment
processing — retailers handle both; this site only compares prices and sends the click.

## Architecture: centralized product database only

The backend is built around one central product database as the single internal source of truth —
see `backend/src/db/schema.sql`:

```
brands ──┐
         ├─► products ──► offers ──► retailers
categories┘        │
                    └─► price_history   (offers ──► clicks, for affiliate attribution)
```

`products` holds each real physical product exactly once (brand, product_name, category,
subcategory, description, upc, ean, gtin, sku, size, shade, image_url, plus timestamps). `offers` is
a separate table, many rows per product — one per retailer carrying it (retailer, retailer_product_id,
retailer_sku, price, sale_price, currency, availability, affiliate_url, last_updated). The
relationship is always one central product → many retailer offers; the frontend/API never show a
duplicate product card for the same physical item just because two retailers wrote the name
differently.

Every write into `products`/`offers` goes through one shared function,
`backend/src/services/productStore.js#upsertProductOffer`, which matches an incoming item against
existing products in priority order — **GTIN → UPC → EAN → existing retailer_product_id → normalized
brand+name+shade+size** — and either attaches a new offer to the matching product or creates a new
product row. `backend/src/services/normalize.js` standardizes brand names, product names, categories,
sizes, shades, identifier formats, currency, prices, and availability before matching runs, so
"Maybelline New York Super Stay Full Coverage Foundation 128 Warm Nude" (Amazon) and "Maybelline
Super Stay Foundation - 128 Warm Nude" (Ulta) collapse into one product with two offers instead of
two separate cards.

**Only two data-collection mechanisms exist in this codebase, both official/licensed, and there is no
scraper anywhere to fall back to:**

1. **Amazon Product Advertising API (PA-API 5.0)** — `backend/src/services/amazon.js` — a real,
   signed, licensed API call. Requires an approved Amazon Associates account.
2. **Affiliate network product feeds** — `backend/src/services/affiliateFeed.js` — reads the CSV/JSON
   feed file an approved affiliate network (Rakuten Advertising, CJ Affiliate, Awin, ShareASale, or
   Impact) generates and hosts for its affiliates. This is the only path for Sephora, Ulta,
   Beautylish, Glossier, and Cult Beauty, none of which have a public product API. Retailers start
   `active = false` in the `retailers` table and stay that way until a real feed is configured in
   `backend/src/config/feedSources.js` — deliberately empty by default.

Neither module fetches a retailer's own web pages, parses HTML, reads JSON-LD/structured data off a
retailer site, drives a browser, calls an unofficial/reverse-engineered API, or scrapes search
engines. An earlier version of this project included a JSON-LD/sitemap scraper for the five
API-less retailers (`services/jsonLdRetailers.js`, `providers/JsonLdRetailerProvider.js`,
`config/retailerSources.js`); **it has been removed entirely** (not just disabled) and replaced with
the affiliate-feed importer above.

## Data freshness / stale offers

Every offer carries `last_updated`, set whenever a sync successfully reconfirms its price/availability
(see `productStore.js#upsertOffer`). `backend/src/routes/products.js` treats any offer older than
`STALE_OFFER_HOURS` (env var, default 48) as **not current** — it's excluded from the lowest-price/
savings calculation and from `best_price`, though it's still returned in the `offers` array flagged
`is_stale: true` so the UI could surface "last checked X ago" if desired. `backend/src/routes/admin.js`
`GET /admin/health` also reports a stale-offer count per retailer so sync gaps are visible.

## What's actually real right now vs. placeholder

Be clear-eyed about this before treating anything here as production-ready:

- **Amazon**: a real, working Product Advertising API (PA-API 5.0) client (`backend/src/services/amazon.js`),
  including request signing. It will do nothing until you set `AMAZON_ACCESS_KEY`/`AMAZON_SECRET_KEY`/
  `AMAZON_PARTNER_TAG` — which requires an Amazon Associates account that's already driven qualifying
  sales (PA-API access isn't granted on signup).
- **Sephora, Ulta, Beautylish, Glossier, Cult Beauty**: no public API exists for any of these, and
  this codebase does not scrape them. The only path in is an approved affiliate network's product
  feed, configured in `backend/src/config/feedSources.js` — empty on purpose until you have real
  credentials. Apply to each retailer's affiliate program (most run through Rakuten Advertising, CJ
  Affiliate, Awin, ShareASale, or Impact); once approved, add the feed URL/field mapping and flip
  `active = true` for that retailer.
- **Sample data**: `backend/src/seed/seedProducts.js` seeds ~10 realistic products with prices across
  multiple retailers — including one item (Maybelline Super Stay Foundation) deliberately entered
  under two different retailer-style names to demonstrate GTIN-based product matching — so the site is
  demoable immediately and the matching logic is exercised on day one. This is fabricated-but-realistic
  data, not live pricing — replace it by running real provider syncs once you have credentials (see
  DEPLOYMENT.md for the cleanup query).
- **Frontend**: unchanged from before this refactor — it only ever called this backend's `/api/*`
  routes, never a retailer site directly, so no frontend code needed to change for the
  centralized-database requirement. Written but **not build-verified** in this sandbox — npm registry
  access was blocked (403 on every package) when installing dependencies, so it could only be reviewed
  by hand. Run `npm install && npm run build` yourself before trusting it. The new backend schema
  *was* verified end-to-end against a real local PostgreSQL 16 instance in this sandbox (schema
  applied, GTIN-based product matching confirmed to collapse two differently-named retailer listings
  into one product with two offers, staleness flagging confirmed) — see the session's work for details.

## Setup

```
# Backend
cd backend
cp .env.example .env    # fill in DATABASE_URL at minimum; everything else is optional to start
npm install
npm run seed             # loads sample data so the site isn't empty
npm run dev

# Frontend
cd frontend
cp .env.example .env
npm install
npm run dev
```

## Adding a real data source

- **Amazon**: get PA-API credentials, add them to `.env`, then `POST /admin/sync/amazon` (with header
  `x-sync-key: <SYNC_SECRET_KEY>`) or wait for the daily scheduled sync.
- **A JSON-LD-scraped retailer**: verify it per the checklist above, add an entry to
  `backend/src/config/retailerSources.js`, then `POST /admin/sync/<retailer>`.
- **An affiliate-network product feed** (the recommended path for Sephora/Ulta/Beautylish/Glossier/
  Cult Beauty): not yet built — this would be a new `services/<network>Feed.js` that parses whatever
  format the network provides (usually CSV/XML) and calls `storeJsonLdProduct`-style upserts into
  `product_offers`. Ask for this once you have network approval and can see a real feed sample.

## Deferred from this first pass

Chosen "full-featured from the start," but a few concertandmatches features weren't ported over yet —
flagging rather than silently omitting:

- Search autocomplete dropdown
- SSR pre-rendering for bots / sitemap.xml
- Admin dashboard UI (the backend stats/health endpoints exist; no HTML page consumes them yet)
- Device/city breakdown on click analytics (raw click rows are captured; the aggregation queries
  aren't built yet)

## Legal pages

`frontend/public/privacy.html`, `terms.html`, and `cookies.html` are drafted starting points (not
legal advice) with `[bracketed placeholders]` for your business details — fill those in and have a
lawyer review before real customers rely on them.

## Deploying

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full checklist, split clearly between what's already
handled in the code and what only you can do (account creation, payment, domain purchase, and
affiliate program applications). Short version: Railway + Postgres for the backend, Vercel for the
frontend, Amazon Associates/PA-API as the one real data source at launch — the other five retailers
launch labeled "coming soon" until their affiliate programs approve you.
