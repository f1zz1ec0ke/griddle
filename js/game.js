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
  // Physics timestep. The explicit conduction in the patty is stable for dt < dz²/2α: the layers
  // are ~0.6 mm and α of wet meat is ~2.5e-7 m²/s, so the bound is about 0.73 s — and physics.js
  // keeps a 20 % margin on it (0.59 s), sub-cycling automatically for the thin layers of a
  // smashed patty. This step is a twelfth of that.
  // The pan rings are further from their bound still (≈1.7 s for cast iron). Halving the work by
  // stepping at 20 Hz instead of 40 costs nothing a cook could taste: every recipe in the README
  // scores the same 100, the peak centre temperature moves by at most 0.2 °C and the cook times by
  // under two seconds. The regression tests deliberately keep stepping at 0.025 s, which is what
  // the constants were calibrated at.
  const DT = 0.05;
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
      this.patties = []; this.spots = []; this.selItem = null;
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
      if (i < 0 || i >= this.forms.length) return;
      if (i === this.sel && !this.selItem) return;
      this.selItem = null; P.selectItem(this.state, null);
      this.sel = i;
      if (this.phase === 'form') { this.loadForm(); this.rebuildPreview(); }
      else if (this.patty) {
        P.selectPatty(this.state, this.patty);
        this.probe.reading = null; this.probe.settle = 0;
        if (this.phase === 'result') { this.showPattyResult(); this.vp.controls.preset('serve'); }
      }
      this.refreshButtons(); this.updateChips();
    }
    /** Select a topping instead of a patty: the flip and remove buttons point at it. */
    selectItem(it) {
      if (!it) return;
      this.selItem = it; P.selectItem(this.state, it);
      this.refreshButtons(); this.updateChips();
    }
    /** The toppings this ticket has going, in the order they went in. */
    get items() { return this.state.items || []; }
    updateChips() {
      const el = $('chips');
      const many = this.forms.length > 1;
      const pattyChips = this.forms.map((f, i) => {
        const p = this.patties[i];
        let status;
        if (this.phase === 'form') status = `${f.thicknessMm} mm · ${f.massG} g`;
        else if (this.phase === 'result') { const r = this.ticketResult && this.ticketResult.results.find((x) => x.patty === p); status = r ? `${r.total}/100` : '—'; }
        else if (!p || p.where === 'board') status = 'on the board';
        else if (p.where === 'pan') status = `in the pan ${P.fmtTime(p.cookTime)}`;
        else status = `resting ${P.fmtTime(p.restT || 0)}`;
        // each patty's chip carries the toppings that have been built onto it
        const tops = p ? this.items.filter((it) => it.burger === p.id) : [];
        const built = tops.length ? ` <i>+ ${tops.map((it) => it.spec.short).join(' ')}</i>` : '';
        return `<button class="chip${i === this.sel && !this.selItem ? ' on' : ''}" data-chip="${i}" title="Select patty ${i + 1} (Tab cycles)"><b>${i + 1}</b> ${SHORT[f.target]}${built} <small>${status}</small></button>`;
      }).join('');
      const itemChips = this.phase === 'form' ? '' : this.items.map((it, i) => {
        const st = P.itemState(it);
        const status = it.where === 'pan' ? `${P.fmtTime(it.cookTime)} · ${st.state}` : `${st.state}${it.burger ? ` → ${it.burger}` : ''}`;
        return `<button class="chip item${it === this.selItem ? ' on' : ''}" data-item="${i}" title="Select this topping"><b>${it.spec.short}</b> <small>${status}</small></button>`;
      }).join('');
      const chips = pattyChips + itemChips;
      if (chips !== this.chipsHTML) { el.innerHTML = chips; this.chipsHTML = chips; }
      el.hidden = this.phase === 'order' || (!many && !this.items.length);
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
      const grill = P.STOVES[this.equip.stove].kind === 'grill';
      const reuse = this.stoveUsed && st && st.stove.id === this.equip.stove && (grill || st.pan.id === this.equip.pan);
      if (reuse) {
        st.patties = []; st.patty = null; st.items = []; st.item = null; st.where = 'board'; st.rest.t = 0; st.lid = false; st.baste = 0; st.served = false;
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
      this.sel = 0; this.selItem = null; this.vp.setPatty(null);
      this.probe = { inserted: false, depth: 0.5, reading: null, settle: 0 }; $('btn-probe').textContent = 'Insert probe';
      $('btn-lid').textContent = 'Lid on';
      this.chart = []; this.logN = -1;
      $('log').innerHTML = '';
      const labels = this.ticket.items.map((id) => this.label(id)).join(' + ');
      const n = this.patties.length;
      const surf = grill ? 'grate' : 'pan';
      if (reuse) P.logEvent(this.state, `Order: ${labels}. ${n > 1 ? `${n} patties are` : 'Patty is'} on the board; the ${surf} is still at ${this.state.pan.T.toFixed(0)} °C from the last ticket` + (this.state.pan.oil > 0.001 ? ` with ${(this.state.pan.oil * 1000).toFixed(1)} g of fat in it.` : '.'), 'info');
      else if (grill) P.logEvent(this.state, `Order: ${labels}. ${n > 1 ? `${n} patties are` : 'Patty is'} on the board. The kettle is cold: light the coals (open the vents) and give the bed a few minutes.`, 'info');
      else P.logEvent(this.state, `Order: ${labels}. ${n > 1 ? `${n} patties are` : 'Patty is'} on the board; the pan is cold (${this.state.pan.T.toFixed(0)} °C).`, 'info');
      this.applyEquipUI();
      if (n > 1) P.logEvent(this.state, `${n} burgers on one ticket: they all have to come off hot together. Lay the one that needs longest in first; every cold patty pulls the pan down.`, 'info');
      this.setPhase('cook');
      this.setSpeed(1);
    }
    /** Labels and controls that differ between a pan on a stove and a grate over coals. */
    applyEquipUI() {
      const grill = !!this.state.grill;
      $('knob-label').textContent = grill ? 'Vents' : 'Burner';
      $('h-pan-label').textContent = grill ? 'IR gun · grate' : 'IR gun · pan';
      $('btn-wash').textContent = grill ? 'Brush grate' : 'Wash pan';
      $('btn-wash').title = grill ? 'Wire-brush the bars while they are hot.' : 'Empty and scrub the pan under the tap. Cools it, leaves it wet.';
      $('btn-fat').disabled = grill; $('e-fat').disabled = grill; $('e-fatg').disabled = grill;
      $('e-pan').hidden = grill; $('e-pan-wrap').hidden = grill;
      $('bank-row').hidden = !grill;
      if (grill) { $('bank').value = Math.round((this.state.grill.bank || 0) * 100); $('bank-v').textContent = $('bank').value; }
      $('btn-move-in').textContent = grill ? 'Over the coals' : 'Move to centre';
      $('btn-move-out').textContent = grill ? 'Off the coals' : 'Move to edge';
      $('btn-lid').title = grill ? 'The kettle lid: turns the grill into an oven and calms the coals.' : 'A glass lid: traps steam, cooks the top, softens the crust.';
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
      $('chips').addEventListener('click', (e) => {
        const b = e.target.closest('[data-chip]'); if (b) { s.select(Number(b.dataset.chip)); return; }
        const it = e.target.closest('[data-item]'); if (it) s.selectItem(s.items[Number(it.dataset.item)]);
      });
      this.vp.onPick = (o) => { const i = s.patties.indexOf(o); if (i >= 0) s.select(i); else if (s.items.indexOf(o) >= 0) s.selectItem(o); };
      // equipment
      const swapStove = () => { s.state = P.createState({ pan: s.equip.pan, stove: s.equip.stove }); s.vp.setStove(s.equip.stove); s.vp.setPan(s.equip.pan); s.vp.clearStains(); $('knob').value = 0; $('knob-v').textContent = '0'; s.layoutSpots(); s.applyEquipUI(); P.logEvent(s.state, s.state.grill ? 'Wheeled the kettle out. Cold coals, cold grate: light it and wait.' : `Swapped to ${s.state.pan.name.toLowerCase()} on ${s.state.stove.name.split(' (')[0].toLowerCase()}: a cold pan.`, 'action'); s.logN = -1; };
      $('e-stove').addEventListener('change', (e) => { s.equip.stove = e.target.value; if (s.phase === 'cook' && !s.anyPlaced()) swapStove(); });
      $('e-pan').addEventListener('change', (e) => { s.equip.pan = e.target.value; if (s.phase === 'cook' && !s.anyPlaced()) swapStove(); });
      $('e-fat').addEventListener('change', (e) => { s.equip.fat = e.target.value; });
      $('e-fatg').addEventListener('input', (e) => { s.equip.fatG = Number(e.target.value); $('e-fatg-v').textContent = e.target.value + ' g'; });
      $('btn-fat').onclick = () => { P.addFat(s.state, s.equip.fat, s.equip.fatG); s.audio.click(); };
      $('knob').addEventListener('input', (e) => { P.setKnob(s.state, Number(e.target.value)); $('knob-v').textContent = e.target.value; });
      $('bank').addEventListener('input', (e) => { P.setBank(s.state, Number(e.target.value) / 100); $('bank-v').textContent = e.target.value; });
      $('btn-place').onclick = () => s.place();
      $('btn-scrape').onclick = () => { const p = s.patty; if (!p || p.where !== 'pan') return; P.scrape(s.state, p); s.audio.hiss(0.3); s.vp.forceTex = true; s.refreshButtons(); };
      $('btn-move-in').onclick = () => s.slide(false);
      $('btn-move-out').onclick = () => s.slide(true);
      // dragging in the viewport: the renderer asks what may be dragged and where a drop would land,
      // and hands the drop back here so the physics decides what the move costs
      s.vp.canDrag = (o) => s.phase === 'cook' && o && o.where === 'pan';
      s.vp.dropSpot = (o, want) => P.slideTo(s.state, o, (o.D != null ? o.D : o.Dcov) / 2, want);
      s.vp.onDrop = (o, land, moved) => {
        if (moved < 0.004) return; // a nudge of a few millimetres on screen is a click, not a move
        const r = s.patties.indexOf(o) >= 0 ? P.movePatty(s.state, o, land) : P.moveItem(s.state, o, land);
        if (r && r.ok) { s.audio.hiss(0.25); s.vp.forceTex = true; }
        s.refreshButtons(); s.updateChips();
      };
      $('btn-flip').onclick = () => {
        // one button, whatever is selected: turn the patty, turn the bun or the rasher or the egg,
        // or stir the onions
        const r = s.selItem ? P.flipItem(s.state, s.selItem) : P.flipPatty(s.state, s.patty);
        if (r.ok) { s.audio.hiss(s.selItem ? 0.35 : 0.6); s.vp.forceTex = true; s.refreshButtons(); s.updateChips(); }
      };
      const addExtra = (kind) => {
        // toasting the buns while the meat rests is the normal way round, so putting something in
        // the pan during the rest puts the stove back in front of you
        if (s.phase === 'rest') { s.setPhase('cook'); P.logEvent(s.state, 'Back on the stove: something else is going in the pan while the meat rests.', 'action'); }
        const made = P.addItem(s.state, kind);
        if (made && made.length) { s.selectItem(made[0]); s.audio.hiss(0.5); }
        s.refreshButtons(); s.updateChips();
      };
      $('btn-bun').onclick = () => addExtra('bun');
      $('btn-bacon').onclick = () => addExtra('bacon');
      $('btn-egg').onclick = () => addExtra('egg');
      $('btn-onion').onclick = () => addExtra('onions');
      $('assign-btns').addEventListener('click', (e) => {
        const b = e.target.closest('[data-burger]'); if (!b || !s.selItem) return;
        const p = s.patties[Number(b.dataset.burger)];
        P.assignTopping(s.state, s.selItem, p);
        P.logEvent(s.state, `${s.selItem.label} goes on burger ${p.id}.`, 'action');
        s.refreshButtons(); s.updateChips();
      });
      $('btn-press').onclick = () => { P.pressPatty(s.state, false, s.patty); s.audio.hiss(0.5); s.vp.forceTex = true; };
      $('btn-smash').onclick = () => { P.pressPatty(s.state, true, s.patty); s.audio.hiss(0.9); s.vp.forceTex = true; s.refreshButtons(); };
      $('btn-lid').onclick = () => { P.toggleLid(s.state); $('btn-lid').textContent = s.state.lid ? 'Lid off' : 'Lid on'; };
      $('btn-cheese').onclick = () => { P.addCheese(s.state, s.patty); s.refreshButtons(); };
      $('btn-baste').onclick = () => { P.basteButter(s.state); s.audio.hiss(0.4); };
      $('btn-wash').onclick = () => { if (P.washPan(s.state)) { s.audio.hiss(Math.min(1, (s.state.pan.T - 30) / 100)); s.vp.forceTex = true; } };
      $('btn-wipe').onclick = () => { P.wipeStove(s.state); s.vp.clearStains(); };
      $('btn-remove').onclick = () => { if (s.selItem) { if (P.removeItem(s.state, s.selItem)) { s.maybeRest(); s.refreshButtons(); s.updateChips(); } } else s.remove(); };
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
        if (e.key === 'Tab' && s.phase !== 'order' && (s.forms.length > 1 || s.items.length)) {
          // Tab walks the chips: every patty, then every topping, then back to the first patty
          e.preventDefault();
          const n = s.forms.length, i = s.selItem ? n + s.items.indexOf(s.selItem) : s.sel;
          const next = (i + 1) % (n + s.items.length);
          if (next < n) s.select(next); else s.selectItem(s.items[next - n]);
          return;
        }
        if (s.phase !== 'cook') return;
        if (e.key === 'f' || e.key === 'F') $('btn-flip').click();
        if (e.key === ' ') { e.preventDefault(); if (s.patty && s.patty.where === 'board') $('btn-place').click(); else $('btn-flip').click(); }
        if (e.key === 'p' || e.key === 'P') $('btn-press').click();
        if (e.key === 's' || e.key === 'S') $('btn-scrape').click();
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
      let pos = this.spots[this.sel];
      const g = this.state.grill;
      if (g && (g.bank || 0) > 0.05) {
        // a banked fire has a searing side and a finishing side, and meat goes on over the coals
        const r = P.slideTo(this.state, p, p.D / 2, { x: 0.55 * this.state.pan.floorR + pos.x * 0.4, y: pos.y });
        if (r.ok) pos = r.pos;
      }
      P.placePatty(this.state, p, pos);
      this.audio.hiss(Math.min(1, (P.panTatXY(this.state, p.pos.x, p.pos.y) - 60) / 200));
      this.vp.forceTex = true;
      this.refreshButtons(); this.updateChips();
    }
    /**
     * Keyboard-friendly moving: slide whatever is selected to the middle of the pan, or out to the
     * edge of it (over the coals, or off them, on a banked kettle — the hot half is +x).
     */
    slide(out) {
      const o = this.selItem || this.patty; if (!o || o.where !== 'pan') return;
      const rad = (o.D != null ? o.D : o.Dcov) / 2;
      const grill = !!this.state.grill, bank = grill ? this.state.grill.bank || 0 : 0;
      const lim = Math.max(0, this.state.pan.floorR - rad);
      // on a banked fire "in" and "out" are the two zones, not the middle and the rim
      const want = bank > 0.05 ? { x: (out ? -0.62 : 0.62) * this.state.pan.floorR, y: 0 } : out ? { x: lim * Math.cos(0.6), y: lim * Math.sin(0.6) } : { x: 0, y: 0 };
      const r = this.selItem ? P.moveItem(this.state, o, want) : P.movePatty(this.state, o, want);
      if (r && r.ok) { this.audio.hiss(0.25); this.vp.forceTex = true; }
      this.refreshButtons(); this.updateChips();
    }
    remove() {
      const p = this.patty; if (!p || p.where !== 'pan') return;
      P.removePatty(this.state, p);
      const board = this.patties.filter((q) => q.where === 'board').length;
      if (!this.maybeRest() && this.inPan().length === 0 && board > 0) {
        P.logEvent(this.state, `Nothing in the pan. ${board} patt${board > 1 ? 'ies' : 'y'} still on the board while patty ${p.id} rests and cools.`, 'info');
      }
      this.refreshButtons(); this.updateChips();
    }
    /**
     * The rest begins when the metal is finally empty — of meat and of toppings — and nothing is
     * left on the board. A rasher still rendering is a reason to leave the burner on.
     */
    maybeRest() {
      if (this.phase !== 'cook') return false;
      const left = this.inPan().length + this.items.filter((q) => q.where === 'pan').length;
      const board = this.patties.filter((q) => q.where === 'board').length;
      if (left > 0 || board > 0 || !this.patties.some((q) => q.where !== 'board')) return false;
      // Burner off with the last thing off the pan: the pan (and its fat) cools in real time while the meat rests.
      P.setKnob(this.state, 0); $('knob').value = 0; $('knob-v').textContent = '0';
      P.logEvent(this.state, `Burner off. The pan is at ${this.state.pan.T.toFixed(0)} °C and will take a while to come down.`, 'action');
      this.setPhase('rest');
      return true;
    }
    refreshButtons() {
      const on = this.phase === 'cook', p = this.patty, it = this.selItem;
      if (it && this.items.indexOf(it) < 0) this.selItem = null;
      const where = p ? p.where : 'board';
      const inPan = on && where === 'pan';
      const itemOn = on && !!it && it.where === 'pan';
      $('btn-place').disabled = !on || where !== 'board';
      $('btn-place').textContent = this.patties.length > 1 ? `Lay patty ${this.sel + 1} in (space)` : 'Lay the patty in (space)';
      for (const id of ['btn-press', 'btn-smash', 'btn-cheese', 'btn-baste']) $(id).disabled = !inPan || !!it;
      // the flip and remove buttons act on whichever chip is selected — a patty or a topping
      $('btn-flip').disabled = it ? !itemOn : !inPan;
      $('btn-flip').textContent = it ? (it.kind === 'onions' ? 'Stir (F)' : `Turn the ${it.spec.short} (F)`) : 'Flip (F)';
      $('btn-remove').disabled = it ? !itemOn : !inPan;
      $('btn-remove').textContent = it ? `Take the ${it.spec.short} off` : 'Off the heat → rest';
      $('btn-lid').disabled = !on || (this.inPan().length === 0 && !this.items.some((q) => q.where === 'pan'));
      // the spatula acts on whatever is selected, and only on the metal
      const onMetal = it ? itemOn : inPan;
      $('btn-scrape').disabled = !inPan || !!it; // only meat welds itself down
      for (const id of ['btn-move-in', 'btn-move-out']) $(id).disabled = !onMetal;
      if (inPan && !it) { const raw = P.gridMean(p, p.dM) < 0.25; $('btn-smash').disabled = !raw || p.h < 0.006 || !!this.state.grill; $('btn-cheese').disabled = p.cheeses.length >= 24; $('btn-baste').disabled = !!this.state.grill; }
      for (const id of ['btn-bun', 'btn-bacon', 'btn-egg', 'btn-onion']) $(id).disabled = !(on || this.phase === 'rest');
      // the build step: with more than one burger on the ticket, say which one this topping is for
      const many = this.patties.length > 1;
      const live = on || this.phase === 'rest';
      $('assign-row').hidden = !live || !it || !many;
      if (live && it && many) {
        const html = this.patties.map((q, i) => `<button data-burger="${i}" class="${it.burger === q.id ? 'on' : ''}">${i + 1} ${SHORT[q.target]}</button>`).join(' ');
        if (html !== this.assignHTML) { $('assign-btns').innerHTML = html; this.assignHTML = html; }
      }
      $('btn-probe').disabled = !(inPan || (p && where === 'rest'));
      $('btn-wash').disabled = !on || this.inPan().length > 0 || this.items.some((q) => q.where === 'pan'); $('btn-wipe').disabled = !on;
      $('e-stove').disabled = $('e-pan').disabled = this.anyPlaced() || this.items.length > 0;
      if (this.state.grill) { $('btn-fat').disabled = true; }
      $('btn-cut').disabled = this.inPan().length > 0 || this.items.some((q) => q.where === 'pan');
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
        // `real` is already capped at 0.1 s, so at 8× speed this is at most 16 steps; the 200-step
        // ceiling is the backstop for a tab that has been asleep, and dropping the remainder there
        // keeps a slow frame from snowballing into a slower one.
        let n = 0;
        while (this.acc >= DT && n < 200) { P.step(st, DT); this.acc -= DT; n++; }
        if (n >= 200) this.acc = 0;
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
      const it = this.selItem;
      $('h-side').textContent = it
        ? `${it.label} · ${P.itemState(it).state}${it.where === 'pan' ? ` · ${fmt(P.itemT(it), 0)} °C · ${P.fmtTime(it.timeDown)} this side` : it.burger ? ` · on burger ${it.burger}` : ' · at the pass'}`
        : p && where === 'pan' ? `${this.patties.length > 1 ? `patty ${p.id} · ` : ''}face ${p.faceDown.id} down · ${P.fmtTime(p.timeDown)} this side` : '';
      if (st.grill && (st.grill.bank || 0) > 0.05 && !this.hard) {
        $('h-pan').textContent = `${fmt(st.grill.Thot, 0)} / ${fmt(st.grill.Tcool, 0)} °C`;
        $('h-pan-label').textContent = 'IR gun · hot / cool';
      } else if (st.grill) $('h-pan-label').textContent = 'IR gun · grate';
      $('h-smoke').hidden = d.smoke < 0.25; $('h-smoke').textContent = d.smoke > 1.2 ? '🚨 Heavy smoke — open a window' : '💨 Smoking';
      $('h-lid').hidden = !st.lid;
      // inspector
      if (!$('inspector').hidden) {
        const rows = [];
        const add = (k, v) => rows.push(`<tr><td>${k}</td><td>${v}</td></tr>`);
        if (st.grill) {
          add('Coal bed', fmt(st.grill.Tfire, 0) + ' °C · ' + fmt(st.grill.coal * 1000, 0) + ' g of charcoal left · burning ' + fmt(st.stove.pDelivered / 1000, 1) + ' kW');
          add('Flare / fat on the coals', fmt(st.grill.flare, 2) + ' · ' + fmt(st.grill.fatOnCoals * 1000, 2) + ' g');
          add('Bed raked', fmt((st.grill.bank || 0) * 100, 0) + ' % to one side' + ((st.grill.bank || 0) > 0.05 ? ` · bars ${fmt(st.grill.Thot, 0)} °C over the coals, ${fmt(st.grill.Tcool, 0)} °C off them` : ' (spread flat)'));
          add('Dome air', fmt(st.grill.Tdome, 0) + ' °C' + (st.lid ? ' (lid on)' : ''));
        } else add('Burner power to pan', fmt(st.stove.pDelivered, 0) + ' W');
        add(st.grill ? 'Grate temperature' : 'Pan temperature', fmt(st.pan.T, 1) + ' °C mean · centre ' + fmt(st.pan.Tcenter, 0) + ' · edge ' + fmt(st.pan.Tedge, 0));
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
          add('Metal under it', fmt(P.panTatXY(st, p.pos.x, p.pos.y), 0) + ' °C · ' + fmt(Math.hypot(p.pos.x, p.pos.y) * 100, 1) + ' cm from the middle' + (p.scrapeT > 0 ? ' · ON THE SPATULA' : ''));
          add('Face down: brown / char', fmt(p.faceDown.brown, 2) + ' / ' + fmt(p.faceDown.char, 2) + (p.faceDown.stuck ? ' · STUCK' : ' · released'));
          add('Face up: brown / char', fmt(p.faceUp.brown, 2) + ' / ' + fmt(p.faceUp.char, 2));
          add('Bottom crust centre → rim', Array.from(p.faceDown.brownR).filter((_, j) => j % Math.ceil(p.Nr / 6) === 0 || j === p.Nr - 1).map((b) => b.toFixed(1)).join(' '));
          add('Diameter / thickness', fmt(p.D * 100, 2) + ' cm / ' + fmt(p.h * 1000, 1) + ' mm · dome ' + fmt(p.dome, 2));
          add('Physics step', `${(DT * 1000).toFixed(0)} ms (${Math.round(1 / DT)} Hz) · ${p.subSteps || 1} conduction sub-step${(p.subSteps || 1) > 1 ? 's' : ''} per step`);
          add('Denatured: myosin/collagen/actin', fmt(P.gridMean(p, p.dM) * 100, 0) + ' / ' + fmt(P.gridMean(p, p.dC) * 100, 0) + ' / ' + fmt(P.gridMean(p, p.dA) * 100, 0) + ' %');
          add('Spatter / smoke', fmt(d.spatter, 1) + ' drops/s · ' + fmt(d.smoke, 2));
        }
        // the selected topping: its own nodes, in the same units as the patty's
        const sit = this.selItem;
        if (sit) {
          const st = P.itemState(sit);
          add('— Topping', `${sit.label} · ${st.state}${sit.burger ? ` · built onto burger ${sit.burger}` : ''}`);
          add('Metal under it / its surface', fmt(sit.Tat, 0) + ' / ' + fmt(sit.Ts, 0) + ' °C · ' + fmt(sit.qBot, 0) + ' W in');
          add('Mass now', fmt(P.itemMass(sit) * 1000, 1) + ' g of ' + fmt(sit.m0 * 1000, 0) + ' · ' + fmt(sit.lostWater * 1000, 1) + ' g steamed off');
          if (sit.kind === 'bun') {
            add('Crust / crumb', fmt(sit.face.T, 0) + ' / ' + fmt(sit.body.T, 0) + ' °C · face ' + fmt(1 - sit.face.w / sit.w0f, 2) + ' dry');
            add('Toast (browning / char)', fmt(sit.cutFace.brown, 2) + ' / ' + fmt(sit.cutFace.char, 3) + ' · ' + fmt(sit.fatSoaked * 1000, 1) + ' g of fat soaked up');
          } else if (sit.kind === 'bacon') {
            add('Strip temperature / dryness', fmt(sit.body.T, 0) + ' °C · ' + fmt(1 - sit.body.w / sit.w0, 2) + ' dry');
            add('Fat: solid / melted / out', fmt(sit.fs * 1000, 1) + ' / ' + fmt(sit.fl * 1000, 1) + ' / ' + fmt(sit.lostFat * 1000, 1) + ' g of ' + fmt(sit.fat0 * 1000, 1));
            add('Crisp / curl / shrink', fmt(sit.crisp, 2) + ' / ' + fmt(sit.curl, 2) + ' / ' + fmt(sit.shrink * 100, 0) + ' %');
            add('Browning A / B', fmt(sit.faceDown.brown, 2) + ' / ' + fmt(sit.faceUp.brown, 2) + ' · char ' + fmt(sit.faceDown.char + sit.faceUp.char, 3));
          } else if (sit.kind === 'egg') {
            add('White: pan side / top', fmt(sit.wBot.T, 0) + ' / ' + fmt(sit.wTop.T, 0) + ' °C · set ' + fmt(sit.setBot, 2) + ' / ' + fmt(sit.setTop, 2));
            add('Yolk / its skin', fmt(sit.yolk.T, 0) + ' / ' + fmt(sit.yolkSkin || sit.yolk.T, 0) + ' °C · set ' + fmt(sit.yolkSet, 2) + (sit.flipped ? ' · turned over ' + P.fmtTime(sit.secondSide) : ''));
            add('Lace / underside', fmt(sit.lace.brown, 2) + ' brown · ' + fmt(sit.lace.char, 3) + ' char · under ' + fmt(sit.faceDown.brown, 2) + (sit.stuck ? ' · STUCK' : ' · released'));
          } else if (sit.kind === 'onions') {
            add('On the metal / in the heap', fmt(sit.bot.T, 0) + ' / ' + fmt(sit.top.T, 0) + ' °C · ' + fmt((sit.bot.w + sit.top.w) * 1000, 0) + ' g of water left of ' + fmt(sit.w0 * 1000, 0));
            add('Caramel: heap / contact layer', fmt(sit.carm, 2) + ' / ' + fmt(sit.carmBot, 2) + ' · char ' + fmt(sit.char, 3) + ' / ' + fmt(sit.charBot, 3));
            add('Stirs / fond lifted', sit.stirs + ' · ' + fmt(sit.fond * 1000, 2) + ' g');
          }
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
        $('r-ticket').innerHTML = `<b>Ticket:</b> ${tk.results.map((r) => r.total).join(' + ')} → mean ${tk.mean}${tk.coldPenalty ? ` − ${tk.coldPenalty} for burgers that went out cold` : ''}${tk.buildPenalty ? ` − ${tk.buildPenalty} for the build` : ''}${tk.buildBonus ? ` + ${tk.buildBonus} for the toppings` : ''}` + (tk.notes.length ? `<ul>${tk.notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : '');
      } else {
        const line = tk.buildPenalty || tk.buildBonus ? `<b>Ticket:</b> ${tk.mean}${tk.buildPenalty ? ` − ${tk.buildPenalty} for the build` : ''}${tk.buildBonus ? ` + ${tk.buildBonus} for the toppings` : ''} → ${tk.total}` : '';
        $('r-ticket').hidden = tk.notes.length === 0 && !line;
        $('r-ticket').innerHTML = line + (tk.notes.length ? `<ul>${tk.notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : '');
      }
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
        ['Build', r.build.items.length
          ? r.build.items.map((b) => `${b.label} — <b>${b.state}</b>`).join('<br>') + (r.build.penalty ? `<br><span class="pen">− ${r.build.penalty.toFixed(1)} on the ticket</span>` : '') + (r.build.bonus ? `<br><span class="bon">+ ${r.build.bonus.toFixed(1)} on the ticket</span>` : '')
          : 'Nothing on it but the patty (and a plain, untoasted bun)'],
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
