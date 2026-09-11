'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/physics');
const A = require('../js/assembly');
const S = require('../js/session');
const { kitchen } = require('./game-harness');
function cook(stove = 'gas') {
  const s = P.createState({ stove, pan: 'castiron' });
  const p = P.makePatty({ id: 1, target: 'medium', massG: 150, thicknessMm: 20, fatFrac: 0.2, tempC: 4 });
  P.placePatty(s, p, { x: 0, y: 0 }); P.setKnob(s, 8);
  return { s, p };
}

test('pan IR reads the centre while Inspector retains mean and edge temperatures', () => {
  const { game: g, elements: e } = kitchen();
  g.startPractice(); g.startCook(); P.setKnob(g.state, 8); g.fastForward(157);
  e.get('inspector').hidden = false;
  const time = g.state.t;
  g.updateHUD();
  const pan = g.state.pan;
  assert.ok(pan.Tcenter - pan.T > 30, 'preheated pan should have a meaningful temperature gradient');
  assert.ok(Math.abs(parseFloat(e.get('h-pan').textContent) - pan.Tcenter) < 1.3);
  assert.equal(e.get('h-pan-label').textContent, 'IR gun · pan centre');
  assert.ok(e.get('insp-table').innerHTML.includes(pan.T.toFixed(1) + ' °C mean'));
  assert.ok(e.get('insp-table').innerHTML.includes('edge ' + pan.Tedge.toFixed(0)));
  g.hard = true; g.updateHUD(); assert.equal(e.get('h-pan').textContent, '—');
  assert.equal(g.state.t, time, 'reading the display must not advance physics');
  g.hard = false; g.state = P.createState({ stove: 'charcoal' });
  g.state.pan.T = 150; g.state.pan.Tcenter = 250; g.updateHUD();
  assert.equal(e.get('h-pan-label').textContent, 'IR gun · grate');
  assert.ok(Math.abs(parseFloat(e.get('h-pan').textContent) - 150) < 1.3);
  g.state.grill.bank = 1; g.state.grill.Thot = 300; g.state.grill.Tcool = 120; g.updateHUD();
  assert.equal(e.get('h-pan').textContent, '300 / 120 °C');
  assert.equal(e.get('h-pan-label').textContent, 'IR gun · hot / cool');
});
test('reheating preserves the patty grid, face damage and peak history', () => {
  const { s, p } = cook();
  for (let i = 0; i < 100; i++) P.step(s, 0.05);
  P.removePatty(s, p); const grid = Array.from(p.T), peak = p.peakCenter, cookTime = p.cookTime;
  p.restT = 120; p.faceDown.torn = 0.4;
  P.placePatty(s, p, { x: 0.03, y: 0 });
  assert.equal(p.where, 'pan'); assert.equal(p.restT, 0); assert.equal(s.patties.length, 1);
  assert.deepEqual(Array.from(p.T), grid); assert.equal(p.peakCenter, peak); assert.equal(p.faceDown.torn, 0.4);
  P.step(s, 0.05); assert.ok(p.cookTime > cookTime);
});
test('discarded bun pair cannot leak into the build; replacements have new IDs', () => {
  const { s, p } = cook(); const pair = P.addItem(s, 'bun');
  const oldIds = pair.map(x => x.id);
  P.assignTopping(s, pair[1], p);
  assert.equal(pair[0].burger, p.id);
  assert.equal(P.discardItem(s, pair[0]), true); assert.equal(s.items.length, 0); assert.equal(s.item, null);
  const fresh = P.addItem(s, 'bun');
  assert.ok(fresh.every(x => !oldIds.includes(x.id)));
  P.removeItem(s, fresh[0]); const face = fresh[0].cutFace; face.char = 0.5;
  assert.equal(P.reheatItem(s, fresh[0]), true); assert.equal(fresh[0].cutFace, face); assert.equal(face.char, 0.5);
});
test('missing requested builds send back an otherwise complete plate; assignment is per burger', () => {
  const { s, p } = cook(); p.requiredBuild = ['bun', 'cheese', 'bacon'];
  const q = P.makePatty({ id: 2, target: 'medium', massG: 150, thicknessMm: 20, fatFrac: 0.2, tempC: 4 }); P.placePatty(s, q, { x: 0.06, y: 0 });
  const buns = P.addItem(s, 'bun'); P.assignTopping(s, buns[0], q);
  const bacon = P.addItem(s, 'bacon')[0]; P.assignTopping(s, bacon, p);
  P.addCheese(s, p);
  for (const it of s.items) P.removeItem(s, it);
  P.removePatty(s, p); P.removePatty(s, q); P.serve(s);
  const r = P.evaluateTicket(s).results[0];
  assert.deepEqual(r.build.missing, ['bun']);
  // Isolate build enforcement from doneness/quality for this verdict.
  const v = P.verdict({ ...r, total: 100, dist: 0, peak: 61, build: { items: [], missing: ['bun'] } });
  assert.equal(v.outcome, 'sent back'); assert.ok(v.complaints.some(c => /missing/i.test(c.text)));
});
test('cold simultaneous burgers are not praised as hot', () => {
  const { s, p } = cook(); P.removePatty(s, p);
  const q = P.makePatty({ id: 2, target: 'medium', massG: 150, thicknessMm: 20, fatFrac: 0.2, tempC: 4 }); P.placePatty(s, q); P.removePatty(s, q); P.serve(s);
  assert.ok(!P.evaluateTicket(s).notes.some(n => n.includes('still hot')));
});
for (const stove of ['gas', 'charcoal']) {
  test(`saved ${stove} physics continues identically with shared references intact`, () => {
    const { s, p } = cook(stove);
    P.addCheese(s, p); const buns = P.addItem(s, 'bun'); P.flipItem(s, buns[0]); P.flipPatty(s, p);
    for (let i = 0; i < 100; i++) P.step(s, 0.05);
    const copy = S.decode(S.encode(s)); copy.stove.profile = P.STOVES[copy.stove.id].profile;
    assert.equal(copy.patty, copy.patties[0]); assert.equal(copy.items[0].cutFace, copy.items[0].faceUp);
    assert.ok(copy.patty.T instanceof Float64Array);
    for (let i = 0; i < 40; i++) { P.step(s, 0.05); P.step(copy, 0.05); }
    assert.deepEqual(Array.from(copy.patty.T), Array.from(s.patty.T));
    assert.equal(copy.pan.T, s.pan.T); assert.equal(copy.items[0].body.T, s.items[0].body.T);
  });
}
test('malformed and future saves are rejected', () => {
  assert.throws(() => S.decode('{'));
  assert.throws(() => S.decode('{"version":2,"nodes":[]}'));
  assert.throws(() => S.decode('{"version":1,"nodes":[{"type":"Object","values":[["__proto__",{}]]}],"root":{"ref":0}}'));
  assert.throws(() => S.validate({}, P));
});
test('probe resets visibly and practice never starts a service timer', () => {
  const { game: g, elements: e } = kitchen();
  e.get('probe-depth').value = '10'; e.get('probe-depth-v').textContent = '10 %';
  g.startPractice(); g.startCook();
  assert.equal(g.probe.depth, 0.5); assert.equal(Number(e.get('probe-depth').value), 50);
  assert.equal(e.get('probe-depth-v').textContent, '50 %'); assert.equal(g.ticketTiming, false); assert.equal(e.get('ticket-clock').hidden, true);
  g.place(); g.remove(); assert.equal(g.phase, 'cook'); g.reheat(); assert.equal(g.patty.where, 'pan');
  g.addPracticePatty(); g.startCook(); assert.equal(g.patties.length, 2); assert.notEqual(g.patties[0].id, g.patties[1].id);
  assert.equal(g.state.patty, g.patties[1]);
  g.clearPractice(); assert.equal(g.patties.length, 0); g.addPracticePatty(); g.startCook(); assert.equal(g.patties.length, 1);
  assert.equal(g.shift.n, 0);
});
test('help blocks shortcuts, closes on Escape, and Tab retains native navigation', () => {
  const { game: g, elements: e, listeners } = kitchen(); g.startPractice(); g.startCook(); g.place();
  const key = listeners.get('keydown'); let prevented = false, stopped = false;
  key({ key: 'Tab', target: e.get('btn-bun'), preventDefault() { prevented = true; } }); assert.equal(prevented, false);
  g.openHelp(); const t = g.state.t, flips = g.patty.flips;
  key({ key: 'f', target: e.get('btn-help-close'), stopImmediatePropagation() { stopped = true; } });
  g.fastForward(3); assert.equal(stopped, true); assert.equal(g.state.t, t); assert.equal(g.patty.flips, flips);
  key({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} }); assert.equal(g.stopped, false);
  g.setPaused(true); g.fastForward(3); assert.equal(g.state.t, t);
});

