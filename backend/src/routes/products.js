import express from 'express';
import { pool } from '../db.js';

const router = express.Router();
const MAX_PRODUCT_ROWS = 5000;

// An offer whose price/availability hasn't been reconfirmed by its source
// (Amazon PA-API or an affiliate feed) in this long is not shown as a
// current deal — see services/productStore.js for how last_updated gets
// set (every successful sync touches it, even when the price didn't
// change), and README/DEPLOYMENT for how often syncs run.
const STALE_OFFER_HOURS = Number(process.env.STALE_OFFER_HOURS || 48);

function withFreshness(offer) {
const ageMs = Date.now() - new Date(offer.last_updated).getTime();
const isStale = ageMs > STALE_OFFER_HOURS * 60 * 60 * 1000;
return { ...offer, is_stale: isStale };
}

// An offer is "on sale" when its sale_price is a real, lower number than
// its (list/original) price — sale_price is only ever populated by a
// source that actually reports a discount (see services/productStore.js
// and awinSync.js's rrp_price handling), so this is never inferred, only
// read from what the retailer's own feed/API said.
function isOnSale(offer) {
return offer.sale_price != null
&& Number(offer.sale_price) > 0
&& offer.price != null
&& Number(offer.sale_price) < Number(offer.price);
}

// The price that actually applies right now — the sale price when the
// offer is genuinely on sale, otherwise the regular price. Every price
// comparison (best_price, cross-retailer savings, sort order) uses this
// so a discounted offer is correctly treated as cheaper than its own
// undiscounted list price.
function effectivePrice(offer) {
return isOnSale(offer) ? Number(offer.sale_price) : Number(offer.price);
}

function discountPercent(offer) {
if (!isOnSale(offer)) return 0;
return Math.round((1 - Number(offer.sale_price) / Number(offer.price)) * 100);
}

// Shapes one product + its offers into the response the frontend expects:
// `title`/`best_price`/`offers[]` (kept stable across the schema change so
// the existing UI needs no changes), plus explicit price-comparison fields
// per spec: lowest price, other retailer prices, price difference,
// savings percentage, availability, retailer, and affiliate URL. Stale
// offers are excluded from the "current" price comparison entirely (never
// presented as a live deal), but still returned (flagged) so the frontend
// could show "last checked X ago" if desired.
function shapeProduct(product, offers) {
const annotated = offers.map(withFreshness);
const current = annotated.filter((o) => !o.is_stale && o.availability !== 'out_of_stock' && o.price != null);
const sortedCurrent = [...current].sort((a, b) => effectivePrice(a) - effectivePrice(b));

const lowest = sortedCurrent[0] || null;
const highest = sortedCurrent[sortedCurrent.length - 1] || null;
const lowestPrice = lowest ? effectivePrice(lowest) : null;
const highestPrice = highest ? effectivePrice(highest) : null;
const savingsPct = lowest && highest && highestPrice > 0 && lowest.id !== highest.id
? Math.round((1 - lowestPrice / highestPrice) * 100)
: 0;
// The discount on the best (cheapest, currently-selected) offer itself —
// a genuine "this listing is marked down" signal, distinct from
// savings_percent above (which compares across different retailers).
const bestDiscountPct = lowest ? discountPercent(lowest) : 0;

return {
id: product.id,
brand: product.brand,
title: product.product_name,
product_name: product.product_name,
category: product.category,
subcategory: product.subcategory,
description: product.description,
upc: product.upc,
ean: product.ean,
gtin: product.gtin,
sku: product.sku,
size: product.size,
shade: product.shade,
image_url: product.image_url,
updated_at: product.updated_at,
best_price: lowest ? lowestPrice : null,
best_retailer: lowest ? lowest.retailer : null,
best_original_price: lowest && bestDiscountPct > 0 ? Number(lowest.price) : null,
discount_percent: bestDiscountPct,
savings_percent: savingsPct,
offer_count: current.length,
offers: annotated.map((o) => {
const onSale = isOnSale(o);
const oEffective = effectivePrice(o);
return {
id: o.id,
retailer: o.retailer,
price: o.price,
sale_price: o.sale_price,
effective_price: o.price != null ? oEffective : null,
original_price: onSale ? Number(o.price) : null,
discount_percent: discountPercent(o),
currency: o.currency,
availability: o.availability,
in_stock: o.availability === 'in_stock',
product_url: o.affiliate_url,
affiliate_url: o.affiliate_url,
last_updated: o.last_updated,
is_stale: o.is_stale,
price_difference: lowest && o.price != null ? Math.round((oEffective - lowestPrice) * 100) / 100 : null,
};
}),
};
}

