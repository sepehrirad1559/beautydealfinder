// The ONLY write path into the central product database. Every provider
// (Amazon PA-API, an affiliate network feed) funnels its normalized items
// through `upsertProductOffer` here — this is what implements "one central
// product -> many retailer offers" and prevents duplicate product rows.
//
// Product-matching priority (per spec):
//   1. GTIN   2. UPC   3. EAN   4. retailer_product_id (existing offer)
//   5. brand + normalized product name + shade + size (match_key)
//
// A GTIN/UPC/EAN match is authoritative and wins even if the brand/name
// text differs across retailers (that's the whole point — "Maybelline New
// York Super Stay Full Coverage Foundation 128 Warm Nude" from Amazon and
// "Maybelline Super Stay Foundation - 128 Warm Nude" from Ulta share a
// barcode and must land on the same product row).
import { pool } from '../db.js';
import { buildMatchKey, normalizeBrand, normalizeBrandKey, normalizeCategory, normalizeProductName, normalizeSize, normalizeShade } from './normalize.js';

async function findOrCreateBrand(client, brandName) {
  const normalized = normalizeBrand(brandName);
  if (!normalized) return null;
  const key = normalizeBrandKey(brandName);
  const existing = await client.query('SELECT id, name FROM brands WHERE normalized_name = $1', [key]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const inserted = await client.query(
    'INSERT INTO brands (name, normalized_name) VALUES ($1,$2) ON CONFLICT (normalized_name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
    [normalized, key]
  );
  return inserted.rows[0].id;
}

async function findOrCreateCategory(client, categoryName) {
  const normalized = normalizeCategory(categoryName);
  const existing = await client.query('SELECT id FROM categories WHERE name = $1', [normalized]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const inserted = await client.query(
    'INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
    [normalized]
  );
  return inserted.rows[0].id;
}

// Finds an existing central product for this normalized item, trying each
// identifier tier in priority order. Returns the product row or null.
async function findExistingProduct(client, item) {
  if (item.gtin) {
    const r = await client.query('SELECT * FROM products WHERE gtin = $1 LIMIT 1', [item.gtin]);
    if (r.rows.length > 0) return r.rows[0];
  }
  if (item.upc) {
    const r = await client.query('SELECT * FROM products WHERE upc = $1 LIMIT 1', [item.upc]);
    if (r.rows.length > 0) return r.rows[0];
  }
  if (item.ean) {
    const r = await client.query('SELECT * FROM products WHERE ean = $1 LIMIT 1', [item.ean]);
    if (r.rows.length > 0) return r.rows[0];
  }
  // Tier 4: this exact retailer+retailer_product_id already has an offer
  // row pointing at a product — re-syncing the same listing must update
  // the same product, not create a sibling.
  if (item.retailer && item.retailerProductId) {
    const r = await client.query(
      `SELECT p.* FROM products p JOIN offers o ON o.product_id = p.id
       WHERE o.retailer = $1 AND o.retailer_product_id = $2 LIMIT 1`,
      [item.retailer, item.retailerProductId]
    );
    if (r.rows.length > 0) return r.rows[0];
  }
  // Tier 5: brand + normalized name + shade + size fallback key.
  const matchKey = buildMatchKey({ brand: item.brand, productName: item.productName, shade: item.shade, size: item.size });
  if (matchKey) {
    const r = await client.query('SELECT * FROM products WHERE match_key = $1 LIMIT 1', [matchKey]);
    if (r.rows.length > 0) return r.rows[0];
  }
  return null;
}

// Fills in any identifier/attribute the existing product row is missing
// with a value this newer item provides, without ever erasing data
// already on file (e.g. one retailer's feed has GTIN, another doesn't —
// keep the GTIN once we have it).
async function backfillProductFields(client, existing, item) {
  const updates = {};
  if (!existing.gtin && item.gtin) updates.gtin = item.gtin;
  if (!existing.upc && item.upc) updates.upc = item.upc;
  if (!existing.ean && item.ean) updates.ean = item.ean;
  if (!existing.sku && item.sku) updates.sku = item.sku;
  if (!existing.image_url && item.imageUrl) updates.image_url = item.imageUrl;
  if (!existing.description && item.description) updates.description = item.description;
  if (!existing.shade && item.shade) updates.shade = normalizeShade(item.shade);
  if (!existing.size && item.size) updates.size = normalizeSize(item.size) || item.size;
  if (!existing.subcategory && item.subcategory) updates.subcategory = item.subcategory;

  const keys = Object.keys(updates);
  if (keys.length === 0) return existing;

  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const result = await client.query(
    `UPDATE products SET ${setClause}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`,
    [...keys.map((k) => updates[k]), existing.id]
  );
  return result.rows[0];
}

async function createProduct(client, item) {
  const brandId = await findOrCreateBrand(client, item.brand);
  const categoryId = await findOrCreateCategory(client, item.category);
  const brand = normalizeBrand(item.brand);
  const category = normalizeCategory(item.category);
  const productName = normalizeProductName(item.productName);
  const size = normalizeSize(item.size) || item.size || null;
  const shade = normalizeShade(item.shade);
  const matchKey = buildMatchKey({ brand: item.brand, productName: item.productName, shade: item.shade, size: item.size });

  const result = await client.query(
    `INSERT INTO products (
      brand_id, brand, product_name, category_id, category, subcategory, description,
      upc, ean, gtin, sku, size, shade, image_url, match_key
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    RETURNING *`,
    [brandId, brand, productName, categoryId, category, item.subcategory || null, item.description || null,
     item.upc || null, item.ean || null, item.gtin || null, item.sku || null, size, shade, item.imageUrl || null, matchKey]
  );
  return result.rows[0];
}

async function findOrCreateRetailer(client, code) {
  const r = await client.query('SELECT id FROM retailers WHERE code = $1', [code]);
  if (r.rows.length > 0) return r.rows[0].id;
  const inserted = await client.query(
    `INSERT INTO retailers (code, display_name, data_source, active) VALUES ($1,$2,'affiliate_feed', true)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    [code, code]
  );
  return inserted.rows[0].id;
}

async function upsertOffer(client, productId, item) {
  const retailerId = await findOrCreateRetailer(client, item.retailer);
  const existing = await client.query(
    'SELECT * FROM offers WHERE retailer = $1 AND retailer_product_id = $2',
    [item.retailer, item.retailerProductId]
  );

  let offer;
  const priceChanged = existing.rows.length === 0
    || Number(existing.rows[0].price) !== Number(item.price)
    || Number(existing.rows[0].sale_price || 0) !== Number(item.salePrice || 0)
    || existing.rows[0].availability !== item.availability;

  if (existing.rows.length > 0) {
    const result = await client.query(
      `UPDATE offers SET product_id = $1, retailer_id = $2, retailer_sku = $3, price = $4, sale_price = $5,
         currency = $6, availability = $7, affiliate_url = $8, last_updated = NOW(), updated_at = NOW()
       WHERE id = $9 RETURNING *`,
      [productId, retailerId, item.retailerSku || null, item.price, item.salePrice || null,
       item.currency || 'USD', item.availability, item.affiliateUrl, existing.rows[0].id]
    );
    offer = result.rows[0];
  } else {
    const result = await client.query(
      `INSERT INTO offers (
        product_id, retailer_id, retailer, retailer_product_id, retailer_sku, price, sale_price,
        currency, availability, affiliate_url, last_updated
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      RETURNING *`,
      [productId, retailerId, item.retailer, item.retailerProductId, item.retailerSku || null,
       item.price, item.salePrice || null, item.currency || 'USD', item.availability, item.affiliateUrl]
    );
    offer = result.rows[0];
  }

  if (priceChanged) {
    await client.query(
      'INSERT INTO price_history (offer_id, price, sale_price, availability) VALUES ($1,$2,$3,$4)',
      [offer.id, offer.price, offer.sale_price, offer.availability]
    );
  }

  return offer;
}

// item shape (all providers normalize into this before calling this
// function — see providers/AmazonProvider.js and
// providers/AffiliateFeedProvider.js):
//   {
//     retailer, retailerProductId, retailerSku,
//     brand, productName, category, subcategory, description,
//     gtin, upc, ean, sku, size, shade, imageUrl,
//     price, salePrice, currency, availability, affiliateUrl,
//   }
export async function upsertProductOffer(item) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let product = await findExistingProduct(client, item);
    let created = false;
    if (product) {
      product = await backfillProductFields(client, product, item);
    } else {
      product = await createProduct(client, item);
      created = true;
    }

    const offer = await upsertOffer(client, product.id, item);

    await client.query('COMMIT');
    return { product, offer, productCreated: created };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('upsertProductOffer failed:', error);
    return null;
  } finally {
    client.release();
  }
}

export default { upsertProductOffer };
