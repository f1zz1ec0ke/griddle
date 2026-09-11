'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Cues = require('../js/cues');
const food = id => ({ id, where: 'pan', faceDown: { brown: 0, char: 0 }, faceUp: { brown: 0, char: 0 } });

test('cooking cues expire in wall time and do not repeat an unchanged milestone', () => {
  const cues = new Cues(), p = food(1);
  p.faceDown.brown = 1.1;
  assert.equal(cues.update([p], 100)[0].title, 'Browning underneath');
  assert.equal(cues.update([p], 6099).length, 1);
  assert.equal(cues.update([p], 6100).length, 0);
  assert.equal(cues.update([p], 9000).length, 0);
  p.faceDown.brown = 2.6;
  assert.equal(cues.update([p], 9100)[0].title, 'Golden crust');
});
test('burning replaces browning immediately and ranks ahead of other food', () => {
  const cues = new Cues(), a = food(1), b = food(2);
  a.faceDown.brown = 1.1;
  cues.update([a,b], 0);
  a.faceDown.char = .26; b.faceDown.brown = 3;
  const active = cues.update([a,b], 10);
  assert.equal(active.length, 2);
  assert.equal(active[0].title, 'Bottom is burning');
  assert.equal(active[0].label, 'Patty 1');
});
test('flips track distinct faces and remove a now-inaccurate underside cue', () => {
  const cues = new Cues(), p = food(1);
  p.faceDown.brown = 2;
  cues.update([p], 0);
  [p.faceDown,p.faceUp] = [p.faceUp,p.faceDown];
  assert.equal(cues.update([p], 100).length, 0);
  p.faceDown.brown = 2;
  assert.equal(cues.update([p], 200).length, 1);
  [p.faceDown,p.faceUp] = [p.faceUp,p.faceDown];
  assert.equal(cues.update([p], 300).length, 0);
});
test('lifting, discarding and leaving the kitchen clear cues; new food can alert', () => {
  const cues = new Cues(), p = food(1);
  p.faceDown.char = .5;
  cues.update([p], 0); p.where = 'rest';
  assert.equal(cues.update([p], 10).length, 0);
  const bun = {...food(2), kind: 'bun', spec: {short:'Bun'}};
  bun.faceDown.brown = 2;
  assert.equal(cues.update([bun], 20)[0].label, 'Bun · 2');
  assert.equal(cues.update([], 30).length, 0);
  const replacement = food(1); replacement.faceDown.brown = 2;
  assert.equal(cues.update([replacement], 40).length, 1);
});
test('UI cues expose sensory labels, never temperatures, even in hard mode', () => {
  const {game, elements} = require('./game-harness').kitchen();
  game.startPractice(); elements.get('btn-to-stove').click(); game.hard = true;
  game.patties[0].where = 'pan'; game.patties[0].faceDown.char = .4;
  game.updateCues(100);
  assert.match(elements.get('cooking-cues').innerHTML, /Bottom is burning/);
  assert.doesNotMatch(elements.get('cooking-cues').innerHTML, /°|temperature/i);
  game.updateCues(6100);
  assert.equal(elements.get('cooking-cues').innerHTML, '');
});
test('station navigation resets on phase changes and retains pressed state', () => {
  const {game, elements} = require('./game-harness').kitchen();
  game.setStation('tools');
  assert.equal(elements.get('panel').dataset.station, 'tools');
  assert.equal(elements.get('station-tools')['aria-pressed'], 'true');
  game.setPhase('form');
  assert.equal(elements.get('panel').dataset.station, 'cook');
  assert.equal(elements.get('station-tools')['aria-pressed'], 'false');
});
test('restoring paused food does not replay old cues, but new milestones still appear', () => {
  const cues = new Cues(), p = food(1);
  p.faceDown.brown = 1.5;
  assert.equal(cues.update([p], 0, true).length, 0);
  assert.equal(cues.update([p], 100).length, 0);
  p.faceDown.char = .3;
  assert.equal(cues.update([p], 200)[0].title, 'Bottom is burning');
});
test('Help keyboard navigation includes topics and wraps only at its boundaries', () => {
  const {game, elements, document, listeners} = require('./game-harness').kitchen();
  const close = elements.get('btn-help-close'), last = {focus(){document.activeElement=this;}};
  elements.get('help').querySelectorAll = () => [close, last];
  game.openHelp();
  let prevented = false;
  const key = shiftKey => ({key:'Tab', shiftKey, preventDefault(){prevented=true;},stopImmediatePropagation(){}});
  listeners.get('keydown')(key(false));
  assert.equal(prevented,false);
  listeners.get('keydown')(key(true));
  assert.equal(document.activeElement,last);
  prevented = false;
  listeners.get('keydown')(key(false));
  assert.equal(document.activeElement,close);
  assert.equal(prevented,true);
});
