// Runs every non-live verify_*.js script in this folder as a child process and reports a summary.
// "Non-live" = everything except verify_depth_proto.js, which needs real network access to MEXC
// and is meant to be run manually/on-demand (see its own header comment) — see also
// docs/13-round13.md and the pattern-engine plan for why live-market scripts are kept separate.
// Run: node tests/run_all.js  (or: npm test)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const LIVE_ONLY = new Set(['verify_depth_proto.js']);

const scripts = fs.readdirSync(dir)
  .filter(f => f.startsWith('verify_') && f.endsWith('.js') && !LIVE_ONLY.has(f))
  .sort();

if (!scripts.length) {
  console.log('No verify_*.js scripts found.');
  process.exit(0);
}

let failed = 0;
scripts.forEach(function (f) {
  console.log('\n=== ' + f + ' ===');
  const res = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
});

console.log('\n' + '='.repeat(50));
console.log((scripts.length - failed) + '/' + scripts.length + ' verify scripts passed.');
if (LIVE_ONLY.size) {
  console.log('Skipped (live/manual only): ' + Array.from(LIVE_ONLY).join(', '));
}
process.exit(failed ? 1 : 0);
