import crypto from 'crypto';
import axios from 'axios';
import { normalizeIdentifier, normalizeAvailability, normalizeCategory } from './normalize.js';
import { upsertProductOffer } from './productStore.js';

// Amazon Product Advertising API (PA-API 5.0) — the one retailer in the
// spec's list with a real, public, keyed, OFFICIAL API for product/price
// data. This is the only non-affiliate-feed data source in the codebase,
// and it's a licensed API, not scraping. Requires an approved Amazon
// Associates account; PA-API access is granted once your Associates
// account has driven qualifying sales, not immediately on signup — see
// https://webservices.amazon.com/paapi5/documentation/.
//
// Until AMAZON_ACCESS_KEY/AMAZON_SECRET_KEY/AMAZON_PARTNER_TAG are set,
// every function below returns a clear "not configured" result rather than
// silently doing nothing.
const AMAZON_ACCESS_KEY = process.env.AMAZON_ACCESS_KEY;
const AMAZON_SECRET_KEY = process.env.AMAZON_SECRET_KEY;
const AMAZON_PARTNER_TAG = process.env.AMAZON_PARTNER_TAG;
const AMAZON_HOST = process.env.AMAZON_HOST || 'webservices.amazon.com';
const AMAZON_REGION = process.env.AMAZON_REGION || 'us-east-1';
const AMAZON_MARKETPLACE = process.env.AMAZON_MARKETPLACE || 'www.amazon.com';

function isConfigured() {
  return Boolean(AMAZON_ACCESS_KEY && AMAZON_SECRET_KEY && AMAZON_PARTNER_TAG);
}

// AWS Signature Version 4 — PA-API 5.0 requires every request to be signed
// this way. Standard SigV4 recipe (canonical request -> string to sign ->
// signing key -> signature), implemented directly with Node's crypto
// rather than pulling in the full AWS SDK for one endpoint.
function sign(key, msg) {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
}

function getSignatureKey(secretKey, dateStamp, regionName, serviceName) {
  const kDate = sign(`AWS4${secretKey}`, dateStamp);
  const kRegion = sign(kDate, regionName);
  const kService = sign(kRegion, serviceName);
  return sign(kService, 'aws4_request');
}

async function signedRequest(target, payload) {
  const service = 'ProductAdvertisingAPI';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const path = `/paapi5/${target === 'SearchItems' ? 'searchitems' : 'getitems'}`;
  const body = JSON.stringify(payload);

  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `content-type:application/json; charset=utf-8\n` +
    `host:${AMAZON_HOST}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${target}\n`;
  const signedHeaders = 'content-encoding;content-type;host;x-amz-date;x-amz-target';
  const payloadHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');

  const canonicalRequest = `POST\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const credentialScope = `${dateStamp}/${AMAZON_REGION}/${service}/aws4_request`;
  const stringToSign =
    `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n` +
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex');

  const signingKey = getSignatureKey(AMAZON_SECRET_KEY, dateStamp, AMAZON_REGION, service);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  const authorizationHeader =
    `AWS4-HMAC-SHA256 Credential=${AMAZON_ACCESS_KEY}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return axios.post(`https://${AMAZON_HOST}${path}`, body, {
    headers: {
      'content-encoding': 'amz-1.0',
      'content-type': 'application/json; charset=utf-8',
      'x-amz-date': amzDate,
      'x-amz-target': `com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${target}`,
      Authorization: authorizationHeader,
    },
    timeout: 15000,
  });
}

// Searches Amazon for beauty products under a given category/keyword.
// PA-API's SearchItems returns up to 10 results/page, 10 pages max (100
// results) per distinct search — call once per keyword/category.
export async function searchAmazonProducts(keywords, itemPage = 1) {
  if (!isConfigured()) {
    return { success: false, error: 'AMAZON_ACCESS_KEY/AMAZON_SECRET_KEY/AMAZON_PARTNER_TAG not configured', items: [] };
  }
  try {
    const response = await signedRequest('SearchItems', {
      PartnerTag: AMAZON_PARTNER_TAG,
      PartnerType: 'Associates',
      Marketplace: AMAZON_MARKETPLACE,
      Keywords: keywords,
      SearchIndex: 'Beauty',
      ItemPage: itemPage,
      Resources: [
        'ItemInfo.Title', 'ItemInfo.Features', 'ItemInfo.ByLineInfo', 'ItemInfo.ExternalIds',
        'Images.Primary.Large', 'Offers.Listings.Price', 'Offers.Listings.SavingBasis',
        'Offers.Listings.Availability.Message', 'CustomerReviews.StarRating', 'CustomerReviews.Count',
      ],
    });
    return { success: true, items: response.data?.SearchResult?.Items || [] };
  } catch (error) {
    const errInfo = error.response?.data ? JSON.stringify(error.response.data).slice(0, 300) : error.message;
    console.error('Amazon PA-API search error:', errInfo);
    return { success: false, error: errInfo, items: [] };
  }
}

