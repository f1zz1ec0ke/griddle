// node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/physics.js');
const DT = 0.025;

function preheat(s, target) { P.setKnob(s, 8); let g = 0; while (s.pan.T < target && g++ < 80000) P.step(s, DT); return s.t; }
function cookFor(s, seconds) { const until = s.t + seconds; while (s.t < until) P.step(s, DT); }
function hold(s, T) { P.setKnob(s, P.clamp(s.stove.knob + (T - s.pan.T) * 0.02, 0, 10)); }
function cookHeld(s, seconds, T) { const until = s.t + seconds; while (s.t < until) { hold(s, T); P.step(s, DT); } }
function std(over) { return P.makePatty({ massG: 150, thicknessMm: 20, fatFrac: 0.2, tempC: 4, dimple: true, work: 0.4, salt: 'surface', ...over }); }
function finite(p) { for (const k of ['T', 'w', 'fs', 'fl', 'fr', 'p', 'dM', 'dA', 'dC', 'dG']) for (const v of p[k]) if (!Number.isFinite(v)) return false; return true; }

test('patty geometry: 150 g at 20 mm is a ~10 cm patty', () => {
  const p = std();
  assert.ok(p.D > 0.09 && p.D < 0.11, `D=${p.D}`);
  assert.ok(p.N >= 10 && p.N <= 80);
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
  while (P.centerT(p) < 66) { cookHeld(s, 30, 220); P.flipPatty(s); }
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
  const plan = [['rare', 18, 41], ['medium-rare', 18, 46], ['medium', 14, 54], ['medium-well', 14, 61], ['well-done', 14, 67]];
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
});
