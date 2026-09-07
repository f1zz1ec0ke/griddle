// node --test test/physics.test.js   (or `npm test`, which shards this file across workers)
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const P = require('../js/physics.js');
const DT = 0.025;

const test = nodeTest.test;

function preheat(s, target) { P.setKnob(s, 8); let g = 0; while (s.pan.T < target && g++ < 80000) P.step(s, DT); return s.t; }
function cookFor(s, seconds) { const until = s.t + seconds; while (s.t < until) P.step(s, DT); }
function hold(s, T) { P.setKnob(s, P.clamp(s.stove.knob + (T - s.pan.T) * 0.02, 0, 10)); }
function cookHeld(s, seconds, T) { const until = s.t + seconds; while (s.t < until) { hold(s, T); P.step(s, DT); } }
function std(over) { return P.makePatty({ massG: 150, thicknessMm: 20, fatFrac: 0.2, tempC: 4, dimple: true, work: 0.4, salt: 'surface', ...over }); }
function finite(p) { for (const k of ['T', 'w', 'fs', 'fl', 'fr', 'p', 'dM', 'dA', 'dC', 'dG']) for (const v of p[k]) if (!Number.isFinite(v)) return false; return true; }

test('patty geometry: 150 g at 20 mm is a ~10 cm patty', () => {
  const p = std();
  assert.ok(p.D > 0.09 && p.D < 0.11, `D=${p.D}`);
  assert.ok(p.Nz >= 10 && p.Nz <= 80);
  assert.ok(Math.abs(P.pattyMass(p) - 0.15) < 1e-9);
});

test('cast iron on a gas burner preheats past 200 °C in under 6 minutes', () => {
  const s = P.createState({ pan: 'castiron', stove: 'gas' });
  const t = preheat(s, 200);
  assert.ok(t < 360, `took ${t}s`);
});

test('electric coil lags: pan is slower to respond than gas', () => {
  const g = P.createState({ pan: 'castiron', stove: 'gas' }); P.setKnob(g, 8); cookFor(g, 30);
  const e = P.createState({ pan: 'castiron', stove: 'electric' }); P.setKnob(e, 8); cookFor(e, 30);
  assert.ok(e.pan.T < g.pan.T);
});

test('bottom layer stays pinned at the boiling point while it still holds water', () => {
  const s = P.createState({}); preheat(s, 230);
  const p = std(); P.placePatty(s, p);
  let maxWhileWet = 0;
  for (let i = 0; i < 4000; i++) { hold(s, 230); P.step(s, DT); if (p.w[0] > 0.3 * p.w0) maxWhileWet = Math.max(maxWhileWet, p.T[0]); }
  assert.ok(maxWhileWet < 103, `T0 reached ${maxWhileWet} while wet`);
  assert.ok(finite(p));
});

test('no browning without a dry, hot surface; browning once dry', () => {
  const s = P.createState({}); preheat(s, 230);
  const p = std(); P.placePatty(s, p);
  cookHeld(s, 5, 230);
  assert.ok(p.faceDown.brown < 0.2, 'browned while wet');
  cookHeld(s, 180, 230);
  assert.ok(p.faceDown.brown > 1.5, `brown=${p.faceDown.brown}`);
});

test('classic 20 mm patty, 3.5 min a side on a 230 °C pan, lands rare-to-medium-rare after resting', () => {
  const s = P.createState({}); preheat(s, 230); P.addFat(s, 'canola', 8);
  const p = std(); P.placePatty(s, p);
  cookHeld(s, 210, 230); P.flipPatty(s); cookHeld(s, 210, 230); P.removePatty(s); cookFor(s, 120);
  const r = P.evaluate(s, 'medium-rare');
  assert.ok(r.peak > 44 && r.peak < 60, `peak=${r.peak}`);
  assert.ok(r.massEnd / r.massStart > 0.68 && r.massEnd / r.massStart < 0.9, `mass ratio ${r.massEnd / r.massStart}`);
  assert.ok(r.fatLost > 0.003, 'fat should render out');
  assert.ok(finite(p));
});

test('mass is conserved: start = remaining + steam + drip + fat + stuck', () => {
  const s = P.createState({}); preheat(s, 230);
  const p = std(); P.placePatty(s, p);
  cookHeld(s, 200, 230); P.flipPatty(s); cookHeld(s, 200, 230);
  const total = P.pattyMass(p) + p.lostWaterEvap + p.lostWaterDrip + p.lostFat + p.lostStuck;
  assert.ok(Math.abs(total - p.massKg0) < 2e-4, `drift ${(total - p.massKg0) * 1000} g`);
});

test('fattier blends render more fat', () => {
  const run = (f) => { const s = P.createState({}); preheat(s, 230); const p = std({ fatFrac: f }); P.placePatty(s, p); cookHeld(s, 240, 230); P.flipPatty(s); cookHeld(s, 240, 230); return p.lostFat; };
  assert.ok(run(0.3) > run(0.1) * 1.8);
});

test('flipping often cooks the centre faster than one flip', () => {
  const run = (sides) => { const s = P.createState({}); preheat(s, 230); const p = std(); P.placePatty(s, p); for (let i = 0; i < sides.length; i++) { cookHeld(s, sides[i], 230); if (i < sides.length - 1) P.flipPatty(s); } P.removePatty(s); cookFor(s, 90); return p.peakCenter; };
  assert.ok(run(new Array(12).fill(40)) > run([240, 240]) + 2);
});

test('frozen patty: centre far behind a fridge patty after the same time', () => {
  const run = (T) => { const s = P.createState({}); preheat(s, 230); const p = std({ tempC: T }); P.placePatty(s, p); cookHeld(s, 240, 230); P.flipPatty(s); cookHeld(s, 240, 230); return P.centerT(p); };
  assert.ok(run(-18) < run(4) - 10);
});

test('flipping raw meat early on stainless tears it; nonstick never sticks', () => {
  const st = P.createState({ pan: 'stainless' }); preheat(st, 200); const p1 = std(); P.placePatty(st, p1); cookHeld(st, 15, 200);
  const r1 = P.flipPatty(st); assert.ok(r1.torn > 0 && p1.lostStuck > 0);
  const ns = P.createState({ pan: 'nonstick' }); preheat(ns, 200); const p2 = std(); P.placePatty(ns, p2); cookHeld(ns, 15, 200);
  const r2 = P.flipPatty(ns); assert.equal(r2.torn, 0);
});

test('pressing a cooked patty squeezes juice out onto the pan', () => {
  const s = P.createState({}); preheat(s, 230); const p = std(); P.placePatty(s, p); cookHeld(s, 200, 230); P.flipPatty(s); cookHeld(s, 120, 230);
  const before = p.lostWaterDrip; P.pressPatty(s, false);
  assert.ok(p.lostWaterDrip > before + 0.0005);
});

test('smashing a raw patty makes it thin and wide', () => {
  const s = P.createState({}); preheat(s, 250); const p = std({ massG: 100, thicknessMm: 15 }); P.placePatty(s, p); cookHeld(s, 2, 250);
  const D0 = p.D; P.pressPatty(s, true);
  assert.ok(p.h < 0.01 && p.D > D0 * 1.2);
});

test('oil past its smoke point smokes; a well-done order is scored on a 71+ °C centre', () => {
  const s = P.createState({}); P.addFat(s, 'butter', 10); preheat(s, 230); cookFor(s, 5);
  assert.ok(s.diag.smoke > 0.2, `smoke=${s.diag.smoke}`);
  const p = std({ thicknessMm: 12, massG: 110 }); P.placePatty(s, p);
  while (P.centerT(p) < 68) { cookHeld(s, 30, 220); P.flipPatty(s); }
  P.removePatty(s); cookFor(s, 90);
  const r = P.evaluate(s, 'well-done');
  assert.ok(r.peak >= 71 && r.peak <= 80, `peak=${r.peak}`); assert.ok(r.parts.doneness >= 40, `doneness=${r.parts.doneness}`);
});

test('carry-over: centre keeps rising after removal', () => {
  const s = P.createState({}); preheat(s, 230); const p = std(); P.placePatty(s, p); cookHeld(s, 240, 230); P.flipPatty(s); cookHeld(s, 240, 230); P.removePatty(s);
  const atRemoval = P.centerT(p); cookFor(s, 120);
  assert.ok(p.peakCenter > atRemoval + 2, `${atRemoval} → ${p.peakCenter}`);
});

test('repeated smashing stays numerically stable and stops at the pan wall', () => {
  const s = P.createState({}); preheat(s, 250);
  const p = std({ massG: 340, thicknessMm: 40 }); P.placePatty(s, p);
  for (let k = 0; k < 8; k++) { P.pressPatty(s, true); cookFor(s, 1); assert.ok(finite(p), `NaN after smash ${k + 1}`); }
  assert.ok(p.D <= 2 * s.pan.floorR * 0.94 + 1e-9, `D=${p.D}`);
  cookHeld(s, 120, 250); assert.ok(finite(p));
});

test('enough oil to cover the patty deep-fries it: both faces brown, no juice beads on top', () => {
  const s = P.createState({}); P.addFat(s, 'canola', 1400); preheat(s, 190);
  const p = std({ thicknessMm: 15, massG: 120 }); P.placePatty(s, p);
  assert.ok(s.pan.oilDepth > p.h, `depth ${s.pan.oilDepth} vs h ${p.h}`);
  cookHeld(s, 240, 190);
  assert.ok(p.faceUp.brown > 1, `top brown=${p.faceUp.brown}`);
  assert.ok(p.faceDown.brown > 1, `bottom brown=${p.faceDown.brown}`);
  assert.ok(p.poolTop < 1e-4);
  assert.ok(finite(p));
});

test('oil past the rim overflows onto the stove and can flare on a live burner', () => {
  const s = P.createState({}); P.setKnob(s, 8); cookFor(s, 5);
  P.addFat(s, 'canola', 4000); cookFor(s, 1);
  assert.ok(Math.abs(s.pan.oilDepth - s.pan.wall) < 1e-9);
  assert.ok(s.pan.overflow > 0.1, `overflow=${s.pan.overflow}`);
  assert.ok(s.pan.flare > 0, 'expected a grease flare');
  cookFor(s, 10); assert.ok(s.pan.flare < 0.01);
});

test('oil is not eaten by spatter: most of it survives a full cook and a flip', () => {
  const s = P.createState({}); preheat(s, 220); P.addFat(s, 'canola', 8);
  const p = std(); P.placePatty(s, p); cookHeld(s, 180, 220);
  const beforeFlip = s.pan.oil; P.flipPatty(s); cookHeld(s, 5, 220);
  assert.ok(s.pan.oil > beforeFlip * 0.97, `flip cost ${((1 - s.pan.oil / beforeFlip) * 100).toFixed(1)} % of the oil`);
  cookHeld(s, 175, 220);
  assert.ok(s.pan.oil > 0.006, `only ${(s.pan.oil * 1000).toFixed(1)} g left of 8 g plus rendered fat`);
});

test('cheese: slices stack, corners that reach the pan melt, dry, brown and eventually burn', () => {
  const s = P.createState({}); preheat(s, 230);
  const p = std({ massG: 60, thicknessMm: 8 }); P.placePatty(s, p); cookHeld(s, 40, 230); P.flipPatty(s);
  P.addCheese(s); cookHeld(s, 120, 230);
  const sk = p.cheeses[0].skirt;
  assert.ok(sk && sk.mass > 1e-5, 'melted corners should be touching the pan');
  P.addCheese(s); P.addCheese(s);
  assert.equal(p.cheeses.length, 3); assert.ok(p.cheeses[1].rot !== p.cheeses[0].rot);
  cookHeld(s, 60, 230);
  assert.ok(p.cheeses[0].T > p.cheeses[2].T, 'top of the stack lags the bottom');
  cookHeld(s, 180, 230);
  assert.ok(sk.dry > 0.8, `dry=${sk.dry}`); assert.ok(sk.brown > 1.5, `brown=${sk.brown}`);
  cookHeld(s, 300, 230);
  assert.ok(sk.char > 0.2, `char=${sk.char}`);
  assert.ok(finite(p));
});

test('cheese under deep-frying oil melts at once, browns within a minute and eventually burns', () => {
  const s = P.createState({}); P.addFat(s, 'canola', 1400); preheat(s, 190);
  const p = std({ thicknessMm: 12, massG: 100 }); P.placePatty(s, p); cookHeld(s, 30, 190); P.flipPatty(s);
  P.addCheese(s); cookHeld(s, 10, 190);
  const ch = p.cheeses[0];
  assert.ok(ch.submerged, 'slice should be under the oil'); assert.ok(ch.melt > 0.9, `melt=${ch.melt}`);
  cookHeld(s, 60, 190);
  assert.ok(ch.skirt.brown > 1, `brown=${ch.skirt.brown}`);
  cookHeld(s, 420, 190);
  assert.ok(ch.skirt.char > 0.2, `char=${ch.skirt.char}`); assert.ok(finite(p));
});

test('flipping a cheeseburger puts the cheese under the meat: it fries, welds, and comes back up as lace', () => {
  const s = P.createState({}); preheat(s, 230);
  const p = std({ massG: 110, thicknessMm: 14 }); P.placePatty(s, p); cookHeld(s, 120, 230); P.flipPatty(s);
  P.addCheese(s); cookHeld(s, 90, 230);
  P.flipPatty(s);
  assert.equal(p.cheeses.length, 0); assert.equal(p.cheeseUnder.length, 1);
  const T0before = p.T[0];
  cookHeld(s, 120, 230);
  const ch = p.cheeseUnder[0];
  assert.ok(ch.skirt.dry > 0.5 && ch.skirt.brown > 0.5, `dry=${ch.skirt.dry} brown=${ch.skirt.brown}`);
  // the meat face only browns once the cheese between it and the pan has boiled dry and heated up
  assert.ok(p.faceDown.brown < 5, `brown=${p.faceDown.brown}`);
  assert.ok(finite(p));
  cookHeld(s, 240, 230);
  assert.ok(ch.skirt.brown > 1.5, `brown after 6 min under=${ch.skirt.brown}`);
  const fondBefore = s.pan.fond; P.flipPatty(s);
  assert.equal(p.cheeseUnder.length, 0);
  assert.ok(s.pan.fond > fondBefore, 'some fried cheese should weld to the pan');
  assert.ok(p.cheeses.length === 0 || p.cheeses[0].fried);
});

test('the pan pays for the cheese it is frying, not for what gets through to the meat', () => {
  // Cheese-side down, the slice is between the metal and the meat: the meat sees what comes up
  // through it, the metal is out what it put into the bottom of it — warming 20 g of slice and
  // boiling ~4 g of water at 2.26 MJ/kg. Two slices under a patty on 220 °C cast iron pull tens of
  // kilojoules out of the metal; if the rings are only charged what the *meat* took, ~30 kJ (a good
  // 25 °C of a cast-iron pan) comes out of nowhere and a cheeseburger flipped over is free heat.
  const s = P.createState({}); preheat(s, 220); P.addFat(s, 'canola', 8);
  const p = std(); P.placePatty(s, p); cookHeld(s, 60, 220);
  P.addCheese(s, p); P.addCheese(s, p); cookHeld(s, 30, 220);
  P.setKnob(s, 0); // burner off: from here the only thing cooling the metal is what is standing on it
  P.flipPatty(s, p);
  const T0 = s.pan.T;
  let debit = 0, gave = 0, took = 0;
  for (let i = 0; i < 2400; i++) { // a minute cheese-side down, with nothing feeding the metal
    P.step(s, DT);
    const r = p.sc.res;
    for (let j = 0; j < p.Nr; j++) { debit += r.qPanR[j] * DT; took += r.qBotR[j] * DT; }
    gave += r.qBot * DT;
  }
  assert.equal(p.cheeseUnder.length, 2);
  assert.ok(Math.abs(debit - gave) < 1e-6 * Math.abs(gave) + 1, `the rings must be charged the pan-side flux: ${(debit / 1000).toFixed(2)} vs ${(gave / 1000).toFixed(2)} kJ`);
  assert.ok(debit > took * 1.5, `the cheese keeps most of it: pan gave ${(debit / 1000).toFixed(1)} kJ, meat took ${(took / 1000).toFixed(1)} kJ`);
  assert.ok(debit > 9000, `two slices frying should be worth the best part of ten kilojoules a minute: ${(debit / 1000).toFixed(1)} kJ`);
  assert.ok(s.pan.T < T0 - 30, `and the metal has to sag for it: ${T0.toFixed(0)} → ${s.pan.T.toFixed(0)} °C`);
  assert.ok(p.cheeseUnder[0].T > 95 && p.cheeseUnder[1].T > 55, `that is where it went: slices at ${p.cheeseUnder.map((c) => c.T.toFixed(0)).join(' / ')} °C, the bottom one boiling`);
  assert.ok(p.cheeseUnder[0].skirt.dry > 0.02, 'and boiling water out of the slice on the metal');
  assert.ok(finite(p));
});

test('the pan dirties over tickets, dirt costs contact and crust, and washing resets it', () => {
  const s = P.createState({ pan: 'stainless' }); preheat(s, 220);
  const p = std(); P.placePatty(s, p); cookHeld(s, 15, 220); P.flipPatty(s); // tears: meat bits
  P.addCheese(s); cookHeld(s, 60, 220); P.flipPatty(s); cookHeld(s, 240, 220); P.flipPatty(s); // cheese welds
  P.removePatty(s);
  assert.ok(s.pan.meatBits > 0 && s.pan.cheeseBits > 0, `meat=${s.pan.meatBits} cheese=${s.pan.cheeseBits}`);
  P.setKnob(s, 9); cookFor(s, 600); // left on the heat: residue carbonises
  assert.ok(s.pan.carbon > 0.0005, `carbon=${s.pan.carbon}`);
  const dirt = P.panDirt(s.pan); assert.ok(dirt > 0.002, `dirt=${dirt}`);
  const p2 = std(); P.placePatty(s, p2); assert.ok(p2.dirtAtStart > 0.002);
  cookHeld(s, 5, 220); assert.ok(s.diag.hc < 400, `hc=${s.diag.hc}`);
  assert.equal(P.washPan(s), false, 'cannot wash with the patty in the pan');
  P.removePatty(s); s.where = 'cut';
  const hot = s.pan.T, carbonBefore = s.pan.carbon; assert.equal(P.washPan(s), true);
  assert.ok(s.pan.T < hot * 0.5, `T=${s.pan.T} from ${hot}`); assert.ok(s.pan.fond === 0 && s.pan.cheeseBits === 0 && s.pan.water > 0);
  assert.ok(s.pan.carbon < carbonBefore * 0.1, `carbon ${carbonBefore} -> ${s.pan.carbon}`);
});

