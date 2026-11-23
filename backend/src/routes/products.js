import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 200;
const STALE_OFFER_HOURS = Number(process.env.STALE_OFFER_HOURS || 48);

function withFreshness(offer) {
    const ageMs = Date.now() - new Date(offer.last_updated).getTime();
    const isStale = ageMs > STALE_OFFER_HOURS * 60 * 60 * 1000;
    return { ...offer, is_stale: isStale };
}

function isOnSale(offer) {
    return offer.sale_price != null
      && Number(offer.sale_price) > 0
      && offer.price != null
      && Number(offer.sale_price) < Number(offer.price);
}

function effectivePrice(offer) {
    return isOnSale(offer) ? Number(offer.sale_price) : Number(offer.price);
}

function discountPercent(offer) {
    if (!isOnSale(offer)) return 0;
    return Math.round((1 - Number(offer.sale_price) / Number(offer.price)) * 100);
}

function dedupeOffersByRetailer(annotated) {
    const byRetailer = new Map();
    const score = (o) => (o.is_stale ? 0 : 4) + (o.availability === 'in_stock' ? 2 : 0) + (o.price != null ? 1 : 0);
    for (const o of annotated) {
          const existing = byRetailer.get(o.retailer);
          if (!existing) { byRetailer.set(o.retailer, o); continue; }
          const sExisting = score(existing);
          const sNew = score(o);
          if (sNew > sExisting) { byRetailer.set(o.retailer, o); continue; }
          if (sNew < sExisting) continue;
          const existingPrice = existing.price != null ? Number(existing.sale_price || existing.price) : Infinity;
          const newPrice = o.price != null ? Number(o.sale_price || o.price) : Infinity;
          if (newPrice < existingPrice) { byRetailer.set(o.retailer, o); continue; }
          if (newPrice === existingPrice && new Date(o.last_updated) > new Date(existing.last_updated)) {
                  byRetailer.set(o.retailer, o);
          }
    }
    return [...byRetailer.values()];
}

