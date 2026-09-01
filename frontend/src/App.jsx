import React, { useState, useEffect, useCallback } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:30011/api';
const GO_BASE = API_URL.replace(/\/api\/?$/, '');
// Keep in sync with the backend's own page-size cap (MAX_PAGE_SIZE in
// backend/src/routes/products.js) — this is a single-page catalog view
// today (no "load more"), so we ask for as many as the backend will hand
// back in one response.
const MAX_PAGE_SIZE = 5000;

const RETAILER_LABELS = {
  amazon: 'Amazon',
  sephora: 'Sephora',
  ulta: 'Ulta Beauty',
  beautylish: 'Beautylish',
  glossier: 'Glossier',
  cultbeauty: 'Cult Beauty',
  // Awin affiliate feeds are stored as `awin_<advertiserId>` (see
  // backend/src/services/awinSync.js) — the raw code isn't something a
  // shopper should ever see, so every joined Awin advertiser needs a
  // human label here. `zlikehair` is a legacy retailer code from an
  // earlier one-off import script and maps to the same merchant.
  awin_102013: 'ZlikeHair',
  zlikehair: 'ZlikeHair',
  awin_108282: 'Sol Labs',
};

// Which retailers actually have a working data source right now (see
// backend/src/providers/registry.js — only Amazon has real API access;
// the rest are unconfigured until each is verified per
// config/retailerSources.js's checklist, or an affiliate feed is set up).
// Keeping this list in the frontend too so the hero/status copy can never
// silently drift out of sync with reality and imply a retailer is live
// when it isn't — a comparison site's core promise is that its prices are
// real, so this can't fudge it even for launch-day polish.
const LIVE_RETAILERS = ['amazon', 'awin_102013', 'zlikehair', 'awin_108282'];
const COMING_SOON_RETAILERS = Object.keys(RETAILER_LABELS).filter((r) => !LIVE_RETAILERS.includes(r));

function AffiliateDisclosure({ className }) {
  return (
    <p className={`disclosure${className ? ` ${className}` : ''}`}>
      Disclosure: BeautyPriceMatch is an independent price-comparison site. We don't sell products
      ourselves — "Buy at" links above take you to the retailer's own site to complete your purchase,
      and we may earn a commission on qualifying purchases at no extra cost to you.
    </p>
  );
}

function ProductCard({ product, onSelect }) {
  const offers = product.offers || [];
  const bestOffer = offers[0];
  const worstPrice = offers.reduce((max, o) => (o.price != null && o.price > max ? o.price : max), 0);
  const savePct = offers.length > 1 && worstPrice > 0 && product.best_price != null
    ? Math.round((1 - product.best_price / worstPrice) * 100)
    : 0;

  return (
    <div className="card" tabIndex={0} onClick={() => onSelect(product)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(product); } }}>
      {savePct > 0 && <div className="save-badge">Save {savePct}%</div>}
      <div className="thumb">
        {product.image_url ? <img src={product.image_url} alt={product.title} /> : <span>No image</span>}
      </div>
      <div className="brand">{product.brand || ' '}</div>
      <div className="title">{product.title}</div>
      <div className="card-meta">
        <div className="price">{product.best_price != null ? `$${Number(product.best_price).toFixed(2)}` : 'Price unavailable'}</div>
        {offers.length > 1 && <div className="count">{offers.length} retailers</div>}
      </div>
      {bestOffer && (
        <div className="bestat">Best at <b>{RETAILER_LABELS[bestOffer.retailer] || bestOffer.retailer}</b></div>
      )}
    </div>
  );
}

function ProductDetailDrawer({ product, onClose }) {
  const open = Boolean(product);
  const offers = product ? [...(product.offers || [])].sort((a, b) => {
    if (a.price != null && b.price != null) return a.price - b.price;
    if (a.price != null) return -1;
    if (b.price != null) return 1;
    return 0;
  }) : [];
  const lowestPrice = offers.find((o) => o.price != null)?.price;

  return (
    <>
      <div className={`scrim${open ? ' open' : ''}`} onClick={onClose} />
      <aside className={`drawer${open ? ' open' : ''}`} aria-hidden={!open}>
        {product && (
          <>
            <div className="drawer-hero">
              <button className="drawer-close" onClick={onClose} aria-label="Close">×</button>
              <div className="drawer-brand">{product.brand}</div>
              <div className="drawer-title">{product.title}</div>
            </div>
            <div className="drawer-body">
              <div className="offer-list">
                {offers.map((offer) => {
                  const isBest = offer.price != null && offer.price === lowestPrice;
                  return (
                    <a
                      key={offer.id}
                      className={`offer${isBest ? ' best' : ''}`}
                      href={`${GO_BASE}/go/offer/${offer.id}`}
                      target="_blank"
                      rel="noopener noreferrer sponsored"
                    >
                      <span className="offer-retailer">{RETAILER_LABELS[offer.retailer] || offer.retailer}</span>
                      <span className="offer-price">
                        {isBest && <span className="badge-best">Best</span>}
                        {offer.price != null ? `$${Number(offer.price).toFixed(2)}` : 'Check price'} ↗
                      </span>
                    </a>
                  );
                })}
              </div>
              <div style={{ marginTop: '18px', paddingTop: '16px', borderTop: '1px solid var(--line)' }}>
                <AffiliateDisclosure />
              </div>
            </div>
          </>
        )}
      </aside>
    </>
  );
}