// ---- scoring: a perfect burger is reachable with good technique, and careless technique is punished
function recipe(target, thick, pull, opts = {}) {
  const s = P.createState({}); P.setKnob(s, 8); while (s.pan.T < (opts.Tpan || 200)) P.step(s, DT);
  P.addFat(s, 'canola', 8);
  const p = std({ thicknessMm: thick, massG: 150, tempC: 4 }); P.placePatty(s, p);
  let since = 0, g = 0;
  while (P.centerT(p) < pull && g++ < 60000) {
    hold(s, opts.Tpan || 200); P.step(s, DT); since += DT;
    if (opts.single) { if (p.flips === 0 && since >= opts.single) { P.flipPatty(s); since = 0; } }
    else if (since >= 45 && !p.faceDown.stuck) { P.flipPatty(s); since = 0; }
    if (opts.press && since > 1 && Math.round(since / DT) % Math.round(20 / DT) === 0) P.pressPatty(s, false); // presses every 20 s, the way people do
  }
  P.removePatty(s); cookFor(s, opts.rest == null ? 150 : opts.rest);
  return P.evaluate(s, target);
}
test('the README recipe scores 100 on every ticket', () => {
  const plan = [['rare', 18, 41], ['medium-rare', 18, 47], ['medium', 14, 56], ['medium-well', 14, 61], ['well-done', 14, 68]];
  for (const [t, thick, pull] of plan) { const r = recipe(t, thick, pull); assert.equal(r.total, 100, `${t}: ${r.total} ${JSON.stringify(r.parts)}`); }
});
test('careless technique is still punished', () => {
  const thickOneFlip = recipe('medium-rare', 26, 46, { single: 240 });      // thick, one flip, cold centre chases the pull temp
  const pressed = recipe('medium', 14, 54, { press: true });                 // squeezing the juice out
  const nuclear = recipe('medium-rare', 18, 46, { Tpan: 300 });              // screaming pan: char
  const noCarry = recipe('medium-rare', 18, 54);                            // pulled at the band's top: carry-over overshoots
  const noRest = recipe('medium-rare', 18, 46, { rest: 0 });                 // cut straight off the heat
  for (const [name, r] of Object.entries({ thickOneFlip, pressed, nuclear, noCarry, noRest })) console.log(`   ${name}: ${r.total} ${JSON.stringify(r.parts)}`);
  assert.ok(thickOneFlip.total < 90, 'thick single flip'); assert.ok(pressed.total < 92, 'pressed'); assert.ok(nuclear.total < 85, 'nuclear'); assert.ok(noCarry.total < 80, 'no carry-over allowance');
  // and the rest is not decoration: cut straight off the heat the centre is 6 °C short of the band
  // it would have carried into, and the doneness mark collapses (56/100 measured, 6 of 50 for it)
  assert.ok(noRest.total < 80, `cut straight off the heat: ${noRest.total}`);
});

// ---------------------------------------------------------------- charcoal grill
function litGrill(knob, until) {
  const s = P.createState({ stove: 'charcoal' }); P.setKnob(s, knob);
  let g = 0; while (s.grill.Tfire < until && g++ < 60000) P.step(s, DT);
  return s;
}
test('charcoal: the bed heats with the vents, the grate follows, and the coals burn down', () => {
  const s = litGrill(8, 600);
  assert.ok(s.t < 300, `bed took ${s.t.toFixed(0)} s to reach 600 °C`);
  cookFor(s, 240);
  assert.ok(s.pan.T > 250 && s.pan.T < 450, `grate=${s.pan.T}`);
  assert.ok(s.grill.Tfire > 600 && s.grill.Tfire < 800, `fire=${s.grill.Tfire}`);
  assert.ok(s.grill.coal < 1.5 && s.grill.coal > 1.2, `coal=${s.grill.coal}`);
  const banked = litGrill(1, 300); cookFor(banked, 600);
  assert.ok(banked.grill.Tfire < s.grill.Tfire - 200, `banked fire=${banked.grill.Tfire}`);
  P.addFat(s, 'canola', 8); assert.equal(s.pan.oil, 0); // no pan to pour into
});
test('grilled: bar marks, browned edges, pan-like timing, and a grill note', () => {
  const s = litGrill(7, 600); cookFor(s, 240);
  const p = std({ thicknessMm: 18, massG: 150 }); P.placePatty(s, p);
  let since = 0; while (P.centerT(p) < 47) { P.step(s, DT); since += DT; if (since >= 60 && !p.faceDown.stuck) { P.flipPatty(s); since = 0; } }
  assert.ok(p.faceDown.marks > 1 && p.faceUp.marks > 1, `marks=${p.faceDown.marks}/${p.faceUp.marks}`);
  assert.ok(p.faceDown.marks > p.faceDown.brown, 'the bars brand darker than the open face');
  assert.ok(p.faceSide.brown > 0.5, `edge brown=${p.faceSide.brown}`);
  assert.ok(p.faceDown.char < 0.3 && p.faceUp.char < 0.3, `char=${p.faceDown.char}/${p.faceUp.char}`);
  assert.ok(p.grilled);
  P.removePatty(s); cookFor(s, 150);
  const r = P.evaluate(s, 'medium-rare');
  assert.ok(r.notes.some((n) => /Grill marks/.test(n)) && r.notes.some((n) => /charcoal|Flare/.test(n)), r.notes.join(' | '));
  assert.ok(r.total >= 70, `grilled MR scored ${r.total} ${JSON.stringify(r.parts)}`);
  // the same patty in a 200 °C pan takes longer to the same centre
  const s2 = P.createState({}); preheat(s2, 200); P.addFat(s2, 'canola', 8);
  const p2 = std({ thicknessMm: 18, massG: 150 }); P.placePatty(s2, p2);
  since = 0; while (P.centerT(p2) < 47) { hold(s2, 200); P.step(s2, DT); since += DT; if (since >= 60 && !p2.faceDown.stuck) { P.flipPatty(s2); since = 0; } }
  assert.ok(Math.abs(p.cookTime - p2.cookTime) < 60, `grill ${p.cookTime} vs pan ${p2.cookTime}`); // comparable: radiant heat vs metal contact
  assert.ok(!p2.grilled && !(p2.faceDown.marks > 0));
});
test('flare-ups: a rush of fat on a hot bed lights, soots the underside, and dies back', () => {
  const s = litGrill(9, 650); cookFor(s, 120);
  const p = std({ thicknessMm: 16, massG: 160, fatFrac: 0.3 }); P.placePatty(s, p);
  cookFor(s, 90); P.flipPatty(s); cookFor(s, 60);
  const before = s.grill.flare;
  P.pressPatty(s, false); cookFor(s, 3); // squeezes fat straight onto the coals
  P.pressPatty(s, false); cookFor(s, 2);
  const peak = s.grill.flare;
  assert.ok(peak > before + 0.3, `flare before=${before} after pressing=${peak}`);
  assert.ok((p.flareChar || 0) > 0, 'soot on the meat');
  cookFor(s, 30);
  assert.ok(s.grill.flare < peak * 0.4, `flare died back to ${s.grill.flare} from ${peak}`);
  assert.ok(s.events.some((e) => /FLARE-UP/.test(e.text)));
  // a lean patty over a banked fire does not
  const s2 = litGrill(2, 300); cookFor(s2, 60);
  const p2 = std({ thicknessMm: 16, massG: 160, fatFrac: 0.07 }); P.placePatty(s2, p2);
  cookFor(s2, 150); P.pressPatty(s2, false); cookFor(s2, 3);
  assert.ok(s2.grill.flare < 0.2, `lean, banked: flare=${s2.grill.flare}`);
});
test('kettle lid: an oven — the top face cooks and browns, the coals calm down', () => {
  const open = litGrill(8, 650), lid = litGrill(8, 650);
  P.toggleLid(lid); cookFor(open, 120); cookFor(lid, 120);
  assert.ok(lid.grill.Tdome > 150, `dome=${lid.grill.Tdome}`);
  assert.ok(lid.grill.Tfire < open.grill.Tfire, `lid ${lid.grill.Tfire} vs open ${open.grill.Tfire}`);
  const po = std({ thicknessMm: 20, massG: 160 }), pl = std({ thicknessMm: 20, massG: 160 });
  P.placePatty(open, po); P.placePatty(lid, pl); cookFor(open, 180); cookFor(lid, 180);
  assert.ok(P.layerMean(pl, pl.T, pl.Nz - 1) > P.layerMean(po, po.T, po.Nz - 1) + 15, `top: lid ${P.layerMean(pl, pl.T, pl.Nz - 1)} vs open ${P.layerMean(po, po.T, po.Nz - 1)}`);
  assert.ok(pl.faceUp.brown > po.faceUp.brown, `top brown: lid ${pl.faceUp.brown} vs open ${po.faceUp.brown}`);
});
test('the grill recipe scores 100: 18 mm, vents on 7, flip every 45 s, pull at 47', () => {
  const s = litGrill(8, 600); P.setKnob(s, 7); cookFor(s, 240);
  const p = std({ thicknessMm: 18, massG: 150, work: 0.35 }); P.placePatty(s, p);
  let since = 0; while (P.centerT(p) < 47) { P.step(s, DT); since += DT; if (since >= 45 && !p.faceDown.stuck) { P.flipPatty(s); since = 0; } }
  P.removePatty(s); cookFor(s, 150);
  const r = P.evaluate(s, 'medium-rare');
  assert.equal(r.total, 100, `grilled MR: ${r.total} ${JSON.stringify(r.parts)} grey ${r.overFrac.toFixed(2)} ret ${r.waterRetained.toFixed(2)}`);
  // the same over a roaring bed chars
  const s2 = litGrill(8, 600); P.setKnob(s2, 10); cookFor(s2, 300);
  const p2 = std({ thicknessMm: 22, massG: 150, work: 0.35 }); P.placePatty(s2, p2);
  since = 0; while (P.centerT(p2) < 47) { P.step(s2, DT); since += DT; if (since >= 90 && !p2.faceDown.stuck) { P.flipPatty(s2); since = 0; } }
  P.removePatty(s2); cookFor(s2, 150);
  const r2 = P.evaluate(s2, 'medium-rare');
  assert.ok(r2.parts.crust < 12 && p2.faceDown.char > 0.25, `roaring: ${r2.total} ${JSON.stringify(r2.parts)} char ${p2.faceDown.char.toFixed(2)}`);
});

// ---------------------------------------------------------------- wood, ash and the vents
/** Run the grill on for `sec` seconds without touching anything. */
function grillFor(s, sec) { const until = s.t + sec; while (s.t < until) P.step(s, DT); }
test('a hickory chunk dries, catches, and smokes for more than eight minutes', () => {
  const s = litGrill(7, 600); grillFor(s, 120);
  const wd = P.addWood(s, 'hickory');
  assert.equal(wd.m, 0.06); assert.ok(wd.water > 0.006, 'a chunk carries its own water');
  const conc0 = s.grill.smokeConc;
  grillFor(s, 60);
  assert.ok(wd.T > 90 && wd.m > 0.0599, `after a minute it is only warming: T=${wd.T} m=${wd.m}`);
  // it has to dry and reach pyrolysis temperature first — a chunk is not a switch
  grillFor(s, 180);
  assert.ok(wd.T > 330 && wd.m < 0.058, `after four minutes it is well alight: T=${wd.T} m=${wd.m}`);
  let smoking = 0, peak = 0, peakT = 0;
  for (let i = 0; i < 20; i++) { grillFor(s, 60); if (wd.smoke > 5e-7) smoking += 60; if (wd.smoke > peak) { peak = wd.smoke; peakT = s.t; } }
  assert.ok(smoking > 8 * 60, `smoked for ${smoking} s`);
  assert.ok(smoking < 22 * 60, `a 60 g chunk is not a log: ${smoking} s`);
  assert.ok(wd.spent && wd.m === 0, 'and then it is gone');
  assert.ok(s.grill.smokeConc < conc0 + 1e-6 || wd.smoke === 0, 'the smoke clears once the chunk is done');
  assert.ok(s.events.some((e) => /chunk of hickory/.test(e.text)) && s.events.some((e) => /spent/.test(e.text)));
  // the rate peaks and then decays: the smouldering front lives on a surface that is shrinking
  assert.ok(peakT - wd.t0 < 420, `peak at ${(peakT - wd.t0).toFixed(0)} s after it went on`);
  assert.ok(peak > 3e-6, `peak smoke rate ${peak} kg/s`);
});
test('a patty over a smouldering chunk takes the smoke, and the wood decides how much', () => {
  const runs = {};
  for (const kind of ['none', 'apple', 'hickory', 'mesquite']) {
    const s = litGrill(8, 600); P.setKnob(s, 7); grillFor(s, 240);
    if (kind !== 'none') { P.addWood(s, kind); grillFor(s, 180); } else grillFor(s, 180);
    const p = std({ thicknessMm: 18, massG: 150, work: 0.35 }); P.placePatty(s, p);
    let since = 0; while (P.centerT(p) < 47) { P.step(s, DT); since += DT; if (since >= 45 && !p.faceDown.stuck) { P.flipPatty(s); since = 0; } }
    P.removePatty(s); cookFor(s, 150);
    runs[kind] = { r: P.evaluate(s, 'medium-rare'), read: P.smokeRead(p) };
  }
  assert.ok(runs.none.read.smokiness < 0.02, `no wood, no smoke: ${runs.none.read.smokiness}`);
  assert.ok(runs.hickory.read.smokiness > 0.5, `hickory: ${runs.hickory.read.smokiness}`);
  assert.ok(runs.apple.read.smokiness < runs.hickory.read.smokiness, 'apple is the mild one');
  assert.ok(runs.mesquite.read.smokiness > runs.hickory.read.smokiness, 'mesquite is the strong one');
  assert.equal(runs.hickory.read.wood, 'hickory');
  assert.ok(runs.hickory.read.creosote < 0.05, 'an open kettle burns the volatiles: no creosote');
  // and the flavour is worth something, without ever taking a perfect crust above twenty
  assert.ok(runs.hickory.r.smokeBonus > 2, `smoke bonus ${runs.hickory.r.smokeBonus}`);
  assert.ok(runs.hickory.r.parts.crust <= 20 && runs.none.r.parts.crust <= 20);
  assert.ok(runs.hickory.r.notes.some((n) => /hickory smoke/.test(n)), runs.hickory.r.notes.join(' | '));
});
test('the grill recipe still scores 100 either way: bare coals, or a chunk of hickory on them', () => {
  for (const wood of [null, 'hickory']) {
    const s = litGrill(8, 600); P.setKnob(s, 7); cookFor(s, 240);
    if (wood) { P.addWood(s, wood); cookFor(s, 180); } else cookFor(s, 180);
    const p = std({ thicknessMm: 18, massG: 150, work: 0.35 }); P.placePatty(s, p);
    let since = 0; while (P.centerT(p) < 47) { P.step(s, DT); since += DT; if (since >= 45 && !p.faceDown.stuck) { P.flipPatty(s); since = 0; } }
    P.removePatty(s); cookFor(s, 150);
    const r = P.evaluate(s, 'medium-rare');
    assert.equal(r.total, 100, `${wood || 'bare coals'}: ${r.total} ${JSON.stringify(r.parts)} smoke ${r.smokiness.toFixed(2)}`);
  }
});
test('a smothered kettle with no wood on it is a dirty fire, not a creosote bath', () => {
  // Shut a kettle down over plain lump and the meat sits in the bed's own starved smoke. Lump
  // charcoal gave up its volatiles in the kiln, so what it makes without air is carbon monoxide and
  // a little soot — a quarter the creosote weight of the same smoke off a smouldering chunk — and
  // it is not the aromatic condensate wood lays down either. It should cost a fraction of a point
  // and say the fire was starved, not blame wood that is not in the kettle.
  const bare = litGrill(8, 600), withWood = litGrill(8, 600);
  const pb = std({ thicknessMm: 18, massG: 150 }), pw = std({ thicknessMm: 18, massG: 150 });
  P.addWood(withWood, 'hickory');
  grillFor(bare, 240); grillFor(withWood, 240); // the chunk needs a few minutes to dry out and reach pyrolysis
  P.placePatty(bare, pb); P.placePatty(withWood, pw);
  for (const s of [bare, withWood]) { P.toggleLid(s); P.setKnob(s, 0); P.setTopVent(s, 0); grillFor(s, 300); }
  const rb = P.smokeRead(pb), rw = P.smokeRead(pw);
  assert.equal(rb.wood, null, 'nothing but the bed deposited on it');
  assert.ok(rb.creosote < 0.35, `bare coals, smothered: creosote ${rb.creosote.toFixed(2)}`);
  assert.ok(rw.creosote > 4 * rb.creosote, `a smouldering chunk is the tar: ${rw.creosote.toFixed(2)} vs ${rb.creosote.toFixed(2)}`);
  const eb = P.evaluate(bare, 'medium-rare', pb);
  assert.ok(eb.smokePenalty < 1, `a starved fire over plain lump should not cost 5 points: ${eb.smokePenalty.toFixed(1)}`);
  assert.ok(!eb.notes.some((n) => /Wood that smoulders/.test(n)), eb.notes.join(' | '));
  const ew = P.evaluate(withWood, 'medium-rare', pw);
  assert.ok(ew.notes.some((n) => /Wood that smoulders/.test(n)), 'with a chunk on it, the note is about the wood');
  assert.ok(ew.smokePenalty > 4, `and it costs: ${ew.smokePenalty}`);
});

test('the white-hot milestone is a temperature the bed can actually reach', () => {
  // target = Tamb + (300 + 430·air)·alive·size tops out at 787 °C, and a real lump bed with both
  // vents wide sits at 740–780: the milestone has to be inside that or it is dead text.
  const s = P.createState({ stove: 'charcoal' }); P.setKnob(s, 10);
  let g = 0; while (!(s._ms && s._ms.coalfull) && g++ < 60000) P.step(s, DT);
  assert.ok(s._ms.coalfull, `never fired; the bed got to ${s.grill.Tfire.toFixed(0)} °C`);
  assert.ok(s.grill.Tfire >= 700 && s.grill.Tfire < 800, `fired at ${s.grill.Tfire.toFixed(0)} °C`);
  assert.ok(s.events.some((e) => /white-hot/.test(e.text)), 'and it says so in the log');
});