// Maps a PA-API item to the shared normalized-item shape consumed by
// services/productStore.js#upsertProductOffer.
export function normalizeAmazonItem(item, searchTerm) {
  const title = item?.ItemInfo?.Title?.DisplayValue;
  const asin = item?.ASIN;
  if (!title || !asin) return null;

  const brand = item?.ItemInfo?.ByLineInfo?.Brand?.DisplayValue || null;
  const image = item?.Images?.Primary?.Large?.URL || null;
  const listing = item?.Offers?.Listings?.[0];
  const currentPrice = listing?.Price?.Amount != null ? Number(listing.Price.Amount) : null;
  const currency = listing?.Price?.Currency || 'USD';
  const availability = normalizeAvailability(listing?.Availability?.Message);
  const upc = normalizeIdentifier(item?.ItemInfo?.ExternalIds?.UPCs?.DisplayValues?.[0]);
  const ean = normalizeIdentifier(item?.ItemInfo?.ExternalIds?.EANs?.DisplayValues?.[0]);

  // SavingBasis is PA-API's own "was" price (what Amazon itself displays as
  // the strikethrough reference price for a "Limited time deal"/"X% off"
  // listing) — a genuine, source-reported discount, never inferred. Only
  // treated as a real discount when it's actually higher than the current
  // price; otherwise this listing just isn't on sale right now.
  const savingBasis = listing?.SavingBasis?.Money?.Amount ?? listing?.SavingBasis?.Amount;
  const listPrice = savingBasis != null ? Number(savingBasis) : null;
  const hasDiscount = listPrice != null && currentPrice != null && listPrice > currentPrice + 0.01;
  const price = hasDiscount ? listPrice : currentPrice;
  const salePrice = hasDiscount ? currentPrice : null;

  return {
    retailer: 'amazon',
    retailerProductId: asin,
    retailerSku: asin,
    productName: title,
    brand,
    category: normalizeCategory(searchTerm),
    description: (item?.ItemInfo?.Features?.DisplayValues || []).join(' '),
    imageUrl: image,
    upc,
    ean,
    gtin: null,
    sku: null,
    size: null,
    shade: null,
    price: price != null && price >= 0 ? price : null,
    salePrice,
    currency,
    availability,
    // DetailPageURL from PA-API already embeds the partner tag as an
    // affiliate link — no separate link-building step needed.
    affiliateUrl: item?.DetailPageURL || `https://www.amazon.com/dp/${asin}?tag=${AMAZON_PARTNER_TAG}`,
  };
}

// A handful of high-traffic beauty search terms/categories — broad enough
// to surface real inventory across brands without needing per-product ASIN
// lookups.
const DEFAULT_SEARCH_TERMS = [
  'foundation makeup', 'moisturizer skincare', 'serum skincare', 'mascara',
  'lipstick', 'sunscreen face', 'shampoo', 'perfume', 'eyeshadow palette', 'face wash',
];

export async function syncAmazonProducts(searchTerms = DEFAULT_SEARCH_TERMS) {
  if (!isConfigured()) {
    console.error('Amazon PA-API not configured — skipping Amazon sync.');
    return { success: false, error: 'AMAZON_ACCESS_KEY/AMAZON_SECRET_KEY/AMAZON_PARTNER_TAG not configured' };
  }

  let totalFound = 0;
  let totalStored = 0;
  let productsCreated = 0;
  for (const term of searchTerms) {
    console.log(`🛍️  Searching Amazon for "${term}"...`);
    const { success, items, error } = await searchAmazonProducts(term);
    if (!success) {
      console.error(`Amazon search failed for "${term}":`, error);
      continue;
    }
    totalFound += items.length;
    for (const item of items) {
      const normalized = normalizeAmazonItem(item, term);
      if (!normalized) continue;
      const result = await upsertProductOffer(normalized);
      if (result) {
        totalStored++;
        if (result.productCreated) productsCreated++;
      }
    }
    // PA-API's default rate limit is 1 request/second per associate
    // account — stay well under it.
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }

  return { success: true, totalFound, totalStored, productsCreated };
}

export default { searchAmazonProducts, normalizeAmazonItem, syncAmazonProducts };

