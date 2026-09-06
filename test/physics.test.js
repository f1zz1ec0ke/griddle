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
  assert.ok(b.lostFat / b.m0 > 0.30, `only ${(b.lostFat / b.m0 * 100).toFixed(0)} % of the strip's mass came out as fat`);
  assert.ok(b.lostFat / b.fat0 > 0.8, `only ${(b.lostFat / b.fat0 * 100).toFixed(0)} % of its fat rendered`);
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
  // turned over, the yolk is a millimetre off the metal and goes jammy in a minute
  const over = panAt(160, 8); const [ev] = P.addItem(over, 'egg');
  cookItem(over, 60, 160); P.flipItem(over, ev); cookItem(over, 35, 160);
  assert.equal(P.itemState(ev).state, 'jammy yolk');
  cookItem(over, 60, 160);
  assert.equal(P.itemState(ev).state, 'hard yolk');
  // the lace at the rim browns in the fat
  assert.ok(eo.lace.brown > 1.2, `lace=${eo.lace.brown}`);
  // and a raw white is a send-back
  const raw = panAt(160, 8); const [er] = P.addItem(raw, 'egg'); cookItem(raw, 20, 160);
  assert.equal(P.itemState(er).state, 'raw white');
  assert.ok(P.itemState(er).score <= -5);
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
  const hot = P.itemT(egg);
  cookItem(s, 300, 210);
  assert.ok(P.itemT(egg) < hot - 20, `off the heat it should cool: ${hot} → ${P.itemT(egg)}`);
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
  assert.ok(after > s.diag.panQ * 0.5 && after > 100, `and the heat comes back once it is down: ${after.toFixed(0)} W`);
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
