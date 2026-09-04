// BeautyPriceMatch.com — Impact.com product catalog sync (products + prices + stock).
//
// WHAT THIS DOES:
//   For every brand in IMPACT_CATALOGS below, downloads that brand's
//   official Impact.com Product Catalog via Impact's Web Services API
//   (the "Catalogs > Items" endpoint) and upserts it into products/offers,
//   exactly like awinSync.js does for Awin advertisers. This is Impact's
//   real, supported publisher-facing feed — merchant-maintained — not a
//   scrape.
//
//   Any offer that used to exist for a brand but is NOT in this run's
//   catalog gets marked availability='out_of_stock' (never deleted).
//
// REQUIRES (Railway service Variables tab — already set):
//   IMPACT_ACCOUNT_SID — from https://app.impact.com -> Settings/API ->
//                         Access Tokens -> "Enable Legacy Tokens" ->
//                         Credentials -> Account SID
//   IMPACT_AUTH_TOKEN  — same page, Auth Token
//   DATABASE_URL       — already set
//
// HOW TO RUN MANUALLY:
//   Upload to Railway Console -> Files panel, then: node impactSync.js
//
// Meant to run on a schedule alongside awinSync.js (see run-all.js).

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const IMPACT_ACCOUNT_SID = process.env.IMPACT_ACCOUNT_SID;
const IMPACT_AUTH_TOKEN = process.env.IMPACT_AUTH_TOKEN;

// When true (default for this run), only items with a real discount
// (OriginalPrice/ListPrice/Msrp higher than CurrentPrice) are imported.
// Run with DISCOUNTS_ONLY=false to bring in full catalogs including
// full-price items on a later pass.
const DISCOUNTS_ONLY = process.env.DISCOUNTS_ONLY !== 'false';

// Brands approved through Impact so far. `catalogId` comes from the
// "Product Catalogs" list in the Impact dashboard (Content -> Product
// Catalogs). Add a brand here only once its catalog actually appears in
// that list with real products in it.
const IMPACT_CATALOGS = [
  { retailerSlug: 'hilo', brandName: 'Hilo', catalogId: '34999' },
  { retailerSlug: 'et-al-beauty-collective', brandName: 'et al. Beauty Collective', catalogId: '35338' },
  { retailerSlug: 'sprout-living', brandName: 'Sprout Living', catalogId: '31472' },
  { retailerSlug: 'plantifique', brandName: 'Plantifique', catalogId: '34614' },
  { retailerSlug: 'terra-and-co', brandName: 'Terra & Co.', catalogId: '35332' },
  { retailerSlug: 'mom-aid', brandName: 'Mom Aid', catalogId: '36331' },
  // Luxeviora, Idun Rx: approved on Impact, but as of the last check no
  // catalog was listed under Content > Product Catalogs for these brands
  // yet (Impact catalogs are populated by the brand, not the publisher).
  // Add their catalogId here once one shows up in that list.
  // { retailerSlug: 'luxeviora', brandName: 'Luxeviora', catalogId: '' },
  // { retailerSlug: 'idun-rx', brandName: 'Idun Rx', catalogId: '' },
];

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function pick(obj, ...candidates) {
  for (const c of candidates) {
    const v = obj[c];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// Impact's JSON responses wrap the actual list under a resource-named key
// that varies by endpoint/account (e.g. "CatalogItems", "Items",
// "@catalogitems"). Rather than hard-code one shape, walk the response and
// return the first array of plain objects we find — robust to Impact's
// exact wrapper key.
function findItemArray(node) {
  if (Array.isArray(node)) {
    if (node.length && typeof node[0] === 'object' && node[0] !== null) return node;
    return null;
  }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      const found = findItemArray(node[key]);
      if (found) return found;
    }
  }
  return null;
}

