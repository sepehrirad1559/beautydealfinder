import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import 'express-async-errors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './db.js';

// Re-exported for anything that imports { pool } from './index.js' —
// nothing in this codebase should do that anymore (every route/service
// imports it from ./db.js directly, to avoid a circular-import deadlock
// with this file's top-level `await import(...)` calls below), but this
// keeps the export path available just in case.
export { pool };

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Apply the schema on boot — idempotent (every statement is CREATE TABLE
// IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), so this is safe to run on
// every deploy rather than needing separate migration-trigger routes.
async function applySchema() {
  const schemaPath = path.join(__dirname, 'db', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schema);
  console.log('✅ Schema applied');
}

const app = express();
app.use(helmet());
// Wide-open CORS is fine for local dev (no FRONTEND_URL set) but not for a
// live site with real customers — restrict to the configured frontend
// origin(s) once deployed. Comma-separated to support a staging + prod
// frontend at once.
const allowedOrigins = process.env.FRONTEND_URL?.split(',').map((s) => s.trim());
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : {}));
app.use(express.json());
app.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

// Routes import `pool` from ./db.js, not from this file, so these dynamic
// imports no longer cycle back into this module — safe to await at the
// top level.
const { default: productsRoutes } = await import('./routes/products.js');
const { default: adminRoutes } = await import('./routes/admin.js');
const { default: redirectRoutes } = await import('./routes/redirect.js');

app.use('/api/products', productsRoutes);
app.use('/admin', adminRoutes);
app.use('/go', redirectRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 30011;

async function start() {
  await applySchema();
  app.listen(PORT, () => {
    console.log(`🚀 Beauty Deal Finder backend running on port ${PORT}`);
  });

  // Daily automatic sync across every configured provider (the Amazon
  // PA-API client, plus whatever affiliate feeds are configured in
  // config/feedSources.js) — staggered after boot so a redeploy doesn't
  // immediately hammer every provider at once. Each sync writes straight
  // into the central products/offers tables via services/productStore.js
  // (product matching happens at write time, not as a separate rebuild
  // pass), so the compare view reflects new data as soon as a sync
  // finishes.
  const { getProvider, listProviderNames } = await import('./providers/registry.js');
  const { logProviderSync } = await import('./services/syncLog.js');

  const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

  async function runScheduledSync() {
    for (const name of listProviderNames()) {
      console.log(`🔄 Running scheduled ${name} sync...`);
      const startedAt = new Date();
      try {
        const result = await getProvider(name).sync();
        await logProviderSync({
          providerName: name, syncType: name === 'amazon' ? 'official_api' : 'affiliate_feed', startedAt, finishedAt: new Date(),
          recordsReceived: result.totalFound ?? null,
          recordsUpdated: result.totalStored ?? null,
          productsCreated: result.productsCreated ?? null,
          status: result.success ? 'success' : 'error', errorMessage: result.error ?? null,
        });
      } catch (err) {
        console.error(`Scheduled ${name} sync failed:`, err);
        await logProviderSync({ providerName: name, syncType: name === 'amazon' ? 'official_api' : 'affiliate_feed', startedAt, finishedAt: new Date(), status: 'error', errorMessage: err.message });
      }
    }
  }

  setTimeout(runScheduledSync, 10 * 60 * 1000);
  setInterval(runScheduledSync, SYNC_INTERVAL_MS);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