test('paused frames freeze cooking while allowing the camera to ease into position', () => {
  const { game: g } = kitchen(); g.startPractice(); g.startCook(); g.place(); g.setPaused(true);
  let updateArgs; g.vp.update = (...args) => { updateArgs = args; };
  const time = g.state.t, ticketClock = g.ticketClock;
  g.frame(g.last + 50);
  assert.equal(g.state.t, time); assert.equal(g.ticketClock, ticketClock);
  assert.equal(updateArgs[1], 0); assert.ok(Math.abs(updateArgs[2] - 0.05) < 1e-12);
});
test('full practice session reload restores paused and service saves use a separate slot', () => {
  const { game: g, storage, elements: e } = kitchen();
  g.setPhase('form'); g.ticketTiming = true; g.startCook(); g.place(); assert.equal(g.saveSession(), true);
  const service = storage.get('griddle.session.v1.service');
  g.startPractice(); g.startCook(); g.place(); P.addItem(g.state, 'egg'); g.fastForward(5); g.probe.depth = 0.1;
  assert.equal(g.saveSession(), true); assert.equal(storage.get('griddle.session.v1.service'), service);
  const restored = kitchen(storage).game; assert.equal(restored.loadSession('practice'), true);
  assert.equal(restored.mode, 'practice'); assert.equal(restored.paused, true); assert.equal(restored.state.t, g.state.t);
  assert.equal(restored.state.patty, restored.patties[0]); assert.equal(restored.state.items.length, 1); assert.equal(restored.probe.depth, 0.1);
  restored.setPaused(false); restored.fastForward(1); assert.ok(restored.state.t > g.state.t);
  const before = restored.state; storage.set('griddle.session.v1.practice', 'broken');
  assert.equal(restored.loadSession(), false); assert.equal(restored.state, before);
  assert.equal(e.get('save-status').textContent, 'Saved — safe to close');
});

