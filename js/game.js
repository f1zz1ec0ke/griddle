/*
 * game.js — phases, UI wiring and the simulation loop.
 *   order → form (build each patty) → cook (stove) → rest → result
 * A ticket is one to three burgers, each with its own doneness. All of them share the pan.
 */
(function (root) {
  'use strict';
  const P = root.BurgerPhysics;
  const $ = (id) => document.getElementById(id);
  const sum = (arr) => { let t = 0; for (const v of arr) t += v; return t; };
  const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(d));
  const DT = 0.025;
  const SHORT = { rare: 'Rare', 'medium-rare': 'MR', medium: 'Med', 'medium-well': 'MW', 'well-done': 'WD' };

  const TICKETS = [
    { who: 'Table 3', line: '“Rare. Like, actually rare. I will send it back.”', items: ['rare'] },
    { who: 'Table 7', line: '“Medium-rare, please, and a good crust on it.”', items: ['medium-rare'] },
    { who: 'The regular at the bar', line: '“Medium. Warm pink centre, not red, not grey.”', items: ['medium'] },
    { who: 'Table 12', line: '“Medium-well — just a hint of pink.”', items: ['medium-well'] },
    { who: 'A dad', line: '“Well done. No pink. Don\'t burn it though.”', items: ['well-done'] },
    { who: 'Table 9, two covers', line: '“One medium-rare, one well done — she doesn\'t trust pink. Together, please.”', items: ['medium-rare', 'well-done'] },
    { who: 'Two regulars', line: '“Both medium. Same time, same plate.”', items: ['medium', 'medium'] },
    { who: 'Date night', line: '“Rare for me, medium-well for him. Don\'t let mine sit while his cooks.”', items: ['rare', 'medium-well'] },
    { who: 'Birthday table', line: '“Three burgers: rare, medium, medium-well. All at once or not at all.”', items: ['rare', 'medium', 'medium-well'] },
    { who: 'Family of three', line: '“Medium-rare, medium-well, and a well-done for the kid. Hot, please.”', items: ['medium-rare', 'medium-well', 'well-done'] },
  ];
  const DEFAULT_FORM = { massG: 150, thicknessMm: 20, blend: '80/20', temp: 'fridge', work: 0.35, dimple: true, salt: 'surface' };

  class Game {
    constructor() {
      this.vp = new root.BurgerRender.Viewport($('view'));
      this.audio = new root.KitchenAudio();
      this.speed = 1; this.phase = 'order'; this.hard = false;
      this.probe = { inserted: false, depth: 0.5, reading: null, settle: 0 };
      this.forms = [{ ...DEFAULT_FORM, target: 'medium' }]; this.previews = []; this.sel = 0;
      this.patties = []; this.spots = [];
      this.equip = { stove: 'gas', pan: 'castiron', fat: 'canola', fatG: 8 };
      this.state = P.createState({ pan: this.equip.pan, stove: this.equip.stove });
      this.chipsHTML = '';
      this.bind();
      this.newOrder();
      this.last = performance.now(); this.acc = 0;
      requestAnimationFrame((t) => this.frame(t));
    }
    // ------------------------------------------------------------ orders & phases
    get form() { return this.forms[this.sel]; }
    /** The selected patty object (cook/rest/result phases). */
    get patty() { return this.patties[this.sel] || null; }
    label(id) { return P.DONENESS.find((d) => d.id === id).label; }
    newOrder(ticket) {
      this.ticket = ticket || TICKETS[Math.floor(Math.random() * TICKETS.length)];
      const items = this.ticket.items;
      this.forms = items.map((id) => ({ ...DEFAULT_FORM, target: id }));
      this.previews = []; this.patties = []; this.sel = 0; this.result = null; this.ticketResult = null;
      $('order-who').textContent = this.ticket.who;
      $('order-line').textContent = this.ticket.line;
      $('order-target').textContent = items.map((id) => this.label(id)).join(' + ').toUpperCase();
      $('order-range').textContent = items.map((id) => { const d = P.DONENESS.find((x) => x.id === id); return `${d.label} ${d.lo}–${d.hi} °C`; }).join(' · ') + ' at the centre after resting' + (items.length > 1 ? `. ${items.length} burgers, one pan, and they all have to land hot at the same time.` : '');
      $('ticket-target').textContent = items.map((id) => this.label(id)).join(' + ');
      const hint = items.map((id) => { const d = P.DONENESS.find((x) => x.id === id); return `${d.label}: ${d.lo}–${d.hi} °C`; }).join(' · ') + ' at the centre, measured at its peak after resting';
      $('ticket').dataset.hint = hint; $('ticket').title = hint;
      this.setPhase('order');
    }
    setPhase(ph) {
      this.phase = ph;
      document.body.dataset.phase = ph;
      for (const el of document.querySelectorAll('[data-phase]')) el.hidden = el.dataset.phase.split(' ').indexOf(ph) < 0;
      if (ph === 'form') { this.vp.setMode('board'); this.loadForm(); this.rebuildPreview(); }
      if (ph === 'cook') { this.vp.setMode('stove'); }
      if (ph === 'result') { this.showResults(); }
      this.refreshButtons(); this.updateChips();
    }
    // ------------------------------------------------------------ selection (one chip per patty)
    select(i) {
      if (i < 0 || i >= this.forms.length || i === this.sel) return;
      this.sel = i;
      if (this.phase === 'form') { this.loadForm(); this.rebuildPreview(); }
      else if (this.patty) {
        P.selectPatty(this.state, this.patty);
        this.probe.reading = null; this.probe.settle = 0;
        if (this.phase === 'result') { this.showPattyResult(); this.vp.controls.preset('serve'); }
      }
      this.refreshButtons(); this.updateChips();
    }
    updateChips() {
      const el = $('chips');
      const chips = this.forms.map((f, i) => {
        const p = this.patties[i];
        let status;
        if (this.phase === 'form') status = `${f.thicknessMm} mm · ${f.massG} g`;
        else if (this.phase === 'result') { const r = this.ticketResult && this.ticketResult.results.find((x) => x.patty === p); status = r ? `${r.total}/100` : '—'; }
        else if (!p || p.where === 'board') status = 'on the board';
        else if (p.where === 'pan') status = `in the pan ${P.fmtTime(p.cookTime)}`;
        else status = `resting ${P.fmtTime(p.restT || 0)}`;
        return `<button class="chip${i === this.sel ? ' on' : ''}" data-chip="${i}" title="Select patty ${i + 1} (Tab cycles)"><b>${i + 1}</b> ${SHORT[f.target]} <small>${status}</small></button>`;
      }).join('');
      if (chips !== this.chipsHTML) { el.innerHTML = chips; this.chipsHTML = chips; }
      el.hidden = this.phase === 'order' || this.forms.length < 2;
    }
    // ------------------------------------------------------------ forming
    loadForm() {
      const f = this.form;
      $('f-mass').value = f.massG; $('f-mass-v').textContent = `${f.massG} g`;
      $('f-thick').value = f.thicknessMm; $('f-thick-v').textContent = `${f.thicknessMm} mm`;
      $('f-work').value = Math.round(f.work * 100); $('f-work-v').textContent = String(Math.round(f.work * 100));
      $('f-blend').value = f.blend; $('f-temp').value = f.temp; $('f-salt').value = f.salt; $('f-dimple').checked = f.dimple;
      $('f-title').textContent = this.forms.length > 1 ? `1 · Form patty ${this.sel + 1} of ${this.forms.length} (${this.label(f.target).toLowerCase()})` : '1 · Form the patty';
      $('btn-copy').hidden = this.forms.length < 2;
    }
    makeFromForm(f, i) {
      const temp = { fridge: 4, room: 18, frozen: -18 }[f.temp];
      const blend = P.BLENDS.find((b) => b.id === f.blend);
      return P.makePatty({ id: i + 1, target: f.target, massG: f.massG, thicknessMm: f.thicknessMm, fatFrac: blend.fat, tempC: temp, dimple: f.dimple, work: f.work, salt: f.salt });
    }
    rebuildPreview() {
      const f = this.form;
      const p = this.makeFromForm(f, this.sel);
      this.previews[this.sel] = p; this.preview = p;
      $('f-diam').textContent = `${(p.D * 100).toFixed(1)} cm`;
      $('f-density').textContent = `${p.rho0.toFixed(0)} kg/m³ (${(p.voids * 100).toFixed(0)} % air)`;
      $('f-water').textContent = `${(sum(p.w0c) * 1000).toFixed(0)} g water · ${(sum(p.fat0c) * 1000).toFixed(0)} g fat · ${(sum(p.p) * 1000).toFixed(0)} g protein`;
      $('f-nodes').textContent = `${p.Nz} layers × ${p.Nr} rings (${(p.h0 / p.Nz * 1000).toFixed(2)} × ${(p.D0 / 2 / p.Nr * 1000).toFixed(1)} mm cells)`;
      const alpha = 0.45 / (p.rho0 * 3300);
      const tHalf = ((p.h0 / 2) ** 2) / alpha;
      $('f-time').textContent = `~${(tHalf / 60 * 0.6).toFixed(0)}–${(tHalf / 60 * 0.9).toFixed(0)} min total (thermal diffusion estimate)`;
      const d = P.DONENESS.find((x) => x.id === f.target);
      $('f-warn').textContent = f.temp === 'frozen' ? 'Frozen: the outside will be well done before the middle thaws.' : f.thicknessMm < 10 ? 'This thin, it is a smash patty. There will be no pink centre whatever you do.' : f.thicknessMm > 32 ? 'Very thick: expect a wide grey band unless you flip often and keep the pan moderate.' : (d.hi < 60 && f.thicknessMm < 15) ? `Thin for a ${d.label.toLowerCase()}: the centre will race past ${d.hi} °C before a crust forms.` : (d.lo >= 65 && f.thicknessMm > 22) ? `Thick for a ${d.label.toLowerCase()}: a long cook, and a wide grey band before the centre gets there.` : '';
      const board = this.stateForPreview || (this.stateForPreview = P.createState({}));
      board.patty = p; board.where = 'board';
      this.vp.setPatty(p);
      this.updateChips();
    }
    startCook() {
      // The stove persists between tickets: same pan and burner means the pan keeps its heat,
      // fat, fond and the spatter on the stovetop. A different pan is a cold pan.
      const st = this.state;
      const reuse = this.stoveUsed && st && st.pan.id === this.equip.pan && st.stove.id === this.equip.stove;
      if (reuse) {
        st.patties = []; st.patty = null; st.where = 'board'; st.rest.t = 0; st.lid = false; st.baste = 0; st.served = false;
        st.trace = []; st.lastTrace = -1; st.events = [];
        const keep = {}; for (const k of ['preheat150', 'leiden', 'oilsmoke', 'ptfe']) if (st._ms && st._ms[k]) keep[k] = true; st._ms = keep;
        $('knob').value = st.stove.knob; $('knob-v').textContent = String(st.stove.knob);
      } else {
        this.state = P.createState({ pan: this.equip.pan, stove: this.equip.stove });
        this.vp.setStove(this.equip.stove); this.vp.setPan(this.equip.pan); this.vp.clearStains();
        $('knob').value = 0; $('knob-v').textContent = '0';
      }
      this.stoveUsed = true;
      // every patty on the ticket is formed now and waits on the board until it is laid in
      this.patties = this.forms.map((f, i) => this.makeFromForm(f, i));
      this.layoutSpots();
      this.sel = 0; this.vp.setPatty(null);
      this.probe = { inserted: false, depth: 0.5, reading: null, settle: 0 }; $('btn-probe').textContent = 'Insert probe';
      $('btn-lid').textContent = 'Lid on';
      this.chart = []; this.logN = -1;
      $('log').innerHTML = '';
      const labels = this.ticket.items.map((id) => this.label(id)).join(' + ');
      const n = this.patties.length;
      if (reuse) P.logEvent(this.state, `Order: ${labels}. ${n > 1 ? `${n} patties are` : 'Patty is'} on the board; the pan is still at ${this.state.pan.T.toFixed(0)} °C from the last ticket` + (this.state.pan.oil > 0.001 ? ` with ${(this.state.pan.oil * 1000).toFixed(1)} g of fat in it.` : '.'), 'info');
      else P.logEvent(this.state, `Order: ${labels}. ${n > 1 ? `${n} patties are` : 'Patty is'} on the board; the pan is cold (${this.state.pan.T.toFixed(0)} °C).`, 'info');
      if (n > 1) P.logEvent(this.state, `${n} burgers on one ticket: they all have to come off hot together. Lay the one that needs longest in first; every cold patty pulls the pan down.`, 'info');
      this.setPhase('cook');
      this.setSpeed(1);
    }
    layoutSpots() {
      const maxR = Math.max(...this.patties.map((p) => p.D / 2));
      this.spots = P.pattySpots(this.patties.length, this.state.pan.floorR, maxR);
    }
    // ------------------------------------------------------------ binding
    bind() {
      const s = this;
      $('btn-accept').onclick = () => s.setPhase('form');
      const link = (id, key, fnv, fnd) => { const el = $(id); el.addEventListener('input', () => { s.form[key] = fnv(el.value); fnd && (fnd.textContent = fnd.dataset.fmt.replace('%', s.form[key])); s.rebuildPreview(); }); };
      link('f-mass', 'massG', Number, $('f-mass-v')); link('f-thick', 'thicknessMm', Number, $('f-thick-v')); link('f-work', 'work', (v) => Number(v) / 100, $('f-work-v'));
      $('f-blend').addEventListener('change', (e) => { s.form.blend = e.target.value; s.rebuildPreview(); });
      $('f-temp').addEventListener('change', (e) => { s.form.temp = e.target.value; s.rebuildPreview(); });
      $('f-salt').addEventListener('change', (e) => { s.form.salt = e.target.value; s.rebuildPreview(); });
      $('f-dimple').addEventListener('change', (e) => { s.form.dimple = e.target.checked; s.rebuildPreview(); });
      $('btn-copy').onclick = () => { const f = s.form; for (let i = 0; i < s.forms.length; i++) if (i !== s.sel) s.forms[i] = { ...f, target: s.forms[i].target }; s.updateChips(); };
      $('btn-to-stove').onclick = () => s.startCook();
      $('chips').addEventListener('click', (e) => { const b = e.target.closest('[data-chip]'); if (b) s.select(Number(b.dataset.chip)); });
      this.vp.onPick = (p) => { const i = s.patties.indexOf(p); if (i >= 0) s.select(i); };
      // equipment
      const swapStove = () => { s.state = P.createState({ pan: s.equip.pan, stove: s.equip.stove }); s.vp.setStove(s.equip.stove); s.vp.setPan(s.equip.pan); s.vp.clearStains(); $('knob').value = 0; $('knob-v').textContent = '0'; s.layoutSpots(); P.logEvent(s.state, `Swapped to ${s.state.pan.name.toLowerCase()} on ${s.state.stove.name.split(' (')[0].toLowerCase()}: a cold pan.`, 'action'); s.logN = -1; };
      $('e-stove').addEventListener('change', (e) => { s.equip.stove = e.target.value; if (s.phase === 'cook' && !s.anyPlaced()) swapStove(); });
      $('e-pan').addEventListener('change', (e) => { s.equip.pan = e.target.value; if (s.phase === 'cook' && !s.anyPlaced()) swapStove(); });
      $('e-fat').addEventListener('change', (e) => { s.equip.fat = e.target.value; });
      $('e-fatg').addEventListener('input', (e) => { s.equip.fatG = Number(e.target.value); $('e-fatg-v').textContent = e.target.value + ' g'; });
      $('btn-fat').onclick = () => { P.addFat(s.state, s.equip.fat, s.equip.fatG); s.audio.click(); };
      $('knob').addEventListener('input', (e) => { P.setKnob(s.state, Number(e.target.value)); $('knob-v').textContent = e.target.value; });
      $('btn-place').onclick = () => s.place();
      $('btn-flip').onclick = () => { const r = P.flipPatty(s.state, s.patty); if (r.ok) { s.audio.hiss(0.6); s.vp.forceTex = true; s.refreshButtons(); } };
      $('btn-press').onclick = () => { P.pressPatty(s.state, false, s.patty); s.audio.hiss(0.5); s.vp.forceTex = true; };
      $('btn-smash').onclick = () => { P.pressPatty(s.state, true, s.patty); s.audio.hiss(0.9); s.vp.forceTex = true; s.refreshButtons(); };
      $('btn-lid').onclick = () => { P.toggleLid(s.state); $('btn-lid').textContent = s.state.lid ? 'Lid off' : 'Lid on'; };
      $('btn-cheese').onclick = () => { P.addCheese(s.state, s.patty); s.refreshButtons(); };
      $('btn-baste').onclick = () => { P.basteButter(s.state); s.audio.hiss(0.4); };
      $('btn-wash').onclick = () => { if (P.washPan(s.state)) { s.audio.hiss(Math.min(1, (s.state.pan.T - 30) / 100)); s.vp.forceTex = true; } };
      $('btn-wipe').onclick = () => { P.wipeStove(s.state); s.vp.clearStains(); };
      $('btn-remove').onclick = () => s.remove();
      $('btn-probe').onclick = () => { s.probe.inserted = !s.probe.inserted; s.probe.settle = 0; s.probe.reading = null; $('btn-probe').textContent = s.probe.inserted ? 'Pull probe' : 'Insert probe'; };
      $('probe-depth').addEventListener('input', (e) => { s.probe.depth = Number(e.target.value) / 100; $('probe-depth-v').textContent = e.target.value + ' %'; });
      $('btn-cut').onclick = () => { P.serve(s.state); s.setPhase('result'); };
      $('btn-again').onclick = () => { s.vp.setCutaway(false); s.vp.setPatty(null); s.state.patties = []; s.state.patty = null; s.state.served = false; s.newOrder(); };
      $('btn-cutaway').onclick = () => { s.vp.setCutaway(!s.vp.cutaway); $('btn-cutaway').classList.toggle('on', s.vp.cutaway); };
      $('r-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-chip]'); if (b) s.select(Number(b.dataset.chip)); });
      for (const b of document.querySelectorAll('[data-speed]')) b.onclick = () => s.setSpeed(Number(b.dataset.speed));
      for (const b of document.querySelectorAll('[data-view]')) b.onclick = () => s.vp.controls.preset(b.dataset.view);
      $('btn-audio').onclick = () => { const on = s.audio.toggle(); $('btn-audio').textContent = on ? '🔊 Sound on' : '🔇 Sound off'; };
      $('hard').addEventListener('change', (e) => { s.hard = e.target.checked; document.body.classList.toggle('hard', s.hard); });
      $('btn-inspector').onclick = () => { $('inspector').hidden = !$('inspector').hidden; };
      $('btn-help').onclick = () => { $('help').hidden = !$('help').hidden; };
      $('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').hidden = true; });
      document.addEventListener('pointerdown', () => { if (!s.audio.ctx && !s.audioAsked) { s.audioAsked = true; s.audio.start(); $('btn-audio').textContent = '🔊 Sound on'; } }, { once: true });
      window.addEventListener('keydown', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
        if (e.key === 'Tab' && s.forms.length > 1 && s.phase !== 'order') { e.preventDefault(); s.select((s.sel + 1) % s.forms.length); return; }
        if (s.phase !== 'cook') return;
        if (e.key === 'f' || e.key === 'F') $('btn-flip').click();
        if (e.key === ' ') { e.preventDefault(); if (s.patty && s.patty.where === 'board') $('btn-place').click(); else $('btn-flip').click(); }
        if (e.key === 'p' || e.key === 'P') $('btn-press').click();
        if (e.key === 'c' || e.key === 'C') $('btn-cutaway').click();
      });
    }
    /** Test/debug hook: advance the physics by `seconds` without rendering. */
    fastForward(seconds) { let n = Math.round(seconds / DT); while (n-- > 0) P.step(this.state, DT); this.vp.forceTex = true; }
    setSpeed(v) { this.speed = v; for (const b of document.querySelectorAll('[data-speed]')) b.classList.toggle('on', Number(b.dataset.speed) === v); }
    anyPlaced() { return this.patties.some((p) => p.where !== 'board'); }
    inPan() { return this.patties.filter((p) => p.where === 'pan'); }
    place() {
      const p = this.patty; if (!p || p.where !== 'board') return;
      P.placePatty(this.state, p, this.spots[this.sel]);
      this.audio.hiss(Math.min(1, (P.panTat(this.state.pan, Math.hypot(p.pos.x, p.pos.y)) - 60) / 200));
      this.vp.forceTex = true;
      this.refreshButtons(); this.updateChips();
    }
    remove() {
      const p = this.patty; if (!p || p.where !== 'pan') return;
      P.removePatty(this.state, p);
      const left = this.inPan().length, board = this.patties.filter((q) => q.where === 'board').length;
      if (left === 0 && board === 0) {
        // Burner off with the last patty: the pan (and its fat) cools in real time while the meat rests.
        P.setKnob(this.state, 0); $('knob').value = 0; $('knob-v').textContent = '0';
        P.logEvent(this.state, `Burner off. The pan is at ${this.state.pan.T.toFixed(0)} °C and will take a while to come down.`, 'action');
        this.setPhase('rest');
      } else if (left === 0) {
        P.logEvent(this.state, `Nothing in the pan. ${board} patt${board > 1 ? 'ies' : 'y'} still on the board while patty ${p.id} rests and cools.`, 'info');
      }
      this.refreshButtons(); this.updateChips();
    }
    refreshButtons() {
      const on = this.phase === 'cook', p = this.patty;
      const where = p ? p.where : 'board';
      const inPan = on && where === 'pan';
      $('btn-place').disabled = !on || where !== 'board';
      $('btn-place').textContent = this.patties.length > 1 ? `Lay patty ${this.sel + 1} in (space)` : 'Lay the patty in (space)';
      for (const id of ['btn-flip', 'btn-press', 'btn-smash', 'btn-cheese', 'btn-baste', 'btn-remove']) $(id).disabled = !inPan;
      $('btn-lid').disabled = !on || this.inPan().length === 0;
      if (inPan) { const raw = P.gridMean(p, p.dM) < 0.25; $('btn-smash').disabled = !raw || p.h < 0.006; $('btn-cheese').disabled = p.cheeses.length >= 24; }
      $('btn-probe').disabled = !(inPan || (p && where === 'rest'));
      $('btn-wash').disabled = !on || this.inPan().length > 0; $('btn-wipe').disabled = !on;
      $('e-stove').disabled = $('e-pan').disabled = this.anyPlaced();
      $('btn-cut').disabled = this.inPan().length > 0;
    }
    // ------------------------------------------------------------ loop
    frame(now) {
      const real = Math.min(0.1, (now - this.last) / 1000); this.last = now;
      const st = this.state;
      const active = this.phase === 'cook' || this.phase === 'rest';
      if (active || this.stoveUsed) {
        // Once the stove has been used it keeps running between tickets, so the pan cools (or
        // keeps heating, if the burner was left on) while the next patty is being formed.
        this.acc += real * this.speed;
        let n = 0;
        while (this.acc >= DT && n < 400) { P.step(st, DT); this.acc -= DT; n++; }
        if (n >= 400) this.acc = 0;
        this.audio.update(st.diag, st.stove.knob / 10, real);
        if (active) {
          this.updateProbe(real * this.speed);
          this.updateHUD();
          this.updateLog();
          this.updateChips();
          if (this.phase === 'rest') { const p = this.patty; $('rest-t').textContent = P.fmtTime(p ? p.restT || 0 : st.rest.t); $('rest-c').textContent = this.hard || !p ? '—' : fmt(P.centerT(p), 1) + ' °C'; }
        }
      } else {
        this.audio.update({ sizzle: 0, spatter: 0 }, 0, real);
      }
      const viewState = this.phase === 'form' ? this.stateForPreview : this.phase === 'order' ? (this.stateForPreview || P.createState({})) : st;
      if (this.phase === 'form' || this.phase === 'order') { viewState.diag = viewState.diag || {}; viewState.where = 'board'; }
      this.vp.setProbe(this.probe.inserted && !!this.state.patty && (this.phase === 'cook' || this.phase === 'rest'), this.probe.depth);
      this.vp.update(viewState, real);
      requestAnimationFrame((t) => this.frame(t));
    }
    updateProbe(dt) {
      const p = this.state.patty; if (!this.probe.inserted || !p || p.where === 'board') { this.probe.reading = null; return; }
      const idx = P.clamp(Math.round((1 - this.probe.depth) * (p.Nz - 1)), 0, p.Nz - 1); // depth measured from the top, on the axis
      const truth = P.cellT(p, idx, 0);
      if (this.probe.reading == null) this.probe.reading = this.state.env.Tamb;
      this.probe.reading += (truth - this.probe.reading) * Math.min(1, dt / 0.9); // thermometer settle time
    }
    updateHUD() {
      const st = this.state, p = st.patty, d = st.diag;
      const where = p ? p.where : 'board';
      $('h-pan').textContent = this.hard ? '—' : fmt(st.pan.T + (Math.random() - 0.5) * 1.5, 0) + ' °C';
      $('h-time').textContent = p && where === 'pan' ? P.fmtTime(p.cookTime) : p && (where === 'rest' || where === 'cut') ? 'rest ' + P.fmtTime(p.restT || 0) : P.fmtTime(st.t);
      $('h-probe').textContent = this.probe.reading == null ? '—' : fmt(this.probe.reading, 1) + ' °C';
      $('h-side').textContent = p && where === 'pan' ? `${this.patties.length > 1 ? `patty ${p.id} · ` : ''}face ${p.faceDown.id} down · ${P.fmtTime(p.timeDown)} this side` : '';
      $('h-smoke').hidden = d.smoke < 0.25; $('h-smoke').textContent = d.smoke > 1.2 ? '🚨 Heavy smoke — open a window' : '💨 Smoking';
      $('h-lid').hidden = !st.lid;
      // inspector
      if (!$('inspector').hidden) {
        const rows = [];
        const add = (k, v) => rows.push(`<tr><td>${k}</td><td>${v}</td></tr>`);
        add('Burner power to pan', fmt(st.stove.pDelivered, 0) + ' W');
        add('Pan temperature', fmt(st.pan.T, 1) + ' °C mean · centre ' + fmt(st.pan.Tcenter, 0) + ' · edge ' + fmt(st.pan.Tedge, 0));
        add('Oil / fat in pan', fmt(st.pan.oil * 1000, 1) + ' g' + (st.pan.oilKind !== 'none' ? ` (${st.pan.oilKind})` : ''));
        add('Water on pan', fmt(st.pan.water * 1000, 2) + ' g');
        add('Fond', fmt(st.pan.fond * 1000, 1) + ' (burnt ' + fmt(st.pan.fondBurnt * 1000, 1) + ')');
        if (p && where !== 'board') {
          if (this.patties.length > 1) add('Selected patty', `${p.id} of ${this.patties.length} (${this.label(p.target)})`);
          add('Heat flux into meat', fmt(d.panQ, 0) + ' W · h = ' + fmt(d.hc, 0) + ' W/m²K');
          add('Bottom surface / node 0', fmt(p.surfT, 0) + ' / ' + fmt(p.T[0], 0) + ' °C');
          add('Centre / top', fmt(P.centerT(p), 1) + ' / ' + fmt(P.cellT(p, p.Nz - 1, 0), 1) + ' °C');
          add('Centre / edge at mid-height', fmt(P.centerT(p), 1) + ' / ' + fmt(P.cellT(p, Math.floor(p.Nz / 2), p.Nr - 1), 1) + ' °C');
          add('Peak centre so far', fmt(p.peakCenter, 1) + ' °C → ' + P.donenessOf(p.peakCenter).label);
          add('Boiling at contact', fmt(d.evapBottom * 1000, 2) + ' g/s · top evap ' + fmt(p.evapTop * 1000, 3) + ' g/s');
          add('Juice pooled top / at pan', fmt(p.poolTop * 1000, 2) + ' / ' + fmt(p.poolBottom * 1000, 2) + ' g');
          add('Fat rendered out', fmt(p.lostFat * 1000, 1) + ' g (' + fmt(d.fatDrip * 1000, 2) + ' g/s)');
          add('Water lost (steam / drip)', fmt(p.lostWaterEvap * 1000, 1) + ' / ' + fmt(p.lostWaterDrip * 1000, 1) + ' g');
          add('Mass now', fmt(P.pattyMass(p) * 1000, 1) + ' g of ' + fmt(p.massKg0 * 1000, 0));
          add('Face down: brown / char', fmt(p.faceDown.brown, 2) + ' / ' + fmt(p.faceDown.char, 2) + (p.faceDown.stuck ? ' · STUCK' : ' · released'));
          add('Face up: brown / char', fmt(p.faceUp.brown, 2) + ' / ' + fmt(p.faceUp.char, 2));
          add('Bottom crust centre → rim', Array.from(p.faceDown.brownR).filter((_, j) => j % Math.ceil(p.Nr / 6) === 0 || j === p.Nr - 1).map((b) => b.toFixed(1)).join(' '));
          add('Diameter / thickness', fmt(p.D * 100, 2) + ' cm / ' + fmt(p.h * 1000, 1) + ' mm · dome ' + fmt(p.dome, 2));
          add('Denatured: myosin/collagen/actin', fmt(P.gridMean(p, p.dM) * 100, 0) + ' / ' + fmt(P.gridMean(p, p.dC) * 100, 0) + ' / ' + fmt(P.gridMean(p, p.dA) * 100, 0) + ' %');
          add('Spatter / smoke', fmt(d.spatter, 1) + ' drops/s · ' + fmt(d.smoke, 2));
        }
        $('insp-table').innerHTML = rows.join('');
        this.drawChart($('chart'), st.trace);
      }
    }
    updateLog() {
      const ev = this.state.events; const el = $('log');
      if (this.logN === ev.length) return; this.logN = ev.length;
      el.innerHTML = ev.slice(-14).map((e) => `<div class="ev ${e.kind}"><span>${P.fmtTime(e.t)}</span>${e.text}</div>`).join('');
      el.scrollTop = el.scrollHeight;
    }
    drawChart(cv, trace) {
      const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height;
      ctx.fillStyle = '#16130f'; ctx.fillRect(0, 0, W, H);
      if (trace.length < 2) return;
      const t0 = trace[0].t, t1 = trace[trace.length - 1].t; const span = Math.max(60, t1 - t0);
      const Tmax = 320; const X = (t) => 36 + ((t - t0) / span) * (W - 44); const Y = (T) => H - 16 - (T / Tmax) * (H - 24);
      ctx.strokeStyle = '#3a332b'; ctx.fillStyle = '#8a8070'; ctx.font = '10px sans-serif';
      for (let T = 0; T <= Tmax; T += 50) { ctx.beginPath(); ctx.moveTo(36, Y(T)); ctx.lineTo(W - 8, Y(T)); ctx.stroke(); ctx.fillText(T + '°', 4, Y(T) + 3); }
      const series = [['pan', '#e0a04a'], ['surf', '#d75b3a'], ['bottom', '#b8825a'], ['center', '#ff6b7a'], ['top', '#6bb3ff']];
      for (const [k, col] of series) {
        ctx.strokeStyle = col; ctx.lineWidth = k === 'center' ? 2 : 1; ctx.beginPath(); let started = false;
        for (const r of trace) { const v = r[k]; if (v == null) { started = false; continue; } const x = X(r.t), y = Y(v); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
        ctx.stroke();
      }
      ctx.lineWidth = 1; let lx = 40;
      for (const [k, col] of series) { ctx.fillStyle = col; ctx.fillRect(lx, 4, 10, 3); ctx.fillStyle = '#c9bfae'; ctx.fillText(k, lx + 13, 9); lx += 52; }
    }
    // ------------------------------------------------------------ results
    showResults() {
      const st = this.state;
      const tk = P.evaluateTicket(st); this.ticketResult = tk;
      this.vp.controls.preset('serve'); $('inspector').hidden = true;
      this.vp.setCutaway(true); $('btn-cutaway').classList.add('on');
      $('r-score').textContent = tk.total;
      $('r-grade').textContent = tk.total >= 90 ? 'Line-cook royalty' : tk.total >= 75 ? 'Solid. They will come back.' : tk.total >= 55 ? 'Edible. Nobody complained out loud.' : tk.total >= 35 ? 'Sent back.' : 'The customer left. So did the smoke alarm.';
      const many = tk.results.length > 1;
      $('r-chips').hidden = !many;
      if (many) {
        $('r-chips').innerHTML = tk.results.map((r, i) => `<button class="chip${i === this.sel ? ' on' : ''}" data-chip="${i}"><b>${i + 1}</b> ${r.target.label} <small>${r.total}/100</small></button>`).join('');
        $('r-ticket').hidden = false;
        $('r-ticket').innerHTML = `<b>Ticket:</b> ${tk.results.map((r) => r.total).join(' + ')} → mean ${tk.mean}${tk.coldPenalty ? ` − ${tk.coldPenalty} for burgers that went out cold` : ''}` + (tk.notes.length ? `<ul>${tk.notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : '');
      } else { $('r-ticket').hidden = tk.notes.length === 0; $('r-ticket').innerHTML = tk.notes.length ? `<ul>${tk.notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''; }
      this.showPattyResult();
    }
    showPattyResult() {
      const st = this.state, tk = this.ticketResult; if (!tk || !tk.results.length) return;
      const r = tk.results.find((x) => x.patty === this.patty) || tk.results[0]; this.result = r;
      for (const b of $('r-chips').querySelectorAll('[data-chip]')) b.classList.toggle('on', Number(b.dataset.chip) === this.sel);
      const target = r.target;
      const prefix = tk.results.length > 1 ? `Patty ${this.sel + 1}: ` : '';
      $('r-verdict').textContent = prefix + (r.dist === 0 ? `${target.label}. Exactly what they asked for.` : r.peak < target.lo ? `Under: ${r.got.label.toLowerCase()} when they wanted ${target.label.toLowerCase()}.` : `Over: ${r.got.label.toLowerCase()} when they wanted ${target.label.toLowerCase()}.`);
      const parts = r.parts;
      $('r-parts').innerHTML = [['Doneness', parts.doneness, 50], ['Crust', parts.crust, 20], ['Juiciness', parts.juiciness, 15], ['Evenness', parts.evenness, 10], ['Structure', parts.structure, 5]]
        .map(([k, v, m]) => `<div class="bar"><span>${k}</span><i><b style="width:${(v / m) * 100}%"></b></i><em>${v}/${m}</em></div>`).join('');
      $('r-stats').innerHTML = [
        ['Peak centre temperature', `${r.peak.toFixed(1)} °C (${r.got.label})`],
        ['Ordered', `${target.label} (${target.lo}–${target.hi} °C)`],
        ['Time on the pan / resting', `${P.fmtTime(r.cookTime)} / ${P.fmtTime(r.restTime)}, ${r.flips} flip${r.flips === 1 ? '' : 's'}`],
        ['Mass', `${(r.massStart * 1000).toFixed(0)} g → ${(r.massEnd * 1000).toFixed(0)} g (−${((1 - r.massEnd / r.massStart) * 100).toFixed(0)} %)`],
        ['Water', `${(r.waterRetained * 100).toFixed(0)} % retained · ${(r.waterEvap * 1000).toFixed(1)} g steamed off · ${(r.waterDrip * 1000).toFixed(1)} g ran out`],
        ['Fat rendered into the pan', `${(r.fatLost * 1000).toFixed(1)} g`],
        ['On the bun', `${r.cheeseSlices ? r.cheeseSlices + ' slice' + (r.cheeseSlices > 1 ? 's' : '') + ' of cheese · ' : ''}${(r.bunSoak * 1000).toFixed(1)} g of juice into the bottom bun`],
        ['Crust (browning index / char)', `A: ${r.faces.down.id === 'A' ? r.faces.down.brown.toFixed(1) : r.faces.up.brown.toFixed(1)} / ${(r.faces.down.id === 'A' ? r.faces.down.char : r.faces.up.char).toFixed(2)} · B: ${r.faces.down.id === 'B' ? r.faces.down.brown.toFixed(1) : r.faces.up.brown.toFixed(1)} / ${(r.faces.down.id === 'B' ? r.faces.down.char : r.faces.up.char).toFixed(2)}`],
        ['Grey band', `${(r.overFrac * 100).toFixed(0)} % of the meat cooked past target`],
      ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
      $('r-notes').innerHTML = r.notes.map((n) => `<li>${n}</li>`).join('');
      this.drawChart($('r-chart'), st.trace);
      this.drawProfile($('r-profile'), r.patty || st.patty);
    }
    drawProfile(cv, p) {
      const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height; ctx.fillStyle = '#16130f'; ctx.fillRect(0, 0, W, H);
      const N = p.Nz; const Tmax = 110;
      const X = (i) => 36 + (i / (N - 1)) * (W - 44); const Y = (T) => H - 16 - (T / Tmax) * (H - 24);
      ctx.strokeStyle = '#3a332b'; ctx.fillStyle = '#8a8070'; ctx.font = '10px sans-serif';
      for (let T = 0; T <= 100; T += 25) { ctx.beginPath(); ctx.moveTo(36, Y(T)); ctx.lineTo(W - 8, Y(T)); ctx.stroke(); ctx.fillText(T + '°', 4, Y(T) + 3); }
      // doneness colour strip along the thickness, on the axis
      for (let i = 0; i < N; i++) { const c = root.BurgerRender.nodeColour(p, i, 0); ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; ctx.fillRect(X(i) - (W - 44) / N / 2, H - 12, (W - 44) / N + 1, 10); }
      // centre column (solid) and the rim column (dotted)
      ctx.strokeStyle = '#ff6b7a'; ctx.lineWidth = 2; ctx.beginPath();
      for (let i = 0; i < N; i++) { const x = X(i), y = Y(P.cellT(p, i, 0)); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke(); ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.strokeStyle = '#d9a066'; ctx.beginPath();
      for (let i = 0; i < N; i++) { const x = X(i), y = Y(P.cellT(p, i, p.Nr - 1)); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#c9bfae'; ctx.fillText('bottom (face ' + p.faceDown.id + ')', 40, 12); ctx.fillText('top (face ' + p.faceUp.id + ')', W - 90, 12);
      ctx.fillStyle = '#ff6b7a'; ctx.fillRect(W / 2 - 40, 4, 10, 3); ctx.fillStyle = '#c9bfae'; ctx.fillText('axis', W / 2 - 27, 9); ctx.fillStyle = '#d9a066'; ctx.fillRect(W / 2 + 6, 4, 10, 3); ctx.fillStyle = '#c9bfae'; ctx.fillText('rim', W / 2 + 19, 9);
    }
  }
  root.addEventListener('DOMContentLoaded', () => { root.game = new Game(); });
})(window);
