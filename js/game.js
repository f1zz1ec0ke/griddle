/*
 * game.js — phases, UI wiring and the simulation loop.
 *   order → form (build the patty) → cook (stove) → rest → result
 */
(function (root) {
  'use strict';
  const P = root.BurgerPhysics;
  const $ = (id) => document.getElementById(id);
  const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(d));
  const DT = 0.025;

  const ORDERS = [
    { id: 'rare', who: 'Table 3', line: '“Rare. Like, actually rare. I will send it back.”' },
    { id: 'medium-rare', who: 'Table 7', line: '“Medium-rare, please, and a good crust on it.”' },
    { id: 'medium', who: 'The regular at the bar', line: '“Medium. Warm pink centre, not red, not grey.”' },
    { id: 'medium-well', who: 'Table 12', line: '“Medium-well — just a hint of pink.”' },
    { id: 'well-done', who: 'A dad', line: '“Well done. No pink. Don\'t burn it though.”' },
  ];

  class Game {
    constructor() {
      this.vp = new root.BurgerRender.Viewport($('view'));
      this.audio = new root.KitchenAudio();
      this.speed = 1; this.phase = 'order'; this.hard = false;
      this.probe = { inserted: false, depth: 0.5, reading: null, settle: 0 };
      this.form = { massG: 150, thicknessMm: 20, blend: '80/20', temp: 'fridge', work: 0.35, dimple: true, salt: 'surface' };
      this.equip = { stove: 'gas', pan: 'castiron', fat: 'canola', fatG: 8 };
      this.state = P.createState({ pan: this.equip.pan, stove: this.equip.stove });
      this.bind();
      this.newOrder();
      this.last = performance.now(); this.acc = 0;
      requestAnimationFrame((t) => this.frame(t));
    }
    // ------------------------------------------------------------ orders & phases
    newOrder() {
      this.order = ORDERS[Math.floor(Math.random() * ORDERS.length)];
      const d = P.DONENESS.find((x) => x.id === this.order.id);
      $('order-who').textContent = this.order.who;
      $('order-line').textContent = this.order.line;
      $('order-target').textContent = d.label.toUpperCase();
      $('order-range').textContent = `${d.lo}–${d.hi} °C at the centre after resting`;
      $('ticket-target').textContent = d.label;
      this.setPhase('order');
    }
    setPhase(ph) {
      this.phase = ph;
      document.body.dataset.phase = ph;
      for (const el of document.querySelectorAll('[data-phase]')) el.hidden = el.dataset.phase.split(' ').indexOf(ph) < 0;
      if (ph === 'form') { this.vp.setMode('board'); this.rebuildPreview(); }
      if (ph === 'cook') { this.vp.setMode('stove'); }
      if (ph === 'result') { this.showResults(); }
      this.refreshButtons();
    }
    rebuildPreview() {
      const f = this.form;
      const temp = { fridge: 4, room: 18, frozen: -18 }[f.temp];
      const blend = P.BLENDS.find((b) => b.id === f.blend);
      this.preview = P.makePatty({ massG: f.massG, thicknessMm: f.thicknessMm, fatFrac: blend.fat, tempC: temp, dimple: f.dimple, work: f.work, salt: f.salt });
      const p = this.preview;
      $('f-diam').textContent = `${(p.D * 100).toFixed(1)} cm`;
      $('f-density').textContent = `${p.rho0.toFixed(0)} kg/m³ (${(p.voids * 100).toFixed(0)} % air)`;
      $('f-water').textContent = `${(p.w0 * p.N * 1000).toFixed(0)} g water · ${(p.fat0 * p.N * 1000).toFixed(0)} g fat · ${(p.p[0] * p.N * 1000).toFixed(0)} g protein`;
      $('f-nodes').textContent = `${p.N} layers × ${(p.h0 / p.N * 1000).toFixed(2)} mm`;
      const alpha = 0.45 / (p.rho0 * 3300);
      const tHalf = ((p.h0 / 2) ** 2) / alpha;
      $('f-time').textContent = `~${(tHalf / 60 * 0.6).toFixed(0)}–${(tHalf / 60 * 0.9).toFixed(0)} min total (thermal diffusion estimate)`;
      $('f-warn').textContent = f.temp === 'frozen' ? 'Frozen: the outside will be well done before the middle thaws.' : f.thicknessMm < 10 ? 'This thin, it is a smash patty. There will be no pink centre whatever you do.' : f.thicknessMm > 32 ? 'Very thick: expect a wide grey band unless you flip often and keep the pan moderate.' : '';
      const board = this.stateForPreview || (this.stateForPreview = P.createState({}));
      board.patty = p; board.where = 'board';
      this.vp.setPatty(p);
    }
    startCook() {
      this.state = P.createState({ pan: this.equip.pan, stove: this.equip.stove });
      this.vp.setPan(this.equip.pan); this.vp.clearStains();
      this.patty = this.preview; this.state.patty = null; // stays on the board until placed
      this.placed = false; this.vp.setPatty(null);
      this.probe = { inserted: false, depth: 0.5, reading: null, settle: 0 };
      this.chart = [];
      $('log').innerHTML = '';
      P.logEvent(this.state, `Order: ${P.DONENESS.find((d) => d.id === this.order.id).label}. Patty is on the board; the pan is cold (${this.state.pan.T.toFixed(0)} °C).`, 'info');
      this.setPhase('cook');
      this.setSpeed(1);
    }
    // ------------------------------------------------------------ binding
    bind() {
      const s = this;
      $('btn-accept').onclick = () => s.setPhase('form');
      const F = s.form;
      const link = (id, key, fnv, fnd) => { const el = $(id); el.addEventListener('input', () => { F[key] = fnv(el.value); fnd && (fnd.textContent = fnd.dataset.fmt.replace('%', F[key])); s.rebuildPreview(); }); };
      link('f-mass', 'massG', Number, $('f-mass-v')); link('f-thick', 'thicknessMm', Number, $('f-thick-v')); link('f-work', 'work', (v) => Number(v) / 100, $('f-work-v'));
      $('f-blend').addEventListener('change', (e) => { F.blend = e.target.value; s.rebuildPreview(); });
      $('f-temp').addEventListener('change', (e) => { F.temp = e.target.value; s.rebuildPreview(); });
      $('f-salt').addEventListener('change', (e) => { F.salt = e.target.value; s.rebuildPreview(); });
      $('f-dimple').addEventListener('change', (e) => { F.dimple = e.target.checked; s.rebuildPreview(); });
      $('btn-to-stove').onclick = () => s.startCook();
      // equipment
      $('e-stove').addEventListener('change', (e) => { s.equip.stove = e.target.value; if (!s.placed) { s.state = P.createState({ pan: s.equip.pan, stove: s.equip.stove }); $('knob').value = 0; } });
      $('e-pan').addEventListener('change', (e) => { s.equip.pan = e.target.value; if (!s.placed) { s.state = P.createState({ pan: s.equip.pan, stove: s.equip.stove }); s.vp.setPan(s.equip.pan); $('knob').value = 0; } });
      $('e-fat').addEventListener('change', (e) => { s.equip.fat = e.target.value; });
      $('e-fatg').addEventListener('input', (e) => { s.equip.fatG = Number(e.target.value); $('e-fatg-v').textContent = e.target.value + ' g'; });
      $('btn-fat').onclick = () => { P.addFat(s.state, s.equip.fat, s.equip.fatG); s.audio.click(); };
      $('knob').addEventListener('input', (e) => { P.setKnob(s.state, Number(e.target.value)); $('knob-v').textContent = e.target.value; });
      $('btn-place').onclick = () => s.place();
      $('btn-flip').onclick = () => { const r = P.flipPatty(s.state); if (r.ok) { s.audio.hiss(0.6); s.vp.forceTex = true; s.refreshButtons(); } };
      $('btn-press').onclick = () => { P.pressPatty(s.state, false); s.audio.hiss(0.5); s.vp.forceTex = true; };
      $('btn-smash').onclick = () => { P.pressPatty(s.state, true); s.audio.hiss(0.9); s.vp.forceTex = true; s.refreshButtons(); };
      $('btn-lid').onclick = () => { P.toggleLid(s.state); $('btn-lid').textContent = s.state.lid ? 'Lid off' : 'Lid on'; };
      $('btn-cheese').onclick = () => { P.addCheese(s.state); s.refreshButtons(); };
      $('btn-baste').onclick = () => { P.basteButter(s.state); s.audio.hiss(0.4); };
      $('btn-remove').onclick = () => { P.removePatty(s.state); s.setPhase('rest'); s.refreshButtons(); };
      $('btn-probe').onclick = () => { s.probe.inserted = !s.probe.inserted; s.probe.settle = 0; s.probe.reading = null; $('btn-probe').textContent = s.probe.inserted ? 'Pull probe' : 'Insert probe'; };
      $('probe-depth').addEventListener('input', (e) => { s.probe.depth = Number(e.target.value) / 100; $('probe-depth-v').textContent = e.target.value + ' %'; });
      $('btn-cut').onclick = () => { s.state.where = 'cut'; s.setPhase('result'); };
      $('btn-again').onclick = () => { s.vp.setCutaway(false); s.vp.setPatty(null); s.newOrder(); };
      $('btn-cutaway').onclick = () => { s.vp.setCutaway(!s.vp.cutaway); $('btn-cutaway').classList.toggle('on', s.vp.cutaway); };
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
        if (s.phase !== 'cook') return;
        if (e.key === 'f' || e.key === 'F') $('btn-flip').click();
        if (e.key === ' ') { e.preventDefault(); if (!s.placed) $('btn-place').click(); else $('btn-flip').click(); }
        if (e.key === 'p' || e.key === 'P') $('btn-press').click();
        if (e.key === 'c' || e.key === 'C') $('btn-cutaway').click();
      });
    }
    /** Test/debug hook: advance the physics by `seconds` without rendering. */
    fastForward(seconds) { let n = Math.round(seconds / DT); while (n-- > 0) P.step(this.state, DT); this.vp.forceTex = true; }
    setSpeed(v) { this.speed = v; for (const b of document.querySelectorAll('[data-speed]')) b.classList.toggle('on', Number(b.dataset.speed) === v); }
    place() {
      if (this.placed) return;
      P.placePatty(this.state, this.patty); this.placed = true;
      this.audio.hiss(Math.min(1, (this.state.pan.T - 60) / 200));
      this.vp.setPatty(this.patty); this.vp.forceTex = true;
      this.refreshButtons();
    }
    refreshButtons() {
      const on = this.phase === 'cook', placed = this.placed && this.state.where === 'pan';
      $('btn-place').disabled = !on || this.placed;
      for (const id of ['btn-flip', 'btn-press', 'btn-smash', 'btn-lid', 'btn-cheese', 'btn-baste', 'btn-remove']) $(id).disabled = !placed;
      if (placed) { const raw = this.patty.dM.reduce((a, b) => a + b, 0) / this.patty.N < 0.25; $('btn-smash').disabled = !raw || this.patty.h < 0.006; $('btn-cheese').disabled = !!this.patty.cheese; }
      $('btn-probe').disabled = !(placed || this.phase === 'rest');
      $('e-stove').disabled = $('e-pan').disabled = this.placed;
    }
    // ------------------------------------------------------------ loop
    frame(now) {
      const real = Math.min(0.1, (now - this.last) / 1000); this.last = now;
      const st = this.state;
      if (this.phase === 'cook' || this.phase === 'rest') {
        this.acc += real * this.speed;
        let n = 0;
        while (this.acc >= DT && n < 400) { P.step(st, DT); this.acc -= DT; n++; }
        if (n >= 400) this.acc = 0;
        this.updateProbe(real * this.speed);
        this.audio.update(st.diag, st.stove.knob / 10, real);
        this.updateHUD();
        this.updateLog();
        if (this.phase === 'rest') { $('rest-t').textContent = P.fmtTime(st.rest.t); $('rest-c').textContent = this.hard ? '—' : fmt(P.centerT(st.patty), 1) + ' °C'; }
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
      const p = this.state.patty; if (!this.probe.inserted || !p) { this.probe.reading = null; return; }
      const idx = P.clamp(Math.round((1 - this.probe.depth) * (p.N - 1)), 0, p.N - 1); // depth measured from the top
      const truth = p.T[idx];
      if (this.probe.reading == null) this.probe.reading = this.state.env.Tamb;
      this.probe.reading += (truth - this.probe.reading) * Math.min(1, dt / 0.9); // thermometer settle time
    }
    updateHUD() {
      const st = this.state, p = st.patty, d = st.diag;
      $('h-pan').textContent = this.hard ? '—' : fmt(st.pan.T + (Math.random() - 0.5) * 1.5, 0) + ' °C';
      $('h-time').textContent = p && st.where === 'pan' ? P.fmtTime(p.cookTime) : p && st.where === 'rest' ? 'rest ' + P.fmtTime(st.rest.t) : P.fmtTime(st.t);
      $('h-probe').textContent = this.probe.reading == null ? '—' : fmt(this.probe.reading, 1) + ' °C';
      $('h-side').textContent = p && st.where === 'pan' ? `face ${p.faceDown.id} down · ${P.fmtTime(p.timeDown)} this side` : '';
      $('h-smoke').hidden = d.smoke < 0.25; $('h-smoke').textContent = d.smoke > 1.2 ? '🚨 Heavy smoke — open a window' : '💨 Smoking';
      $('h-lid').hidden = !st.lid;
      // inspector
      if (!$('inspector').hidden) {
        const rows = [];
        const add = (k, v) => rows.push(`<tr><td>${k}</td><td>${v}</td></tr>`);
        add('Burner power to pan', fmt(st.stove.pDelivered, 0) + ' W');
        add('Pan temperature', fmt(st.pan.T, 1) + ' °C');
        add('Oil / fat in pan', fmt(st.pan.oil * 1000, 1) + ' g' + (st.pan.oilKind !== 'none' ? ` (${st.pan.oilKind})` : ''));
        add('Water on pan', fmt(st.pan.water * 1000, 2) + ' g');
        add('Fond', fmt(st.pan.fond * 1000, 1) + ' (burnt ' + fmt(st.pan.fondBurnt * 1000, 1) + ')');
        if (p) {
          add('Heat flux into meat', fmt(d.panQ, 0) + ' W · h = ' + fmt(d.hc, 0) + ' W/m²K');
          add('Bottom surface / node 0', fmt(p.surfT, 0) + ' / ' + fmt(p.T[0], 0) + ' °C');
          add('Centre / top', fmt(P.centerT(p), 1) + ' / ' + fmt(p.T[p.N - 1], 1) + ' °C');
          add('Peak centre so far', fmt(p.peakCenter, 1) + ' °C → ' + P.donenessOf(p.peakCenter).label);
          add('Boiling at contact', fmt(d.evapBottom * 1000, 2) + ' g/s · top evap ' + fmt(p.evapTop * 1000, 3) + ' g/s');
          add('Juice pooled top / at pan', fmt(p.poolTop * 1000, 2) + ' / ' + fmt(p.poolBottom * 1000, 2) + ' g');
          add('Fat rendered out', fmt(p.lostFat * 1000, 1) + ' g (' + fmt(d.fatDrip * 1000, 2) + ' g/s)');
          add('Water lost (steam / drip)', fmt(p.lostWaterEvap * 1000, 1) + ' / ' + fmt(p.lostWaterDrip * 1000, 1) + ' g');
          add('Mass now', fmt(P.pattyMass(p) * 1000, 1) + ' g of ' + fmt(p.massKg0 * 1000, 0));
          add('Face down: brown / char', fmt(p.faceDown.brown, 2) + ' / ' + fmt(p.faceDown.char, 2) + (p.faceDown.stuck ? ' · STUCK' : ' · released'));
          add('Face up: brown / char', fmt(p.faceUp.brown, 2) + ' / ' + fmt(p.faceUp.char, 2));
          add('Diameter / thickness', fmt(p.D * 100, 2) + ' cm / ' + fmt(p.h * 1000, 1) + ' mm · dome ' + fmt(p.dome, 2));
          const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
          add('Denatured: myosin/collagen/actin', fmt(avg(p.dM) * 100, 0) + ' / ' + fmt(avg(p.dC) * 100, 0) + ' / ' + fmt(avg(p.dA) * 100, 0) + ' %');
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
      const st = this.state; const r = P.evaluate(st, this.order.id); this.result = r;
      this.vp.controls.preset('serve'); $('inspector').hidden = true;
      this.vp.setCutaway(true); $('btn-cutaway').classList.add('on');
      const target = r.target;
      $('r-score').textContent = r.total;
      $('r-verdict').textContent = r.dist === 0 ? `${target.label}. Exactly what they asked for.` : r.peak < target.lo ? `Under: ${r.got.label.toLowerCase()} when they wanted ${target.label.toLowerCase()}.` : `Over: ${r.got.label.toLowerCase()} when they wanted ${target.label.toLowerCase()}.`;
      $('r-grade').textContent = r.total >= 90 ? 'Line-cook royalty' : r.total >= 75 ? 'Solid. They will come back.' : r.total >= 55 ? 'Edible. Nobody complained out loud.' : r.total >= 35 ? 'Sent back.' : 'The customer left. So did the smoke alarm.';
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
        ['Crust (browning index / char)', `A: ${r.faces.down.id === 'A' ? r.faces.down.brown.toFixed(1) : r.faces.up.brown.toFixed(1)} / ${(r.faces.down.id === 'A' ? r.faces.down.char : r.faces.up.char).toFixed(2)} · B: ${r.faces.down.id === 'B' ? r.faces.down.brown.toFixed(1) : r.faces.up.brown.toFixed(1)} / ${(r.faces.down.id === 'B' ? r.faces.down.char : r.faces.up.char).toFixed(2)}`],
        ['Grey band', `${(r.overFrac * 100).toFixed(0)} % of the thickness cooked past target`],
      ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
      $('r-notes').innerHTML = r.notes.map((n) => `<li>${n}</li>`).join('');
      this.drawChart($('r-chart'), st.trace);
      this.drawProfile($('r-profile'), st.patty);
    }
    drawProfile(cv, p) {
      const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height; ctx.fillStyle = '#16130f'; ctx.fillRect(0, 0, W, H);
      const N = p.N; const Tmax = 110;
      const X = (i) => 36 + (i / (N - 1)) * (W - 44); const Y = (T) => H - 16 - (T / Tmax) * (H - 24);
      ctx.strokeStyle = '#3a332b'; ctx.fillStyle = '#8a8070'; ctx.font = '10px sans-serif';
      for (let T = 0; T <= 100; T += 25) { ctx.beginPath(); ctx.moveTo(36, Y(T)); ctx.lineTo(W - 8, Y(T)); ctx.stroke(); ctx.fillText(T + '°', 4, Y(T) + 3); }
      // doneness colour strip along the thickness
      for (let i = 0; i < N; i++) { const c = root.BurgerRender.nodeColour(p, i); ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; ctx.fillRect(X(i) - (W - 44) / N / 2, H - 12, (W - 44) / N + 1, 10); }
      ctx.strokeStyle = '#ff6b7a'; ctx.lineWidth = 2; ctx.beginPath();
      for (let i = 0; i < N; i++) { const x = X(i), y = Y(p.T[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke(); ctx.lineWidth = 1;
      ctx.fillStyle = '#c9bfae'; ctx.fillText('bottom (face ' + p.faceDown.id + ')', 40, 12); ctx.fillText('top (face ' + p.faceUp.id + ')', W - 90, 12);
    }
  }
  root.addEventListener('DOMContentLoaded', () => { root.game = new Game(); });
})(window);
