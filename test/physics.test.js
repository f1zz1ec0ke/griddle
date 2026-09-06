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