export default function App() {
  const [products, setProducts] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(() => {
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('search') || '';
  });
  const [brand, setBrand] = useState('');
  const [brands, setBrands] = useState([]);
  const [selected, setSelected] = useState(null);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (brand) params.set('brand', brand);
      // The catalog can hold thousands of live products, but the backend
      // caps a single page at MAX_PAGE_SIZE (see routes/products.js) so one
      // request can't blow up response size — request that full page and
      // show the server's real `total` (not products.length) so the count
      // on screen never silently reads as "500" when there's actually more.
      params.set('limit', String(MAX_PAGE_SIZE));
      const res = await fetch(`${API_URL}/products?${params.toString()}`);
      const data = await res.json();
      setProducts(data.products || []);
      setTotal(typeof data.total === 'number' ? data.total : (data.products || []).length);
    } catch (err) {
      console.error('Failed to fetch products:', err);
    } finally {
      setLoading(false);
    }
  }, [search, brand]);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);
  useEffect(() => {
    fetch(`${API_URL}/products/meta/brands`)
      .then((r) => r.json())
      .then((d) => setBrands(d.brands || []))
      .catch(() => {});
  }, []);

  const [showAllBrands, setShowAllBrands] = useState(false);
  const FAMOUS_BRANDS = ['CeraVe', 'Maybelline', "L'Oreal Paris", 'Neutrogena', 'e.l.f.', 'NYX Professional Makeup', 'Revlon', 'The Ordinary', 'Olay', 'Dove', 'Nivea', "Burt's Bees"];
  const sortedBrands = [...brands].sort((a, b) => {
    const ai = FAMOUS_BRANDS.findIndex((f) => f.toLowerCase() === a.toLowerCase());
    const bi = FAMOUS_BRANDS.findIndex((f) => f.toLowerCase() === b.toLowerCase());
    const aRank = ai === -1 ? FAMOUS_BRANDS.length : ai;
    const bRank = bi === -1 ? FAMOUS_BRANDS.length : bi;
    if (aRank !== bRank) return aRank - bRank;
    return a.localeCompare(b);
  });
  const VISIBLE_BRAND_COUNT = 10;
  const visibleBrands = showAllBrands ? sortedBrands : sortedBrands.slice(0, VISIBLE_BRAND_COUNT);
  const hiddenBrandCount = sortedBrands.length - VISIBLE_BRAND_COUNT;

  return (
    <>
      <div className="hero">
        <div className="hero-inner">
          <div className="hero-top">
            <div className="wordmark">BeautyPriceMatch<span className="dot">.com</span></div>
          </div>
          <div className="hero-kicker">Real prices, one retailer live today</div>
          <h1 className="display">Find the best price before you buy.</h1>
          <p className="hero-sub">
            We're launching with real, live pricing from Amazon — {COMING_SOON_RETAILERS.map((r) => RETAILER_LABELS[r]).join(', ')}{' '}
            are coming soon as we get set up with each retailer's affiliate program.
          </p>
          <div className="hero-status">
            {LIVE_RETAILERS.map((r) => <span key={r} className="status-pill live">{RETAILER_LABELS[r]} · Live</span>)}
            {COMING_SOON_RETAILERS.map((r) => <span key={r} className="status-pill soon">{RETAILER_LABELS[r]} · Coming soon</span>)}
          </div>
        </div>
      </div>

      <div className="toolbar">
        <div className="toolbar-inner">
          <label className="searchwrap">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products or brands…" autoComplete="off" />
          </label>
          <div className="chips">
            <button className={`chip${brand === '' ? ' active' : ''}`} onClick={() => setBrand('')}>All brands</button>
            {visibleBrands.map((b) => (
              <button key={b} className={`chip${brand === b ? ' active' : ''}`} onClick={() => setBrand(b)}>{b}</button>
            ))}
            {hiddenBrandCount > 0 && (
              <button className="chip chip-more" onClick={() => setShowAllBrands((v) => !v)}>
                {showAllBrands ? 'Show less' : `+${hiddenBrandCount} more`}
              </button>
            )}
          </div>
        </div>
      </div>

      <main className="page">
        <p className="subhead"><strong>{total}</strong> product{total === 1 ? '' : 's'}</p>

        {loading ? (
          <p className="empty-state">Loading…</p>
        ) : products.length === 0 ? (
          <p className="empty-state">
            No products found yet. Run a sync (<code>POST /admin/sync/amazon</code>) once Amazon credentials are
            configured, or run <code>npm run seed</code> for sample data during development.
          </p>
        ) : (
          <div className="grid">
            {products.map((p) => <ProductCard key={p.id} product={p} onSelect={setSelected} />)}
          </div>
        )}

        <div className="coming-soon">
          <h3>More retailers coming soon</h3>
          <div className="coming-soon-list">
            {COMING_SOON_RETAILERS.map((r) => <span key={r} className="coming-soon-item">{RETAILER_LABELS[r]}</span>)}
          </div>
        </div>
      </main>

      <ProductDetailDrawer product={selected} onClose={() => setSelected(null)} />

      <footer className="site-footer">
        <div className="site-footer-inner">
          <AffiliateDisclosure className="footer" />
          <nav className="footer-links">
            <a href="/blog/">Blog</a>
            <a href="/about.html">About Us</a>
            <a href="/contact.html">Contact Us</a>
            <a href="/privacy.html">Privacy Policy</a>
            <a href="/terms.html">Terms of Service</a>
            <a href="/cookies.html">Cookie Notice</a>
          </nav>
        </div>
      </footer>
    </>
  );
}
