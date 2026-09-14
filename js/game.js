/*
 * game.js — phases, UI wiring and the simulation loop.
 *   order → form (build each patty) → cook (stove) → rest → result
 * A ticket is one to three burgers, each with its own doneness. All of them share the pan.
 */
(function (root) {
  'use strict';
  const P = root.BurgerPhysics;
  const A = root.BurgerAssembly;
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
    { who: 'Table 3', line: '“Rare. Like, actually rare. I will send it back.”', items: ['rare'], builds: [["bun", "pickles", "mustard"]] },
    { who: 'Table 7', line: '“Medium-rare, please, and a good crust on it.”', items: ['medium-rare'], builds: [["bun", "cheese", "lettuce", "tomato"]] },
    { who: 'The regular at the bar', line: '“Medium. Warm pink centre, not red, not grey.”', items: ['medium'], builds: [["bun", "bacon", "cheese", "mayo"]] },
    { who: 'Table 12', line: '“Medium-well — just a hint of pink.”', items: ['medium-well'], builds: [["bun", "onions", "mustard"]] },
    { who: 'A dad', line: '“Well done. No pink. Don\'t burn it though.”', items: ['well-done'], builds: [["bun", "egg", "ketchup"]] },
    { who: 'Table 9, two covers', line: '“One medium-rare, one well done — she doesn\'t trust pink. Together, please.”', items: ['medium-rare', 'well-done'], builds: [["bun", "cheese"], ["bun", "bacon"]] },
    { who: 'Two regulars', line: '“Both medium. Same time, same plate.”', items: ['medium', 'medium'], builds: [["bun", "onions"], ["bun", "egg"]] },
    { who: 'Date night', line: '“Rare for me, medium-well for him. Don\'t let mine sit while his cooks.”', items: ['rare', 'medium-well'], builds: [["bun"], ["bun", "cheese", "bacon"]] },
    { who: 'Birthday table', line: '“Three burgers: rare, medium, medium-well. All at once or not at all.”', items: ['rare', 'medium', 'medium-well'], builds: [["bun", "cheese"], ["bun", "bacon"], ["bun", "onions"]] },
    { who: 'Two hungry regulars', line: '“Two doubles, medium, cheese and pickles. Make them count.”', items: ['medium','medium'], builds: [['bun','double','cheese','pickles'],['bun','double','cheese','pickles']] },
    { who: 'Family of three', line: '“Medium-rare, medium-well, and a well-done for the kid. Hot, please.”', items: ['medium-rare', 'medium-well', 'well-done'], builds: [["bun", "cheese"], ["bun", "egg"], ["bun", "bacon"]] },
  ];
  const DEFAULT_FORM = { massG: 150, thicknessMm: 20, blend: '80/20', temp: 'fridge', work: 0.35, dimple: true, salt: 'surface' };
  const SHIFT_LEN = 6;                  // six tickets is a service
  const SAVE_KEY = 'griddle.session.v1';
  const SNAPSHOT_FIELDS = ['mode', 'phase', 'state', 'patties', 'forms', 'equip', 'ticket', 'shift', 'sel', 'selItem', 'probe', 'speed', 'hard', 'ticketTarget', 'ticketClock', 'ticketTiming', 'ticketRecorded', 'stoveUsed', 'practiceNextId', 'addingPractice', 'shownShiftEnd'];
  const BUILD_NAMES = { double: 'two patties', bun: 'bun halves', cheese: 'cheese', bacon: 'bacon', egg: 'egg', onions: 'onions', ...Object.fromEntries(Object.entries(A.cold).map(([k,v]) => [k,v.label.toLowerCase()])) };
  const BEST_KEY = 'griddle.bestShift'; // localStorage: the best shift this browser has ever cooked
  const money = (v) => '$' + (v || 0).toFixed(2);

  class Game {
    constructor() {
      this.vp = new root.BurgerRender.Viewport($('view'));
      this.audio = new root.KitchenAudio();
      this.fahrenheit = false;
      try { this.fahrenheit = localStorage.getItem('griddle.temperatureUnit') === 'F'; } catch (_) {}
      this.speed = 1; this.phase = 'order'; this.hard = false;
      this.mode = 'service'; this.paused = false; this.autosaveClock = 0;
      this.probe = { inserted: false, depth: 0.5, reading: null };
      this.forms = [{ ...DEFAULT_FORM, target: 'medium' }]; this.previews = []; this.sel = 0;
      this.patties = []; this.spots = []; this.selItem = null;
      this.equip = { stove: 'gas', pan: 'castiron', fat: 'canola', fatG: 8, wood: 'hickory', coalG: 500 };
      this.state = P.createState({ pan: this.equip.pan, stove: this.equip.stove });
      this.chipsHTML = '';
      this.cues = new root.CookingCues(); this.cuesHTML = '';
      this.shift = this.emptyShift();
      this.bind();
      this.newOrder();
      this.unitLabels = Array.from(document.querySelectorAll('option, #help p, #help li')).map(el => [el, el.innerHTML]);
      this.unitTitles = Array.from(document.querySelectorAll('[title]')).filter(el => el.title.includes('°C')).map(el => [el, el.title]);
      this.syncUnits();
      $('btn-load').textContent = 'Resume saved service';
      try { $('btn-service-load').hidden = $('btn-load').hidden = !localStorage.getItem(SAVE_KEY + '.service'); $('btn-practice-load').hidden = !localStorage.getItem(SAVE_KEY + '.practice'); } catch (_) {}
      this.last = performance.now(); this.acc = 0;
      requestAnimationFrame((t) => this.frame(t));
    }
    get stopped() { return this.paused || !$('help').hidden; }
    syncPause() {
      document.body.classList.toggle('paused', this.paused);
      $('btn-pause').textContent = this.paused ? 'Resume' : 'Pause';
      $('btn-pause').setAttribute('aria-pressed', String(this.paused));
      const help = !$('help').hidden;
      $('workbench').inert = this.paused || help;
      for (const id of ['flight-deck', 'view', 'inspector', 'order', 'results', 'shiftend']) $(id).inert = help;
      this.last = performance.now(); this.acc = 0;
    }
    setPaused(on) { this.paused = on; this.syncPause(); }
    openHelp() {
      this.helpFocus = document.activeElement;
      $('help').hidden = false; this.syncPause(); $('btn-help-close').focus();
    }
    closeHelp() {
      $('help').hidden = true; this.syncPause();
      if (this.helpFocus && this.helpFocus.isConnected) this.helpFocus.focus();
    }
    saveSession(automatic = false) {
      if (automatic && this.mode === 'service' && this.phase === 'order' && !this.shift.n) return;
      try {
        const snapshot = Object.fromEntries(SNAPSHOT_FIELDS.map(k => [k, this[k]]));
        snapshot.controls = {};
        for (const el of document.querySelectorAll('input[id], select[id]')) snapshot.controls[el.id] = { value: el.value, checked: el.checked };
        localStorage.setItem(SAVE_KEY + '.' + this.mode, root.GriddleSession.encode(snapshot));
        this.savedSession = true; $('btn-load').hidden = false; $('btn-load').textContent = 'Resume saved ' + this.mode;
        if (this.mode === 'practice') $('btn-practice-load').hidden = false;
        else $('btn-service-load').hidden = false;
        $('save-status').textContent = automatic ? 'Autosaved' : 'Saved — safe to close';
        return true;
      } catch (_) {
        this.savedSession = false;
        $('save-status').textContent = 'Could not save. Storage may be full or unavailable.';
        return false;
      }
    }
    loadSession(mode = this.mode) {
      let snapshot;
      try {
        snapshot = root.GriddleSession.validate(root.GriddleSession.decode(localStorage.getItem(SAVE_KEY + '.' + mode)), P);
      } catch (_) { $('save-status').textContent = 'Saved session could not be read. Your current kitchen is unchanged.'; return false; }
      this.vp.setPatty(null);
      for (const k of SNAPSHOT_FIELDS) this[k] = snapshot[k];
      if (this.phase !== 'result') for (const p of this.patties) { p.manualAssembly = true; p.assembly ||= []; }
      this.previews = []; this.stateForPreview = null;
      this.sel = Math.max(0, Math.min(this.sel || 0, this.forms.length - 1));
      this.chipsHTML = this.assignHTML = this.clockHTML = ''; this.logN = -1;
      for (const [id, control] of Object.entries(snapshot.controls || {})) {
        const el = $(id); if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) { el.value = control.value; el.checked = control.checked; }
      }
      document.body.classList.toggle('hard', this.hard); $('hard').checked = this.hard;
      $('btn-inspector').hidden = this.hard; $('inspector').hidden = true;
      this.vp.setStove(this.equip.stove); this.vp.setPan(this.equip.pan); this.vp.clearStains();
      this.vp.setCutaway(false); $('btn-cutaway').classList.remove('on');
      this.layoutSpots(); this.applyEquipUI(); this.updateOrderText(); this.updateShiftBar(); this.updateTicketClock();
      $('knob').value = this.state.stove.knob; $('knob-v').textContent = this.state.stove.knob;
      $('e-fatg-v').textContent = this.equip.fatG + ' g'; $('e-coalg-v').textContent = this.equip.coalG + ' g';
      this.syncProbe(); this.syncUnits(); $('btn-lid').textContent = this.state.lid ? 'Lid off' : 'Lid on';
      $('h-sense').hidden = true; this.senseNote = '';
      $('shiftend').hidden = true;
      $('btn-load').hidden = false; $('btn-load').textContent = 'Resume saved ' + this.mode;
      const phase = this.phase;
      if (this.shownShiftEnd) { this.setPhase('order'); this.showShiftEnd(); }
      else this.setPhase(phase);
      this.setSpeed(this.speed); this.setPaused(true); this.autosaveClock = 0;
      this.savedSession = true; $('save-status').textContent = 'Restored paused — resume when ready';
      this.vp.forceTex = true;
      return true;
    }
    syncProbe() {
      $('probe-depth').value = Math.round(this.probe.depth * 100);
      $('probe-depth-v').textContent = $('probe-depth').value + ' %';
      $('btn-probe').textContent = this.probe.inserted ? 'Pull probe' : 'Insert probe';
      $('ro-probe').setAttribute('aria-pressed', String(this.probe.inserted));
      $('ro-probe').setAttribute('aria-label', $('btn-probe').textContent);
      $('ro-probe').title = $('btn-probe').textContent;
    }
    startPractice() {
      this.vp.setCutaway(false);$('btn-cutaway').classList.remove('on');
      this.mode = 'practice'; this.paused = false; this.addingPractice = false; this.practiceNextId = 1;
      this.state = P.createState({ pan: this.equip.pan, stove: this.equip.stove }); this.stoveUsed = false;
      this.ticket = { who: 'Free practice', line: '', items: [] };
      this.ticketTiming = false; this.ticketClock = 0; this.ticketTarget = 0; this.ticketRecorded = false;
      this.forms = [{ ...DEFAULT_FORM, target: 'medium' }]; this.patties = []; this.previews = []; this.sel = 0; this.selItem = null;
      this.shownShiftEnd = false; $('shiftend').hidden = true;
      $('btn-load').textContent = 'Resume saved practice'; $('save-status').textContent = '';
      try { $('btn-load').hidden = !localStorage.getItem(SAVE_KEY + '.practice'); } catch (_) { $('btn-load').hidden = true; }
      this.updateOrderText(); this.updateTicketClock(); this.setPhase('form'); this.setSpeed(1); this.syncPause();
    }
    addPracticePatty() {
      if (this.mode !== 'practice' || this.patties.length >= 4) return;
      this.addingPractice = true;
      this.forms.push({ ...DEFAULT_FORM, target: 'medium' }); this.sel = this.forms.length - 1;
      this.selItem = null; this.setPhase('form');
    }
    addSecondPatty() {
      const p=this.patty;
      if(!p || p.assembledTo!=null || p.extraFor!=null || A.layers(p).filter(l=>l.patty).length>=2 || this.patties.some(q=>q.extraFor===p.id) || this.patties.length >= (this.mode==='practice'?4:6)) return false;
      this.forms.push({...this.form,extraFor:p.id});this.sel=this.forms.length-1;
      this.addingPractice=true;this.selItem=null;this.setPhase('form');return true;
    }
    clearPractice() {
      if (this.mode !== 'practice') return;
      this.state.patties = []; this.state.patty = null; this.state.items = []; this.state.item = null;
      this.state.where = 'board'; this.state.served = false;
      this.patties = []; this.forms = []; this.sel = 0; this.selItem = null;
      this.vp.setPatty(null); this.probe.inserted = false; this.syncProbe();
      this.setPhase('cook'); P.logEvent(this.state, 'Practice bench cleared. The stove keeps its heat and residue.', 'action');
    }
    reheat() {
      const it = this.selItem, p = this.patty;
      if (it?.assembledTo != null || (!it && (p?.assembly?.length || p?.assembledTo!=null))) return;
      if (it) { if (!P.reheatItem(this.state, it)) return; }
      else { if (!p || !['rest', 'oven'].includes(p.where)) return; P.placePatty(this.state, p, P.freeSpot(this.state, p.D / 2).pos); }
      this.setPhase('cook'); this.vp.forceTex = true;
      P.logEvent(this.state, 'Back at the stove — check the burner or vents before continuing.', 'info');
    }
    discard() {
      if (this.selItem) {
        if (!P.discardItem(this.state, this.selItem)) return;
        this.selItem = null; P.selectItem(this.state, null);
      } else if (this.patty) {
        const p = this.patty;
        A.unpack(p);
        if (p.where === 'pan') P.removePatty(this.state, p);
        this.state.patties = this.state.patties.filter(q => q !== p);
        for (const it of this.items) if (it.burger === p.id) it.burger = null;
        this.state.wasteG = (this.state.wasteG || 0) + P.pattyMass(p) * 1000;
        if (p.assembledTo!=null) { const owner=this.patties.find(q=>q.id===p.assembledTo); if(owner) A.unpack(owner); }
        if (this.mode === 'service') {
          const fresh = this.makeFromForm(this.form, this.sel); fresh.id = p.id;
          this.patties[this.sel] = fresh;
          P.selectPatty(this.state, fresh); this.probe.inserted = false; this.probe.reading = null; this.syncProbe();
          this.vp.setPatty(null); this.setPhase('cook');
          P.logEvent(this.state, `Patty ${p.id} discarded. Fresh replacement on the board; the order clock keeps running.`, 'action');
          return;
        }
        for(const q of this.patties)if(q.extraFor===p.id)q.extraFor=null;
        for(const f of this.forms)if(f.extraFor===p.id)f.extraFor=null;
        this.patties.splice(this.sel, 1); this.forms.splice(this.sel, 1);
        this.sel = Math.max(0, this.sel - 1);
        this.state.patty = this.patty; this.state.where = this.patty ? this.patty.where : 'board';
        this.vp.setPatty(null);
        P.logEvent(this.state, `Discarded practice patty ${p.id}.`, 'action');
      } else return;
      this.maybeRest(); this.refreshButtons(); this.updateChips(); this.vp.forceTex = true;
    }
    updateBuilds() {
      const el = $('build-checklist');
      if (this.mode === 'practice') { el.textContent = ''; return; }
      const rows = (this.ticket.builds || []).map((build, i) => {
        const p = this.patties[i];
        return `<div><b>${i + 1} ${this.label(this.ticket.items[i])}</b>: ` + build.map(k => {
          const have = p && !P.buildOf(this.state,p).missing.includes(k);
          return `<span class="${have ? 'ready' : 'missing'}">${have ? '✓' : '○'} ${BUILD_NAMES[k]}</span>`;
        }).join(' · ') + '</div>';
      });
      const html = rows.join(''); if (el.innerHTML !== html) el.innerHTML = html;
    }
    // ------------------------------------------------------------ orders & phases
    get form() { return this.forms[this.sel]; }
    /** The selected patty object (cook/rest/result phases). */
    get patty() { return this.patties[this.sel] || null; }
    label(id) { return P.DONENESS.find((d) => d.id === id).label; }
    newOrder(ticket) {
      const planned = this.shift && this.shift.plan[this.shift.n];
      this.ticket = ticket || planned || TICKETS[Math.floor(Math.random() * TICKETS.length)];
      const items = this.ticket.items;
      // The room's patience for this order, running from the moment it is accepted. The clock is in
      // kitchen seconds — the same time base the physics runs on — so speeding the sim up does not
      // buy service time.
      this.ticketTarget = P.ticketTargetTime(items) + ((this.ticket.builds || []).some(b => b.includes('onions')) ? 600 : (this.ticket.builds || []).some(b => b.includes('bacon')) ? 300 : (this.ticket.builds || []).length ? 120 : 0);
      this.ticketClock = 0; this.ticketTiming = false; this.ticketRecorded = false; this.verdicts = null;
      this.forms = items.map((id) => ({ ...DEFAULT_FORM, target: id }));
      (this.ticket.builds||[]).forEach((build,i)=>{if(build.includes('double'))this.forms.push({...DEFAULT_FORM,target:items[i],extraFor:i+1});});
      if(this.forms.length>items.length)this.ticketTarget+=180;
      this.previews = []; this.patties = []; this.sel = 0; this.selItem = null; this.result = null; this.ticketResult = null;
      this.updateOrderText();
      this.updateShiftBar(); this.updateTicketClock();
      this.setPhase('order');
    }
    updateOrderText() {
      const items = this.ticket.items;
      $('ticket-label').textContent = this.mode === 'practice' ? '' : 'Ticket: ';
      if (this.mode === 'practice') { $('ticket-target').textContent = 'Free practice'; $('ticket').removeAttribute('data-hint'); $('ticket').title = ''; return; }
      $('order-who').textContent = this.ticket.who;
      $('order-line').textContent = this.ticket.line;
      $('order-target').textContent = items.map((id) => this.label(id)).join(' + ').toUpperCase();
      $('order-range').textContent = items.map((id) => { const d = P.DONENESS.find((x) => x.id === id); return `${d.label} ${d.lo}–${d.hi} °C`; }).join(' · ') + ' at the centre after resting' + (items.length > 1 ? `. ${items.length} burgers, one pan, and they all have to land hot at the same time.` : '');
      $('ticket-target').textContent = items.map((id) => this.label(id)).join(' + ');
      const hint = items.map((id) => { const d = P.DONENESS.find((x) => x.id === id); return `${d.label}: ${d.lo}–${d.hi} °C`; }).join(' · ') + ' at the centre, measured at its peak after resting';
      $('order-range').textContent = this.tempText($('order-range').textContent);
      $('ticket').dataset.hint = this.tempText(hint); $('ticket').title = this.tempText(hint);
      $('order-builds').textContent = (this.ticket.builds || []).map((build, i) => `${i + 1} ${this.label(items[i])}: ${build.map(k => BUILD_NAMES[k]).join(', ')}`).join(' · ');
    }
    // ------------------------------------------------------------ the shift: six tickets and a till
    emptyShift() { return { n: 0, plan: this.planShift(), tickets: [], points: 0, tips: 0, bill: 0, covers: 0, time: 0 }; }
    /** Whether reloading would throw away work from a shift that has actually started. */
    hasUnfinishedShift() {
      return !!(this.shift && this.shift.n < SHIFT_LEN && (this.shift.n > 0 || this.ticketTiming));
    }
    /**
     * A service builds the way a real one does: singles while the room fills, two-tops in the
     * middle, and a three-burger table at the peak. Tickets are drawn from TICKETS by how many
     * burgers they carry, without repeating one until the pool runs out.
     */
    planShift() {
      const used = new Set();
      const byN = (n) => TICKETS.filter((t) => t.items.length === n);
      const out = [];
      for (let i = 0; i < SHIFT_LEN; i++) {
        const want = i < SHIFT_LEN / 2 ? 1 : i < SHIFT_LEN - 1 ? 2 : 3;
        let list = byN(want); if (!list.length) list = byN(want - 1); if (!list.length) list = TICKETS;
        const free = list.filter((t) => !used.has(t)); const pool = free.length ? free : list;
        const t = pool[Math.floor(Math.random() * pool.length)]; used.add(t); out.push(t);
      }
      return out;
    }
    newShift() {
      this.mode = 'service'; this.paused = false; this.addingPractice = false; this.shownShiftEnd = false;
      this.shift = this.emptyShift();
      this.state.items = []; this.state.item = null;
      $('shiftend').hidden = true;
      this.vp.setCutaway(false); $('btn-cutaway').classList.remove('on');
      this.vp.setPatty(null); this.state.patties = []; this.state.patty = null; this.state.served = false;
      this.newOrder();
      $('btn-load').textContent = 'Resume saved service';
      try { $('btn-load').hidden = !localStorage.getItem(SAVE_KEY + '.service'); } catch (_) {}
    }
    updateShiftBar() {
      const sh = this.shift; if (!sh || this.mode === 'practice') return;
      const n = Math.min(sh.n + 1, SHIFT_LEN);
      let pips = ''; for (let i = 0; i < SHIFT_LEN; i++) pips += i < sh.n ? '<i>●</i>' : '○';
      $('order-shift').innerHTML =
        `<div class="pips">${pips}</div>` +
        `<div><span>Ticket</span> <b>${n}</b> <span>of ${SHIFT_LEN}</span></div>` +
        `<div><span>Shift so far</span> <b>${sh.points}</b> <span>pts</span></div>` +
        `<div><span>Tips</span> <b>${money(sh.tips)}</b></div>` +
        `<div><span>They expect it in</span> <b>${P.fmtTime(this.ticketTarget || 0)}</b> <span>from “yes chef”</span></div>`;
    }
    /** The HUD ticket clock: time on this ticket against the time it was quoted (“7:40 / 12:00”). */
    updateTicketClock() {
      const el = $('ticket-clock'); if (!el) return;
      const t = this.ticketClock || 0, target = this.ticketTarget || 0;
      el.hidden = this.mode === 'practice' || !(target > 0);
      const html = `<b>${P.fmtTime(t)}</b> / ${P.fmtTime(target)}`;
      if (html !== this.clockHTML) { el.innerHTML = html; this.clockHTML = html; }
      el.classList.toggle('late', target > 0 && t > target && t <= target * 2);
      el.classList.toggle('vlate', target > 0 && t > target * 2);
    }
    /** Fold a finished ticket into the shift's running totals. */
    recordTicket(rec) {
      const sh = this.shift; if (!sh || this.ticketRecorded) return; this.ticketRecorded = true;
      sh.tickets.push(rec); sh.n = sh.tickets.length;
      sh.points += rec.points; sh.tips += rec.tips; sh.bill += rec.bill; sh.covers += rec.covers; sh.time += rec.elapsed;
    }
    loadBest() { try { const raw = localStorage.getItem(BEST_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
    saveBest(rec) { try { localStorage.setItem(BEST_KEY, JSON.stringify(rec)); return true; } catch (e) { return false; } }
    showShiftEnd() {
      this.shownShiftEnd = true;
      const sh = this.shift, ts = sh.tickets;
      if (!ts.length) { this.newShift(); return; }
      const avg = Math.round(sh.points / ts.length);
      let best = ts[0], worst = ts[0];
      for (const t of ts) { if (t.points > best.points) best = t; if (t.points <= worst.points) worst = t; }
      $('se-score').textContent = `${avg}/100`;
      $('se-line').textContent = avg >= 90 ? 'Six tickets, no complaints. The pass never backed up.'
        : avg >= 75 ? 'A good service. A couple of them noticed something, nobody minded much.'
        : avg >= 55 ? 'You got through it. The room ate.'
        : avg >= 35 ? 'A rough night. Too many plates came back.' : 'That was a disaster. Take the apron off.';
      const sent = ts.filter((t) => t.sentBack).length;
      $('se-stats').innerHTML = [
        ['Covers', `${sh.covers} burger${sh.covers === 1 ? '' : 's'} over ${ts.length} ticket${ts.length === 1 ? '' : 's'}${sent ? `, ${sent} sent back` : ''}`],
        ['Average ticket', `${avg}/100 · ${sh.points} points on the night`],
        ['Tips', `${money(sh.tips)} on ${money(sh.bill)} of food (${sh.bill > 0 ? ((sh.tips / sh.bill) * 100).toFixed(1) : '0.0'} %)`],
        ['Time on the line', `${P.fmtTime(sh.time)} of cooking, ${P.fmtTime(sh.tickets.reduce((a, t) => a + t.target, 0))} of it quoted`],
        ['Best ticket', `#${best.n} ${best.who} — ${best.points}/100 ${best.quote}`],
        ['Worst ticket', `#${worst.n} ${worst.who} — ${worst.points}/100 ${worst.quote}`],
      ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
      $('se-tickets').innerHTML = ts.map((t) => `<div class="t${t.sentBack ? ' sent' : t === best ? ' best' : ''}"><em>#${t.n}</em><span>${t.who} · ${t.labels} · ${P.fmtTime(t.elapsed)} of ${P.fmtTime(t.target)}${t.penalty >= 0.5 ? ` (−${t.penalty.toFixed(0)} late)` : ''} · ${money(t.tips)} tip</span><b>${t.sentBack ? 'back' : t.points}</b></div>`).join('');
      const prev = this.loadBest();
      const rec = { points: sh.points, avg, tips: Math.round(sh.tips * 100) / 100, covers: sh.covers, tickets: ts.length, time: Math.round(sh.time) };
      if (!prev || sh.points > prev.points) { $('se-best').textContent = this.saveBest(rec) ? `A new best shift — the old one was ${prev ? `${prev.points} points (${prev.avg}/100) with ${money(prev.tips)} in tips` : 'nothing at all'}.` : `Best shift: ${sh.points} points. (This browser will not remember it.)`; }
      else $('se-best').textContent = `Your best shift is still ${prev.points} points (${prev.avg}/100, ${money(prev.tips)} in tips).`;
      $('results').hidden = true;   // setPhase puts it back when the next shift's first order comes up
      $('shiftend').hidden = false;
    }
    setPhase(ph) {
      this.setDrawer(null);
      this.phase = ph;
      this.cameraPreset = ph === 'rest' || ph === 'result' ? 'serve' : ph === 'cook' ? 'default' : null;
      document.body.dataset.phase = ph;
      for (const el of document.querySelectorAll('[data-phase]')) el.hidden = el.dataset.phase.split(' ').indexOf(ph) < 0;
      $('workbench').hidden = !(ph === 'form' || ph === 'cook' || ph === 'rest');
      if (ph === 'form') { this.vp.setMode('board'); this.loadForm(); this.rebuildPreview(); }
      if (ph === 'cook' || ph === 'rest' || ph === 'result') { this.vp.setMode('stove'); }
      if (ph === 'result') { this.showResults(); }
      this.refreshButtons(); this.updateChips(); this.syncPause();
      if (this.vp.resize) this.vp.resize(); // Recenter when the station/results appear or disappear.
    }
    // ------------------------------------------------------------ selection (one chip per patty)
    select(i) {
      if (i < 0 || i >= this.forms.length || (this.addingPractice && this.phase === 'form' && i !== this.forms.length - 1)) return;
      if (i === this.sel && !this.selItem) return;
      this.selItem = null; P.selectItem(this.state, null);
      this.sel = i;
      if (this.phase === 'form') { this.loadForm(); this.rebuildPreview(); }
      else if (this.patty) {
        P.selectPatty(this.state, this.patty);
        this.probe.reading = null;
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
        else if (this.phase === 'result') { const r = this.ticketResult && this.ticketResult.results.find((x) => x.patty === p); status = r ? this.mode === 'practice' ? r.got.label : `${r.total}/100` : '—'; }
        else if (!p || p.where === 'board') status = 'on the board';
        else if (p.assembledTo!=null) status = `in burger ${p.assembledTo}`;
        else if (p.where === 'oven') status = `in the oven ${P.fmtTime(p.ovenTime || 0)}`;
        else if (p.where === 'pan') status = `in the pan ${P.fmtTime(p.cookTime)}`;
        else status = `resting ${P.fmtTime(p.restT || 0)}`;
        // each patty's chip carries the toppings that have been built onto it
        const tops = p ? this.items.filter((it) => it.burger === p.id) : [];
        const built = tops.length ? ` <i>+ ${tops.map((it) => it.spec.short).join(' ')}</i>` : '';
        return `<button ${this.addingPractice && this.phase === 'form' && i !== this.forms.length - 1 ? 'disabled' : ''} class="chip${i === this.sel && !this.selItem ? ' on' : ''}" data-chip="${i}" title="Select patty ${i + 1} ([ and ] cycle food)"><b>${i + 1}</b> ${this.mode === 'practice' ? 'Patty' : SHORT[f.target]}${built} <small>${status}</small></button>`;
      }).join('');
      const itemChips = this.phase === 'form' ? '' : this.items.map((it, i) => {
        const st = P.itemState(it);
        // where it is going: assigned by hand, or the default the build step would pick (shown in
        // brackets, so the cook sees the plan while there is still time to change it)
        const plan = this.patties.length > 1 && it.burger == null && !this.patties.some(p=>p.manualAssembly) ? P.plannedBurger(this.state, it) : null;
        const dest = it.burger ? ` → ${it.burger}` : plan ? ` → (${plan.id})` : '';
        const status = it.where === 'pan' ? `${P.fmtTime(it.cookTime)} · ${st.state}` : `${st.state}${dest}`;
        return `<button class="chip item${it === this.selItem ? ' on' : ''}" data-item="${i}" title="Select this topping"><b>${it.spec.short}</b> <small>${status}</small></button>`;
      }).join('');
      const chips = pattyChips + itemChips;
      if (chips !== this.chipsHTML) {
        const active = document.activeElement;
        const key = active && el.contains(active) ? active.hasAttribute('data-chip') ? ['data-chip', active.dataset.chip] : ['data-item', active.dataset.item] : null;
        el.innerHTML = chips; this.chipsHTML = chips;
        if (key) { const next = el.querySelector(`[${key[0]}="${key[1]}"]`); if (next) next.focus({ preventScroll: true }); }
      }
      this.updateBuilds();
      el.hidden = this.phase === 'order' || (!many && !this.items.length && this.mode !== 'practice');
    }
    // ------------------------------------------------------------ forming
    loadForm() {
      const f = this.form;
      $('f-mass').value = f.massG; $('f-mass-v').textContent = `${f.massG} g`;
      $('f-thick').value = f.thicknessMm; $('f-thick-v').textContent = `${f.thicknessMm} mm`;
      $('f-work').value = Math.round(f.work * 100); $('f-work-v').textContent = String(Math.round(f.work * 100));
      $('f-blend').value = f.blend; $('f-temp').value = f.temp; $('f-salt').value = f.salt; $('f-dimple').checked = f.dimple;
      $('f-title').textContent = this.mode === 'practice' ? 'Form a practice patty' : this.forms.length > 1 ? `1 · Form patty ${this.sel + 1} of ${this.forms.length} (${this.label(f.target).toLowerCase()})` : '1 · Form the patty';
      $('btn-copy').hidden = this.mode === 'practice' || this.forms.length < 2;
    }
    makeFromForm(f, i) {
      const temp = { fridge: 4, room: 18, frozen: -18 }[f.temp];
      const blend = P.BLENDS.find((b) => b.id === f.blend);
      const p = P.makePatty({ id: i + 1, target: f.target, massG: f.massG, thicknessMm: f.thicknessMm, fatFrac: blend.fat, tempC: temp, dimple: f.dimple, work: f.work, salt: f.salt });
      p.extraFor=f.extraFor;
      p.requiredBuild = this.mode === 'practice' || f.extraFor!=null ? [] : (this.ticket.builds && this.ticket.builds[i]) || [];
      p.manualAssembly = true; p.assembly = [];
      return p;
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
      $('f-warn').textContent = f.temp === 'frozen' ? 'Frozen: the outside will be well done before the middle thaws.' : f.thicknessMm < 10 ? 'This thin, it is a smash patty. There will be no pink centre whatever you do.' : f.thicknessMm > 32 ? 'Very thick: expect a wide grey band unless you flip often and keep the pan moderate.' : (this.mode !== 'practice' && d.hi < 60 && f.thicknessMm < 15) ? `Thin for a ${d.label.toLowerCase()}: the centre will race past ${d.hi} °C before a crust forms.` : (this.mode !== 'practice' && d.lo >= 65 && f.thicknessMm > 22) ? `Thick for a ${d.label.toLowerCase()}: a long cook, and a wide grey band before the centre gets there.` : '';
      $('f-warn').textContent = this.tempText($('f-warn').textContent);
      const board = this.stateForPreview || (this.stateForPreview = P.createState({}));
      board.patty = p; board.where = 'board';
      this.vp.setPatty(p);
      this.updateChips();
    }
    startCook() {
      if (this.addingPractice) {
        const p = this.makeFromForm(this.form, this.sel); p.id = Math.max(0,...this.patties.map(q=>q.id),(this.practiceNextId||1)-1)+1; this.practiceNextId=p.id+1;
        this.patties.push(p); this.addingPractice = false; this.layoutSpots();
        P.selectPatty(this.state, p); this.probe.reading = null;
        this.vp.setPatty(null); this.setPhase('cook'); return;
      }
      // The stove persists between tickets: same pan and burner means the pan keeps its heat,
      // fat, fond and the spatter on the stovetop. A different pan is a cold pan.
      const st = this.state;
      const grill = P.STOVES[this.equip.stove].kind === 'grill';
      const reuse = this.stoveUsed && st && st.stove.id === this.equip.stove && (grill || st.pan.id === this.equip.pan);
      if (reuse) {
        // the equipment carries over: a pan keeps its heat, fat, fond and carbon, and a kettle keeps
        // its fire — coals, ash, the bars' heat and any chunk of wood still smouldering on the bed
        P.nextTicket(st);
        $('knob').value = st.stove.knob; $('knob-v').textContent = String(st.stove.knob);
      } else {
        this.state = P.createState({ pan: this.equip.pan, stove: this.equip.stove });
        this.state.room=P.roomAir(st);
        this.vp.setStove(this.equip.stove); this.vp.setPan(this.equip.pan); this.vp.clearStains();
        $('knob').value = 0; $('knob-v').textContent = '0';
      }
      this.stoveUsed = true;
      // every patty on the ticket is formed now and waits on the board until it is laid in
      this.patties = this.forms.map((f, i) => this.makeFromForm(f, i));
      if (this.mode === 'practice') { for (const p of this.patties) p.id = this.practiceNextId++; }
      this.layoutSpots();
      this.sel = 0; this.selItem = null; this.vp.setPatty(null);
      this.probe = { inserted: false, depth: 0.5, reading: null }; this.syncProbe();
      $('btn-lid').textContent = 'Lid on';
      this.chart = []; this.logN = -1;
      $('log').innerHTML = '';
      this.senseNote = ''; $('h-sense').hidden = true; $('h-sense-v').textContent = '—';
      const labels = this.ticket.items.map((id) => this.label(id)).join(' + ');
      const n = this.patties.length;
      const surf = grill ? 'grate' : 'pan';
      if (reuse && grill) {
        const g = this.state.grill, wood = g.woods.filter((w) => w.m > 1e-6).length;
        P.logEvent(this.state, `Order: ${labels}. ${n > 1 ? `${n} patties are` : 'Patty is'} on the board; the kettle is still going from the last ticket — bars at ${this.state.pan.T.toFixed(0)} °C, bed at ${g.Tfire.toFixed(0)} °C, ${(g.coal * 1000).toFixed(0)} g of charcoal left and ${((g.ash + g.ashBowl) * 1000).toFixed(0)} g of ash under it`
          + (wood ? `, and ${wood > 1 ? `${wood} chunks` : 'a chunk'} of wood still smouldering on the coals.` : '.'), 'info');
      } else if (reuse) P.logEvent(this.state, `Order: ${labels}. ${n > 1 ? `${n} patties are` : 'Patty is'} on the board; the ${surf} is still at ${this.state.pan.T.toFixed(0)} °C from the last ticket` + (this.state.pan.oil > 0.001 ? ` with ${(this.state.pan.oil * 1000).toFixed(1)} g of fat in it.` : '.'), 'info');
      else if (grill) P.logEvent(this.state, `Order: ${labels}. ${n > 1 ? `${n} patties are` : 'Patty is'} on the board. The kettle is cold: light the coals (open the vents) and give the bed a few minutes.`, 'info');
      else P.logEvent(this.state, `Order: ${labels}. ${n > 1 ? `${n} patties are` : 'Patty is'} on the board; the pan is cold (${this.state.pan.T.toFixed(0)} °C).`, 'info');
      if (this.mode === 'practice') { this.state.events = []; P.logEvent(this.state, 'Free practice. Experiment freely; clear food to change equipment. No tickets or scores.', 'info'); }
      this.applyEquipUI();
      if (n > 1 && this.mode !== 'practice') P.logEvent(this.state, `${n} burgers on one ticket: they all have to come off hot together. Lay the one that needs longest in first; every cold patty pulls the pan down.`, 'info');
      this.setPhase('cook');
      this.setSpeed(1);
    }
    /** Labels and controls that differ between a pan on a stove and a grate over coals. */
    applyEquipUI() {
      const grill = !!this.state.grill;
      $('knob-label').textContent = grill ? 'Vents' : 'Burner';
      $('h-pan-label').textContent = grill ? 'IR gun · grate' : 'IR gun · pan centre';
      $('btn-wash').textContent = grill ? 'Brush grate' : 'Wash pan';
      $('btn-wash').title = grill ? 'Wire-brush the bars while they are hot.' : 'Empty and scrub the pan under the tap. Cools it, leaves it wet.';
      $('btn-fat').disabled = grill; $('e-fat').disabled = grill; $('e-fatg').disabled = grill;
      $('e-pan').hidden = grill; $('e-pan-wrap').hidden = grill;
      $('bank-row').hidden = !grill;
      $('topvent-row').hidden = !grill; $('fire-row').hidden = !grill;
      if (grill) {
        $('bank').value = Math.round((this.state.grill.bank || 0) * 100); $('bank-v').textContent = $('bank').value;
        $('topvent').value = Math.round(this.state.grill.topVent * 100); $('topvent-v').textContent = $('topvent').value;
      }
      $('btn-move-in').textContent = grill ? 'Over the coals' : 'Move to centre';
      $('btn-move-out').textContent = grill ? 'Off the coals' : 'Move to edge';
      $('btn-lid').title = grill ? 'The kettle lid: turns the grill into an oven and calms the coals.' : 'A glass lid: traps steam, cooks the top, softens the crust.';
    }
    layoutSpots() {
      const maxR = Math.max(0.05, ...this.patties.map((p) => p.D / 2));
      this.spots = P.pattySpots(this.patties.length, this.state.pan.floorR, maxR);
    }
    // ------------------------------------------------------------ binding
    bind() {
      const s = this;
      for (const name of ['heat', 'toppings', 'tools', 'build']) {
        $('open-' + name).onclick = () => s.setDrawer(s.drawer === name ? null : name);
        $('close-' + name).onclick = () => s.setDrawer(null, true);
      }
      $('open-build').onclick = () => {
        if (s.drawer === 'build') { s.setDrawer(null); return; }
        s.selItem = null; P.selectItem(s.state,null); s.cameraPreset = 'serve';
        s.refreshButtons(); s.updateChips(); s.setDrawer('build');
      };
      $('assembly-controls').addEventListener('click', e => {
        const b = e.target.closest('[data-build]'); if (!b || b.disabled) return;
        const key = b.dataset.build;
        if (key.startsWith('select:')) { s.select(Number(key.slice(7))); s.cameraPreset = 'serve'; }
        else s.buildLayer(key);
      });
      $('btn-window').onclick = () => { P.toggleWindow(s.state); s.stoveUsed=true; s.updateHUD(); };
      $('btn-pause').onclick = () => s.setPaused(!s.paused);
      $('btn-save').onclick = () => s.saveSession();
      $('btn-load').onclick = () => s.loadSession();
      $('btn-service-load').onclick = () => s.loadSession('service');
      $('btn-practice-load').onclick = () => s.loadSession('practice');
      $('btn-practice').onclick = () => { if (s.hasUnfinishedShift() && !s.saveSession()) return; s.startPractice(); };
      $('btn-end-practice').onclick = () => { if (!s.saveSession()) return; s.clearPractice(); s.newShift(); };
      $('btn-add-patty').onclick = () => s.addPracticePatty();
      $('btn-clear-practice').onclick = () => s.clearPractice();
      $('btn-reheat').onclick = () => s.reheat();
      $('oven-temp').addEventListener('change', () => {
        if (s.stopped) return;
        P.setOven(s.state, Number($('oven-temp').value)); s.stoveUsed = true; s.updateHUD();
      });
      $('btn-oven').onclick = () => {
        if (s.stopped || s.selItem || !P.putInOven(s.state, s.patty)) return;
        s.setPhase('cook'); s.cameraPreset = 'oven'; s.refreshButtons(); s.updateChips(); s.updateHUD();
      };
      $('oven-status').onclick = () => s.setDrawer('heat');
      $('btn-discard').onclick = () => s.discard();
      $('btn-accept').onclick = () => { s.ticketTiming = true; s.setSpeed(1); s.setPhase('form'); };  // the ticket clock starts at “yes chef”, at 1× — the speed buttons are hidden while forming, so the last ticket's 8× must not carry over
      const link = (id, key, fnv, fnd) => { const el = $(id); el.addEventListener('input', () => { s.form[key] = fnv(el.value); fnd && (fnd.textContent = fnd.dataset.fmt.replace('%', s.form[key])); s.rebuildPreview(); }); };
      link('f-mass', 'massG', Number, $('f-mass-v')); link('f-thick', 'thicknessMm', Number, $('f-thick-v')); link('f-work', 'work', (v) => Number(v) / 100, $('f-work-v'));
      $('f-blend').addEventListener('change', (e) => { s.form.blend = e.target.value; s.rebuildPreview(); });
      $('f-temp').addEventListener('change', (e) => { s.form.temp = e.target.value; s.rebuildPreview(); });
      $('f-salt').addEventListener('change', (e) => { s.form.salt = e.target.value; s.rebuildPreview(); });
      $('f-dimple').addEventListener('change', (e) => { s.form.dimple = e.target.checked; s.rebuildPreview(); });
      $('btn-copy').onclick = () => { const f = s.form; for (let i = 0; i < s.forms.length; i++) if (i !== s.sel) s.forms[i] = { ...f, target: s.forms[i].target, extraFor:s.forms[i].extraFor }; s.updateChips(); };
      $('btn-to-stove').onclick = () => s.startCook();
      $('chips').addEventListener('click', (e) => {
        const b = e.target.closest('[data-chip]'); if (b) { s.select(Number(b.dataset.chip)); return; }
        const it = e.target.closest('[data-item]'); if (it) s.selectItem(s.items[Number(it.dataset.item)]);
      });
      this.vp.onPick = (o) => { if(o==='pan') { s.cameraFood=s.selItem||s.patty;s.cameraFoodWhere=s.cameraFood?.where;s.cameraPreset='pan';return; } const i = s.patties.indexOf(o); if (i >= 0) s.select(i); else if (s.items.indexOf(o) >= 0) s.selectItem(o); };
      // equipment
      const swapStove = () => { const air=P.roomAir(s.state); s.state = P.createState({ pan: s.equip.pan, stove: s.equip.stove }); s.state.room=air; s.vp.setStove(s.equip.stove); s.vp.setPan(s.equip.pan); s.vp.clearStains(); $('knob').value = 0; $('knob-v').textContent = '0'; s.layoutSpots(); s.applyEquipUI(); s.refreshButtons(); $('btn-lid').textContent = s.state.lid ? 'Lid off' : 'Lid on'; P.logEvent(s.state, s.state.grill ? 'Wheeled the kettle out. Cold coals, cold grate: light it and wait.' : `Swapped to ${s.state.pan.name.toLowerCase()} on ${s.state.stove.name.split(' (')[0].toLowerCase()}: a cold pan.`, 'action'); s.logN = -1; };
      $('e-stove').addEventListener('change', (e) => { s.equip.stove = e.target.value; if (s.phase === 'cook' && !s.anyPlaced()) swapStove(); });
      $('e-pan').addEventListener('change', (e) => { s.equip.pan = e.target.value; if (s.phase === 'cook' && !s.anyPlaced()) swapStove(); });
      $('e-fat').addEventListener('change', (e) => { s.equip.fat = e.target.value; });
      $('e-fatg').addEventListener('input', (e) => { s.equip.fatG = Number(e.target.value); $('e-fatg-v').textContent = e.target.value + ' g'; });
      $('btn-fat').onclick = () => { P.addFat(s.state, s.equip.fat, s.equip.fatG); s.audio.click(); };
      $('knob').addEventListener('input', (e) => { P.setKnob(s.state, Number(e.target.value)); $('knob-v').textContent = e.target.value; });
      $('bank').addEventListener('input', (e) => { P.setBank(s.state, Number(e.target.value) / 100); $('bank-v').textContent = e.target.value; });
      $('topvent').addEventListener('input', (e) => { P.setTopVent(s.state, Number(e.target.value) / 100); $('topvent-v').textContent = e.target.value; });
      $('e-wood').addEventListener('change', (e) => { s.equip.wood = e.target.value; });
      $('e-coalg').addEventListener('input', (e) => { s.equip.coalG = Number(e.target.value); $('e-coalg-v').textContent = e.target.value + ' g'; });
      $('btn-wood').onclick = () => { P.addWood(s.state, s.equip.wood); s.audio.hiss(0.2); s.refreshButtons(); };
      $('btn-coals').onclick = () => { P.addCoals(s.state, s.equip.coalG / 1000); s.audio.click(); s.refreshButtons(); };
      $('btn-stir').onclick = () => { P.stirCoals(s.state); s.audio.hiss(0.35); s.refreshButtons(); };
      $('btn-emptyash').onclick = () => { if (P.emptyAsh(s.state)) s.audio.click(); s.refreshButtons(); };
      $('btn-place').onclick = () => s.place();
      $('btn-scrape').onclick = () => { const p = s.patty; if (!p || p.where !== 'pan') return; P.scrape(s.state, p); s.audio.hiss(0.3); s.vp.forceTex = true; s.refreshButtons(); };
      $('btn-move-in').onclick = () => s.slide(false);
      $('btn-move-out').onclick = () => s.slide(true);
      // dragging in the viewport: the renderer asks what may be dragged and where a drop would land,
      // and hands the drop back here so the physics decides what the move costs
      s.vp.canDrag = (o) => !(s.vp.isFlipping && s.vp.isFlipping(o)) && !s.stopped && s.phase === 'cook' && o && o.where === 'pan';
      s.vp.dropSpot = (o, want) => P.slideTo(s.state, o, (o.D != null ? o.D : o.Dcov) / 2, want);
      s.vp.onDrop = (o, land, moved) => {
        if (moved < 0.004) return; // a nudge of a few millimetres on screen is a click, not a move
        const r = s.patties.indexOf(o) >= 0 ? P.movePatty(s.state, o, land) : P.moveItem(s.state, o, land);
        if (r && r.ok) { s.audio.hiss(0.25); s.vp.forceTex = true; }
        s.refreshButtons(); s.updateChips();
      };
      $('btn-flip').onclick = () => {
        if (s.stopped || (!s.selItem && s.vp.isFlipping && s.vp.isFlipping(s.patty))) return;
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
        if (made && !made.length) { if (kind === 'bun') s.selectItem(s.items.find(it => it.kind === 'bun')); s.limitWarning(); }
        if (made && made.length) { s.selectItem(made[0]); s.audio.hiss(0.5); }
        s.refreshButtons(); s.updateChips();
      };
      $('btn-bun').onclick = () => addExtra('bun');
      $('btn-bacon').onclick = () => addExtra('bacon');
      $('btn-egg').onclick = () => addExtra('egg');
      $('btn-onion').onclick = () => addExtra('onions');
      // ---- the cook's own senses. In hard mode they are all there is; in normal mode a real cook
      // uses them anyway, and they cost exactly the same either way.
      $('btn-presstest').onclick = () => {
        const p = s.patty; if (!p || (p.where !== 'pan' && p.where !== 'rest')) return;
        const r = P.pressTest(s.state, p);
        if (!r) return;
        s.note(`Press test — ${r.reading}`);
        s.audio.click(); s.vp.forceTex = true; s.refreshButtons();
      };
      $('btn-peek').onclick = () => {
        const p = s.patty; if (!p || (p.where !== 'pan' && p.where !== 'rest')) return;
        const r = P.peek(s.state, p);
        if (!r) return;
        s.note(`Cut open — ${r.colour}; ${r.band}.`);
        s.vp.peekCutaway(p, 4.5); // the knife is in it for a moment; then it closes and leaves the line
        s.vp.forceTex = true; s.refreshButtons(); s.updateChips();
      };
      $('btn-hand').onclick = () => {
        if (s.state.grill && s.state.lid) { s.note('The lid is on: a hand on the lid says warm and nothing else. Take it off to read the fire.'); return; }
        const p = s.patty && s.patty.where === 'pan' ? s.patty : null; // over the meat if there is meat, otherwise over the middle
        const count = (r) => `${r.seconds >= 59 ? 'you could leave it there' : `${r.seconds < 10 ? r.seconds.toFixed(1) : Math.round(r.seconds)} s before you pull it away`}: ${r.word}`;
        const g = s.state.grill;
        if (!p && g && (g.bank || 0) > 0.05) {
          // a banked fire has two temperatures and the middle of the grate is neither of them: with
          // nothing on the bars the hand goes over each side in turn, which is what the test is for
          const R = s.state.pan.floorR;
          const hot = P.handTestAt(s.state, { x: 0.62 * R, y: 0 }), cool = P.handTestAt(s.state, { x: -0.62 * R, y: 0 });
          s.note(`Hand over the coals — ${count(hot)}. Off them — ${count(cool)}.`);
          return;
        }
        const r = P.handTestAt(s.state, p ? p.pos : null);
        s.note(`Hand over the ${g ? 'grate' : 'pan'} — ${count(r)}.`);
      };
      $('btn-press').onclick = () => { P.pressPatty(s.state, false, s.patty); s.audio.hiss(0.5); s.vp.forceTex = true; };
      $('btn-smash').onclick = () => { P.pressPatty(s.state, true, s.patty); s.audio.hiss(0.9); s.vp.forceTex = true; s.refreshButtons(); };
      $('btn-lid').onclick = () => { P.toggleLid(s.state); $('btn-lid').textContent = s.state.lid ? 'Lid off' : 'Lid on'; };
      $('btn-cheese').onclick = () => { if (!P.addCheese(s.state, s.patty)) s.limitWarning(); s.refreshButtons(); };
      $('btn-baste').onclick = () => { P.basteButter(s.state); s.audio.hiss(0.4); };
      $('btn-wash').onclick = () => { if (P.washPan(s.state)) { s.audio.hiss(Math.min(1, (s.state.pan.T - 30) / 100)); s.vp.forceTex = true; } };
      $('btn-wipe').onclick = () => { P.wipeStove(s.state); s.vp.clearStains(); };
      $('btn-remove').onclick = () => { if (s.selItem) { if (P.removeItem(s.state, s.selItem)) { s.maybeRest(); s.refreshButtons(); s.updateChips(); } } else s.remove(); };
      $('btn-probe').onclick = () => { s.probe.inserted = !s.probe.inserted; s.probe.reading = null; s.syncProbe(); };
      $('ro-probe').onclick = () => { if (!$('help').hidden) return; $('btn-probe').click(); };
      $('probe-depth').addEventListener('input', (e) => { s.probe.depth = Number(e.target.value) / 100; $('probe-depth-v').textContent = e.target.value + ' %'; });
      $('btn-cut').onclick = () => { if (s.stopped || $('btn-cut').disabled) return; s.selItem = null; P.selectItem(s.state, null); s.ticketTiming = false; P.serve(s.state); s.setPhase('result'); }; // the clock stops when the plates leave the pass
      // everything this ticket had goes with it: the toppings too, or the next order's form phase
      // shows the last table's chips and Tab walks a bacon rasher that has already been eaten
      // the results card turns the cutaway on to show the cut face; the next ticket turns it off
      // again, and the button has to come back up with it or the first press of C looks like a no-op
      $('btn-again').onclick = () => { if (s.mode === 'practice') { s.vp.setCutaway(false); $('btn-cutaway').classList.remove('on'); s.result = null; s.ticketResult = null; s.clearPractice(); s.addPracticePatty(); return; } s.vp.setCutaway(false); $('btn-cutaway').classList.remove('on'); s.vp.setPatty(null); s.state.patties = []; s.state.patty = null; s.state.items = []; s.state.item = null; s.selItem = null; s.state.served = false; if (s.shift && s.shift.n >= SHIFT_LEN) s.showShiftEnd(); else s.newOrder(); };
      $('btn-new-shift').onclick = () => s.newShift();
      $('btn-cutaway').onclick = () => { s.vp.setCutaway(!s.vp.cutaway); $('btn-cutaway').classList.toggle('on', s.vp.cutaway); };
      $('r-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-chip]'); if (b) s.select(Number(b.dataset.chip)); });
      for (const b of document.querySelectorAll('[data-speed]')) b.onclick = () => s.setSpeed(Number(b.dataset.speed));
      for (const b of document.querySelectorAll('[data-view]')) b.onclick = () => s.vp.controls.preset(b.dataset.view);
      $('btn-units').onclick = () => { this.fahrenheit = !this.fahrenheit; try { localStorage.setItem('griddle.temperatureUnit', this.fahrenheit ? 'F' : 'C'); } catch (_) {} this.syncUnits(); };
      $('btn-audio').onclick = () => { const on = s.audio.toggle(); $('btn-audio').textContent = on ? 'Sound on' : 'Sound off'; };
      $('hard').addEventListener('change', (e) => {
        s.hard = e.target.checked; document.body.classList.toggle('hard', s.hard);
        $('btn-inspector').hidden = s.hard; if (s.hard) $('inspector').hidden = true; // the inspector is a wall of thermometers
        s.logN = -1; // redraw the log with or without its numbers
        // no thermometers means no thermometers: the probe comes out too
        if (s.hard && s.probe.inserted) { s.probe.inserted = false; s.probe.reading = null; $('btn-probe').textContent = 'Insert probe'; }
        // Results are normally rendered only once, on entering the phase. Re-render their text and
        // charts now so switching difficulty on the plate cannot leave temperatures (or a previous
        // ticket's canvas) behind, and switching back restores the current ticket's measurements.
        if (s.phase === 'result') s.renderResultDetails();
        s.refreshButtons();
      });
      $('btn-inspector').onclick = () => { $('inspector').hidden = !$('inspector').hidden; };
      $('btn-help').onclick = () => s.openHelp();
      $('kitchen-menu').addEventListener('keydown', e => {
        if (e.key === 'Escape') { $('kitchen-menu').open = false; $('kitchen-menu').querySelector('summary').focus(); }
      });
      document.addEventListener('pointerdown', e => {
        if (s.drawer && !$('drawer-' + s.drawer).contains(e.target) && !$('action-dock').contains(e.target)) s.setDrawer(null);
        if (!$('kitchen-menu').contains(e.target)) $('kitchen-menu').open = false;
      });
      $('btn-help-close').onclick = () => s.closeHelp();
      $('help').addEventListener('click', (e) => { if (e.target === $('help')) s.closeHelp(); });
      document.addEventListener('pointerdown', () => { if (!s.audio.ctx && !s.audioAsked) { s.audioAsked = true; s.audio.start(); $('btn-audio').textContent = 'Sound on'; } }, { once: true });
      window.addEventListener('beforeunload', (e) => { if ((s.hasUnfinishedShift() || s.mode === 'practice') && !s.saveSession(true)) { e.preventDefault(); e.returnValue = ''; } }); // a reload loses the shift; the browser asks first
      window.addEventListener('keydown', (e) => {
        if(['choose','real'].includes(document.body.dataset.experience))return;
        if (!$('help').hidden) {
          if (e.key === 'Escape') { e.preventDefault(); s.closeHelp(); }
          else if (e.key === 'Tab') {
            const focusable = Array.from($('help').querySelectorAll('button, summary'));
            const first = focusable[0] || $('btn-help-close'), last = focusable[focusable.length - 1] || first;
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
          }
          e.stopImmediatePropagation(); return;
        }
        if (e.key === 'Escape' && s.drawer) { e.preventDefault(); e.stopImmediatePropagation(); s.setDrawer(null, true); return; }
        if (e.target && (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable)) return;
        if ((e.key === '[' || e.key === ']') && s.phase !== 'order' && (s.forms.length || s.items.length)) {
          e.preventDefault();
          const n = s.forms.length, i = s.selItem ? n + s.items.indexOf(s.selItem) : s.sel;
          const next = (i + (e.key === '[' ? -1 : 1) + n + s.items.length) % (n + s.items.length);
          if (next < n) s.select(next); else s.selectItem(s.items[next - n]);
          return;
        }
        if (s.stopped) return;
        // the cutaway is a way of looking, not an action: it works wherever its button does — while
        // the meat rests, and on the plate in front of the customer
        if (e.key === 'c' || e.key === 'C') { $('btn-cutaway').click(); return; }
        // the senses work in the rest phase too: a resting patty can be pressed and cut into
        if (s.phase === 'cook' || s.phase === 'rest') {
          if (e.key === 't' || e.key === 'T') { $('btn-presstest').click(); return; }
          if (e.key === 'k' || e.key === 'K') { $('btn-peek').click(); return; }
          if (e.key === 'h' || e.key === 'H') { $('btn-hand').click(); return; }
        }
        if (s.phase !== 'cook') return;
        if (e.key === 'f' || e.key === 'F') $('btn-flip').click();
        if (e.key === ' ' && (!e.target || e.target.tagName !== 'BUTTON')) { e.preventDefault(); if (s.patty && s.patty.where === 'board') $('btn-place').click(); else $('btn-flip').click(); }
        if (e.key === 'p' || e.key === 'P') $('btn-press').click();
        if (e.key === 's' || e.key === 'S') $('btn-scrape').click();
      }, true);
    }
    /** The last thing the cook's eyes, ears, fingers or hand reported, on the HUD as well as the log. */
    tempText(text) { return root.TemperatureUnits.text(text, this.fahrenheit); }
    syncUnits() {
      $('btn-units').textContent = this.fahrenheit ? '°F · switch to °C' : '°C · switch to °F';
      for (const [el, source] of this.unitLabels || []) el.innerHTML = this.tempText(source);
      for (const [el, source] of this.unitTitles || []) el.title = this.tempText(source);
      this.updateOrderText(); this.updateHUD(); this.logN = -1; this.updateLog();
      if (this.phase === 'result') this.renderResultDetails();
      if (this.form && this.phase === 'form') this.rebuildPreview();
    }
    limitWarning(now = performance.now()) {
      this.limitHits = now - (this.lastLimitHit ?? -Infinity) < 5000 ? (this.limitHits || 0) + 1 : 1;
      this.lastLimitHit = now; this.noticeUntil = now + 3000;
      $('kitchen-notice').textContent = this.limitHits >= 3 ? 'CALM DOWN FFS!' : 'Calm down!';
      $('kitchen-notice').hidden = false;
    }
    note(text) { this.senseNote = text; $('h-sense-v').textContent = this.tempText(text); $('h-sense').hidden = false; }
    /** Test/debug hook: advance the physics by `seconds` without rendering. */
    fastForward(seconds) { if (this.stopped) return; let n = Math.round(seconds / DT); while (n-- > 0) P.step(this.state, DT); if (this.ticketTiming) { this.ticketClock += seconds; this.updateTicketClock(); } this.vp.forceTex = true; }
    setSpeed(v) { this.speed = v; for (const b of document.querySelectorAll('[data-speed]')) b.classList.toggle('on', Number(b.dataset.speed) === v); }
    anyPlaced() { return this.patties.some((p) => p.where !== 'board'); }
    inPan() { return this.patties.filter((p) => p.where === 'pan'); }
    place() {
      const p = this.patty; if (!p || p.where !== 'board') return;
      let pos = this.spots[this.sel] || P.freeSpot(this.state,p.D/2).pos;
      const g = this.state.grill;
      // a banked fire has a searing side and a finishing side, and meat goes on over the coals
      const want = g && (g.bank || 0) > 0.05 ? { x: 0.55 * this.state.pan.floorR + pos.x * 0.4, y: pos.y } : pos;
      // the spot is where the patty would go in an empty pan; if the onions or the bacon are already
      // sitting on it the patty goes in beside them, the way a topping goes in beside a patty
      const r = P.slideTo(this.state, p, p.D / 2, want);
      if (r.ok) pos = r.pos;
      else P.logEvent(this.state, `No room: patty ${p.id} is going in half on top of something. Crowd a pan and nothing browns.`, 'warn');
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
      const p = this.patty; if (!p || !['pan', 'oven'].includes(p.where)) return;
      if (p.where === 'oven') this.cameraPreset = 'serve';
      if (p.where === 'oven') P.takeFromOven(this.state, p); else P.removePatty(this.state, p);
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
      if (this.phase !== 'cook' || this.mode === 'practice') return false;
      const left = this.patties.filter(q => q.where === 'oven').length + this.inPan().length + this.items.filter((q) => q.where === 'pan').length;
      const board = this.patties.filter((q) => q.where === 'board').length;
      if (left > 0 || board > 0 || !this.patties.some((q) => q.where !== 'board')) return false;
      // Burner off with the last thing off the pan: the pan (and its fat) cools in real time while the meat rests.
      P.setKnob(this.state, 0); $('knob').value = 0; $('knob-v').textContent = '0';
      P.logEvent(this.state, this.state.grill
        ? `Bottom vent shut. The bars are at ${this.state.pan.T.toFixed(0)} °C and the bed will sulk down to about ${(this.state.env.Tamb + 350 * 0.2).toFixed(0)} °C on the leak alone — open it again before the next thing goes on.`
        : `Burner off. The pan is at ${this.state.pan.T.toFixed(0)} °C and will take a while to come down.`, 'action');
      this.setPhase('rest');
      return true;
    }
    refreshButtons() {
      const on = this.phase === 'cook', p = this.patty, it = this.selItem;
      $('btn-end-practice').hidden = this.mode !== 'practice';
      $('practice-tools').hidden = this.mode !== 'practice' || !['cook', 'rest'].includes(this.phase);
      $('btn-add-patty').disabled = this.patties.length >= 4;
      $('btn-add-patty').textContent = this.patties.length >= 4 ? 'Four patties on the bench' : 'Form another patty';
      $('btn-reheat').disabled = !(it ? it.where === 'rest' && it.assembledTo == null : p && ['rest', 'oven'].includes(p.where) && !p.assembly?.length && p.assembledTo==null);
      $('btn-discard').disabled = !(it && it.where !== 'cut') && !(p && p.where !== 'cut');
      $('btn-discard').textContent = it && it.pair != null ? 'Discard both bun halves' : it ? 'Discard ' + it.spec.short : this.mode === 'practice' ? 'Discard patty' : 'Replace patty';
      $('btn-discard').title = !it && this.mode === 'service' ? 'Discard this patty and put a fresh one on the board. The order clock keeps running.' : 'Discard selected food';
      $('open-build').disabled = !p || p.where !== 'rest';
      this.renderAssembly();
      $('btn-cut').hidden = !(this.phase === 'rest' || (this.mode === 'practice' && this.phase === 'cook'));
      if (it && this.items.indexOf(it) < 0) this.selItem = null;
      const air=P.roomAir(this.state);
      $('btn-window').textContent=air.windowOpen?'Close window':'Open window';
      $('btn-window').setAttribute('aria-pressed',String(air.windowOpen));
      $('btn-window').title=air.windowOpen?'Fresh air is clearing the room':air.upper+air.lower>.35?'Smoke is gathering — open the window to clear the room':'Ventilate the kitchen';
      const where = p ? p.where : 'board';
      const inPan = on && where === 'pan';
      const itemOn = on && !!it && it.where === 'pan';
      $('btn-place').disabled = !on || where !== 'board';
      $('btn-place').textContent = this.patties.length > 1 ? `Place patty ${this.sel + 1}` : 'Place patty';
      for (const id of ['btn-press', 'btn-smash', 'btn-cheese', 'btn-baste']) $(id).disabled = !inPan || !!it;
      // the flip and remove buttons act on whichever chip is selected — a patty or a topping
      $('btn-flip').disabled = it ? !itemOn : !inPan;
      $('btn-flip').textContent = it ? (it.kind === 'onions' ? 'Stir' : 'Turn') : 'Flip';
      $('btn-oven').disabled = !!it || !p || !!p.assembly?.length || p.assembledTo!=null || !['cook', 'rest'].includes(this.phase) || !['pan', 'rest'].includes(where);
      $('btn-remove').disabled = it ? !itemOn : !(inPan || where === 'oven');
      $('btn-remove').textContent = it ? 'Lift off' : where === 'oven' ? 'Out & rest' : 'Rest';
      // a pan lid is for what is in the pan; a kettle lid is part of the fire (it is half the
      // airflow and it is what holds the smoke in), so it is always available on the kettle
      $('btn-lid').disabled = !on || (!this.state.grill && this.inPan().length === 0 && !this.items.some((q) => q.where === 'pan'));
      // the spatula acts on whatever is selected, and only on the metal
      const onMetal = it ? itemOn : inPan;
      $('btn-scrape').disabled = !inPan || !!it; // only meat welds itself down
      for (const id of ['btn-move-in', 'btn-move-out']) $(id).disabled = !onMetal;
      if (inPan && !it) { const raw = P.gridMean(p, p.dM) < 0.25; $('btn-smash').disabled = !raw || p.h < 0.006 || !!this.state.grill; $('btn-cheese').disabled = false; $('btn-baste').disabled = !!this.state.grill; }
      for (const id of ['btn-bun', 'btn-bacon', 'btn-egg', 'btn-onion']) $(id).disabled = !(on || this.phase === 'rest');
      // the senses act on the selected patty, on the metal or resting; the hand only needs a stove
      const canSense = (on || this.phase === 'rest') && !!p && (where === 'pan' || where === 'rest') && !it;
      $('btn-presstest').disabled = !canSense; $('btn-peek').disabled = !canSense;
      $('btn-hand').disabled = !(on || this.phase === 'rest');
      $('btn-probe').disabled = !(inPan || (p && ['rest', 'oven'].includes(where))) || this.hard; // hard mode: no thermometers at all
      $('ro-probe').disabled = $('btn-probe').disabled;
      this.syncProbe();
      $('btn-wash').disabled = !on || this.inPan().length > 0 || this.items.some((q) => q.where === 'pan'); $('btn-wipe').disabled = !on;
      // the fire: wood and coals go on any time there is a kettle, ash only comes out of a cold one
      if (this.state.grill) {
        const g = this.state.grill, live = on || this.phase === 'rest';
        $('btn-wood').disabled = !live; $('btn-coals').disabled = !live; $('btn-stir').disabled = !live;
        $('btn-emptyash').disabled = !live || g.Tfire > 60 || this.state.pan.T > 60 || (g.ash + g.ashBowl) < 1e-4;
      }
      $('e-stove').disabled = $('e-pan').disabled = this.anyPlaced() || this.items.length > 0;
      if (this.state.grill) { $('btn-fat').disabled = true; }
      $('btn-cut').disabled = !this.patties.length || this.patties.some(q => (this.mode==='service'&&q.extraFor!=null&&q.assembledTo==null)||q.where === 'board' || q.where === 'oven' || (q.assembly?.length && (!A.hasPatty(q) || (q.assembly.some(l=>l.item?.half==='bottom') && !A.closed(q))))) || this.inPan().length > 0 || this.items.some((q) => q.where === 'pan');
    }
    // ------------------------------------------------------------ loop
    frame(now) {
      if(['choose','real'].includes(document.body.dataset.experience)){this.last=now;requestAnimationFrame(t=>this.frame(t));return;}
      if (this.noticeUntil && now >= this.noticeUntil) { $('kitchen-notice').hidden = true; this.noticeUntil = 0; }
      const visualDt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
      const real = this.stopped ? 0 : visualDt; this.last = now;
      const st = this.state;
      const active = this.phase === 'cook' || this.phase === 'rest';
      // The ticket clock runs from “yes chef” to the moment the plates go out, in the same kitchen
      // seconds the simulation steps in — forming counts, and 8× does not make you faster.
      if (this.ticketTiming && this.phase !== 'order' && this.phase !== 'result') { this.ticketClock += real * this.speed; this.updateTicketClock(); }
      if (active || this.stoveUsed) {
        // Once the stove has been used it keeps running between tickets, so the pan cools (or
        // keeps heating, if the burner was left on) while the next patty is being formed.
        this.acc += real * this.speed;
        // `real` is already capped at 0.1 s, so at 8× speed this is at most 16 steps; the 200-step
        // ceiling is the backstop for a tab that has been asleep, and dropping the remainder there
        // keeps a slow frame from snowballing into a slower one.
        let n = 0;
        while (this.acc >= DT && n < 200) { P.step(st, DT); this.acc -= DT; n++; }
        if(this.selItem&&!st.items.includes(this.selItem)) {this.selItem=null;P.selectItem(st,null);this.refreshButtons();}
        if (n >= 200) this.acc = 0;
        this.audio.update(st.diag, st.stove.knob / 10, real);
        if (active) {
          this.updateProbe(real * this.speed);
          this.updateHUD();
          this.updateLog();
          this.updateChips();
          this.btnClock = (this.btnClock || 0) + real; if (this.btnClock > 0.5) { this.btnClock = 0; this.refreshButtons(); } // smash/empty-ash follow the physics, not only clicks
          if (this.phase === 'rest') { const p = this.patty; $('rest-t').textContent = P.fmtTime(p ? p.restT || 0 : st.rest.t); $('rest-c').textContent = this.hard || !p ? '—' : this.tempText(fmt(P.centerT(p), 1) + ' °C'); }
        }
      } else {
        this.audio.update({ sizzle: 0, spatter: 0 }, 0, real);
      }
      this.autosaveClock += real;
      this.updateCues(now);
      if (this.autosaveClock >= 15) { this.autosaveClock = 0; this.saveSession(true); }
      const viewState = this.phase === 'form' ? this.stateForPreview : this.phase === 'order' ? (this.stateForPreview || P.createState({})) : st;
      if (this.phase === 'form' || this.phase === 'order') { viewState.diag = viewState.diag || {}; viewState.where = 'board'; }
      this.vp.setProbe(this.probe.inserted && !!this.state.patty && (this.phase === 'cook' || this.phase === 'rest'), this.probe.depth);
      viewState.room=P.roomAir(st);
      this.vp.update(viewState, real, visualDt);
      // Position the food first, then ease the camera toward its new station.
      this.followSelectedFood();
      if (this.cameraPreset) { this.vp.controls.preset(this.cameraPreset); this.cameraPreset = null; }
      requestAnimationFrame((t) => this.frame(t));
    }
    followSelectedFood() {
      if (!['cook', 'rest'].includes(this.phase)) { this.cameraFood = null; return; }
      const food = this.selItem || this.patty;
      if (!food) { this.cameraFood = null; return; }
      if (food !== this.cameraFood || food.where !== this.cameraFoodWhere) {
        this.cameraFood = food; this.cameraFoodWhere = food.where;
        this.cameraPreset = food.where === 'oven' ? 'oven' : food.where === 'rest' || food.where === 'cut' ? 'serve' : 'default';
      }
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
      const air=P.roomAir(this.state);
      $('btn-window').textContent=air.windowOpen?'Close window':'Open window';
      $('btn-window').setAttribute('aria-pressed',String(air.windowOpen));
      $('btn-window').title=air.windowOpen?'Fresh air is clearing the room':air.upper+air.lower>.35?'Smoke is gathering — open the window to clear the room':'Ventilate the kitchen';
      const where = p ? p.where : 'board';
      const irTemperature = st.grill ? st.pan.T : st.pan.Tcenter;
      $('h-pan').textContent = this.hard ? '—' : fmt(irTemperature + (Math.random() - 0.5) * 1.5, 0) + ' °C';
      const oven = st.oven;
      $('oven-temp').value = String(oven ? oven.target : 0);
      $('oven-status').hidden = !oven || (!oven.target && !this.patties.some(q => q.where === 'oven') && oven.T < 40);
      $('oven-status').textContent = oven ? `Oven · ${oven.T.toFixed(0)} °C · ${oven.target ? 'set ' + oven.target + ' °C' : 'off'}${this.patties.some(q => q.where === 'oven') ? ' · cooking' : ''}` : 'Oven off';
      $('h-time').textContent = p && where === 'oven' ? 'oven ' + P.fmtTime(p.ovenTime || 0) : p && where === 'pan' ? P.fmtTime(p.cookTime) : p && (where === 'rest' || where === 'cut') ? 'rest ' + P.fmtTime(p.restT || 0) : P.fmtTime(st.t);
      $('h-probe').textContent = this.probe.reading == null ? '—' : fmt(this.probe.reading, 1) + ' °C';
      const it = this.selItem;
      $('h-side').textContent = it
        ? `${it.label} · ${P.itemState(it).state}${it.where === 'pan' ? ` · ${this.hard ? '' : fmt(P.itemT(it), 0) + ' °C · '}${P.fmtTime(it.timeDown)} this side` : it.burger ? ` · on burger ${it.burger}` : ' · at the pass'}`
        : p && where === 'pan' ? `${this.patties.length > 1 ? `patty ${p.id} · ` : ''}face ${p.faceDown.id} down · ${P.fmtTime(p.timeDown)} this side` : '';
      if (st.grill && (st.grill.bank || 0) > 0.05 && !this.hard) {
        $('h-pan').textContent = `${fmt(st.grill.Thot, 0)} / ${fmt(st.grill.Tcool, 0)} °C`;
        $('h-pan-label').textContent = 'IR gun · hot / cool';
      } else $('h-pan-label').textContent = st.grill ? 'IR gun · grate' : 'IR gun · pan centre';
      // the kettle's own readout: what is left of the fire, what is choking it, and what is coming
      // off it. The bed temperature is a number, so hard mode does not get it — the hand test does.
      $('ro-fire').hidden = !st.grill;
      if (st.grill) {
        const g = st.grill;
        const wood = g.woods.filter((w) => w.m > 1e-6);
        const smk = P.smokeName(st);
        $('h-fire').textContent = `${this.hard ? '—' : fmt(g.Tfire, 0) + ' °C'} · ${fmt(g.coal * 1000, 0)} g coal${g.unlit > 0.001 ? ` (+${fmt(g.unlit * 1000, 0)} g unlit)` : ''} · ${fmt((g.ash + g.ashBowl) * 1000, 0)} g ash`
          + (wood.length ? ` · ${wood.length > 1 ? `${wood.length} × ` : ''}${wood[0].spec.name.toLowerCase()}` : '')
          + (smk ? ` · ${smk}` : '') + (st.lid ? ` · lid vent ${fmt(g.topVent * 100, 0)} %` : '');
        $('h-fire-label').textContent = this.hard ? 'the fire (no numbers)' : 'bed · coal · ash';
      }
      $('h-smoke').hidden = d.smoke < 0.25; $('h-smoke').textContent = d.smoke > 1.2 ? 'Heavy smoke' : 'Smoking';
      $('h-lid').hidden = !st.lid;
      // inspector
      if (!$('inspector').hidden) {
        const rows = [];
        const add = (k, v) => rows.push(`<tr><td>${k}</td><td>${v}</td></tr>`);
        if (st.grill) {
          const g = st.grill;
          // hard mode takes the thermometers away, and the bed's temperature is a thermometer
          add('Coal bed', (this.hard ? '— °C' : fmt(g.Tfire, 0) + ' °C') + ' · ' + fmt(g.coal * 1000, 0) + ' g of charcoal left'
            + (g.unlit > 0.001 ? ` · ${fmt(g.unlit * 1000, 0)} g unlit at ${this.hard ? '—' : fmt(g.unlitT, 0) + ' °C'}` : '') + ' · burning ' + fmt(st.stove.pDelivered / 1000, 1) + ' kW');
          add('Ash', fmt(g.ash * 1000, 0) + ' g in the bed · ' + fmt(g.ashBowl * 1000, 0) + ' g in the bowl · draught ' + fmt(g.air, 2)
            + ' of full' + (g.stir > 0.01 ? ` · just raked (${fmt(g.stir, 2)})` : ''));
          add('Vents', 'bottom ' + fmt(st.stove.knob * 10, 0) + ' % · lid ' + fmt(g.topVent * 100, 0) + ' %' + (st.lid ? ` · in series: ${fmt(P.ventFlow(st) * 100, 0)} % open` : ' (lid off: the top vent does nothing)'));
          const wood = g.woods.filter((w) => w.m > 1e-6);
          add('Wood', wood.length
            ? wood.map((w) => `${w.spec.name} ${fmt(w.m * 1000, 0)} g of ${fmt(w.m0 * 1000, 0)} · ${this.hard ? '—' : fmt(w.T, 0) + ' °C'} · ${w.water > 1e-6 ? `${fmt(w.water * 1000, 1)} g of water still in it` : 'dry'} · ${fmt(w.smoke * 1e6, 2)} mg/s`).join('<br>')
            : 'nothing on the coals');
          add('Smoke under the dome', fmt(g.smokeConc * 1e6, 0) + ' mg/m³ · ' + (P.smokeName(st) || 'clear') + ' · combustion ' + fmt(g.comb, 2));
          if (p && p.grilled) { const sr = P.smokeRead(p); add('Smoke on the patty', fmt(sr.smokiness, 2) + ' smokiness · ' + fmt(sr.creosote, 2) + ' creosote' + (sr.wood ? ' · mostly ' + sr.wood : '')); }
          add('Flare / fat on the coals', fmt(g.flare, 2) + ' · ' + fmt(g.fatOnCoals * 1000, 2) + ' g');
          add('Bed raked', fmt((g.bank || 0) * 100, 0) + ' % to one side' + ((g.bank || 0) > 0.05 ? ` · bars ${fmt(g.Thot, 0)} °C over the coals, ${fmt(g.Tcool, 0)} °C off them` : ' (spread flat)'));
          add('Dome air', (this.hard ? '—' : fmt(g.Tdome, 0) + ' °C') + (st.lid ? ' (lid on)' : ''));
        } else add('Burner power to pan', fmt(st.stove.pDelivered, 0) + ' W');
        add(st.grill ? 'Grate temperature' : 'Pan temperature', fmt(st.pan.T, 1) + ' °C mean · centre ' + fmt(st.pan.Tcenter, 0) + ' °C · edge ' + fmt(st.pan.Tedge, 0) + ' °C');
        add('Oil / fat in pan', fmt(st.pan.oil * 1000, 1) + ' g' + (st.pan.oilKind !== 'none' ? ` (${st.pan.oilKind})` : ''));
        add('Water on pan', fmt(st.pan.water * 1000, 2) + ' g');
        add('Fond', fmt(st.pan.fond * 1000, 1) + ' (burnt ' + fmt(st.pan.fondBurnt * 1000, 1) + ')');
        if (p && where !== 'board') {
          if (this.patties.length > 1) add('Selected patty', `${p.id} of ${this.patties.length} (${this.label(p.target)})`);
          add('Heat flux into meat', fmt(d.panQ, 0) + ' W · h = ' + fmt(d.hc, 0) + ' W/m²K');
          add('Bottom surface / bottom cell', fmt(p.surfT, 0) + ' / ' + fmt(p.T[0], 0) + ' °C');
          add('Centre / top', fmt(P.centerT(p), 1) + ' / ' + fmt(P.cellT(p, p.Nz - 1, 0), 1) + ' °C');
          add('Centre / edge at mid-height', fmt(P.centerT(p), 1) + ' / ' + fmt(P.cellT(p, Math.floor(p.Nz / 2), p.Nr - 1), 1) + ' °C');
          add('Peak centre so far', fmt(p.peakCenter, 1) + ' °C → ' + P.donenessOf(p.peakCenter).label);
          { const f = P.firmness(p); add('Firmness under a finger', fmt(f.index, 2) + ' (' + fmt(f.E / 1000, 1) + ' kPa) · ' + P.firmnessWord(f.index).word); }
          { const h = P.handTest(st, p.where === 'pan' ? p.pos : null); add('Hand over the metal', fmt(h.seconds, 1) + ' s · ' + h.word + ' · ' + fmt(h.flux / 1000, 1) + ' kW/m² (' + fmt(h.radiant / 1000, 1) + ' radiant)'); }
          add('Sizzle: boil / fry / roar', fmt(d.boilNoise, 2) + ' / ' + fmt(d.hiss, 2) + ' / ' + fmt(d.roar, 2) + ' · contact ' + fmt(d.contact, 2));
          if (p.slits || p.pressTests) add('Cuts / press tests', `${p.slits} · ${p.pressTests} (${fmt((p.lostWaterCut + p.pressTestJuice) * 1000, 2)} g of juice between them)`);
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
        $('insp-table').innerHTML = this.tempText(rows.join(''));
        this.drawChart($('chart'), st.trace);
      }
      for (const id of ['h-pan','h-probe','h-side','h-fire','oven-status']) $(id).textContent = this.tempText($(id).textContent);
      if (this.senseNote) $('h-sense-v').textContent = this.tempText(this.senseNote);
    }
    /** Hard mode has no thermometers, so nothing the game writes gets to quote one either. */
    maskT(t) { return this.tempText(this.hard ? String(t).replace(/(?:[-−]?\d+(?:\.\d+)?\s*[–—-]\s*)?[-−]?\d+(?:\.\d+)?\s*°C/g, '·· °C') : t); } // a range (“60–63 °C”) goes as one
    updateLog() {
      const ev = this.state.events; const el = $('log');
      if (this.logN === ev.length) return; this.logN = ev.length;
      el.innerHTML = ev.slice(-14).map((e) => `<div class="ev ${e.kind}"><span>${P.fmtTime(e.t)}</span>${this.maskT(e.text)}</div>`).join('');
      el.scrollTop = el.scrollHeight;
    }
    buildLayer(key) {
      const p = this.patty; if (!p) return false;
      if(key==='extra') return this.addSecondPatty();
      if(p.where!=='rest') return false;
      let ok;
      if (key === 'undo') ok = A.pop(p);
      else if (key === 'unpack') { A.unpack(p); ok = true; }
      else ok = A.add(this.state,p,key.startsWith('item:') ? Number(key.slice(5)) : key);
      if (!ok) return false;
      this.selItem = null; P.selectItem(this.state,null);
      this.vp.forceTex = true; this.cameraPreset = 'serve';
      this.refreshButtons(); this.updateChips();
      return true;
    }
    renderAssembly() {
      const p = this.patty, el = $('assembly-controls');
      if (!p) { el.innerHTML = ''; return; }
      const stack = A.layers(p), closed = A.closed(p), ready = p.where === 'rest' && p.assembledTo==null;
      const button = (key,label,disabled=false,icon='') => `<button data-build="${key}" ${disabled?'disabled':''}>${icon ? `<img alt="" src="assets/icons/${icon}.svg">` : ''}${label}</button>`;
      let html = '<div class="assembly-burgers">' + this.patties.map((q,i) => button('select:'+i,q.extraFor!=null?`Second patty → ${q.extraFor}`:`Burger ${i+1}`,i===this.sel)).join('') + '</div>';
      html += `<p class="assembly-hint">${p.assembledTo!=null ? 'In burger '+p.assembledTo+'. Select that burger to undo or unpack.' : !ready ? 'Rest this patty before building.' : closed ? 'Closed. Ready for the pass.' : 'Stack from the bottom up. Undo lifts the last layer.'}</p>`;
      html += '<ol class="assembly-stack">' + stack.map(l => `<li>${A.label(l)}</li>`).join('') + '</ol>';
      if (!stack.length) html += '<p class="assembly-empty">Your plate is empty.</p>';
      html += '<div class="assembly-edit">'+button('undo','Undo layer',!ready||!stack.length)+button('unpack','Unpack',!ready||!stack.length)+'</div>';
      html += '<h3>From the pass</h3><div class="assembly-options">';
      html += button('patty','Patty',!ready||closed||stack.some(l=>l.patty&&!l.meat),'burger');
      for(const q of this.patties.filter(q=>q!==p && q.where==='rest' && q.assembledTo==null && !A.layers(q).length && (this.mode==='practice'||q.extraFor===p.id)))
        html+=button('patty:'+q.id,'Second patty · '+q.id,!ready||closed||!A.hasPatty(p)||stack.filter(l=>l.patty).length>=2,'burger');
      html+=button('extra','Form second patty',p.assembledTo!=null||p.extraFor!=null||stack.filter(l=>l.patty).length>=2||this.patties.some(q=>q.extraFor===p.id)||this.patties.length>=(this.mode==='practice'?4:6),'burger');
      for (const it of this.items.filter(it => it.where === 'rest' && it.assembledTo == null)) {
        const bottom = it.kind === 'bun' && it.half === 'bottom', top = it.kind === 'bun' && it.half === 'top';
        const blocked = !ready || closed || (bottom ? stack.length>0 : top ? !A.hasPatty(p)||!stack.some(l=>l.item?.pair===it.pair&&l.item.half==='bottom') : !stack.length);
        html += button('item:'+it.id,it.kind==='bun'?`${it.half==='top'?'Top':'Bottom'} bun · ${it.pair}`:it.spec.short+' · '+it.id,blocked,it.kind==='onions'?'onion':it.kind);
      }
      html += '</div><h3>Fresh & sauces</h3><div class="assembly-options">';
      for (const [key,spec] of Object.entries(A.cold)) html += button(key,spec.label,!ready||closed||!stack.length||stack.filter(l=>l.cold===key).length>=(spec.sauce?1:4),key);
      html += '</div>';
      if (el.innerHTML !== html) {
        const key = el.contains(document.activeElement) && document.activeElement.dataset.build;
        el.innerHTML = html;
        if (key) {
          const next = el.querySelector(`[data-build="${key}"]:not(:disabled)`) || el.querySelector('[data-build="undo"]:not(:disabled)');
          if(next?.focus) next.focus({preventScroll:true}); else $('close-build').focus({preventScroll:true});
        }
      }
    }
    setDrawer(view, restoreFocus = false) {
      const previous = this.drawer;
      this.drawer = view;
      for (const name of ['heat', 'toppings', 'tools', 'build']) {
        $('drawer-' + name).hidden = name !== view;
        $('open-' + name).setAttribute('aria-expanded', String(name === view));
      }
      if (view) { $('drawer-' + view).scrollTop = 0; $('close-' + view).focus({preventScroll:true}); }
      else if (restoreFocus && previous) $('open-' + previous).focus({preventScroll:true});
    }
    updateCues(now) {
      const active = this.phase === 'cook' || this.phase === 'rest';
      const cues = this.cues.update(active ? this.patties.concat(this.items) : [], now, this.stopped);
      const escape = text => String(text).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
      const html = cues.map(c => `<div class="cook-cue ${c.level === 3 ? 'burn' : ''}" data-cue="${c.id}"><img src="assets/icons/${c.icon}.svg" alt=""><div><small>${escape(c.label)}</small><strong>${c.title}</strong></div></div>`).join('');
      if (html !== this.cuesHTML) { $('cooking-cues').innerHTML = html; this.cuesHTML = html; }
    }
    drawChart(cv, trace) {
      const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height;
      ctx.fillStyle = '#16130f'; ctx.fillRect(0, 0, W, H);
      if (trace.length < 2) return;
      const t0 = trace[0].t, t1 = trace[trace.length - 1].t; const span = Math.max(60, t1 - t0);
      ctx.fillStyle = '#c9bfae'; ctx.fillText(this.fahrenheit ? '°F' : '°C', 4, 10);
      const Tmax = 320; const X = (t) => 36 + ((t - t0) / span) * (W - 44); const Y = (T) => H - 16 - (T / Tmax) * (H - 24);
      ctx.strokeStyle = '#3a332b'; ctx.fillStyle = '#8a8070'; ctx.font = '10px sans-serif';
      for (let T = 0; T <= Tmax; T += 50) { ctx.beginPath(); ctx.moveTo(36, Y(T)); ctx.lineTo(W - 8, Y(T)); ctx.stroke(); ctx.fillText(Math.round(this.fahrenheit ? T * 1.8 + 32 : T) + '°', 4, Y(T) + 3); }
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
      const practice = this.mode === 'practice';
      $('r-mode').textContent = practice ? 'Practice cook' : 'Service';
      $('r-score-wrap').hidden = practice; $('r-breakdown').hidden = practice;
      $('r-parts').hidden = practice; $('r-notes').hidden = practice;
      $('r-details').open = practice;
      if (practice) {
        this.verdicts = null;
        $('r-bill').hidden = true; $('r-shift').hidden = true;
        $('r-grade').textContent = 'Explore the centre, crust and cooking history.';
        $('btn-again').textContent = 'Cook another';
        this.vp.controls.preset('serve'); $('inspector').hidden = true;
        this.vp.setCutaway(true); $('btn-cutaway').classList.add('on');
        this.renderResultDetails();
        return;
      }
      // What the room actually experienced: the wait, then each customer's own words about the
      // plate in front of them, the bill and what they left on it.
      const elapsed = this.ticketClock || 0, targetT = this.ticketTarget || 0;
      tk.service = { elapsed, target: targetT, penalty: P.latePenalty(elapsed, targetT) };
      this.verdicts = tk.results.map((r) => r.patty.assembledTo!=null ? null : P.verdict(r.plateVerdict||r, tk));
      const plateVerdicts=this.verdicts.filter(Boolean);
      const sentBack = plateVerdicts.filter((v) => v.outcome === 'sent back');
      // A plate that goes back is comped: it is off the bill, and nobody tips on it.
      const bill = plateVerdicts.reduce((a, v) => a + (v.outcome === 'sent back' ? 0 : v.bill), 0);
      const tips = plateVerdicts.reduce((a, v) => a + v.tipAmount, 0);
      const points = sentBack.length ? 0 : P.clamp(Math.round(tk.total - tk.service.penalty), 0, 100);
      // what the card remembers this ticket by: the plate that went back if one did, else the lowest
      const worst = sentBack[0] || plateVerdicts.reduce((a, v) => (v.score < a.score ? v : a), plateVerdicts[0]);
      this.recordTicket({
        n: (this.shift ? this.shift.n : 0) + 1, who: this.ticket.who, labels: this.ticket.items.map((id) => SHORT[id]).join(' + '),
        points, tips, bill, covers: plateVerdicts.length, elapsed, target: targetT, penalty: tk.service.penalty,
        sentBack: sentBack.length > 0, quote: worst ? worst.quote : '',
      });
      const sh = this.shift;
      $('r-bill').hidden = false;
      $('r-bill').innerHTML = `<b>Bill</b> ${plateVerdicts.map((v) => `${v.billLines[0].what} ${money(v.bill)}${v.outcome === 'sent back' ? ' <em>comped</em>' : ''}`).join(' · ')} — total <b>${money(bill)}</b>, tip <b>${money(tips)}</b>${bill > 0 ? ` (${((tips / bill) * 100).toFixed(0)} %)` : ''}`;
      $('r-shift').hidden = false;
      $('r-shift').innerHTML = `<b>Shift</b> ticket ${sh.n} of ${SHIFT_LEN} · this ticket <b>${points}</b>` +
        (sentBack.length ? ' <em>(sent back — the ticket scores nothing)</em>' : tk.service.penalty >= 0.5 ? ` (${tk.total} − ${tk.service.penalty.toFixed(0)} for going out ${P.fmtTime(elapsed)} against ${P.fmtTime(targetT)})` : ` in ${P.fmtTime(elapsed)} of ${P.fmtTime(targetT)}`) +
        ` · running total <b>${sh.points}</b> · tips <b>${money(sh.tips)}</b>`;
      $('btn-again').textContent = sh.n >= SHIFT_LEN ? 'Finish the shift →' : 'Next ticket';
      const card = $('results').querySelector('.card'); if (card) card.scrollTop = 0;  // start every ticket's verdict at the top, not where the last one was left
      this.vp.controls.preset('serve'); $('inspector').hidden = true;
      this.vp.setCutaway(true); $('btn-cutaway').classList.add('on');
      $('r-score').textContent = tk.total;
      // the kitchen's one-line grade agrees with the customer: a plate that went back (under 45 on
      // its own score, or anything raw or burnt on the build) is "sent back" whatever the ticket total
      const anyBack = this.verdicts && this.verdicts.some((v) => v && v.outcome === 'sent back');
      $('r-grade').textContent = anyBack ? (tk.total >= 55 ? 'Sent back — over the build, not the meat.' : 'Sent back.') : tk.total >= 90 ? 'Line-cook royalty' : tk.total >= 75 ? 'Solid. They will come back.' : tk.total >= 55 ? 'Edible. Nobody complained out loud.' : tk.total >= 45 ? 'They ate it. They will not be back.' : 'The customer left. So did the smoke alarm.';
      this.renderResultDetails();
    }
    /** Re-render the result fields whose contents depend on Hard mode. */
    renderResultDetails() {
      const tk = this.ticketResult; if (!tk) return;
      const many = tk.results.length > 1;
      $('r-chips').hidden = !many;
      if (this.mode === 'practice') {
        $('r-chips').innerHTML = many ? tk.results.map((r, i) => `<button class="chip${i === this.sel ? ' on' : ''}" data-chip="${i}">Patty ${i + 1} · ${r.got.label}</button>`).join('') : '';
        $('r-ticket').hidden = true;
        this.showPattyResult();
        return;
      }
      if (many) {
        $('r-chips').innerHTML = tk.results.map((r, i) => `<button class="chip${i === this.sel ? ' on' : ''}" data-chip="${i}"><b>${i + 1}</b> ${r.target.label} <small>${r.total}/100</small></button>`).join('');
        $('r-ticket').hidden = false;
        $('r-ticket').innerHTML = `<b>Ticket:</b> ${tk.results.map((r) => r.total).join(' + ')} → mean ${tk.mean}${tk.coldPenalty ? ` − ${tk.coldPenalty} for burgers that went out cold` : ''}${tk.buildPenalty ? ` − ${tk.buildPenalty} for the build` : ''}${tk.buildBonus ? ` + ${tk.buildBonus} for the toppings` : ''}` + (tk.notes.length ? `<ul>${tk.notes.map((n) => `<li>${this.maskT(n)}</li>`).join('')}</ul>` : '');
      } else {
        const line = tk.buildPenalty || tk.buildBonus ? `<b>Ticket:</b> ${tk.mean}${tk.buildPenalty ? ` − ${tk.buildPenalty} for the build` : ''}${tk.buildBonus ? ` + ${tk.buildBonus} for the toppings` : ''} → ${tk.total}` : '';
        $('r-ticket').hidden = tk.notes.length === 0 && !line;
        $('r-ticket').innerHTML = line + (tk.notes.length ? `<ul>${tk.notes.map((n) => `<li>${this.maskT(n)}</li>`).join('')}</ul>` : '');
      }
      this.showPattyResult();
    }
    showPattyResult() {
      const st = this.state, tk = this.ticketResult; if (!tk || !tk.results.length) return;
      const r = tk.results.find((x) => x.patty === this.patty) || tk.results[0]; this.result = r;
      for (const b of $('r-chips').querySelectorAll('[data-chip]')) b.classList.toggle('on', Number(b.dataset.chip) === this.sel);
      const target = r.target;
      // The customer's own words about this plate, above the kitchen's rubric.
      const v = this.verdicts && this.verdicts[tk.results.indexOf(r)];
      const box = $('r-customer'); box.hidden = !v;
      if (v) {
        const cls = v.outcome === 'sent back' ? 'sent' : v.outcome;
        // nobody compliments a plate they are sending back, however juicy the raw middle was
        const said = v.complaints.slice(0, 4).map((c) => `<li>${this.maskT(c.text)}</li>`).concat(v.outcome === 'sent back' ? [] : v.praise.slice(0, 2).map((g) => `<li class="good">${this.maskT(g.text)}</li>`));
        box.innerHTML = `<p class="quote">${this.maskT(v.quote)}</p>` +
          `<span class="outcome ${cls}">${v.outcome}</span> ` +
          // the ticket's bill is printed below; per plate it is only worth repeating when there are several
          `<span class="muted">${v.outcome === 'sent back' ? 'comped — no tip' : tk.results.length > 1 ? `their share: tip ${money(v.tipAmount)} on ${money(v.bill)} (${(v.tip * 100).toFixed(0)} %)` : ''}${v.late && v.late.penalty >= 0.5 ? ` · waited ${P.fmtTime(v.late.elapsed)}` : ''}</span>` +
          `<details class="customer-notes"><summary>Kitchen feedback</summary><ul>${said.join('')}</ul></details>`;
      }
      const prefix = tk.results.length > 1 ? `Patty ${this.sel + 1}: ` : '';
      // The band the ticket is scored against is tighter than the band the eye calls a doneness, so
      // a plate can miss the order by a fraction of a degree and still be the doneness ordered —
      // "Over: medium-rare when they wanted medium-rare" is not a sentence. Name the edge instead.
      // No temperature here: hard mode reads this line too.
      $('r-verdict').textContent = this.mode === 'practice' ? prefix + r.got.label : prefix + (r.dist === 0 ? `${target.label}. Exactly what they asked for.`
        : r.got.id === target.id ? `${target.label}, but right on the ${r.peak < target.lo ? 'bottom' : 'top'} edge of the band.`
        : r.peak < target.lo ? `Under: ${r.got.label.toLowerCase()} when they wanted ${target.label.toLowerCase()}.`
        : `Over: ${r.got.label.toLowerCase()} when they wanted ${target.label.toLowerCase()}.`);
      const parts = r.parts;
      $('r-parts').innerHTML = [['Doneness', parts.doneness, 50], ['Crust', parts.crust, 20], ['Juiciness', parts.juiciness, 15], ['Evenness', parts.evenness, 10], ['Structure', parts.structure, 5]]
        .map(([k, v, m]) => `<div class="bar"><span>${k}</span><i><b style="width:${(v / m) * 100}%"></b></i><em>${v}/${m}</em></div>`).join('');
      // Hard mode is no thermometers all the way through, including the post-mortem: the plate tells
      // you what it landed on in words (and the cutaway shows you), but never what the number was.
      $('r-stats').innerHTML = [
        ['Peak centre temperature', this.hard ? `— · it came out ${r.got.label.toLowerCase()}` : `${r.peak.toFixed(1)} °C (${r.got.label})`],
        ['Ordered', this.hard ? target.label : `${target.label} (${target.lo}–${target.hi} °C)`],
        ['Cooking / resting', `${P.fmtTime(r.cookTime)} / ${P.fmtTime(r.restTime)}, ${r.flips} flip${r.flips === 1 ? '' : 's'}`],
        ['Mass', `${(r.massStart * 1000).toFixed(0)} g → ${(r.massEnd * 1000).toFixed(0)} g (−${((1 - r.massEnd / r.massStart) * 100).toFixed(0)} %)`],
        ['Water', `${(r.waterRetained * 100).toFixed(0)} % retained · ${(r.waterEvap * 1000).toFixed(1)} g steamed off · ${(r.waterDrip * 1000).toFixed(1)} g ran out`],
        ['Fat rendered into the pan', `${(r.fatLost * 1000).toFixed(1)} g`],
        ['On the bun', r.patty.assembledTo!=null ? `Part of burger ${r.patty.assembledTo}` : r.patty.bunFaces && r.patty.bunFaces.bottom ? `${r.cheeseSlices ? r.cheeseSlices + ' slice' + (r.cheeseSlices > 1 ? 's' : '') + ' of cheese · ' : ''}${(r.bunSoak * 1000).toFixed(1)} g of juice into the bottom bun` : 'No bottom bun served'],
        ['Crust (browning index / char)', `A: ${r.faces.down.id === 'A' ? r.faces.down.brown.toFixed(1) : r.faces.up.brown.toFixed(1)} / ${(r.faces.down.id === 'A' ? r.faces.down.char : r.faces.up.char).toFixed(2)} · B: ${r.faces.down.id === 'B' ? r.faces.down.brown.toFixed(1) : r.faces.up.brown.toFixed(1)} / ${(r.faces.down.id === 'B' ? r.faces.down.char : r.faces.up.char).toFixed(2)}`],
        ['Grey band', `${(r.overFrac * 100).toFixed(0)} % of the meat cooked past target`],
        // the smoke line only exists if it was cooked over a fire
        ...(r.patty && r.patty.grilled ? [['Smoke', r.smokiness < 0.05 ? 'None: bare charcoal, no wood on it'
          : `${r.smokiness.toFixed(2)} deposited${r.smokeWood ? ` (mostly ${r.smokeWood})` : ''}${r.creosote > 0.15 ? ` · ${r.creosote.toFixed(2)} of it creosote off smothered smoke` : ' · clean'}`
            + (r.smokeBonus > 0.05 ? `<br><span class="bon">+ ${r.smokeBonus.toFixed(1)} of the crust mark</span>` : '')
            + (r.smokePenalty > 0.05 ? `<br><span class="pen">− ${r.smokePenalty.toFixed(1)} of the crust mark</span>` : '')]] : []),
        ['Senses used', [
          r.peeks ? `cut into it ${r.peeks === 1 ? 'once' : r.peeks === 2 ? 'twice' : r.peeks + ' times'} — ${(r.cutJuice * 1000).toFixed(1)} g of juice out of the cut, and a slit in the burger` : null,
          r.pressTests ? `${r.pressTests} press test${r.pressTests > 1 ? 's' : ''} — ${(r.pressJuice * 1000).toFixed(2)} g` : null,
        ].filter(Boolean).join('<br>') || 'None: never pressed, never cut.'],
        ['Build', r.patty.assembledTo!=null ? `Second patty in burger ${r.patty.assembledTo}` : r.build.items.length
          ? r.build.items.map((b) => `${b.label} — <b>${b.state}</b>`).join('<br>') + (r.build.penalty ? `<br><span class="pen">− ${r.build.penalty.toFixed(1)} on the ticket</span>` : '') + (r.build.bonus ? `<br><span class="bon">+ ${r.build.bonus.toFixed(1)} on the ticket</span>` : '')
          : 'Nothing on it but the patty'],
      ].filter(([k]) => this.mode !== 'practice' || !['Ordered', 'Grey band'].includes(k)).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
      $('r-stats').innerHTML = this.tempText($('r-stats').innerHTML);
      $('r-notes').innerHTML = r.notes.map((n) => `<li>${this.maskT(n)}</li>`).join('');
      // the two charts are thermometer traces with a °C axis, so hard mode does not get them either
      if (!this.hard) { this.drawChart($('r-chart'), st.trace); this.drawProfile($('r-profile'), r.patty || st.patty); }
    }
    drawProfile(cv, p) {
      const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height; ctx.fillStyle = '#16130f'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#c9bfae'; ctx.fillText(this.fahrenheit ? '°F' : '°C', 4, 10);
      const N = p.Nz; const Tmax = 110;
      const X = (i) => 36 + (i / (N - 1)) * (W - 44); const Y = (T) => H - 16 - (T / Tmax) * (H - 24);
      ctx.strokeStyle = '#3a332b'; ctx.fillStyle = '#8a8070'; ctx.font = '10px sans-serif';
      for (let T = 0; T <= 100; T += 25) { ctx.beginPath(); ctx.moveTo(36, Y(T)); ctx.lineTo(W - 8, Y(T)); ctx.stroke(); ctx.fillText(Math.round(this.fahrenheit ? T * 1.8 + 32 : T) + '°', 4, Y(T) + 3); }
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
