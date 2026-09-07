// Strategy search: cook many burgers through the physics with realistic technique and report the
// best score per order and where points are lost.
//
//   node test/player.js [quick] [order]          pan on gas: thickness x pan temperature x flips x pull
//   node test/player.js grill [quick] [order]    charcoal kettle: vents x thickness x flips x pull x lid
//
// `quick` is the coarse grid you can run while you wait; without it the sweep is a few hundred
// cooks per order and takes minutes.
const P = require('../js/physics.js');
const DT = 0.025;
const hold = (s, T) => P.setKnob(s, P.clamp(s.stove.knob + (T - s.pan.T) * 0.02, 0, 10));
function cook(o) {
  const s = P.createState({ pan: o.pan || 'castiron', stove: 'gas' });
  P.setKnob(s, 8); let g = 0; while (s.pan.T < o.Tpan && g++ < 80000) P.step(s, DT);
  P.addFat(s, 'canola', 8);
  const target = P.DONENESS.find((d) => d.id === o.target);
  const p = P.makePatty({ massG: o.massG, thicknessMm: o.thick, fatFrac: 0.2, tempC: o.temp, dimple: true, work: 0.35, salt: 'surface' });
  P.placePatty(s, p);
  if (o.smash) P.pressPatty(s, true);
  const pull = target.lo + o.pullOffset;
  let sinceFlip = 0, guard = 0;
  while (P.centerT(p) < pull && guard++ < 60000) {
    hold(s, o.Tpan); P.step(s, DT); sinceFlip += DT;
    if (o.flip === 'single') { if (p.flips === 0 && sinceFlip >= o.firstSide) { P.flipPatty(s); sinceFlip = 0; } }
    else if (sinceFlip >= o.flip && !p.faceDown.stuck) { P.flipPatty(s); sinceFlip = 0; }
  }
  P.removePatty(s);
  const until = s.t + (o.rest || 150); while (s.t < until) P.step(s, DT);
  const r = P.evaluate(s, o.target);
  return { r, p, s };
}
// ---------------------------------------------------------------- charcoal kettle
/*
 * Every cook in a grill sweep needs a bed of coals that is already glowing, and lighting one takes
 * eight to ten simulated minutes of stepping — several times the cook itself. So each vent setting
 * is lit once, settled, and then cloned for every recipe that uses it. The clone is a deep copy of
 * the state (Float64Arrays and all); the only thing structuredClone cannot carry is the burner
 * profile function on the stove, which is put back by hand.
 */
const litBeds = new Map();
function cloneState(s) {
  const c = structuredClone({ ...s, stove: { ...s.stove, profile: null } });
  c.stove.profile = s.stove.profile;
  return c;
}
function litKettle(vents) {
  const key = String(vents);
  if (!litBeds.has(key)) {
    const s = P.createState({ stove: 'charcoal' });
    P.setKnob(s, 8); // light it wide open, the way a chimney of coals arrives
    let g = 0; while ((s.grill.Tfire < 600 || s.pan.T < 250) && g++ < 120000) P.step(s, DT);
    P.setKnob(s, vents);
    const u = s.t + 240; while (s.t < u) P.step(s, DT); // let the bed settle where the vents put it
    litBeds.set(key, s);
  }
  return cloneState(litBeds.get(key));
}
function cookGrill(o) {
  const s = litKettle(o.vents);
  const target = P.DONENESS.find((d) => d.id === o.target);
  const p = P.makePatty({ massG: o.massG, thicknessMm: o.thick, fatFrac: 0.2, tempC: o.temp, dimple: true, work: 0.35, salt: 'surface' });
  P.placePatty(s, p);
  if (o.lid) P.toggleLid(s);
  const pull = target.lo + o.pullOffset;
  let sinceFlip = 0, guard = 0;
  while (P.centerT(p) < pull && guard++ < 60000) {
    P.step(s, DT); sinceFlip += DT;
    if (o.flip === 'single') { if (p.flips === 0 && sinceFlip >= o.firstSide) { P.flipPatty(s); sinceFlip = 0; } }
    else if (sinceFlip >= o.flip && !p.faceDown.stuck) { P.flipPatty(s); sinceFlip = 0; }
  }
  P.removePatty(s);
  const until = s.t + (o.rest || 150); while (s.t < until) P.step(s, DT);
  return { r: P.evaluate(s, o.target), p, s };
}

function searchGrill(target, quick) {
  const grid = [];
  const ventsL = quick ? [6, 7, 8] : [5, 6, 7, 8, 10]; // 7 is the README's setting and the only one that scores 100: a quick sweep that skips it cannot report the window
  const thicks = quick ? [14, 18] : [14, 18, 22];
  const flips = quick ? [45, 60] : ['single', 45, 60, 90];
  const pulls = quick ? [-8, -6, -4, -2] : [-8, -5, -2];
  const lids = quick ? [false] : [false, true];
  for (const vents of ventsL) for (const thick of thicks) for (const flip of flips) for (const pullOffset of pulls) for (const lid of lids)
    grid.push({ target, vents, thick, flip, pullOffset, lid, temp: 4, massG: 150, firstSide: flip === 'single' ? Math.round(thick * 9) : 0 });
  let best = null; const results = [];
  for (const o of grid) {
    const { r, p, s } = cookGrill(o);
    results.push({ o, r });
    if (!best || r.total > best.r.total) best = { o, r, p, s };
  }
  return { best, results };
}

