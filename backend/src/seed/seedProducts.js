import crypto from 'crypto';
import { pool } from '../db.js';
import { upsertProductOffer } from '../services/productStore.js';

// Realistic sample data so the site is demoable immediately, before any
// real Amazon PA-API credentials or affiliate feed access is set up.
// Clearly NOT real-time pricing — run `node src/seed/seedProducts.js` once
// against a fresh database, then swap to real provider syncs as retailer
// access comes online. Goes through the exact same central-database write
// path (services/productStore.js#upsertProductOffer) every real provider
// uses, so seeded data exercises the same product-matching/normalization
// logic real syncs will — including the "same product, different retailer
// naming" case (see the Maybelline entry below).
const SAMPLE_PRODUCTS = [
  { productName: 'Pro Filt\'r Soft Matte Longwear Foundation', brand: 'Fenty Beauty', category: 'Makeup', size: '32ml', shade: null, gtin: '810876030134',
    offers: [
      { retailer: 'sephora', price: 40.00, url: 'https://www.sephora.com/product/pro-filtr-soft-matte-longwear-foundation-P87985432' },
      { retailer: 'ulta', price: 40.00, url: 'https://www.ulta.com/p/pro-filtr-soft-matte-longwear-foundation' },
      { retailer: 'amazon', price: 38.50, url: 'https://www.amazon.com/dp/B074JQKD3F' },
    ] },
  { productName: 'Niacinamide 10% + Zinc 1%', brand: 'The Ordinary', category: 'Skincare', size: '30ml', shade: null, gtin: '769915190679',
    offers: [
      { retailer: 'ulta', price: 12.90, url: 'https://www.ulta.com/p/niacinamide-10pct-zinc-1pct' },
      { retailer: 'beautylish', price: 11.80, url: 'https://www.beautylish.com/s/the-ordinary-niacinamide' },
      { retailer: 'amazon', price: 13.20, url: 'https://www.amazon.com/dp/B01MDTVZTZ' },
    ] },
  { productName: 'Milky Jelly Cleanser', brand: 'Glossier', category: 'Skincare', size: '177ml', shade: null, gtin: null,
    offers: [
      { retailer: 'glossier', price: 20.00, url: 'https://www.glossier.com/products/milky-jelly-cleanser' },
      { retailer: 'cultbeauty', price: 22.00, url: 'https://www.cultbeauty.com/glossier-milky-jelly-cleanser.html' },
    ] },
  { productName: 'Lash Slick Mascara', brand: 'Glossier', category: 'Makeup', size: '7.5g', shade: null, gtin: null,
    offers: [
      { retailer: 'glossier', price: 20.00, url: 'https://www.glossier.com/products/lash-slick' },
      { retailer: 'sephora', price: 20.00, url: 'https://www.sephora.com/product/lash-slick-P471070' },
    ] },
  { productName: 'Advanced Night Repair Serum', brand: 'Estée Lauder', category: 'Skincare', size: '50ml', shade: null, gtin: '027131916009',
    offers: [
      { retailer: 'sephora', price: 98.00, url: 'https://www.sephora.com/product/advanced-night-repair-P225900' },
      { retailer: 'ulta', price: 98.00, url: 'https://www.ulta.com/p/advanced-night-repair-synchronized-recovery-complex-ii' },
      { retailer: 'amazon', price: 92.50, url: 'https://www.amazon.com/dp/B000WHZIOA' },
      { retailer: 'cultbeauty', price: 105.00, url: 'https://www.cultbeauty.com/estee-lauder-advanced-night-repair.html' },
    ] },
  { productName: 'Air Wrap Multi-Styler', brand: 'Dyson', category: 'Tools', size: null, shade: null, gtin: null,
    offers: [
      { retailer: 'sephora', price: 599.99, url: 'https://www.sephora.com/product/airwrap-P468194' },
      { retailer: 'ulta', price: 599.99, url: 'https://www.ulta.com/p/airwrap-multi-styler-complete-long' },
      { retailer: 'amazon', price: 579.99, url: 'https://www.amazon.com/dp/B08FCLK6XV' },
    ] },
  { productName: 'Soft Pinch Liquid Blush', brand: 'Rare Beauty', category: 'Makeup', size: '7.5ml', shade: null, gtin: null,
    offers: [
      { retailer: 'sephora', price: 23.00, url: 'https://www.sephora.com/product/soft-pinch-liquid-blush-P468520' },
      { retailer: 'amazon', price: 22.00, url: 'https://www.amazon.com/dp/B08HLZ71WW' },
    ] },
  { productName: 'Vitamin C Suspension 23% + HA Spheres 2%', brand: 'The Ordinary', category: 'Skincare', size: '30ml', shade: null, gtin: '769915174600',
    offers: [
      { retailer: 'ulta', price: 17.90, url: 'https://www.ulta.com/p/vitamin-c-suspension-23pct-ha-spheres-2pct' },
      { retailer: 'beautylish', price: 16.50, url: 'https://www.beautylish.com/s/the-ordinary-vitamin-c' },
      { retailer: 'cultbeauty', price: 18.50, url: 'https://www.cultbeauty.com/the-ordinary-vitamin-c-suspension.html' },
    ] },
  { productName: 'Original Exfoliation Foot Peel', brand: 'Baby Foot', category: 'Bath & Body', size: null, shade: null, gtin: null,
    offers: [
      { retailer: 'ulta', price: 25.00, url: 'https://www.ulta.com/p/original-exfoliation-foot-peel' },
      { retailer: 'amazon', price: 21.99, url: 'https://www.amazon.com/dp/B00PGX5MLY' },
    ] },
  { productName: 'Cloud Paint Blush', brand: 'Glossier', category: 'Makeup', size: '4g', shade: null, gtin: null,
    offers: [
      { retailer: 'glossier', price: 22.00, url: 'https://www.glossier.com/products/cloud-paint' },
      { retailer: 'sephora', price: 22.00, url: 'https://www.sephora.com/product/cloud-paint-P448426' },
    ] },
  // Demonstrates cross-retailer product-name normalization/matching: two
  // very differently worded titles for the identical shade, sharing a
  // GTIN, must collapse to ONE central product with three offers — this
  // is the exact example from the architecture spec.
  { productName: 'Super Stay Full Coverage Foundation', brand: 'Maybelline', category: 'Makeup', size: '30ml', shade: '128 Warm Nude', gtin: '041554449737',
    offers: [
      { retailer: 'amazon', price: 11.99, url: 'https://www.amazon.com/dp/B073SXHV3F', productName: 'Maybelline New York Super Stay Full Coverage Foundation 128 Warm Nude', shade: '128 Warm Nude' },
      { retailer: 'ulta', price: 10.99, url: 'https://www.ulta.com/p/super-stay-full-coverage-foundation-128-warm-nude', productName: 'Maybelline Super Stay Foundation - 128 Warm Nude', shade: '128 Warm Nude' },
    ] },
];