test('the lid vent is half the airflow with the lid on and nothing at all with it off', () => {
  const s = litGrill(8, 600);
  P.setTopVent(s, 0);
  assert.equal(P.ventFlow(s), 0.8, 'lid off: the bottom vent is the only vent');
  P.toggleLid(s);
  assert.ok(P.ventFlow(s) < 0.1, `lid on, top shut: ${P.ventFlow(s)}`);
  P.setTopVent(s, 1);
  const both = P.ventFlow(s);
  assert.ok(both > 0.6 && both < 0.8, `both wide: ${both}`); // two orifices in series: 0.71 of one
  P.setKnob(s, 1); // shutting either one shuts the fire down
  assert.ok(P.ventFlow(s) < 0.2, `bottom nearly shut: ${P.ventFlow(s)}`);
});
test('lid on with both vents shut smothers it: the fire falls, the smoke goes white and acrid', () => {
  const open = litGrill(8, 600), shut = litGrill(8, 600);
  for (const s of [open, shut]) { P.setKnob(s, 7); grillFor(s, 240); P.addWood(s, 'hickory'); grillFor(s, 180); }
  const pOpen = std({ thicknessMm: 18, massG: 150 }), pShut = std({ thicknessMm: 18, massG: 150 });
  P.placePatty(open, pOpen); P.placePatty(shut, pShut);
  P.toggleLid(open); P.toggleLid(shut);
  P.setKnob(shut, 0); P.setTopVent(shut, 0);
  const T0 = shut.grill.Tfire;
  grillFor(open, 300); grillFor(shut, 300);
  assert.ok(shut.grill.Tfire < T0 - 80, `smothered fire ${T0.toFixed(0)} → ${shut.grill.Tfire.toFixed(0)}`);
  assert.ok(shut.grill.Tfire < open.grill.Tfire - 100, `smothered ${shut.grill.Tfire} vs vented ${open.grill.Tfire}`);
  assert.ok(shut.grill.comb < 0.05 && open.grill.comb > 0.9, `combustion ${shut.grill.comb} vs ${open.grill.comb}`);
  // thick white smoke: the concentration under a shut dome is orders of magnitude higher
  assert.ok(shut.grill.smokeConc > 10 * open.grill.smokeConc, `conc ${shut.grill.smokeConc} vs ${open.grill.smokeConc}`);
  const rs = P.smokeRead(pShut), ro = P.smokeRead(pOpen);
  assert.ok(rs.creosote > 2 && rs.creosote > 20 * (ro.creosote + 1e-3), `creosote ${rs.creosote} vs ${ro.creosote}`);
  assert.ok(rs.smokiness > ro.smokiness, 'and far more of everything else too');
  // the top face is also cooler under a smothered dome
  assert.ok(shut.grill.Tdome < open.grill.Tdome, `dome ${shut.grill.Tdome} vs ${open.grill.Tdome}`);
  P.removePatty(shut, pShut); cookFor(shut, 150);
  const r = P.evaluate(shut, 'medium-rare', pShut);
  assert.ok(r.smokePenalty > 4, `creosote penalty ${r.smokePenalty}`);
  assert.ok(r.notes.some((n) => /Smothered smoke/.test(n)), r.notes.join(' | '));
});
test('half a kilo of cold coals dips the bed before it lifts it', () => {
  const add = litGrill(6, 500), ctl = litGrill(6, 500);
  grillFor(add, 600); grillFor(ctl, 600);
  const T0 = add.grill.Tfire;
  P.addCoals(add, 0.5);
  assert.equal(add.grill.unlit, 0.5);
  grillFor(add, 120); grillFor(ctl, 120);
  const dip = add.grill.Tfire;
  assert.ok(dip < T0 - 50, `cold coals are a heat sink: ${T0.toFixed(0)} → ${dip.toFixed(0)}`);
  assert.ok(add.grill.unlit > 0.4, 'and they have not caught yet');
  grillFor(add, 240); grillFor(ctl, 240);           // six minutes after they went on
  assert.ok(add.grill.Tfire > dip + 50, `by six minutes it is climbing again: ${add.grill.Tfire.toFixed(0)}`);
  assert.ok(add.grill.unlit < 0.2 && add.grill.coal > 1.4, 'the new coals have caught and joined the bed');
  grillFor(add, 240); grillFor(ctl, 240);           // ten minutes
  assert.ok(add.grill.Tfire > ctl.grill.Tfire + 8, `topped up ${add.grill.Tfire.toFixed(0)} vs left alone ${ctl.grill.Tfire.toFixed(0)}`);
  assert.ok(add.events.some((e) => /have caught/.test(e.text)));
});
test('ash builds over forty minutes, chokes the bed, and raking it out gets the heat back', () => {
  const dirty = litGrill(5, 450), raked = litGrill(5, 450);
  for (let i = 0; i < 8; i++) { grillFor(dirty, 300); grillFor(raked, 300); P.stirCoals(raked); }
  assert.ok(dirty.grill.ash + dirty.grill.ashBowl > 0.02, `ash after 40 min: ${dirty.grill.ash + dirty.grill.ashBowl}`);
  assert.ok(dirty.grill.ash > 3 * raked.grill.ash, `bed ash: choked ${dirty.grill.ash} vs raked ${raked.grill.ash}`);
  assert.ok(raked.grill.ashBowl > dirty.grill.ashBowl, 'what comes off the lumps ends up in the bowl');
  assert.ok(raked.grill.Tfire > dirty.grill.Tfire + 15, `same vents: choked ${dirty.grill.Tfire.toFixed(0)} vs raked ${raked.grill.Tfire.toFixed(0)}`);
  assert.ok(raked.grill.air > dirty.grill.air, 'ash is a restriction on the draught, and that is the mechanism');
  assert.ok(dirty.grill.coal > raked.grill.coal, 'a choked bed burns slower as well as cooler');
  assert.ok(dirty.pan.T < raked.pan.T, `and the bars follow: ${dirty.pan.T.toFixed(0)} vs ${raked.pan.T.toFixed(0)}`);
  // the ash only comes out when the kettle is cold
  assert.equal(P.emptyAsh(dirty), false);
  assert.ok(dirty.events.some((e) => /Ash goes in a bin/.test(e.text)));
  P.setKnob(dirty, 0); let g = 0; while (dirty.grill.Tfire > 60 && g++ < 400000) P.step(dirty, DT);
  assert.equal(P.emptyAsh(dirty), true);
  assert.equal(dirty.grill.ash + dirty.grill.ashBowl, 0);
});
test('the kettle keeps its fire between tickets', () => {
  const s = litGrill(7, 600); grillFor(s, 240);
  P.addWood(s, 'apple'); grillFor(s, 240);
  const p = std({ thicknessMm: 16 }); P.placePatty(s, p); grillFor(s, 120); P.removePatty(s, p); grillFor(s, 60);
  const before = { coal: s.grill.coal, ash: s.grill.ash, bowl: s.grill.ashBowl, Tfire: s.grill.Tfire, grate: s.pan.T, wood: s.grill.woods[0].m, conc: s.grill.smokeConc, dirt: P.panDirt(s.pan) };
  P.nextTicket(s);
  assert.equal(s.patties.length, 0); assert.equal(s.lid, false); assert.equal(s.events.length, 0);
  assert.equal(s.grill.coal, before.coal); assert.equal(s.grill.ash, before.ash); assert.equal(s.grill.ashBowl, before.bowl);
  assert.equal(s.grill.Tfire, before.Tfire); assert.equal(s.pan.T, before.grate);
  assert.equal(s.grill.woods.length, 1); assert.equal(s.grill.woods[0].m, before.wood);
  assert.equal(s.grill.smokeConc, before.conc); assert.equal(P.panDirt(s.pan), before.dirt);
  // and it goes on burning while the next patty is formed: coal down, ash up, chunk smaller
  grillFor(s, 300);
  assert.ok(s.grill.coal < before.coal - 0.01 && s.grill.ash + s.grill.ashBowl > before.ash + before.bowl);
  assert.ok(s.grill.woods[0].m < before.wood, 'the chunk kept smouldering through the changeover');
  const p2 = std({ thicknessMm: 16 }); P.placePatty(s, p2); grillFor(s, 60);
  assert.ok(P.centerT(p2) > 5 && s.pan.T > 250, 'and the next patty lands on a hot grate');
  assert.ok(P.smokeRead(p2).smokiness > 0, 'in a kettle that still smells of apple');
});

// ---------------------------------------------------------------- performance & timestep
// The model is on the browser's frame budget, so the shape of the hot path is part of the
// contract: no allocation per step, no sub-cycling that is not needed, and the same answers at
// the timestep the game actually uses. `node test/perf.js` prints the cost of all of it.
test('stepping allocates nothing: the per-patty scratch buffers are made once and reused', () => {
  const s = P.createState({}); preheat(s, 220);
  const p = std(); P.placePatty(s, p);
  P.step(s, DT);
  const sc = p.sc, arrays = [sc.Cn, sc.Kn, sc.Q, sc.X, sc.flux, sc.fmv, sc.dir, sc.qBotR, sc.TpanR, sc.Aj];
  assert.ok(sc, 'a patty carries its scratch');
  assert.equal(sc.Cn.length, p.Nz * p.Nr);
  cookFor(s, 5);
  assert.equal(p.sc, sc, 'the scratch object was replaced');
  const now = [sc.Cn, sc.Kn, sc.Q, sc.X, sc.flux, sc.fmv, sc.dir, sc.qBotR, sc.TpanR, sc.Aj];
  for (let i = 0; i < arrays.length; i++) assert.equal(now[i], arrays[i], `scratch buffer ${i} was reallocated`);
  // and the boundary-condition objects are reused too, rather than three literals per patty per step
  assert.ok(p.sc.bcPan && !p.sc.bcGrill, 'a pan patty keeps one pan boundary object');
});

test('two patties in the same pan keep their own scratch and their own results', () => {
  const s = P.createState({}); preheat(s, 230); P.addFat(s, 'canola', 8);
  const a = std({ thicknessMm: 20 }), b = std({ thicknessMm: 12, massG: 110 });
  const spots = P.pattySpots(2, s.pan.floorR, Math.max(a.D, b.D) / 2);
  P.placePatty(s, a, spots[0]); P.placePatty(s, b, spots[1]);
  assert.notEqual(a.sc, b.sc);
  assert.notEqual(a.sc.Q, b.sc.Q);
  cookHeld(s, 120, 230);
  assert.ok(finite(a) && finite(b));
  assert.ok(P.centerT(b) > P.centerT(a) + 3, `thin ${P.centerT(b)} vs thick ${P.centerT(a)}`);
  assert.ok(a.sc.qBotR !== b.sc.qBotR && a.faceDown.brown > 0.5 && b.faceDown.brown > 0.5);
});

test('the same cook run twice is bit-for-bit identical', () => {
  const run = () => {
    const s = P.createState({}); preheat(s, 230); P.addFat(s, 'canola', 8);
    const p = std(); P.placePatty(s, p);
    cookHeld(s, 90, 230); P.flipPatty(s); cookHeld(s, 90, 230); P.removePatty(s); cookFor(s, 60);
    return p;
  };
  const a = run(), b = run();
  for (const k of ['T', 'w', 'fs', 'fl', 'fr', 'dM', 'dC', 'dA', 'dG', 'Tpk']) {
    for (let i = 0; i < a[k].length; i++) assert.equal(a[k][i], b[k][i], `${k}[${i}] drifted between runs`);
  }
  assert.equal(a.faceDown.brown, b.faceDown.brown);
  assert.equal(a.peakCenter, b.peakCenter);
});

test('conduction sub-cycles only when the layers are thin enough to need it', () => {
  const s = P.createState({}); preheat(s, 250);
  const p = std(); P.placePatty(s, p);
  P.step(s, 0.05);
  // 20 mm over ~33 layers is a 0.6 mm layer: the explicit bound is ~0.6 s, ten times the step
  assert.equal(p.subSteps, 1, `an ordinary patty sub-cycled ${p.subSteps} times`);
  const smashed = std({ massG: 340, thicknessMm: 40 }); P.placePatty(s, smashed, { x: 0.06, y: 0 });
  for (let k = 0; k < 6; k++) { P.pressPatty(s, true, smashed); P.step(s, 0.05); }
  assert.ok(smashed.subSteps > 1, `a ${(smashed.h * 1000).toFixed(1)} mm smashed patty did not sub-cycle`);
  // ice conducts five times faster than wet meat, so a frozen patty needs a finer sub-step
  const s2 = P.createState({}); preheat(s2, 250);
  const frozen = std({ tempC: -18, thicknessMm: 8 }), chilled = std({ tempC: 4, thicknessMm: 8 });
  P.placePatty(s2, frozen); P.placePatty(s2, chilled, { x: 0.07, y: 0 });
  P.step(s2, 0.2);
  assert.ok(frozen.subSteps > chilled.subSteps, `frozen ${frozen.subSteps} vs chilled ${chilled.subSteps}`);
  assert.ok(finite(frozen) && finite(chilled));
});

test('Tmin follows the coldest cell, so the frozen bound is only used while there is ice', () => {
  const s = P.createState({}); preheat(s, 230);
  const p = std({ tempC: -18, thicknessMm: 12, massG: 120 }); P.placePatty(s, p);
  P.step(s, DT);
  assert.ok(p.Tmin < 0 && Math.abs(p.Tmin - Math.min(...p.T)) < 1e-12, `Tmin=${p.Tmin}`);
  cookHeld(s, 300, 230);
  assert.ok(p.Tmin < 0, `the last of the ice should still be sitting on the fusion plateau: ${p.Tmin}`);
  cookHeld(s, 300, 230);
  assert.ok(p.Tmin > 0, `a 12 mm patty still has ice in it after ten minutes: ${p.Tmin}`);
  assert.ok(Math.abs(p.Tmin - Math.min(...p.T)) < 1e-12);
});

test('waterHolding still reads the salt and the working of the meat', () => {
  const raw = (o) => { const p = std(o); return P.waterHolding(p, 0); };
  assert.ok(Math.abs(raw({ salt: 'surface', work: 0 }) - 1) < 1e-12);
  assert.ok(Math.abs(raw({ salt: 'mixed', work: 0 }) - 1.02) < 1e-12);          // clamped at 1.02
  assert.ok(Math.abs(raw({ salt: 'none', work: 0 }) - 0.98) < 1e-12);
  assert.ok(Math.abs(raw({ salt: 'surface', work: 1 }) - 0.95) < 1e-12);
  const p = std({ salt: 'surface', work: 0 });
  p.dM[0] = 1; p.dC[0] = 1; p.dA[0] = 1;
  assert.ok(Math.abs(P.waterHolding(p, 0) - (1 - 0.06 - 0.06 - 0.28)) < 1e-12, 'denaturation must still collapse it');
});

test('the game timestep of 0.05 s gives the same cook as 0.025 s', () => {
  // game.js steps at 0.05 s; the tests keep 0.025. Both must land the same burger.
  const recipeAt = (dt, target, thick, pull) => {
    const s = P.createState({}); P.setKnob(s, 8); let g = 0;
    while (s.pan.T < 200 && g++ < 80000) P.step(s, dt);
    P.addFat(s, 'canola', 8);
    const p = P.makePatty({ massG: 150, thicknessMm: thick, fatFrac: 0.2, tempC: 4, dimple: true, work: 0.35, salt: 'surface' });
    P.placePatty(s, p); let since = 0;
    while (P.centerT(p) < pull) { P.setKnob(s, P.clamp(s.stove.knob + (200 - s.pan.T) * 0.02, 0, 10)); P.step(s, dt); since += dt; if (since >= 45 && !p.faceDown.stuck) { P.flipPatty(s); since = 0; } }
    P.removePatty(s); const until = s.t + 150; while (s.t < until) P.step(s, dt);
    return { r: P.evaluate(s, target), p };
  };
  for (const [t, thick, pull] of [['medium-rare', 18, 47], ['well-done', 14, 68]]) {
    const fine = recipeAt(0.025, t, thick, pull), game = recipeAt(0.05, t, thick, pull);
    assert.equal(game.r.total, 100, `${t} at the game timestep: ${game.r.total} ${JSON.stringify(game.r.parts)}`);
    assert.equal(fine.r.total, 100, `${t} at 0.025: ${fine.r.total}`);
    assert.ok(Math.abs(game.r.peak - fine.r.peak) < 0.5, `${t} peak ${fine.r.peak} → ${game.r.peak}`);
    assert.ok(Math.abs(game.p.cookTime - fine.p.cookTime) < 5, `${t} cook time ${fine.p.cookTime} → ${game.p.cookTime}`);
    assert.ok(Math.abs(game.p.faceDown.brown - fine.p.faceDown.brown) < 0.3, `${t} crust ${fine.p.faceDown.brown} → ${game.p.faceDown.brown}`);
  }
});

test('smashing stays stable at the game timestep too', () => {
  const s = P.createState({}); P.setKnob(s, 8); while (s.pan.T < 250) P.step(s, 0.05);
  const p = std({ massG: 340, thicknessMm: 40 }); P.placePatty(s, p);
  for (let k = 0; k < 8; k++) { P.pressPatty(s, true); const u = s.t + 1; while (s.t < u) P.step(s, 0.05); assert.ok(finite(p), `NaN after smash ${k + 1}`); }
  const u = s.t + 120; while (s.t < u) { hold(s, 250); P.step(s, 0.05); }
  assert.ok(finite(p) && p.T[0] < 260 && P.centerT(p) < 120, `centre ${P.centerT(p)}`);
});

test('the benchmark harness measures a sane cost per simulated second', () => {
  const perf = require('./perf.js');
  const r = perf.bench('one patty, 2 s', 2, () => {
    const s = P.createState({}); preheat(s, 230); const p = std(); P.placePatty(s, p); return { s, p };
  }, ({ s }) => cookFor(s, 2));
  assert.ok(Number.isFinite(r.perSim) && r.perSim > 0, `perSim=${r.perSim}`);
  assert.ok(r.perSim < 200, `2 sim-seconds should not cost ${r.perSim} ms each`);
  assert.equal(r.all.length, 4);
});

test('three patties in a pan still fit the frame the game gives them', () => {
  // The harness test above is a smoke test — 200 ms per simulated second would be a 15× regression
  // and it would still pass. This is the guard with a number on it. The case is the browser's worst
  // one: three patties in one pan, which is what a three-top ticket is, and the budget is the frame
  // it has to fit in. At 8× speed a 60 Hz frame advances 8/60 = 0.133 simulated seconds, so the
  // physics costs perSim × 0.133 ms of a 16.7 ms frame.
  //
  // Measured on the box this was written on (4-core Xeon at 2.8 GHz, node 22): 13.2–14.7 ms/sim-s,
  // and 13.2–14.7 again with four of these running at once, which is how `npm test` runs it — the
  // model is a tight loop over Float64Arrays, so it does not lose much to a busy machine. The bar
  // is 3× the slowest of those, 44 ms/sim-s: a real regression trips it, a slow CI runner does not.
  const perf = require('./perf.js');
  const r = perf.bench('three patties, 20 s', 20, () => {
    const s = P.createState({ pan: 'castiron', stove: 'gas' }); preheat(s, 230); P.addFat(s, 'canola', 8);
    const ps = [std(), std({ thicknessMm: 14 }), std({ thicknessMm: 18 })];
    const spots = P.pattySpots(3, s.pan.floorR, Math.max(...ps.map((q) => q.D / 2)));
    ps.forEach((q, i) => P.placePatty(s, q, spots[i]));
    return { s, ps };
  }, ({ s }) => cookHeld(s, 20, 230));
  const perFrame = (r.perSim * 8) / 60;
  console.log(`   three patties: ${r.perSim.toFixed(2)} ms per simulated second, ${perFrame.toFixed(2)} ms of an 16.7 ms frame at 8×`);
  assert.ok(r.perSim < 44, `three patties cost ${r.perSim.toFixed(1)} ms per simulated second (13–15 measured, 44 is the line)`);
  // and the thing that number is for: at 8× the model has to leave the renderer most of the frame
  assert.ok(perFrame < 6, `${perFrame.toFixed(2)} ms of physics in a 16.7 ms frame leaves the renderer nothing`);
});

// ---------------------------------------------------------------- pan items (the toppings)
// The items are lumped, so they are held against a *local* pan temperature: `holdAt` steers the
// burner off the metal under the item's own footprint (its `Tat`), not the pan's area mean, which
// on a gas hot spot is 40–60 °C cooler than the middle. `settle` lets cast iron stop overshooting
// before anything goes in, the way a cook waits for the IR gun to sit still.
function holdAt(s, T) { P.setKnob(s, P.clamp(4 + (T - s.pan.Tcenter) * 0.25, 0, 10)); }
function settleAt(s, T) { P.setKnob(s, 8); let g = 0; while (s.pan.Tcenter < T && g++ < 200000) P.step(s, DT); const u = s.t + 240; while (s.t < u) { holdAt(s, T); P.step(s, DT); } return s; }
function cookItem(s, seconds, T) { const until = s.t + seconds; while (s.t < until) { holdAt(s, T); P.step(s, DT); } }
function panAt(T, fatG) { const s = P.createState({}); settleAt(s, T); if (fatG) P.addFat(s, 'canola', fatG); return s; }

test('a bun face toasts golden in about a minute face-down and is black in three', () => {
  const s = panAt(200, 8);
  const [heel, crown] = P.addItem(s, 'bun');
  assert.equal(heel.half, 'bottom'); assert.equal(crown.half, 'top');
  cookItem(s, 15, 200);
  assert.ok(heel.cutFace.brown < 0.6, `browned while the crumb was still wet: ${heel.cutFace.brown}`);
  cookItem(s, 45, 200);
  const st = P.itemState(heel);
  assert.ok(heel.cutFace.brown > 1.2 && heel.cutFace.brown < 4.5, `after a minute face down: brown=${heel.cutFace.brown}`);
  assert.equal(st.state, 'toasted');
  assert.ok(heel.fatSoaked > 0.001 && heel.fatSoaked <= 0.004, `it should have drunk a few grams of the pan's fat: ${heel.fatSoaked * 1000} g`);
  cookItem(s, 120, 200);
  assert.ok(heel.cutFace.char > 0.35, `three minutes face down on a 200 °C pan should be black: char=${heel.cutFace.char}`);
  assert.equal(P.itemState(heel).state, 'burnt');
  // and a moderate pan never gets there
  const s2 = panAt(155, 8); const [h2] = P.addItem(s2, 'bun');
  cookItem(s2, 180, 155);
  assert.ok(h2.cutFace.char < 0.15 && h2.cutFace.brown > 1.5, `moderate pan: brown=${h2.cutFace.brown} char=${h2.cutFace.char}`);
});

