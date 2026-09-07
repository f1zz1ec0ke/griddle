// Headless calibration runs. `node test/calibrate.js`
const P = require('../js/physics.js');
const DT = 0.025;
function run(name, cfg) {
  const s = P.createState({ pan: cfg.pan || 'castiron', stove: cfg.stove || 'gas' });
  P.setKnob(s, cfg.knob == null ? 8 : cfg.knob);
  // preheat until target
  let guard = 0;
  while (s.pan.T < (cfg.preheat || 220) && guard++ < 60000) P.step(s, DT);
  const tPre = s.t;
  if (cfg.oil) P.addFat(s, cfg.oil, cfg.oilG || 8);
  if (cfg.knobCook != null) P.setKnob(s, cfg.knobCook);
  const hold = cfg.hold; // hold pan temperature with a crude controller
  const p = P.makePatty({ massG: cfg.massG || 150, thicknessMm: cfg.thick || 20, fatFrac: cfg.fat == null ? 0.2 : cfg.fat, tempC: cfg.temp == null ? 4 : cfg.temp, dimple: cfg.dimple !== false, work: 0.4, salt: 'surface' });
  P.placePatty(s, p);
  const sides = cfg.sides || [240, 240];
  const marks = [];
  for (let k = 0; k < sides.length; k++) {
    const until = s.t + sides[k];
    if (cfg.smash && k === 0) P.pressPatty(s, true);
    while (s.t < until) {
      if (hold) P.setKnob(s, P.clamp(s.stove.knob + (hold - s.pan.T) * 0.02, 0, 10));
      P.step(s, DT);
      if (Math.round(s.t / DT) % Math.round(30 / DT) === 0) marks.push(`${P.fmtTime(p.cookTime)} pan=${s.pan.T.toFixed(0)} Ts=${p.surfT.toFixed(0)} T0=${p.T[0].toFixed(0)} c=${P.centerT(p).toFixed(1)} top=${P.cellT(p, p.Nz - 1, 0).toFixed(0)} edge=${P.cellT(p, Math.floor(p.Nz / 2), p.Nr - 1).toFixed(0)} brown=${p.faceDown.brown.toFixed(2)} char=${p.faceDown.char.toFixed(2)} w0=${(p.w[0]/p.w0).toFixed(2)} poolTop=${(p.poolTop*1e3).toFixed(2)}g oil=${(s.pan.oil*1e3).toFixed(1)}g siz=${s.diag.sizzle.toFixed(2)} sp=${s.diag.spatter.toFixed(1)} smoke=${s.diag.smoke.toFixed(2)} dome=${p.dome.toFixed(2)} hc=${(s.diag.hc||0).toFixed(0)}`);
    }
    if (k < sides.length - 1) { marks.push('   flip: profile ' + p.T.map(v=>v.toFixed(0)).join(' ')); P.flipPatty(s); }
  }
  P.removePatty(s);
  const rest = cfg.rest == null ? 120 : cfg.rest;
  const until = s.t + rest; while (s.t < until) P.step(s, DT);
  const r = P.evaluate(s, cfg.target || 'medium');
  console.log(`\n=== ${name}  (preheat ${P.fmtTime(tPre)} to ${(cfg.preheat||220)} °C)`);
  for (const m of marks) console.log('  ' + m);
  console.log(`  faces: down brown=${p.faceDown.brown.toFixed(2)} char=${p.faceDown.char.toFixed(2)} torn=${p.faceDown.torn}; up brown=${p.faceUp.brown.toFixed(2)} char=${p.faceUp.char.toFixed(2)} torn=${p.faceUp.torn}`);
  console.log(`  peak centre ${r.peak.toFixed(1)} → ${r.got.label}; mass ${(r.massStart*1e3).toFixed(0)}→${(r.massEnd*1e3).toFixed(0)} g (evap ${(r.waterEvap*1e3).toFixed(1)}, drip ${(r.waterDrip*1e3).toFixed(1)}, fat ${(r.fatLost*1e3).toFixed(1)}), waterRet ${(r.waterRetained*100).toFixed(0)}%, D ${(p.D0*100).toFixed(1)}→${(p.D*100).toFixed(1)} cm, h ${(p.h0*1e3).toFixed(1)}→${(p.h*1e3).toFixed(1)} mm, grey ${(r.overFrac*100).toFixed(0)}%`);
  console.log(`  score ${r.total} ${JSON.stringify(r.parts)}`);
  console.log('  centre column: ' + Array.from({length:p.Nz},(_,k)=>P.cellT(p,k,0).toFixed(0)).join(' '));
  console.log('  bottom brown by ring: ' + Array.from(p.faceDown.brownR).map(v=>v.toFixed(1)).join(' ') + ' | pan centre/edge ' + s.pan.Tcenter.toFixed(0) + '/' + s.pan.Tedge.toFixed(0));
  return { s, p, r };
}

