// BeautyPriceMatch.com — one-time seed for awin_programmes.
//
// Loads the two known-good advertisers' real datafeed IDs so the sync has
// a known-good starting point; awinProgrammeChecker.js keeps this table
// current automatically after that, for any newly approved programme.

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
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

  const rows = [
    { advertiser_id: 102013, advertiser_name: 'Zlike Hair', datafeed_id: 'F753' },
    { advertiser_id: 108282, advertiser_name: 'Sol Labs', datafeed_id: '99929' },
  ];

  for (const r of rows) {
    await pool.query(
      `INSERT INTO awin_programmes (advertiser_id, advertiser_name, status, datafeed_id, last_checked_at)
       VALUES ($1,$2,'joined',$3,NOW())
       ON CONFLICT (advertiser_id)
       DO UPDATE SET advertiser_name=$2, status='joined', datafeed_id=$3, last_checked_at=NOW()`,
      [r.advertiser_id, r.advertiser_name, r.datafeed_id]
    );
    console.log(`Seeded: ${r.advertiser_name} (advertiser ${r.advertiser_id}, datafeed ${r.datafeed_id})`);
  }

  console.log('\nDone. awinSync.js can now run and will pick up both programmes.');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