test('a toasted bottom bun soaks far less of the juice than an untoasted one', () => {
  const cook = (toast) => {
    const s = panAt(200, 8);
    const p = std({ thicknessMm: 18 }); P.placePatty(s, p, { x: 0.06, y: 0 });
    cookItem(s, 180, 200); P.flipPatty(s, p); cookItem(s, 180, 200);
    if (toast) { const [heel] = P.addItem(s, 'bun'); cookItem(s, 60, 200); P.removeItem(s, heel); P.removeItem(s, s.items[1]); }
    P.removePatty(s, p); cookItem(s, 150, 200);
    P.serve(s);
    return p;
  };
  const bare = cook(false), toasted = cook(true);
  assert.ok(toasted.bunToast > 1.2, `the heel should be toasted: ${toasted.bunToast}`);
  assert.ok(bare.bunSoak > 0, `something has to run out to soak in: ${bare.bunSoak}`);
  assert.ok(toasted.bunSoak < 0.45 * toasted.bunSoakRaw, `toasted heel took ${(toasted.bunSoak / toasted.bunSoakRaw * 100).toFixed(0)} % of the juice`);
  assert.ok(Math.abs(bare.bunSoak - bare.bunSoakRaw) < 1e-12, 'no bun in the pan means no reduction');
});

test('bacon renders most of its fat and crisps in about eight minutes at 180 °C, and chars at 260', () => {
  const s = panAt(180, 6);
  const [b] = P.addItem(s, 'bacon');
  for (let i = 0; i < 8; i++) { cookItem(s, 60, 180); if (i % 2 === 1) P.flipItem(s, b); }
  // A 25 g rasher is 10 g of fat, 10.5 g of water and 4.5 g of lean. Frying it crisp renders 50–65 %
  // of the fat (6 g here, a quarter of the raw strip) and drives off 60–70 % of the water: what
  // comes out is 11–12 g — a little under half of what went in — and it is still ~40 % fat, which is
  // what cooked streaky bacon is. Nothing renders the last of the fat out of the lean.
  assert.ok(b.lostFat / b.m0 > 0.20, `only ${(b.lostFat / b.m0 * 100).toFixed(0)} % of the strip's mass came out as fat`);
  assert.ok(b.lostFat / b.fat0 > 0.5 && b.lostFat / b.fat0 < 0.7, `${(b.lostFat / b.fat0 * 100).toFixed(0)} % of its fat rendered; a rasher gives up 50–65 %`);
  const cooked = P.itemMass(b);
  assert.ok(cooked > 0.40 * b.m0 && cooked < 0.55 * b.m0, `cooked weight ${(cooked * 1000).toFixed(1)} g of ${(b.m0 * 1000).toFixed(0)} g raw`);
  assert.ok(b.body.w > 0.2 * b.w0, `crisp bacon is not bone dry: ${(b.body.w * 1000).toFixed(1)} g of water left`);
  assert.ok(b.fs + b.fl > 0.3 * b.fat0, `and it keeps its intramuscular fat: ${((b.fs + b.fl) * 1000).toFixed(1)} g`);
  assert.ok(s.pan.oil > 0.006 + b.lostFat * 0.8, 'the rendered fat should be in the pan');
  assert.ok(b.crisp > 0.6, `crisp=${b.crisp}`);
  assert.ok(b.shrink > 0.2, `it should have shrunk by about a quarter: ${b.shrink}`);
  assert.ok(Math.abs(b.curl) > 0.3, `it should have curled: ${b.curl}`);
  assert.equal(P.itemState(b).state, 'crisp');
  assert.ok(b.faceDown.char + b.faceUp.char < 0.3, `crisp, not burnt: char=${b.faceDown.char + b.faceUp.char}`);
  // a screaming pan burns it long before it is ready
  const s2 = panAt(260, 6); const [b2] = P.addItem(s2, 'bacon');
  cookItem(s2, 180, 260);
  assert.ok(b2.faceDown.char + b2.faceUp.char > 0.35, `260 °C for three minutes should char it: ${b2.faceDown.char + b2.faceUp.char}`);
  assert.equal(P.itemState(b2).state, 'burnt');
});

test('egg: the white sets before the yolk, and a lid sets the yolk', () => {
  const open = panAt(160, 8), lid = panAt(160, 8);
  const [eo] = P.addItem(open, 'egg'), [el] = P.addItem(lid, 'egg');
  P.toggleLid(lid);
  cookItem(open, 30, 160); cookItem(lid, 30, 160);
  assert.ok(eo.setBot > 0.9, `the white on the metal sets first: ${eo.setBot}`);
  assert.ok(eo.yolkSet < 0.05, `the yolk cannot be set before the white: ${eo.yolkSet}`);
  cookItem(open, 150, 160); cookItem(lid, 150, 160);
  assert.ok(eo.setTop > 0.9, `three minutes sunny side up should set the top of the white: ${eo.setTop}`);
  assert.ok(eo.yolkSet < 0.3, `sunny side up, the yolk stays runny: ${eo.yolkSet}`);
  assert.ok(el.yolkSet > 0.75, `under a lid the steam sets the yolk: ${el.yolkSet}`);
  assert.ok(el.yolk.T > eo.yolk.T + 20, `lid ${el.yolk.T} vs open ${eo.yolk.T}`);
  assert.equal(P.itemState(eo).state, 'runny yolk');
  // and it is still an egg: three minutes of frying takes 10–15 % of its mass off as steam (USDA
  // has a 50 g large egg going out at 46 g), not the third of it a layer of white boiling dry would
  assert.ok(eo.lostWater > 0.003 && eo.lostWater < 0.009, `${(eo.lostWater * 1000).toFixed(1)} g steamed off a 55 g egg`);
  assert.ok(P.itemMass(eo) > 0.85 * eo.m0, `a fried egg keeps its weight: ${(P.itemMass(eo) * 1000).toFixed(1)} g of ${(eo.m0 * 1000).toFixed(0)}`);
  assert.ok(eo.wBot.w > 0.5 * eo.w0b, `the set white holds its water: ${(eo.wBot.w * 1000).toFixed(1)} g of ${(eo.w0b * 1000).toFixed(1)}`);
  // turned over, the yolk is a millimetre off the metal and goes jammy in a minute
  const over = panAt(160, 8); const [ev] = P.addItem(over, 'egg');
  cookItem(over, 60, 160); P.flipItem(over, ev); cookItem(over, 35, 160);
  assert.equal(P.itemState(ev).state, 'jammy yolk');
  cookItem(over, 60, 160);
  assert.equal(P.itemState(ev).state, 'hard yolk');
  // a yolk left on the metal long enough goes to the boil, and that water has to be counted like
  // any other: mass + steam + fat + drip is what went in, to within a milligram
  const yw0 = ev.yolk.w;
  cookItem(over, 240, 200);
  assert.ok(ev.yolk.T > 99, `a yolk left frying reaches the boil: ${ev.yolk.T}`);
  assert.ok(ev.yolk.w < yw0 - 1e-5, `and some of its water has gone: ${(yw0 * 1000).toFixed(2)} → ${(ev.yolk.w * 1000).toFixed(2)} g`);
  const bal = P.itemMass(ev) + ev.lostWater + ev.lostFat + ev.lostDrip - ev.fatSoaked;
  assert.ok(Math.abs(bal - ev.m0) < 1e-6, `${((bal - ev.m0) * 1000).toFixed(3)} g adrift once the yolk has boiled`);
  // the lace at the rim browns in the fat
  assert.ok(eo.lace.brown > 1.2, `lace=${eo.lace.brown}`);
  // and a raw white is a send-back
  const raw = panAt(160, 8); const [er] = P.addItem(raw, 'egg'); cookItem(raw, 20, 160);
  assert.equal(P.itemState(er).state, 'raw white');
  assert.ok(P.itemState(er).score <= -5);
});

test('a fridge-cold patty feels firmer than the same meat that has sat out', () => {
  const cold = std({ tempC: 4 }), warm = std({ tempC: 25 });
  const Ec = P.firmness(cold).E, Ew = P.firmness(warm).E;
  // Raw mince is ~8 kPa of wet paste; the solid fat in it is waxy at fridge temperature and soft at
  // room temperature, so the same meat is ~10 % stiffer cold. Nothing has denatured in either.
  assert.ok(Ec > Ew * 1.05, `4 °C ${Ec.toFixed(0)} Pa vs 25 °C ${Ew.toFixed(0)} Pa`);
  assert.ok(Ew > 7.5e3 && Ec < 11e3, `both are still raw mince: ${Ew.toFixed(0)} / ${Ec.toFixed(0)} Pa`);
  assert.equal(P.firmnessWord(P.firmness(cold).index).word, P.firmnessWord(P.firmness(warm).index).word); // both still read raw to a finger
});

test('onions: sweet and brown in a quarter of an hour on medium, ruined in minutes on a hot pan', () => {
  const s = panAt(170, 10);
  P.addFat(s, 'butter', 6); // butter is 2 % milk solids, so there is fond in the pan for them to lift
  const [o] = P.addItem(s, 'onions');
  const Tin = s.pan.Tcenter;
  cookItem(s, 20, 170);
  assert.ok(s.pan.Tcenter < Tin - 5, `eighty grams of wet onion should drag the metal down: ${Tin} → ${s.pan.Tcenter}`);
  for (let i = 0; i < 15; i++) { cookItem(s, 60, 170); P.flipItem(s, o); } // stirred every minute, as anyone caramelising onions does
  assert.ok(o.lostWater > 0.06, `${(o.lostWater * 1000).toFixed(0)} g of the 71 g of water should have boiled off`);
  assert.ok(o.carm > 1.0, `fifteen minutes on medium should caramelise them: carm=${o.carm}`);
  assert.ok(o.char < 0.05, `and not burn them: char=${o.char}`);
  assert.equal(P.itemState(o).state, 'caramelised');
  assert.ok(P.itemState(o).score > 1);
  assert.ok(o.fond > 0, 'they should have lifted some fond off the metal');
  // on a 260 °C pan the layer against the metal is past sweet inside four minutes and black if left
  const s2 = panAt(260, 10); const [o2] = P.addItem(s2, 'onions');
  cookItem(s2, 240, 260);
  assert.ok(o2.carmBot > 2.4, `four minutes on a 260 °C pan: carmBot=${o2.carmBot}`);
  cookItem(s2, 360, 260);
  assert.equal(P.itemState(o2).state, 'burnt');
  assert.ok(P.itemState(o2).score < -3);
  // stirring is what saves them: the same pan, stirred every half minute, is not black yet
  const s3 = panAt(260, 10); const [o3] = P.addItem(s3, 'onions');
  for (let i = 0; i < 12; i++) { cookItem(s3, 30, 260); P.flipItem(s3, o3); }
  assert.ok(o3.char < o2.char, `stirred ${o3.char} vs left alone ${o2.char}`);
});

test('onions with their water gone but no colour on them are sweated, not raw', () => {
  const s = panAt(150, 10);
  const [o] = P.addItem(s, 'onions');
  for (let i = 0; i < 12; i++) { cookItem(s, 60, 150); P.flipItem(s, o); }
  // Twelve minutes on a 150 °C pan boils most of the 71 g of water out of 80 g of onion but never
  // gets the contact layer dry enough for the sugars to go: soft, translucent, mild — sweated.
  // Reading that as "raw" (and telling the cook only 50 g of their water was out, of 71) was wrong.
  assert.ok(o.lostWater > 0.6 * o.w0, `${(o.lostWater * 1000).toFixed(0)} g of ${(o.w0 * 1000).toFixed(0)} g is out`);
  assert.ok(o.carm < 0.35, `nothing has browned yet: carm=${o.carm}`);
  const st = P.itemState(o);
  assert.equal(st.state, 'sweated');
  assert.ok(st.score > -1 && st.score <= 0.5, `sweated onions are not a penalty: ${st.score}`);
  assert.ok(!/only \d+ g of their water/.test(st.note), st.note);
  // and a heap that has only just gone in is still raw, and still says so
  const s2 = panAt(150, 10); const [o2] = P.addItem(s2, 'onions'); cookItem(s2, 60, 150);
  assert.equal(P.itemState(o2).state, 'raw');
});

test('the caramelised window is wide enough to hit: the contact layer runs out of sugar', () => {
  const s = panAt(170, 10);
  const [o] = P.addItem(s, 'onions');
  let caramelised = 0;
  for (let i = 0; i < 20; i++) { cookItem(s, 60, 170); P.flipItem(s, o); if (P.itemState(o).state === 'caramelised') caramelised++; }
  // An onion carries 5.6 % of its weight as free sugars; the layer on the metal cannot go darker
  // than the sugar it has. Stirred every minute on a 170 °C pan the heap reads caramelised for a
  // good four or five minutes, instead of stepping from golden to bitter between two readings.
  assert.ok(caramelised >= 4, `only ${caramelised} minutes of the cook read caramelised`);
});

test('items take a spot on the pan, count in the coverage, and pull the metal under them down', () => {
  const s = panAt(200, 8);
  const p = std(); P.placePatty(s, p, { x: 0, y: 0 });
  const [heel, crown] = P.addItem(s, 'bun');
  for (const b of [heel, crown]) {
    assert.ok(Math.hypot(b.pos.x, b.pos.y) - b.Dcov / 2 > -p.D / 2, 'a bun must not be laid on top of the patty');
    assert.ok(Math.hypot(b.pos.x, b.pos.y) + b.Dcov / 2 <= s.pan.floorR * 1.02, 'and it has to be inside the pan');
  }
  assert.ok(Math.hypot(heel.pos.x - crown.pos.x, heel.pos.y - crown.pos.y) > 0.05, 'nor on top of each other');
  // the rings under an item are shaded from the room exactly as the rings under a patty are
  P.step(s, DT);
  const j = heel.rings[0].j0;
  const cov = P.ringCoverage(s);
  assert.ok(cov[j] > 0, `ring ${j} is under the bun but reads ${cov[j]} covered`);
  const bare = P.createState({}); bare.patties = []; bare.items = [];
  assert.equal(P.ringCoverage(bare)[j], 0);
  // and a cold, wet thing drawing 100-odd watts out of them drags them down: the same pan and the
  // same burner, with and without a bun on it
  const run = (withBun) => {
    const t = P.createState({}); settleAt(t, 200); P.addFat(t, 'canola', 8);
    P.setKnob(t, 3);
    if (withBun) P.addItem(t, 'bun');
    const j0 = withBun ? t.items[0].rings[0].j0 : heel.rings[0].j0;
    const T0 = t.pan.Tr[j0]; cookFor(t, 30);
    return t.pan.Tr[j0] - T0;
  };
  const withBun = run(true), without = run(false);
  assert.ok(withBun < without - 3, `ring under the bun moved ${withBun.toFixed(1)} K, the bare ring ${without.toFixed(1)} K`);
});

test('a topping with nowhere to go lies on the meat, and only what touches the metal cooks', () => {
  // freeSpot returns the least-bad place on a crowded pan, and addItem lays the heap there anyway —
  // which is what a cook does. What it must not do is let the part lying on 70 °C beef draw the
  // same 200-odd watts out of the rings as the part on the metal.
  const s = panAt(200, 8);
  const a = std(), b = std();
  P.placePatty(s, a, { x: -0.045, y: 0 }); P.placePatty(s, b, { x: 0.045, y: 0 });
  const [heap] = P.addItem(s, 'onions');
  assert.ok(heap.overlap > 0.3, `most of a 16 cm heap has nowhere to go on this pan: overlap=${heap.overlap}`);
  assert.ok(Math.abs(heap.contactF - (1 - heap.overlap)) < 1e-9);
  assert.ok(s.events.some((e) => /No room/.test(e.text) && /off the metal/.test(e.text)), 'and the cook is told');
  cookItem(s, 60, 200);
  const crowded = heap.qBot;
  // the same heap, the same pan, nothing else on it
  const clear = panAt(200, 8);
  const [alone] = P.addItem(clear, 'onions');
  assert.equal(alone.overlap, 0); assert.equal(alone.contactF, 1);
  cookItem(clear, 60, 200);
  assert.ok(crowded < 0.75 * alone.qBot, `half on the meat should not draw a full footprint: ${crowded.toFixed(0)} W vs ${alone.qBot.toFixed(0)} W`);
  assert.ok(heap.bot.T < alone.bot.T, `and it cooks slower: ${heap.bot.T.toFixed(0)} vs ${alone.bot.T.toFixed(0)} °C`);
});

test('a pan of bacon with no patty in it still sizzles', () => {
  // boilNoise and hiss are the two voices the audio plays, and both were scaled by a patty-only
  // contact and a patty-only dryness: with nothing but toppings on the metal that is zero, so two
  // rashers rendering in 12 g of their own fat came out a hundredth of what the same pan sounds
  // like with meat in it — and lifting the last patty off silenced bacon that was still frying.
  const s = panAt(190, 0);
  P.addItem(s, 'bacon'); P.addItem(s, 'bacon');
  cookItem(s, 120, 190);
  const d = s.diag;
  assert.ok(d.contact > 0.5, `two rashers are things against the metal: contact=${d.contact}`);
  assert.ok(s.items[0].lostFat > 0.002 && s.pan.oil > 0.004, `they should be rendering: ${(s.pan.oil * 1000).toFixed(1)} g of fat in the pan`);
  assert.ok(d.hiss > 0.1, `fat frying on 190 °C metal has to be audible: hiss=${d.hiss.toFixed(3)}`);
  assert.ok(d.boilNoise > 0.05, `and water is still coming out of them: boil=${d.boilNoise.toFixed(3)}`);
  assert.ok(s.events.some((e) => /sizzle/.test(e.text)), 'and the kitchen says so at least once');
  // the two voices track what the rashers are doing: dry lean frying is hiss, wet lean is boil
  assert.ok(P.itemDryness(s.items[0]) > 0.3, `the face on the metal has dried down: ${P.itemDryness(s.items[0]).toFixed(2)}`);
  // and lifting a patty out from beside them does not silence them
  const s2 = panAt(190, 0);
  P.addItem(s2, 'bacon');
  const p = std(); P.placePatty(s2, p, { x: 0.05, y: 0 });
  cookItem(s2, 120, 190);
  const withMeat = s2.diag.hiss;
  P.removePatty(s2, p); P.step(s2, DT);
  assert.ok(s2.diag.hiss > 0.3 * withMeat, `rasher still frying: ${s2.diag.hiss.toFixed(3)} vs ${withMeat.toFixed(3)} with the patty beside it`);
});

