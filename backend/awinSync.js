// BeautyPriceMatch.com — Awin datafeed sync (products + prices + stock).
//
// WHAT THIS DOES:
//   For every advertiser in the `awin_programmes` table with status
//   'joined' and a known datafeed_id (populated automatically by
//   awinProgrammeChecker.js), this downloads that advertiser's official
//   product datafeed straight from Awin's Product Data feed service and
//   upserts it into products/offers. This is the real, supported source
//   of truth Awin gives publishers — merchant-maintained, refreshed
//   daily on their end — so prices, new products, and out-of-stock
//   items all come from the same place a human affiliate manager would
//   use, not from scraping.
//
//   Any offer that used to exist for an advertiser but is NOT in this
//   run's feed gets marked availability='out_of_stock' (never deleted —
//   history and any existing outbound links stay intact).
//
// REQUIRES (Railway service Variables tab):
//   AWIN_DATAFEED_APIKEY — from https://ui.awin.com -> Publisher menu ->
//                           "Datafeeds" -> API tab (this is a DIFFERENT
//                           key than the OAuth token used by
//                           awinProgrammeChecker.js)
//   AWIN_AFFID            — your Awin publisher/affiliate ID (3062047)
//   DATABASE_URL          — already set
//
// HOW TO RUN MANUALLY:
//   Upload to Railway Console -> Files panel, then: node awinSync.js
//
// Meant to run on a schedule (see run-all.js + Railway Cron Job setup).
//
// PERFORMANCE NOTE (Sept 2026): originally did one row at a time — a
// category lookup/insert, a product select-or-insert, and an offer
// upsert, all as separate awaited round trips per row. Fine for small
// feeds, but for a merchant like Zlike Hair with ~15,700 rows that meant
// ~47,000 sequential DB round trips, which took 40+ minutes on Railway's
// network. Rewritten below to batch: categories and existing products
// are resolved with a handful of bulk queries up front, new products are
// bulk-inserted, and offers are bulk-upserted in chunks — cuts a
// multi-row feed down to a small, constant number of round trips instead
// of ~3 per row.

import { Pool } from 'pg';
import zlib from 'zlib';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const AWIN_DATAFEED_APIKEY = process.env.AWIN_DATAFEED_APIKEY;
const AWIN_AFFID = process.env.AWIN_AFFID || '3062047';

// How many offer rows to upsert per INSERT statement. Postgres has a
// 65535 bind-parameter limit per statement; each offer row here binds 8
// params, so 500 rows/chunk (4000 params) is comfortably under that
// while still cutting a 15k-row feed to ~30 round trips instead of 15k.
const OFFER_CHUNK_SIZE = 500;
const PRODUCT_CHUNK_SIZE = 500;

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function awinLink(advertiserId, destUrl) {
  return `https://www.awin1.com/cread.php?awinmid=${advertiserId}&awinaffid=${AWIN_AFFID}&ued=${encodeURIComponent(destUrl)}`;
}

// Minimal CSV parser good enough for Awin's standard feed columns
// (quoted fields, commas inside quotes, escaped quotes).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (field.length || row.length) { row.push(field); rows.push(row); }
        field = ''; row = [];
        if (c === '\r' && text[i + 1] === '\n') i++;
      } else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const rawHeader = rows[0].map((h) => h.trim());
  const normHeader = rawHeader.map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''));
  return rows.slice(1).filter((r) => r.length === rawHeader.length).map((r) => {
    const obj = {};
    rawHeader.forEach((h, idx) => { obj[h] = r[idx]; });
    normHeader.forEach((h, idx) => { if (!(h in obj)) obj[h] = r[idx]; });
    return obj;
  });
}

function pick(row, ...candidates) {
  for (const c of candidates) {
    if (row[c] !== undefined && row[c] !== null && String(row[c]).trim() !== '') return String(row[c]).trim();
  }
  return '';
}

const FEED_COLUMNS = [
  'aw_deep_link', 'product_name', 'aw_product_id', 'merchant_product_id',
  'merchant_image_url', 'description', 'merchant_category', 'search_price',
  'merchant_name', 'merchant_id', 'category_name', 'category_id',
  'aw_image_url', 'currency', 'store_price', 'delivery_cost',
  'merchant_deep_link', 'language', 'last_updated', 'display_price',
  'data_feed_id', 'in_stock', 'rrp_price',
].join(',');

