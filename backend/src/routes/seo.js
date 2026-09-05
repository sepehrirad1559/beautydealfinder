import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

// Thresholds mirror the SEO strategy doc exactly (Parts 3, 6, 7) — this
// route is the single source of truth for "is this page worth asking
// Google to index", consumed by both the frontend's client-side
// noindex/index meta tag (see frontend/src/pages/*.jsx) and the sitemap
// generator (frontend/api/sitemap.js). A page that fails the gate simply
// isn't in the arrays below, so it can never end up in the sitemap even if
// someone forgets to check the flag somewhere else.
const MIN_BRAND_PRODUCTS = 3;
const MIN_CATEGORY_PRODUCTS_FOR_INDEX = 10;
const STALE_OFFER_HOURS = Number(process.env.STALE_OFFER_HOURS || 48);

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

// GET /api/seo/sitemap-data — every indexable product/brand/category URL,
// computed live from the same offer-freshness rule the product API uses
// (an offer older than STALE_OFFER_HOURS doesn't count as a live price),
// so a product that's gone stale drops out of the sitemap on its own
// without needing a separate cleanup job.
router.get('/sitemap-data', async (req, res) => {
  try {
    const { rows: products } = await pool.query(`
      SELECT p.id, p.brand, p.product_name, p.description, p.updated_at,
             COUNT(o.id) FILTER (
               WHERE o.availability = 'in_stock' AND o.price IS NOT NULL
                 AND o.last_updated > NOW() - INTERVAL '${STALE_OFFER_HOURS} hours'
             ) AS live_offer_count
      FROM products p
      LEFT JOIN offers o ON o.product_id = p.id
      GROUP BY p.id
    `);

    const indexableProducts = products.filter(
      (p) => Number(p.live_offer_count) >= 2 || (p.description && p.description.length > 40)
    );

    const { rows: brandRows } = await pool.query(
      `SELECT brand, COUNT(*) AS count FROM products WHERE brand IS NOT NULL GROUP BY brand HAVING COUNT(*) >= $1`,
      [MIN_BRAND_PRODUCTS]
    );

    const { rows: categoryRows } = await pool.query(
      `SELECT category, COUNT(*) AS count FROM products WHERE category IS NOT NULL GROUP BY category HAVING COUNT(*) >= $1`,
      [MIN_CATEGORY_PRODUCTS_FOR_INDEX]
    );

    res.json({
      products: indexableProducts.map((p) => ({
        path: `/p/${slugify(p.brand)}/${slugify(p.product_name)}-${p.id}`,
        updatedAt: p.updated_at ? new Date(p.updated_at).toISOString().slice(0, 10) : undefined,
      })),
      brands: brandRows.map((b) => ({ path: `/brand/${slugify(b.brand)}` })),
      categories: categoryRows.map((c) => ({ path: `/category/${slugify(c.category)}` })),
    });
  } catch (error) {
    console.error('Error building sitemap data:', error);
    res.status(500).json({ error: 'Failed to build sitemap data' });
  }
});

export default router;

