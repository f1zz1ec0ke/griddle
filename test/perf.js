/*
 * perf.js — how expensive is the model to run?
 *
 *   node test/perf.js                 # the standard four benchmarks
 *   node test/perf.js --dt=0.05       # at a different timestep
 *   node test/perf.js --reps=5        # more repeats (the median is reported)
 *
 * The unit that matters is **ms of CPU per simulated second**, because that is what decides
 * whether the browser keeps up: at 8× speed a 60 Hz frame has to advance 8 × 16.7 ms = 0.133
 * simulated seconds, so the physics costs (ms/sim-s) × 0.133 per frame out of a 16.7 ms budget.
 * Wall time for a fixed cook is reported too, because that is what the regression suite spends
 * nearly all of its time on.
 *
 * The `cold ms` column is the first pass, thrown away by the median: that is the run the JIT is
 * still compiling through, and it costs two to three times the steady state.
 *
 * Everything the benchmark does mirrors what the game does (same pan, same held temperature,
 * same flips), so the numbers move for the same reasons the game does.
 */
const P = require('../js/physics.js');

const args = process.argv.slice(2);
const argN = (name, dflt) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : dflt; };
const DT = argN('dt', 0.025);
const REPS = argN('reps', 4);
const SIMS = argN('sims', 100); // sim-seconds per throughput benchmark

// ---------------------------------------------------------------- helpers (same style as physics.test.js)
function preheat(s, target) { P.setKnob(s, 8); let g = 0; while (s.pan.T < target && g++ < 80000) P.step(s, DT); return s.t; }
function hold(s, T) { P.setKnob(s, P.clamp(s.stove.knob + (T - s.pan.T) * 0.02, 0, 10)); }
function cookHeld(s, seconds, T) { const until = s.t + seconds; while (s.t < until) { hold(s, T); P.step(s, DT); } }
function cookFor(s, seconds) { const until = s.t + seconds; while (s.t < until) P.step(s, DT); }
function std(over) { return P.makePatty({ massG: 150, thicknessMm: 20, fatFrac: 0.2, tempC: 4, dimple: true, work: 0.4, salt: 'surface', ...over }); }
function litGrill(knob, until) { const s = P.createState({ stove: 'charcoal' }); P.setKnob(s, knob); let g = 0; while (s.grill.Tfire < until && g++ < 60000) P.step(s, DT); return s; }
const median = (xs) => { const a = xs.slice().sort((x, y) => x - y); return a[(a.length - 1) >> 1]; };
const ms = () => Number(process.hrtime.bigint() / 1000n) / 1000;

/**
 * Run `setup` (not timed) and then `body` (timed), `REPS` times; report the median.
 * The setup is rebuilt every repeat so no run inherits another's state.
 *
 * The first run is a warm-up and is thrown away: cold, the first pass through the model runs
 * two to three times slower than the steady state while the JIT is still compiling it, and the
 * browser is in the steady state for all but the first second of a cook.
 */
function bench(name, simSeconds, setup, body) {
  const times = []; let cold = 0;
  for (let i = 0; i <= REPS; i++) {
    const ctx = setup();
    const t0 = ms(); body(ctx); const t1 = ms();
    if (i > 0) times.push(t1 - t0); else cold = t1 - t0;
  }
  const t = median(times);
  return { name, simSeconds, ms: t, cold, perSim: simSeconds ? t / simSeconds : null, best: Math.min(...times), all: times };
}

// ---------------------------------------------------------------- the benchmarks
/** (a) one 150 g patty in a pan held at 230 °C — the common case. */
function benchOne() {
  return bench('one patty in a pan', SIMS, () => {
    const s = P.createState({ pan: 'castiron', stove: 'gas' }); preheat(s, 230); P.addFat(s, 'canola', 8);
    const p = std(); P.placePatty(s, p); return { s, p };
  }, ({ s }) => cookHeld(s, SIMS, 230));
}

/** (b) three patties sharing the pan — a full ticket, and the worst case in the browser. */
function benchThree() {
  return bench('three patties in a pan', SIMS, () => {
    const s = P.createState({ pan: 'castiron', stove: 'gas' }); preheat(s, 230); P.addFat(s, 'canola', 8);
    const ps = [std(), std({ thicknessMm: 14 }), std({ thicknessMm: 18 })];
    const spots = P.pattySpots(3, s.pan.floorR, Math.max(...ps.map((p) => p.D / 2)));
    ps.forEach((p, i) => P.placePatty(s, p, spots[i]));
    return { s, ps };
  }, ({ s }) => cookHeld(s, SIMS, 230));
}

/** (c) one patty over lit charcoal — the grill path (coal bed, grate, bars, radiation). */
function benchGrill() {
  return bench('one patty on the charcoal grill', SIMS, () => {
    const s = litGrill(7, 600); cookFor(s, 120);
    const p = std({ thicknessMm: 18 }); P.placePatty(s, p); return { s, p };
  }, ({ s }) => cookFor(s, SIMS));
}

/**
 * (d) a fixed five-minute cook, end to end and including the preheat: place, flip every 45 s,
 * pull, rest. This is the shape of nearly every regression test, so its wall time is a good
 * proxy for the suite's.
 */
function benchCook() {
  return bench('a full 5-minute cook (preheat + 4 min pan + 1 min rest)', 300, () => null, () => {
    const s = P.createState({ pan: 'castiron', stove: 'gas' }); preheat(s, 200); P.addFat(s, 'canola', 8);
    const p = std({ thicknessMm: 18 }); P.placePatty(s, p);
    for (let i = 0; i < 5; i++) { cookHeld(s, 45, 200); if (i < 4) P.flipPatty(s); }
    P.removePatty(s); cookFor(s, 60);
    return { s, p };
  });
}

function run() {
  const rows = [benchOne(), benchThree(), benchGrill(), benchCook()];
  const pad = (v, n) => String(v).padStart(n);
  console.log(`griddle physics benchmark — DT ${DT} s, ${REPS} repeats (median), node ${process.version}`);
  console.log('');
  console.log('  benchmark                                              sim s     ms   ms/sim-s   ×realtime   cold ms');
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(52)} ${pad(r.simSeconds, 6)} ${pad(r.ms.toFixed(0), 6)} ${pad(r.perSim.toFixed(3), 10)} ${pad((1000 / r.perSim).toFixed(0), 11)} ${pad(r.cold.toFixed(0), 9)}`);
  }
  console.log('');
  // One 60 Hz frame at 8× speed has to advance 8 × 16.7 ms = 0.133 sim-seconds.
  const perFrame = rows[1].perSim * 8 * (1 / 60);
  console.log(`  three patties at 8× speed: ${perFrame.toFixed(2)} ms of physics per 16.7 ms frame` +
    ` (${perFrame < 16.7 ? 'fits' : 'DOES NOT FIT'}${perFrame < 4 ? ', with room to spare for the renderer' : ''}).`);
  return rows;
}

if (require.main === module) run();
module.exports = { run, bench, benchOne, benchThree, benchGrill, benchCook, DT };
