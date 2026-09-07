/*
 * test/e2e/run.js — the end-to-end runner.  `npm run e2e [scenario ...]`
 *
 * Each scenario boots the real page in Chromium (software WebGL), plays a ticket through the real
 * buttons, and fails if anything throws, if the score is not what the recipe promises, or if the
 * page logged a single uncaught error. Screenshots land in test/e2e/out/ (gitignored).
 *
 * Playwright is expected to be installed globally, not in the repo:
 *     NODE_PATH=/opt/node22/lib/node_modules npm run e2e
 */
'use strict';
const path = require('path');
const { runScenario, OUT } = require('./helper');

const SCENARIOS = [
  require('./scenario-medium-rare.js'),
  require('./scenario-ticket-of-three.js'),
  require('./scenario-charcoal.js'),
  require('./scenario-shift.js'),
  require('./scenario-viewport.js'),
  require('./scenario-interface.js'),
];

(async () => {
  const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const list = want.length ? SCENARIOS.filter((s) => want.includes(s.name)) : SCENARIOS;
  if (!list.length) {
    console.error(`No such scenario. Known: ${SCENARIOS.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }
  console.log(`Griddle end-to-end: ${list.length} scenario(s), screenshots in ${path.relative(process.cwd(), OUT) || OUT}\n`);
  const results = [];
  for (const sc of list) {
    console.log(`▶ ${sc.name} — ${sc.description}`);
    const r = await runScenario(sc.name, sc.run);
    results.push(r);
    if (r.error) console.log(`✖ ${sc.name} failed after ${r.seconds.toFixed(1)} s: ${r.error.message}`);
    else console.log(`✔ ${sc.name} passed in ${r.seconds.toFixed(1)} s (${r.shots.length} screenshots, 0 page errors)`);
    if (r.consoleErrors.length) console.log(`  console errors: ${r.consoleErrors.length}\n    ${r.consoleErrors.slice(0, 5).join('\n    ')}`);
    console.log('');
  }
  const failed = results.filter((r) => r.error);
  console.log('---');
  for (const r of results) console.log(`${r.error ? 'fail' : 'pass'}  ${r.name.padEnd(18)} ${r.seconds.toFixed(1)} s  ${r.pageErrors.length} page errors  ${r.shots.length} shots`);
  console.log(`${results.length - failed.length}/${results.length} scenarios passed`);
  if (failed.length) {
    for (const r of failed) console.log(`\n${r.name}:\n${r.error.stack || r.error.message}`);
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
