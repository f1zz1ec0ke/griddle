'use strict';
// Small DOM/renderer boundary for testing the real game state machine without WebGL.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const P = require('../js/physics');
const Session = require('../js/session');
function kitchen(storage = new Map()) {
  const elements = new Map(), all = [], listeners = new Map();
  const context2d = new Proxy({}, { get: () => () => {} });
  const classes = () => { const set = new Set(); return { add: x => set.add(x), remove: x => set.delete(x), toggle: (x, on) => on ? set.add(x) : set.delete(x), contains: x => set.has(x) }; };
  let document;
  function element(id, tag = 'DIV', attrs = '') {
    const el = { id, tagName: tag.toUpperCase(), dataset: {}, value: '', textContent: '', innerHTML: '', hidden: /\bhidden\b/.test(attrs), checked: /\bchecked\b/.test(attrs), disabled: false, classList: classes(), style: {}, isConnected: true,
      addEventListener(name, fn) { this.events ||= {}; this.events[name] = fn; },
      setAttribute(k, v) { this[k] = v; }, removeAttribute(k) { delete this[k]; }, hasAttribute(k) { return this[k] != null; },
      focus() { document.activeElement = this; }, contains(o) { return o === this; },
      querySelector() { return { scrollTop: 0 }; }, querySelectorAll() { return []; },
      getContext() { return context2d; }, click() { if (!this.disabled && this.onclick) this.onclick(); },
      width: 420, height: 160, offsetHeight: 100,
    };
    for (const [, k, v] of attrs.matchAll(/data-([\w-]+)="([^"]*)"/g)) el.dataset[k] = v;
    const value = attrs.match(/\bvalue="([^"]*)"/); if (value) el.value = value[1];
    if (id) elements.set(id, el); all.push(el); return el;
  }
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  for (const [, tag, attrs] of html.matchAll(/<([\w-]+)\b([^>]*)>/g)) {
    const id = attrs.match(/\bid="([^"]+)"/);
    if (id || /data-phase=|data-speed=|data-view=/.test(attrs)) element(id && id[1], tag, attrs);
  }
  document = {
    activeElement: null, body: { dataset: {}, classList: classes() }, documentElement: { style: { setProperty() {} } },
    getElementById: id => elements.get(id), addEventListener() {},
    querySelectorAll: selector => selector === 'input[id], select[id]' ? all.filter(e => ['INPUT', 'SELECT'].includes(e.tagName) && e.id)
      : all.filter(e => selector === '[data-phase]' ? e.dataset.phase != null : selector === '[data-speed]' ? e.dataset.speed != null : selector === '[data-view]' ? e.dataset.view != null : false),
  };
  class Viewport {
    constructor() { this.controls = { preset() {} }; }
    setMode(mode) { this.mode = mode; } setStove() {} setPan() {} clearStains() {} setPatty() {} setProbe() {} update() {} peekCutaway() {}
    setCutaway(v) { this.cutaway = v; }
  }
  class Audio { click() {} hiss() {} update() {} start() {} toggle() { return false; } }
  const root = { BurgerPhysics: P, GriddleSession: Session, BurgerRender: { Viewport, nodeColour: () => [0, 0, 0] }, KitchenAudio: Audio,
    addEventListener(name, fn) { listeners.set(name, fn); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/game.js'), 'utf8'), {
    window: root, document, performance, requestAnimationFrame() {}, localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
  });
  listeners.get('DOMContentLoaded')();
  return { game: root.game, elements, document, listeners, storage, P };
}
module.exports = { kitchen };
