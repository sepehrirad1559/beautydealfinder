// BeautyPriceMatch.com — Awin datafeed sync (products + prices + stock).
//
// WHAT THIS DOES:
//   For every advertiser in the `awin_programmes` table with status
//   'joined' and a known datafeed_id (populated automatically by
//   awinProgrammeChecker.js), this downloads that advertiser's official
//   product datafeed straight from Awin's Product Data feed service and
//   upserts it into products/offers. This is the real, supported source
//   of truth Awin gives publishers — merchant-maintained, refreshed
//   daily on their end — so prices, new prod// BeautyPriceMatch.com — Awin datafeed sync (products + prices + stock).
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

import { Pool } from 'pg';
import zlib from 'zlib';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const AWIN_DATAFEED_APIKEY = process.env.AWIN_DATAFEED_APIKEY;
const AWIN_AFFID = process.env.AWIN_AFFID || '3062047';

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

async function getOrCreateCategoryId(name) {
  const catName = name && name.trim() ? name.trim() : 'Beauty';
  const res = await pool.query(`SELECT id FROM categories WHERE name=$1`, [catName]);
  if (res.rows.length) return res.rows[0].id;
  const ins = await pool.query(`INSERT INTO categories (name) VALUES ($1) RETURNING id`, [catName]);
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

  const seenProductIds = [];
  let added = 0, updated = 0;

  let skippedNoName = 0, skippedNoId = 0, skippedNoLink = 0, skippedNoPrice = 0;
  let sampleLogged = false;
  let rowIdx = -1;

  for (const r of rows) {
    rowIdx++;
    const productName = pick(r, 'product_name', 'title', 'name', 'product_title');
    const merchantProductId = pick(r, 'merchant_product_id', 'aw_product_id', 'sku', 'product_id', 'id', 'mpn', 'item_id');
    const priceRaw = pick(r, 'search_price', 'display_price', 'store_price', 'price', 'sale_price', 'current_price');
    const priceStr = priceRaw.replace(/[^0-9.]/g, '');
    const price = parseFloat(priceStr);
    // rrp_price is Awin's standard "recommended retail price" column — when
    // a merchant reports one that's genuinely higher than the current
    // selling price, that's a real, source-reported discount (never
    // inferred/estimated here). price stays the original/RRP, sale_price
    // becomes the current lower price, matching the price/sale_price
    // convention used everywhere else (see productStore.js).
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

    const catId = await getOrCreateCategoryId(category);
    const matchKey = normalize(`${advertiserName} ${productName}`);

    let prodRes = await pool.query(`SELECT id FROM products WHERE match_key=$1`, [matchKey]);
    let productId;
    if (prodRes.rows.length) {
      productId = prodRes.rows[0].id;
      if (imageUrl) {
        await pool.query(`UPDATE products SET image_url=$1 WHERE id=$2 AND (image_url IS NULL OR image_url='' OR image_url LIKE 'https://placehold.co%')`, [imageUrl, productId]);
      }
    } else {
      const ins = await pool.query(
        `INSERT INTO products (brand_id, brand, product_name, category_id, category, image_url, match_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [brandId, advertiserName, productName, catId, category || 'Beauty', imageUrl, matchKey]
      );
      productId = ins.rows[0].id;
      added++;
    }

    const affiliateUrl = readyAffiliateUrl || awinLink(advertiserId, destUrl);
    await pool.query(
      `INSERT INTO offers (product_id, retailer_id, retailer, retailer_product_id, price, sale_price, currency, availability, affiliate_url, last_updated)
       VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,$8,NOW())
       ON CONFLICT (retailer, retailer_product_id)
       DO UPDATE SET price=$5, sale_price=$6, availability=$7, affiliate_url=$8, last_updated=NOW()`,
      [productId, retailerId, retailerCode, merchantProductId, listPrice, salePrice, isInStock ? 'in_stock' : 'out_of_stock', affiliateUrl]
    );
    seenProductIds.push(merchantProductId);
    updated++;
  }

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
ucts, and out-of-stock
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

import { Pool } from 'pg';
import zlib from 'zlib';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const AWIN_DATAFEED_APIKEY = process.env.AWIN_DATAFEED_APIKEY;
const AWIN_AFFID = process.env.AWIN_AFFID || '3062047';

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
  'data_feed_id', 'in_stock',
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

async function getOrCreateCategoryId(name) {
  const catName = name && name.trim() ? name.trim() : 'Beauty';
  const res = await pool.query(`SELECT id FROM categories WHERE name=$1`, [catName]);
  if (res.rows.length) return res.rows[0].id;
  const ins = await pool.query(`INSERT INTO categories (name) VALUES ($1) RETURNING id`, [catName]);
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

  const seenProductIds = [];
  let added = 0, updated = 0;

  let skippedNoName = 0, skippedNoId = 0, skippedNoLink = 0, skippedNoPrice = 0;
  let sampleLogged = false;
  let rowIdx = -1;

  for (const r of rows) {
    rowIdx++;
    const productName = pick(r, 'product_name', 'title', 'name', 'product_title');
    const merchantProductId = pick(r, 'merchant_product_id', 'aw_product_id', 'sku', 'product_id', 'id', 'mpn', 'item_id');
    const priceRaw = pick(r, 'search_price', 'display_price', 'store_price', 'price', 'sale_price', 'current_price');
    const priceStr = priceRaw.replace(/[^0-9.]/g, '');
    const price = parseFloat(priceStr);
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

    const catId = await getOrCreateCategoryId(category);
    const matchKey = normalize(`${advertiserName} ${productName}`);

    let prodRes = await pool.query(`SELECT id FROM products WHERE match_key=$1`, [matchKey]);
    let productId;
    if (prodRes.rows.length) {
      productId = prodRes.rows[0].id;
      if (imageUrl) {
        await pool.query(`UPDATE products SET image_url=$1 WHERE id=$2 AND (image_url IS NULL OR image_url='' OR image_url LIKE 'https://placehold.co%')`, [imageUrl, productId]);
      }
    } else {
      const ins = await pool.query(
        `INSERT INTO products (brand_id, brand, product_name, category_id, category, image_url, match_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [brandId, advertiserName, productName, catId, category || 'Beauty', imageUrl, matchKey]
      );
      productId = ins.rows[0].id;
      added++;
    }

    const affiliateUrl = readyAffiliateUrl || awinLink(advertiserId, destUrl);
    await pool.query(
      `INSERT INTO offers (product_id, retailer_id, retailer, retailer_product_id, price, currency, availability, affiliate_url, last_updated)
       VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,NOW())
       ON CONFLICT (retailer, retailer_product_id)
       DO UPDATE SET price=$5, availability=$6, affiliate_url=$7, last_updated=NOW()`,
      [productId, retailerId, retailerCode, merchantProductId, price, isInStock ? 'in_stock' : 'out_of_stock', affiliateUrl]
    );
    seenProductIds.push(merchantProductId);
    updated++;
  }

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