/**
 * The same idea over charcoal. There is no pan to preheat and no oil to pour: the knob is the
 * vents, the bed has to catch and the bars have to come up before the meat goes on, and everything
 * that leaves the patty lands on the fire. Prints the fire and the grate alongside the meat.
 */
function runGrill(name, cfg) {
  const s = P.createState({ stove: 'charcoal' });
  P.setKnob(s, cfg.knob == null ? 8 : cfg.knob);
  let guard = 0;
  const fire = cfg.fire || 600, grate = cfg.grate || 250;
  while ((s.grill.Tfire < fire || s.pan.T < grate) && guard++ < 120000) P.step(s, DT);
  const tPre = s.t;
  if (cfg.knobCook != null) P.setKnob(s, cfg.knobCook);
  if (cfg.settle) { const u = s.t + cfg.settle; while (s.t < u) P.step(s, DT); }
  const p = P.makePatty({ massG: cfg.massG || 150, thicknessMm: cfg.thick || 18, fatFrac: cfg.fat == null ? 0.2 : cfg.fat, tempC: cfg.temp == null ? 4 : cfg.temp, dimple: cfg.dimple !== false, work: 0.35, salt: 'surface' });
  P.placePatty(s, p);
  if (cfg.lid) P.toggleLid(s);
  const sides = cfg.sides || [60, 60, 60, 60, 60, 60];
  const marks = [];
  cook: for (let k = 0; k < sides.length; k++) {
    const until = s.t + sides[k];
    if (cfg.cheeseAt != null && k === cfg.cheeseAt) P.addCheese(s);
    while (s.t < until) {
      if (cfg.pull && P.centerT(p) >= cfg.pull) break cook; // cook to a probe temperature, not a clock
      P.step(s, DT);
      if (cfg.pressEvery && Math.round(s.t / DT) % Math.round(cfg.pressEvery / DT) === 0) P.pressPatty(s, false);
      if (Math.round(s.t / DT) % Math.round(30 / DT) === 0) marks.push(`${P.fmtTime(p.cookTime)} fire=${s.grill.Tfire.toFixed(0)} grate=${s.pan.T.toFixed(0)} Ts=${p.surfT.toFixed(0)} T0=${p.T[0].toFixed(0)} c=${P.centerT(p).toFixed(1)} top=${P.cellT(p, p.Nz - 1, 0).toFixed(0)} edge=${P.cellT(p, Math.floor(p.Nz / 2), p.Nr - 1).toFixed(0)} brown=${p.faceDown.brown.toFixed(2)} marks=${(p.faceDown.marks || 0).toFixed(2)} char=${p.faceDown.char.toFixed(2)} side=${p.faceSide.brown.toFixed(2)} flare=${s.grill.flare.toFixed(2)} fatCoals=${(s.grill.fatOnCoals * 1e3).toFixed(2)}g coal=${(s.grill.coal * 1e3).toFixed(0)}g smoke=${s.diag.smoke.toFixed(2)} dome=${s.grill.Tdome.toFixed(0)}`);
    }
    if (k < sides.length - 1) P.flipPatty(s);
  }
  P.removePatty(s);
  const rest = cfg.rest == null ? 150 : cfg.rest;
  const until = s.t + rest; while (s.t < until) P.step(s, DT);
  const r = P.evaluate(s, cfg.target || 'medium-rare');
  console.log(`\n=== ${name}  (bed lit in ${P.fmtTime(tPre)} to ${fire} °C, grate ${grate} °C)`);
  for (const m of marks) console.log('  ' + m);
  console.log(`  faces: down brown=${p.faceDown.brown.toFixed(2)} marks=${(p.faceDown.marks || 0).toFixed(2)} char=${p.faceDown.char.toFixed(2)}; up brown=${p.faceUp.brown.toFixed(2)} marks=${(p.faceUp.marks || 0).toFixed(2)} char=${p.faceUp.char.toFixed(2)}; edge ${p.faceSide.brown.toFixed(2)}/${p.faceSide.char.toFixed(2)}`);
  console.log(`  fire: ${(s.grill.coal * 1e3).toFixed(0)} g coal left, ${(s.grill.ash * 1e3).toFixed(0)} g ash, ${(s.grill.flareTotal * 1e3).toFixed(2)} g of fat burnt in flare-ups, soot on the meat ${(p.flareChar || 0).toFixed(3)}` + (s.grill.cheeseOnCoals ? `, ${(s.grill.cheeseOnCoals * 1e3).toFixed(1)} g of cheese through the bars` : ''));
  console.log(`  peak centre ${r.peak.toFixed(1)} → ${r.got.label}; mass ${(r.massStart * 1e3).toFixed(0)}→${(r.massEnd * 1e3).toFixed(0)} g (evap ${(r.waterEvap * 1e3).toFixed(1)}, drip ${(r.waterDrip * 1e3).toFixed(1)}, fat ${(r.fatLost * 1e3).toFixed(1)}), waterRet ${(r.waterRetained * 100).toFixed(0)}%, grey ${(r.overFrac * 100).toFixed(0)}%`);
  console.log(`  score ${r.total} ${JSON.stringify(r.parts)}`);
  console.log('  centre column: ' + Array.from({ length: p.Nz }, (_, k) => P.cellT(p, k, 0).toFixed(0)).join(' '));
  console.log('  bottom brown by ring: ' + Array.from(p.faceDown.brownR).map((v) => v.toFixed(1)).join(' ') + ' | grate centre/edge ' + s.pan.Tcenter.toFixed(0) + '/' + s.pan.Tedge.toFixed(0));
  return { s, p, r };
}