test('the build: toppings go on a burger, the ticket pays for raw or burnt ones and the patty score does not move', () => {
  const s = panAt(200, 8);
  const p = std({ thicknessMm: 18 }); P.placePatty(s, p, { x: 0.05, y: 0 });
  let since = 0;
  while (P.centerT(p) < 47) { holdAt(s, 200); P.step(s, DT); since += DT; if (since >= 45 && !p.faceDown.stuck) { P.flipPatty(s, p); since = 0; } }
  P.removePatty(s, p);
  const [b] = P.addItem(s, 'bacon');
  cookItem(s, 20, 200);           // nowhere near rendered
  P.removeItem(s, b);
  P.assignTopping(s, b, p);
  cookItem(s, 130, 200);
  const alone = P.evaluate(s, 'medium-rare', p);
  P.serve(s);
  const r = P.evaluate(s, 'medium-rare', p);
  assert.equal(r.total, alone.total, 'a topping must never move the patty score itself');
  assert.equal(r.build.items.length, 1);
  assert.equal(r.build.items[0].kind, 'bacon');
  assert.equal(r.build.items[0].state, 'limp');
  assert.ok(r.build.penalty >= 3 && r.build.bonus === 0);
  const tk = P.evaluateTicket(s);
  assert.ok(tk.buildPenalty >= 3, `ticket build penalty=${tk.buildPenalty}`);
  assert.ok(tk.total < tk.mean, `${tk.total} should be under the patty mean ${tk.mean}`);
  assert.ok(tk.notes.some((n) => /send-back/.test(n)), tk.notes.join(' | '));
  assert.ok(P.toppingsOf(s, p).length === 1);
});

test('a bun stays one bun: both halves go to the same burger, and the plan is visible before serving', () => {
  // addItem lays the two halves at two separate free spots, and the build step used to give each
  // topping to the burger nearest *its own* rest position — so on a three-burger ticket the heel
  // routinely went to one burger and the crown to another. The burger with only a crown then has no
  // heel at all: it takes the untoasted soak factor and goes out with nothing under it, and its
  // neighbour goes out with no top. The pair has to travel together.
  const s = panAt(200, 8);
  const ps = [{ x: -0.07, y: 0 }, { x: 0.07, y: 0 }, { x: 0, y: 0.07 }].map((pos, i) => { const p = std({ id: i + 1, thicknessMm: 16 }); P.placePatty(s, p, pos); return p; });
  const [heel, crown] = P.addItem(s, 'bun');
  cookItem(s, 60, 200);
  for (const p of ps) P.removePatty(s, p);
  P.removeItem(s, heel); P.removeItem(s, crown);
  // put them down on opposite sides of the board, which is exactly what split them before
  heel.restPos = { x: -0.07, y: 0 }; crown.restPos = { x: 0.07, y: 0 };
  assert.equal(heel.pair, crown.pair, 'the two halves of one bun share a pair id');
  const plan = P.plannedBurger(s, heel);
  assert.equal(P.plannedBurger(s, crown).id, plan.id, 'and the plan puts them on the same burger');
  assert.equal(plan.id, 1, 'the pair follows the heel, which is the half the burger is built on');
  P.serve(s);
  assert.equal(heel.burger, crown.burger);
  const built = ps.find((p) => p.id === heel.burger);
  assert.ok(built.bunFaces.bottom && built.bunFaces.top, 'the burger it was built on has both halves');
  for (const p of ps) if (p !== built) assert.ok(!p.bunFaces.bottom && !p.bunFaces.top, `burger ${p.id} should have no bun at all, not half of one`);
  assert.ok(built.bunSoak < built.bunSoakRaw, 'and it gets the toasted heel it was given');
  // a half the cook has assigned by hand takes its other half with it
  const s2 = panAt(200, 8);
  const qs = [{ x: -0.07, y: 0 }, { x: 0.07, y: 0 }].map((pos, i) => { const p = std({ id: i + 1, thicknessMm: 16 }); P.placePatty(s2, p, pos); return p; });
  const [h2, c2] = P.addItem(s2, 'bun');
  cookItem(s2, 30, 200);
  for (const p of qs) P.removePatty(s2, p);
  P.removeItem(s2, h2); P.removeItem(s2, c2);
  P.assignTopping(s2, c2, qs[1]); // the crown, by hand, onto burger 2
  assert.equal(P.plannedBurger(s2, h2).id, 2, 'the heel follows the half that was assigned');
  P.serve(s2);
  assert.equal(h2.burger, 2);
});

test('every item stays finite, conserves its mass into steam and fat, and cools off the heat', () => {
  const s = panAt(210, 8);
  const made = [];
  for (const k of ['bun', 'bacon', 'egg', 'onions']) for (const it of P.addItem(s, k)) made.push(it);
  assert.equal(made.length, 5); // the bun goes in as two halves
  cookItem(s, 240, 210);
  for (const it of made) {
    const m = P.itemMass(it);
    assert.ok(Number.isFinite(m) && m > 0, `${it.kind}: mass=${m}`);
    assert.ok(Number.isFinite(P.itemT(it)) && P.itemT(it) > 0 && P.itemT(it) < 400, `${it.kind}: T=${P.itemT(it)}`);
    const balance = m + it.lostWater + it.lostFat + it.lostDrip - it.fatSoaked;
    assert.ok(Math.abs(balance - it.m0) < 1e-4, `${it.kind}: ${(balance - it.m0) * 1000} g adrift`);
    P.removeItem(s, it);
  }
  const egg = made.find((i) => i.kind === 'egg');
  const hot = P.itemT(egg), whiteHot = egg.wBot.T;
  // Off the heat nothing snaps to the room: a lump of egg is ~160 J/K losing 15-odd watts to still
  // air, so the time constant is five minutes. Five seconds of it is nothing.
  cookItem(s, 5, 210);
  assert.ok(P.itemT(egg) > hot - 3 && egg.wBot.T > whiteHot - 6, `five seconds off the heat: yolk ${hot} → ${P.itemT(egg)}, white ${whiteHot} → ${egg.wBot.T}`);
  cookItem(s, 295, 210);
  // Five minutes later the white — which is the surface — has given up most of it, while the yolk
  // buried in the middle coasts on carry-over for the first minute and is only ~10 K down.
  assert.ok(egg.wBot.T < whiteHot - 25, `the white should have cooled: ${whiteHot} → ${egg.wBot.T}`);
  assert.ok(P.itemT(egg) < hot - 5 && P.itemT(egg) > 25, `off the heat it should cool: ${hot} → ${P.itemT(egg)}`);
  assert.ok(egg.restT > 290);
});

test('toppings over coals: the bars toast a bun, an egg runs through them, and nothing goes NaN', () => {
  const s = litGrill(8, 600); cookFor(s, 240);
  const [heel] = P.addItem(s, 'bun');
  const [rasher] = P.addItem(s, 'bacon');
  const [egg] = P.addItem(s, 'egg');
  cookFor(s, 90);
  assert.ok(heel.cutFace.brown > 1, `a grate toasts a bun face too: ${heel.cutFace.brown}`);
  assert.ok(rasher.lostFat > 0.001 && s.grill.fatOnCoals > 0, 'rendered bacon fat falls on the coals');
  assert.ok(egg.lostDrip > 0.002, `raw white runs through the bars: ${egg.lostDrip * 1000} g`);
  for (const it of [heel, rasher, egg]) {
    assert.ok(Number.isFinite(P.itemMass(it)) && Number.isFinite(P.itemT(it)), `${it.kind} went non-finite`);
    assert.ok(P.itemState(it).state.length > 0);
  }
  assert.equal(P.washPan(s), false, 'the grate cannot be brushed with food on it');
});

// ---------------------------------------------------------------- the spatula: moving things about
// Everything the pan does to a patty is read from where it is standing, every step: which rings it
// draws heat from, which part of the burner's profile is under it, and — on a banked kettle — which
// side of the fire it is on. These tests are about that following the patty when it moves.
function footprintT(s, pos, rad) {
  const rings = P.footprintRings(s.pan, pos, rad), Tr = s.pan.Tr;
  let T = 0; for (const o of rings) T += o.w * (o.t ? Tr[o.j0] * (1 - o.t) + Tr[o.j0 + 1] * o.t : Tr[o.j0]);
  return T;
}
function meanTat(p) { let T = 0; for (let j = 0; j < p.Nr; j++) T += p.sc.TatR[j] * p.aj[j]; return T; }

test('the rim of a gas pan is cooler metal than the middle, and a patty dragged out there reads it', () => {
  const s = P.createState({ pan: 'castiron', stove: 'gas' }); preheat(s, 200);
  P.setKnob(s, 4); cookFor(s, 300); P.addFat(s, 'canola', 8);
  const p = std({ thicknessMm: 18 }), R = p.D / 2, lim = s.pan.floorR - R;
  const Tmid = footprintT(s, { x: 0, y: 0 }, R), Trim = footprintT(s, { x: lim, y: 0 }, R);
  assert.ok(Tmid - Trim > 30, `the metal under the rim should be well cooler: middle ${Tmid.toFixed(0)}, rim ${Trim.toFixed(0)}`);
  // laid in the middle, it reads the middle; slid to the rim, it reads the rim, within a step
  P.placePatty(s, p, { x: 0, y: 0 }); cookFor(s, 2);
  const mid = meanTat(p);
  assert.ok(Math.abs(mid - Tmid) < 25, `in the middle it reads the middle: ${mid.toFixed(0)} vs ${Tmid.toFixed(0)}`);
  const r = P.movePatty(s, p, { x: lim, y: 0 });
  assert.ok(r.ok && r.moved > 0.08, `moved ${JSON.stringify(r)}`);
  cookFor(s, 2);
  assert.ok(meanTat(p) < mid - 25, `the metal it reads should follow it out: ${mid.toFixed(0)} → ${meanTat(p).toFixed(0)}`);
  // and the heat comes out of the rings it is actually standing on now: ring 0 recovers, the rings
  // under the rim start to sag
  const T0 = s.pan.Tr[0], T8 = s.pan.Tr[8];
  cookFor(s, 60);
  assert.ok(s.pan.Tr[0] > T0, `ring 0 should stop being drained once nothing is on it: ${T0.toFixed(0)} → ${s.pan.Tr[0].toFixed(0)}`);
  assert.ok(s.pan.Tr[8] < T8, `and the rings under it now should give up heat: ${T8.toFixed(0)} → ${s.pan.Tr[8].toFixed(0)}`);
  // What does NOT follow is the time to the centre, and that is not an oversight. The middle of a
  // 12" pan over a ring burner is a small reservoir with no flame under it, the rim is a big one
  // sitting right over the flame, and while the underside is still boiling the surface is pinned at
  // 100 °C either way — so hotter metal buys crust and evaporation, not a faster centre. The place
  // where position really does change the clock is a banked fire, where it changes the radiant load
  // by a factor of five (see the two-zone tests below).
});

test('a patty dragged across the pan before it releases tears exactly as an early flip does', () => {
  const tear = (how) => {
    const s = P.createState({ pan: 'stainless', stove: 'gas' }); preheat(s, 220);
    const p = std({ thicknessMm: 18 }); P.placePatty(s, p, { x: 0, y: 0 });
    cookFor(s, 25); // far too early: raw protein still welded to the steel
    assert.ok(p.faceDown.stuck, 'it should still be stuck this early');
    if (how === 'flip') P.flipPatty(s, p);
    else if (how === 'move') P.movePatty(s, p, { x: 0.05, y: 0 });
    else P.scrape(s, p);
    return p.faceDown.torn + p.faceUp.torn;
  };
  const flipped = tear('flip'), moved = tear('move'), scraped = tear('scrape');
  assert.ok(moved > 0.02, `dragging a stuck patty must cost it: torn ${moved}`);
  assert.ok(Math.abs(moved - flipped) < 1e-9, `a drag tears exactly like an early flip: ${moved} vs ${flipped}`);
  assert.ok(scraped < moved * 0.5 && scraped > 0, `the blade tears less than the lift: ${scraped} vs ${moved}`);
  assert.ok(Math.abs(scraped - moved * 0.4) < 1e-9, `and it is the 40 % the model claims: ${scraped / moved}`);
});

test('scraping frees a stuck patty, costs it a second of contact, and says so when it was already free', () => {
  const s = P.createState({ pan: 'stainless', stove: 'gas' }); preheat(s, 220); // dry steel: the worst case for sticking
  const p = std({ thicknessMm: 18 }); P.placePatty(s, p, { x: 0, y: 0 });
  cookFor(s, 25);
  const r = P.scrape(s, p);
  assert.ok(r.ok && r.torn > 0 && !p.faceDown.stuck, `scrape: ${JSON.stringify(r)} stuck=${p.faceDown.stuck}`);
  assert.ok(s.events.some((e) => /spatula under patty/.test(e.text)), s.events.map((e) => e.text).join(' | '));
  assert.ok(p.scrapeT > 0.9 && p.scrapeT <= 1, `a scrape is a second of work: ${p.scrapeT}`);
  // during that second the face is up on the blade: far less heat crosses than in the second before
  const before = s.diag.panQ;
  P.step(s, DT);
  assert.ok(s.diag.panQ < before * 0.6, `on the blade it should draw much less: ${before.toFixed(0)} → ${s.diag.panQ.toFixed(0)} W`);
  cookFor(s, 1.2);
  assert.equal(p.scrapeT, 0, 'and the second runs out in simulated time');
  const after = s.diag.panQ;
  // against `before`, not against itself: the face is back on the metal, so the draw is what it was
  // before the blade went under it (measured 385 W before, 133 W on the blade, 392 W after)
  assert.ok(after > before * 0.8 && after > 100, `and the heat comes back once it is down: ${before.toFixed(0)} → ${after.toFixed(0)} W`);
  // a released patty just slides
  cookFor(s, 200);
  assert.ok(!p.faceDown.stuck);
  const r2 = P.scrape(s, p);
  assert.equal(r2.torn, 0);
  assert.ok(s.events.some((e) => /moves freely/.test(e.text)), 'it should say it moves freely');
});

test('moving is bounded by the floor and refuses to stack meat on meat', () => {
  const s = P.createState({}); preheat(s, 200);
  const a = std({ thicknessMm: 18 }), b = std({ thicknessMm: 18, massG: 120 });
  const spots = P.pattySpots(2, s.pan.floorR, a.D / 2);
  P.placePatty(s, a, spots[0]); P.placePatty(s, b, spots[1]);
  // way outside the pan: clamped to the floor with the whole patty on the metal
  const r = P.movePatty(s, a, { x: 1, y: 0 });
  assert.ok(r.ok, 'a move off the edge is clamped, not refused');
  assert.ok(Math.hypot(a.pos.x, a.pos.y) + a.D / 2 <= s.pan.floorR + 1e-9, `it must stay on the floor: ${Math.hypot(a.pos.x, a.pos.y) + a.D / 2} > ${s.pan.floorR}`);
  // straight on top of the other one: nudged clear, and never overlapping
  const r2 = P.movePatty(s, a, { x: b.pos.x, y: b.pos.y });
  const gap = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) - a.D / 2 - b.D / 2;
  assert.ok(gap > -0.001, `two patties must not end up on top of each other: gap ${(gap * 1000).toFixed(1)} mm (${JSON.stringify(r2)})`);
  // a pan with no room left refuses rather than stacking
  const s2 = P.createState({ pan: 'nonstick' }); preheat(s2, 200);
  const big = std({ massG: 320, thicknessMm: 14 }), small = std({ massG: 90, thicknessMm: 14 });
  P.placePatty(s2, big, { x: 0, y: 0 });
  P.placePatty(s2, small, { x: s2.pan.floorR - small.D / 2, y: 0 });
  const r3 = P.movePatty(s2, small, { x: 0, y: 0 });
  assert.equal(r3.ok, false, 'nowhere to put it: refused');
  assert.ok(s2.events.some((e) => /No room/.test(e.text)));
});

test('a topping drags its footprint with it: the rings it draws from and shades follow', () => {
  const s = panAt(200, 8);
  const [heel] = P.addItem(s, 'bun');
  P.moveItem(s, heel, { x: 0, y: 0 });
  cookItem(s, 20, 200);
  assert.ok(Math.hypot(heel.pos.x, heel.pos.y) < 0.005, `it should be in the middle now: ${JSON.stringify(heel.pos)}`);
  assert.equal(heel.rings[0].j0, 0, 'and drawing from the middle rings');
  const cov = P.ringCoverage(s);
  assert.ok(cov[0] > 0.5, `the middle of the pan is shaded by it now: ${cov[0]}`);
  const T0 = heel.Tat;
  P.moveItem(s, heel, { x: s.pan.floorR - heel.Dcov / 2, y: 0 });
  cookItem(s, 20, 200);
  assert.ok(heel.Tat < T0 - 10, `out at the rim it sits on cooler metal: ${T0.toFixed(0)} → ${heel.Tat.toFixed(0)}`);
  assert.ok(P.ringCoverage(s)[0] < 0.2, 'and the middle is bare again');
});

// ---------------------------------------------------------------- two-zone fire
test('banked coals: a hot side and a cool side 150 °C apart, and raking them out again evens it up', () => {
  const s = litGrill(8, 600); P.setKnob(s, 7); cookFor(s, 240);
  const even = s.pan.Tr[4];
  assert.equal(s.pan.zoned, false, 'a bed spread flat has no two zones');
  const coal0 = s.grill.coal;
  P.setBank(s, 1);
  cookFor(s, 600);
  const R = s.pan.floorR;
  const hot = P.panTatXY(s, 0.66 * R, 0), cool = P.panTatXY(s, -0.66 * R, 0);
  assert.ok(hot - cool >= 150, `the two sides should be at least 150 K apart: hot ${hot.toFixed(0)}, cool ${cool.toFixed(0)}`);
  assert.ok(hot - cool < 300, `and not absurdly more: ${(hot - cool).toFixed(0)}`);
  assert.ok(hot > even - 40 && cool < even - 100, `hot side near the old bed (${even.toFixed(0)}), cool side far below: ${hot.toFixed(0)} / ${cool.toFixed(0)}`);
  // banking moves the charcoal, it does not burn more or less of it
  const burnt = coal0 - s.grill.coal;
  const s2 = litGrill(8, 600); P.setKnob(s2, 7); cookFor(s2, 240); const c2 = s2.grill.coal; cookFor(s2, 600);
  assert.ok(Math.abs(burnt - (c2 - s2.grill.coal)) < 0.01, `the same coal burns either way: ${burnt} vs ${c2 - s2.grill.coal}`);
  // the meat's view of the fire follows the same profile
  const bHot = P.bedAt(s, 0.66 * R), viewHot = bHot.view, TfHot = bHot.Tfire;
  const bCool = P.bedAt(s, -0.66 * R), viewCool = bCool.view, TfCool = bCool.Tfire;
  assert.equal(viewHot, 1, 'over the pile it sees the whole fire');
  assert.ok(viewCool > 0.3 && viewCool < 0.4, `and about a third of it off the pile: ${viewCool}`);
  assert.ok(TfCool < TfHot - 130, `radiating at a fraction of the bed: ${TfCool.toFixed(0)} vs ${TfHot.toFixed(0)}`);
  // rake it flat again and the bars come back together
  P.setBank(s, 0);
  cookFor(s, 900);
  assert.ok(P.panTatXY(s, 0.66 * R, 0) - P.panTatXY(s, -0.66 * R, 0) < 40, `spread out again: ${(P.panTatXY(s, 0.66 * R, 0) - P.panTatXY(s, -0.66 * R, 0)).toFixed(0)} K apart`);
});

