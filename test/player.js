// Strategy search: cook many burgers through the physics with realistic technique and report the
// best score per order and where points are lost.  `node test/player.js [quick]`
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
const quick = process.argv[2] === 'quick';
const targets = process.argv[3] ? [process.argv[3]] : P.DONENESS.map((d) => d.id);
for (const t of targets) {
  const { best, results } = search(t, quick);
  const r = best.r, o = best.o;
  console.log(`\n=== ${t}: best ${r.total}/100  parts ${JSON.stringify(r.parts)}`);
  console.log(`  recipe: ${o.massG} g, ${o.thick} mm, ${o.temp} °C start, pan ${o.Tpan} °C, flip ${o.flip === 'single' ? 'once at ' + o.firstSide + ' s' : 'every ' + o.flip + ' s'}, pull at ${(P.DONENESS.find((d) => d.id === t).lo + o.pullOffset)} °C centre, rest ${o.rest || 150} s`);
  console.log(`  outcome: peak ${r.peak.toFixed(1)} °C, cook ${P.fmtTime(r.cookTime)}, flips ${r.flips}, water retained ${(r.waterRetained * 100).toFixed(0)} %, grey ${(r.overFrac * 100).toFixed(0)} %, crust A ${best.p.faceDown.brown.toFixed(1)}/${best.p.faceDown.char.toFixed(2)} B ${best.p.faceUp.brown.toFixed(1)}/${best.p.faceUp.char.toFixed(2)} crisp ${best.p.faceDown.crisp.toFixed(2)}/${best.p.faceUp.crisp.toFixed(2)}`);
  // where do points go, across the top 10
  const top = results.sort((a, b) => b.r.total - a.r.total).slice(0, 10);
  const avg = (k) => (top.reduce((x, y) => x + y.r.parts[k], 0) / top.length).toFixed(1);
  console.log(`  top-10 average parts: doneness ${avg('doneness')}/50 crust ${avg('crust')}/20 juiciness ${avg('juiciness')}/15 evenness ${avg('evenness')}/10 structure ${avg('structure')}/5`);
  const bestRet = Math.max(...results.map((x) => x.r.waterRetained)), minGrey = Math.min(...results.filter((x) => x.r.parts.doneness >= 45).map((x) => x.r.overFrac));
  const n100 = results.filter((x) => x.r.total === 100).length, n95 = results.filter((x) => x.r.total >= 95).length, n90 = results.filter((x) => x.r.total >= 90).length;
  console.log(`  of ${results.length} probe-driven cooks: ${n100} scored 100, ${n95} scored 95+, ${n90} scored 90+, median ${results.map((x) => x.r.total).sort((a, b) => a - b)[Math.floor(results.length / 2)]}`);
  console.log(`  best water retention seen ${(bestRet * 100).toFixed(0)} %, smallest grey band among on-target cooks ${(minGrey * 100).toFixed(0)} %`);
}
