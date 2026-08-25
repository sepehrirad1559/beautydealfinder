# Going live: deployment checklist

Split into what's already handled in the code vs. what only you can do (account creation, payment,
and affiliate applications aren't things I'm able to do on your behalf).

## ✅ Already done in the code

- `backend/railway.json` — Railway build/start/healthcheck config
- `frontend/vercel.json` — Vercel build config for the Vite frontend
- CORS restricted to `FRONTEND_URL` env var (was wide-open before — fixed for real traffic)
- Seed script refuses to run against `NODE_ENV=production` without an explicit override, so
  fabricated demo data can't accidentally end up in front of real customers
- Legal page drafts: `/privacy.html`, `/terms.html`, `/cookies.html` (fill in the placeholders —
  see "Legal" section below)
- Honest launch-state UI: the site now says "Amazon · Live" and lists the other five retailers as
  "Coming soon" instead of implying all six have real data

## 🔲 Steps only you can do

### 1. Database
- Create a PostgreSQL database. Railway can provision one directly in the same project as the
  backend ("New" → "Database" → "PostgreSQL") — simplest option, gives you `DATABASE_URL`
  automatically wired into the backend service's environment.

### 2. Backend (Railway, or any Node host)
- Create a Railway account, new project, deploy from this repo's `backend/` directory (or point it
  at the repo root with a root directory setting of `backend`).
- Set environment variables (see `backend/.env.example`): at minimum `DATABASE_URL` (auto-set if
  using Railway's Postgres addon), `FRONTEND_URL` (your Vercel URL, once you have it),
  `SYNC_SECRET_KEY` and `ADMIN_DASHBOARD_PASSWORD` (pick strong random values), `CLICK_SALT` (a
  random string).
- Deploy. Confirm `GET https://<your-backend>/api/health` returns `{"status":"ok"}`.

### 3. Frontend (Vercel)
- Create a Vercel account, import this repo, set the root directory to `frontend`.
- Set `VITE_API_URL` to your deployed backend's URL + `/api` (e.g. `https://your-backend.up.railway.app/api`).
- Deploy. Confirm the site loads and product search hits the real backend (check the browser network
  tab for `/api/products` requests succeeding).

### 4. Domain
- Buy `beautydealfinder.com` (or your chosen domain) through any registrar (Namecheap, Google
  Domains successor, Cloudflare, etc.).
- Point it at Vercel per Vercel's domain docs (usually a CNAME or Vercel's nameservers).

### 5. Amazon Associates + PA-API (the one real data source at launch)
- Apply at https://affiliate-program.amazon.com/ — requires your live site URL, so do this *after*
  steps 2–4 are done and the site is actually up (even with the seed/demo data showing, so there's
  something to review).
- Amazon requires 3 qualifying sales within 180 days of joining to keep API access — read their
  current terms, this changes periodically.
- Once approved for PA-API specifically (a separate step from basic Associates approval — see
  https://webservices.amazon.com/paapi5/documentation/), get your `AMAZON_ACCESS_KEY`,
  `AMAZON_SECRET_KEY`, and set `AMAZON_PARTNER_TAG` to your Associates tracking ID. Add all three to
  the backend's environment variables and redeploy.
- Trigger a real sync: `POST /admin/sync/amazon` with header `x-sync-key: <your SYNC_SECRET_KEY>`.
  Amazon items are matched into the central `products` table automatically (by UPC/EAN, then by
  brand+name+shade+size) — no separate rebuild step needed.
- **Once real Amazon data is flowing, remove the seed data**: `DELETE FROM products WHERE id NOT IN (SELECT DISTINCT product_id FROM offers WHERE retailer <> 'amazon' OR retailer_product_id NOT LIKE 'seed-%');`
  is overkill — simplest is `DELETE FROM offers WHERE retailer_product_id LIKE 'seed-%'; DELETE FROM products WHERE id NOT IN (SELECT product_id FROM offers);` via a database console — this clears the
  fabricated demo rows (and any product left with zero real offers) so customers only ever see real prices.

### 6. The other five retailers (Sephora, Ulta, Beautylish, Glossier, Cult Beauty)
- Apply to their affiliate programs once the site is live and has some traffic to show (Rakuten
  Advertising, CJ Affiliate, Awin, and ShareASale are the networks most beauty retailers use — check
  each retailer's own footer for an "Affiliates" link to confirm which network they're actually on).
- Once approved, add an entry to `backend/src/config/feedSources.js` with that network's feed URL and
  field mapping (see the commented example in that file), set `active = true` for the retailer in the
  `retailers` table, then `POST /admin/sync/<retailer>`. The importer
  (`backend/src/services/affiliateFeed.js`) reads the network's own CSV/JSON feed and writes through
  the same central-database path Amazon uses — it never touches the retailer's website. This is the
  ONLY supported way to bring a non-Amazon retailer online; there is no scraper to fall back to.

### 7. Legal
- Fill in every `[bracketed placeholder]` in `privacy.html`, `terms.html`, and `cookies.html` with
  your actual business name, contact email, and jurisdiction.
- Have an actual lawyer review these before real customers rely on them — I drafted reasonable
  starting points, but I'm not a lawyer and this isn't legal advice, especially around GDPR/CCPA if
  you'll have EU or California visitors.

### 8. Monitoring (recommended, not blocking launch)
- Set up uptime monitoring on `/api/health` (e.g. UptimeRobot, free tier).
- Check `GET /admin/health` periodically (needs the dashboard bearer token — see `POST /admin/auth/login`)
  to watch for sync failures.
