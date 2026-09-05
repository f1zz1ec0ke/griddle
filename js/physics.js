/*
 * physics.js — the thermodynamic, mass-transfer and reaction-kinetics core of the
 * burger simulator. Pure, deterministic, no DOM. Loadable in the browser (global
 * `BurgerPhysics`) and in Node (`module.exports`) so it can be calibrated headlessly.
 *
 * Model summary
 * -------------
 *  • Patty: 1-D finite-difference slab through the thickness (N nodes, bottom = index 0).
 *    Every node tracks temperature, bound water, solid/liquid/free fat, protein, and the
 *    irreversible denaturation extents of myosin, collagen, actin and myoglobin.
 *  • Heat: explicit conduction with composition-dependent k and cp (incl. ice fusion),
 *    contact conductance to the pan, convection/evaporation to air, edge losses.
 *  • Water: boiling clamp at 100 °C (latent heat), Magnus-equation evaporation from the
 *    top face, denaturation-driven expulsion of "free" juice that migrates to the faces.
 *  • Fat: melt → cell rupture (Arrhenius-ish) → gravity drainage into the pan.
 *  • Surface: Maillard browning (Ea≈80 kJ/mol, water-activity gated) and pyrolysis/char
 *    (Ea≈120 kJ/mol) per face, computed at an extrapolated true surface temperature.
 *  • Pan: lumped-capacitance body with burner input, convective + radiative losses,
 *    oil/fat pool with smoke point, juice/water boil-off (with Leidenfrost), fond.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BurgerPhysics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- constants
  const C = {
    cpW: 4180, cpF: 2000, cpP: 1600,        // J/(kg K)
    kW: 0.60, kF: 0.18, kP: 0.20, kIce: 2.2, // W/(m K)
    rhoW: 1000, rhoF: 920, rhoP: 1320,      // kg/m^3
    Lvap: 2.26e6, Lfus: 3.34e5,             // J/kg
    R: 8.314, sigma: 5.67e-8,
    Tboil: 100,
    // Maillard (effective, surface-limited): dB/dt = Am*exp(-EaM/RT)*f(aw)*(1-B/Bmax)
    //   → 0.017/s at 150 °C, 0.09/s at 200 °C on a dry surface
    Am: 1085, EaM: 40e3, Bmax: 7,   // → 0.0125/s @150 °C, 0.042/s @200 °C (crust in ~70 s)
    // Pyrolysis/char: dC/dt = Ac*exp(-EaC/RT) → 0.003/s at 200 °C, 0.043/s at 250 °C
    Ac: 1.4e9, EaC: 110e3, Cmax: 1.5,  // → 0.001/s @200 °C, 0.014/s @250 °C
    hOil: 350,           // W/(m^2 K) hot-oil convection onto immersed meat (deep frying)
    hContactBase: 380,   // W/(m^2 K) meat-on-metal, wet/oiled
    hAirTop: 12, hAirSide: 10, hLid: 30,
    hMass: 0.011,        // m/s mass-transfer coefficient for surface evaporation
    vJuice: 0.45e-3,     // m/s migration speed of expelled juice
    Dw: 1.5e-9,          // m^2/s effective (capillary) moisture diffusivity in meat
    vFat: 0.15e-3,       // m/s drainage speed of free fat at reference viscosity
    fusionSpread: 1.5,   // K over which ice melts (apparent-cp method)
  };

  const BLENDS = [
    { id: '70/30', fat: 0.30, label: '70/30 (chuck + trim)' },
    { id: '80/20', fat: 0.20, label: '80/20 (classic chuck)' },
    { id: '85/15', fat: 0.15, label: '85/15 (lean chuck)' },
    { id: '90/10', fat: 0.10, label: '90/10 (sirloin)' },
    { id: '93/7', fat: 0.07, label: '93/7 (extra lean)' },
  ];

  const PANS = {
    castiron:   { id: 'castiron',   name: 'Cast iron, 12" (2.7 kg)',        mass: 2.7, cp: 460, diam: 0.30, wall: 0.045, emiss: 0.95, release: 0.55, hcMul: 1.00, maxT: 600 },
    carbonsteel:{ id: 'carbonsteel',name: 'Carbon steel, 12" (1.6 kg)',     mass: 1.6, cp: 470, diam: 0.30, wall: 0.045, emiss: 0.80, release: 0.60, hcMul: 1.00, maxT: 600 },
    stainless:  { id: 'stainless',  name: 'Stainless tri-ply, 12" (1.4 kg)',mass: 1.4, cp: 500, diam: 0.30, wall: 0.045, emiss: 0.30, release: 0.95, hcMul: 1.05, maxT: 600 },
    nonstick:   { id: 'nonstick',   name: 'Nonstick aluminium, 10" (0.9 kg)', mass: 0.9, cp: 900, diam: 0.26, wall: 0.040, emiss: 0.85, release: 0.00, hcMul: 0.90, maxT: 260 },
  };

  const FATS = {
    none:    { id: 'none',    name: 'Nothing (dry pan)',        smoke: Infinity, water: 0,    solids: 0 },
    canola:  { id: 'canola',  name: 'Canola oil (smoke 204 °C)', smoke: 204,      water: 0,    solids: 0 },
    avocado: { id: 'avocado', name: 'Avocado oil (smoke 271 °C)',smoke: 271,      water: 0,    solids: 0 },
    butter:  { id: 'butter',  name: 'Butter (smoke 150 °C)',     smoke: 150,      water: 0.16, solids: 0.02 },
    ghee:    { id: 'ghee',    name: 'Ghee (smoke 250 °C)',       smoke: 250,      water: 0,    solids: 0 },
    tallow:  { id: 'tallow',  name: 'Beef tallow (smoke 250 °C)',smoke: 250,      water: 0,    solids: 0 },
  };
  const TALLOW_SMOKE = 250; // rendered beef fat in the pan

  const STOVES = {
    gas:       { id: 'gas',       name: 'Gas burner (3.5 kW nominal, ~40 % to pan)', pMax: 3500, eff: 0.40, tau: 0 },
    electric:  { id: 'electric',  name: 'Electric coil (2.4 kW, slow to respond)',  pMax: 2400, eff: 0.65, tau: 45 },
    induction: { id: 'induction', name: 'Induction (1.8 kW, ~85 % to pan)',         pMax: 1800, eff: 0.85, tau: 0 },
  };

  // Chef temperature bands for the *peak* centre temperature (°C).
  const DONENESS = [
    { id: 'rare',        label: 'Rare',        lo: 49, hi: 52 },
    { id: 'medium-rare', label: 'Medium-rare', lo: 54, hi: 57 },
    { id: 'medium',      label: 'Medium',      lo: 60, hi: 63 },
    { id: 'medium-well', label: 'Medium-well', lo: 65, hi: 68 },
    { id: 'well-done',   label: 'Well done',   lo: 71, hi: 77 },
  ];

  // ---------------------------------------------------------------- helpers
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const sig = (x, x0, w) => 1 / (1 + Math.exp(-(x - x0) / w));
  const arrh = (A, Ea, TC) => A * Math.exp(-Ea / (C.R * (TC + 273.15)));
  // Saturation vapour density of water (kg/m^3), Magnus formula.
  function rhoVapSat(TC) {
    const T = clamp(TC, -30, 100);
    const p = 610.94 * Math.exp((17.625 * T) / (T + 243.04));
    return (p * 0.018015) / (C.R * (T + 273.15));
  }
  function donenessOf(T) {
    if (T < 46) return { id: 'raw', label: 'Raw / blue' };
    if (T < 52.5) return { id: 'rare', label: 'Rare' };
    if (T < 58) return { id: 'medium-rare', label: 'Medium-rare' };
    if (T < 64) return { id: 'medium', label: 'Medium' };
    if (T < 69.5) return { id: 'medium-well', label: 'Medium-well' };
    if (T < 82) return { id: 'well-done', label: 'Well done' };
    return { id: 'overdone', label: 'Overcooked (hockey puck)' };
  }

  // ---------------------------------------------------------------- patty
  /**
   * @param o {massG, thicknessMm, fatFrac, tempC, dimple:boolean, work:0..1, salt:'none'|'surface'|'mixed'}
   */
  function makePatty(o) {
    const fat = clamp(o.fatFrac, 0.03, 0.5);
    const water = (1 - fat) * 0.745;
    const protein = (1 - fat) * 0.255; // protein + ash + glycogen lumped
    const massKg = o.massG / 1000;
    const work = clamp(o.work == null ? 0.4 : o.work, 0, 1);
    const voids = 0.10 * (1 - work);
    const rhoSolid = 1 / (water / C.rhoW + fat / C.rhoF + protein / C.rhoP);
    const rho = rhoSolid * (1 - voids);
    const V = massKg / rho;
    const h = clamp(o.thicknessMm, 3, 60) / 1000;
    const A = V / h;
    const D = Math.sqrt((4 * A) / Math.PI);
    const N = clamp(Math.round(h / 0.0006), 10, 80);
    const T0 = o.tempC == null ? 4 : o.tempC;
    const per = massKg / N;
    const n = () => new Array(N).fill(0);
    const p = {
      N, massKg0: massKg, rho0: rho, voids, work,
      h0: h, D0: D, A0: A, h, D, A,
      dimple: !!o.dimple, salt: o.salt || 'surface', fatFrac: fat, T0,
      T: n().map(() => T0),
      w: n().map(() => per * water), w0: per * water,
      fs: n().map(() => per * fat), fl: n(), fr: n(), fat0: per * fat,
      p: n().map(() => per * protein),
      dM: n(), dC: n(), dA: n(), dG: n(),
      // faces: A is the face that starts DOWN.
      faceDown: makeFace('A'), faceUp: makeFace('B'),
      poolBottom: 0, poolTop: 0, fatTop: 0,
      dome: 0, pressT: 0, pressed: false,
      lostWaterEvap: 0, lostWaterDrip: 0, lostFat: 0, lostStuck: 0,
      flips: 0, cookTime: 0, timeDown: 0,
      peakCenter: T0, cheeses: [],
      steamRate: 0, boilBottom: 0, evapTop: 0,
      surfT: T0, // extrapolated bottom surface temp
    };
    // A dimple pre-empts doming; overworked meat gets denser & tighter.
    return p;
  }
  function makeFace(id) { return { id, brown: 0, char: 0, torn: 0, crisp: 0, stuck: true, maxT: 0 }; }

  function nodeHeatCap(p, i) {
    let cp = p.w[i] * C.cpW + (p.fs[i] + p.fl[i] + p.fr[i]) * C.cpF + p.p[i] * C.cpP;
    const T = p.T[i];
    if (T > -C.fusionSpread && T <= 0) cp += (p.w[i] * C.Lfus) / C.fusionSpread; // apparent cp through fusion
    return cp;
  }
  function nodeK(p, i) {
    const w = p.w[i], f = p.fs[i] + p.fl[i] + p.fr[i], pr = p.p[i];
    const T = p.T[i];
    const ice = T < 0 ? clamp(-T / C.fusionSpread, 0, 1) : 0;
    const kw = lerp(C.kW, C.kIce, ice);
    const vw = w / C.rhoW, vf = f / C.rhoF, vp = pr / C.rhoP;
    const vt = vw + vf + vp + 1e-12;
    // Dried-out tissue: air-filled pores, much worse conductor.
    const dryness = 1 - clamp(w / p.w0, 0, 1);
    const k = (vw * kw + vf * C.kF + vp * C.kP) / vt;
    return k * (1 - 0.10 * (1 - p.work)) * (1 - 0.40 * dryness);
  }
  function nodeMass(p, i) { return p.w[i] + p.fs[i] + p.fl[i] + p.fr[i] + p.p[i]; }
  function pattyMass(p) { let m = 0; for (let i = 0; i < p.N; i++) m += nodeMass(p, i); return m + p.poolBottom + p.poolTop + p.fatTop; }
  function centerT(p) { const N = p.N; return N % 2 ? p.T[(N - 1) / 2] : 0.5 * (p.T[N / 2 - 1] + p.T[N / 2]); }
  function avg(arr) { let s = 0; for (const v of arr) s += v; return s / arr.length; }

  // ---------------------------------------------------------------- state
  function createState(cfg) {
    const pan = PANS[cfg.pan] || PANS.castiron;
    const stove = STOVES[cfg.stove] || STOVES.gas;
    const Tamb = cfg.Tamb == null ? 21 : cfg.Tamb;
    return {
      t: 0,
      env: { Tamb, RH: 0.45 },
      stove: { ...stove, knob: 0, pDelivered: 0 },
      pan: {
        ...pan, T: Tamb, C: pan.mass * pan.cp,
        oil: 0, oilKind: 'none', oilSmoke: Infinity, water: 0, fond: 0, fondBurnt: 0,
        floorR: pan.diam / 2 * 0.95, oilDepth: 0, overflow: 0, flare: 0,
        smoke: 0, smokeOil: 0, smokeChar: 0, smokeFond: 0,
        lostSpatter: 0, area: Math.PI * (pan.diam / 2) ** 2,
      },
      lid: false, lidAirT: Tamb,
      patty: null, where: 'board', // 'board' | 'pan' | 'rest' | 'cut'
      baste: 0,
      events: [], log: [], trace: [], traceEvery: 0.5, lastTrace: -1,
      diag: { sizzle: 0, spatter: 0, steam: 0, smoke: 0, evapBottom: 0, evapPan: 0, oilBubble: 0, fatDrip: 0, juiceTop: 0, juiceSide: 0, panQ: 0 },
      rest: { t: 0 }, result: null,
    };
  }

  function logEvent(s, text, kind) {
    s.events.push({ t: s.t, text, kind: kind || 'info' });
    if (s.events.length > 400) s.events.shift();
  }

  // ---------------------------------------------------------------- actions
  function setKnob(s, v) { s.stove.knob = clamp(v, 0, 10); }

  function addFat(s, kind, grams) {
    const f = FATS[kind] || FATS.none;
    if (kind === 'none' || !grams) return;
    const m = grams / 1000;
    s.pan.water += m * f.water;
    s.pan.oil += m * (1 - f.water - f.solids);
    s.pan.fond += m * f.solids * 5;
    s.pan.oilKind = s.pan.oil > 0 && s.pan.oilKind !== 'none' && s.pan.oilKind !== kind ? 'mixed' : kind;
    s.pan.oilSmoke = Math.min(s.pan.oilSmoke, f.smoke);
    const depth = s.pan.oil / 920 / (Math.PI * s.pan.floorR ** 2);
    logEvent(s, `Added ${grams} g ${f.name.split(' (')[0].toLowerCase()} to the pan` + (s.pan.T > f.smoke ? ' — it is smoking immediately, the pan is above its smoke point.' : '.') + (depth > 0.002 ? ` Fat is now ${(depth * 1000).toFixed(0)} mm deep.` : ''), 'action');
  }

  function placePatty(s, patty) {
    s.patty = patty; s.where = 'pan';
    patty.faceDown.stuck = true;
    patty.timeDown = 0;
    logEvent(s, `Patty (${(patty.massKg0 * 1000).toFixed(0)} g, ${(patty.h0 * 1000).toFixed(0)} mm, ${(patty.fatFrac * 100).toFixed(0)} % fat, ${patty.T0.toFixed(0)} °C) hits the pan at ${s.pan.T.toFixed(0)} °C.`, 'action');
    if (s.pan.T < 120) logEvent(s, 'The pan is not hot enough. The meat will steam in its own juice and go grey.', 'warn');
  }

  function flipPatty(s) {
    const p = s.patty; if (!p || s.where !== 'pan') return { ok: false };
    const fd = p.faceDown;
    const relThr = s.pan.release * (s.pan.oil > 0.002 ? 0.7 : 1.0);
    let torn = 0;
    if (fd.stuck && fd.brown < relThr && s.pan.release > 0) {
      // Protein has bonded to the metal and the crust hasn't formed/dried enough to release it.
      torn = clamp(0.25 * (1 - fd.brown / relThr), 0.03, 0.25);
      const m0 = nodeMass(p, 0);
      for (const k of ['w', 'fs', 'fl', 'fr', 'p']) { p.lostStuck += p[k][0] * torn; p[k][0] *= (1 - torn); }
      s.pan.fond += m0 * torn * 20;
      fd.torn += torn;
      logEvent(s, `It stuck. ${(torn * 100).toFixed(0)} % of the bottom face tore off and stayed welded to the pan. Meat releases on its own once the crust sets.`, 'warn');
    }
    // Orientation reversal.
    for (const k of ['T', 'w', 'fs', 'fl', 'fr', 'p', 'dM', 'dC', 'dA', 'dG']) p[k].reverse();
    const tmp = p.faceDown; p.faceDown = p.faceUp; p.faceUp = tmp;
    // Juice that was sitting on top now hits the pan.
    s.pan.water += p.poolTop;
    p.poolBottom = 0; // the old contact film was steam
    const juiceHit = p.poolTop; p.poolTop = 0;
    s.pan.oil += p.fatTop; p.fatTop = 0;
    p.faceDown.stuck = true;
    p.faceDown.crisp = Math.max(0, p.faceDown.crisp - 0.1);
    p.flips++; p.timeDown = 0;
    p.dome *= 0.6; // the cooked side, now up, stops pulling
    if (p.cheeses.length) { s.pan.fond += 0.006 * p.cheeses.length; logEvent(s, `${p.cheeses.length} slice${p.cheeses.length > 1 ? 's' : ''} of cheese slid off into the pan and welded to it.`, 'warn'); p.cheeses = []; }
    logEvent(s, `Flip #${p.flips}. Face ${p.faceDown.id} down.` + (juiceHit > 0.0005 ? ` ${(juiceHit * 1000).toFixed(1)} g of pooled juice hit the pan and flashed to steam.` : ''), 'action');
    return { ok: true, torn };
  }

  function pressPatty(s, hard) {
    const p = s.patty; if (!p || s.where !== 'pan') return;
    const cooked = avg(p.dM);
    p.pressT = 1.5; p.pressed = true;
    // Squeeze out free juice and, if the protein network has already set, bound juice too.
    let expelled = 0;
    for (let i = 0; i < p.N; i++) {
      const whc = waterHolding(p, i);
      const free = Math.max(0, p.w[i] - whc * p.w0);
      let out = free * 0.8;
      if (p.dM[i] > 0.3) out += p.w[i] * (hard ? 0.10 : 0.05) * p.dM[i];
      out = Math.min(out, p.w[i]);
      p.w[i] -= out; expelled += out;
      const fatOut = p.fr[i] * 0.7; p.fr[i] -= fatOut; s.pan.oil += fatOut; p.lostFat += fatOut;
    }
    s.pan.water += expelled; p.lostWaterDrip += expelled;
    p.dome = 0;
    if (cooked < 0.25 && hard) {
      // Smash: the raw patty deforms plastically.
      let hNew = Math.max(0.004, p.h * 0.55);
      // the meat cannot spread past the pan wall: once it fills the floor it just gets squeezed
      const Dmax = 2 * s.pan.floorR * 0.94;
      const V = p.A * p.h;
      let Anew = V / hNew, Dnew = Math.sqrt((4 * Anew) / Math.PI);
      let hitWall = false;
      if (Dnew > Dmax) { Dnew = Dmax; Anew = (Math.PI * Dnew * Dnew) / 4; hNew = V / Anew; hitWall = true; }
      if (hNew >= p.h * 0.98) { logEvent(s, 'Pressed hard, but it already fills the pan: nowhere left to go.', 'action'); return; }
      p.h = hNew; p.A = Anew; p.D = Dnew;
      p.h0 = p.h; p.A0 = p.A; p.D0 = p.D;
      p.faceDown.stuck = true;
      logEvent(s, `SMASHED. Patty flattened to ${(p.h * 1000).toFixed(0)} mm, ${(p.D * 100).toFixed(1)} cm across.` + (hitWall ? ' It has hit the pan wall.' : ' Huge contact area, huge crust, no pink centre.'), 'action');
    } else {
      logEvent(s, `Pressed with the spatula. ${(expelled * 1000).toFixed(1)} g of juice squeezed out and boiled off. That was flavour.`, expelled > 0.002 ? 'warn' : 'action');
    }
  }

  function removePatty(s) {
    const p = s.patty; if (!p || s.where !== 'pan') return;
    const fd = p.faceDown;
    const relThr = s.pan.release * (s.pan.oil > 0.002 ? 0.7 : 1.0);
    if (fd.stuck && fd.brown < relThr && s.pan.release > 0) {
      const torn = clamp(0.25 * (1 - fd.brown / relThr), 0.03, 0.25);
      for (const k of ['w', 'fs', 'fl', 'fr', 'p']) { p.lostStuck += p[k][0] * torn; p[k][0] *= (1 - torn); }
      fd.torn += torn;
      logEvent(s, `Scraped it off the pan; the bottom crust stayed behind.`, 'warn');
    }
    s.pan.oil += p.fatTop; p.fatTop = 0;
    s.where = 'rest'; s.rest.t = 0; p.poolBottom = 0;
    p.peakCenter = Math.max(p.peakCenter, centerT(p));
    logEvent(s, `Off the heat after ${fmtTime(p.cookTime)}. Centre ${centerT(p).toFixed(1)} °C. Resting — carry-over cooking begins.`, 'action');
  }

  function addCheese(s) {
    const p = s.patty; if (!p || s.where !== 'pan' || p.cheeses.length >= 24) return;
    const k = p.cheeses.length;
    p.cheeses.push({ T: s.env.Tamb, melt: 0, mass: 0.02, rot: k * 0.42 + (Math.random() - 0.5) * 0.2, overhang: 0, contact: 0, skirt: null });
    logEvent(s, k === 0 ? 'Slice of American cheese on top (20 g). Processed cheese softens around 45 °C and flows by 60 °C; a lid speeds it up.' : `Another slice (${k + 1} on the stack, ${(20 * (k + 1))} g). The top of the pile heats through the slices under it.`, 'action');
  }
  function toggleLid(s) { s.lid = !s.lid; logEvent(s, s.lid ? 'Lid on. Steam trapped: the top face will cook from condensing vapour and the crust will soften.' : 'Lid off.', 'action'); }
  function basteButter(s) {
    if (s.where !== 'pan') return;
    addFat(s, 'butter', 15);
    s.baste = 12;
    logEvent(s, 'Basting: spooning hot butter over the top for ~12 s.', 'action');
  }

  // ---------------------------------------------------------------- physics
  function waterHolding(p, i) {
    // Water-holding capacity of the protein matrix collapses as proteins denature & shrink.
    let whc = 1 - 0.06 * p.dM[i] - 0.06 * p.dC[i] - 0.28 * p.dA[i];
    if (p.salt === 'mixed') whc += 0.06;          // salt-solubilised myosin binds water
    if (p.salt === 'none') whc -= 0.02;
    whc -= 0.05 * p.work;                          // compaction squeezes the matrix
    return clamp(whc, 0.3, 1.02);
  }

  /**
   * The part of a cheese slice hanging past the patty droops as it melts; whatever reaches the pan
   * becomes a "skirt" with its own temperature and water. On hot metal it melts, boils dry into a
   * lace, browns (lactose + casein go golden fast) and finally chars.
   */
  const CHEESE_SIDE = 0.095, CHEESE_THICK = 0.0015, CHEESE_WATER = 0.38;
  function stepCheeseSkirt(p, ch, k, dt, bc) {
    const R = p.D / 2, baseY = p.h * (1 + 0.28 * p.dome) + k * CHEESE_THICK;
    const n = 10; let overN = 0, touchN = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x = ((i + 0.5) / n - 0.5) * CHEESE_SIDE, z = ((j + 0.5) / n - 0.5) * CHEESE_SIDE;
      const over = Math.hypot(x, z) - R * 0.98; if (over <= 0) continue;
      overN++;
      if (bc.bottom.type === 'pan' && over * (0.2 + 1.6 * ch.melt) >= baseY) touchN++;
    }
    ch.overhang = overN / (n * n); ch.contact = overN ? touchN / overN : 0;
    const sk = ch.skirt || (ch.skirt = { T: ch.T, water: CHEESE_WATER, melt: 0, brown: 0, char: 0, dry: 0, charRate: 0, mass: 0 });
    const massS = ch.mass * ch.overhang * ch.contact; sk.mass = massS;
    if (massS < 1e-5) { sk.T += (ch.T - sk.T) * Math.min(1, dt / 2); sk.charRate = 0; return; }
    const areaS = CHEESE_SIDE * CHEESE_SIDE * ch.overhang * ch.contact;
    const Cs = massS * (1500 + 4180 * sk.water);
    const q = 200 * areaS * (bc.bottom.T - sk.T) - 12 * areaS * (sk.T - bc.top.T);
    let Tn = sk.T + (q * dt) / Cs;
    if (Tn > C.Tboil && sk.water > 0) {
      const excess = Cs * (Tn - C.Tboil); const m = Math.min(sk.water * massS, excess / C.Lvap);
      sk.water = Math.max(0, sk.water - m / massS); Tn = C.Tboil + (excess - m * C.Lvap) / Cs;
    }
    sk.T = Tn;
    sk.melt = clamp(sk.melt + 0.15 * sig(sk.T, 52, 5) * dt, 0, 1);
    sk.dry = 1 - clamp(sk.water / CHEESE_WATER, 0, 1);
    const fAw = 0.15 + 0.85 * smooth(0.3, 0.9, sk.dry);
    sk.brown += arrh(C.Am * 2, C.EaM, sk.T) * fAw * Math.max(0, 1 - sk.brown / C.Bmax) * dt;
    const rC = arrh(C.Ac * 2, C.EaC, sk.T) * (0.3 + 0.7 * smooth(0.6, 1, sk.dry)) * Math.max(0, 1 - sk.char / C.Cmax);
    sk.char += rC * dt; sk.charRate = rC;
  }

  /** Advance the patty by dt (s) with the given boundary conditions. */
  function stepPatty(s, p, dt, bc) {
    const N = p.N, A = p.A, dz = p.h / N, D = p.D;
    const T = p.T;
    const Cn = new Array(N), Kn = new Array(N), Q = new Array(N).fill(0);
    for (let i = 0; i < N; i++) { Cn[i] = nodeHeatCap(p, i); Kn[i] = nodeK(p, i); }
    Cn[0] += p.poolBottom * C.cpW; Cn[N - 1] += p.poolTop * C.cpW + p.fatTop * C.cpF;

    // conduction between nodes
    for (let i = 0; i < N - 1; i++) {
      const kI = (2 * Kn[i] * Kn[i + 1]) / (Kn[i] + Kn[i + 1] + 1e-9);
      const g = (kI * A) / dz;
      const q = g * (T[i + 1] - T[i]);
      Q[i] += q; Q[i + 1] -= q;
    }
    // bottom boundary
    let qBot = 0, hc = 0;
    if (bc.bottom.type === 'pan') {
      const contact = clamp(1 - 0.35 * p.dome, 0.5, 1) * (p.pressT > 0 ? 1.4 : 1);
      const oilFilm = clamp(bc.bottom.oil / 0.003, 0, 1);
      const boiling = p.poolBottom > 1e-6 || (T[0] > 98 && p.w[0] > 0.2 * p.w0);
      const dry0 = 1 - clamp(p.w[0] / p.w0, 0, 1);
      const crust = 1 - 0.35 * smooth(0.5, 1, dry0) - 0.15 * clamp(p.faceDown.brown / 4, 0, 1) - 0.3 * clamp(p.faceDown.char, 0, 1);
      hc = C.hContactBase * bc.bottom.hcMul * (1 + 0.5 * oilFilm) * (boiling ? 1.25 : 1) * crust * contact;
      qBot = hc * A * (bc.bottom.T - T[0]);
    } else {
      qBot = bc.bottom.h * A * (bc.bottom.T - T[0]);
    }
    Q[0] += qBot;
    // top boundary
    let hTop = bc.top.h, TairTop = bc.top.T;
    let qTop = 0;
    if (p.cheeses.length) {
      // a stack of lumped cheese slices: meat → slice 0 → slice 1 → … → air
      const cs = p.cheeses, n = cs.length;
      const gc = 300 * A; // contact conductance improves as the cheese melts into its neighbour
      const flux = new Array(n + 1);
      flux[0] = gc * (1 + cs[0].melt) * (T[N - 1] - cs[0].T);
      for (let k = 1; k < n; k++) flux[k] = gc * (1 + Math.min(cs[k - 1].melt, cs[k].melt)) * (cs[k - 1].T - cs[k].T);
      flux[n] = hTop * A * (TairTop - cs[n - 1].T);
      for (let k = 0; k < n; k++) {
        const ch = cs[k], Cc = ch.mass * 2500;
        ch.T += ((flux[k] - (k < n - 1 ? flux[k + 1] : -flux[n])) * dt) / Cc;
        ch.melt = clamp(ch.melt + 0.08 * sig(ch.T, 52, 5) * dt, 0, 1);
        stepCheeseSkirt(p, ch, k, dt, bc);
      }
      Q[N - 1] -= flux[0];
    } else {
      qTop = hTop * A * (TairTop - T[N - 1]);
      Q[N - 1] += qTop;
    }
    if (s.baste > 0) { const q = 150 * A * ((bc.bottom.T || 150) - 40 - T[N - 1]); Q[N - 1] += Math.max(0, q); }
    // edge losses
    const per = Math.PI * D;
    for (let i = 0; i < N; i++) {
      const inOil = bc.side.oilDepth > (i + 0.5) * dz;
      Q[i] += inOil ? C.hOil * per * dz * (bc.side.oilT - T[i]) : C.hAirSide * per * dz * (bc.side.T - T[i]);
    }

    // top evaporation (Magnus) — from pooled juice first, then from tissue.
    let evapTop = 0;
    if (!p.cheeses.length && bc.top.RH < 0.99) {
      const Ts = T[N - 1];
      const X = p.w[N - 1] / (p.p[N - 1] + 1e-9);      // moisture on dry basis
      const aw = p.poolTop > 1e-6 ? 1 : 1 - Math.exp(-8 * X);
      const drive = Math.max(0, aw * rhoVapSat(Ts) - bc.top.RH * rhoVapSat(bc.top.T));
      let m = C.hMass * A * drive * dt;
      const maxByEnergy = Math.max(0, (Cn[N - 1] * (Ts - (bc.top.T - 8))) / C.Lvap);
      m = Math.min(m, maxByEnergy, p.poolTop + p.w[N - 1]);
      const fromPool = Math.min(m, p.poolTop); p.poolTop -= fromPool; p.w[N - 1] -= (m - fromPool);
      Q[N - 1] -= (m * C.Lvap) / dt; evapTop = m / dt; p.lostWaterEvap += m;
    }

    // integrate temperatures, with the boiling clamp (latent heat) at every node
    let boil = 0, boilBottom = 0;
    for (let i = 0; i < N; i++) {
      let Tn = T[i] + (Q[i] * dt) / Cn[i];
      const water = p.w[i] + (i === 0 ? p.poolBottom : 0) + (i === N - 1 ? p.poolTop : 0);
      if (Tn > C.Tboil && water > 1e-9) {
        const excess = Cn[i] * (Tn - C.Tboil);
        let m = Math.min(water, excess / C.Lvap);
        // take from pools first, then from tissue
        let rem = m;
        if (i === 0) { const a = Math.min(rem, p.poolBottom); p.poolBottom -= a; rem -= a; }
        if (i === N - 1) { const a = Math.min(rem, p.poolTop); p.poolTop -= a; rem -= a; }
        p.w[i] -= rem;
        Tn = C.Tboil + (excess - m * C.Lvap) / Cn[i];
        boil += m; if (i <= 1) boilBottom += m; p.lostWaterEvap += m;
      }
      T[i] = Tn;
    }
    p.steamRate = (boil / dt) + evapTop;
    p.boilBottom = boilBottom / dt;
    p.evapTop = evapTop;

    // ---- denaturation kinetics (first order, sigmoidal-in-T rate)
    for (let i = 0; i < N; i++) {
      const Ti = T[i];
      const kM = 0.25 * sig(Ti, 52, 2.5), kC = 0.12 * sig(Ti, 61, 3), kA = 0.10 * sig(Ti, 68, 1.5), kG = 0.06 * sig(Ti, 64, 1.5);
      p.dM[i] += kM * (1 - p.dM[i]) * dt;
      p.dC[i] += kC * (1 - p.dC[i]) * dt;
      p.dA[i] += kA * (1 - p.dA[i]) * dt;
      p.dG[i] += kG * (1 - p.dG[i]) * dt;
    }

    // ---- capillary moisture diffusion (wicks water toward the drying crust)
    {
      const rhoDry = 420; // kg/m^3 of dry solids
      const X = new Array(N);
      for (let i = 0; i < N; i++) X[i] = p.w[i] / (p.p[i] + 1e-9);
      for (let i = 0; i < N - 1; i++) {
        const dry = Math.min(p.T[i], p.T[i + 1]) > 0 ? 1 : 0.05; // frozen: negligible
        let f = (C.Dw * dry * rhoDry * A * (X[i + 1] - X[i]) / dz) * dt;
        f = clamp(f, -p.w[i] * 0.5, p.w[i + 1] * 0.5);
        p.w[i] += f; p.w[i + 1] -= f;
      }
    }
    // ---- juice expulsion & migration
    const half = N / 2;
    const fmove = Math.min(1, (C.vJuice * dt) / dz);
    const sideFrac = 0.10;
    let toBottom = 0, toTop = 0, toSide = 0;
    const flux = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      const free = Math.max(0, p.w[i] - waterHolding(p, i) * p.w0);
      flux[i] = free * fmove;
    }
    for (let i = 0; i < N; i++) {
      const f = flux[i]; if (f <= 0) continue;
      p.w[i] -= f;
      const side = f * sideFrac; toSide += side;
      const rest = f - side;
      if (i < half) { if (i === 0) toBottom += rest; else p.w[i - 1] += rest; }
      else { if (i === N - 1) toTop += rest; else p.w[i + 1] += rest; }
    }
    p.poolBottom += toBottom; p.poolTop += toTop;
    // top pool: beads run off the edge (faster when domed)
    const runoff = p.poolTop * (0.04 + 0.2 * p.dome) * dt;
    p.poolTop -= runoff;
    const juiceSide = toSide + runoff;
    p.lostWaterDrip += juiceSide;

    // ---- fat: melt, release from cells, drain
    let fatDrip = 0;
    const fmoveF = new Array(N);
    for (let i = 0; i < N; i++) {
      const Ti = T[i];
      const melt = p.fs[i] * Math.min(1, 0.06 * sig(Ti, 42, 3) * dt); p.fs[i] -= melt; p.fl[i] += melt;
      const kRel = 0.0035 * sig(Ti, 66, 6) * (1 + Math.max(0, Ti - 66) / 40);
      const rel = p.fl[i] * Math.min(1, kRel * dt); p.fl[i] -= rel; p.fr[i] += rel;
      const visc = clamp((Ti - 38) / 50, 0.05, 1.6);
      fmoveF[i] = Math.min(1, (C.vFat * visc * dt) / dz);
    }
    let fatSide = 0;
    for (let i = N - 1; i >= 0; i--) {
      const f = p.fr[i] * fmoveF[i]; if (f <= 0) continue;
      p.fr[i] -= f;
      const side = f * 0.2; fatSide += side;
      if (i === 0) fatDrip += f - side; else p.fr[i - 1] += f - side;
    }
    // A little free fat wicks up to the top face as the meat contracts (the glisten).
    const wick = p.fr[N - 1] * 0.02 * dt; p.fr[N - 1] -= wick; p.fatTop += wick;
    const fatTopRun = p.fatTop * 0.05 * dt; p.fatTop -= fatTopRun; fatSide += fatTopRun;
    p.lostFat += fatDrip + fatSide;

    // ---- surface chemistry on the face in contact with the pan
    const kBot = Kn[0];
    let Ts = T[0] + (Math.max(0, qBot) / A) * (dz / 2) / Math.max(kBot, 0.05);
    if (p.w[0] > 0.25 * p.w0 || p.poolBottom > 1e-6) Ts = Math.min(Ts, C.Tboil + 2);
    if (bc.bottom.type === 'pan') Ts = Math.min(Ts, bc.bottom.T);
    p.surfT = Ts;
    const fd = p.faceDown;
    fd.maxT = Math.max(fd.maxT, Ts);
    const dryness = 1 - clamp(p.w[0] / p.w0, 0, 1);
    const fAw = 0.12 + 0.88 * smooth(0.25, 0.85, dryness);
    const rB = arrh(C.Am, C.EaM, Ts) * fAw * Math.max(0, 1 - fd.brown / C.Bmax);
    fd.brown += rB * dt;
    const rC = arrh(C.Ac, C.EaC, Ts) * (0.3 + 0.7 * smooth(0.6, 1, dryness)) * Math.max(0, 1 - fd.char / C.Cmax);
    fd.char += rC * dt; fd.charRate = rC;
    fd.crisp = clamp(fd.crisp + (dryness > 0.6 ? 0.02 : -0.01) * dt, 0, 1);
    if (fd.stuck && (fd.brown >= 0.5 * (bc.bottom.release || 1) + 0.15 || dryness > 0.6)) fd.stuck = false;
    // top face: submerged in hot fat it browns like the bottom (deep frying)
    const fu = p.faceUp;
    if (bc.top.oil && !p.cheeses.length) {
      let TsT = T[N - 1] + (Math.max(0, qTop) / A) * (dz / 2) / Math.max(Kn[N - 1], 0.05);
      if (p.w[N - 1] > 0.25 * p.w0 || p.poolTop > 1e-6) TsT = Math.min(TsT, C.Tboil + 2);
      TsT = Math.min(TsT, bc.top.T);
      fu.maxT = Math.max(fu.maxT, TsT);
      const dryT = 1 - clamp(p.w[N - 1] / p.w0, 0, 1);
      const fAwT = 0.12 + 0.88 * smooth(0.25, 0.85, dryT);
      fu.brown += arrh(C.Am, C.EaM, TsT) * fAwT * Math.max(0, 1 - fu.brown / C.Bmax) * dt;
      const rCT = arrh(C.Ac, C.EaC, TsT) * (0.3 + 0.7 * smooth(0.6, 1, dryT)) * Math.max(0, 1 - fu.char / C.Cmax);
      fu.char += rCT * dt; fu.charRate = rCT;
      fu.crisp = clamp(fu.crisp + (dryT > 0.6 ? 0.02 : -0.01) * dt, 0, 1);
    }
    // under a lid the crust goes soggy; when basting, a little browning.
    if (bc.top.RH > 0.9) fu.crisp = clamp(fu.crisp - 0.03 * dt, 0, 1);
    if (s.baste > 0) fu.brown += 0.004 * dt;

    // ---- geometry: shrinkage & doming
    const sC = avg(p.dC), sM = avg(p.dM);
    const massNow = pattyMass(p);
    const lossFrac = 1 - massNow / p.massKg0;
    const shrink = 1 - 0.15 * sC - 0.04 * sM - 0.06 * lossFrac;
    p.D = p.D0 * clamp(shrink, 0.6, 1);
    p.A = (Math.PI * p.D * p.D) / 4;
    const Vnow = massNow / p.rho0 / (1 - 0.15 * lossFrac); // cooked meat gets a little less dense (pores)
    p.h = Vnow / p.A;
    // doming: the lower half's collagen contracts first and pulls the edges down / centre up
    const lowerC = avg(p.dC.slice(0, Math.max(1, Math.floor(half))));
    const thick = clamp(p.h0 / 0.016, 0.3, 1.4);
    const domeTarget = (p.dimple ? 0.15 : 1) * clamp(lowerC * 1.3, 0, 1) * thick * (p.pressed ? 0.35 : 1);
    p.dome += (domeTarget - p.dome) * Math.min(1, dt / 6);
    if (p.pressT > 0) p.pressT -= dt;

    p.peakCenter = Math.max(p.peakCenter, centerT(p));
    return { qBot, hc, boilBottom: boilBottom / dt, evapTop, fatDrip: fatDrip / dt, fatSide: fatSide / dt, juiceSide: juiceSide / dt, Ts };
  }

  /** Explicit conduction is only stable for dt < dz²/(2α). A smashed patty keeps its layer count
   *  while its thickness collapses, so sub-cycle when the layers get thin. */
  function stepPattyStable(s, p, dt, bc) {
    const dz = p.h / p.N;
    let frozen = false; for (let i = 0; i < p.N; i++) if (p.T[i] < 0) { frozen = true; break; }
    const alphaMax = frozen ? 1.3e-6 : 2.5e-7;
    const dtMax = (0.4 * dz * dz) / alphaMax;
    const n = Math.max(1, Math.min(64, Math.ceil(dt / dtMax)));
    if (n === 1) return stepPatty(s, p, dt, bc);
    const h = dt / n; let acc = null;
    for (let k = 0; k < n; k++) {
      const r = stepPatty(s, p, h, bc);
      if (!acc) acc = { ...r }; else for (const key in r) acc[key] += r[key];
    }
    for (const key in acc) acc[key] /= n;
    return acc;
  }

  /** Advance the whole world (stove, pan, patty) by dt seconds. */
  function step(s, dt) {
    const pan = s.pan, st = s.stove, Tamb = s.env.Tamb;
    if (!s._ms) s._ms = {};
    s.t += dt;
    // ---- burner
    const pTarget = (st.knob / 10) * st.pMax * st.eff;
    if (st.tau > 0) st.pDelivered += ((pTarget - st.pDelivered) * dt) / st.tau; else st.pDelivered = pTarget;
    // ---- lid air
    const lidTarget = s.lid ? Math.min(104, 0.75 * pan.T + 25) : Tamb + 0.25 * (pan.T - Tamb); // hot plume just above the pan
    s.lidAirT += ((lidTarget - s.lidAirT) * dt) / (s.lid ? 12 : 4);

    // ---- pan energy balance
    const Tk = pan.T + 273.15, Tak = Tamb + 273.15;
    const hNat = 1.32 * Math.pow(Math.max(1, pan.T - Tamb) / pan.diam, 0.25) + 3; // natural conv, up-facing plate
    const coveredA = s.patty && s.where === 'pan' ? s.patty.A : 0;
    const freeA = Math.max(0, pan.area - coveredA);
    let qLoss = hNat * freeA * (pan.T - Tamb) * (s.lid ? 0.4 : 1)
      + pan.emiss * C.sigma * (Tk ** 4 - Tak ** 4) * freeA * (s.lid ? 0.3 : 1)
      + 6 * pan.area * (pan.T - Tamb) * 0.5 // underside & handle
      + 0.25 * Math.PI * pan.diam * 0.05 * hNat * (pan.T - Tamb); // rim
    // water in the pan boils off (Leidenfrost slows it on a very hot pan)
    let evapPan = 0;
    if (pan.water > 0 && pan.T > 100) {
      const leiden = pan.T > 210 ? 0.15 : 1;
      let r = clamp((pan.T - 100) / 15, 0, 6) * leiden; // 1/s
      let m = Math.min(pan.water, pan.water * r * dt);
      const maxByEnergy = Math.max(0, (pan.C * (pan.T - 100) * 0.5) / C.Lvap);
      m = Math.min(m, maxByEnergy);
      pan.water -= m; evapPan = m / dt;
      qLoss += (m * C.Lvap) / dt;
      pan.fond += m * 0.3; // dissolved solids left behind
    }
    // oil level: a film until the floor is covered, then a rising pool; past the rim it spills
    const floorA = Math.PI * pan.floorR * pan.floorR;
    pan.oilDepth = pan.oil / 920 / floorA;
    if (pan.oilDepth > pan.wall) {
      const excess = (pan.oilDepth - pan.wall) * floorA * 920;
      pan.oil -= excess; pan.overflow += excess; pan.oilDepth = pan.wall;
      s._spillAcc = (s._spillAcc || 0) + excess;
      if (s._spillAcc > 0.02) {
        s._spillAcc = 0;
        logEvent(s, `Fat is overflowing the pan onto the stove (${(pan.overflow * 1000).toFixed(0)} g so far).`, 'warn');
        if (st.pDelivered > 150 && st.id !== 'induction') { pan.flare = 8; logEvent(s, 'GREASE FIRE. Fat has run onto the burner and lit. Flames up the sides of the pan.', 'warn'); }
      }
    }
    if (pan.flare > 0) { pan.flare = Math.max(0, pan.flare - dt); qLoss -= 1500; } // the fire heats the pan too
    // fond browns then burns
    if (pan.fond > 0 && pan.T > 180) { const b = pan.fond * 0.01 * clamp((pan.T - 180) / 60, 0, 2) * dt; pan.fond -= b; pan.fondBurnt += b; }
    // oil oxidises / smokes away slowly above smoke point
    const smokeT = Math.min(pan.oilSmoke, pan.oilKind === 'none' || pan.oilKind === 'tallow' || pan.oilKind === 'mixed' ? TALLOW_SMOKE : Infinity);
    const overSmoke = pan.oil > 1e-5 ? Math.max(0, pan.T - Math.min(smokeT, TALLOW_SMOKE + (pan.oilSmoke === Infinity ? 0 : 0))) : 0;
    pan.smokeOil = pan.oil > 1e-5 ? clamp(overSmoke / 40, 0, 2) * clamp(pan.oil / 0.004, 0.2, 1) : 0;
    if (overSmoke > 0) pan.oil = Math.max(0, pan.oil - pan.oil * 0.0004 * (overSmoke / 40) * dt);
    pan.smokeFond = clamp(pan.fondBurnt / 0.01, 0, 1) * clamp((pan.T - 200) / 60, 0, 1.5);

    // ---- patty
    let pr = null;
    const p = s.patty;
    if (p && s.where === 'pan') {
      const submerged = pan.oilDepth > p.h * (1 + 0.28 * p.dome) + 0.0005;
      if (submerged && !s._ms.deepfry) { s._ms.deepfry = true; logEvent(s, `The patty is under ${(pan.oilDepth * 1000).toFixed(0)} mm of fat: this is deep frying now. Both faces will brown.`, 'info'); }
      const bc = {
        bottom: { type: 'pan', T: pan.T, oil: pan.oil, hcMul: pan.hcMul, release: pan.release },
        top: submerged ? { h: C.hOil, T: pan.T, RH: 1, oil: true } : { h: s.lid ? C.hLid : C.hAirTop, T: s.lidAirT, RH: s.lid ? clamp((s.lidAirT - 60) / 40, s.env.RH, 1) : s.env.RH },
        side: { T: Tamb + 0.25 * (pan.T - Tamb), oilDepth: pan.oilDepth, oilT: pan.T },
      };
      pr = stepPattyStable(s, p, dt, bc);
      p.cookTime += dt; p.timeDown += dt;
      // heat drawn from pan
      qLoss += pr.qBot;
      // juice & fat that ran off the patty land in the pan
      pan.water += pr.juiceSide * dt;
      pan.oil += (pr.fatDrip + pr.fatSide) * dt;
      // bottom boiling energy came via the patty node (already in qBot)
      // char smoke
      let cheeseSmoke = 0; for (const ch of p.cheeses) if (ch.skirt) cheeseSmoke += ch.skirt.charRate * 40 * (0.3 + ch.skirt.char) * ch.skirt.mass / 0.01;
      pan.smokeChar = clamp((p.faceDown.charRate || 0) * 40 * (0.3 + p.faceDown.char) + cheeseSmoke, 0, 2.5);
      if (s.baste > 0) s.baste -= dt;
    } else {
      pan.smokeChar = 0;
    }
    if (p && s.where === 'rest') {
      const bc = {
        bottom: { type: 'air', h: 15, T: Tamb + 8 }, // sitting on a plate/board
        top: { h: C.hAirTop, T: Tamb, RH: s.env.RH },
        side: { T: Tamb },
      };
      stepPattyStable(s, p, dt, bc);
      s.rest.t += dt;
    }

    // spatter: water flashing under a layer of hot fat throws droplets
    const boilTotal = (pr ? pr.boilBottom : 0) + evapPan;
    const oilFactor = clamp(pan.oil / 0.006, 0, 1.5);
    const hotFactor = clamp((pan.T - 120) / 120, 0, 1.5);
    // droplets/s; each carries ~0.15 mg of fat out of the pan (a ~0.6 mm droplet)
    const spatter = Math.min(80, boilTotal * 4e4 * oilFactor * hotFactor + (pan.water > 0 && pan.T > 150 ? 2 * oilFactor : 0));
    if (spatter > 0) { const loss = Math.min(pan.oil, spatter * 1.5e-7 * dt); pan.oil -= loss; pan.lostSpatter += loss; }
    pan.T += ((st.pDelivered - qLoss) * dt) / (pan.C + pan.oil * C.cpF);
    if (pan.T > pan.maxT && pan.id === 'nonstick' && !s._ptfeWarned) { s._ptfeWarned = true; logEvent(s, 'Nonstick coating above 260 °C: it is degrading and off-gassing. Not a good idea.', 'warn'); }

    const oilBubble = pan.oil > 1e-5 ? clamp((pan.T - 140) / 100, 0, 1) * clamp(pan.oil / 0.005, 0, 1) : 0;
    s.diag = {
      sizzle: clamp(boilTotal * 300 + oilBubble * 0.15 + (pr ? pr.evapTop * 20 : 0), 0, 1.5),
      spatter, steam: (pr ? p.steamRate : 0) + evapPan,
      smoke: pan.smokeOil + pan.smokeChar + pan.smokeFond + (pan.flare > 0 ? 1.5 : 0),
      flare: pan.flare, oilDepth: pan.oilDepth, overflow: pan.overflow,
      evapBottom: pr ? pr.boilBottom : 0, evapPan, oilBubble,
      fatDrip: pr ? pr.fatDrip + pr.fatSide : 0, juiceTop: p ? p.poolTop : 0, juiceSide: pr ? pr.juiceSide : 0,
      panQ: pr ? pr.qBot : 0, Ts: pr ? pr.Ts : 0, hc: pr ? pr.hc : 0,
    };
    pan.smoke = s.diag.smoke;

    // trace for charts
    if (s.t - s.lastTrace >= s.traceEvery) {
      s.lastTrace = s.t;
      s.trace.push({ t: s.t, pan: pan.T, center: p ? centerT(p) : null, bottom: p ? p.T[0] : null, top: p ? p.T[p.N - 1] : null, surf: p ? p.surfT : null, mass: p ? pattyMass(p) : null, where: s.where });
      if (s.trace.length > 20000) s.trace.shift();
    }
    checkMilestones(s);
  }

  function checkMilestones(s) {
    const p = s.patty; const pan = s.pan; const ms = s._ms || (s._ms = {});
    const once = (key, cond, text, kind) => { if (!ms[key] && cond) { ms[key] = true; logEvent(s, text, kind); } };
    once('preheat150', pan.T >= 150, 'Pan at 150 °C. A drop of water would sizzle and vanish in a second.', 'info');
    once('leiden', pan.T >= 200, 'Pan past ~200 °C: water drops would now bead and skate (Leidenfrost). Proper searing territory.', 'info');
    once('oilsmoke', pan.smokeOil > 0.3, 'The oil is smoking — it is past its smoke point and breaking down (acrolein). Slightly acrid.', 'warn');
    if (!p) return;
    if (s.where === 'pan') {
      once('fatmelt', p.T[0] > 45, 'Fat in the bottom layer has melted (≈42 °C). It will start to leak out as the cells rupture.', 'info');
      once('myosin', p.dM[0] > 0.5, 'Myosin denaturing at the bottom face: the meat is firming and going opaque grey.', 'info');
      once('render', p.lostFat > 0.001, 'Fat is rendering out and pooling around the patty. Listen to it.', 'info');
      once('dry', p.w[0] < 0.25 * p.w0, 'Bottom face has boiled dry. Its temperature is no longer pinned at 100 °C — Maillard browning can now proceed.', 'info');
      once('brown1', p.faceDown.brown > 1, 'A pale tan crust is forming.', 'info');
      once('brown2', p.faceDown.brown > 2.5, 'Deep brown crust: Maillard is well underway (pyrazines, furanones — that smell).', 'good');
      once('char', p.faceDown.char > 0.25, 'The crust is starting to burn (pyrolysis). Bitter, acrid, black.', 'warn');
      once('juice', p.poolTop > 0.0008, 'Pink juice is beading on the top surface — the classic "time to flip" cue.', 'good');
      once('c50', p.peakCenter >= 50, 'Centre 50 °C — rare.', 'info');
      once('c55', p.peakCenter >= 55, 'Centre 55 °C — medium-rare.', 'info');
      once('c60', p.peakCenter >= 60, 'Centre 60 °C — medium.', 'info');
      once('c66', p.peakCenter >= 66, 'Centre 66 °C — medium-well. Actin is denaturing; juice loss accelerates.', 'info');
      once('c71', p.peakCenter >= 71, 'Centre 71 °C — well done. USDA-safe for ground beef.', 'info');
      once('c80', p.peakCenter >= 80, 'Centre 80 °C. This is a hockey puck now.', 'warn');
      const c0 = p.cheeses[0];
      once('cheese', c0 && c0.melt > 0.8, 'Cheese fully melted and draping over the edges.', 'good');
      const sk = p.cheeses.map((c) => c.skirt).filter((x) => x && x.mass > 1e-5);
      once('cheeseTouch', sk.length > 0, 'Cheese has drooped onto the pan. It will melt, boil dry into a lace, then brown.', 'info');
      once('cheeseFrico', sk.some((x) => x.brown > 2), 'The cheese on the pan has gone golden and crisp: frico.', 'good');
      once('cheeseBurn', sk.some((x) => x.char > 0.3), 'The cheese lace is burning: black, bitter, and smoking.', 'warn');
    }
  }

  // ---------------------------------------------------------------- results
  function fmtTime(t) { const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; }

  function evaluate(s, targetId) {
    const p = s.patty; if (!p) return null;
    const target = DONENESS.find((d) => d.id === targetId) || DONENESS[2];
    const peak = p.peakCenter;
    const got = donenessOf(peak);
    // 1. doneness (50)
    const dist = peak < target.lo ? target.lo - peak : peak > target.hi ? peak - target.hi : 0;
    const doneScore = 50 * clamp(1 - dist / 9, 0, 1);
    // 2. crust (20) — both faces
    const faceScore = (f) => {
      const b = f.brown;
      let sc = b < 1 ? b * 0.3 : b < 2.5 ? 0.3 + ((b - 1) / 1.5) * 0.7 : b < 4.5 ? 1 : b < 6 ? 1 - (b - 4.5) * 0.4 : 0.4;
      sc *= 1 - clamp(f.char / 0.6, 0, 0.9);
      sc *= 1 - f.torn * 2;
      sc *= 0.7 + 0.3 * f.crisp;
      return clamp(sc, 0, 1);
    };
    const crustScore = 20 * 0.5 * (faceScore(p.faceDown) + faceScore(p.faceUp));
    // 3. juiciness (15) — water retained relative to what that doneness inevitably costs
    let wNow = 0; for (let i = 0; i < p.N; i++) wNow += p.w[i];
    const wRet = wNow / (p.w0 * p.N);
    const expected = clamp(1 - 0.0075 * Math.max(0, target.hi - 40), 0.55, 0.95); // ~0.86 for MR, ~0.72 for WD
    const juiceScore = 15 * clamp((wRet - (expected - 0.25)) / 0.25, 0, 1);
    // 4. evenness (10) — fraction of thickness cooked past the target band (grey band)
    let over = 0; for (let i = 0; i < p.N; i++) if (p.dG[i] > 0.7 && target.hi < 68) over++;
    const overFrac = over / p.N;
    const evenScore = 10 * clamp(1 - overFrac / 0.7, 0, 1);
    // 5. structure (5)
    let structure = 1;
    if (p.work > 0.8) structure -= 0.4;
    if (p.salt === 'mixed') structure -= 0.3;
    if (p.dome > 0.5) structure -= 0.3;
    if (p.lostStuck > 0) structure -= 0.3;
    const structScore = 5 * clamp(structure, 0, 1);
    const total = Math.round(doneScore + crustScore + juiceScore + evenScore + structScore);
    const massNow = pattyMass(p);
    const notes = [];
    if (dist === 0) notes.push(`Centre peaked at ${peak.toFixed(1)} °C — squarely ${target.label.toLowerCase()}. Nailed it.`);
    else notes.push(`Centre peaked at ${peak.toFixed(1)} °C. That is ${got.label.toLowerCase()}; the order was ${target.label.toLowerCase()} (${target.lo}–${target.hi} °C). Off by ${dist.toFixed(1)} °C.`);
    if (target.id !== 'well-done') notes.push('Note: ground beef is only USDA-safe at 71 °C. Anything pinker is a calculated risk you took on the customer\'s behalf.');
    if (p.faceDown.char > 0.3 || p.faceUp.char > 0.3) notes.push('At least one face is charred — pyrolysed, bitter, and carrying a haze of smoke.');
    else if (Math.max(p.faceDown.brown, p.faceUp.brown) < 1) notes.push('Barely any crust. The surface never got hot and dry enough for Maillard: the pan was too cool, or the meat too wet.');
    else if (Math.min(p.faceDown.brown, p.faceUp.brown) < 1) notes.push('One face browned, the other did not — uneven timing between sides.');
    else if (Math.min(p.faceDown.brown, p.faceUp.brown) > 2.2) notes.push('Proper crust on both faces.');
    if (p.faceDown.torn + p.faceUp.torn > 0) notes.push('Some crust tore off and stayed on the pan when it was moved before releasing.');
    if (p.cheeses.some((c) => c.skirt && c.skirt.char > 0.3)) notes.push('Burnt cheese lace welded to the edges: acrid.');
    else if (p.cheeses.some((c) => c.skirt && c.skirt.brown > 2)) notes.push('A crisp golden cheese skirt around the edge. Good.');
    if (s._ms && s._ms.deepfry) notes.push('It was deep-fried: cooked in enough fat to cover it, so heat came in from every side at once.');
    if (p.lostWaterDrip > 0.006) notes.push(`${(p.lostWaterDrip * 1000).toFixed(0)} g of juice ran out onto the pan instead of staying in the meat.`);
    if (p.lostFat > 0.004) notes.push(`${(p.lostFat * 1000).toFixed(0)} g of fat rendered out and pooled in the pan.`);
    if (overFrac > 0.5 && target.hi < 68) notes.push('A wide grey band: the outside went well past target before the centre got there. Thicker patty, lower heat, or flip more often.');
    if (p.dome > 0.5) notes.push('The patty domed into a meatball: the centre lifted off the pan and browned unevenly. A thumb dimple prevents that.');
    if (p.salt === 'mixed') notes.push('Salt was mixed through the meat early: dissolved myosin cross-linked into a springy, sausage-like bite.');
    if (p.work > 0.8) notes.push('The meat was overworked: dense and tight instead of loose and tender.');
    return {
      total, target, got, peak, dist,
      parts: { doneness: Math.round(doneScore), crust: Math.round(crustScore), juiciness: Math.round(juiceScore), evenness: Math.round(evenScore), structure: Math.round(structScore) },
      massStart: p.massKg0, massEnd: massNow, waterRetained: wRet, waterEvap: p.lostWaterEvap, waterDrip: p.lostWaterDrip, fatLost: p.lostFat, stuck: p.lostStuck,
      overFrac, notes, cookTime: p.cookTime, restTime: s.rest.t, flips: p.flips,
      faces: { down: { ...p.faceDown }, up: { ...p.faceUp } },
      profile: p.T.slice(), dG: p.dG.slice(),
    };
  }

  return {
    C, BLENDS, PANS, FATS, STOVES, DONENESS,
    makePatty, createState, step, stepPatty,
    setKnob, addFat, placePatty, flipPatty, pressPatty, removePatty, addCheese, toggleLid, basteButter,
    evaluate, donenessOf, centerT, pattyMass, nodeMass, waterHolding, fmtTime, clamp, lerp, rhoVapSat, logEvent,
  };
});
