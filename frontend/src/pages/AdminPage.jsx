import React, { useEffect, useState } from 'react';
import { API_URL } from '../App.jsx';
import { useSeo } from '../seo.js';

// Password-gated ops dashboard (Search Console/social-performance requests
// keep coming up, and the only way to answer them so far has been asking
// someone with Railway access to read raw DB rows over chat — this makes
// it self-serve). Exchanges ADMIN_DASHBOARD_PASSWORD for a signed,
// short-lived token via POST /admin/auth/login (see backend/src/routes/
// admin.js), then reads /admin/health and /admin/stats with it. The token
// only lives in sessionStorage — closing the tab signs you out, and
// nothing here is indexable or linked from anywhere else in the site.
const TOKEN_KEY = 'bdf_admin_token';

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function fmtDay(day) {
  // Postgres DATE comes back as an ISO string already at midnight UTC.
  return new Date(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function AdminPage() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  const [health, setHealth] = useState(null);
  const [stats, setStats] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);

  useSeo({ title: 'Admin | BeautyPriceMatch', robots: 'noindex,nofollow' });

  async function loadDashboard(activeToken) {
    setLoading(true);
    setLoadError('');
    try {
      const headers = { Authorization: `Bearer ${activeToken}` };
      const [healthRes, statsRes] = await Promise.all([
        fetch(`${API_URL}/admin/health`, { headers }),
        fetch(`${API_URL}/admin/stats`, { headers }),
      ]);
      if (healthRes.status === 401 || statsRes.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken('');
        setLoadError('Your session expired — please log in again.');
        return;
      }
      if (!healthRes.ok || !statsRes.ok) throw new Error('Request failed');
      setHealth(await healthRes.json());
      setStats(await statsRes.json());
    } catch (e) {
      setLoadError('Could not load dashboard data. Is the backend reachable?');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (token) loadDashboard(token);
  }, [token]);

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError('');
    setLoggingIn(true);
    try {
      const res = await fetch(`${API_URL}/admin/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) {
        setLoginError(data.error || 'Login failed.');
        return;
      }
      sessionStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setPassword('');
    } catch {
      setLoginError('Could not reach the backend.');
    } finally {
      setLoggingIn(false);
    }
  }

  function handleLogout() {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken('');
    setHealth(null);
    setStats(null);
  }

  if (!token) {
    return (
      <main className="page admin-page">
        <div className="admin-login">
          <h1>Admin</h1>
          <p className="subhead">Sign in to view site health, click activity, and social-source performance.</p>
          <form onSubmit={handleLogin}>
            <input
              type="password"
              placeholder="Admin password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            <button type="submit" disabled={loggingIn || !password}>
              {loggingIn ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          {loginError && <p className="admin-error">{loginError}</p>}
        </div>
      </main>
    );
  }

  return (
    <main className="page admin-page">
      <div className="admin-header">
        <h1>Admin dashboard</h1>
        <button className="admin-logout" onClick={handleLogout}>Log out</button>
      </div>

      {loading && <p className="empty-state">Loading…</p>}
      {loadError && <p className="admin-error">{loadError}</p>}

      {health && (
        <section className="admin-section">
          <h2>Inventory & sync health</h2>
          <div className="admin-cards">
            <div className="admin-card">
              <div className="admin-card-value">{health.centralProductCount?.toLocaleString()}</div>
              <div className="admin-card-label">Total products</div>
            </div>
            <div className="admin-card">
              <div className="admin-card-value">{health.configuredProviders?.length ?? 0}</div>
              <div className="admin-card-label">Configured providers</div>
            </div>
          </div>

          <h3>Offers by retailer</h3>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>Retailer</th><th>Offers</th><th>Stale</th></tr></thead>
              <tbody>
                {health.offersByRetailer?.map((r) => {
                  const stale = health.staleOffersByRetailer?.find((s) => s.retailer === r.retailer);
                  return (
                    <tr key={r.retailer}>
                      <td>{r.retailer}</td>
                      <td>{Number(r.count).toLocaleString()}</td>
                      <td>{stale ? Number(stale.stale_count).toLocaleString() : 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <h3>Recent syncs</h3>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>Provider</th><th>Type</th><th>Started</th><th>Status</th><th>Added / Updated</th></tr></thead>
              <tbody>
                {health.recentSyncs?.map((s, i) => (
                  <tr key={i}>
                    <td>{s.provider_name}</td>
                    <td>{s.sync_type}</td>
                    <td>{fmtDate(s.started_at)}</td>
                    <td><span className={`admin-status admin-status-${s.status}`}>{s.status}</span></td>
                    <td>{s.products_created ?? '—'} / {s.records_updated ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {stats && (
        <section className="admin-section">
          <h2>Click activity</h2>
          <div className="admin-cards">
            <div className="admin-card">
              <div className="admin-card-value">
                {stats.clicksByRetailer?.reduce((sum, r) => sum + Number(r.clicks), 0).toLocaleString()}
              </div>
              <div className="admin-card-label">Total clicks (all time)</div>
            </div>
            <div className="admin-card">
              <div className="admin-card-value">
                {stats.clicksLast7Days?.reduce((sum, r) => sum + Number(r.clicks), 0).toLocaleString() || 0}
              </div>
              <div className="admin-card-label">Clicks (last 7 days)</div>
            </div>
          </div>

          <h3>Clicks per day</h3>
          {stats.clicksLast7Days?.length ? (
            <div className="admin-bars">
              {stats.clicksLast7Days.map((d) => {
                const max = Math.max(...stats.clicksLast7Days.map((x) => Number(x.clicks)), 1);
                return (
                  <div className="admin-bar-col" key={d.day}>
                    <div className="admin-bar" style={{ height: `${(Number(d.clicks) / max) * 100}%` }} title={`${d.clicks} clicks`} />
                    <div className="admin-bar-label">{fmtDay(d.day)}</div>
                    <div className="admin-bar-value">{d.clicks}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="empty-state small">No clicks recorded in the last 7 days yet.</p>
          )}

          <h3>Clicks by retailer</h3>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>Retailer</th><th>Clicks</th></tr></thead>
              <tbody>
                {stats.clicksByRetailer?.length ? stats.clicksByRetailer.map((r) => (
                  <tr key={r.retailer}><td>{r.retailer}</td><td>{r.clicks}</td></tr>
                )) : <tr><td colSpan={2} className="admin-empty-cell">No clicks yet.</td></tr>}
              </tbody>
            </table>
          </div>

          <h3>Social & marketing sources</h3>
          <p className="subhead">
            Every link shared with a <code>?sid=</code> tag (e.g. <code>?sid=fb_amysbeauty</code>, <code>?sid=ig_launchpost</code>) is tracked
            here separately from untagged organic/direct traffic — this is how you tell whether a specific post actually drove clicks.
          </p>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>Source tag</th><th>Clicks</th></tr></thead>
              <tbody>
                {stats.clicksBySource?.length ? stats.clicksBySource.map((r) => (
                  <tr key={r.source}>
                    <td>{r.source === '(untagged)' ? <em>Untagged / direct</em> : r.source}</td>
                    <td>{r.clicks}</td>
                  </tr>
                )) : <tr><td colSpan={2} className="admin-empty-cell">No clicks yet.</td></tr>}
              </tbody>
            </table>
          </div>

          <h3>Top clicked products</h3>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>Product</th><th>Retailer</th><th>Clicks</th></tr></thead>
              <tbody>
                {stats.topProducts?.length ? stats.topProducts.map((p, i) => (
                  <tr key={i}><td>{p.product_name}</td><td>{p.retailer}</td><td>{p.clicks}</td></tr>
                )) : <tr><td colSpan={3} className="admin-empty-cell">No clicks yet.</td></tr>}
              </tbody>
            </table>
          </div>

          <p className="admin-note">
            Note: this tracks clicks through to a retailer, not confirmed purchases — none of Amazon Associates, Awin, or
            Impact.com send purchase confirmations back into this app. Check each network's own dashboard for actual sales
            and commission figures.
          </p>
        </section>
      )}
    </main>
  );
}