async function fetchAndParse(url) {
  const res = await fetch(url);
  if (!res.ok) return { ok: false, status: res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  let text;
  try {
    text = zlib.gunzipSync(buf).toString('utf8');
  } catch {
    text = buf.toString('utf8');
  }
  return { ok: true, rows: parseCsv(text) };
}

async function downloadFeed(datafeedId) {
  const primaryUrl =
    `https://productdata.awin.com/datafeed/download/apikey/${AWIN_DATAFEED_APIKEY}` +
    `/language/en/fid/${datafeedId}/columns/${FEED_COLUMNS}` +
    `/format/csv/delimiter/%2C/compression/gzip/adultcontent/1/`;
  const primary = await fetchAndParse(primaryUrl);
  if (primary.ok) return primary.rows;

  const fallbackUrl =
    `https://ui.awin.com/productdata-darwin-download/publisher/${AWIN_AFFID}` +
    `/${AWIN_DATAFEED_APIKEY}/1/feed/${datafeedId}.csv.gz`;
  const fallback = await fetchAndParse(fallbackUrl);
  if (fallback.ok) return fallback.rows;

  throw new Error(
    `Feed download failed for datafeed ${datafeedId} — classic endpoint: ${primary.status}, ` +
    `newer-format endpoint: ${fallback.status}`
  );
}

// Splits an array into fixed-size chunks.
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Resolves category name -> id for every distinct category seen in this
// feed with a small, constant number of round trips: one SELECT for all
// names already in the table, then (if needed) one bulk INSERT for the
// rest, instead of a SELECT-then-maybe-INSERT per row.
async function resolveCategoryIds(names) {
  const distinct = [...new Set(names.map((n) => (n && n.trim() ? n.trim() : 'Beauty')))];
  const map = new Map();
  if (!distinct.length) return map;

  const existing = await pool.query(`SELECT id, name FROM categories WHERE name = ANY($1::text[])`, [distinct]);
  for (const row of existing.rows) map.set(row.name, row.id);

  const missing = distinct.filter((n) => !map.has(n));
  if (missing.length) {
    const values = missing.map((_, i) => `($${i + 1})`).join(',');
    const ins = await pool.query(
      `INSERT INTO categories (name) VALUES ${values}
       ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name
       RETURNING id, name`,
      missing
    );
    for (const row of ins.rows) map.set(row.name, row.id);
  }
  return map;
}

// Resolves match_key -> product id for every distinct product in this
// feed. Existing products are fetched with chunked bulk SELECTs; new
// ones are created with chunked bulk INSERTs — replaces what used to be
// one SELECT (and sometimes one INSERT) per row.
async function resolveProductIds(rowsMeta) {
  const byKey = new Map(); // match_key -> row meta (first occurrence wins for insert data)
  for (const r of rowsMeta) if (!byKey.has(r.matchKey)) byKey.set(r.matchKey, r);
  const allKeys = [...byKey.keys()];

  const idByKey = new Map();
  for (const keyChunk of chunk(allKeys, PRODUCT_CHUNK_SIZE)) {
    const res = await pool.query(`SELECT id, match_key FROM products WHERE match_key = ANY($1::text[])`, [keyChunk]);
    for (const row of res.rows) idByKey.set(row.match_key, row.id);
  }

  // Backfill missing images on existing products whose image is empty/placeholder.
  const imageUpdates = [...byKey.values()].filter((r) => idByKey.has(r.matchKey) && r.imageUrl);
  for (const group of chunk(imageUpdates, PRODUCT_CHUNK_SIZE)) {
    await Promise.all(group.map((r) =>
      pool.query(
        `UPDATE products SET image_url=$1 WHERE id=$2 AND (image_url IS NULL OR image_url='' OR image_url LIKE 'https://placehold.co%')`,
        [r.imageUrl, idByKey.get(r.matchKey)]
      )
    ));
  }

  const toCreate = allKeys.filter((k) => !idByKey.has(k));
  let added = 0;
  for (const keyChunk of chunk(toCreate, PRODUCT_CHUNK_SIZE)) {
    const cols = ['brand_id', 'brand', 'product_name', 'category_id', 'category', 'image_url', 'match_key'];
    const values = [];
    const placeholders = keyChunk.map((key, i) => {
      const r = byKey.get(key);
      const base = i * cols.length;
      values.push(r.brandId, r.advertiserName, r.productName, r.catId, r.category || 'Beauty', r.imageUrl, r.matchKey);
      return `(${cols.map((_, j) => `$${base + j + 1}`).join(',')})`;
    }).join(',');
    // No ON CONFLICT here: products.match_key has a plain index but no
    // unique constraint (unlike offers.retailer+retailer_product_id,
    // which does), so ON CONFLICT would error at runtime. Safe without
    // it anyway — toCreate was already filtered against a fresh SELECT
    // above and de-duplicated by matchKey via the `byKey` Map, and this
    // script only ever runs one instance at a time.
    const ins = await pool.query(
      `INSERT INTO products (${cols.join(',')}) VALUES ${placeholders}
       RETURNING id, match_key`,
      values
    );
    for (const row of ins.rows) idByKey.set(row.match_key, row.id);
    added += ins.rows.length;
  }

  return { idByKey, added };
}

// Bulk-upserts offers in chunks instead of one INSERT ... ON CONFLICT per row.
async function upsertOffers(offerRows) {
  let updated = 0;
  const cols = ['product_id', 'retailer_id', 'retailer', 'retailer_product_id', 'price', 'sale_price', 'currency', 'availability', 'affiliate_url'];
  for (const group of chunk(offerRows, OFFER_CHUNK_SIZE)) {
    const values = [];
    const placeholders = group.map((o, i) => {
      const base = i * cols.length;
      values.push(o.productId, o.retailerId, o.retailerCode, o.merchantProductId, o.listPrice, o.salePrice, 'USD', o.availability, o.affiliateUrl);
      return `(${cols.map((_, j) => `$${base + j + 1}`).join(',')}, NOW())`;
    }).join(',');
    await pool.query(
      `INSERT INTO offers (${cols.join(',')}, last_updated) VALUES ${placeholders}
       ON CONFLICT (retailer, retailer_product_id)
       DO UPDATE SET price=EXCLUDED.price, sale_price=EXCLUDED.sale_price, availability=EXCLUDED.availability,
                      affiliate_url=EXCLUDED.affiliate_url, last_updated=NOW()`,
      values
    );
    updated += group.length;
  }
  return updated;
}

async function getOrCreateBrandId(name) {
  const norm = normalize(name);
  const res = await pool.query(`SELECT id FROM brands WHERE normalized_name=$1`, [norm]);
  if (res.rows.length) return res.rows[0].id;
  const ins = await pool.query(
    `INSERT INTO brands (name, normalized_name) VALUES ($1,$2) RETURNING id`,
    [name, norm]
  );
  return ins.rows[0].id;
}

async function syncAdvertiser(programme) {
  const { advertiser_id: advertiserId, advertiser_name: advertiserName, datafeed_id: datafeedId } = programme;
  if (!datafeedId) {
    console.log(`SKIP ${advertiserName} (${advertiserId}) — no datafeed_id on file`);
    return { added: 0, updated: 0, deactivated: 0 };
  }

  const retailerCode = `awin_${advertiserId}`;
  await pool.query(
    `INSERT INTO retailers (code, display_name, data_source, active)
     VALUES ($1,$2,'official_api',true)
     ON CONFLICT (code) DO UPDATE SET display_name=$2`,
    [retailerCode, `${advertiserName} (Awin)`]
  );
  const retailerRes = await pool.query(`SELECT id FROM retailers WHERE code=$1`, [retailerCode]);
  const retailerId = retailerRes.rows[0].id;

  const brandId = await getOrCreateBrandId(advertiserName);

  let rows;
  try {
    rows = await downloadFeed(datafeedId);
  } catch (e) {
    console.log(`ERROR downloading feed for ${advertiserName}: ${e.message}`);
    return { added: 0, updated: 0, deactivated: 0 };
  }
  console.log(`${advertiserName}: ${rows.length} rows in feed`);

  let skippedNoName = 0, skippedNoId = 0, skippedNoLink = 0, skippedNoPrice = 0;
  let sampleLogged = false;
  let rowIdx = -1;

  // Pass 1 (in memory, no DB calls): validate/parse every row.
  const validRows = [];
  for (const r of rows) {
    rowIdx++;
    const productName = pick(r, 'product_name', 'title', 'name', 'product_title');
    const merchantProductId = pick(r, 'merchant_product_id', 'aw_product_id', 'sku', 'product_id', 'id', 'mpn', 'item_id');
    const priceRaw = pick(r, 'search_price', 'display_price', 'store_price', 'price', 'sale_price', 'current_price');
    const priceStr = priceRaw.replace(/[^0-9.]/g, '');
    const price = parseFloat(priceStr);
    const rrpRaw = pick(r, 'rrp_price', 'msrp', 'list_price', 'was_price');
    const rrpStr = rrpRaw.replace(/[^0-9.]/g, '');
    const rrp = parseFloat(rrpStr);
    const hasDiscount = !isNaN(rrp) && !isNaN(price) && rrp > price + 0.01;
    const listPrice = hasDiscount ? rrp : price;
    const salePrice = hasDiscount ? price : null;
    const imageUrl = pick(r, 'merchant_image_url', 'aw_image_url', 'image_link', 'image_url', 'large_image');
    const readyAffiliateUrl = pick(r, 'aw_deep_link', 'awin_deep_link', 'tracking_url', 'affiliate_url');
    const destUrl = pick(r, 'merchant_deep_link', 'link', 'product_url', 'url');
    const category = pick(r, 'merchant_category', 'category_name', 'category', 'google_product_category', 'product_type');
    const inStock = pick(r, 'in_stock', 'stock_status', 'availability') || '1';
    const isInStock = !/^(0|false|out.?of.?stock|no|unavailable)$/i.test(inStock);

    if (!sampleLogged && rowIdx === 0) {
      console.log('  sample parsed row -> name:', JSON.stringify(productName), '| id:', JSON.stringify(merchantProductId),
        '| price:', JSON.stringify(priceRaw), '| link:', JSON.stringify(readyAffiliateUrl || destUrl));
      sampleLogged = true;
    }

    if (!productName) { skippedNoName++; continue; }
    if (!merchantProductId) { skippedNoId++; continue; }
    if (!readyAffiliateUrl && !destUrl) { skippedNoLink++; continue; }
    if (isNaN(price)) { skippedNoPrice++; continue; }

    const matchKey = normalize(`${advertiserName} ${productName}`);
    const affiliateUrl = readyAffiliateUrl || awinLink(advertiserId, destUrl);

    validRows.push({
      advertiserName, productName, category, imageUrl, matchKey, brandId,
      merchantProductId, listPrice, salePrice, affiliateUrl,
      availability: isInStock ? 'in_stock' : 'out_of_stock',
    });
  }

  if (!validRows.length) {
    console.log(`  -> 0 new, 0 updated, 0 marked out of stock`);
    if (skippedNoName || skippedNoId || skippedNoLink || skippedNoPrice) {
      console.log(`  -> skipped: ${skippedNoName} no name, ${skippedNoId} no product id, ${skippedNoLink} no link, ${skippedNoPrice} no valid price`);
    }
    return { added: 0, updated: 0, deactivated: 0 };
  }

  // Pass 2: resolve categories in bulk, then attach category ids.
  const catMap = await resolveCategoryIds(validRows.map((r) => r.category));
  for (const r of validRows) r.catId = catMap.get(r.category && r.category.trim() ? r.category.trim() : 'Beauty');

  // Pass 3: resolve/create products in bulk.
  const { idByKey, added } = await resolveProductIds(validRows);

  // Pass 4: bulk-upsert offers.
  const offerRows = validRows.map((r) => ({
    productId: idByKey.get(r.matchKey),
    retailerId, retailerCode,
    merchantProductId: r.merchantProductId,
    listPrice: r.listPrice, salePrice: r.salePrice,
    availability: r.availability, affiliateUrl: r.affiliateUrl,
  }));
  const updated = await upsertOffers(offerRows);

  const seenProductIds = validRows.map((r) => r.merchantProductId);
  let deactivated = 0;
  if (seenProductIds.length) {
    const staleRes = await pool.query(
      `UPDATE offers SET availability='out_of_stock', last_updated=NOW()
       WHERE retailer=$1 AND retailer_product_id <> ALL($2::text[]) AND availability <> 'out_of_stock'
       RETURNING id`,
      [retailerCode, seenProductIds]
    );
    deactivated = staleRes.rowCount;
  }

  console.log(`  -> ${added} new, ${updated} updated, ${deactivated} marked out of stock`);
  if (skippedNoName || skippedNoId || skippedNoLink || skippedNoPrice) {
    console.log(`  -> skipped: ${skippedNoName} no name, ${skippedNoId} no product id, ${skippedNoLink} no link, ${skippedNoPrice} no valid price`);
  }
  return { added, updated, deactivated };
}

async function main() {
  if (!AWIN_DATAFEED_APIKEY) {
    throw new Error('Missing AWIN_DATAFEED_APIKEY environment variable.');
  }
  const programmesRes = await pool.query(
    `SELECT advertiser_id, advertiser_name, datafeed_id FROM awin_programmes WHERE status='joined'`
  );
  console.log(`Syncing ${programmesRes.rows.length} joined Awin programme(s)...\n`);

  let totals = { added: 0, updated: 0, deactivated: 0 };
  for (const programme of programmesRes.rows) {
    const r = await syncAdvertiser(programme);
    totals.added += r.added;
    totals.updated += r.updated;
    totals.deactivated += r.deactivated;
  }

  console.log(`\nDone. Totals across all Awin programmes: ${totals.added} new, ${totals.updated} updated, ${totals.deactivated} marked out of stock.`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