test('service saves resume through forming, resting, results and the end of a shift', () => {
  let { game: g, elements: e, storage } = kitchen();
  e.get('btn-accept').click(); g.forms[0].thicknessMm = 25;
  assert.equal(g.saveSession(), true);
  g = kitchen(storage).game; assert.equal(g.loadSession(), true);
  assert.equal(g.phase, 'form'); assert.equal(g.forms[0].thicknessMm, 25);
  g.setPaused(false); g.startCook(); g.place(); g.fastForward(2); g.remove();
  assert.equal(g.phase, 'rest'); assert.equal(g.saveSession(), true);
  let fresh = kitchen(storage); g = fresh.game; e = fresh.elements;
  assert.equal(e.get('btn-service-load').hidden, false); e.get('btn-service-load').click();
  assert.equal(g.phase, 'rest'); assert.equal(g.vp.mode, 'stove');
  g.setPaused(false); g.reheat(); assert.equal(g.patty.where, 'pan'); g.remove();
  e.get('btn-cut').click(); assert.equal(g.phase, 'result'); assert.equal(g.shift.n, 1);
  const points = g.shift.points; assert.equal(g.saveSession(), true);
  fresh = kitchen(storage); g = fresh.game; e = fresh.elements;
  assert.equal(g.loadSession(), true); assert.equal(g.phase, 'result');
  assert.equal(g.shift.n, 1); assert.equal(g.shift.points, points);
  g.setPaused(false);
  while (g.shift.n < 6) {
    e.get('btn-again').click(); e.get('btn-accept').click(); g.startCook();
    for (let i = 0; i < g.patties.length; i++) { g.select(i); g.place(); g.remove(); }
    e.get('btn-cut').click();
  }
  e.get('btn-again').click(); assert.equal(g.shownShiftEnd, true);
  assert.equal(g.saveSession(), true);
  fresh = kitchen(storage); assert.equal(fresh.game.loadSession(), true);
  assert.equal(fresh.game.shift.n, 6); assert.equal(fresh.elements.get('shiftend').hidden, false);
});

test('storage failures keep the last save and malformed equipment cannot replace the kitchen', () => {
  const storage = new Map(), { game: g, elements } = kitchen(storage);
  g.startPractice(); g.startCook(); g.place(); assert.equal(g.saveSession(), true);
  const key = 'griddle.session.v1.practice', saved = storage.get(key), set = storage.set;
  storage.set = () => { throw new Error('QuotaExceededError'); };
  assert.equal(g.saveSession(), false); assert.equal(storage.get(key), saved);
  assert.match(elements.get('save-status').textContent, /Could not save/);
  storage.set = set;
  const corrupt = S.decode(saved); corrupt.equip = null; storage.set(key, S.encode(corrupt));
  const current = g.state; assert.equal(g.loadSession(), false); assert.equal(g.state, current);
});

