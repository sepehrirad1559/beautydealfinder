// Vercel serverless function, served at /sitemap.xml via the rewrite in
// vercel.json (this replaces the old static public/sitemap.xml, which has
// been removed — a static file at that path would otherwise take
// precedence over the rewrite and this function would never run).
//
// Pulls the current indexable product/brand/category URL set straight
// from the backend's /api/seo/sitemap-data endpoint (see
// backend/src/routes/seo.js) so the sitemap can never drift out of sync
// with which pages actually pass their own indexability gate (Parts
// 2/3/6/7/8 of the SEO strategy doc) — there is no separately-maintained
// list to go stale. The hand-authored blog/legal pages are still real,
// static, indexable pages, so they're listed here too, alongside the
// dynamic ones.
const SITE = 'https://www.beautypricematch.com';
const API_URL = (process.env.VITE_API_URL || 'https://beautydealfinder-backend.up.railway.app/api').replace(/\/$/, '');

const STATIC_PAGES = [
  { loc: `${SITE}/`, changefreq: 'daily', priority: '1.0' },
  { loc: `${SITE}/deals`, changefreq: 'daily', priority: '0.9' },
  { loc: `${SITE}/blog/`, changefreq: 'weekly', priority: '0.8' },
  { loc: `${SITE}/blog/cerave-vs-la-roche-posay-moisturizer.html`, changefreq: 'monthly', priority: '0.6' },
  { loc: `${SITE}/blog/drugstore-dupes-for-skincare.html`, changefreq: 'monthly', priority: '0.6' },
  { loc: `${SITE}/blog/the-ordinary-niacinamide-price-comparison.html`, changefreq: 'monthly', priority: '0.6' },
  { loc: `${SITE}/blog/maybelline-fit-me-foundation-cheapest-price.html`, changefreq: 'monthly', priority: '0.6' },
  { loc: `${SITE}/about.html`, changefreq: 'monthly', priority: '0.5' },
  { loc: `${SITE}/contact.html`, changefreq: 'monthly', priority: '0.3' },
  { loc: `${SITE}/privacy.html`, changefreq: 'yearly', priority: '0.2' },
  { loc: `${SITE}/terms.html`, changefreq: 'yearly', priority: '0.2' },
  { loc: `${SITE}/cookies.html`, changefreq: 'yearly', priority: '0.2' },
];

function urlEntry({ loc, lastmod, changefreq, priority }) {
  return `  <url>\n    <loc>${loc}</loc>\n${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ''}    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
}

export default async function handler(req, res) {
  let dynamicEntries = [];
  try {
    const r = await fetch(`${API_URL}/seo/sitemap-data`);
    const data = await r.json();
    dynamicEntries = [
      ...(data.products || []).map((p) => ({ loc: `${SITE}${p.path}`, lastmod: p.updatedAt, changefreq: 'daily', priority: '0.8' })),
      ...(data.brands || []).map((b) => ({ loc: `${SITE}${b.path}`, changefreq: 'weekly', priority: '0.6' })),
      ...(data.categories || []).map((c) => ({ loc: `${SITE}${c.path}`, changefreq: 'weekly', priority: '0.6' })),
    ];
  } catch (err) {
    // If the backend is briefly unreachable, still serve the static pages
    // rather than a 500 — a sitemap missing today's new products for one
    // cycle is far less damaging than Googlebot getting an error on the
    // whole sitemap and backing off the crawl.
    console.error('sitemap: failed to load dynamic data', err);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...STATIC_PAGES, ...dynamicEntries].map(urlEntry).join('\n')}\n</urlset>`;

  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  res.status(200).send(xml);
}
