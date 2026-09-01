// BeautyPriceMatch.com — Awin programme-approval checker.
//
// WHAT THIS DOES:
//   Asks Awin's own Publisher API "which programmes am I actually joined
//   to right now" and syncs that list into a new `awin_programmes` table.
//   Any programme that is newly Joined (wasn't in our table before, or
//   just flipped from pending -> joined) gets picked up automatically —
//   no one has to notice the approval email or tell Claude about it.
//
//   awinSync.js (the product/price sync script) reads its list of
//   advertisers to sync FROM this table. So the loop is fully closed:
//   Awin approves you -> this script notices on its next run -> the next
//   sync run picks up that merchant's products automatically.
//
// REQUIRES (Railway service Variables tab):
//   AWIN_API_TOKEN     — OAuth2 access token from https://ui.awin.com/awin-api
//                         (Awin account -> Tools -> API -> create token,
//                         scope: "Publisher — Read Programme Details")
//   AWIN_PUBLISHER_ID  — your Awin publisher/affiliate ID (3062047 for
//                         this account)
//   DATABASE_URL       — already set, same Postgres DB as everything else
//
// HOW TO RUN MANUALLY (first time, to create the table and do an initial sync):
//   Upload to Railway Console -> Files panel, then: node awinProgrammeChecker.js
//
// After that, this is meant to run on a schedule — see run-all.js and the
// Railway Cron Job setup instructions delivered alongside this file.

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const AWIN_API_TOKEN = process.env.AWIN_API_TOKEN;
const AWIN_PUBLISHER_ID = process.env.AWIN_PUBLISHER_ID;

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS awin_programmes (
      advertiser_id BIGINT PRIMARY KEY,
      advertiser_name TEXT NOT NULL,
      status TEXT NOT NULL,
      datafeed_id TEXT,
      first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_checked_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}

async function fetchJoinedProgrammes() {
  if (!AWIN_API_TOKEN || !AWIN_PUBLISHER_ID) {
    throw new Error(
      'Missing AWIN_API_TOKEN or AWIN_PUBLISHER_ID environment variables. ' +
      'Set these in Railway -> beautypricematch-backend -> Variables.'
    );
  }
  const url = `https://api.awin.com/publishers/${AWIN_PUBLISHER_ID}/programmes?relationship=joined`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AWIN_API_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Awin API error ${res.status}: ${await res.text()}`);
  }
  return res.json(); // array of { id, name, ... }
}

async function fetchDatafeedId(advertiserId) {
  try {
    const url = `https://api.awin.com/publishers/${AWIN_PUBLISHER_ID}/programmes/${advertiserId}/datafeeds`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AWIN_API_TOKEN}` },
    });
    if (!res.ok) return null;
    const feeds = await res.json();
    const csvFeed = feeds.find((f) => (f.format || '').toLowerCase() === 'csv') || feeds[0];
    return csvFeed ? String(csvFeed.id) : null;
  } catch {
    return null;
  }
}

async function main() {
  await ensureTable();
  const joined = await fetchJoinedProgrammes();
  console.log(`Awin reports ${joined.length} joined programme(s).`);

  const existingRes = await pool.query(`SELECT advertiser_id FROM awin_programmes`);
  const known = new Set(existingRes.rows.map((r) => String(r.advertiser_id)));

  let newlyApproved = 0;
  for (const p of joined) {
    const advertiserId = p.id;
    const name = p.name || `Advertiser ${advertiserId}`;
    const isNew = !known.has(String(advertiserId));

    const datafeedId = await fetchDatafeedId(advertiserId);

    await pool.query(
      `INSERT INTO awin_programmes (advertiser_id, advertiser_name, status, datafeed_id, last_checked_at)
       VALUES ($1,$2,'joined',$3,NOW())
       ON CONFLICT (advertiser_id)
       DO UPDATE SET advertiser_name=$2, status='joined',
         datafeed_id=COALESCE($3, awin_programmes.datafeed_id), last_checked_at=NOW()`,
      [advertiserId, name, datafeedId]
    );

    if (isNew) {
      newlyApproved++;
      console.log(`NEW APPROVAL: ${name} (advertiser ${advertiserId}) — datafeed: ${datafeedId || 'none found'}`);
    } else {
      console.log(`already known: ${name} (advertiser ${advertiserId})`);
    }
  }

  console.log(`\nDone. ${newlyApproved} newly-approved programme(s) added to the sync list.`);
  console.log(`Total tracked joined programmes: ${joined.length}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
