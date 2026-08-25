// Normalization layer — standardizes attributes coming from any provider
// (Amazon PA-API or an affiliate network feed) before they're matched
// against / written into the central `products` table. Keeping this in one
// module means "how do we normalize a brand name" has exactly one answer
// no matter which provider the data came from.

export function normalizeBrand(raw) {
  if (!raw) return null;
  return String(raw)
    .replace(/\s+/g, ' ')
    .trim()
    // Strip a handful of common corporate/marketing suffixes retailers
    // append inconsistently ("Maybelline New York" vs "Maybelline"), so
    // both land on the same brand row. Only strips when a shorter form is
    // still a meaningful name (avoids reducing e.g. "e.l.f." to nothing).
    .replace(/\s*(new york|paris|london)$/i, '')
    .trim();
}

// Lowercase, punctuation-stripped form used as brands.normalized_name and
// as an input to buildMatchKey — NOT what's displayed.
export function normalizeBrandKey(raw) {
  const brand = normalizeBrand(raw);
  if (!brand) return null;
  return brand.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const NAME_NOISE_WORDS = new Set([
  // Marketing filler that varies retailer-to-retailer for the identical
  // product ("Super Stay Full Coverage Foundation" vs "Super Stay
  // Foundation") — stripped only for MATCHING (buildMatchKey), never for
  // the display copy stored in products.product_name.
  'new', 'full', 'coverage', 'the',
]);

export function normalizeProductName(raw) {
  if (!raw) return null;
  return String(raw).replace(/\s+/g, ' ').trim();
}

function matchTokens(name) {
  return (normalizeProductName(name) || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !NAME_NOISE_WORDS.has(t));
}

export function normalizeCategory(raw) {
  if (!raw) return 'Other';
  const s = String(raw).toLowerCase();
  if (/skin ?care|serum|moisturi[sz]er|cleanser|sunscreen|spf/.test(s)) return 'Skincare';
  if (/make ?up|foundation|mascara|lipstick|eyeshadow|blush|concealer/.test(s)) return 'Makeup';
  if (/hair/.test(s)) return 'Haircare';
  if (/fragrance|perfume|cologne|eau de/.test(s)) return 'Fragrance';
  if (/bath|body|lotion/.test(s)) return 'Bath & Body';
  if (/tool|brush|styler|dryer|wrap/.test(s)) return 'Tools';
  return 'Other';
}

// Extracts and normalizes a size/volume token, e.g. "50 ML" / "1.7 fl oz"
// -> "50ml". Returns null when no recognizable size is present.
const SIZE_RE = /(\d+(?:\.\d+)?)\s*(ml|milliliters?|oz|fl\s?oz|fluid ounces?|g|grams?|kg)\b/i;
const UNIT_MAP = { milliliters: 'ml', milliliter: 'ml', fluidounces: 'floz', fluidounce: 'floz', floz: 'floz', 'fl oz': 'floz', grams: 'g', gram: 'g' };

export function normalizeSize(raw) {
  if (!raw) return null;
  const match = String(raw).match(SIZE_RE);
  if (!match) return null;
  const value = parseFloat(match[1]);
  let unit = match[2].toLowerCase().replace(/\s+/g, '');
  unit = UNIT_MAP[unit] || unit;
  return `${value}${unit}`;
}

// Shade names are largely free text ("128 Warm Nude", "Warm Nude 128") —
// normalize whitespace/case for matching, but preserve the retailer's
// numbering since that IS the identifying detail.
export function normalizeShade(raw) {
  if (!raw) return null;
  return String(raw).replace(/\s+/g, ' ').trim();
}

function shadeKey(raw) {
  const shade = normalizeShade(raw);
  if (!shade) return '';
  return shade.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Strips non-digits so "978-0-13-468599-1"-style punctuation in a
// retailer/feed-supplied identifier doesn't defeat an otherwise-exact
// match. Returns null for empty/absent input.
export function normalizeIdentifier(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

export function normalizeCurrency(raw) {
  if (!raw) return 'USD';
  return String(raw).toUpperCase().trim().slice(0, 3);
}

export function normalizePrice(raw) {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

// Normalizes any provider's availability signal down to a fixed vocabulary
// the frontend/price-comparison logic can rely on.
export function normalizeAvailability(raw) {
  if (raw == null) return 'unknown';
  const s = String(raw).toLowerCase();
  if (/out of stock|unavailable|sold out|discontinued/.test(s)) return 'out_of_stock';
  if (/limited|low stock|few left|backorder/.test(s)) return 'limited';
  if (/in stock|available|ships|instock/.test(s)) return 'in_stock';
  return 'unknown';
}

// The fallback matching key (priority 5 in the spec: brand + normalized
// name + shade + size) — used only when no product identifier (GTIN/UPC/
// EAN) and no existing retailer_product_id match is available. Two items
// that reduce to the same match_key are treated as the same physical
// product.
export function buildMatchKey({ brand, productName, shade, size }) {
  const brandKey = normalizeBrandKey(brand) || '';
  const nameTokens = matchTokens(productName).sort().join('');
  const shadeK = shadeKey(shade);
  const sizeK = (normalizeSize(size) || '').replace(/[^a-z0-9]/gi, '');
  if (!brandKey || !nameTokens) return null;
  return `${brandKey}|${nameTokens}|${shadeK}|${sizeK}`;
}

export default {
  normalizeBrand,
  normalizeBrandKey,
  normalizeProductName,
  normalizeCategory,
  normalizeSize,
  normalizeShade,
  normalizeIdentifier,
  normalizeCurrency,
  normalizePrice,
  normalizeAvailability,
  buildMatchKey,
};
