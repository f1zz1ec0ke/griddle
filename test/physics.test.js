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
