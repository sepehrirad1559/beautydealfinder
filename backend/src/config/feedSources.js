// Configuration for retailers ingested via an affiliate network's official
// product feed (see providers/AffiliateFeedProvider.js). This is the ONLY
// non-Amazon data path in this codebase — there is no scraper, no HTML
// parser, no browser automation, and no "unofficial API" client anywhere
// in the project. A retailer with no public API (Sephora, Ulta,
// Beautylish, Glossier, Cult Beauty) gets into the central database
// exclusively by applying to its affiliate program (most run through
// Rakuten Advertising, CJ Affiliate, Awin, ShareASale, or Impact) and
// configuring that program's feed here once approved.
//
// Deliberately empty by default. Add an entry only once you have real
// credentials/a feed URL from an approved affiliate program — do not
// invent one to "fill in" a retailer.
//
// Each entry:
//   {
//     retailer: 'sephora',            // must match retailers.code
//     network: 'rakuten',             // 'rakuten' | 'cj' | 'awin' | 'shareasale' | 'impact'
//     feedUrl: process.env.SEPHORA_FEED_URL,   // network-provided feed URL (CSV or JSON), read via HTTPS from the network's own servers — not the retailer's site
//     feedFormat: 'csv',              // 'csv' | 'json'
//     fieldMap: {                     // maps the feed's own column/field names to our normalized item shape
//       retailerProductId: 'sku',
//       productName: 'product_name',
//       brand: 'brand_name',
//       price: 'price',
//       salePrice: 'sale_price',
//       availability: 'in_stock',
//       imageUrl: 'image_url',
//       affiliateUrl: 'buy_url',       // the network's own pre-built tracking link — never hand-constructed
//       gtin: 'gtin',
//       upc: 'upc',
//       ean: 'ean',
//     },
//   }
export const FEED_SOURCES = [];

export default FEED_SOURCES;
