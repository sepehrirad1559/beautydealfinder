// Shared slug helpers for SEO-friendly URLs (see Part 1 of the SEO
// strategy: /p/{brand-slug}/{product-slug}-{id}, /brand/{brand-slug},
// /category/{category-slug}). The numeric id suffix on product URLs means
// we never need a global slug-uniqueness pass across the catalog — two
// products with the same name+brand just get different id suffixes.
export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'item';
}

export function productPath(product) {
  const brandSlug = slugify(product.brand);
  const nameSlug = slugify(product.title || product.product_name);
  return `/p/${brandSlug}/${nameSlug}-${product.id}`;
}

export function comparePath(product) {
  const brandSlug = slugify(product.brand);
  const nameSlug = slugify(product.title || product.product_name);
  return `/compare/${brandSlug}/${nameSlug}-${product.id}`;
}

export function brandPath(brand) {
  return `/brand/${slugify(brand)}`;
}

export function categoryPath(category) {
  return `/category/${slugify(category)}`;
}

// Pulls the trailing numeric id off a `{slug}-{id}` URL segment.
export function idFromSlug(slugWithId) {
  const match = String(slugWithId || '').match(/-(\d+)$/);
  return match ? match[1] : null;
}
