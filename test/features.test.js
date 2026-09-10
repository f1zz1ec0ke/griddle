'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/physics');
const S = require('../js/session');
const { kitchen } = require('./game-harness');
function cook(stove = 'gas') {
  const s = P.createState({ stove, pan: 'castiron' });
  const p = P.makePatty({ id: 1, target: 'medium', massG: 150, thicknessMm: 20, fatFrac: 0.2, tempC: 4 });
  P.placePatty(s, p, { x: 0, y: 0 }); P.setKnob(s, 8);
  return { s, p };
}
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
  assert.equal(updateArgs[1], 0); assert.equal(updateArgs[2], 0.05);
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
