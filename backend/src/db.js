import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

// The Postgres connection pool lives in its own module, separate from
// index.js. Every route/service imports `pool` from here instead of from
// index.js — index.js itself also imports it from here. This avoids a
// circular import (index.js -> routes/*.js -> back to index.js) that
// deadlocks Node's ESM loader when combined with index.js's top-level
// `await import(...)` calls (symptom: "Detected unsettled top-level
// await", process exits with code 13, no error message).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

export default pool;