function search(target, quick) {
  const grid = [];
  const thicks = quick ? [14, 18, 22] : [12, 15, 18, 22, 26];
  const Tpans = quick ? [200, 230] : [180, 200, 220, 240, 260];
  const flips = quick ? ['single', 45] : ['single', 30, 60, 90];
  const temps = quick ? [4] : [4, 18];
  for (const thick of thicks) for (const Tpan of Tpans) for (const flip of flips) for (const temp of temps) for (const pullOffset of [-8, -6, -4, -2, 0, 2])
    grid.push({ target, thick, Tpan, flip, temp, pullOffset, massG: 150, firstSide: flip === 'single' ? Math.round(thick * 9) : 0 });
  let best = null; const results = [];
  for (const o of grid) {
    const { r, p } = cook(o);
    results.push({ o, r });
    if (!best || r.total > best.r.total) best = { o, r, p };
  }
  return { best, results };
}
const args = process.argv.slice(2);
const grill = args.includes('grill');
const quick = args.includes('quick');
const targets = args.filter((a) => a !== 'grill' && a !== 'quick');
for (const t of (targets.length ? targets : P.DONENESS.map((d) => d.id))) {
  const { best, results } = grill ? searchGrill(t, quick) : search(t, quick);
  const r = best.r, o = best.o;
  console.log(`\n=== ${t}${grill ? ' over charcoal' : ''}: best ${r.total}/100  parts ${JSON.stringify(r.parts)}`);
  const how = `flip ${o.flip === 'single' ? 'once at ' + o.firstSide + ' s' : 'every ' + o.flip + ' s'}, pull at ${(P.DONENESS.find((d) => d.id === t).lo + o.pullOffset)} °C centre, rest ${o.rest || 150} s`;
  if (grill) console.log(`  recipe: ${o.massG} g, ${o.thick} mm, ${o.temp} °C start, vents on ${o.vents}${o.lid ? ', lid on' : ', lid off'}, ${how}`);
  else console.log(`  recipe: ${o.massG} g, ${o.thick} mm, ${o.temp} °C start, pan ${o.Tpan} °C, ${how}`);
  console.log(`  outcome: peak ${r.peak.toFixed(1)} °C, cook ${P.fmtTime(r.cookTime)}, flips ${r.flips}, water retained ${(r.waterRetained * 100).toFixed(0)} %, grey ${(r.overFrac * 100).toFixed(0)} %, crust A ${best.p.faceDown.brown.toFixed(1)}/${best.p.faceDown.char.toFixed(2)} B ${best.p.faceUp.brown.toFixed(1)}/${best.p.faceUp.char.toFixed(2)} crisp ${best.p.faceDown.crisp.toFixed(2)}/${best.p.faceUp.crisp.toFixed(2)}`);
  if (grill) console.log(`  fire: bed ${best.s.grill.Tfire.toFixed(0)} °C, grate ${best.s.pan.T.toFixed(0)} °C, ${(best.s.grill.coal * 1000).toFixed(0)} g of charcoal left, bar marks ${(best.p.faceDown.marks || 0).toFixed(1)}/${(best.p.faceUp.marks || 0).toFixed(1)}, edge browning ${best.p.faceSide.brown.toFixed(1)}, ${(best.s.grill.flareTotal * 1000).toFixed(1)} g burnt in flare-ups`);
  // where do points go, across the top 10
  const top = results.sort((a, b) => b.r.total - a.r.total).slice(0, 10);
  const avg = (k) => (top.reduce((x, y) => x + y.r.parts[k], 0) / top.length).toFixed(1);
  console.log(`  top-10 average parts: doneness ${avg('doneness')}/50 crust ${avg('crust')}/20 juiciness ${avg('juiciness')}/15 evenness ${avg('evenness')}/10 structure ${avg('structure')}/5`);
  const bestRet = Math.max(...results.map((x) => x.r.waterRetained)), minGrey = Math.min(...results.filter((x) => x.r.parts.doneness >= 45).map((x) => x.r.overFrac));
  const n100 = results.filter((x) => x.r.total === 100).length, n95 = results.filter((x) => x.r.total >= 95).length, n90 = results.filter((x) => x.r.total >= 90).length;
  console.log(`  of ${results.length} probe-driven cooks: ${n100} scored 100, ${n95} scored 95+, ${n90} scored 90+, median ${results.map((x) => x.r.total).sort((a, b) => a - b)[Math.floor(results.length / 2)]}`);
  if (grill) {
    // which vent setting is actually the window, and what wide open costs you
    const byVents = new Map();
    for (const x of results) { const k = x.o.vents; byVents.set(k, Math.max(byVents.get(k) || 0, x.r.total)); }
    console.log('  best by vents: ' + [...byVents.entries()].sort((a, b) => a[0] - b[0]).map(([v, sc]) => `${v}:${sc}`).join(' '));
  }
  console.log(`  best water retention seen ${(bestRet * 100).toFixed(0)} %, smallest grey band among on-target cooks ${(minGrey * 100).toFixed(0)} %`);
}