test('two-zone technique: sear over the coals, finish off them — medium-rare with a quarter of the char', () => {
  const cook = (move) => {
    const s = litGrill(8, 600); P.setKnob(s, 9); P.setBank(s, 1); cookFor(s, 420);
    const p = std({ thicknessMm: 20, massG: 150, work: 0.35 });
    const R = s.pan.floorR, hot = { x: 0.6 * R, y: 0 }, cool = { x: -0.6 * R, y: 0 };
    P.placePatty(s, p, hot);
    let since = 0, moved = false, g = 0;
    while (P.centerT(p) < (move ? 49 : 47) && g++ < 200000) {
      P.step(s, DT); since += DT;
      if (since >= 60 && !p.faceDown.stuck) { P.flipPatty(s); since = 0; if (move && !moved && p.cookTime >= 180) { P.movePatty(s, p, cool); moved = true; } }
    }
    P.removePatty(s); cookFor(s, 150);
    const r = P.evaluate(s, 'medium-rare', p);
    return { r, char: p.faceDown.char + p.faceUp.char, t: p.cookTime };
  };
  const stay = cook(false), two = cook(true);
  console.log(`   stayed on the coals: ${stay.t.toFixed(0)} s, char ${stay.char.toFixed(2)}, ${stay.r.total}/100; moved across: ${two.t.toFixed(0)} s, char ${two.char.toFixed(2)}, ${two.r.total}/100`);
  for (const c of [stay, two]) assert.ok(c.r.peak > 54 && c.r.peak < 57.5, `both should land medium-rare: ${c.r.peak}`);
  assert.ok(two.char < stay.char * 0.5, `the cool side should char far less: ${two.char.toFixed(2)} vs ${stay.char.toFixed(2)}`);
  assert.ok(two.t > stay.t + 30, `and take longer to get there: ${two.t.toFixed(0)} vs ${stay.t.toFixed(0)} s`);
  assert.ok(two.r.total > stay.r.total + 5, `which is the whole point: ${two.r.total} vs ${stay.r.total}`);
});

// ---------------------------------------------------------------- the cook's senses
/** Cook a standard patty to a pull temperature the way the README says to, and rest it. */
function toPull(pull, over) {
  const s = P.createState({}); preheat(s, 200); P.addFat(s, 'canola', 8);
  const p = std({ thicknessMm: 18, ...over }); P.placePatty(s, p);
  let since = 0, g = 0;
  while (pull > 0 && P.centerT(p) < pull && g++ < 60000) {
    hold(s, 200); P.step(s, DT); since += DT;
    if (since >= 45 && !p.faceDown.stuck) { P.flipPatty(s); since = 0; }
  }
  return { s, p };
}

test('the press test: firmness rises monotonically with the peak centre temperature, raw → rare → medium → well', () => {
  const out = [];
  for (const pull of [0, 41, 47, 56, 61, 68]) {
    const { s, p } = toPull(pull);
    P.removePatty(s, p); cookFor(s, 150);
    const r = P.pressTest(s, p);
    out.push({ pull, peak: p.peakCenter, idx: r.index, kPa: r.E / 1000, word: r.word });
  }
  for (const o of out) console.log(`   pull ${o.pull}: peak ${o.peak.toFixed(1)} °C → ${o.kPa.toFixed(1)} kPa, index ${o.idx.toFixed(3)} (${o.word})`);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].peak > out[i - 1].peak, `the cooks must be in order: ${out[i].peak} after ${out[i - 1].peak}`);
    assert.ok(out[i].idx > out[i - 1].idx + 0.01, `firmness must rise with the peak centre: ${out[i - 1].idx.toFixed(3)} → ${out[i].idx.toFixed(3)}`);
  }
  // and the words a cook would use land on the doneness they mean
  assert.equal(out[0].word, 'raw');
  assert.equal(out[2].word, 'springy');   // pulled at 47 → medium-rare
  assert.equal(out[5].word, 'hard');      // pulled at 68 → well done
  assert.ok(out[0].kPa > 8 && out[0].kPa < 14, `raw mince is 8–14 kPa: ${out[0].kPa}`);
  assert.ok(out[5].kPa > 45 && out[5].kPa < 80, `a well-done patty is a few tens of kPa: ${out[5].kPa}`);
});

test('a press test costs about a tenth of the juice a spatula press does', () => {
  const cost = (how) => {
    const { s, p } = toPull(47);
    const before = P.pattyMass(p);
    if (how === 'finger') P.pressTest(s, p); else P.pressPatty(s, false, p);
    return before - P.pattyMass(p);
  };
  const finger = cost('finger'), spatula = cost('spatula');
  console.log(`   finger ${(finger * 1000).toFixed(2)} g vs spatula ${(spatula * 1000).toFixed(2)} g (${((finger / spatula) * 100).toFixed(0)} %)`);
  assert.ok(finger > 0, 'a press test is not free');
  assert.ok(finger < spatula, 'and it must cost less than leaning on it with a spatula');
  assert.ok(finger / spatula < 0.2, `about a tenth of it, not most of it: ${(finger / spatula).toFixed(3)}`);
  // it also flattens the dome a little, the way pushing on something does
  const { s, p } = toPull(47, { dimple: false });
  const dome = p.dome; P.pressTest(s, p);
  assert.ok(p.dome < dome, 'pushing down on it flattens the dome a little');
});

test('a peek records a slit, reads the colour and the grey band, and weeps during the rest', () => {
  const { s, p } = toPull(47);
  const v = P.peek(s, p);
  console.log(`   ${v.colour} · grey band ${v.greyBottomMm.toFixed(1)} / ${v.greyTopMm.toFixed(1)} mm`);
  assert.equal(p.slits, 1);
  assert.ok(v.greyBottomMm > 0.5 && v.greyBottomMm < p.h * 1000 * 0.5, `a grey band that is neither nothing nor the whole patty: ${v.greyBottomMm} mm of ${p.h * 1000} mm`);
  assert.ok(/red|pink/.test(v.colour), `a medium-rare centre is not grey: ${v.colour}`);
  assert.ok(s.events.some((e) => e.kind === 'note' && /Cut into patty/.test(e.text)), 'and it says so in the log');
  const cut0 = p.lostWaterCut;
  P.removePatty(s, p); cookFor(s, 150);
  const lost = p.lostWaterCut - cut0;
  let w0 = 0; for (const v2 of p.w0c) w0 += v2;
  console.log(`   ${(p.lostWaterCut * 1000).toFixed(2)} g out of the cut (${((p.lostWaterCut / w0) * 100).toFixed(1)} % of the water), ${(lost * 1000).toFixed(2)} g of it during the rest`);
  assert.ok(lost > 0, 'it keeps weeping out of the cut while it rests');
  assert.ok(p.lostWaterCut / w0 > 0.005 && p.lostWaterCut / w0 < 0.06, `a few percent of the water, not a trickle and not a flood: ${(p.lostWaterCut / w0 * 100).toFixed(1)} %`);
  // a second cut opens a second drain
  const { s: s2, p: p2 } = toPull(47);
  P.peek(s2, p2); P.peek(s2, p2);
  assert.equal(p2.slits, 2);
  P.removePatty(s2, p2); cookFor(s2, 150);
  assert.ok(p2.lostWaterCut > p.lostWaterCut, 'twice cut, twice drained');
});

test('a peeked patty cannot score 100: it was cut', () => {
  const whole = recipe('medium-rare', 18, 47);
  assert.equal(whole.total, 100, 'the README recipe still scores 100 when nobody cuts into it');
  const s = P.createState({}); P.setKnob(s, 8); while (s.pan.T < 200) P.step(s, DT);
  P.addFat(s, 'canola', 8);
  const p = std({ thicknessMm: 18 }); P.placePatty(s, p);
  let since = 0, g = 0, cut = false;
  while (P.centerT(p) < 47 && g++ < 60000) {
    hold(s, 200); P.step(s, DT); since += DT;
    if (since >= 45 && !p.faceDown.stuck) { P.flipPatty(s); since = 0; }
    if (!cut && P.centerT(p) > 42) { P.peek(s, p); cut = true; }
  }
  P.removePatty(s, p); cookFor(s, 150);
  const r = P.evaluate(s, 'medium-rare', p);
  console.log(`   cut into it once: ${r.total}/100 ${JSON.stringify(r.parts)}`);
  assert.ok(cut && r.peeks === 1);
  assert.ok(r.total < 100, `a burger with a slit in it is not a 100: ${r.total}`);
  assert.ok(r.parts.structure < 5, 'and it is the structure mark that pays for it');
  assert.ok(r.notes.some((n) => /cut into it once/.test(n)), 'the results say so');
});

test('the hand test: seconds fall as the pan heats, and a wide-open coal bed gives you two', () => {
  const s = P.createState({});
  const rows = [];
  for (const T of [150, 200, 250, 300, 350]) { preheat(s, T); rows.push({ T: s.pan.T, ...P.handTest(s) }); }
  for (const r of rows) console.log(`   pan ${r.T.toFixed(0)} °C → ${r.seconds.toFixed(1)} s (${r.word}), ${(r.flux / 1000).toFixed(1)} kW/m²`);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].seconds < rows[i - 1].seconds - 0.5, `a hotter pan must give you less time: ${rows[i - 1].seconds} → ${rows[i].seconds}`);
  assert.ok(rows[0].seconds > 12, `a 150 °C pan is not a fire — you can hold a hand over it: ${rows[0].seconds.toFixed(1)} s`);
  // wide-open coals: the classic two seconds
  const g = litGrill(10, 700); cookFor(g, 300);
  const h = P.handTest(g);
  console.log(`   coal bed ${g.grill.Tfire.toFixed(0)} °C, grate ${g.pan.T.toFixed(0)} °C → ${h.seconds.toFixed(1)} s (${h.word}), ${(h.flux / 1000).toFixed(1)} kW/m², ${(h.radiant / 1000).toFixed(1)} of it radiant`);
  assert.ok(h.seconds <= 2, `two seconds over a wide-open bed: ${h.seconds.toFixed(1)}`);
  assert.ok(h.radiant > h.convective, 'and most of it is radiant, which is what a fire does that a pan cannot');
  // banked: the whole point of a two-zone fire is that your hand can tell them apart
  const b = litGrill(8, 600); P.setKnob(b, 7); cookFor(b, 240); P.setBank(b, 1); cookFor(b, 600);
  const R = b.pan.floorR;
  const hot = P.handTest(b, { x: 0.66 * R, y: 0 }), cool = P.handTest(b, { x: -0.66 * R, y: 0 });
  console.log(`   banked: ${hot.seconds.toFixed(1)} s over the coals, ${cool.seconds.toFixed(1)} s off them`);
  assert.ok(cool.seconds > hot.seconds * 3, `the two zones must be obvious to a hand: ${hot.seconds.toFixed(1)} vs ${cool.seconds.toFixed(1)} s`);
});

test('the sizzle is a diagnostic: a wet underside crackles, a dry one hisses, and the log says which', () => {
  const s = P.createState({}); preheat(s, 200); P.addFat(s, 'canola', 8);
  const p = std({ thicknessMm: 18 }); P.placePatty(s, p);
  let wetBoil = 0, wetHiss = 0, dryBoil = 0, dryHiss = 0, g = 0;
  while (p.cookTime < 200 && g++ < 60000) {
    hold(s, 200); P.step(s, DT);
    const wet = P.layerMean(p, p.w, 0) / P.layerMean(p, p.w0c, 0);
    if (p.cookTime > 2 && wet > 0.5) { wetBoil = Math.max(wetBoil, s.diag.boilNoise); wetHiss = Math.max(wetHiss, s.diag.hiss); }
    if (wet < 0.05) { dryBoil = Math.max(dryBoil, s.diag.boilNoise); dryHiss = Math.max(dryHiss, s.diag.hiss); }
  }
  console.log(`   wet: boil ${wetBoil.toFixed(2)} / hiss ${wetHiss.toFixed(2)} · dry: boil ${dryBoil.toFixed(2)} / hiss ${dryHiss.toFixed(2)}`);
  assert.ok(wetBoil > 0.3, `a wet underside on a 200 °C pan is a loud crackle: ${wetBoil.toFixed(2)}`);
  assert.ok(wetHiss < wetBoil, 'and it is louder than the frying noise while it lasts');
  assert.ok(dryHiss > 0.3 && dryHiss > wetHiss * 2, `a dry crust hisses instead: ${dryHiss.toFixed(2)} against ${wetHiss.toFixed(2)}`);
  assert.ok(dryBoil < wetBoil * 0.5, `and the crackle goes with the water: ${wetBoil.toFixed(2)} → ${dryBoil.toFixed(2)}`);
  const notes = s.events.filter((e) => e.kind === 'note').map((e) => e.text);
  assert.ok(notes.some((t) => /loud and rough/.test(t)), 'the log calls the crackle');
  assert.ok(notes.some((t) => /dropped to a hiss/.test(t)), 'and the log calls the change to a hiss, which is the cue hard mode needs');
  // a patty up on the blade is not touching the metal, and the sound goes with it
  const before = s.diag.boilNoise + s.diag.hiss;
  P.scrape(s, p); P.step(s, DT);
  assert.ok(s.diag.contact < 0.7, `on the blade, most of the face is off the metal: ${s.diag.contact.toFixed(2)}`);
  assert.ok(s.diag.boilNoise + s.diag.hiss < before, 'so the sizzle drops when it lifts');
});

test('the grill has a roar a pan does not, and the lid is a low-pass filter on all of it', () => {
  const g = litGrill(9, 650);
  assert.ok(g.diag.roar > 0.5, `vents wide open, the fire draws hard: ${g.diag.roar.toFixed(2)}`);
  P.setKnob(g, 2); cookFor(g, 300);
  assert.ok(g.diag.roar < 0.4, `and quietens right down when they are shut: ${g.diag.roar.toFixed(2)}`);
  const open = g.diag.roar;
  P.toggleLid(g); cookFor(g, 30);
  assert.ok(g.diag.lid === true && g.diag.roar < open, 'the lid throttles the fire and muffles it');
  const pan = P.createState({}); preheat(pan, 200);
  assert.equal(pan.diag.roar, 0, 'a pan on a burner has no draught through it at all');
});

// ---------------------------------------------------------------- the customer, the bill, the shift
const D = (id) => P.DONENESS.find((d) => d.id === id);
/** A hand-built `evaluate` result: a flawless medium-rare, with whatever is overridden on top. */
function mkResult(over = {}) {
  const target = D(over.target || 'medium-rare');
  const got = D(over.got || over.target || 'medium-rare');
  const mid = (target.lo + target.hi) / 2;
  const base = {
    id: 1, total: 100, target, got, peak: mid, dist: 0, serveT: mid,
    parts: { doneness: 50, crust: 20, juiciness: 15, evenness: 10, structure: 5 },
    waterRetained: 0.70, waterEvap: 0.02, waterDrip: 0.002, fatLost: 0.01, stuck: 0, overFrac: 0.3, cheeseSlices: 0,
    faces: { down: { id: 'A', brown: 3.2, char: 0.08, torn: 0, marks: 0 }, up: { id: 'B', brown: 3.0, char: 0.07, torn: 0, marks: 0 } },
    cookTime: 340, restTime: 150, flips: 7, notes: [],
  };
  const r = { ...base, ...over };
  r.target = target; r.got = got;
  return r;
}
const kinds = (v) => v.complaints.map((c) => c.kind);

test('verdict: a flawless burger is delighted, praised, and tipped the full 25 %', () => {
  const v = P.verdict(mkResult());
  assert.equal(v.outcome, 'delighted');
  assert.equal(v.complaints.length, 0, JSON.stringify(v.complaints));
  assert.equal(v.doneness.state, 'right');
  assert.equal(v.crust.state, 'proper');
  assert.equal(v.juiciness.state, 'juicy');
  assert.equal(v.temperature.state, 'hot');
  assert.ok(Math.abs(v.tip - 0.25) < 1e-9, `tip=${v.tip}`);
  assert.equal(v.bill, P.MENU.burger);
  assert.ok(Math.abs(v.tipAmount - P.MENU.burger * 0.25) < 0.005, `tip $${v.tipAmount}`);
  assert.ok(/[“”]/.test(v.quote) && v.quote.length > 12, v.quote);
});

test('verdict: dry, no crust, burnt, cold, under and over each get their own complaint', () => {
  const dry = P.verdict(mkResult({ total: 78, waterRetained: 0.55, parts: { doneness: 50, crust: 20, juiciness: 3, evenness: 10, structure: 5 } }));
  assert.equal(dry.juiciness.state, 'parched');
  assert.ok(kinds(dry).includes('dry'), kinds(dry).join(','));
  assert.ok(/dry|sawdust|chalk|juice/i.test(dry.quote), dry.quote);

  const tight = P.verdict(mkResult({ total: 88, waterRetained: 0.66 }));   // 3 points of water short of a medium-rare
  assert.equal(tight.juiciness.state, 'tight');

  const nocrust = P.verdict(mkResult({ total: 76, faces: { down: { brown: 0.4, char: 0 }, up: { brown: 0.3, char: 0 } } }));
  assert.equal(nocrust.crust.state, 'none');
  assert.ok(kinds(nocrust).includes('crust'));
  assert.ok(/crust|seared|steamed/i.test(nocrust.quote), nocrust.quote);

  const pale = P.verdict(mkResult({ total: 84, faces: { down: { brown: 1.4, char: 0.02 }, up: { brown: 1.2, char: 0.02 } } }));
  assert.equal(pale.crust.state, 'pale');

  const burnt = P.verdict(mkResult({ total: 62, faces: { down: { brown: 5, char: 0.6 }, up: { brown: 3, char: 0.2 } } }));
  assert.equal(burnt.crust.state, 'burnt');
  assert.ok(/burnt|ash|carbon|cremated|bitter/i.test(burnt.quote), burnt.quote);

  const cold = P.verdict(mkResult({ total: 84, serveT: 34 }));   // peaked at 55.5, served at 34
  assert.equal(cold.temperature.state, 'cold');
  assert.ok(kinds(cold).includes('cold'));
  assert.ok(/cold|sitting|pass/i.test(cold.quote), cold.quote);
  const warm = P.verdict(mkResult({ total: 90, serveT: 44 }));   // 11.5 °C down: lukewarm, not cold
  assert.equal(warm.temperature.state, 'lukewarm');

  const under = P.verdict(mkResult({ target: 'medium', got: 'rare', peak: 50.5, dist: 9.5, serveT: 50.5, total: 52 }));
  assert.equal(under.doneness.state, 'under');
  assert.ok(/raw|uncooked/i.test(under.quote), under.quote);
  const overCooked = P.verdict(mkResult({ target: 'medium-rare', got: 'well-done', peak: 74, dist: 17, serveT: 74, total: 50 }));
  assert.equal(overCooked.doneness.state, 'over');
  assert.ok(/grey|puck|cooked every/i.test(overCooked.quote), overCooked.quote);
  const nearly = P.verdict(mkResult({ target: 'medium', got: 'medium-rare', peak: 58, dist: 2, serveT: 58, total: 88 }));
  assert.equal(nearly.doneness.state, 'under');
  assert.equal(nearly.complaints.find((c) => c.kind === 'doneness').sev, 0.25);
});

test('verdict: structure and grill faults are noticed', () => {
  const torn = P.verdict(mkResult({ total: 70, stuck: 0.004 }));
  assert.ok(torn.structure.faults.includes('torn'), JSON.stringify(torn.structure));
  const springy = P.verdict(mkResult({ total: 82, patty: { id: 1, work: 0.95, salt: 'surface' } }));
  assert.ok(springy.structure.faults.includes('springy'));
  const domed = P.verdict(mkResult({ total: 80, patty: { id: 1, dome: 0.8 } }));
  assert.ok(domed.structure.faults.includes('domed'));
  const grilled = P.verdict(mkResult({ total: 92, grilled: true, waterRetained: 0.60, faces: { down: { brown: 2.4, char: 0.1, marks: 4 }, up: { brown: 2.2, char: 0.1, marks: 3.5 } } }));
  assert.equal(grilled.grill.grilled, true);
  assert.ok(grilled.praise.some((g) => /charcoal/i.test(g.text)), JSON.stringify(grilled.praise));
  assert.equal(grilled.juiciness.state, 'juicy'); // a grilled patty is allowed to lose 10 points more water
  const sooty = P.verdict(mkResult({ total: 74, grilled: true, flareChar: 0.4 }));
  assert.ok(kinds(sooty).includes('smoke'));
});

