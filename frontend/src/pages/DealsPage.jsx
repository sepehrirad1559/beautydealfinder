import React, { useEffect, useState } from 'react';
import { Link } from '../router.js';
import { API_URL, ProductCard } from '../App.jsx';
import { useSeo } from '../seo.js';

// Deals hub (Part 8 of the SEO strategy). A product only ever appears
// here because the backend's own discount_percent field says so — that
// field is only ever populated from a retailer's own reported sale price
// vs. list price (see backend/src/routes/products.js's isOnSale/
// discountPercent helpers), never a manually-set "deal" flag, so this
// page can't drift into showing a fake or stale discount.
export default function DealsPage() {
  const [products, setProducts] = useState([]);
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ categoryGroup: 'deals', limit: '200' });
    fetch(`${API_URL}/products?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) { setProducts(d.products || []); setStatus('ok'); } })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, []);

  useSeo({
    title: `Beauty Deals — ${products.length} Verified Price Drops Today | BeautyPriceMatch`,
    description: `${products.length} beauty products currently discounted below their own listed price, tracked across retailers. Real, source-reported discounts only — refreshed as our price syncs run.`,
    path: '/deals',
    robots: 'index,follow',
  });

  return (
    <main className="page">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><Link to="/">Home</Link> / <span>Deals</span></nav>
      <h1>Beauty Deals</h1>
      <p className="subhead">Real, source-reported discounts only — a product only shows up here because the retailer itself reported a lower sale price, never a flag we set ourselves.</p>
      {status === 'loading' ? (
        <p className="empty-state">Loading…</p>
      ) : products.length === 0 ? (
        <p className="empty-state">No verified discounts right now — check back after the next price sync.</p>
      ) : (
        <div className="grid">
          {products.map((p) => <ProductCard key={p.id} product={p} onSelect={() => {}} />)}
        </div>
      )}
    </main>
  );
}