async function fetchCatalogItems(catalogId) {
  const authHeader = 'Basic ' + Buffer.from(`${IMPACT_ACCOUNT_SID}:${IMPACT_AUTH_TOKEN}`).toString('base64');
  let items = [];
  let page = 1;
  const pageSize = 1000;
  for (;;) {
    const url = `https://api.impact.com/Mediapartners/${IMPACT_ACCOUNT_SID}/Catalogs/${catalogId}/Items` +
      `?PageSize=${pageSize}&Page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} fetching catalog ${catalogId} (page ${page}): ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    const pageItems = findItemArray(json) || [];
    if (page === 1) items = [];
    items = items.concat(pageItems);
    const totalPages = Number(pick(json, '@numpages', 'NumPages', 'TotalPages')) || 1;
    if (page === 1) {
      console.log(`  catalog ${catalogId}: reported ${totalPages} page(s) of results`);
    }
    if (pageItems.length < pageSize || page >= totalPages) break;
    page++;
  }
  return items;
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

async function syncCatalog({ retailerSlug, brandName, catalogId }) {
  const retailerCode = `impact_${retailerSlug}`;
  await pool.query(
    `INSERT INTO retailers (code, display_name, data_source, active)
     VALUES ($1,$2,'official_api',true)
     ON CONFLICT (code) DO UPDATE SET display_name=$2`,
    [retailerCode, `${brandName} (Impact)`]
  );
  const retailerRes = await pool.query(`SELECT id FROM retailers WHERE code=$1`, [retailerCode]);
  const retailerId = retailerRes.rows[0].id;

  const brandId = await getOrCreateBrandId(brandName);

  let rawItems;
  try {
    rawItems = await fetchCatalogItems(catalogId);
  } catch (e) {
    console.log(`ERROR downloading Impact catalog for ${brandName} (${catalogId}): ${e.message}`);
    return { added: 0, updated: 0, deactivated: 0 };
  }
  console.log(`${brandName}: ${rawItems.length} items in catalog ${catalogId}`);

  const seenProductIds = [];
  let added = 0, updated = 0;
  let skippedNoName = 0, skippedNoId = 0, skippedNoLink = 0, skippedNoPrice = 0, skippedNoDiscount = 0;
  let sampleLogged = false;

  for (const it of rawItems) {
    const productName = pick(it, 'Name', 'ItemName', 'ProductName', 'Title');
    const merchantProductId = pick(it, 'CatalogItemId', 'ItemId', 'Sku', 'SKU', 'Id', 'ProductId');
    const priceRaw = pick(it, 'CurrentPrice', 'Price', 'SalePrice', 'RetailPrice');
    const priceStr = priceRaw.replace(/[^0-9.]/g, '');
    const price = parseFloat(priceStr);
    const origRaw = pick(it, 'OriginalPrice', 'ListPrice', 'Msrp', 'RRP', 'WasPrice');
    const origStr = origRaw.replace(/[^0-9.]/g, '');
    const orig = parseFloat(origStr);
    const hasDiscount = !isNaN(orig) && !isNaN(price) && orig > price + 0.01;
    const listPrice = hasDiscount ? orig : price;
    const salePrice = hasDiscount ? price : null;
    const imageUrl = pick(it, 'ImageUrl', 'ImageURL', 'Image', 'ThumbnailUrl');
    const readyAffiliateUrl = pick(it, 'TrackingLink', 'TrackingUrl', 'AffiliateUrl', 'Url', 'ClickUrl');
    const category = pick(it, 'CategoryPath', 'Category', 'ProductType', 'GoogleProductCategory');
    const inStockRaw = pick(it, 'InStock', 'Availability', 'StockStatus') || 'true';
    const isInStock = !/^(0|false|out.?of.?stock|no|unavailable)$/i.test(inStockRaw);

    if (!sampleLogged) {
      console.log('  sample item keys:', Object.keys(it).join(', '));
      console.log('  sample parsed -> name:', JSON.stringify(productName), '| id:', JSON.stringify(merchantProductId),
        '| price:', JSON.stringify(priceRaw), '| link:', JSON.stringify(readyAffiliateUrl));
      sampleLogged = true;
    }

    if (!productName) { skippedNoName++; continue; }
    if (!merchantProductId) { skippedNoId++; continue; }
    if (!readyAffiliateUrl) { skippedNoLink++; continue; }
    if (isNaN(price)) { skippedNoPrice++; continue; }
    if (DISCOUNTS_ONLY && !hasDiscount) { skippedNoDiscount++; continue; }

    const catId = await getOrCreateCategoryId(category);
    const matchKey = normalize(`${brandName} ${productName}`);

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
        [brandId, brandName, productName, catId, category || 'Beauty', imageUrl, matchKey]
      );
      productId = ins.rows[0].id;
      added++;
    }

    await pool.query(
      `INSERT INTO offers (product_id, retailer_id, retailer, retailer_product_id, price, sale_price, currency, availability, affiliate_url, last_updated)
       VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,$8,NOW())
       ON CONFLICT (retailer, retailer_product_id)
       DO UPDATE SET price=$5, sale_price=$6, availability=$7, affiliate_url=$8, last_updated=NOW()`,
      [productId, retailerId, retailerCode, merchantProductId, listPrice, salePrice, isInStock ? 'in_stock' : 'out_of_stock', readyAffiliateUrl]
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
  if (skippedNoName || skippedNoId || skippedNoLink || skippedNoPrice || skippedNoDiscount) {
    console.log(`  -> skipped: ${skippedNoName} no name, ${skippedNoId} no product id, ${skippedNoLink} no link, ${skippedNoPrice} no valid price, ${skippedNoDiscount} no discount`);
  }
  return { added, updated, deactivated };
}

async function main() {
  if (!IMPACT_ACCOUNT_SID || !IMPACT_AUTH_TOKEN) {
    throw new Error('Missing IMPACT_ACCOUNT_SID / IMPACT_AUTH_TOKEN environment variable(s).');
  }
  console.log(`Syncing ${IMPACT_CATALOGS.length} Impact catalog(s)... (DISCOUNTS_ONLY=${DISCOUNTS_ONLY})\n`);

  let totals = { added: 0, updated: 0, deactivated: 0 };
  for (const cat of IMPACT_CATALOGS) {
    const r = await syncCatalog(cat);
    totals.added += r.added;
    totals.updated += r.updated;
    totals.deactivated += r.deactivated;
  }

  console.log(`\nDone. Totals across all Impact catalogs: ${totals.added} new, ${totals.updated} updated, ${totals.deactivated} marked out of stock.`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
