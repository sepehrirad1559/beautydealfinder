import React, { useEffect, useState } from 'react';
import { useParams, Link } from '../router.js';
import { API_URL, RETAILER_LABELS, ProductCard } from '../App.jsx';
import { useSeo } from '../seo.js';
import { brandPath, categoryPath, productPath } from '../slug.js';

// Brand hub page (Part 6 of the SEO strategy). Indexability threshold: a
// brand needs at least 3 products with live price data before this page
// is worth competing for the brand-name query — below that it stays
// noindex,follow (still fully functional and linked, just not asking
// Google to rank a thin page).
const MIN_INDEXABLE_PRODUCTS = 3;

export default function BrandPage() {
  const { brandSlug } = useParams();
  const [products, setProducts] = useState([]);
  const [brandName, setBrandName] = useState('');
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    fetch(`${API_URL}/products/meta/brands`)
      .then((r) => r.json())
      .then((d) => {
        const match = (d.brands || []).find((b) => brandPath(b) === `/brand/${brandSlug}`);
        if (!match) { if (!cancelled) setStatus('error'); return; }
        if (cancelled) return;
        setBrandName(match);
        const params = new URLSearchParams({ brand: match, limit: '200' });
        fetch(`${API_URL}/products?${params.toString()}`)
          .then((r) => r.json())
          .then((d2) => { if (!cancelled) { setProducts(d2.products || []); setStatus('ok'); } })
          .catch(() => { if (!cancelled) setStatus('error'); });
      })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, [brandSlug]);

  const indexable = products.length >= MIN_INDEXABLE_PRODUCTS;
  const prices = products.map((p) => p.best_price).filter((p) => p != null);
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  const categories = [...new Set(products.map((p) => p.category).filter(Boolean))];
  const popular = [...products].sort((a, b) => (b.offer_count || 0) - (a.offer_count || 0)).slice(0, 8);

  useSeo({
    title: brandName ? `${brandName} — Compare Prices on ${products.length} Products | BeautyPriceMatch` : undefined,
    description: brandName ? `Compare current prices for every ${brandName} product we track across ${new Set(products.flatMap((p) => (p.offers || []).map((o) => o.retailer))).size || 'multiple'} retailers.${minPrice != null ? ` ${brandName} products range from $${minPrice.toFixed(2)} to $${maxPrice.toFixed(2)}.` : ''}` : undefined,
    path: brandSlug ? `/brand/${brandSlug}` : undefined,
    robots: status === 'ok' && !indexable ? 'noindex,follow' : 'index,follow',
  });

  if (status === 'error') {
    return <main className="page"><p className="empty-state">We don't have that brand yet. <Link to="/">Back to all products</Link></p></main>;
  }
  if (status === 'loading') {
    return <main className="page"><p className="empty-state">Loading…</p></main>;
  }

  return (
    <main className="page">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><Link to="/">Home</Link> / <span>{brandName}</span></nav>
      <h1>{brandName} — Compare Prices Across {products.length} Product{products.length === 1 ? '' : 's'}</h1>
      {minPrice != null && (
        <p className="subhead">{brandName} products on BeautyPriceMatch range from ${minPrice.toFixed(2)} to ${maxPrice.toFixed(2)}.</p>
      )}
      {categories.length > 0 && (
        <p className="subhead">
          Shop {brandName} in: {categories.map((c, i) => (
            <React.Fragment key={c}>{i > 0 && ', '}<Link to={categoryPath(c)}>{c}</Link></React.Fragment>
          ))}
        </p>
      )}

      {popular.length > 0 && (
        <section>
          <h2>Popular right now</h2>
          <div className="grid">
            {popular.map((p) => <Link key={p.id} to={productPath(p)} className="card">
              <div className="thumb">{p.image_url ? <img src={p.image_url} alt={p.title} /> : <span>No image</span>}</div>
              <div className="title">{p.title}</div>
              <div className="price">{p.best_price != null ? `$${Number(p.best_price).toFixed(2)}` : 'Price unavailable'}</div>
            </Link>)}
          </div>
        </section>
      )}

      <section>
        <h2>All {brandName} products</h2>
        <div className="grid">
          {products.map((p) => <ProductCard key={p.id} product={p} onSelect={() => {}} />)}
        </div>
      </section>

      <section aria-labelledby="brand-faq-heading">
        <h2 id="brand-faq-heading">Frequently asked questions</h2>
        <div className="faq">
          <details>
            <summary>What's the cheapest {brandName} product?</summary>
            <p>{minPrice != null ? `Prices start at $${minPrice.toFixed(2)} — see the full list above sorted by price.` : `We don't have live pricing for ${brandName} yet.`}</p>
          </details>
        </div>
      </section>
    </main>
  );
}