test('verdict: outcomes and the tip that goes with them', () => {
  assert.equal(P.verdict(mkResult({ total: 90 })).outcome, 'delighted');
  assert.equal(P.verdict(mkResult({ total: 89 })).outcome, 'accepted');
  assert.equal(P.verdict(mkResult({ total: 45 })).outcome, 'accepted');
  const back = P.verdict(mkResult({ total: 44 }));
  assert.equal(back.outcome, 'sent back');
  assert.equal(back.tip, 0);
  assert.equal(back.tipAmount, 0);
  assert.ok(/back|can't eat|sorry/i.test(back.quote), back.quote);
  // a raw or burnt item in the build sends the plate back however well the patty scored
  const raw = P.verdict(mkResult({ total: 100, build: [{ name: 'bacon', state: 'raw' }] }));
  assert.equal(raw.outcome, 'sent back');
  assert.equal(raw.build.ok, false);
  assert.ok(/bacon/.test(raw.quote), raw.quote);
  const burntItem = P.verdict(mkResult({ total: 96, build: [{ name: 'bun', state: 'burnt' }] }));
  assert.equal(burntItem.outcome, 'sent back');
  const goodBuild = P.verdict(mkResult({ total: 96, build: [{ name: 'cheese', state: 'melted' }] }));
  assert.equal(goodBuild.outcome, 'delighted');
  assert.equal(goodBuild.build.ok, true);
});

test('tips: nothing on a sent-back plate, ~10 % on a mediocre one, 25 % on a perfect one, and it only ever rises', () => {
  assert.equal(P.tipFraction(30), 0);
  assert.equal(P.tipFraction(95, 'sent back'), 0);
  assert.ok(Math.abs(P.tipFraction(100, 'delighted') - 0.25) < 1e-9);
  assert.ok(P.tipFraction(70, 'accepted') > 0.09 && P.tipFraction(70, 'accepted') < 0.12, P.tipFraction(70, 'accepted'));
  assert.ok(P.tipFraction(90, 'delighted') > 0.19 && P.tipFraction(90, 'delighted') < 0.21);
  let prev = -1;
  for (let s = 45; s <= 100; s++) { const t = P.tipFraction(s, 'accepted'); assert.ok(t >= prev, `tip fell at ${s}`); prev = t; }
  // the bill is the burger plus what went on it, and the tip is paid on that
  assert.equal(P.billFor([{ cheeseSlices: 0 }]).total, P.MENU.burger);
  assert.equal(P.billFor([{ cheeseSlices: 2 }]).total, P.MENU.burger + 2 * P.MENU.cheese);
  assert.equal(P.billFor([{ cheeseSlices: 0 }, { cheeseSlices: 1 }]).total, 2 * P.MENU.burger + P.MENU.cheese);
  const cheesy = P.verdict(mkResult({ cheeseSlices: 2 }));
  assert.equal(cheesy.bill, P.MENU.burger + 2 * P.MENU.cheese);
  assert.ok(Math.abs(cheesy.tipAmount - cheesy.bill * 0.25) < 0.005);
});

test('the ticket clock: a rare is quick, three burgers are not, and the quote is ~1.6× the cook', () => {
  const one = P.ticketTargetTime(['medium-rare']);
  assert.ok(Math.abs(one - 1.6 * (P.COOK_S['medium-rare'] + 150)) < 10, `${one}`);
  assert.ok(P.ticketTargetTime(['rare']) < P.ticketTargetTime(['well-done']), 'rare should be quicker than well done');
  assert.ok(P.ticketTargetTime(['medium-rare', 'medium-rare']) > one, 'a second burger costs time');
  assert.ok(P.ticketTargetTime(['medium-rare', 'medium-rare']) < 2 * one, 'but they share the pan, so not double');
  const three = P.ticketTargetTime(['rare', 'medium', 'medium-well']);
  assert.ok(three > P.ticketTargetTime(['rare', 'medium']), 'three is slower than two');
  assert.ok(one > 600 && one < 900, `one medium-rare quoted at ${one} s`);
  assert.equal(P.ticketTargetTime([]), 0);
});

test('the late penalty: free until the quote, −5 at half again, −10 at double, no worse after', () => {
  const T = 720;
  assert.equal(P.latePenalty(0, T), 0);
  assert.equal(P.latePenalty(T, T), 0);
  assert.ok(Math.abs(P.latePenalty(T * 1.5, T) - 5) < 1e-9);
  assert.ok(Math.abs(P.latePenalty(T * 2, T) - 10) < 1e-9);
  assert.equal(P.latePenalty(T * 5, T), P.SERVICE_MAX);
  assert.equal(P.latePenalty(9999, 0), 0);
  // and it lands in the verdict, in minutes, in words
  const v = P.verdict(mkResult({ total: 92 }), { service: { elapsed: 1200, target: 720, penalty: P.latePenalty(1200, 720) } });
  assert.ok(kinds(v).includes('service'), kinds(v).join(','));
  assert.ok(/twenty minutes/.test(v.complaints.find((c) => c.kind === 'service').text), v.quote);
  assert.equal(P.spellMinutes(1200), 'twenty');
  assert.equal(P.spellMinutes(1500), 'twenty-five');
  // late costs them the tip even though the burger itself was fine
  assert.ok(v.tip < P.verdict(mkResult({ total: 92 })).tip, 'a late plate tips worse');
});

test('a lukewarm plate is tipped like a worse one', () => {
  const hot = P.verdict(mkResult({ total: 92 }));
  const cool = P.verdict(mkResult({ total: 92, serveT: 34 }));   // peaked at 55.5, went out at 34
  assert.equal(cool.temperature.penalty, 10);
  assert.ok(cool.tip < hot.tip * 0.85, `${cool.tip} vs ${hot.tip}`);
  assert.ok(cool.served < cool.score);
});

test('the same plate always says the same thing, and different plates do not all say the same thing', () => {
  const a = P.verdict(mkResult({ id: 2, total: 71, waterRetained: 0.6 }));
  const b = P.verdict(mkResult({ id: 2, total: 71, waterRetained: 0.6 }));
  assert.equal(a.quote, b.quote);
  const said = new Set();
  for (let i = 1; i <= 12; i++) said.add(P.verdict(mkResult({ id: i, total: 70 + (i % 5), waterRetained: 0.6 })).quote);
  assert.ok(said.size >= 3, `only ${said.size} phrasings across twelve plates`);
});

test('the README recipe delights the customer and earns the top tip', () => {
  const r = recipe('medium-rare', 18, 47);
  assert.equal(r.total, 100);
  const v = P.verdict(r, { service: { elapsed: 700, target: P.ticketTargetTime(['medium-rare']), penalty: 0 } });
  assert.equal(v.outcome, 'delighted');
  assert.equal(v.complaints.length, 0, JSON.stringify(v.complaints));
  assert.equal(v.crust.state, 'proper');
  assert.equal(v.juiciness.state, 'juicy');
  assert.ok(Math.abs(v.tip - 0.25) < 1e-9);
  assert.ok(Math.abs(v.tipAmount - 3.5) < 0.01, `$${v.tipAmount}`);
});

test('verdict: the build as `buildOf` returns it — the kitchen\'s send-back line, its praise, and its mild faults', () => {
  // a raw egg white is −5 on the ticket: the customer sends the plate back and names it
  const rawEgg = P.verdict(mkResult({ total: 100, build: { items: [{ kind: 'egg', label: 'Egg', state: 'raw white', score: -5 }], penalty: 5, bonus: 0 } }));
  assert.equal(rawEgg.outcome, 'sent back');
  assert.equal(rawEgg.build.ok, false);
  assert.ok(/egg/.test(rawEgg.quote), rawEgg.quote);
  // limp bacon is −3: the kitchen calls that a send-back too, and so does the table
  const limp = P.verdict(mkResult({ total: 95, build: { items: [{ kind: 'bacon', label: 'Bacon', state: 'limp', score: -3 }], penalty: 3, bonus: 0 } }));
  assert.equal(limp.outcome, 'sent back');
  assert.ok(/bacon/.test(limp.quote) && /limp/.test(limp.quote), limp.quote);
  // an over-toasted bun (−1) is a remark, not a send-back
  const dark = P.verdict(mkResult({ total: 95, build: { items: [{ kind: 'bun', label: 'Bottom bun', state: 'over-toasted', score: -1 }], penalty: 1, bonus: 0 } }));
  assert.equal(dark.outcome, 'delighted');
  assert.ok(kinds(dark).includes('build'), kinds(dark).join(','));
  // and crisp bacon, a jammy yolk or a toasted heel are praised
  const good = P.verdict(mkResult({ total: 96, build: { items: [{ kind: 'bacon', label: 'Bacon', state: 'crisp', score: 2 }, { kind: 'egg', label: 'Egg', state: 'jammy yolk', score: 2.5 }], penalty: 0, bonus: 4.5 } }));
  assert.equal(good.outcome, 'delighted');
  assert.equal(good.build.ok, true);
  assert.equal(good.praise.filter((g) => g.kind === 'build').length, 2, JSON.stringify(good.praise));
  // no toppings at all is neither
  const bare = P.verdict(mkResult({ total: 96, build: { items: [], penalty: 0, bonus: 0 } }));
  assert.equal(bare.build.items.length, 0);
});

test('verdict: creosote is tasted, clean wood smoke is praised, and a slit from a peek is noticed', () => {
  const tar = P.verdict(mkResult({ total: 80, grilled: true, waterRetained: 0.6, smokiness: 0.9, creosote: 0.6, smokeWood: 'hickory' }));
  assert.ok(kinds(tar).includes('smoke'), kinds(tar).join(','));
  assert.ok(/tar|bonfire|sooty/i.test(tar.quote), tar.quote);
  const clean = P.verdict(mkResult({ total: 96, grilled: true, waterRetained: 0.6, smokiness: 0.9, creosote: 0.05, smokeWood: 'hickory' }));
  assert.ok(!kinds(clean).includes('smoke'));
  assert.ok(clean.praise.some((g) => /smoke/i.test(g.text)), JSON.stringify(clean.praise));
  const peeked = P.verdict(mkResult({ total: 94, peeks: 1 }));
  assert.ok(peeked.complaints.some((c) => c.kind === 'structure' && /knife|cut/i.test(c.text)), JSON.stringify(peeked.complaints));
  assert.equal(P.verdict(mkResult({ total: 94, peeks: 0 })).complaints.some((c) => /knife|cut/i.test(c.text)), false);
});

test('a real egg that went out with a raw white sends the whole plate back through evaluateTicket', () => {
  const s = panAt(200, 8);
  const p = std({ thicknessMm: 14 }); P.placePatty(s, p, { x: 0.06, y: 0 });
  let since = 0; while (P.centerT(p) < 56) { hold(s, 200); P.step(s, DT); since += DT; if (since >= 45 && !p.faceDown.stuck) { P.flipPatty(s, p); since = 0; } }
  P.removePatty(s, p);
  // the egg goes in as the patty comes off and is pulled after twenty seconds: white still clear
  const [egg] = P.addItem(s, 'egg'); cookItem(s, 20, 200); P.removeItem(s, egg); P.assignTopping(s, egg, p);
  cookFor(s, 150); P.serve(s);
  const tk = P.evaluateTicket(s);
  assert.equal(tk.results[0].build.items[0].state, 'raw white');
  const v = P.verdict(tk.results[0], tk);
  assert.equal(v.outcome, 'sent back', JSON.stringify(v.build));
  assert.equal(v.build.items[0].name, 'egg');
  assert.ok(/egg/.test(v.quote), v.quote);
  assert.equal(v.tipAmount, 0);
});

// ---------------------------------------------------------------- kettle paths: cheese, pressing,
// brushing, swapping the stove mid-ticket, and a three-burger ticket over the coals
test('cheese on the grate: the overhang sags through the bars onto the coals and flares, and the lid is what melts it', () => {
  const s = litGrill(9, 700); cookFor(s, 120);
  const p = std({ thicknessMm: 16, massG: 150 }); P.placePatty(s, p);
  cookFor(s, 60); P.flipPatty(s); cookFor(s, 20);
  P.addCheese(s);
  const ch = p.cheeses[0];
  let peakFlare = 0; for (let i = 0; i < 8000; i++) { P.step(s, DT); peakFlare = Math.max(peakFlare, s.grill.flare); }
  assert.ok(ch.dripped > 0.002, `only ${(ch.dripped * 1000).toFixed(2)} g of cheese went through the bars`);
  assert.ok(ch.mass < 0.018, `slice should have lost mass: ${(ch.mass * 1000).toFixed(1)} g`);
  assert.ok(s.grill.cheeseOnCoals > 0.002, `cheese on the coals ${s.grill.cheeseOnCoals}`);
  assert.ok(peakFlare > 0.3, `a gob of cheese on a 700 °C bed should light: peak flare ${peakFlare.toFixed(2)}`);
  assert.ok(!ch.skirt || ch.skirt.mass < 1e-5, 'there is no pan to fry a skirt against');
  assert.ok(s.events.some((e) => /sagging through the bars/.test(e.text)));
  assert.ok(finite(p) && P.pattyFinite(p));
  // the same patty over a bare bed: no cheese, no gobs, no flames worth the name
  const bare = litGrill(9, 700); cookFor(bare, 120);
  const pb = std({ thicknessMm: 16, massG: 150 }); P.placePatty(bare, pb);
  cookFor(bare, 60); P.flipPatty(bare); cookFor(bare, 20);
  let bareFlare = 0; for (let i = 0; i < 8000; i++) { P.step(bare, DT); bareFlare = Math.max(bareFlare, bare.grill.flare); }
  assert.ok(peakFlare > bareFlare * 3, `cheese flare ${peakFlare.toFixed(2)} vs bare ${bareFlare.toFixed(2)}`);
  // and the lid: dome radiation and hot air melt a slice in well under a minute, open sky does not
  const melted = (lid) => {
    const g = litGrill(7, 600); cookFor(g, 240);
    const q = std({ thicknessMm: 16, massG: 150 }); P.placePatty(g, q);
    cookFor(g, 60); P.flipPatty(g); cookFor(g, 30);
    P.addCheese(g); if (lid) P.toggleLid(g);
    cookFor(g, 40); return q.cheeses[0];
  };
  const open = melted(false), under = melted(true);
  assert.ok(under.melt > open.melt + 0.15, `melt after 40 s: lid ${under.melt.toFixed(2)} vs open ${open.melt.toFixed(2)}`);
  assert.ok(under.T > open.T + 3, `cheese temperature: lid ${under.T.toFixed(0)} vs open ${open.T.toFixed(0)}`);
});

test('a cheeseburger flipped over the coals lays the cheese on the bars, not in a pan', () => {
  const s = litGrill(7, 600); cookFor(s, 240);
  const p = std({ thicknessMm: 14, massG: 120 }); P.placePatty(s, p);
  cookFor(s, 60); P.flipPatty(s); P.addCheese(s); cookFor(s, 40); P.flipPatty(s);
  assert.equal(p.cheeseUnder.length, 1);
  cookFor(s, 60);
  const ch = p.cheeseUnder[0];
  // the fire heats it through the bars and the gaps; it boils dry and browns like a frico
  assert.ok(Number.isFinite(ch.T) && ch.T > 90, `cheese against the bars: ${ch.T} °C`);
  assert.ok(ch.skirt.dry > 0.3, `dry=${ch.skirt.dry}`);
  assert.ok(finite(p) && P.pattyFinite(p));
  assert.equal(s.guard.restores, 0, 'the grate path should not need the instability guard');
  assert.equal(s.pan.oil, 0, 'there is no pan for the fat to pool in');
  const bits = s.pan.cheeseBits; P.flipPatty(s);
  assert.ok(s.pan.cheeseBits > bits, 'what welded stays on the bars until it is brushed off');
});

test('pressing on the grate sends the juice and the fat straight down onto the coals, and there is nothing to smash against', () => {
  const s = litGrill(9, 650); cookFor(s, 150);
  const p = std({ thicknessMm: 20, massG: 160, fatFrac: 0.3 }); P.placePatty(s, p);
  cookFor(s, 120); P.flipPatty(s); cookFor(s, 60);
  const h0 = p.h, D0 = p.D, drip0 = p.lostWaterDrip, fat0 = s.grill.fatOnCoals, flare0 = s.grill.flare;
  P.pressPatty(s, true); // a smash on bars is just a press
  assert.ok(Math.abs(p.h - h0) < 1e-4 && Math.abs(p.D - D0) < 1e-4, `grate smash reshaped the patty: ${h0} → ${p.h}`);
  assert.ok(p.lostWaterDrip > drip0 + 0.0005, `juice out ${(p.lostWaterDrip - drip0) * 1000} g`);
  assert.ok(s.grill.fatOnCoals > fat0, 'the fat lands on the fire');
  assert.equal(s.pan.water, 0); assert.equal(s.pan.oil, 0); // there is no pan to catch any of it
  assert.equal(p.dome, 0);
  assert.ok(s.events.some((e) => /nothing to smash it against/.test(e.text)));
  cookFor(s, 3); P.pressPatty(s, false); cookFor(s, 2); // the way people lean on it, twice
  assert.ok(s.grill.flare > flare0 + 0.3, `pressing a 70/30 over a hot bed should flare: ${flare0.toFixed(2)} → ${s.grill.flare.toFixed(2)}`);
  assert.ok(finite(p));
});

test('a dirty grate gets brushed, not washed: the residue comes off and the bars stay hot', () => {
  const s = litGrill(8, 600); cookFor(s, 240);
  const p = std({ thicknessMm: 14, massG: 120 }); P.placePatty(s, p);
  cookFor(s, 20); P.flipPatty(s); P.addCheese(s); cookFor(s, 60); P.flipPatty(s); cookFor(s, 120); P.flipPatty(s);
  assert.equal(P.washPan(s), false, 'cannot brush with the meat on the bars');
  P.removePatty(s);
  const dirt = P.panDirt(s.pan);
  assert.ok(dirt > 0.002, `grate dirt=${dirt}`);
  const T = s.pan.T;
  assert.equal(P.washPan(s), true);
  assert.ok(P.panDirt(s.pan) < dirt * 0.1, `dirt after brushing ${P.panDirt(s.pan)}`);
  assert.ok(s.pan.T > T - 5, `a wire brush does not cool the bars: ${T} → ${s.pan.T}`);
  assert.equal(s.pan.water, 0, 'a brush is not a tap');
  assert.ok(/Brushed the grate/.test(s.events[s.events.length - 1].text), s.events[s.events.length - 1].text);
  // the same button on a stove is a wash: it cools the pan and leaves it wet
  const pan = P.createState({}); preheat(pan, 200);
  assert.equal(P.washPan(pan), true);
  assert.ok(pan.pan.T < 100 && pan.pan.water > 0, `washed pan: ${pan.pan.T} °C, ${pan.pan.water} kg of water`);
  assert.ok(/Washed the pan/.test(pan.events[pan.events.length - 1].text), pan.events[pan.events.length - 1].text);
});

test('swapping stove and kettle mid-ticket, before anything is placed, is a cold start that leaves the patties alone', () => {
  // what the game does when the stove is changed with nothing in the pan: a brand new world
  const pan = P.createState({ pan: 'castiron', stove: 'gas' }); preheat(pan, 220); P.addFat(pan, 'canola', 8);
  const patties = [std({ thicknessMm: 18 }), std({ thicknessMm: 14 })]; // formed, still on the board
  const kettle = P.createState({ stove: 'charcoal' });
  assert.ok(kettle.grill && kettle.pan.id === 'grate' && kettle.pan.barFrac > 0);
  assert.equal(kettle.stove.knob, 0); assert.equal(kettle.pan.oil, 0);
  assert.ok(kettle.pan.T < 25 && kettle.grill.Tfire < 25 && !kettle.grill.lit, 'a kettle you have just wheeled out is cold');
  for (const p of patties) { assert.equal(p.where, 'board'); assert.equal(p.cookTime, 0); assert.ok(Math.abs(P.pattyMass(p) - 0.15) < 1e-9); }
  // the grate is wider than the pan, so the same three spots sit further apart
  const R = Math.max(...patties.map((p) => p.D / 2));
  assert.ok(kettle.pan.floorR > pan.pan.floorR, `grate ${kettle.pan.floorR} vs pan ${pan.pan.floorR}`);
  assert.ok(P.pattySpots(2, kettle.pan.floorR, R)[1].x >= P.pattySpots(2, pan.pan.floorR, R)[1].x);
  // the patties cook on the new stove exactly as if they had been formed for it
  P.setKnob(kettle, 8); let g = 0; while ((kettle.grill.Tfire < 600 || kettle.pan.T < 250) && g++ < 60000) P.step(kettle, DT);
  P.placePatty(kettle, patties[0]); cookFor(kettle, 60);
  assert.ok(patties[0].grilled && patties[0].faceDown.marks > 0, 'it is on the grate now, bars and all');
  assert.ok(finite(patties[0]));
  // and swapping back is a cold pan again, however hot the last one was
  const back = P.createState({ pan: 'castiron', stove: 'gas' });
  assert.ok(!back.grill && back.pan.T < 25 && back.pan.id === 'castiron');
});

test('three burgers on the kettle: each one pulls the bars under it down, and each is scored on its own', () => {
  const s = litGrill(7, 600); cookFor(s, 240);
  const ps = [std({ id: 1, target: 'medium-rare', thicknessMm: 18 }), std({ id: 2, target: 'medium', thicknessMm: 14 }), std({ id: 3, target: 'well-done', thicknessMm: 14 })];
  const spots = P.pattySpots(3, s.pan.floorR, Math.max(...ps.map((p) => p.D / 2)));
  const before = Array.from(s.pan.Tr);
  ps.forEach((p, i) => P.placePatty(s, p, spots[i]));
  cookFor(s, 45);
  // the patties sit around r ≈ 6 cm, which is rings 2–4 of the twelve; the outer bars are untouched
  const under = Math.min(s.pan.Tr[2], s.pan.Tr[3]), outer = s.pan.Tr[s.pan.Np - 1];
  assert.ok(under < before[3] - 30, `bars under the meat ${under.toFixed(0)} vs ${before[3].toFixed(0)} before`);
  assert.ok(outer > under + 25, `the rim of the grate should still be hot: ${outer.toFixed(0)} vs ${under.toFixed(0)}`);
  const pulls = { 1: 47, 2: 56, 3: 68 };
  let since = 0, guard = 0;
  while (ps.some((p) => p.where === 'pan') && guard++ < 60000) {
    P.step(s, DT); since += DT;
    if (since >= 45) { since = 0; for (const p of ps) if (p.where === 'pan' && !p.faceDown.stuck) P.flipPatty(s, p); }
    for (const p of ps) if (p.where === 'pan' && P.centerT(p) >= pulls[p.id]) P.removePatty(s, p);
  }
  cookFor(s, 150); P.serve(s);
  const tk = P.evaluateTicket(s);
  assert.equal(tk.results.length, 3);
  for (const r of tk.results) {
    assert.equal(r.dist, 0, `patty ${r.id} wanted ${r.target.id}, peaked at ${r.peak.toFixed(1)}`);
    assert.ok(r.patty.grilled && r.faces.down.marks > 0.5, `patty ${r.id} should carry bar marks`);
    assert.ok(P.pattyFinite(r.patty));
  }
  assert.ok(ps[2].cookTime > ps[0].cookTime, 'the well-done takes longest');
  assert.ok(tk.total >= 85, `three off one kettle: ${tk.total} (${tk.results.map((r) => r.total).join('+')})`);
  assert.equal(s.guard.restores, 0);
});

// ---------------------------------------------------------------- the instability guard
test('the instability guard: a pathological patty stays finite, and a poisoned cell is rolled back', () => {
  // 3 mm of meat, 0.1 s steps (four times what the game uses) over a 600 °C bed
  const s = litGrill(10, 600);
  const p = std({ thicknessMm: 3, massG: 150 });
  P.placePatty(s, p);
  for (let i = 0; i < 400; i++) P.step(s, 0.1);
  assert.ok(P.pattyFinite(p) && finite(p), 'the pathological cook itself should stay finite');
  assert.ok(Number.isFinite(s.pan.T) && Number.isFinite(P.centerT(p)));
  // now force it: NaN in a temperature, an infinite mass, NaN in a reaction extent
  const T0 = Float64Array.from(p.T), restores = s.guard.restores;
  p.T[3] = NaN; p.w[7] = Infinity; p.dM[11] = NaN;
  P.step(s, 0.1);
  assert.ok(P.pattyFinite(p), 'the guard should have restored the arrays');
  assert.ok(s.guard.restores > restores, `restores ${s.guard.restores}`);
  assert.ok(s.events.some((e) => /instability/i.test(e.text)));
  let drift = 0; for (let i = 0; i < p.T.length; i++) drift = Math.max(drift, Math.abs(p.T[i] - T0[i]));
  assert.ok(drift < 5, `a rollback should cost one step of cooking, not the cook: drift ${drift.toFixed(2)} K`);
  // and it keeps cooking afterwards
  const c0 = P.centerT(p);
  for (let i = 0; i < 200; i++) P.step(s, 0.1);
  assert.ok(P.pattyFinite(p) && P.centerT(p) > c0, `centre ${c0.toFixed(1)} → ${P.centerT(p).toFixed(1)}`);
  // the metal is guarded the same way: a poisoned ring is rolled back, not spread over the kitchen
  const panRestores = s.guard.panRestores;
  s.pan.Tr[4] = NaN;
  P.step(s, DT);
  assert.ok(Number.isFinite(s.pan.T) && Number.isFinite(s.pan.Tcenter) && s.pan.T > 20, `pan T=${s.pan.T}`);
  assert.ok(s.guard.panRestores > panRestores);
  assert.ok(P.pattyFinite(p));
  // a healthy cook never touches any of this
  const clean = P.createState({}); preheat(clean, 230);
  const q = std(); P.placePatty(clean, q); cookHeld(clean, 120, 230); P.flipPatty(clean); cookHeld(clean, 120, 230);
  assert.equal(clean.guard.restores, 0, 'the guard should never fire on an ordinary cook');
});

test('the guard\'s last resort leaves a patty that keeps cooking, cheese included', () => {
  // The sanitiser runs when there is no snapshot to go back to — the step right after a flip threw
  // it away. It used to write 0 into w0c, the *reference* water the cell was formed with, and every
  // dryness in the model is a ratio against that: the next step divided 0/0, the grid went NaN, the
  // rollback had nothing good to restore, and the patty sat there for the rest of the cook while
  // pattyFinite cheerfully said it was fine. The reference has to come back as the formed value.
  const s = P.createState({}); preheat(s, 230);
  const p = std(); P.placePatty(s, p); cookHeld(s, 60, 230);
  P.flipPatty(s, p); // invalidates the snapshot
  const w0 = p.w0c[5], c0 = P.centerT(p);
  p.w0c[5] = NaN; p.w[5] = NaN;
  for (let i = 0; i < 1600; i++) { hold(s, 230); P.step(s, DT); } // forty seconds of cooking after the poison
  assert.ok(P.pattyFinite(p) && finite(p));
  assert.ok(Math.abs(p.w0c[5] - w0) < 1e-9, `the formed reference should be back, not zero: ${p.w0c[5]}`);
  assert.ok(P.centerT(p) > c0 + 3, `and the patty goes on cooking: ${c0.toFixed(2)} → ${P.centerT(p).toFixed(2)} °C`);
  assert.ok(Number.isFinite(P.firmness(p).index), 'a finger on it still reads a number');
  assert.ok(s.guard.restores <= 3, `one bad step, not four hundred: ${s.guard.restores} restores`);
  // and the slices are part of the patty: a non-finite one is invisible to a snapshot of the grid
  const s2 = P.createState({}); preheat(s2, 230);
  const q = std(); P.placePatty(s2, q); cookHeld(s2, 60, 230);
  P.addCheese(s2, q); cookHeld(s2, 60, 230); P.flipPatty(s2, q); cookHeld(s2, 20, 230);
  assert.equal(q.cheeseUnder.length, 1);
  const cq0 = P.centerT(q);
  q.cheeseUnder[0].T = NaN;
  assert.equal(P.pattyFinite(q), false, 'a NaN slice is not a finite patty');
  for (let i = 0; i < 400; i++) { hold(s2, 230); P.step(s2, DT); }
  assert.ok(Number.isFinite(q.cheeseUnder[0].T) && q.cheeseUnder[0].T > 20, `the slice is put back on the meat: ${q.cheeseUnder[0].T}`);
  assert.ok(P.pattyFinite(q) && P.centerT(q) > cq0 + 0.5, `and the cook continues: ${cq0.toFixed(2)} → ${P.centerT(q).toFixed(2)} °C`);
  assert.ok(s2.guard.restores <= 3, `${s2.guard.restores} restores`);
});

// ---------------------------------------------------------------- what the integration playthrough turned up
test('the hand test reads a pan on a pan\'s scale: twenty seconds over 200 °C is "about right", eight is a 300 °C pan', () => {
  // the same count means different metal over a fire and over a pan: eight seconds is "medium" on
  // the grill chart and a pan past every oil's smoke point
  assert.equal(P.handWord(8, true), 'medium'); assert.equal(P.handWord(8, false), 'searing');
  assert.equal(P.handWord(2, true), 'searing'); assert.equal(P.handWord(20, false), 'medium');
  // cast iron preheated on gas, so with the hot centre a real pan has; the recipe temperature
  const s = P.createState({ pan: 'castiron', stove: 'gas' }); preheat(s, 200);
  const ok = P.handTestAt(s, null);
  console.log(`   200 °C pan: ${ok.seconds.toFixed(1)} s, ${ok.word} — ${s.events[s.events.length - 1].text}`);
  assert.ok(ok.seconds > 15 && ok.seconds < 30, `about twenty seconds over a 200 °C pan: ${ok.seconds.toFixed(1)}`);
  assert.equal(ok.word, 'medium');
  assert.ok(/about right under a patty/.test(s.events[s.events.length - 1].text), 'the note says it is the temperature to cook on');
  // and the pan that the old "six to eight seconds" advice actually produced
  preheat(s, 330);
  const hot = P.handTestAt(s, null);
  console.log(`   330 °C pan: ${hot.seconds.toFixed(1)} s, ${hot.word} — ${s.events[s.events.length - 1].text}`);
  assert.ok(hot.seconds < 9, `under nine seconds over 330 °C: ${hot.seconds.toFixed(1)}`);
  assert.ok(hot.word === 'searing' || hot.word === 'very hot', hot.word);
  assert.ok(/smoke point|char/.test(s.events[s.events.length - 1].text), 'the note warns that this is a burnt crust');
  // a pan that is 200 °C edge to edge (no hot spot) still reads as the temperature to cook on
  const flat = P.createState({}); flat.pan.T = 200; flat.pan.Tr.fill(200);
  assert.equal(P.handTest(flat, null).word, 'medium');
  // over coals the words are the grill chart, unchanged
  const g = litGrill(10, 700); cookFor(g, 300);
  assert.equal(P.handTest(g).word, 'searing');
});

test('the grey-band note and the evenness mark draw the same line', () => {
  // the README's medium: it scores 10/10 for evenness, so it must not also be told it has a wide grey band
  const r = recipe('medium', 14, 56);
  assert.equal(r.parts.evenness, 10, JSON.stringify(r.parts));
  assert.ok(!r.notes.some((n) => /wide grey band/.test(n)), r.notes.join(' / '));
  // a thick medium-rare given one long flip a side is grey most of the way through, and is told so
  const bad = recipe('medium-rare', 26, 46, { single: 240 });
  console.log(`   single-flip 26 mm: evenness ${bad.parts.evenness}, ${(bad.overFrac * 100).toFixed(0)} % past the line`);
  assert.equal(bad.notes.some((n) => /wide grey band/.test(n)), bad.parts.evenness < 10, `note and mark disagree: ${bad.parts.evenness} ${bad.notes.join(' / ')}`);
});

test('the customer knows the onions are plural', () => {
  const burnt = P.verdict(mkResult({ total: 100, build: { items: [{ kind: 'onions', label: 'Sliced onions', state: 'burnt', score: -4 }], penalty: 4, bonus: 0 } }));
  assert.equal(burnt.outcome, 'sent back');
  assert.ok(/onions are burnt|onions are black/.test(burnt.quote), burnt.quote);
  assert.ok(!/onions is/.test(burnt.quote), burnt.quote);
  const egg = P.verdict(mkResult({ total: 100, build: { items: [{ kind: 'egg', label: 'Egg', state: 'burnt', score: -4 }], penalty: 4, bonus: 0 } }));
  assert.ok(/egg is burnt|egg is black/.test(egg.quote), egg.quote);
  const mush = P.verdict(mkResult({ total: 95, build: { items: [{ kind: 'onions', label: 'Sliced onions', state: 'soggy', score: -1 }], penalty: 1, bonus: 0 } }));
  assert.ok(mush.complaints.some((c) => /onions (have gone to mush|are soggy)/.test(c.text)), JSON.stringify(mush.complaints));
});

test('flipping turns the peak-temperature record over with the meat', () => {
  // the grey band is judged on each cell's hottest moment; after a flip that record must still sit on the cell it belongs to
  const s = P.createState({}); preheat(s, 230); const p = std({ thicknessMm: 20 }); P.placePatty(s, p); cookFor(s, 150);
  const bot = p.Tpk[0], top = p.Tpk[(p.Nz - 1) * p.Nr];
  assert.ok(bot > top + 20, `the seared face should hold the record: bottom ${bot.toFixed(0)} vs top ${top.toFixed(0)}`);
  P.flipPatty(s);
  assert.equal(p.Tpk[(p.Nz - 1) * p.Nr], bot); assert.equal(p.Tpk[0], top);
});

test('a scraped raw face welds itself back on when the blade comes out; a set one stays free', () => {
  // scrape a raw patty at 5 s: the blade frees it for the second it is under it, then raw protein
  // on hot steel welds again; scrape one whose crust has set and it stays free
  const s = P.createState({ pan: 'stainless' }); preheat(s, 220); P.addFat(s, 'canola', 6);
  const p = std({ thicknessMm: 18 }); P.placePatty(s, p); cookHeld(s, 5, 220);
  assert.ok(p.faceDown.stuck, 'raw meat on stainless is welded');
  P.scrape(s, p); assert.ok(!p.faceDown.stuck, 'free while the blade is under it');
  cookHeld(s, 4, 220);
  assert.ok(p.faceDown.stuck, 'back on the metal and raw, it is welded again');
  cookHeld(s, 120, 220);
  P.scrape(s, p); cookHeld(s, 4, 220);
  assert.ok(!p.faceDown.stuck, 'once the crust has set the scraped face stays free');
});

test('a hand over the meat reads the meat, not the metal hidden under it', () => {
  const s = P.createState({}); preheat(s, 250);
  const bare = P.handTest(s, { x: 0, y: 0 });
  const p = std({ thicknessMm: 20 }); P.placePatty(s, p, { x: 0, y: 0 }); cookHeld(s, 60, 250);
  const overMeat = P.handTest(s, { x: 0, y: 0 });
  assert.ok(overMeat.seconds > bare.seconds * 1.5, `over a 20 mm patty the hand lasts longer than over bare 250 °C iron: ${overMeat.seconds.toFixed(1)} vs ${bare.seconds.toFixed(1)} s`);
  const beside = P.handTest(s, { x: 0.11, y: 0 });
  assert.ok(beside.seconds < overMeat.seconds, 'beside the patty the metal is in view again');
});

// ---------------------------------------------------------------- the runner over this file
// `npm test` deals these tests out to workers by name. Everything it can see it runs; anything it
// cannot see it silently does not — so the scan that reads this file is worth a test of its own.
test('the runner sees every test in this file, whatever the indentation, and refuses a name it cannot match', () => {
  const runner = require('./run.js');
  const src = fs.readFileSync(__filename, 'utf8');
  const names = runner.testNames(src);
  // two independent scans: if they ever disagree, the name scan has stopped seeing a declaration,
  // which is the one failure the runner cannot notice on its own — a test it never deals out is a
  // test it never misses, and the shard still adds up
  assert.equal(names.length, runner.countTests(src), `the runner reads ${names.length} names out of ${runner.countTests(src)} declarations`);
  assert.ok(names.includes('patty geometry: 150 g at 20 mm is a ~10 cm patty'), 'the first test in the file');
  assert.ok(names.includes('the README recipe scores 100 on every ticket'), 'the one that must never break');
  // flat, indented, in a block, `.only`, and a name with an escaped quote in it: all still tests.
  // `test` is spelled out below so this fixture is not counted as a declaration in this file.
  const T = 'test';
  const sample = [`${T}('flat', () => {});`, `  ${T}('indented', () => {});`, `\t${T}.only(\`inside a loop\`, () => {});`, `  ${T}("say \\"ah\\"", () => {});`].join('\n');
  assert.deepEqual(runner.testNames(sample), ['flat', 'indented', 'inside a loop', 'say "ah"']);
  assert.equal(runner.countTests(sample), 4);
  // one tucked onto a line with other code is not read — and is not lost either: the two scans
  // disagree, which is what makes the runner refuse the run instead of dealing out a suite with a
  // hole in it
  const hidden = `${sample}\nif (x) { ${T}('tucked away', () => {}); }`;
  assert.equal(runner.testNames(hidden).length, 4);
  assert.equal(runner.countTests(hidden), 5);
  // a name only known at run time can never be matched by --test-name-pattern, so it is refused
  // out loud instead of being dealt to nobody
  assert.throws(() => runner.testNames(`${T}(\`per wood: \${wood}\`, () => {});`), /template/);
});

test('the shard timeout is a cap on the worker, which is what run.js and the README say it is', () => {
  // `npm test` gives each worker `--test-timeout`, and the number is documented as the budget for
  // that worker's whole shard rather than for one test. This is why: node applies the option to the
  // test that wraps the file, and it cannot interrupt a synchronous test at all. If a node upgrade
  // ever changes either half of that, this fails and the docs get another look.
  const os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'griddle-timeout-'));
  const T = 'test';  // spelled out so test/run.js's scan of this file does not count the fixtures
  // NODE_TEST_CONTEXT has to go: a child that thinks it is already inside a test run refuses to
  // run any files ("run() is being called recursively") and hands back an empty report
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = (name, body, args) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return spawnSync(process.execPath, ['--test', ...args, '--test-reporter=spec', file], { encoding: 'utf8', env });
  };
  // three tests of 120 ms under a 300 ms cap: every test is well inside it, the file is not
  const each = run('each.test.js', `const { ${T} } = require('node:test');\nconst sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n`
    + [1, 2, 3].map((n) => `${T}('t${n}', async () => { await sleep(120); });`).join('\n'), ['--test-timeout=300']);
  assert.match(each.stdout, /✔ t1/, each.stdout);
  assert.match(each.stdout, /cancelled 1/, `the file itself is what times out, not a test:\n${each.stdout}`);
  assert.match(each.stdout, /each\.test\.js.*timed out/s, each.stdout);
  // and a synchronous test cannot be cancelled by its own timeout: the timer never gets a turn
  const spin = run('spin.test.js', `const { ${T} } = require('node:test');\n${T}('spin', { timeout: 100 }, () => { const t0 = Date.now(); while (Date.now() - t0 < 400); });\n`, []);
  assert.match(spin.stdout, /✔ spin/, spin.stdout);
  assert.match(spin.stdout, /cancelled 0/, `a 400 ms synchronous test under a 100 ms timeout still passes:\n${spin.stdout}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
