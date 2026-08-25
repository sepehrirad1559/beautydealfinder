-- Beauty Deal Finder schema — centralized product database architecture.
--
-- Source of truth model: ONE normalized `products` table holds each real
-- physical product exactly once. Retailer pricing lives in a separate
-- `offers` table, many-to-one against `products`. There is no raw/scraped
-- staging table and no per-retailer scrape cache — every write into
-- `products`/`offers` comes from either the Amazon Product Advertising API
-- (a licensed, official API) or an approved affiliate network's product
-- feed (see backend/src/providers/AffiliateFeedProvider.js). Nothing in
-- this codebase fetches or parses a retailer's own web pages.
--
--   brands  ← products → categories
--                 ↓
--              offers → retailers
--                 ↓
--           price_history

CREATE TABLE IF NOT EXISTS brands (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,                     -- display form, e.g. "Maybelline New York"
  normalized_name TEXT NOT NULL UNIQUE,   -- lowercased/punctuation-stripped, used for matching
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,              -- 'Skincare' | 'Makeup' | 'Haircare' | 'Fragrance' | 'Bath & Body' | 'Tools' | 'Other'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Retailers whose offers we're allowed to show. `data_source` records HOW
-- this retailer's offers legitimately get into the database — every value
-- is an approved, official channel; there is deliberately no 'scrape'
-- option in this schema.
CREATE TABLE IF NOT EXISTS retailers (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,              -- 'amazon' | 'sephora' | 'ulta' | 'beautylish' | 'glossier' | 'cultbeauty'
  display_name TEXT NOT NULL,
  data_source TEXT NOT NULL DEFAULT 'affiliate_feed'
    CHECK (data_source IN ('official_api', 'affiliate_feed')),
  affiliate_network TEXT,                 -- 'rakuten' | 'cj' | 'awin' | 'shareasale' | 'impact' | NULL for direct API retailers
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- The central product database — the single internal source of truth for
-- "what product is this". One row per real-world product/variant
-- (brand + name + shade/size combination), never duplicated across
-- retailers. See services/matching.js for how an incoming item from any
-- provider is matched to an existing row here (or creates a new one).
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  brand_id INTEGER REFERENCES brands(id),
  brand TEXT,                             -- denormalized display copy of brands.name, kept in sync on write — avoids a join for the common "brand" read/filter path
  product_name TEXT NOT NULL,             -- normalized/display product name (retailer-name variations are normalized before matching, see services/normalize.js)
  category_id INTEGER REFERENCES categories(id),
  category TEXT,                          -- denormalized display copy of categories.name
  subcategory TEXT,
  description TEXT,
  upc TEXT,                               -- Universal Product Code (12-digit)
  ean TEXT,                               -- European Article Number (13-digit)
  gtin TEXT,                              -- Global Trade Item Number — superset of UPC/EAN, highest-priority identifier when present
  sku TEXT,                               -- our own canonical SKU, if assigned
  size TEXT,                              -- normalized size/volume, e.g. "50ml"
  shade TEXT,                             -- normalized shade/color name, e.g. "128 Warm Nude"
  image_url TEXT,
  match_key TEXT,                         -- normalized brand+name+shade+size fallback matching key (see services/normalize.js#buildMatchKey) — indexed for fast lookup when no identifier is available
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_gtin ON products (gtin) WHERE gtin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_upc ON products (upc) WHERE upc IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_ean ON products (ean) WHERE ean IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_match_key ON products (match_key) WHERE match_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_brand_name ON products (brand, product_name);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);

-- One row per (retailer, retailer's own product id) — i.e. one row per
-- place you can buy a given central product. Many offers point at the
-- same product_id; that many-to-one relationship IS the price comparison.
CREATE TABLE IF NOT EXISTS offers (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  retailer_id INTEGER NOT NULL REFERENCES retailers(id),
  retailer TEXT NOT NULL,                 -- denormalized copy of retailers.code, kept in sync on write
  retailer_product_id TEXT NOT NULL,      -- ASIN, retailer feed's product id, etc. — unique per retailer
  retailer_sku TEXT,
  price NUMERIC(10,2),
  sale_price NUMERIC(10,2),               -- current discounted price, when the retailer/feed reports one distinct from list price
  currency TEXT NOT NULL DEFAULT 'USD',
  availability TEXT,                      -- normalized: 'in_stock' | 'out_of_stock' | 'limited' | 'unknown'
  affiliate_url TEXT NOT NULL,            -- the tracked link a click sends the shopper to (built by the provider at ingest time)
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when THIS price/availability was last confirmed by its source (API or feed) — distinct from updated_at, which is "when this DB row last changed"
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (retailer, retailer_product_id)
);

CREATE INDEX IF NOT EXISTS idx_offers_product ON offers (product_id);
CREATE INDEX IF NOT EXISTS idx_offers_retailer ON offers (retailer);
CREATE INDEX IF NOT EXISTS idx_offers_last_updated ON offers (last_updated);

-- Every price/availability change for an offer, so "price history" and
-- "was this actually a deal or a fake-discount markup-then-markdown" are
-- answerable later. One row per observed change, not per sync run.
CREATE TABLE IF NOT EXISTS price_history (
  id SERIAL PRIMARY KEY,
  offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  price NUMERIC(10,2),
  sale_price NUMERIC(10,2),
  availability TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_history_offer ON price_history (offer_id, recorded_at DESC);

-- Every provider ingest run (Amazon API call or affiliate feed import),
-- success or failure — makes "why is coverage sparse" answerable from the
-- database instead of guessing.
CREATE TABLE IF NOT EXISTS sync_logs (
  id SERIAL PRIMARY KEY,
  provider_name TEXT NOT NULL,
  sync_type TEXT NOT NULL,                -- 'official_api' | 'affiliate_feed'
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  records_received INTEGER,
  records_updated INTEGER,
  products_created INTEGER,
  status TEXT NOT NULL,                   -- 'success' | 'error'
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Affiliate click tracking — the entire revenue mechanism. Every outbound
-- click is logged with enough context to reconcile against retailer/
-- network commission reports.
CREATE TABLE IF NOT EXISTS clicks (
  id SERIAL PRIMARY KEY,
  offer_id INTEGER REFERENCES offers(id),
  retailer TEXT NOT NULL,
  clicked_url TEXT NOT NULL,
  session_id TEXT,
  user_agent TEXT,
  referrer TEXT,
  ip_hash TEXT,                           -- salted hash, never raw IP
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clicks_created_at ON clicks (created_at);
CREATE INDEX IF NOT EXISTS idx_clicks_retailer ON clicks (retailer);

-- Seed the retailers table with the six retailers the spec names. Amazon
-- is the one with a real official API today; the rest start inactive
-- (active = false) until an approved affiliate feed is actually wired up
-- for them — see config/feedSources.js.
INSERT INTO retailers (code, display_name, data_source, affiliate_network, active) VALUES
  ('amazon', 'Amazon', 'official_api', NULL, true),
  ('sephora', 'Sephora', 'affiliate_feed', NULL, false),
  ('ulta', 'Ulta Beauty', 'affiliate_feed', NULL, false),
  ('beautylish', 'Beautylish', 'affiliate_feed', NULL, false),
  ('glossier', 'Glossier', 'affiliate_feed', NULL, false),
  ('cultbeauty', 'Cult Beauty', 'affiliate_feed', NULL, false)
ON CONFLICT (code) DO NOTHING;
