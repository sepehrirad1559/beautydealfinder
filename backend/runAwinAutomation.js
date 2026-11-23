// BeautyPriceMatch.com — single entry point for the scheduled feed automation.
//
// This is the ONE command the Railway Cron Job actually runs. It does,
// in order:
//   1. Check Awin for newly-approved programmes (awinProgrammeChecker.js)
//   2. Sync every joined Awin programme's products/prices/stock (awinSync.js)
//   3. Sync every configured Impact.com brand catalog (impactSync.js)
//
// Nothing here needs a human. Run manually once to confirm it works, then
// let the Railway Cron Job take over.
//
// OVERLAP GUARD (added for catalog-scale growth): as the number of joined
// Awin programmes and Impact catalogs grows toward the thousands of SKUs
// each, a single run can take long enough that the next scheduled fire
// could start before the previous one finishes — two copies writing to
// the same products/offers rows at once. A Postgres advisory lock (a
// plain integer lock keyed to this job's name, released automatically if
// the process dies) makes a second concurrent run exit immediately
// instead of racing the first one.
import { execFileSync } from 'child_process';
import { Pool } from 'pg';

function run(script) {
    console.log(`\n===== Running ${script} =====`);
    try {
          execFileSync('node', [script], { stdio: 'inherit' });
    } catch (e) {
          console.error(`${script} exited with an error (see above). Continuing.`);
    }
}

// hashtext() of a fixed string gives a stable 32-bit lock key without
// needing to coordinate a magic number by hand.
const LOCK_KEY_SQL = `SELECT pg_try_advisory_lock(hashtext('beautypricematch_feed_automation')) AS acquired`;
const UNLOCK_SQL = `SELECT pg_advisory_unlock(hashtext('beautypricematch_feed_automation')) AS released`;

async function main() {
    const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false },
    });

  let acquired = false;
    try {
          const { rows } = await pool.query(LOCK_KEY_SQL);
          acquired = rows[0]?.acquired === true;
    } catch (e) {
          console.error('Could not check the automation lock (DB unreachable?) — aborting this run:', e.message);
          await pool.end().catch(() => {});
          process.exit(1);
    }

  if (!acquired) {
        console.log('Another feed-automation run already holds the lock — skipping this run to avoid a race.');
        await pool.end().catch(() => {});
        return;
  }

  try {
        console.log(`Feed automation run started: ${new Date().toISOString()}`);
        run('awinProgrammeChecker.js');
        run('awinSync.js');
        run('impactSync.js');
        console.log(`\nFeed automation run finished: ${new Date().toISOString()}`);
  } finally {
        try {
                await pool.query(UNLOCK_SQL);
        } catch (e) {
                console.error('Could not release the automation lock (it will auto-release when this connection closes):', e.message);
        }
        await pool.end().catch(() => {});
  }
}

main().catch((e) => {
    console.error('Fatal error in feed automation:', e);
    process.exit(1);
});
