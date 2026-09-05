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
      if (Math.round(s.t / DT) % Math.round(30 / DT) === 0) marks.push(`${P.fmtTime(p.cookTime)} pan=${s.pan.T.toFixed(0)} Ts=${p.surfT.toFixed(0)} T0=${p.T[0].toFixed(0)} c=${P.centerT(p).toFixed(1)} top=${p.T[p.N-1].toFixed(0)} brown=${p.faceDown.brown.toFixed(2)} char=${p.faceDown.char.toFixed(2)} w0=${(p.w[0]/p.w0).toFixed(2)} poolTop=${(p.poolTop*1e3).toFixed(2)}g oil=${(s.pan.oil*1e3).toFixed(1)}g siz=${s.diag.sizzle.toFixed(2)} sp=${s.diag.spatter.toFixed(1)} smoke=${s.diag.smoke.toFixed(2)} dome=${p.dome.toFixed(2)} hc=${(s.diag.hc||0).toFixed(0)}`);
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
  console.log('  profile: ' + p.T.map(v=>v.toFixed(0)).join(' '));
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
};
(which ? [which] : Object.keys(all)).forEach((k) => all[k]());
