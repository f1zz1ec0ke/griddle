/*
 * test/e2e/helper.js — the shared machinery behind the end-to-end scenarios.
 *
 * A scenario gets a real browser with a real WebGL context, a real HTTP server on a free port,
 * and a handle that drives the game the way a cook does: by clicking the buttons in the panel and
 * dragging the sliders. Nothing reaches into the model to change it; the only test-only hooks are
 * the ones the game already exposes for headless runs — `game.fastForward(seconds)` to advance the
 * physics without waiting for wall-clock time, and `game.newOrder(ticket)` to force a ticket
 * instead of taking a random one. Real mode also positions the chef for interaction fixtures;
 * cooking actions and movement checks use pointer and keyboard input.
 *
 * Playwright is not a dependency of this project (there is no build step and no node_modules); it
 * is expected to be installed globally. Run the suite as
 *     NODE_PATH=/opt/node22/lib/node_modules npm run e2e
 * or set PLAYWRIGHT_PATH to the directory holding the playwright package.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = process.env.E2E_OUT || path.join(__dirname, 'out');

// Chromium in a container has no GPU: SwiftShader is the software rasteriser that gives us a real
// WebGL context, which the whole viewport depends on.
const CHROME_ARGS = ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];
const VIEWPORT = { width: 1400, height: 860 };

function loadPlaywright() {
  const tried = [];
  const candidates = ['playwright'];
  if (process.env.PLAYWRIGHT_PATH) candidates.push(path.join(process.env.PLAYWRIGHT_PATH, 'playwright'));
  candidates.push('/opt/node22/lib/node_modules/playwright'); // where this box keeps it
  for (const c of candidates) {
    try { return require(c); } catch (e) { tried.push(`${c}: ${e.code || e.message}`); }
  }
  throw new Error('Playwright not found. Install it globally and run with NODE_PATH set, e.g.\n'
    + '    NODE_PATH=/opt/node22/lib/node_modules npm run e2e\n  tried:\n    ' + tried.join('\n    '));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
/** Serve the repository over HTTP on a free port (file:// would block the texture canvases). */
function serve() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(buf);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/index.html` }));
  });
}

/** Everything a scenario is allowed to do to the page. */
class Kitchen {
  constructor(page, name) {
    this.page = page; this.name = name;
    this.pageErrors = []; this.consoleErrors = []; this.shots = []; this.steps = [];
  }
  // ---- driving the real controls
  async click(sel) { await this.page.click(sel); await this.page.waitForTimeout(20); }
  /**
   * Click something the game re-renders as the clock ticks. Playwright's own click resolves the
   * element and then presses it in a second round trip, which loses the race against a chip list
   * that is rebuilt every second — and `$eval` has the same gap. This finds the element and clicks
   * it inside one page call, so it cannot be detached in between. It is still the page's own
   * handler doing the work.
   */
  async clickLive(sel) {
    const hit = await this.page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
    if (!hit) throw new Error(`${this.name}: nothing matches ${sel}`);
    await this.page.waitForTimeout(10);
  }
  /** Select patty i by its chip, and make sure it took (the chip may have been mid-rebuild). */
  async chip(i) {
    for (let tries = 0; tries < 6; tries++) {
      const sel = await this.page.evaluate((n) => {
        const el = document.querySelector(`[data-chip="${n}"]`);
        if (el) el.click();
        return window.game.sel;
      }, i);
      if (sel === i) return;
      await this.page.waitForTimeout(50);
    }
    throw new Error(`${this.name}: could not select patty ${i + 1} — its chip would not take the click`);
  }
  /** Move a slider the way a pointer does: set the value and fire the input event the page listens for. */
  async range(sel, value) {
    await this.page.$eval(sel, (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    await this.page.waitForTimeout(10);
  }
  async choose(sel, value) {
    await this.page.$eval(sel, (el, v) => { el.value = String(v); el.dispatchEvent(new Event('change', { bubbles: true })); }, value);
    await this.page.waitForTimeout(10);
  }
  async check(sel, on) {
    await this.page.$eval(sel, (el, v) => { el.checked = !!v; el.dispatchEvent(new Event('change', { bubbles: true })); }, on);
  }
  async text(sel) { return this.page.$eval(sel, (el) => el.textContent.trim()); }
  /**
   * Wait for `n` drawn frames. Under software WebGL a frame of the result phase can take half a
   * second, so anything that is only true after the viewport has drawn again — a bun placed on a
   * stack, an atlas repainted, a bead moved — has to be waited for in frames and not in milliseconds.
   */
  async frames(n = 1) { for (let i = 0; i < n; i++) await this.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))); }
  /** Read something out of the live model. `fn` runs in the page with (game, P). */
  async read(fn) { return this.page.evaluate(`(${fn.toString()})(window.game, window.BurgerPhysics)`); }
  /** Advance the simulation without waiting for wall-clock seconds. */
  async fast(seconds) { await this.page.evaluate((s) => window.game.fastForward(s), seconds); }
  /** Force a ticket instead of the random one. */
  async order(items, who = 'E2E', line = 'Test ticket.') {
    await this.page.evaluate((t) => window.game.newOrder(t), { who, line, items });
  }
  async phase() { return this.page.evaluate(() => window.game.phase); }
  async shot(label) {
    const file = path.join(OUT, `${this.name}-${String(this.shots.length + 1).padStart(2, '0')}-${label}.png`);
    await this.page.screenshot({ path: file });
    this.shots.push(file);
    return file;
  }
  /** Step the model in chunks until `cond(state)` is true, or give up. */
  async until(label, read, cond, { chunk = 2, max = 1800 } = {}) {
    let t = 0;
    for (;;) {
      const v = await this.read(read);
      if (cond(v)) return v;
      if (t >= max) throw new Error(`${this.name}: timed out after ${max} simulated seconds waiting for ${label} (last value ${JSON.stringify(v)})`);
      await this.fast(chunk); t += chunk;
    }
  }
  log(msg) { this.steps.push(msg); console.log(`   · ${msg}`); }
  ok(cond, msg) { if (!cond) throw new Error(`${this.name}: ${msg}`); this.log(`ok — ${msg}`); }
  near(actual, expected, tol, msg) { this.ok(Math.abs(actual - expected) <= tol, `${msg} (${actual} vs ${expected} ±${tol})`); }
}

/** Boot a browser + server, hand the scenario a Kitchen, and tear everything down again. */
async function runScenario(name, fn, experience = 'legacy') {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(OUT, { recursive: true });
  const { server, url } = await serve();
  const browser = await chromium.launch({ args: CHROME_ARGS, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}) });
  const page = await browser.newPage({ viewport: VIEWPORT });
  const k = new Kitchen(page, name);
  page.on('pageerror', (e) => k.pageErrors.push(String(e && e.stack ? e.stack : e)));
  page.on('console', (m) => { if (m.type() === 'error') k.consoleErrors.push(m.text()); });
  const started = Date.now();
  let error = null;
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.game && window.game.state, null, { timeout: 30000 });
    await page.locator('#choose-'+experience).click();
    await fn(k);
  } catch (e) {
    error = e;
    try { await k.shot('FAILURE'); } catch (_) { /* the page may be gone */ }
  } finally {
    await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }
  if (!error && k.pageErrors.length) error = new Error(`${k.pageErrors.length} page error(s):\n  ${k.pageErrors.join('\n  ')}`);
  return { name, error, seconds: (Date.now() - started) / 1000, pageErrors: k.pageErrors, consoleErrors: k.consoleErrors, shots: k.shots, steps: k.steps };
}

module.exports = { runScenario, OUT };