// GET /api/products — search/filter/sort the central product catalog. The
// frontend never queries anything but this API — no retailer site is ever
// contacted directly by the client.
router.get('/', async (req, res) => {
try {
const { search, brand, category, minPrice, maxPrice, sort, limit, offset, includeUnavailable, retailer } = req.query;

let whereClause = 'WHERE 1=1';
const params = [];
let paramCount = 1;

// `retailer` may be a single code or a comma-separated list — a merchant
// can have more than one retailer code on file (e.g. a legacy one-off
// import script used a different code than the current Awin sync), and
// the frontend's "Best at X" filter pills need to match every code that
// resolves to the same displayed retailer name.
if (retailer) {
whereClause += ` AND EXISTS (
  SELECT 1 FROM offers o
  WHERE o.product_id = p.id
    AND o.retailer = ANY($${paramCount}::text[])
)`;
params.push(String(retailer).split(',').map((r) => r.trim()).filter(Boolean));
paramCount++;
}

if (search) {
whereClause += ` AND (p.product_name ILIKE $${paramCount} OR p.brand ILIKE $${paramCount})`;
params.push(`%${search}%`);
paramCount++;
}
if (brand) {
whereClause += ` AND p.brand = $${paramCount}`;
params.push(brand);
paramCount++;
}
if (category) {
whereClause += ` AND p.category = $${paramCount}`;
params.push(category);
paramCount++;
}

// Restrict to products with a live offer BEFORE the row cap below, not
// after — a sync run can touch thousands of out-of-stock rows in a row
// (they're processed in whatever order the source feed lists them), and
// filtering for availability only after limiting to the 5000 most
// recently-updated products meant a big out-of-stock batch could push
// every in-stock product out of that window, showing 0 results mid-sync
// even though plenty of products actually have a live price. Doing the
// filter in SQL, before LIMIT, avoids that.
if (!includeUnavailable) {
whereClause += ` AND EXISTS (
  SELECT 1 FROM offers o
  WHERE o.product_id = p.id
    AND o.availability = 'in_stock'
    AND o.price IS NOT NULL
    AND o.last_updated > NOW() - INTERVAL '${STALE_OFFER_HOURS} hours'
)`;
}

const { rows: products } = await pool.query(
`SELECT p.* FROM products p ${whereClause} ORDER BY p.updated_at DESC LIMIT ${MAX_PRODUCT_ROWS}`,
params
);

if (products.length === 0) {
return res.json({ products: [], total: 0 });
}

const ids = products.map((p) => p.id);
const { rows: offers } = await pool.query(
`SELECT * FROM offers WHERE product_id = ANY($1::int[]) ORDER BY price ASC NULLS LAST`,
[ids]
);
const offersByProduct = new Map();
for (const offer of offers) {
if (!offersByProduct.has(offer.product_id)) offersByProduct.set(offer.product_id, []);
offersByProduct.get(offer.product_id).push(offer);
}

let shaped = products.map((p) => shapeProduct(p, offersByProduct.get(p.id) || []));

// Hide products with no current (in-stock, non-stale) offer by default —
// a card with no price is dead weight in the grid ("Price unavailable"),
// so unless the caller explicitly asks for everything (?includeUnavailable=1,
// e.g. for an internal/admin view), only show products that actually have
// a live price right now. The row itself is never deleted — a future sync
// that brings the item back in stock makes it reappear automatically.
if (!includeUnavailable) {
shaped = shaped.filter((p) => p.best_price != null);
}

// best_price/minPrice/maxPrice filtering happens after shaping since
// best_price is computed (lowest non-stale, in-stock offer), not a
// stored column.
if (minPrice) shaped = shaped.filter((p) => p.best_price != null && p.best_price >= Number(minPrice));
if (maxPrice) shaped = shaped.filter((p) => p.best_price != null && p.best_price <= Number(maxPrice));

const withinGroupSort = sort === 'price_desc'
? (a, b) => (b.best_price ?? -1) - (a.best_price ?? -1)
: sort === 'rating'
? (a, b) => new Date(b.updated_at) - new Date(a.updated_at)
: (a, b) => (a.best_price ?? Infinity) - (b.best_price ?? Infinity);
// Products currently on a genuine sale (discount_percent > 0) always lead
// every view — every brand/retailer filter and every sort order — with
// whatever sort was requested only breaking ties within each group. This
// applies uniformly regardless of category/brand/retailer filtering above,
// since it runs on the already-filtered `shaped` list.
const sortFn = (a, b) => {
const aDeal = a.discount_percent > 0 ? 1 : 0;
const bDeal = b.discount_percent > 0 ? 1 : 0;
if (aDeal !== bDeal) return bDeal - aDeal;
return withinGroupSort(a, b);
};
shaped.sort(sortFn);

const pageLimit = Math.min(Number(limit) || 24, MAX_PRODUCT_ROWS);
const pageOffset = Number(offset) || 0;
const paged = shaped.slice(pageOffset, pageOffset + pageLimit);

res.json({ products: paged, total: shaped.length });
} catch (error) {
console.error('Error fetching products:', error);
res.status(500).json({ error: 'Failed to fetch products' });
}
});

// GET /api/products/:id — single product detail with full offer list,
// pulled entirely from the central database (products + offers). Detail
// pages still show even when currently out of stock (so "Price unavailable"
// with a "was $X" note is a reasonable thing to render there), unlike the
// list endpoint above which hides those cards entirely.
router.get('/:id', async (req, res) => {
try {
const { rows: productRows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
if (productRows.length === 0) return res.status(404).json({ error: 'Product not found' });

const { rows: offers } = await pool.query(
`SELECT * FROM offers WHERE product_id = $1 ORDER BY price ASC NULLS LAST`,
[req.params.id]
);
res.json(shapeProduct(productRows[0], offers));
} catch (error) {
console.error('Error fetching product:', error);
res.status(500).json({ error: 'Failed to fetch product' });
}
});

// GET /api/products/meta/brands — distinct brand list, for a filter dropdown.
router.get('/meta/brands', async (req, res) => {
try {
const { rows } = await pool.query(
`SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL ORDER BY brand LIMIT 500`
);
res.json({ brands: rows.map((r) => r.brand) });
} catch (error) {
console.error('Error fetching brands:', error);
res.status(500).json({ error: 'Failed to fetch brands' });
}
});

export default router;