test('a complete requested build has no missing ingredients after reheating and replacement', () => {
  const { s, p } = cook(); p.requiredBuild = ['bun', 'bacon', 'cheese'];
  const burnt = P.addItem(s, 'bacon')[0]; burnt.faceDown.char = 1;
  P.assignTopping(s, burnt, p); P.discardItem(s, burnt);
  const bacon = P.addItem(s, 'bacon')[0], buns = P.addItem(s, 'bun');
  P.assignTopping(s, bacon, p); P.assignTopping(s, buns[0], p); P.addCheese(s, p);
  P.removeItem(s, bacon); P.reheatItem(s, bacon);
  for (const it of s.items) P.removeItem(s, it);
  P.removePatty(s, p); P.serve(s);
  const r = P.evaluateTicket(s).results[0];
  assert.deepEqual(r.build.missing, []);
  assert.equal(r.build.items.filter(it => it.kind === 'bacon').length, 1);
  assert.equal(s.items.includes(burnt), false);
});


test('onions show sweating before browning and retain softening after cooling', () => {
  const s = P.createState({stove: 'gas', pan: 'castiron'});
  P.setKnob(s, 6);
  for (let i = 0; i < 6000; i++) P.step(s, .05);
  const it = P.addItem(s, 'onions')[0];
  for (let i = 0; i < 2400; i++) P.step(s, .05);
  assert.equal(P.itemState(it).state, 'sweating');
  assert.ok(it.soft > 0.01 && it.carm < .35);
  for (let i = 0; i < 4800; i++) P.step(s, .05);
  assert.ok(it.carm > .35, 'the same onions should go on to brown');
  P.removeItem(s, it); const soft = it.soft;
  for (let i = 0; i < 200; i++) P.step(s, .05);
  assert.ok(it.soft >= soft, 'cooling must not make onions raw again');
});

test('oven preheats independently and finishes the existing meat grid', () => {
  const {s, p} = cook(); P.setKnob(s, 0); P.setOven(s, 180);
  for (let i = 0; i < 6000; i++) P.step(s, .05);
  assert.ok(s.oven.T > 160 && s.pan.T < 30);
  p.faceDown.brown = 2; p.faceDown.brownR.fill(2); const face = p.faceDown, grid = p.T;
  assert.equal(P.putInOven(s, p), true);
  const start = P.centerT(p), time = p.cookTime;
  for (let i = 0; i < 6000; i++) P.step(s, .05);
  assert.ok(P.centerT(p) > start + 15);
  assert.equal(p.T, grid); assert.equal(p.faceDown, face); assert.ok(face.brown >= 2);
  assert.ok(p.cookTime > time); assert.equal(p.restT, 0);
  assert.equal(s.guard.restores, 0); assert.ok(Array.from(p.T).every(Number.isFinite));
  P.serve(s, p); assert.equal(p.where, 'oven', 'cannot serve a burger still in the oven');
  P.takeFromOven(s, p); assert.equal(p.where, 'rest');
  P.putInOven(s, p); P.placePatty(s, p); assert.equal(p.where, 'pan');
  assert.equal(s.patties.length, 1); assert.equal(p.T, grid);
  P.setOven(s, 0); const hot = s.oven.T; P.step(s, 1); assert.ok(s.oven.T < hot);
});

test('oven burger keeps a service cooking, survives paused save and returns to the pan', () => {
  const {game:g, elements:e, storage} = kitchen();
  g.startCook(); g.place(); P.setOven(g.state, 180);
  e.get('btn-oven').click();
  assert.equal(g.patty.where, 'oven'); assert.equal(g.phase, 'cook');
  assert.equal(g.maybeRest(), false); assert.equal(e.get('btn-cut').disabled, true);
  assert.equal(g.cameraPreset, 'oven');
  g.fastForward(5); assert.equal(g.saveSession(), true);
  const {game:r, elements:re} = kitchen(storage);
  assert.equal(r.loadSession('service'), true); assert.equal(r.paused, true);
  assert.equal(r.patty.where, 'oven'); assert.equal(r.state.oven.target, 180);
  const temp = r.state.oven.T; r.fastForward(5); assert.equal(r.state.oven.T, temp);
  r.setPaused(false); g.fastForward(.5); r.fastForward(.5);
  assert.deepEqual(Array.from(r.patty.T), Array.from(g.patty.T), 'oven simulation resumes identically');
  assert.equal(r.state.oven.T, g.state.oven.T);
  re.get('btn-remove').click();
  assert.equal(r.patty.where, 'rest'); assert.equal(r.phase, 'rest');
  re.get('btn-oven').click(); assert.equal(r.patty.where, 'oven');
  re.get('btn-reheat').click(); assert.equal(r.patty.where, 'pan');
  assert.equal(r.phase, 'cook');
});

