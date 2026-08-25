// Ingests an affiliate network's own official product feed — a file the
// network generates and hosts for its approved affiliates, in CSV or JSON,
// containing that retailer's current catalog/pricing. This is the
// legitimate, ToS-compliant path for the five retailers with no public
// product API (Sephora, Ulta, Beautylish, Glossier, Cult Beauty): apply to
// the retailer's affiliate program (Rakuten Advertising, CJ Affiliate,
// Awin, ShareASale, or Impact all offer one), get approved, and the
// network hands you a feed URL/credentials.
//
// This module does NOT fetch retailer web pages, does NOT parse HTML, and
// does NOT read structured data (JSON-LD or otherwise) out of a retailer's
// own site. It only reads the feed file the network itself serves at
// `feedUrl`. If that's ever pointed at something other than an actual
// affiliate network endpoint, that's a misconfiguration to fix, not a
// sanctioned use of this module.
import axios from 'axios';
import { normalizeIdentifier, normalizeCurrency, normalizePrice, normalizeAvailability } from './normalize.js';
import { upsertProductOffer } from './productStore.js';

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i]; });
    return row;
  });
}

// Minimal RFC4180-ish CSV line splitter — handles quoted fields containing
// commas, which real product feeds (titles/descriptions) commonly have.
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function mapRow(row, fieldMap) {
  const get = (key) => (fieldMap[key] ? row[fieldMap[key]] : undefined);
  return {
    retailerProductId: get('retailerProductId'),
    retailerSku: get('retailerSku') ?? get('retailerProductId'),
    productName: get('productName'),
    brand: get('brand'),
    category: get('category'),
    subcategory: get('subcategory'),
    description: get('description'),
    imageUrl: get('imageUrl'),
    size: get('size'),
    shade: get('shade'),
    gtin: normalizeIdentifier(get('gtin')),
    upc: normalizeIdentifier(get('upc')),
    ean: normalizeIdentifier(get('ean')),
    sku: get('sku'),
    price: normalizePrice(get('price')),
    salePrice: normalizePrice(get('salePrice')),
    currency: normalizeCurrency(get('currency')),
    availability: normalizeAvailability(get('availability')),
    affiliateUrl: get('affiliateUrl'),
  };
}

// Fetches and parses one affiliate network feed, then stores every row via
// the shared central-database write path (services/productStore.js).
export async function syncAffiliateFeed(feedConfig) {
  const { retailer, feedUrl, feedFormat = 'csv', fieldMap } = feedConfig;
  if (!feedUrl) {
    return { success: false, retailer, error: `No feedUrl configured for ${retailer} — see config/feedSources.js` };
  }

  let rows;
  try {
    const { data } = await axios.get(feedUrl, { timeout: 30000, responseType: 'text' });
    rows = feedFormat === 'json'
      ? (typeof data === 'string' ? JSON.parse(data) : data)
      : parseCsv(String(data));
  } catch (error) {
    return { success: false, retailer, error: `Failed to fetch/parse feed: ${error.message}` };
  }

  let stored = 0;
  let created = 0;
  let skipped = 0;
  for (const row of rows) {
    const item = mapRow(row, fieldMap);
    if (!item.retailerProductId || !item.productName || !item.affiliateUrl) {
      skipped++;
      continue;
    }
    const result = await upsertProductOffer({ retailer, ...item });
    if (result) {
      stored++;
      if (result.productCreated) created++;
    } else {
      skipped++;
    }
  }

  return { success: true, retailer, totalFound: rows.length, totalStored: stored, productsCreated: created, skipped };
}

export default { syncAffiliateFeed };
