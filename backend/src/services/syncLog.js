import { pool } from '../db.js';

// Logs every provider sync run, success or failure, so "why is coverage
// sparse for retailer X" is answerable from the database (see sync_logs in
// db/schema.sql) instead of digging through server logs.
export async function logProviderSync({ providerName, syncType, startedAt, finishedAt, recordsReceived, recordsUpdated, productsCreated, status, errorMessage }) {
  try {
    await pool.query(
      `INSERT INTO sync_logs (provider_name, sync_type, started_at, finished_at, records_received, records_updated, products_created, status, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [providerName, syncType, startedAt, finishedAt ?? null, recordsReceived ?? null, recordsUpdated ?? null, productsCreated ?? null, status, errorMessage ?? null]
    );
  } catch (error) {
    console.error('Failed to write sync log:', error.message);
  }
}

export default { logProviderSync };