test('two burgers can finish in the oven while toppings cook on the pan', () => {
  const {s,p} = cook();
  const q = P.makePatty({id:2, target:'medium', massG:150, thicknessMm:20, fatFrac:.2, tempC:4});
  P.placePatty(s,q); P.putInOven(s,p); P.putInOven(s,q);
  P.setOven(s,180); const it = P.addItem(s,'onions')[0];
  P.step(s,.05);
  assert.equal(it.where,'pan'); assert.equal(p.where,'oven'); assert.equal(q.where,'oven');
  P.takeFromOven(s,p); assert.equal(q.where,'oven');
});


test('flip animation arcs around the centre, freezes on pause and lands without drift', () => {
  const fs = require('node:fs'), vm = require('node:vm'), THREE = require('../js/vendor/three.min.js');
  const root = {THREE, BurgerPhysics:P};
  vm.runInNewContext(fs.readFileSync(require.resolve('../js/render3d.js'),'utf8'), {window:root});
  const {p} = cook();
  const view = {p, group:new THREE.Group(), vp:{panFloorY:.01}, lastFlips:0, flipElapsed:null, texClock:0,
    rebuildGeometry(){}, texDirty(){return false;}, texCommit(){}, paintTextures(){}, updateCheese(){}};
  const update = dt => root.BurgerRender.PattyView.prototype.update.call(view, {}, dt, 'pan', {x:.03,z:.04}, 'stove');
  p.flips=1; update(0);
  assert.equal(view.group.rotation.z,-Math.PI);
  update(.325); assert.ok(view.group.position.y > .09);
  const pos=view.group.position.clone(), angle=view.group.rotation.z;
  update(0); assert.deepEqual(view.group.position,pos); assert.equal(view.group.rotation.z,angle);
  update(.325); update(0);
  assert.equal(view.group.rotation.z,0); assert.equal(view.flipElapsed,null);
  assert.deepEqual(view.group.position.toArray(),[.03,.01,.04]);
  assert.equal(p.flips,1,'rendering must not change the simulated flip count');
});


test('practice can cut and inspect a rested burger without recording service, then cook again', () => {
  const {game:g, elements:e, storage} = kitchen();
  g.startPractice(); g.startCook();
  assert.equal(e.get('btn-cut').disabled, true, 'unplaced food cannot be served');
  g.place(); assert.equal(e.get('btn-cut').disabled, true);
  P.setOven(g.state, 180); e.get('btn-oven').click();
  assert.equal(e.get('btn-cut').disabled, true, 'take food out of the oven first');
  e.get('btn-remove').click();
  const onion = P.addItem(g.state, 'onions')[0]; g.refreshButtons();
  assert.equal(e.get('btn-cut').disabled, true, 'lift toppings too');
  P.removeItem(g.state,onion); g.refreshButtons();
  assert.equal(e.get('btn-cut').hidden, false); assert.equal(e.get('btn-cut').disabled, false);
  const shift = JSON.stringify(g.shift); e.get('btn-cut').click();
  assert.equal(g.phase,'result'); assert.equal(g.patty.where,'cut');
  assert.equal(g.vp.cutaway,true); assert.equal(JSON.stringify(g.shift),shift);
  assert.equal(e.get('r-mode').textContent,'Practice cook');
  assert.equal(e.get('r-score-wrap').hidden,true); assert.equal(e.get('r-customer').hidden,true);
  assert.equal(e.get('r-breakdown').hidden,true); assert.equal(e.get('r-details').open,true);
  assert.match(e.get('r-stats').innerHTML,/Peak centre temperature/);
  assert.doesNotMatch(e.get('r-stats').innerHTML,/Ordered|Grey band/);
  assert.doesNotMatch(e.get('r-verdict').textContent,/asked|wanted/);
  assert.equal(g.saveSession(),true);
  const {game:r,elements:re} = kitchen(storage);
  assert.equal(r.loadSession('practice'),true); assert.equal(r.phase,'result');
  assert.equal(r.vp.cutaway,true); assert.equal(re.get('r-score-wrap').hidden,true);
  r.setPaused(false); const oven=r.state.oven, pan=r.state.pan;
  re.get('btn-again').click();
  assert.equal(r.mode,'practice'); assert.equal(r.phase,'form'); assert.equal(r.forms.length,1);
  assert.equal(r.state.oven,oven); assert.equal(r.state.pan,pan); assert.equal(r.vp.cutaway,false);
  assert.equal(r.ticketTiming,false); assert.equal(r.state.patties.length,0);
});