function shapeProduct(product, offers) {
    const annotated = dedupeOffersByRetailer(offers.map(withFreshness));
    const current = annotated.filter((o) => !o.is_stale && o.availability !== 'out_of_stock' && o.price != null);
    const sortedCurrent = [...current].sort((a, b) => effectivePrice(a) - effectivePrice(b));

  const lowest = sortedCurrent[0] || null;
    const highest = sortedCurrent[sortedCurrent.length - 1] || null;
    const lowestPrice = lowest ? effectivePrice(lowest) : null;
    const highestPrice = highest ? effectivePrice(highest) : null;
    const savingsPct = lowest && highest && highestPrice > 0 && lowest.id !== highest.id
      ? Math.round((1 - lowestPrice / highestPrice) * 100)
          : 0;
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

const HAIR_WIG_RETAILERS = ['awin_102013', 'zlikehair'];

function buildFilters(query) {
    const { search, brand, category, retailer, categoryGroup, includeUnavailable } = query;
    const params = [];
    const add = (v) => { params.push(v); return `$${params.length}`; };
    let where = 'WHERE 1=1';

  if (categoryGroup === 'makeup') {
        where += ` AND p.category = ${add('Makeup')}`;
  } else if (categoryGroup === 'skincare') {
        where += ` AND p.category = ${add('Skincare')}`;
  } else if (categoryGroup === 'hair') {
        where += ` AND (p.category = ${add('Haircare')} OR EXISTS (
              SELECT 1 FROM offers ohw WHERE ohw.product_id = p.id AND ohw.retailer = ANY(${add(HAIR_WIG_RETAILERS)}::text[])
                  ))`;
  }

  if (retailer) {
        const codes = String(retailer).split(',').map((r) => r.trim()).filter(Boolean);
        where += ` AND EXISTS (
              SELECT 1 FROM offers ort WHERE ort.product_id = p.id AND ort.retailer = ANY(${add(codes)}::text[])
                  )`;
  }

  if (search) where += ` AND (p.product_name ILIKE ${add(`%${search}%`)} OR p.brand ILIKE ${add(`%${search}%`)})`;
    if (brand) where += ` AND p.brand = ${add(brand)}`;
    if (category) where += ` AND p.category = ${add(category)}`;

  if (!includeUnavailable && categoryGroup === 'deals') {
        where += ' AND b.discount_percent > 0';
  }

  return { where, params, add };
}

router.get('/', async (req, res) => {
    try {
          const { minPrice, maxPrice, sort, limit, offset, includeUnavailable } = req.query;
          const includeAll = !!includeUnavailable;

      const { where, params, add } = buildFilters(req.query);

      const staleHoursParam = add(STALE_OFFER_HOURS);
          const bestOfferCte = `
                SELECT DISTINCT ON (o.product_id)
                        o.product_id, o.retailer, o.price, o.sale_price, o.discount_percent, o.last_updated,
                                COALESCE(o.sale_price, o.price) AS effective_price
                                      FROM offers o
                                            WHERE o.availability = 'in_stock' AND o.price IS NOT NULL
                                                    AND o.last_updated > NOW() - (${staleHoursParam} || ' hours')::interval
                                                          ORDER BY o.product_id, COALESCE(o.sale_price, o.price) ASC, o.last_updated DESC
                                                              `;

      const joinType = includeAll ? 'LEFT JOIN' : 'JOIN';
          let where2 = where;
          if (minPrice) where2 += ` AND b.effective_price >= ${add(Number(minPrice))}`;
          if (maxPrice) where2 += ` AND b.effective_price <= ${add(Number(maxPrice))}`;

      const sortExpr = sort === 'price_desc'
            ? 'b.effective_price DESC NULLS LAST'
              : sort === 'rating'
              ? 'p.updated_at DESC'
                : 'b.effective_price ASC NULLS LAST';
          const orderBy = `ORDER BY (COALESCE(b.discount_percent, 0) > 0) DESC, ${sortExpr}`;

      const pageLimit = Math.min(Number(limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
          const pageOffset = Math.max(Number(offset) || 0, 0);
          const limitParam = add(pageLimit);
          const offsetParam = add(pageOffset);

      const baseFrom = `
            FROM products p
                  ${joinType} (${bestOfferCte}) b ON b.product_id = p.id
                        ${where2}
                            `;

      const [{ rows: products }, { rows: countRows }] = await Promise.all([
              pool.query(
                        `SELECT p.*, b.effective_price AS best_price, b.retailer AS best_retailer,
                                        b.price AS best_list_price, COALESCE(b.discount_percent, 0) AS best_discount_percent
                                                 ${baseFrom}
                                                          ${orderBy}
                                                                   LIMIT ${limitParam} OFFSET ${offsetParam}`,
                        params
                      ),
              pool.query(`SELECT COUNT(*) AS total ${baseFrom}`, params.slice(0, params.length - 2)),
            ]);

      const total = Number(countRows[0]?.total || 0);

      if (products.length === 0) {
              return res.json({ products: [], total });
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

      const shaped = products.map((p) => shapeProduct(p, offersByProduct.get(p.id) || []));

      res.json({ products: shaped, total });
    } catch (error) {
          console.error('Error fetching products:', error);
          res.status(500).json({ error: 'Failed to fetch products' });
    }
});

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

router.get('/meta/categories', async (req, res) => {
    try {
          const { rows } = await pool.query(
                  `SELECT category, COUNT(*) AS count FROM products WHERE category IS NOT NULL GROUP BY category ORDER BY category`
                );
          res.json({ categories: rows.map((r) => ({ name: r.category, count: Number(r.count) })) });
    } catch (error) {
          console.error('Error fetching categories:', error);
          res.status(500).json({ error: 'Failed to fetch categories' });
    }
});

export default router;
