import express from 'express';
import crypto from 'crypto';
import { pool } from '../db.js';
import { logProviderSync } from '../services/syncLog.js';
import { getProvider, listProviderNames } from '../providers/registry.js';

const router = express.Router();
const STALE_OFFER_HOURS = Number(process.env.STALE_OFFER_HOURS || 48);

// --- Dashboard auth --------------------------------------------------
// Two-tier pattern: a low-privilege ADMIN_DASHBOARD_PASSWORD for viewing
// stats (exchanged for a short-lived signed token, never sent as a
// persistent secret), separate from the higher-privilege SYNC_SECRET_KEY
// required for anything that writes data (triggering syncs against the
// central product database).
function signToken(payload) {
  const secret = process.env.ADMIN_DASHBOARD_PASSWORD || '';
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const [body, sig] = String(token).split('.');
    const secret = process.env.ADMIN_DASHBOARD_PASSWORD || '';
    const expectedSig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (sig !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAdminAccess(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

router.post('/auth/login', (req, res) => {
  const expected = process.env.ADMIN_DASHBOARD_PASSWORD;
  if (!expected) return res.status(503).json({ error: 'ADMIN_DASHBOARD_PASSWORD is not configured on the server' });
  if (req.body?.password !== expected) return res.status(403).json({ error: 'Invalid password' });
  const token = signToken({ exp: Date.now() + 24 * 60 * 60 * 1000 });
  res.json({ success: true, token });
});

function requireSyncKey(req, res, next) {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (!expectedKey) return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  if (!providedKey || providedKey !== expectedKey) return res.status(403).json({ error: 'Invalid or missing sync key' });
  next();
}

// POST /admin/sync/:provider — triggers one provider's sync into the
// central product database by name ('amazon', the official PA-API client,
// or any retailer configured in config/feedSources.js as an affiliate
// feed). Runs in the background and responds immediately — an affiliate
// feed import can take a while, which would otherwise exceed a hosting
// platform's proxy timeout.
router.post('/sync/:provider', requireSyncKey, async (req, res) => {
  const provider = getProvider(req.params.provider);
  if (!provider) {
    return res.status(404).json({ error: `Unknown provider "${req.params.provider}". Known: ${listProviderNames().join(', ')}` });
  }

  const startedAt = new Date();
  res.json({ success: true, message: `${req.params.provider} sync started in the background. Check GET /admin/health or hosting logs for completion.` });

  provider.sync()
    .then((result) => logProviderSync({
      providerName: req.params.provider,
      syncType: req.params.provider === 'amazon' ? 'official_api' : 'affiliate_feed',
      startedAt, finishedAt: new Date(),
      recordsReceived: result.totalFound ?? null,
      recordsUpdated: result.totalStored ?? null,
      productsCreated: result.productsCreated ?? null,
      status: result.success ? 'success' : 'error', errorMessage: result.error ?? null,
    }))
    .catch((error) => {
      console.error(`Background ${req.params.provider} sync failed:`, error);
      return logProviderSync({
        providerName: req.params.provider,
        syncType: req.params.provider === 'amazon' ? 'official_api' : 'affiliate_feed',
        startedAt, finishedAt: new Date(),
        status: 'error', errorMessage: error.message,
      });
    });
});

router.get('/health', requireAdminAccess, async (req, res) => {
  try {
    const { rows: offerCounts } = await pool.query(
      `SELECT retailer, COUNT(*) AS count FROM offers GROUP BY retailer ORDER BY retailer`
    );
    const { rows: productCount } = await pool.query('SELECT COUNT(*) AS count FROM products');
    const { rows: staleCounts } = await pool.query(
      `SELECT retailer, COUNT(*) AS stale_count FROM offers
       WHERE last_updated < NOW() - INTERVAL '${STALE_OFFER_HOURS} hours' GROUP BY retailer ORDER BY retailer`
    );
    const { rows: recentSyncs } = await pool.query(
      `SELECT provider_name, sync_type, started_at, finished_at, records_received, records_updated, products_created, status, error_message
       FROM sync_logs ORDER BY started_at DESC LIMIT 20`
    );
    res.json({
      offersByRetailer: offerCounts,
      staleOffersByRetailer: staleCounts,
      staleOfferThresholdHours: STALE_OFFER_HOURS,
      centralProductCount: Number(productCount[0].count),
      recentSyncs,
      configuredProviders: listProviderNames(),
    });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ error: 'Failed to fetch health data' });
  }
});

router.get('/stats', requireAdminAccess, async (req, res) => {
  try {
    const { rows: clicksByRetailer } = await pool.query(
      `SELECT retailer, COUNT(*) AS clicks FROM clicks GROUP BY retailer ORDER BY clicks DESC`
    );
    const { rows: clicksLast7Days } = await pool.query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS clicks FROM clicks
       WHERE created_at >= NOW() - INTERVAL '7 days' GROUP BY day ORDER BY day`
    );
    const { rows: topProducts } = await pool.query(
      `SELECT p.product_name, o.retailer, COUNT(c.id) AS clicks
       FROM clicks c JOIN offers o ON o.id = c.offer_id JOIN products p ON p.id = o.product_id
       GROUP BY p.id, p.product_name, o.retailer ORDER BY clicks DESC LIMIT 20`
    );
    res.json({ clicksByRetailer, clicksLast7Days, topProducts });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