test('practice results let the cook inspect each burger independently', () => {
  const {game:g,elements:e} = kitchen();
  g.startPractice(); g.startCook(); g.place();
  g.addPracticePatty(); g.startCook(); g.place();
  for(const p of g.patties) P.removePatty(g.state,p);
  g.refreshButtons(); e.get('btn-cut').click();
  assert.equal(g.ticketResult.results.length,2); assert.equal(e.get('r-chips').hidden,false);
  assert.doesNotMatch(e.get('r-chips').innerHTML,/100|Ticket/);
  g.select(0); assert.equal(g.result.patty,g.patties[0]);
  g.select(1); assert.equal(g.result.patty,g.patties[1]);
});


test('temperature display converts values and ranges without changing the simulation', () => {
  const U = require('../js/units');
  assert.equal(U.text('100 °C',true),'212 °F');
  assert.equal(U.text('54–57 °C',true),'129–135 °F');
  assert.equal(U.text('54-57 °C',true),'129-135 °F');
  assert.equal(U.text('−18 °C',true),'0 °F');
  assert.equal(U.text('−20–−10 °C',true),'-4–14 °F');
  assert.equal(U.text('180 / 220 °C',true),'356 / 428 °F');
  assert.equal(U.text('10 °C cooler',true),'18 °F cooler');
  assert.equal(U.text('Off by 10 °C.',true),'Off by 18 °F.');
  assert.equal(U.text('10 °C past the top',true),'18 °F past the top');
  assert.equal(U.text('centre fell 10 °C from its peak',true),'centre fell 18 °F from its peak');
  const {game:g,elements:e,storage} = kitchen();
  g.startPractice(); g.startCook(); g.place(); P.setOven(g.state,180);
  const state = S.encode(g.state); e.get('btn-units').click();
  assert.equal(g.fahrenheit,true); assert.equal(S.encode(g.state),state);
  assert.match(e.get('h-pan').textContent,/°F/); assert.match(e.get('oven-status').textContent,/356 °F/);
  assert.equal(e.get('oven-temp').value,'180'); assert.equal(storage.get('griddle.temperatureUnit'),'F');
  g.hard=true; g.updateHUD(); assert.equal(e.get('h-pan').textContent,'—');
  assert.equal(g.maskT('Centre 60 °C'),'Centre ·· °F');
  const r=kitchen(storage).game; assert.equal(r.fahrenheit,true);
  e.get('btn-units').click(); assert.equal(g.fahrenheit,false);
});

test('two bun pairs and four portions of each other topping; discard releases the limit', () => {
  const {s,p} = cook();
  for(const kind of ['bun','bacon','egg','onions']) {
    const limit = kind === 'bun' ? 2 : 4;
    for(let i=0;i<limit;i++) assert.ok(P.addItem(s,kind).length);
    assert.deepEqual(P.addItem(s,kind),[]);
    const old=s.items.find(it=>it.kind===kind); P.discardItem(s,old);
    assert.ok(P.addItem(s,kind).length);
  }
  for(let i=0;i<4;i++) assert.equal(P.addCheese(s,p),true);
  P.flipPatty(s,p); assert.equal(P.addCheese(s,p),false);
  assert.equal(p.cheeses.length+p.cheeseUnder.length,4);
});

test('limit feedback escalates on repeated attempts and bun discard stays available', () => {
  const {game:g,elements:e} = kitchen(); g.startPractice(); g.startCook();
  e.get('btn-bun').click(); e.get('btn-bun').click();
  assert.equal(g.items.length,4);
  e.get('btn-bun').click();
  assert.equal(g.items.length,4); assert.equal(g.selItem.kind,'bun');
  assert.equal(e.get('btn-discard').disabled,false);
  assert.equal(e.get('btn-discard').textContent,'Discard both bun halves');
  g.limitWarning(10000); assert.equal(e.get('kitchen-notice').textContent,'Calm down!');
  g.limitWarning(10100); g.limitWarning(10200);
  assert.equal(e.get('kitchen-notice').textContent,'CALM DOWN FFS!');
  g.limitWarning(20000); assert.equal(e.get('kitchen-notice').textContent,'Calm down!');
  e.get('btn-discard').click(); assert.equal(g.items.length,2);
  e.get('btn-bun').click(); assert.equal(g.items.length,4);
});