const which = process.argv[2];
const all = {
  classic: () => run('150 g, 20 mm, 80/20, 4 °C, pan held 230, 3.5 min/side', { sides: [210, 210], hold: 230, target: 'medium-rare' }),
  classic4: () => run('150 g, 20 mm, 80/20, 4 °C, pan held 230, 4.5 min/side', { sides: [270, 270], hold: 230, target: 'medium' }),
  mr: () => run('150 g, 20 mm, 3 min/side', { sides: [180, 180], target: 'medium-rare' }),
  thick: () => run('225 g, 28 mm, 4 min/side', { massG: 225, thick: 28, sides: [240, 240], target: 'medium' }),
  smash: () => run('smash: 100 g, 15→6 mm, pan 260, 75 s + 45 s', { massG: 100, thick: 15, preheat: 260, smash: true, sides: [75, 45], target: 'well-done', rest: 30 }),
  frozen: () => run('frozen -18 °C, 150 g 20 mm, 5 min/side', { temp: -18, sides: [300, 300] }),
  cool: () => run('cool pan 140 °C, 5 min/side', { preheat: 140, knobCook: 3, sides: [300, 300] }),
  hot: () => run('screaming 320 °C pan, 3 min/side', { preheat: 320, knob: 10, sides: [180, 180] }),
  lean: () => run('93/7 lean 4 min/side', { fat: 0.07, sides: [240, 240] }),
  fatty: () => run('70/30 4 min/side', { fat: 0.30, sides: [240, 240] }),
  nodimple: () => run('no dimple, 30 mm 250 g', { dimple: false, massG: 250, thick: 30, sides: [300, 300] }),
  stainless: () => run('stainless, flip at 60 s (stick test)', { pan: 'stainless', sides: [60, 240] }),
  multiflip: () => run('flip every 30 s x 16', { sides: new Array(16).fill(30) }),
  // ---- charcoal kettle
  grill: () => runGrill('kettle: vents 7, 18 mm, flip every 45 s, pull at 47 °C (the README grill recipe)', { knob: 8, knobCook: 7, settle: 240, thick: 18, sides: new Array(14).fill(45), pull: 47, target: 'medium-rare' }),
  grillhot: () => runGrill('kettle: vents wide open, 22 mm, lazy 90 s flips, pull at 47 °C', { knob: 10, settle: 300, thick: 22, sides: new Array(8).fill(90), pull: 47, target: 'medium-rare' }),
  grillbanked: () => runGrill('kettle: vents on 2 (banked bed), 18 mm', { knob: 2, fire: 380, grate: 180, settle: 120, thick: 18, sides: new Array(8).fill(60), target: 'medium-rare' }),
  grilllid: () => runGrill('kettle: lid on the whole cook, 20 mm (the oven)', { knob: 7, settle: 240, thick: 20, lid: true, sides: new Array(6).fill(60), target: 'medium' }),
  grillflare: () => runGrill('kettle: 70/30 pressed every 40 s over a roaring bed (flare-ups)', { knob: 9, fire: 650, settle: 120, fat: 0.30, thick: 16, pressEvery: 40, sides: new Array(6).fill(60), target: 'medium' }),
  grillcheese: () => runGrill('kettle: cheese on after the second flip — it drips through the bars', { knob: 7, settle: 240, thick: 16, cheeseAt: 2, sides: new Array(8).fill(45), target: 'medium-rare' }),
  grillthick: () => runGrill('kettle: 250 g at 30 mm, vents 6, flip every 60 s', { knob: 6, settle: 240, massG: 250, thick: 30, sides: new Array(12).fill(60), target: 'medium' }),
};
(which ? [which] : Object.keys(all)).forEach((k) => all[k]());
