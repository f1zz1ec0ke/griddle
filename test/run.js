/*
 * test/run.js — the physics regression suite, spread across worker processes.  `npm test`
 *
 * `node --test test/physics.test.js` runs one file, and node runs the tests inside a file one after
 * another, so the whole suite is a single core grinding through several hundred simulated minutes
 * of cooking. The tests are independent (each one builds its own state), so this runner reads the
 * test names out of the file, deals them round-robin into as many buckets as there are workers, and
 * starts one `node --test --test-name-pattern=…` per bucket. Same tests, same file, same reporter —
 * only the wall clock changes.
 *
 * It refuses to be quietly wrong: if the buckets do not add up to the number of tests it found in
 * the file, it fails instead of reporting a green run over half a suite.
 *
 *   npm test                      all of it, on min(4, cores) workers
 *   TEST_WORKERS=1 npm test       serial, identical to `node --test test/physics.test.js`
 *   TEST_TIMEOUT=900000 npm test  per-test timeout in ms (default 10 minutes)
 *   npm test -- "the grill recipe"   only tests whose name contains this
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'physics.test.js');
const WORKERS = Math.max(1, Number(process.env.TEST_WORKERS || Math.min(4, os.cpus().length || 1)));
// The slowest single test today is about 20 s of wall clock; ten minutes leaves room for a very
// slow machine, a much heavier test, and four workers sharing the cores, without hanging CI for ever.
const TIMEOUT = Number(process.env.TEST_TIMEOUT || 600000);

/** Every top-level `test('name', …)` in the file, in source order (duplicates included). */
function testNames(src) {
  const out = [];
  const re = /^test\(\s*(['"`])((?:\\.|(?!\1)[^])*)\1/gm;
  let m;
  while ((m = re.exec(src))) out.push(m[2].replace(/\\(['"`\\])/g, '$1'));
  return out;
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function runWorker(names, i) {
  const pattern = `^(?:${names.map(escape).join('|')})$`;
  const args = ['--test', `--test-timeout=${TIMEOUT}`, '--test-reporter=spec', `--test-name-pattern=${pattern}`, FILE];
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('close', (code) => {
      const num = (k) => { const m = out.match(new RegExp(`^\\s*[ℹi]?\\s*${k} (\\d+)$`, 'm')); return m ? Number(m[1]) : 0; };
      resolve({ i, code, out, seconds: (Date.now() - t0) / 1000, counts: { tests: num('tests'), pass: num('pass'), fail: num('fail'), cancelled: num('cancelled'), skipped: num('skipped') } });
    });
  });
}

(async () => {
  const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  let names = testNames(fs.readFileSync(FILE, 'utf8'));
  if (!names.length) { console.error(`No tests found in ${FILE}. Has the style of the file changed?`); process.exit(2); }
  if (filter.length) names = names.filter((n) => filter.some((f) => n.includes(f)));
  if (!names.length) { console.error(`No test matches ${JSON.stringify(filter)}`); process.exit(2); }

  // two tests can share a name; the pattern for one of them matches both, so bucket the distinct
  // names but expect the count with duplicates back
  const unique = [...new Set(names)];
  const workers = Math.min(WORKERS, unique.length);
  const buckets = Array.from({ length: workers }, () => []);
  unique.forEach((n, i) => buckets[i % workers].push(n)); // round robin: the slow tests are scattered
  console.log(`griddle: ${names.length} tests across ${workers} worker${workers > 1 ? 's' : ''} (per-test timeout ${(TIMEOUT / 1000).toFixed(0)} s)\n`);

  const t0 = Date.now();
  const results = await Promise.all(buckets.map(runWorker));
  const total = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0 };
  for (const r of results) {
    process.stdout.write(r.out);
    for (const k in total) total[k] += r.counts[k];
  }
  const wall = (Date.now() - t0) / 1000;
  console.log('\n--- summary -------------------------------------------------');
  for (const r of results) console.log(`  worker ${r.i + 1}: ${r.counts.pass} passed, ${r.counts.fail} failed, ${r.seconds.toFixed(1)} s`);
  console.log(`# tests ${total.tests}`);
  console.log(`# pass ${total.pass}`);
  console.log(`# fail ${total.fail}`);
  if (total.cancelled) console.log(`# cancelled ${total.cancelled}`);
  if (total.skipped) console.log(`# skipped ${total.skipped}`);
  console.log(`# duration ${wall.toFixed(1)} s`);

  const ran = total.pass + total.fail + total.cancelled + total.skipped;
  if (ran !== names.length) {
    console.error(`\nBUG: ${names.length} tests were dealt out but ${ran} ran. Not calling that a pass.`);
    process.exit(3);
  }
  // a worker that died (a timeout cancels the file rather than failing a test) is a failure too
  const bad = total.fail > 0 || total.cancelled > 0 || results.some((r) => r.code !== 0);
  console.log(`# result ${bad ? 'FAIL' : 'pass'}`);
  process.exit(bad ? 1 : 0);
})();