test('camera follows selected food between pan, plate and oven without fighting manual views', () => {
  const {game:g,elements:e} = kitchen(); g.startPractice(); g.startCook(); g.place();
  g.followSelectedFood(); assert.equal(g.cameraPreset,'default');
  g.remove(); g.followSelectedFood(); assert.equal(g.cameraPreset,'serve');
  e.get('btn-bun').click(); g.followSelectedFood(); assert.equal(g.cameraPreset,'default');
  g.cameraPreset = null; g.followSelectedFood(); assert.equal(g.cameraPreset,null);
  const bun = g.selItem;
  P.removeItem(g.state,bun); g.followSelectedFood(); assert.equal(g.cameraPreset,'serve');
  g.reheat(); g.followSelectedFood(); assert.equal(g.cameraPreset,'default');
  g.select(0); g.followSelectedFood(); assert.equal(g.cameraPreset,'serve');
  P.putInOven(g.state,g.patty); g.followSelectedFood(); assert.equal(g.cameraPreset,'oven');
});

test('manual assembly consumes exact food, preserves layer order and frees loose bun capacity', () => {
  const {s,p} = cook(); P.removePatty(s,p); p.manualAssembly=true;
  const first=P.addItem(s,'bun'), second=P.addItem(s,'bun');
  for(const it of first.concat(second)) P.removeItem(s,it);
  assert.deepEqual(P.addItem(s,'bun'),[]);
  assert.equal(A.add(s,p,first[1].id),false,'cannot close before placing a patty');
  assert.ok(A.add(s,p,first[0].id)); assert.deepEqual(P.addItem(s,'bun'),[],'half-built pair still occupies a loose slot');
  assert.ok(A.add(s,p,'mayo')); assert.ok(A.add(s,p,'patty'));
  assert.equal(A.add(s,p,'patty'),false);
  assert.ok(A.add(s,p,'lettuce')); assert.ok(A.add(s,p,'tomato'));
  assert.equal(A.add(s,p,second[1].id),false,'a crown must match its heel');
  assert.ok(A.add(s,p,first[1].id)); assert.equal(A.add(s,p,'ketchup'),false);
  assert.equal(P.reheatItem(s,first[0]),false); assert.equal(P.putInOven(s,p),false);
  assert.equal(P.addItem(s,'bun').length,2,'assembled pair frees capacity for a third burger');
  p.requiredBuild=['bun','lettuce','tomato','mayo']; assert.deepEqual(P.buildOf(s,p).missing,[]);
  P.serve(s,p); assert.equal(first[0].where,'cut'); assert.equal(second[0].where,'rest','loose food is not silently assigned');
  assert.deepEqual(p.assembly.map(A.label),['Bottom bun','Mayo','Patty','Lettuce','Tomato','Top bun']);
});

test('unpacking restores cooked ingredients and excludes them from the build', () => {
  const {s,p}=cook(); P.removePatty(s,p); p.manualAssembly=true;
  const [b]=P.addItem(s,'bacon'); P.removeItem(s,b); b.faceDown.brown=3;
  A.add(s,p,'patty'); A.add(s,p,b.id); A.add(s,p,'mustard');
  assert.equal(A.add(s,p,'mustard'),false);
  A.unpack(p); assert.equal(b.burger,null); assert.equal(b.assembledTo,null);
  assert.equal(b.faceDown.brown,3); assert.equal(P.toppingsOf(s,p).length,0);
  assert.equal(P.reheatItem(s,b),true);
});

test('assembled practice saves retain shared food references and resume for serving', () => {
  const {game:g,elements:e,storage}=kitchen(); g.startPractice(); g.startCook(); g.place(); g.remove();
  const buns=P.addItem(g.state,'bun'); for(const it of buns) P.removeItem(g.state,it);
  g.buildLayer('item:'+buns[0].id); g.buildLayer('patty'); g.buildLayer('pickles'); g.buildLayer('item:'+buns[1].id);
  assert.equal(e.get('btn-cut').disabled,false); assert.equal(g.saveSession(),true);
  const {game:r,elements:re}=kitchen(storage); assert.equal(r.loadSession('practice'),true);
  assert.equal(r.patty.assembly[0].item,r.items[0]); assert.equal(r.items[0].assembledTo,r.patty.id);
  r.setPaused(false); re.get('btn-cut').click(); assert.equal(r.phase,'result');
  assert.ok(P.buildOf(r.state,r.patty).items.some(it=>it.kind==='pickles'));
});

