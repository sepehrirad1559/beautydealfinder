import React, { useEffect, useState } from 'react';
import { useParams, Link } from '../router.js';
import { API_URL, GO_BASE, RETAILER_LABELS, getSessionSid, AffiliateDisclosure } from '../App.jsx';
import { useSeo, SITE } from '../seo.js';
import { idFromSlug, brandPath, categoryPath, productPath } from '../slug.js';

// Individual product page — the "entity page" from the SEO strategy
// (Part 2/3): full description, specs, every live retailer offer, and the
// internal links (brand, category, similar products) Google needs to
// crawl the rest of the catalog from here. Indexability is decided below,
// not assumed: a product with fewer than 2 live offers and no real
// description doesn't have enough to say that a plain Google search
// wouldn't already show, so it stays noindex,follow until it does.
export default function ProductPage() {
  const { brandSlug, slugId } = useParams();
  const id = idFromSlug(slugId);
  const [product, setProduct] = useState(null);
  const [similar, setSimilar] = useState([]);
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    if (!id) { setStatus('error'); return; }
    let cancelled = false;
    setStatus('loading');
    fetch(`${API_URL}/products/${id}`)
      .then((r) => { if (!r.ok) throw new Error('not found'); return r.json(); })
      .then((data) => {
        if (cancelled) return;
        setProduct(data);
        setStatus('ok');
        const params = new URLSearchParams({ category: data.category || '', limit: '6' });
        fetch(`${API_URL}/products?${params.toString()}`)
          .then((r) => r.json())
          .then((d) => { if (!cancelled) setSimilar((d.products || []).filter((p) => p.id !== data.id).slice(0, 6)); })
          .catch(() => {});
      })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, [id]);

  const offers = product ? [...(product.offers || [])].filter((o) => !o.is_stale)
    .sort((a, b) => (a.effective_price ?? Infinity) - (b.effective_price ?? Infinity)) : [];
  const hasEnoughContent = product && (offers.length >= 2 || (product.description && product.description.length > 40));

  const title = product ? `${product.title} Price Comparison — Best Price ${product.best_price != null ? `$${Number(product.best_price).toFixed(2)}` : ''} | BeautyPriceMatch` : 'Loading… | BeautyPriceMatch';
  const description = product
    ? `Compare current prices for ${product.title}${product.brand ? ` by ${product.brand}` : ''} across ${offers.length || 'multiple'} retailer${offers.length === 1 ? '' : 's'}. ${product.best_price != null ? `Best price: $${Number(product.best_price).toFixed(2)} at ${RETAILER_LABELS[product.best_retailer] || product.best_retailer}.` : ''} Updated ${product.updated_at ? new Date(product.updated_at).toLocaleDateString() : 'recently'}.`
    : undefined;
  const path = product ? productPath(product) : undefined;

  const jsonLd = product ? {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    brand: product.brand ? { '@type': 'Brand', name: product.brand } : undefined,
    image: product.image_url || undefined,
    description: product.description || description,
    sku: product.sku || undefined,
    gtin: product.gtin || product.upc || product.ean || undefined,
    offers: offers.length > 0 ? {
      '@type': 'AggregateOffer',
      priceCurrency: offers[0].currency || 'USD',
      lowPrice: product.best_price,
      highPrice: offers.reduce((max, o) => Math.max(max, o.effective_price || 0), 0) || undefined,
      offerCount: offers.length,
      offers: offers.map((o) => ({
        '@type': 'Offer',
        price: o.effective_price,
        priceCurrency: o.currency || 'USD',
        availability: o.in_stock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
        url: `${SITE}${path}`,
      })),
    } : undefined,
  } : null;

  useSeo({
    title,
    description,
    path,
    robots: product && !hasEnoughContent ? 'noindex,follow' : 'index,follow',
    jsonLd,
  });

  if (status === 'error') {
    return (
      <main className="page">
        <p className="empty-state">We couldn't find that product. <Link to="/">Back to all products</Link></p>
      </main>
    );
  }
  if (status === 'loading' || !product) {
    return <main className="page"><p className="empty-state">Loading…</p></main>;
  }

  return (
    <main className="page product-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">Home</Link>
        {product.category && <> / <Link to={categoryPath(product.category)}>{product.category}</Link></>}
        {product.brand && <> / <Link to={brandPath(product.brand)}>{product.brand}</Link></>}
        <> / <span>{product.title}</span></>
      </nav>

      <div className="product-detail-hero">
        <div className="product-detail-image">
          {product.image_url ? <img src={product.image_url} alt={product.title} /> : <span>No image</span>}
        </div>
        <div className="product-detail-info">
          {product.brand && <Link to={brandPath(product.brand)} className="brand-link">{product.brand}</Link>}
          <h1>{product.title}</h1>
          {(product.size || product.shade) && (
            <p className="product-specs">{[product.size, product.shade].filter(Boolean).join(' · ')}</p>
          )}
          {product.best_price != null && (
            <p className="product-best-price">
              Best price: <strong>${Number(product.best_price).toFixed(2)}</strong> at {RETAILER_LABELS[product.best_retailer] || product.best_retailer}
              {product.savings_percent > 0 && <span className="save-badge" style={{ marginLeft: 8 }}>Save {product.savings_percent}%</span>}
            </p>
          )}
          <p className="product-updated">Prices last checked {product.updated_at ? new Date(product.updated_at).toLocaleString() : 'recently'}</p>
        </div>
      </div>

      <section aria-labelledby="price-table-heading">
        <h2 id="price-table-heading">Compare prices across {offers.length} retailer{offers.length === 1 ? '' : 's'}</h2>
        <div className="offer-table">
          {offers.map((offer) => (
            <a
              key={offer.id}
              className={`offer${offer.effective_price === product.best_price ? ' best' : ''}`}
              href={`${GO_BASE}/go/offer/${offer.id}${getSessionSid() ? `?sid=${encodeURIComponent(getSessionSid())}` : ''}`}
              target="_blank"
              rel="noopener noreferrer sponsored"
            >
              <span className="offer-retailer">{RETAILER_LABELS[offer.retailer] || offer.retailer}</span>
              <span className="offer-price">
                {offer.effective_price === product.best_price && <span className="badge-best">Best</span>}
                {offer.discount_percent > 0 && offer.original_price != null && (
                  <span className="offer-price-was">${Number(offer.original_price).toFixed(2)}</span>
                )}
                {offer.effective_price != null ? `$${Number(offer.effective_price).toFixed(2)}` : 'Check price'} ↗
              </span>
            </a>
          ))}
          {offers.length === 0 && (
            <p className="empty-state small">Currently out of stock everywhere we track. Check back soon, or see similar in-stock products below.</p>
          )}
        </div>
      </section>

      {product.description && (
        <section aria-labelledby="description-heading">
          <h2 id="description-heading">About this product</h2>
          <p>{product.description}</p>
        </section>
      )}

      <section aria-labelledby="faq-heading">
        <h2 id="faq-heading">Frequently asked questions</h2>
        <div className="faq">
          <details>
            <summary>What's the cheapest way to buy {product.title}?</summary>
            <p>{product.best_price != null
              ? `Right now, the best price we've found is $${Number(product.best_price).toFixed(2)} at ${RETAILER_LABELS[product.best_retailer] || product.best_retailer}.`
              : `We're not tracking a live price for this product from any retailer right now.`}</p>
          </details>
          <details>
            <summary>How often are these prices updated?</summary>
            <p>Prices are refreshed automatically as our retailer syncs run — this page shows the last-checked time for each offer above, so you can see exactly how current the data is.</p>
          </details>
          <details>
            <summary>Does BeautyPriceMatch sell {product.title} directly?</summary>
            <p>No — we compare prices across retailers and link you to their sites to complete your purchase. We may earn a commission on qualifying purchases at no extra cost to you.</p>
          </details>
        </div>
      </section>

      {similar.length > 0 && (
        <section aria-labelledby="similar-heading">
          <h2 id="similar-heading">Similar products</h2>
          <div className="grid">
            {similar.map((p) => (
              <Link key={p.id} to={productPath(p)} className="card">
                <div className="thumb">{p.image_url ? <img src={p.image_url} alt={p.title} /> : <span>No image</span>}</div>
                <div className="brand">{p.brand}</div>
                <div className="title">{p.title}</div>
                <div className="price">{p.best_price != null ? `$${Number(p.best_price).toFixed(2)}` : 'Price unavailable'}</div>
              </Link>
            ))}
          </div>
        </section>
      )}

      <AffiliateDisclosure />
    </main>
  );
}