async function seed() {
  // Guard against accidentally running fabricated demo data into a live
  // production database real customers are looking at.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED_IN_PRODUCTION !== 'true') {
    console.error('Refusing to run seed data against a production database. Set ALLOW_SEED_IN_PRODUCTION=true if you really mean it.');
    process.exit(1);
  }

  console.log('🌱 Seeding sample products through the central product database write path...');
  let stored = 0;
  let productsCreated = 0;
  for (const product of SAMPLE_PRODUCTS) {
    for (const offer of product.offers) {
      const retailerProductId = `seed-${offer.retailer}-${crypto.createHash('sha1').update(offer.url).digest('hex').slice(0, 16)}`;
      const result = await upsertProductOffer({
        retailer: offer.retailer,
        retailerProductId,
        retailerSku: retailerProductId,
        productName: offer.productName || product.productName,
        brand: product.brand,
        category: product.category,
        description: '',
        imageUrl: null,
        gtin: product.gtin,
        upc: null,
        ean: null,
        sku: null,
        size: product.size,
        shade: offer.shade || product.shade,
        price: offer.price,
        salePrice: null,
        currency: 'USD',
        availability: 'in_stock',
        affiliateUrl: offer.url,
      });
      if (result) {
        stored++;
        if (result.productCreated) productsCreated++;
      }
    }
  }
  console.log(`Stored ${stored} sample offers, creating ${productsCreated} central product rows (fewer than ${SAMPLE_PRODUCTS.length + 1} source entries thanks to GTIN-based matching on the Maybelline example).`);
  console.log('✅ Seed complete.');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