test('service replacement preserves the order clock, other food, equipment and requested build', () => {
  const {game:g,elements:e}=kitchen(); e.get('btn-accept').click(); g.startCook(); g.place();
  const old=g.patty, request=old.requiredBuild.slice(); g.ticketClock=137; P.setKnob(g.state,7);
  const [b]=P.addItem(g.state,'bacon'); const pan=g.state.pan;
  e.get('btn-discard').click();
  assert.notEqual(g.patty,old); assert.equal(g.patty.id,old.id); assert.equal(g.patty.where,'board');
  assert.deepEqual(g.patty.requiredBuild,request); assert.equal(g.ticketClock,137); assert.equal(g.ticketTiming,true);
  assert.equal(g.state.pan,pan); assert.equal(g.state.stove.knob,7); assert.equal(g.items[0],b);
  assert.ok(!g.state.patties.includes(old)); assert.ok(g.state.wasteG>0);
  g.place(); assert.equal(g.patty.where,'pan');
});

test('three requested burgers can be built and served within the two loose-pair limit', () => {
  const s=P.createState({}), patties=[];
  for(let i=0;i<3;i++) {
    const p=P.makePatty({id:i+1,target:'medium',massG:150,thicknessMm:20,fatFrac:.2,tempC:4});
    p.manualAssembly=true; p.requiredBuild=['bun','pickles','mustard'];
    P.placePatty(s,p); P.removePatty(s,p); patties.push(p);
    const buns=P.addItem(s,'bun'); buns.forEach(it=>P.removeItem(s,it));
    for(const key of [buns[0].id,'mustard','patty','pickles',buns[1].id]) assert.equal(A.add(s,p,key),true);
  }
  P.serve(s);
  assert.equal(s.items.length,6);
  for(const p of patties) { assert.deepEqual(P.buildOf(s,p).missing,[]); assert.equal(P.toppingsOf(s,p).length,2); }
});

test('assembly validation rejects a saved ingredient shared by two stacks', () => {
  const {game:g}=kitchen(); g.startPractice(); g.startCook(); g.place(); g.remove();
  const buns=P.addItem(g.state,'bun'); buns.forEach(it=>P.removeItem(g.state,it));
  A.add(g.state,g.patty,buns[0].id); A.add(g.state,g.patty,'patty');
  g.addPracticePatty(); g.startCook(); g.place(); g.remove();
  g.patty.assembly=[{item:buns[0]},{patty:true}];
  assert.throws(()=>S.validate(g,P),/assembled food/);
});

test('the shared discard button follows the selected topping or practice patty', () => {
  const {game:g,elements:e} = kitchen(); g.startPractice(); g.startCook();
  for (const kind of ['bun','bacon','egg','onions']) {
    const made = P.addItem(g.state,kind); g.selectItem(made[0]);
    assert.equal(e.get('btn-discard').disabled,false);
    e.get('btn-discard').click();
    assert.ok(made.every(it => !g.items.includes(it)));
    assert.equal(g.patties.length,1,'discarding toppings preserves the burger');
  }
  g.select(0);
  assert.equal(e.get('btn-discard').textContent,'Discard patty');
  e.get('btn-discard').click(); assert.equal(g.patties.length,0);
});

test('window control is independent of food selection and restores with room smoke',()=>{
  const {game:g,elements:e,storage}=kitchen();g.startPractice();g.startCook();g.place();
  const p=g.state.patty,grid=Array.from(p.T);
  e.get('btn-window').click();assert.equal(g.state.room.windowOpen,true);assert.equal(e.get('btn-window').textContent,'Close window');
  assert.deepEqual(Array.from(p.T),grid);
  g.state.diag.smoke=1;for(let i=0;i<100;i++)P.stepRoom(g.state,.05);
  g.setPaused(true);const before={...g.state.room};g.frame(g.last+50);assert.deepEqual(g.state.room,before);
  assert.equal(g.saveSession(),true);const saved=S.decode(storage.get('griddle.session.v1.practice'));
  S.validate(saved,P);assert.deepEqual(saved.state.room,before);
  saved.state.room.upper=-1;assert.throws(()=>S.validate(saved,P),/room air/);
  e.get('btn-window').click();assert.equal(g.state.room.windowOpen,false);assert.equal(e.get('btn-window').textContent,'Open window');
});
