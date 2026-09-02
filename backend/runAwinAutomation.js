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

import { execFileSync } from 'child_process';

function run(script) {
  console.log(`\n===== Running ${script} =====`);
  try {
    execFileSync('node', [script], { stdio: 'inherit' });
  } catch (e) {
    console.error(`${script} exited with an error (see above). Continuing.`);
  }
}

console.log(`Feed automation run started: ${new Date().toISOString()}`);
run('awinProgrammeChecker.js');
run('awinSync.js');
run('impactSync.js');
console.log(`\nFeed automation run finished: ${new Date().toISOString()}`);
// BeautyPriceMatch.com — single entry point for the scheduled Awin automation.
//
// This is the ONE command the Railway Cron Job actually runs. It does,
// in order:
//   1. Check Awin for newly-approved programmes (awinProgrammeChecker.js)
//   2. Sync every joined programme's products/prices/stock (awinSync.js)
//
// Nothing here needs a human. Run manually once to confirm it works, then
// let the Railway Cron Job take over.

import { execFileSync } from 'child_process';

function run(script) {
  console.log(`\n===== Running ${script} =====`);
  try {
    execFileSync('node', [script], { stdio: 'inherit' });
  } catch (e) {
    console.error(`${script} exited with an error (see above). Continuing.`);
  }
}

console.log(`Awin automation run started: ${new Date().toISOString()}`);
run('awinProgrammeChecker.js');
run('awinSync.js');
console.log(`\nAwin automation run finished: ${new Date().toISOString()}`);
