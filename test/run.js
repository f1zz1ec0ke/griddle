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
 *   TEST_TIMEOUT=900000 npm test  how long one worker may spend on its whole shard, in ms
 *   npm test -- "the grill recipe"   only tests whose name contains this
 *
 * **TEST_TIMEOUT bounds a worker's shard, not a single test**, because that is the only thing node
 * will bound. Two measurements, both on node 22:
 *   - `--test-timeout` is applied to the test that wraps the whole *file*: four 150 ms tests under
 *     `--test-timeout=400` all pass and then the file is cancelled at 401 ms. So the number caps
 *     the sum of everything a worker was dealt, and when it is hit the rest of that shard is
 *     cancelled where it stands.
 *   - a per-test `{ timeout }` cannot help, because it cannot stop a *synchronous* test: the timer
 *     is a task on the event loop and every test here is one long synchronous grind through the
 *     model, so it only gets its turn once the test it was meant to cut short has finished anyway
 *     (an 800 ms synchronous test under a 200 ms timeout passes). Nor can a watchdog out here read
 *     progress: `node --test` reports a file's results when the file is done, so a worker's output
 *     arrives in one lump at the end (measured: 12.8 s of tests, first byte at 12.77 s).
 * So: one number, one meaning, and the test that pins it is "the shard timeout is a cap on the
 * worker" in physics.test.js. A hung *single* test is caught by the shard cap it eats, and on CI by
 * the job's own timeout-minutes.
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'physics.test.js');
const WORKERS = Math.max(1, Number(process.env.TEST_WORKERS || Math.min(4, os.cpus().length || 1)));
// One worker's whole shard (see the header). Measured on this box (4 cores, node 22): a quarter of
// the file is 58–83 s on four workers, the whole file in one worker (TEST_WORKERS=1) is 227 s, and
// the slowest single test in it is 17 s. Ten minutes is seven times the worst shard and two and a
// half times the serial run — room for a much slower machine and a heavier suite, and it still
// fails fast against the CI job's own twenty minutes.
const TIMEOUT = Number(process.env.TEST_TIMEOUT || 600000);

/**
 * Every `test('name', …)` in the file, in source order (duplicates included), at any indentation:
 * a test declared inside a loop or a block is still a test, and a runner that cannot see it deals
 * it to nobody while `node --test` runs it — a green shard over a suite with a hole in it.
 * Throws on a name built out of a template, because `--test-name-pattern` can never match one.
 */
function testNames(src) {
  const out = [];
  const re = /^[ \t]*test(?:\.only)?\(\s*(['"`])((?:\\.|(?!\1)[^])*)\1/gm;
  let m;
  while ((m = re.exec(src))) {
    const name = m[2].replace(/\\(['"`\\])/g, '$1');
    if (name.includes('${')) throw new Error(`This test's name is a template: ${JSON.stringify(name)}.\n`
      + '  The runner deals tests out by name, and no --test-name-pattern can match a name that is\n'
      + '  only known at run time. Give it a literal name (spell the loop variable into the string\n'
      + '  by hand, one test() per case) and this will run again.');
    out.push(name);
  }
  return out;
}
/**
 * An independent count of the declarations in the file, deliberately not sharing the scan above:
 * if the two ever disagree the name scan has stopped seeing a test, and that is exactly the failure
 * the runner cannot notice on its own (a test it never deals out is a test it never misses).
 */
function countTests(src) {
  const re = /\btest(?:\.only)?\(\s*['"`]/g;
  let n = 0;
  while (re.exec(src)) n++;
  return n;
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
      // the last name the reporter printed: whatever ran after it is what the shard cap caught
      const done = out.match(/^[✔✖][^\n]*?(?= \(\d)/gm);
      resolve({ i, code, out, lastName: done && done.length ? done[done.length - 1].slice(2) : null, seconds: (Date.now() - t0) / 1000, counts: { tests: num('tests'), pass: num('pass'), fail: num('fail'), cancelled: num('cancelled'), skipped: num('skipped') } });
    });
  });
}

async function main() {
  const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const src = fs.readFileSync(FILE, 'utf8');
  let names;
  try { names = testNames(src); } catch (e) { console.error(`${FILE}:\n${e.message}`); process.exit(2); }
  if (!names.length) { console.error(`No tests found in ${FILE}. Has the style of the file changed?`); process.exit(2); }
  const declared = countTests(src);
  if (names.length !== declared) {
    console.error(`Found ${names.length} test names in ${FILE} but ${declared} test(…) declarations.`
      + '\n  Something in that file is declared in a way the name scan cannot read, and a test this'
      + '\n  runner cannot name is a test it never runs. Fix the scan (testNames) or the declaration.');
    process.exit(2);
  }
  if (filter.length) names = names.filter((n) => filter.some((f) => n.includes(f)));
  if (!names.length) { console.error(`No test matches ${JSON.stringify(filter)}`); process.exit(2); }

  // two tests can share a name; the pattern for one of them matches both, so bucket the distinct
  // names but expect the count with duplicates back
  const unique = [...new Set(names)];
  const workers = Math.min(WORKERS, unique.length);
  const buckets = Array.from({ length: workers }, () => []);
  unique.forEach((n, i) => buckets[i % workers].push(n)); // round robin: the slow tests are scattered
  console.log(`griddle: ${names.length} tests across ${workers} worker${workers > 1 ? 's' : ''} (${(TIMEOUT / 1000).toFixed(0)} s per worker, for its whole shard)\n`);

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

  // a cancelled shard is a slow machine or a wedged model, not a broken runner: say so, and say
  // where it stopped, because the next question is always "which test was it in?"
  for (const r of results) {
    if (!r.counts.cancelled) continue;
    console.error(`worker ${r.i + 1} ran out of time: its shard passed the ${(TIMEOUT / 1000).toFixed(0)} s TEST_TIMEOUT after ${r.seconds.toFixed(0)} s and ${r.counts.cancelled} test(s) were cancelled.`
      + ` The last one it finished was ${r.lastName ? `“${r.lastName}”` : 'none at all'}, so look at the one after that — or give the shard longer.`);
  }
  const ran = total.pass + total.fail + total.cancelled + total.skipped;
  if (ran !== names.length) {
    console.error(`\n${names.length} tests were dealt out but ${ran} ran. Not calling that a pass.`
      + (total.cancelled ? ' A worker was cut short by the timeout above.' : ' That is a bug in the runner, or a worker that died.'));
    process.exit(3);
  }
  // a worker that died (the shard timeout cancels the file rather than failing a test) is a failure too
  const bad = total.fail > 0 || total.cancelled > 0 || results.some((r) => r.code !== 0);
  console.log(`# result ${bad ? 'FAIL' : 'pass'}`);
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main();
module.exports = { testNames, countTests, FILE, TIMEOUT };
