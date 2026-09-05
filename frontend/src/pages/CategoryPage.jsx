import React, { useEffect, useState } from 'react';
import { useParams, Link } from '../router.js';
import { API_URL, ProductCard } from '../App.jsx';
import { useSeo } from '../seo.js';
import { categoryPath, brandPath } from '../slug.js';

// Category hub page. Follows the tiered indexability rule from Part 7 of
// the SEO strategy doc: under 10 products, noindex (not enough to
// differentiate from search); 10-49, indexable only with the buying-guide
// blurb below; 50+, indexable outright. Re-evaluated on every load since
// it's driven by live product counts, not a manual flag.
const CATEGORY_BLURBS = {
  Makeup: 'From foundation to lipstick, compare real prices across every retailer we track before you buy.',
  Skincare: 'Serums, moisturizers, cleansers and sunscreen — see which retailer actually has the lowest price today.',
  Haircare: 'Shampoo, conditioner, and styling products compared across retailers so you don’t overpay.',
  Fragrance: 'Compare perfume and cologne prices across retailers before you buy.',
};

export default function CategoryPage() {
  const { categorySlug } = useParams();
  const [products, setProducts] = useState([]);
  const [categoryName, setCategoryName] = useState('');
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    fetch(`${API_URL}/products?limit=1`)
      .then(() => {})
      .catch(() => {});
    // Categories aren't enumerated by a dedicated endpoint yet, so match
    // the slug against the fixed set of known categories in the schema
    // (see backend/src/db/schema.sql's comment listing them) rather than
    // guessing — this avoids a second round-trip just to resolve the slug.
    const KNOWN_CATEGORIES = ['Skincare', 'Makeup', 'Haircare', 'Fragrance', 'Bath & Body', 'Tools', 'Other'];
    const match = KNOWN_CATEGORIES.find((c) => categoryPath(c) === `/category/${categorySlug}`);
    if (!match) { if (!cancelled) setStatus('error'); return; }
    setCategoryName(match);
    const params = new URLSearchParams({ category: match, limit: '500' });
    fetch(`${API_URL}/products?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) { setProducts(d.products || []); setStatus('ok'); } })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, [categorySlug]);

  const count = products.length;
  const blurb = CATEGORY_BLURBS[categoryName];
  const indexable = count >= 50 || (count >= 10 && Boolean(blurb));
  const brands = [...new Set(products.map((p) => p.brand).filter(Boolean))].sort();

  useSeo({
    title: categoryName ? `Best ${categoryName} Prices — Compare ${count} Product${count === 1 ? '' : 's'} | BeautyPriceMatch` : undefined,
    description: categoryName ? `${blurb || `Compare ${categoryName.toLowerCase()} prices across retailers.`} ${count} products tracked, updated as prices change.` : undefined,
    path: categorySlug ? `/category/${categorySlug}` : undefined,
    robots: status === 'ok' && !indexable ? 'noindex,follow' : 'index,follow',
  });

  if (status === 'error') {
    return <main className="page"><p className="empty-state">We don't have that category yet. <Link to="/">Back to all products</Link></p></main>;
  }
  if (status === 'loading') {
    return <main className="page"><p className="empty-state">Loading…</p></main>;
  }

  return (
    <main className="page">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><Link to="/">Home</Link> / <span>{categoryName}</span></nav>
      <h1>Best {categoryName} Prices</h1>
      {blurb && <p className="subhead">{blurb}</p>}
      {brands.length > 0 && (
        <p className="subhead">
          Brands: {brands.slice(0, 12).map((b, i) => (
            <React.Fragment key={b}>{i > 0 && ', '}<Link to={brandPath(b)}>{b}</Link></React.Fragment>
          ))}
        </p>
      )}
      {products.length === 0 ? (
        <p className="empty-state">No {categoryName.toLowerCase()} products tracked yet — check back soon.</p>
      ) : (
        <div className="grid">
          {products.map((p) => <ProductCard key={p.id} product={p} onSelect={() => {}} />)}
        </div>
      )}
    </main>
  );
}
