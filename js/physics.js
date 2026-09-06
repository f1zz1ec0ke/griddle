/*
 * physics.js — the thermodynamic, mass-transfer and reaction-kinetics core of the
 * burger simulator. Pure, deterministic, no DOM. Loadable in the browser (global
 * `BurgerPhysics`) and in Node (`module.exports`) so it can be calibrated headlessly.
 *
 * Model summary
 * -------------
 *  • Patty: 2-D axisymmetric finite-difference grid (Nr rings × Nz layers, bottom = layer 0,
 *    centre = ring 0). Every cell tracks temperature, bound water, solid/liquid/free fat,
 *    protein, and the irreversible denaturation extents of myosin, collagen, actin, myoglobin.
 *  • Heat: explicit conduction radially and vertically with composition-dependent k and cp
 *    (incl. ice fusion); per-ring contact conductance to the pan (so a domed patty really does
 *    lift its centre off the metal), convection/evaporation on the top, an explicit edge
 *    boundary to air, oil or radiant heat.
 *  • Water: boiling clamp at 100 °C (latent heat) in every cell, Magnus-equation evaporation
 *    from the top face, capillary diffusion, and denaturation-driven expulsion of "free" juice
 *    that migrates to whichever face is nearest (bottom, top, or the edge).
 *  • Fat: melt → cell rupture → gravity drainage into the pan, plus edge leakage.
 *  • Surface: Maillard browning and pyrolysis/char per ring on each face, computed at an
 *    extrapolated true surface temperature.
 *  • Pan: radial rings with a stove-specific burner heat profile, radial conduction through the
 *    metal (so there is a hot spot over the flame and cooler edges), convective and radiative
 *    losses from the uncovered area, an oil/fat pool with smoke point, juice boil-off with
 *    Leidenfrost, fond and residue that build into carbon.
 *  • Several patties can share the pan; each one draws heat from the rings under it, which is
 *    where crowding comes from.
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
    Am: 1085, EaM: 40e3, Bmax: 7,   // → 0.0125/s @150 °C, 0.042/s @200 °C (crust in ~70 s)
    // Pyrolysis/char: dC/dt = Ac*exp(-EaC/RT)
    Ac: 1.4e9, EaC: 110e3, Cmax: 1.5,  // → 0.001/s @200 °C, 0.014/s @250 °C
    hOil: 350,           // W/(m^2 K) hot-oil convection onto immersed meat (deep frying)
    hContactBase: 380,   // W/(m^2 K) meat-on-metal, wet/oiled
    hAirTop: 12, hAirSide: 10, hLid: 30,
    hMass: 0.011,        // m/s mass-transfer coefficient for surface evaporation
    vJuice: 0.45e-3,     // m/s migration speed of expelled juice
    Dw: 1.5e-9,          // m^2/s effective (capillary) moisture diffusivity in meat
    vFat: 0.15e-3,       // m/s drainage speed of free fat at reference viscosity
    fusionSpread: 1.5,   // K over which ice melts (apparent-cp method)
    panRings: 12,
  };

  const BLENDS = [
    { id: '70/30', fat: 0.30, label: '70/30 (chuck + trim)' },
    { id: '80/20', fat: 0.20, label: '80/20 (classic chuck)' },
    { id: '85/15', fat: 0.15, label: '85/15 (lean chuck)' },
    { id: '90/10', fat: 0.10, label: '90/10 (sirloin)' },
    { id: '93/7', fat: 0.07, label: '93/7 (extra lean)' },
  ];

  // k·t is what sets the hot spot: cast iron is thick but a poor conductor, aluminium is the
  // most even, tri-ply's aluminium core does most of the spreading.
  const PANS = {
    castiron:   { id: 'castiron',   name: 'Cast iron, 12" (2.7 kg)',        mass: 2.7, cp: 460, diam: 0.30, wall: 0.045, k: 50,  thick: 0.005,  emiss: 0.95, release: 0.55, hcMul: 1.00, maxT: 600 },
    carbonsteel:{ id: 'carbonsteel',name: 'Carbon steel, 12" (1.6 kg)',     mass: 1.6, cp: 470, diam: 0.30, wall: 0.045, k: 50,  thick: 0.0025, emiss: 0.80, release: 0.60, hcMul: 1.00, maxT: 600 },
    stainless:  { id: 'stainless',  name: 'Stainless tri-ply, 12" (1.4 kg)',mass: 1.4, cp: 500, diam: 0.30, wall: 0.045, k: 110, thick: 0.003,  emiss: 0.30, release: 0.95, hcMul: 1.05, maxT: 600 },
    nonstick:   { id: 'nonstick',   name: 'Nonstick aluminium, 10" (0.9 kg)', mass: 0.9, cp: 900, diam: 0.26, wall: 0.040, k: 200, thick: 0.004,  emiss: 0.85, release: 0.00, hcMul: 0.90, maxT: 260 },
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

  // burner heat profiles are functions of pan radius (m) and knob (0..1); normalised in step()
  const STOVES = {
    gas:       { id: 'gas',       name: 'Gas burner (3.5 kW nominal, ~40 % to pan)', pMax: 3500, eff: 0.40, tau: 0,
                 profile: (r, k) => Math.exp(-(((r - (0.045 + 0.035 * k)) / (0.025 + 0.02 * k)) ** 2)) },
    electric:  { id: 'electric',  name: 'Electric coil (2.4 kW, slow to respond)',  pMax: 2400, eff: 0.65, tau: 45,
                 profile: (r) => (r <= 0.10 ? 1 : 0) },
    induction: { id: 'induction', name: 'Induction (1.8 kW, ~85 % to pan)',         pMax: 1800, eff: 0.85, tau: 0,
                 profile: (r) => (r >= 0.02 && r <= 0.105 ? 1 : 0) },
    // A 22" kettle: 1.5 kg of lump charcoal under a steel grate. The knob is the vents (and how
    // hard you fan): airflow sets the fire temperature and how fast the coals burn down.
    charcoal:  { id: 'charcoal',  name: 'Charcoal kettle (22", lump charcoal)', kind: 'grill', pMax: 0, eff: 0, tau: 0, profile: () => 1 },
  };
  /** The grate over the coals, standing in for the pan when the stove is a grill. */
  const GRATE = { id: 'grate', name: 'Steel grate over charcoal', mass: 1.6, cp: 470, diam: 0.54, wall: 0.0, k: 50, thick: 0.004, emiss: 0.9, release: 0.7, hcMul: 1.0, maxT: 900, barFrac: 0.28 };
  const COAL = { H: 30e6, view: 0.5, viewGrate: 0.4, viewSide: 0.2, tauUp: 150, tauDown: 300 };

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
  function fmtTime(t) { const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; }

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
    const Nz = clamp(Math.round(h / 0.0006), 10, 60);
    const Nr = clamp(Math.round(D / 2 / 0.004), 6, 16);
    const T0 = o.tempC == null ? 4 : o.tempC;
    const n = Nz * Nr;
    const p = {
      id: o.id || 1, target: o.target || null, where: 'board', pos: { x: 0, y: 0 },
      Nz, Nr, massKg0: massKg, rho0: rho, voids, work,
      h0: h, D0: D, A0: A, h, D, A,
      dimple: !!o.dimple, salt: o.salt || 'surface', fatFrac: fat, T0,
      T: new Float64Array(n).fill(T0),
      w: new Float64Array(n), w0c: new Float64Array(n), fs: new Float64Array(n), fl: new Float64Array(n), fr: new Float64Array(n), fat0c: new Float64Array(n),
      p: new Float64Array(n), dM: new Float64Array(n), dC: new Float64Array(n), dA: new Float64Array(n), dG: new Float64Array(n),
      Tpk: new Float64Array(n).fill(T0), // hottest each cell has ever been: the record that decides what is 'past target'
      aj: new Float64Array(Nr), // ring area fractions
      faceDown: makeFace('A', Nr), faceUp: makeFace('B', Nr), faceSide: { brown: 0, char: 0 },
      poolB: new Float64Array(Nr), poolT: new Float64Array(Nr), poolBottom: 0, poolTop: 0, fatTop: 0,
      dome: 0, pressT: 0, pressed: false,
      lostWaterEvap: 0, lostWaterDrip: 0, lostFat: 0, lostStuck: 0,
      flips: 0, cookTime: 0, timeDown: 0,
      peakCenter: T0, cheeses: [], cheeseUnder: [],
      steamRate: 0, boilBottom: 0, evapTop: 0, surfT: T0,
    };
    for (let j = 0; j < Nr; j++) p.aj[j] = (2 * j + 1) / (Nr * Nr);
    for (let k = 0; k < Nz; k++) for (let j = 0; j < Nr; j++) {
      const c = k * Nr + j, m = (massKg / Nz) * p.aj[j];
      p.w[c] = m * water; p.w0c[c] = m * water; p.fs[c] = m * fat; p.fat0c[c] = m * fat; p.p[c] = m * protein;
    }
    p.w0 = p.w0c[0]; p.fat0 = p.fat0c[0]; // centre-column reference values (used for dryness of the centre column)
    return p;
  }
  function makeFace(id, Nr) { return { id, brown: 0, char: 0, torn: 0, crisp: 0, stuck: true, maxT: 0, brownR: new Float64Array(Nr), charR: new Float64Array(Nr) }; }

  function cellHeatCap(p, c) {
    let cp = p.w[c] * C.cpW + (p.fs[c] + p.fl[c] + p.fr[c]) * C.cpF + p.p[c] * C.cpP;
    const T = p.T[c];
    if (T > -C.fusionSpread && T <= 0) cp += (p.w[c] * C.Lfus) / C.fusionSpread; // apparent cp through fusion
    return cp;
  }
  function cellK(p, c) {
    const w = p.w[c], f = p.fs[c] + p.fl[c] + p.fr[c], pr = p.p[c];
    const T = p.T[c];
    const ice = T < 0 ? clamp(-T / C.fusionSpread, 0, 1) : 0;
    const kw = lerp(C.kW, C.kIce, ice);
    const vw = w / C.rhoW, vf = f / C.rhoF, vp = pr / C.rhoP;
    const vt = vw + vf + vp + 1e-12;
    const dryness = 1 - clamp(w / p.w0c[c], 0, 1);
    const k = (vw * kw + vf * C.kF + vp * C.kP) / vt;
    return k * (1 - 0.10 * (1 - p.work)) * (1 - 0.40 * dryness);
  }
  function cellMass(p, c) { return p.w[c] + p.fs[c] + p.fl[c] + p.fr[c] + p.p[c]; }
  function layerMass(p, k) { let m = 0; for (let j = 0; j < p.Nr; j++) m += cellMass(p, k * p.Nr + j); return m; }
  function pattyMass(p) { let m = 0; for (let c = 0; c < p.T.length; c++) m += cellMass(p, c); return m + p.poolBottom + p.poolTop + p.fatTop; }
  function centerT(p) { const N = p.Nz, Nr = p.Nr; return N % 2 ? p.T[((N - 1) / 2) * Nr] : 0.5 * (p.T[(N / 2 - 1) * Nr] + p.T[(N / 2) * Nr]); }
  function cellT(p, k, j) { return p.T[k * p.Nr + j]; }
  function layerMean(p, arr, k) { let s = 0; for (let j = 0; j < p.Nr; j++) s += arr[k * p.Nr + j] * p.aj[j]; return s; }
  function gridMean(p, arr) { let s = 0; for (let k = 0; k < p.Nz; k++) s += layerMean(p, arr, k); return s / p.Nz; }
  function faceMean(p, face) { let b = 0, ch = 0; for (let j = 0; j < p.Nr; j++) { b += face.brownR[j] * p.aj[j]; ch += face.charR[j] * p.aj[j]; } face.brown = b; face.char = ch; }

  // ---------------------------------------------------------------- state
  function createState(cfg) {
    const stove = STOVES[cfg.stove] || STOVES.gas;
    const grill = stove.kind === 'grill';
    const pan = grill ? GRATE : (PANS[cfg.pan] || PANS.castiron);
    const Tamb = cfg.Tamb == null ? 21 : cfg.Tamb;
    const Np = C.panRings, floorR = pan.diam / 2 * 0.95;
    const dr = floorR / Np;
    const ringA = new Float64Array(Np), ringM = new Float64Array(Np);
    for (let j = 0; j < Np; j++) { ringA[j] = Math.PI * dr * dr * (2 * j + 1); ringM[j] = pan.mass * 0.7 * ((2 * j + 1) / (Np * Np)); }
    ringM[Np - 1] += pan.mass * 0.3; // wall and handle ride on the outer ring
    const s = {
      t: 0,
      env: { Tamb, RH: 0.45 },
      stove: { ...stove, knob: 0, pDelivered: 0 },
      pan: {
        ...pan, T: Tamb, C: pan.mass * pan.cp, Tr: new Float64Array(Np).fill(Tamb), Np, dr, ringA, ringM, Tcenter: Tamb, Tedge: Tamb,
        oil: 0, oilKind: 'none', oilSmoke: Infinity, water: 0, fond: 0, fondBurnt: 0,
        cheeseBits: 0, meatBits: 0, carbon: 0, washes: 0,
        floorR, oilDepth: 0, overflow: 0, flare: 0,
        smoke: 0, smokeOil: 0, smokeChar: 0, smokeFond: 0,
        lostSpatter: 0,
      },
      lid: false, lidAirT: Tamb,
      // the fire, when the stove is a grill: coal left, bed temperature, ash, flare-ups, dome air
      grill: grill ? { coal: 1.5, coal0: 1.5, Tfire: Tamb, ash: 0, lit: false, flare: 0, flareTotal: 0, Tdome: Tamb, fatOnCoals: 0, burnW: 0 } : null,
      patties: [], patty: null, where: 'board', // s.patty / s.where mirror the selected patty
      baste: 0,
      events: [], trace: [], traceEvery: 0.5, lastTrace: -1,
      diag: { sizzle: 0, spatter: 0, steam: 0, smoke: 0, evapBottom: 0, evapPan: 0, oilBubble: 0, fatDrip: 0, juiceTop: 0, juiceSide: 0, panQ: 0 },
      // the instability guard's book-keeping (see stepPattyGuarded)
      guard: { restores: 0, retries: 0, sanitised: 0, panRestores: 0, lastLog: -1e9 },
      rest: { t: 0 }, result: null,
    };
    return s;
  }
  function panTat(pan, r) {
    // pan temperature at radius r (m), linear between ring centres
    const x = clamp(r / pan.dr - 0.5, 0, pan.Np - 1); const j = Math.floor(x), t = x - j;
    return j >= pan.Np - 1 ? pan.Tr[pan.Np - 1] : lerp(pan.Tr[j], pan.Tr[j + 1], t);
  }
  function selectPatty(s, p) { s.patty = p || null; s.where = p ? p.where : 'board'; }
  function syncSelected(s) { if (s.patty) s.where = s.patty.where; }

  function logEvent(s, text, kind) {
    s.events.push({ t: s.t, text, kind: kind || 'info' });
    if (s.events.length > 400) s.events.shift();
  }

  // ---------------------------------------------------------------- actions
  function setKnob(s, v) { s.stove.knob = clamp(v, 0, 10); }

  function addFat(s, kind, grams) {
    const f = FATS[kind] || FATS.none;
    if (kind === 'none' || !grams) return;
    if (s.grill) { logEvent(s, 'There is no pan on a grill. Fat goes on the meat, not the grate, and whatever renders out falls on the coals.', 'info'); return; }
    const m = grams / 1000;
    s.pan.water += m * f.water;
    s.pan.oil += m * (1 - f.water - f.solids);
    s.pan.fond += m * f.solids;
    s.pan.oilKind = s.pan.oil > 0 && s.pan.oilKind !== 'none' && s.pan.oilKind !== kind ? 'mixed' : kind;
    s.pan.oilSmoke = Math.min(s.pan.oilSmoke, f.smoke);
    const depth = s.pan.oil / 920 / (Math.PI * s.pan.floorR ** 2);
    logEvent(s, `Added ${grams} g ${f.name.split(' (')[0].toLowerCase()} to the pan` + (s.pan.T > f.smoke ? ' — it is smoking immediately, the pan is above its smoke point.' : '.') + (depth > 0.002 ? ` Fat is now ${(depth * 1000).toFixed(0)} mm deep.` : ''), 'action');
  }

  /** Standard spots for n patties in a pan of floor radius R: centre, a pair, a triangle, a square. */
  function pattySpots(n, R, pattyR) {
    const d = Math.min(R - pattyR * 1.05, Math.max(0.055, pattyR * 1.12));
    if (n <= 1) return [{ x: 0, y: 0 }];
    if (n === 2) return [{ x: -d * 0.95, y: 0 }, { x: d * 0.95, y: 0 }];
    if (n === 3) return [0, 1, 2].map((i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3; return { x: d * Math.cos(a), y: d * Math.sin(a) }; });
    return [0, 1, 2, 3].map((i) => { const a = Math.PI / 4 + (i * Math.PI) / 2; return { x: d * Math.cos(a), y: d * Math.sin(a) }; });
  }

  function placePatty(s, patty, pos) {
    if (patty.where === 'pan') return;
    if (!s.patties.includes(patty)) s.patties.push(patty);
    patty.where = 'pan'; patty.pos = pos || patty.pos || { x: 0, y: 0 };
    selectPatty(s, patty);
    patty.faceDown.stuck = true;
    patty.timeDown = 0;
    patty.dirtAtStart = panDirt(s.pan);
    if (patty.dirtAtStart > 0.002) logEvent(s, 'The pan is dirty: burnt bits from earlier tickets will stick to this crust and smoke.', 'warn');
    const Tunder = panTat(s.pan, Math.hypot(patty.pos.x, patty.pos.y));
    const others = s.patties.filter((q) => q !== patty && q.where === 'pan').length;
    logEvent(s, `Patty ${patty.id} (${(patty.massKg0 * 1000).toFixed(0)} g, ${(patty.h0 * 1000).toFixed(0)} mm, ${(patty.fatFrac * 100).toFixed(0)} % fat, ${patty.T0.toFixed(0)} °C) hits the ${s.grill ? 'grate' : 'pan'} at ${Tunder.toFixed(0)} °C under it` + (others ? ` — ${others + 1} ${s.grill ? 'on the grate' : 'in the pan'} now, and every cold patty drags the metal down.` : '.'), 'action');
    if (s.grill && (!s.grill.lit || s.grill.Tfire < 350)) logEvent(s, 'The coals are not ready. Meat over a cool fire steams and sticks; wait for the bed to glow.', 'warn');
    else if (!s.grill && Tunder < 120) logEvent(s, 'The pan is not hot enough there. The meat will steam in its own juice and go grey.', 'warn');
  }

  function flipPatty(s, patty) {
    const p = patty || s.patty; if (!p || p.where !== 'pan') return { ok: false };
    const fd = p.faceDown;
    const relThr = s.pan.release * (s.pan.oil > 0.002 ? 0.7 : 1.0);
    let torn = 0;
    if (fd.stuck && fd.brown < relThr && s.pan.release > 0) {
      torn = clamp(0.25 * (1 - fd.brown / relThr), 0.03, 0.25);
      const m0 = layerMass(p, 0);
      for (const k of ['w', 'fs', 'fl', 'fr', 'p']) for (let j = 0; j < p.Nr; j++) { p.lostStuck += p[k][j] * torn; p[k][j] *= (1 - torn); }
      s.pan.fond += m0 * torn * 0.3; s.pan.meatBits += m0 * torn;
      fd.torn += torn;
      logEvent(s, `Patty ${p.id} stuck. ${(torn * 100).toFixed(0)} % of the bottom face tore off and stayed welded to the pan. Meat releases on its own once the crust sets.`, 'warn');
    }
    // Orientation reversal: reverse every column.
    for (const k of ['T', 'w', 'w0c', 'fs', 'fl', 'fr', 'fat0c', 'p', 'dM', 'dC', 'dA', 'dG']) {
      const a = p[k];
      for (let j = 0; j < p.Nr; j++) for (let lo = 0, hi = p.Nz - 1; lo < hi; lo++, hi--) { const t = a[lo * p.Nr + j]; a[lo * p.Nr + j] = a[hi * p.Nr + j]; a[hi * p.Nr + j] = t; }
    }
    p.w0 = p.w0c[0]; p.fat0 = p.fat0c[0];
    const tmp = p.faceDown; p.faceDown = p.faceUp; p.faceUp = tmp;
    let juiceHit = 0; for (let j = 0; j < p.Nr; j++) { juiceHit += p.poolT[j]; p.poolT[j] = 0; p.poolB[j] = 0; }
    // over coals there is no pan to catch any of it: the juice that was pooled on top and the fat
    // wicked to the surface go through the bars onto the fire
    if (s.grill) { s.grill.juiceOnCoals = (s.grill.juiceOnCoals || 0) + juiceHit; s.grill.fatOnCoals += p.fatTop; }
    else { s.pan.water += juiceHit; s.pan.oil += p.fatTop; }
    p.poolTop = 0; p.poolBottom = 0; p.fatTop = 0;
    p.faceDown.stuck = true;
    if (p._snap) p._snap.valid = false; // the columns have been reversed: the old snapshot is upside down
    p.faceDown.crisp = Math.max(0, p.faceDown.crisp - 0.1);
    p.flips++; p.timeDown = 0;
    p.dome *= 0.6;
    {
      const up = p.cheeses, under = p.cheeseUnder; let welded = 0;
      for (const ch of under) { const sk = ch.skirt; const lossF = sk ? clamp(0.3 * sk.dry + 0.6 * sk.char, 0, 0.9) : 0; const lost = ch.mass * lossF; ch.mass -= lost; welded += lost; ch.fried = true; }
      s.pan.fond += welded * 0.3; s.pan.cheeseBits += welded;
      p.cheeses = under.filter((ch) => ch.mass > 0.003);
      p.cheeseUnder = up;
      if (up.length) logEvent(s, `Flipped with ${up.length} slice${up.length > 1 ? 's' : ''} of cheese on it. The cheese is now between the meat and the pan: it will fry, weld to the metal, and insulate that side.`, 'warn');
      if (under.length) logEvent(s, welded > 0.002 ? `${(welded * 1000).toFixed(0)} g of fried cheese stayed welded to the pan; the rest came up as a burnt lace on top.` : 'The fried cheese came back up on top.', under.length && welded > 0.002 ? 'warn' : 'info');
    }
    logEvent(s, `Patty ${p.id}: flip #${p.flips}. Face ${p.faceDown.id} down.` + (juiceHit > 0.0005 ? ` ${(juiceHit * 1000).toFixed(1)} g of pooled juice ${s.grill ? 'fell through the bars and hissed on the coals' : 'hit the pan and flashed to steam'}.` : ''), 'action');
    return { ok: true, torn };
  }

  function pressPatty(s, hard, patty) {
    const p = patty || s.patty; if (!p || p.where !== 'pan') return;
    const cooked = gridMean(p, p.dM);
    p.pressT = 1.5; p.pressed = true;
    let expelled = 0;
    for (let c = 0; c < p.T.length; c++) {
      const free = Math.max(0, p.w[c] - waterHolding(p, c) * p.w0c[c]);
      let out = free;
      if (p.dM[c] > 0.3) out += p.w[c] * (hard ? 0.16 : 0.10) * p.dM[c] * (0.5 + 0.5 * p.dA[c] + 0.5 * p.dC[c]);
      out = Math.min(out, p.w[c]);
      p.w[c] -= out; expelled += out;
      const fatOut = p.fr[c] * 0.7; p.fr[c] -= fatOut; p.lostFat += fatOut; if (s.grill) s.grill.fatOnCoals += fatOut; else s.pan.oil += fatOut;
    }
    p.lostWaterDrip += expelled; if (s.grill) s.grill.juiceOnCoals = (s.grill.juiceOnCoals || 0) + expelled; else s.pan.water += expelled;
    p.dome = 0;
    if (hard && s.grill) {
      // You cannot smash on a grate: there is no flat surface to spread against, the meat just
      // squeezes down between the bars. It presses (juice and fat go straight on the coals) but
      // the patty keeps its shape.
      logEvent(s, `Leaned on patty ${p.id} with the spatula, but a grate is bars and air: nothing to smash it against. ${(expelled * 1000).toFixed(1)} g of juice and the fat went straight down onto the coals.`, 'warn');
      return;
    }
    if (cooked < 0.25 && hard) {
      let hNew = Math.max(0.004, p.h * 0.55);
      const Dmax = 2 * s.pan.floorR * 0.94;
      const V = p.A * p.h;
      let Anew = V / hNew, Dnew = Math.sqrt((4 * Anew) / Math.PI);
      let hitWall = false;
      if (Dnew > Dmax) { Dnew = Dmax; Anew = (Math.PI * Dnew * Dnew) / 4; hNew = V / Anew; hitWall = true; }
      if (hNew >= p.h * 0.98) { logEvent(s, 'Pressed hard, but it already fills the pan: nowhere left to go.', 'action'); return; }
      p.h = hNew; p.A = Anew; p.D = Dnew;
      if (p._snap) p._snap.valid = false; // a smash re-forms the grid; the old snapshot is a different patty
      p.h0 = p.h; p.A0 = p.A; p.D0 = p.D;
      p.faceDown.stuck = true;
      logEvent(s, `SMASHED. Patty ${p.id} flattened to ${(p.h * 1000).toFixed(0)} mm, ${(p.D * 100).toFixed(1)} cm across.` + (hitWall ? ' It has hit the pan wall.' : ' Huge contact area, huge crust, no pink centre.'), 'action');
    } else {
      logEvent(s, `Pressed patty ${p.id} with the spatula. ${(expelled * 1000).toFixed(1)} g of juice squeezed out and boiled off. That was flavour.`, expelled > 0.002 ? 'warn' : 'action');
    }
  }

  function removePatty(s, patty) {
    const p = patty || s.patty; if (!p || p.where !== 'pan') return;
    const fd = p.faceDown;
    const relThr = s.pan.release * (s.pan.oil > 0.002 ? 0.7 : 1.0);
    if (fd.stuck && fd.brown < relThr && s.pan.release > 0) {
      const torn = clamp(0.25 * (1 - fd.brown / relThr), 0.03, 0.25);
      for (const k of ['w', 'fs', 'fl', 'fr', 'p']) for (let j = 0; j < p.Nr; j++) { p.lostStuck += p[k][j] * torn; p[k][j] *= (1 - torn); }
      fd.torn += torn;
      logEvent(s, `Scraped patty ${p.id} off the pan; the bottom crust stayed behind.`, 'warn');
    }
    if (s.grill) s.grill.fatOnCoals += p.fatTop; else s.pan.oil += p.fatTop;
    p.fatTop = 0;
    p.where = 'rest'; p.restT = 0; if (s.patty === p) s.where = 'rest';
    for (let j = 0; j < p.Nr; j++) p.poolB[j] = 0; p.poolBottom = 0; p.dripAtRest = p.lostWaterDrip;
    p.faceDown.crispAtRest = p.faceDown.crisp; p.faceUp.crispAtRest = p.faceUp.crisp;
    p.peakCenter = Math.max(p.peakCenter, centerT(p));
    if (!s.patties.some((q) => q.where === 'pan')) s.rest.t = 0;
    logEvent(s, `Patty ${p.id} off the heat after ${fmtTime(p.cookTime)}. Centre ${centerT(p).toFixed(1)} °C. Resting — carry-over cooking begins.`, 'action');
  }

  function addCheese(s, patty) {
    const p = patty || s.patty; if (!p || p.where !== 'pan' || p.cheeses.length >= 24) return;
    const k = p.cheeses.length;
    p.cheeses.push({ T: s.env.Tamb, melt: 0, mass: 0.02, rot: k * 0.42 + (Math.random() - 0.5) * 0.2, overhang: 0, contact: 0, skirt: null });
    logEvent(s, k === 0 ? `Slice of American cheese on patty ${p.id} (20 g). Processed cheese softens around 45 °C and flows by 60 °C; a lid speeds it up.` : `Another slice on patty ${p.id} (${k + 1} on the stack, ${(20 * (k + 1))} g). The top of the pile heats through the slices under it.`, 'action');
  }
  function toggleLid(s) {
    s.lid = !s.lid;
    if (s.grill) logEvent(s, s.lid ? 'Lid on. The kettle is an oven now: hot air and the dome\'s radiant heat cook the top face; less air for the coals, so the fire calms down a little.' : 'Lid off. Full air to the coals.', 'action');
    else logEvent(s, s.lid ? 'Lid on. Steam trapped: the top face will cook from condensing vapour and the crust will soften.' : 'Lid off.', 'action');
  }
  function basteButter(s) {
    if (!s.patties.some((q) => q.where === 'pan')) return;
    addFat(s, 'butter', 15);
    s.baste = 12;
    logEvent(s, 'Basting: spooning hot butter over the top for ~12 s.', 'action');
  }

  // ---------------------------------------------------------------- physics
  function waterHolding(p, c) {
    let whc = 1 - 0.06 * p.dM[c] - 0.06 * p.dC[c] - 0.28 * p.dA[c];
    if (p.salt === 'mixed') whc += 0.06;
    if (p.salt === 'none') whc -= 0.02;
    whc -= 0.05 * p.work;
    return clamp(whc, 0.3, 1.02);
  }

  const CHEESE_SIDE = 0.095, CHEESE_THICK = 0.0015, CHEESE_WATER = 0.38;
  function stepCheeseSkirt(p, ch, k, dt, bc) {
    const R = p.D / 2, baseY = p.h * (1 + 0.28 * p.dome) + k * CHEESE_THICK;
    // a slice that has lost mass (dripped through a grate) covers less: same thickness, so the
    // square shrinks as the square root of what is left of it
    const side = CHEESE_SIDE * Math.sqrt(clamp(ch.mass / 0.02, 0, 1));
    const n = 10; let overN = 0, touchN = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x = ((i + 0.5) / n - 0.5) * side, z = ((j + 0.5) / n - 0.5) * side;
      const over = Math.hypot(x, z) - R * 0.98; if (over <= 0) continue;
      overN++;
      if (bc.bottom.type === 'pan' && over * (0.2 + 1.6 * ch.melt) >= baseY) touchN++;
    }
    ch.overhang = overN / (n * n); ch.contact = overN ? touchN / overN : 0;
    const inOil = !!bc.top.oil;
    if (inOil) { ch.overhang = 1; ch.contact = 1; ch.melt = clamp(ch.melt + 0.5 * dt, 0, 1); }
    ch.submerged = inOil;
    if (bc.bottom.type === 'grill') {
      // A grate has nothing under the overhang to hold it: once the slice is molten the part
      // hanging past the meat sags between the bars and falls on the coals. Melted processed
      // cheese is thick (emulsifying salts keep it from running like a sauce), so it leaves at
      // ~1.5 %/s of what is hanging over: a 20 g slice on a 10 cm patty has ~4 g past the rim and
      // loses it over a minute or so, and stops once the slice has pulled back inside the meat.
      const sag = ch.mass * ch.overhang * 0.015 * ch.melt * ch.melt * dt;
      ch.mass -= sag; ch.pending = (ch.pending || 0) + sag;
      // it does not run off in a film: surface tension holds the sagging cheese until about a
      // gram has gathered on the low corner and the gob lets go all at once, which is why
      // cheese on a grill flares in bursts rather than smouldering steadily
      if (ch.pending >= 0.0008) { p.cheeseDrip = (p.cheeseDrip || 0) + ch.pending; ch.dripped = (ch.dripped || 0) + ch.pending; ch.pending = 0; }
      ch.contact = 0; // nothing to fry against: no skirt on a grate, it simply leaves
    }
    const sk = ch.skirt || (ch.skirt = { T: ch.T, water: CHEESE_WATER, melt: 0, brown: 0, char: 0, dry: 0, charRate: 0, mass: 0 });
    const massS = ch.mass * ch.overhang * ch.contact; sk.mass = massS;
    if (massS < 1e-5) { sk.T += (ch.T - sk.T) * Math.min(1, dt / 2); sk.charRate = 0; return; }
    const areaS = side * side * ch.overhang * ch.contact;
    const Cs = massS * (1500 + 4180 * sk.water);
    const Tpan = bc.bottom.Tedge == null ? bc.bottom.T : bc.bottom.Tedge;
    const q = inOil ? 2 * C.hOil * areaS * (bc.top.T - sk.T) : 200 * areaS * (Tpan - sk.T) - 12 * areaS * (sk.T - bc.top.T);
    let Tn = sk.T + (q * dt) / Cs;
    if (Tn > C.Tboil && sk.water > 0) {
      const excess = Cs * (Tn - C.Tboil); const m = Math.min(sk.water * massS, excess / C.Lvap);
      sk.water = Math.max(0, sk.water - m / massS); Tn = C.Tboil + (excess - m * C.Lvap) / Cs;
    }
    sk.T = Tn;
    cheeseChemistry(sk, dt);
  }
  function cheeseChemistry(sk, dt) {
    sk.melt = clamp(sk.melt + 0.15 * sig(sk.T, 52, 5) * dt, 0, 1);
    sk.dry = 1 - clamp(sk.water / CHEESE_WATER, 0, 1);
    const fAw = 0.15 + 0.85 * smooth(0.3, 0.9, sk.dry);
    sk.brown += arrh(C.Am * 2, C.EaM, sk.T) * fAw * Math.max(0, 1 - sk.brown / C.Bmax) * dt;
    const rC = arrh(C.Ac * 2, C.EaC, sk.T) * (0.3 + 0.7 * smooth(0.6, 1, sk.dry)) * Math.max(0, 1 - sk.char / C.Cmax);
    sk.char += rC * dt; sk.charRate = rC;
  }
  function stepCheeseUnder(p, dt, bc, TbotMean) {
    const cu = p.cheeseUnder, n = cu.length, A = p.A;
    const onPan = bc.bottom.type === 'pan';
    // 250 W/(m² K) for molten cheese wetting metal — poorer than meat on metal because the layer
    // itself is an insulator. Over coals the cheese lies on the bars like the meat does: line
    // contact on barFrac of it, the fire's radiation and hot gas through the gaps.
    const gc = 300 * A;
    const flux = new Array(n + 1);
    if (bc.bottom.type === 'grill') {
      const g = bc.bottom, Tk = cu[0].T + 273.15;
      flux[0] = A * (g.barFrac * 200 * (g.Tbar - cu[0].T)
        + (1 - g.barFrac) * (0.9 * C.sigma * g.view * ((g.Tfire + 273.15) ** 4 - Tk ** 4) + 25 * (g.Tair - cu[0].T)));
    } else flux[0] = (onPan ? 250 : bc.bottom.h) * A * (bc.bottom.T - cu[0].T);
    for (let k = 1; k < n; k++) flux[k] = gc * (cu[k - 1].T - cu[k].T);
    flux[n] = gc * (cu[n - 1].T - TbotMean);
    for (let k = 0; k < n; k++) {
      const ch = cu[k];
      const sk = ch.skirt || (ch.skirt = { T: ch.T, water: CHEESE_WATER, melt: 0, brown: 0, char: 0, dry: 0, charRate: 0, mass: 0 });
      ch.overhang = 1; ch.contact = 1; ch.fried = true; sk.mass = ch.mass;
      const Cs = ch.mass * (1500 + 4180 * sk.water);
      let Tn = ch.T + ((flux[k] - flux[k + 1]) * dt) / Cs;
      if (Tn > C.Tboil && sk.water > 0) {
        const excess = Cs * (Tn - C.Tboil); const m = Math.min(sk.water * ch.mass, excess / C.Lvap);
        sk.water = Math.max(0, sk.water - m / ch.mass); Tn = C.Tboil + (excess - m * C.Lvap) / Cs;
      }
      ch.T = Tn; sk.T = Tn; ch.melt = clamp(ch.melt + 0.5 * sig(Tn, 52, 5) * dt, 0, 1);
      cheeseChemistry(sk, dt);
    }
    return { qPan: flux[0], qMeat: flux[n], hc: 300 };
  }

  /**
   * Advance the patty by dt (s). bc.bottom: {type:'pan', Tat(r), T, Tedge, oil, hcMul, release}
   * | {type:'air', h, T} | {type:'grill', ...}; bc.top: {h, T, RH, oil?}; bc.side: {T, oilDepth, oilT, rad?}.
   */
  function stepPatty(s, p, dt, bc) {
    const Nz = p.Nz, Nr = p.Nr, A = p.A, R = p.D / 2, dz = p.h / Nz, dr = R / Nr;
    const T = p.T, n = Nz * Nr;
    p.cheeseDrip = 0; // cheese that leaves the slice this step (only happens over a grate)
    const Cn = new Float64Array(n), Kn = new Float64Array(n), Q = new Float64Array(n);
    for (let c = 0; c < n; c++) { Cn[c] = cellHeatCap(p, c); Kn[c] = cellK(p, c); }
    for (let j = 0; j < Nr; j++) { Cn[j] += p.poolB[j] * C.cpW; Cn[(Nz - 1) * Nr + j] += p.poolT[j] * C.cpW + p.fatTop * p.aj[j] * C.cpF; }
    const Aj = (j) => A * p.aj[j];

    // ---- conduction: vertical within each ring, radial within each layer
    for (let k = 0; k < Nz; k++) for (let j = 0; j < Nr; j++) {
      const c = k * Nr + j;
      if (k < Nz - 1) {
        const d = c + Nr; const kI = (2 * Kn[c] * Kn[d]) / (Kn[c] + Kn[d] + 1e-9);
        const q = ((kI * Aj(j)) / dz) * (T[d] - T[c]); Q[c] += q; Q[d] -= q;
      }
      if (j < Nr - 1) {
        const d = c + 1; const kI = (2 * Kn[c] * Kn[d]) / (Kn[c] + Kn[d] + 1e-9);
        const q = ((kI * 2 * Math.PI * (j + 1) * dr * dz) / dr) * (T[d] - T[c]); Q[c] += q; Q[d] -= q;
      }
    }

    // ---- bottom boundary, per ring
    const qBotR = new Float64Array(Nr), TpanR = new Float64Array(Nr), hcR = new Float64Array(Nr);
    let qBot = 0, qPan = 0, hc = 0;
    let TbotMean = 0; for (let j = 0; j < Nr; j++) TbotMean += T[j] * p.aj[j];
    if (p.cheeseUnder.length) {
      const r = stepCheeseUnder(p, dt, bc, TbotMean);
      for (let j = 0; j < Nr; j++) { qBotR[j] = r.qMeat * p.aj[j]; Q[j] += qBotR[j]; TpanR[j] = bc.bottom.T; }
      qBot = r.qMeat; qPan = r.qPan; hc = r.hc;
    } else if (bc.bottom.type === 'pan' || bc.bottom.type === 'grill') {
      const oilFilm = clamp((bc.bottom.oil || 0) / 0.003, 0, 1);
      const fd = p.faceDown;
      for (let j = 0; j < Nr; j++) {
        const rc = (j + 0.5) * dr;
        const Tp = bc.bottom.Tat ? bc.bottom.Tat(rc) : bc.bottom.T; TpanR[j] = Tp;
        // doming lifts the centre off the metal; pressing flattens it back on
        const lift = p.dome * clamp(1 - rc / (0.65 * R), 0, 1);
        const contact = clamp(1 - lift, 0.05, 1) * (p.pressT > 0 ? 1.4 : 1);
        const boiling = p.poolB[j] > 1e-7 || (T[j] > 98 && p.w[j] > 0.2 * p.w0c[j]);
        const dry0 = 1 - clamp(p.w[j] / p.w0c[j], 0, 1);
        const crust = 1 - 0.35 * smooth(0.5, 1, dry0) - 0.15 * clamp(fd.brownR[j] / 4, 0, 1) - 0.3 * clamp(fd.charR[j], 0, 1);
        let q;
        if (bc.bottom.type === 'grill') {
          // grate bars: line contact over a fraction of the area; the rest sees the fire
          const g = bc.bottom;
          const Tsk = T[j] + 273.15;
          const hcBar = 200 * crust * contact;
          const qBar = g.barFrac * hcBar * (g.Tbar - T[j]);
          const qRad = (1 - g.barFrac) * (0.9 * C.sigma * g.view * ((g.Tfire + 273.15) ** 4 - Tsk ** 4) + 25 * (g.Tair - T[j]));
          hcR[j] = g.barFrac * hcBar + (1 - g.barFrac) * 25; q = (qBar + qRad) * Aj(j);
        } else {
          hcR[j] = C.hContactBase * bc.bottom.hcMul * (1 + 0.5 * oilFilm) * (boiling ? 1.25 : 1) * crust * contact;
          q = hcR[j] * Aj(j) * (Tp - T[j]);
        }
        qBotR[j] = q; Q[j] += q; qBot += q; hc += hcR[j] * p.aj[j];
      }
      qPan = qBot;
    } else {
      for (let j = 0; j < Nr; j++) { const q = bc.bottom.h * Aj(j) * (bc.bottom.T - T[j]); qBotR[j] = q; Q[j] += q; qBot += q; TpanR[j] = bc.bottom.T; }
      qPan = qBot;
    }

    // ---- top boundary
    let hTop = bc.top.h, TairTop = bc.top.T, qTop = 0;
    const top = (j) => (Nz - 1) * Nr + j;
    let TtopMean = 0; for (let j = 0; j < Nr; j++) TtopMean += T[top(j)] * p.aj[j];
    if (p.cheeses.length) {
      const cs = p.cheeses, m = cs.length, gc = 300 * A;
      const flux = new Array(m + 1);
      flux[0] = gc * (1 + cs[0].melt) * (TtopMean - cs[0].T);
      for (let k = 1; k < m; k++) flux[k] = gc * (1 + Math.min(cs[k - 1].melt, cs[k].melt)) * (cs[k - 1].T - cs[k].T);
      // under a lid the dome radiates onto the top slice as well as blowing hot air over it —
      // that is why a kettle lid melts cheese in seconds where open air takes a minute
      flux[m] = hTop * A * (TairTop - cs[m - 1].T)
        + (bc.top.rad ? A * 0.9 * C.sigma * bc.top.radView * ((bc.top.radT + 273.15) ** 4 - (cs[m - 1].T + 273.15) ** 4) : 0);
      for (let k = 0; k < m; k++) {
        const ch = cs[k], Cc = ch.mass * 2500;
        ch.T += ((flux[k] - (k < m - 1 ? flux[k + 1] : -flux[m])) * dt) / Cc;
        ch.melt = clamp(ch.melt + 0.08 * sig(ch.T, 52, 5) * dt, 0, 1);
        stepCheeseSkirt(p, ch, k, dt, bc);
      }
      for (let j = 0; j < Nr; j++) Q[top(j)] -= flux[0] * p.aj[j];
    } else {
      for (let j = 0; j < Nr; j++) {
        let q = hTop * Aj(j) * (TairTop - T[top(j)]);
        if (bc.top.rad) q += Aj(j) * 0.9 * C.sigma * bc.top.radView * ((bc.top.radT + 273.15) ** 4 - (T[top(j)] + 273.15) ** 4);
        Q[top(j)] += q; qTop += q;
      }
    }
    if (s.baste > 0) { const q = 150 * A * ((bc.bottom.T || 150) - 40 - TtopMean); for (let j = 0; j < Nr; j++) Q[top(j)] += Math.max(0, q) * p.aj[j]; }

    // ---- edge boundary (outer ring of every layer)
    const per = 2 * Math.PI * R; let qSide = 0;
    for (let k = 0; k < Nz; k++) {
      const c = k * Nr + Nr - 1, z = (k + 0.5) * dz;
      const inOil = bc.side.oilDepth > z;
      let q;
      if (inOil) q = C.hOil * per * dz * (bc.side.oilT - T[c]);
      else {
        q = (bc.side.h || C.hAirSide) * per * dz * (bc.side.T - T[c]);
        if (bc.side.rad) q += per * dz * 0.9 * C.sigma * bc.side.radView * ((bc.side.radT + 273.15) ** 4 - (T[c] + 273.15) ** 4);
      }
      Q[c] += q; qSide += q;
    }

    // ---- top evaporation (Magnus): from pooled juice first, then tissue, per ring
    let evapTop = 0;
    if (!p.cheeses.length && bc.top.RH < 0.99) {
      for (let j = 0; j < Nr; j++) {
        const c = top(j), Ts = T[c];
        const X = p.w[c] / (p.p[c] + 1e-9);
        const aw = p.poolT[j] > 1e-8 ? 1 : 1 - Math.exp(-8 * X);
        const drive = Math.max(0, aw * rhoVapSat(Ts) - bc.top.RH * rhoVapSat(bc.top.T));
        let m = C.hMass * Aj(j) * drive * dt;
        const maxByEnergy = Math.max(0, (Cn[c] * (Ts - (bc.top.T - 8))) / C.Lvap);
        m = Math.min(m, maxByEnergy, p.poolT[j] + p.w[c]);
        const fromPool = Math.min(m, p.poolT[j]); p.poolT[j] -= fromPool; p.w[c] -= (m - fromPool);
        Q[c] -= (m * C.Lvap) / dt; evapTop += m / dt; p.lostWaterEvap += m;
      }
    }

    // ---- integrate temperatures with the boiling clamp in every cell
    let boil = 0, boilBottom = 0;
    for (let k = 0; k < Nz; k++) for (let j = 0; j < Nr; j++) {
      const c = k * Nr + j;
      let Tn = T[c] + (Q[c] * dt) / Cn[c];
      const water = p.w[c] + (k === 0 ? p.poolB[j] : 0) + (k === Nz - 1 ? p.poolT[j] : 0);
      if (Tn > C.Tboil && water > 1e-10) {
        const excess = Cn[c] * (Tn - C.Tboil);
        const m = Math.min(water, excess / C.Lvap);
        let rem = m;
        if (k === 0) { const a = Math.min(rem, p.poolB[j]); p.poolB[j] -= a; rem -= a; }
        if (k === Nz - 1) { const a = Math.min(rem, p.poolT[j]); p.poolT[j] -= a; rem -= a; }
        p.w[c] -= rem;
        Tn = C.Tboil + (excess - m * C.Lvap) / Cn[c];
        boil += m; if (k <= 1) boilBottom += m; p.lostWaterEvap += m;
      }
      T[c] = Tn;
    }
    p.steamRate = boil / dt + evapTop; p.boilBottom = boilBottom / dt; p.evapTop = evapTop;

    // ---- denaturation kinetics
    for (let c = 0; c < n; c++) {
      const Ti = T[c];
      p.dM[c] += 0.25 * sig(Ti, 52, 2.5) * (1 - p.dM[c]) * dt;
      p.dC[c] += 0.12 * sig(Ti, 61, 3) * (1 - p.dC[c]) * dt;
      p.dA[c] += 0.10 * sig(Ti, 68, 1.5) * (1 - p.dA[c]) * dt;
      p.dG[c] += 0.06 * sig(Ti, 64, 1.5) * (1 - p.dG[c]) * dt;
      if (Ti > p.Tpk[c]) p.Tpk[c] = Ti;
    }

    // ---- capillary moisture diffusion (vertical and radial)
    {
      const rhoDry = 420;
      const X = new Float64Array(n); for (let c = 0; c < n; c++) X[c] = p.w[c] / (p.p[c] + 1e-9);
      for (let k = 0; k < Nz; k++) for (let j = 0; j < Nr; j++) {
        const c = k * Nr + j;
        if (k < Nz - 1) {
          const d = c + Nr; const dry = Math.min(T[c], T[d]) > 0 ? 1 : 0.05;
          let f = ((C.Dw * dry * rhoDry * Aj(j) * (X[d] - X[c])) / dz) * dt; f = clamp(f, -p.w[c] * 0.5, p.w[d] * 0.5);
          p.w[c] += f; p.w[d] -= f;
        }
        if (j < Nr - 1) {
          const d = c + 1; const dry = Math.min(T[c], T[d]) > 0 ? 1 : 0.05;
          let f = ((C.Dw * dry * rhoDry * 2 * Math.PI * (j + 1) * dr * dz * (X[d] - X[c])) / dr) * dt; f = clamp(f, -p.w[c] * 0.5, p.w[d] * 0.5);
          p.w[c] += f; p.w[d] -= f;
        }
      }
    }
    // ---- juice expulsion: free water moves toward the nearest face
    const fz = Math.min(1, (C.vJuice * dt) / dz), frr = Math.min(1, (C.vJuice * dt) / dr);
    let toSide = 0;
    const flux = new Float64Array(n), dir = new Int8Array(n); // 0 down, 1 up, 2 out
    for (let k = 0; k < Nz; k++) for (let j = 0; j < Nr; j++) {
      const c = k * Nr + j;
      const free = Math.max(0, p.w[c] - waterHolding(p, c) * p.w0c[c]);
      if (free <= 0) continue;
      const dB = (k + 0.5) * dz, dT = (Nz - k - 0.5) * dz, dS = R - (j + 0.5) * dr;
      // juice mostly follows the fibre grain toward a flat face; only the last couple of
      // millimetres at the rim weep out of the side
      if (dS < 0.6 * Math.min(dB, dT)) { dir[c] = 2; flux[c] = free * frr; } else if (dB <= dT) { dir[c] = 0; flux[c] = free * fz; } else { dir[c] = 1; flux[c] = free * fz; }
    }
    for (let k = 0; k < Nz; k++) for (let j = 0; j < Nr; j++) {
      const c = k * Nr + j, f = flux[c]; if (f <= 0) continue;
      p.w[c] -= f;
      if (dir[c] === 2) { if (j === Nr - 1) toSide += f; else p.w[c + 1] += f; }
      else if (dir[c] === 0) { if (k === 0) p.poolB[j] += f; else p.w[c - Nr] += f; }
      else { if (k === Nz - 1) p.poolT[j] += f; else p.w[c + Nr] += f; }
    }
    // top pool: beads run off the edge (faster when domed)
    let poolTop = 0, poolBottom = 0;
    for (let j = 0; j < Nr; j++) { const run = p.poolT[j] * (0.04 + 0.2 * p.dome) * dt; p.poolT[j] -= run; toSide += run; poolTop += p.poolT[j]; poolBottom += p.poolB[j]; }
    p.poolTop = poolTop; p.poolBottom = poolBottom;
    const juiceSide = toSide; p.lostWaterDrip += juiceSide;

    // ---- fat: melt, release, drain down each column; the outer ring also leaks out the side
    let fatDrip = 0, fatSide = 0;
    const fmv = new Float64Array(n);
    for (let c = 0; c < n; c++) {
      const Ti = T[c];
      const melt = p.fs[c] * Math.min(1, 0.06 * sig(Ti, 42, 3) * dt); p.fs[c] -= melt; p.fl[c] += melt;
      const kRel = 0.0035 * sig(Ti, 66, 6) * (1 + Math.max(0, Ti - 66) / 40);
      const rel = p.fl[c] * Math.min(1, kRel * dt); p.fl[c] -= rel; p.fr[c] += rel;
      const visc = clamp((Ti - 38) / 50, 0.05, 1.6);
      fmv[c] = Math.min(1, (C.vFat * visc * dt) / dz);
    }
    for (let k = Nz - 1; k >= 0; k--) for (let j = 0; j < Nr; j++) {
      const c = k * Nr + j, f = p.fr[c] * fmv[c]; if (f <= 0) continue;
      p.fr[c] -= f;
      const side = j === Nr - 1 ? f * 0.35 : 0; fatSide += side;
      if (k === 0) fatDrip += f - side; else p.fr[c - Nr] += f - side;
    }
    { let wick = 0; for (let j = 0; j < Nr; j++) { const c = top(j); const w = p.fr[c] * 0.02 * dt; p.fr[c] -= w; wick += w; } p.fatTop += wick; }
    const fatTopRun = p.fatTop * 0.05 * dt; p.fatTop -= fatTopRun; fatSide += fatTopRun;
    p.lostFat += fatDrip + fatSide;

    // ---- surface chemistry per ring on the face in contact with the heat
    const fd = p.faceDown; let surfT = 0, dryMean = 0; const TsLim = new Float64Array(Nr);
    for (let j = 0; j < Nr; j++) {
      const c = j;
      let Ts = T[c] + (Math.max(0, qBotR[j]) / Aj(j)) * (dz / 2) / Math.max(Kn[c], 0.05);
      if (p.w[c] > 0.25 * p.w0c[c] || p.poolB[j] > 1e-8) Ts = Math.min(Ts, C.Tboil + 2);
      // a pan surface cannot exceed the pan; over coals the crust settles where the radiant input
      // balances re-radiation and conduction inward — well below the bed, but hotter than a pan
      const Tlim = bc.bottom.type === 'pan' ? TpanR[j] : bc.bottom.type === 'grill' ? bc.bottom.Tsurf : Infinity;
      Ts = Math.min(Ts, Tlim); TsLim[j] = Tlim;
      if (p.cheeseUnder.length) Ts = Math.min(Ts, p.cheeseUnder[p.cheeseUnder.length - 1].T);
      surfT += Ts * p.aj[j];
      fd.maxT = Math.max(fd.maxT, Ts);
      const dryness = 1 - clamp(p.w[c] / p.w0c[c], 0, 1); dryMean += dryness * p.aj[j];
      const fAw = 0.12 + 0.88 * smooth(0.25, 0.85, dryness);
      fd.brownR[j] += arrh(C.Am, C.EaM, Ts) * fAw * Math.max(0, 1 - fd.brownR[j] / C.Bmax) * dt;
      const rC = arrh(C.Ac, C.EaC, Ts) * (0.3 + 0.7 * smooth(0.6, 1, dryness)) * Math.max(0, 1 - fd.charR[j] / C.Cmax);
      fd.charR[j] += rC * dt;
      if (bc.bottom.type === 'grill') {
        // the bars press hotter lines into the face: a separate, faster browning track
        const Tb = Math.min(bc.bottom.Tbar, bc.bottom.Tsurf + 60, T[c] + (Math.max(0, qBotR[j]) / Aj(j)) * (dz / 2) / Math.max(Kn[c], 0.05) + 40);
        fd.marks = (fd.marks || 0) + (arrh(C.Am, C.EaM, Tb) * fAw * Math.max(0, 1 - (fd.marks || 0) / C.Bmax) * dt) * p.aj[j];
        fd.marksChar = (fd.marksChar || 0) + arrh(C.Ac, C.EaC, Tb) * (0.3 + 0.7 * smooth(0.6, 1, dryness)) * Math.max(0, 1 - (fd.marksChar || 0) / C.Cmax) * dt * p.aj[j];
      }
    }
    faceMean(p, fd);
    p.surfT = surfT;
    fd.charRate = 0; for (let j = 0; j < Nr; j++) fd.charRate += arrh(C.Ac, C.EaC, Math.min(TpanR[j], TsLim[j])) * p.aj[j] * clamp(fd.charR[j] / 0.3, 0, 1);
    fd.crisp = clamp(fd.crisp + (dryMean > 0.6 ? 0.02 : -0.01) * dt, 0, 1);
    if (fd.stuck && (fd.brown >= 0.5 * (bc.bottom.release || 1) + 0.15 || dryMean > 0.6)) fd.stuck = false;
    // top face: submerged in hot fat or under a broiling lid it browns like the bottom
    const fu = p.faceUp;
    if ((bc.top.oil || bc.top.rad) && !p.cheeses.length) {
      for (let j = 0; j < Nr; j++) {
        const c = top(j);
        let TsT = T[c] + (Math.max(0, qTop * p.aj[j]) / Aj(j)) * (dz / 2) / Math.max(Kn[c], 0.05);
        if (p.w[c] > 0.25 * p.w0c[c] || p.poolT[j] > 1e-8) TsT = Math.min(TsT, C.Tboil + 2);
        TsT = Math.min(TsT, bc.top.oil ? bc.top.T : bc.top.radT);
        fu.maxT = Math.max(fu.maxT, TsT);
        const dryT = 1 - clamp(p.w[c] / p.w0c[c], 0, 1);
        const fAwT = 0.12 + 0.88 * smooth(0.25, 0.85, dryT);
        fu.brownR[j] += arrh(C.Am, C.EaM, TsT) * fAwT * Math.max(0, 1 - fu.brownR[j] / C.Bmax) * dt;
        fu.charR[j] += arrh(C.Ac, C.EaC, TsT) * (0.3 + 0.7 * smooth(0.6, 1, dryT)) * Math.max(0, 1 - fu.charR[j] / C.Cmax) * dt;
      }
      faceMean(p, fu);
      fu.crisp = clamp(fu.crisp + 0.01 * dt, 0, 1);
    }
    if (bc.top.RH > 0.9) fu.crisp = clamp(fu.crisp - 0.03 * dt, 0, 1);
    if (s.baste > 0) { for (let j = 0; j < Nr; j++) fu.brownR[j] += 0.004 * dt; faceMean(p, fu); }
    // the edge: browns from radiant heat on a grill, barely at all in a pan
    if (bc.side.rad) {
      let Te = 0; for (let k = 0; k < Nz; k++) Te += T[k * Nr + Nr - 1] / Nz;
      const Tse = Math.min(bc.side.radT, Te + 30);
      p.faceSide.brown += arrh(C.Am, C.EaM, Tse) * 0.5 * Math.max(0, 1 - p.faceSide.brown / C.Bmax) * dt;
      p.faceSide.char += arrh(C.Ac, C.EaC, Tse) * 0.3 * Math.max(0, 1 - p.faceSide.char / C.Cmax) * dt;
    }

    // ---- geometry: shrinkage & doming
    const sC = gridMean(p, p.dC), sM = gridMean(p, p.dM);
    const massNow = pattyMass(p);
    const lossFrac = 1 - massNow / p.massKg0;
    const shrink = 1 - 0.15 * sC - 0.04 * sM - 0.06 * lossFrac;
    p.D = p.D0 * clamp(shrink, 0.6, 1);
    p.A = (Math.PI * p.D * p.D) / 4;
    const Vnow = massNow / p.rho0 / (1 - 0.15 * lossFrac);
    p.h = Vnow / p.A;
    // doming: the outer ring's collagen (edge + bottom heated) contracts before the centre's and
    // pulls the rim down, lifting the middle; a dimple pre-empts it, pressing flattens it
    {
      const half = Math.max(1, Math.floor(Nz / 2)); let outer = 0, inner = 0, no = 0, ni = 0;
      for (let k = 0; k < half; k++) for (let j = 0; j < Nr; j++) { const rc = (j + 0.5) / Nr; if (rc > 0.7) { outer += p.dC[k * Nr + j]; no++; } else if (rc < 0.35) { inner += p.dC[k * Nr + j]; ni++; } }
      outer /= Math.max(1, no); inner /= Math.max(1, ni);
      const thick = clamp(p.h0 / 0.016, 0.3, 1.4);
      const domeTarget = (p.dimple ? 0.15 : 1) * clamp(0.8 * outer + 1.2 * (outer - inner), 0, 1) * thick * (p.pressed ? 0.35 : 1);
      p.dome += (domeTarget - p.dome) * Math.min(1, dt / 6);
    }
    if (p.pressT > 0) p.pressT -= dt;

    p.peakCenter = Math.max(p.peakCenter, centerT(p));
    return { qBot: qPan, qBotR, hc, boilBottom: boilBottom / dt, evapTop, fatDrip: fatDrip / dt, fatSide: fatSide / dt, juiceSide: juiceSide / dt, cheeseDrip: p.cheeseDrip / dt, Ts: surfT, qSide };
  }

  /** Explicit conduction is only stable for dt < dz²/(2α): sub-cycle when the layers get thin. */
  function stepPattyStable(s, p, dt, bc, subMin) {
    const dz = p.h / p.Nz;
    let frozen = false; for (let c = 0; c < p.T.length; c++) if (p.T[c] < 0) { frozen = true; break; }
    const alphaMax = frozen ? 1.3e-6 : 2.5e-7;
    const dtMax = (0.4 * dz * dz) / alphaMax;
    const n = Math.max(1, subMin || 1, Math.min(64, Math.ceil(dt / dtMax)));
    if (n === 1) return stepPatty(s, p, dt, bc);
    const h = dt / n; let acc = null;
    for (let k = 0; k < n; k++) {
      const r = stepPatty(s, p, h, bc);
      if (!acc) { acc = { ...r, qBotR: Float64Array.from(r.qBotR) }; } else { for (const key in r) if (key !== 'qBotR') acc[key] += r[key]; for (let j = 0; j < r.qBotR.length; j++) acc.qBotR[j] += r.qBotR[j]; }
    }
    for (const key in acc) if (key !== 'qBotR') acc[key] /= n;
    for (let j = 0; j < acc.qBotR.length; j++) acc.qBotR[j] /= n;
    return acc;
  }

  // ---------------------------------------------------------------- instability guard
  /*
   * An explicit finite-difference grid that gets re-formed under the player's hands — a smash
   * halves dz, a flip reverses every column, a press changes the area, a 3 mm patty on a 600 °C
   * bed is a Fourier number on a knife edge — can in principle run away: one cell overshoots, the
   * next step overshoots further, and a few steps later the arrays hold Infinity or NaN and every
   * readout downstream (colour, score, the pan it is drawing heat from) is garbage. So instead of
   * trusting that it never happens, each patty keeps a snapshot of the last good step and the
   * world rolls back to it.
   *
   * A patty grid is small — at most 60 layers × 16 rings = 960 cells, so the 15 arrays are about
   * 115 kB, and copying that at 40 Hz is a few MB/s of memcpy — so for any patty a cook could
   * actually form the snapshot is taken every step and a rollback costs one frame of cooking.
   * SNAP_CELLS is the cutoff: a grid bigger than that is snapshotted every SNAP_EVERY steps and a
   * rollback costs that many steps instead.
   */
  const GUARD_ARRAYS = ['T', 'w', 'w0c', 'fs', 'fl', 'fr', 'fat0c', 'p', 'dM', 'dC', 'dA', 'dG', 'Tpk', 'poolB', 'poolT'];
  const GUARD_SCALARS = ['h', 'D', 'A', 'dome', 'pressT', 'poolTop', 'poolBottom', 'fatTop', 'peakCenter', 'lostWaterEvap', 'lostWaterDrip', 'lostFat', 'surfT', 'steamRate', 'boilBottom', 'evapTop'];
  const GUARD_FACE_ARRAYS = ['brownR', 'charR'];
  const GUARD_FACE_SCALARS = ['brown', 'char', 'torn', 'crisp', 'maxT', 'marks', 'marksChar', 'charRate'];
  const SNAP_CELLS = 4000, SNAP_EVERY = 20;

  function finiteArray(a) { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; }
  /** True when every number the rest of the model reads off this patty is finite. */
  function pattyFinite(p) {
    for (const k of GUARD_ARRAYS) if (!finiteArray(p[k])) return false;
    for (const k of GUARD_SCALARS) if (!Number.isFinite(p[k])) return false;
    for (const f of [p.faceDown, p.faceUp]) {
      for (const k of GUARD_FACE_ARRAYS) if (!finiteArray(f[k])) return false;
      for (const k of GUARD_FACE_SCALARS) if (f[k] != null && !Number.isFinite(f[k])) return false;
    }
    return true;
  }
  /** The step's returned fluxes feed the pan, so they have to be finite too. */
  function stepResultFinite(r) {
    for (const k in r) { const v = r[k]; if (k === 'qBotR') { if (!finiteArray(v)) return false; } else if (!Number.isFinite(v)) return false; }
    return true;
  }
  function guardSnapshot(p, step) {
    const cells = p.T.length;
    const due = !p._snap || !p._snap.valid || cells <= SNAP_CELLS || step - p._snap.t >= SNAP_EVERY;
    if (!due) return;
    if (!pattyFinite(p)) return; // never overwrite a good snapshot with a state that is already bad
    const s = p._snap || (p._snap = { arr: {}, sc: {}, faces: [{ arr: {}, sc: {} }, { arr: {}, sc: {} }], side: {} });
    for (const k of GUARD_ARRAYS) { const a = p[k]; if (!s.arr[k] || s.arr[k].length !== a.length) s.arr[k] = Float64Array.from(a); else s.arr[k].set(a); }
    for (const k of GUARD_SCALARS) s.sc[k] = p[k];
    const faces = [p.faceDown, p.faceUp];
    for (let i = 0; i < 2; i++) {
      const f = faces[i], d = s.faces[i]; d.id = f.id; // by id, not by reference: a state can be cloned
      for (const k of GUARD_FACE_ARRAYS) { const a = f[k]; if (!d.arr[k] || d.arr[k].length !== a.length) d.arr[k] = Float64Array.from(a); else d.arr[k].set(a); }
      for (const k of GUARD_FACE_SCALARS) d.sc[k] = f[k];
    }
    s.side.brown = p.faceSide.brown; s.side.char = p.faceSide.char;
    s.t = step; s.valid = true;
  }
  /** Put the patty back the way it was at the last snapshot. */
  function guardRestore(p) {
    const s = p._snap; if (!s || !s.valid) return false;
    for (const k of GUARD_ARRAYS) p[k].set(s.arr[k]);
    for (const k of GUARD_SCALARS) p[k] = s.sc[k];
    for (const d of s.faces) { const f = p.faceDown.id === d.id ? p.faceDown : p.faceUp; for (const k of GUARD_FACE_ARRAYS) f[k].set(d.arr[k]); for (const k of GUARD_FACE_SCALARS) if (d.sc[k] != null) f[k] = d.sc[k]; }
    p.faceSide.brown = s.side.brown; p.faceSide.char = s.side.char;
    return true;
  }
  /**
   * Last resort when there is no snapshot to go back to (the very first step after a flip or a
   * smash threw the arrays away): put something physical in every cell that went bad — the mean of
   * the cells that are still finite for temperature, nothing for a mass, no reaction extent.
   */
  function guardSanitise(p) {
    let sum = 0, n = 0; for (let c = 0; c < p.T.length; c++) if (Number.isFinite(p.T[c])) { sum += p.T[c]; n++; }
    const Tfill = n ? sum / n : p.T0;
    for (let c = 0; c < p.T.length; c++) if (!Number.isFinite(p.T[c])) p.T[c] = Tfill;
    for (const k of ['w', 'w0c', 'fs', 'fl', 'fr', 'fat0c', 'p', 'poolB', 'poolT']) { const a = p[k]; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) a[i] = 0; }
    for (const k of ['dM', 'dC', 'dA', 'dG']) { const a = p[k]; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) a[i] = 0; }
    for (let i = 0; i < p.Tpk.length; i++) if (!Number.isFinite(p.Tpk[i])) p.Tpk[i] = p.T[i];
    for (const k of GUARD_SCALARS) if (!Number.isFinite(p[k])) p[k] = 0;
    if (!(p.h > 0)) p.h = p.h0; if (!(p.D > 0)) p.D = p.D0; if (!(p.A > 0)) p.A = p.A0;
    for (const f of [p.faceDown, p.faceUp]) {
      for (const k of GUARD_FACE_ARRAYS) { const a = f[k]; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) a[i] = 0; }
      for (const k of GUARD_FACE_SCALARS) if (f[k] != null && !Number.isFinite(f[k])) f[k] = 0;
    }
    if (!Number.isFinite(p.faceSide.brown)) p.faceSide.brown = 0;
    if (!Number.isFinite(p.faceSide.char)) p.faceSide.char = 0;
  }
  const ZERO_STEP = (p) => ({ qBot: 0, qBotR: new Float64Array(p.Nr), hc: 0, boilBottom: 0, evapTop: 0, fatDrip: 0, fatSide: 0, juiceSide: 0, cheeseDrip: 0, Ts: p.surfT || 0, qSide: 0 });
  /**
   * stepPattyStable with the rollback around it. A blow-up is nearly always a step that was too
   * long for the cell it hit, so the retry is the same dt cut into eight, which is the fix a human
   * would apply; if even that comes back non-finite the patty sits this step out (its heat draw on
   * the pan is zero for one frame) rather than poisoning the rest of the world.
   */
  function stepPattyGuarded(s, p, dt, bc) {
    const step = s._guardStep = (s._guardStep || 0) + 1;
    guardSnapshot(p, step);
    let r = stepPattyStable(s, p, dt, bc);
    if (pattyFinite(p) && stepResultFinite(r)) return r;
    const g = s.guard || (s.guard = { restores: 0, retries: 0, sanitised: 0, lastLog: -1e9 });
    const rolled = guardRestore(p);
    if (!rolled) { guardSanitise(p); g.sanitised++; }
    g.restores++;
    r = stepPattyStable(s, p, dt, bc, 8);
    if (!(pattyFinite(p) && stepResultFinite(r))) {
      if (!guardRestore(p)) guardSanitise(p);
      r = ZERO_STEP(p); g.retries++;
    }
    if (s.t - g.lastLog > 5) {
      g.lastLog = s.t;
      logEvent(s, `Numerical instability in patty ${p.id} (${(p.h * 1000).toFixed(1)} mm thick, ${p.Nz} layers, ${dt.toFixed(3)} s step): the solver rolled the patty back to its last good state and took the step again in smaller pieces.`, 'warn');
    }
    return r;
  }

  /**
   * The coal bed. Airflow (the knob: vents and fanning) sets the temperature the bed heads for
   * and how fast it eats the charcoal; the lid throttles it. Fat that falls on a hot bed flares:
   * a few grams within seconds is a foot of yellow flame that licks the meat, dies back in
   * seconds, and leaves soot. Ash builds as the coals burn and dulls the bed.
   */
  function stepCoals(s, dt) {
    const g = s.grill, Tamb = s.env.Tamb, v = s.stove.knob / 10;
    if (!g.lit && s.stove.knob > 0) { g.lit = true; g.litAt = s.t; logEvent(s, 'A chimney of lit lump charcoal dumped in and raked out under the grate. Open the vents and wait for the bed to glow.', 'action'); }
    if (!g.lit) { g.burnW = 0; g.flare = Math.max(0, g.flare - dt); g.smoke = 0; g.sizzle = 0; return; }
    const air = (0.12 + 0.88 * v) * (s.lid ? 0.75 : 1);
    const alive = clamp(g.coal / 0.25, 0, 1);
    const target = Tamb + (300 + 430 * air) * alive * (1 - 0.25 * clamp(g.ash / 0.4, 0, 1)); // ~350 °C banked, ~750 °C wide open
    const tau = target > g.Tfire ? COAL.tauUp * (s.t - g.litAt < 90 ? 0.4 : 1) : COAL.tauDown;
    g.Tfire += ((target - g.Tfire) * dt) / tau;
    const burn = ((0.35 + 1.4 * air) / 3600) * alive; // kg/s: a chimney lasts 45 min flat out, two hours banked
    const used = Math.min(g.coal, burn * dt); g.coal -= used; g.ash += used * 0.06; g.burnW = (used / dt) * COAL.H * 0.3;
    // fat on the coals: ignites above ~450 °C; the flare grows with the amount and dies in seconds
    const hot = clamp((g.Tfire - 450) / 250, 0, 1);
    const ignite = Math.min(g.fatOnCoals, g.fatOnCoals * Math.min(1, dt * (0.1 + 2 * hot)));
    g.fatOnCoals -= ignite; g.fatOnCoals *= Math.exp(-dt / 30); // what does not burn soaks into the ash
    const flareTarget = (ignite / dt) * 2000 * hot; // 0.5 g/s of burning fat is a foot of flame
    g.flare += ((flareTarget - g.flare) * dt) / (flareTarget > g.flare ? 0.5 : 1.5);
    g.flareTotal += ignite * hot;
    const juice = g.juiceOnCoals || 0; g.juiceOnCoals = 0;
    g.sizzle = clamp(juice * 400 / dt, 0, 1) * 0.6;
    g.smoke = 0.12 * alive + clamp(g.flare, 0, 2) * 0.7 + clamp(juice / dt * 30, 0, 0.3) + (g.fatOnCoals > 0.001 && hot < 0.3 ? 0.4 : 0);
    if (g.flare > 0.6 && (!g._flareLogT || s.t - g._flareLogT > 20)) { g._flareLogT = s.t; logEvent(s, `FLARE-UP: fat hit the coals and lit. Flames up through the grate, licking the meat${s.lid ? ' under the lid' : ''}. Move it or close the vents.`, 'warn'); }
    if (g.coal < 0.2 && !g._lowLogged) { g._lowLogged = true; logEvent(s, 'The coals are burning down to ash. The bed is cooling; whatever is not cooked yet had better be close.', 'warn'); }
  }
  /** Fraction of each pan ring's area covered by patties (sampled around the ring). */
  function ringCoverage(s) {
    const pan = s.pan, cov = new Float64Array(pan.Np);
    const inPan = s.patties.filter((p) => p.where === 'pan');
    if (!inPan.length) return cov;
    const NA = 24;
    for (let j = 0; j < pan.Np; j++) {
      const r = (j + 0.5) * pan.dr; let hit = 0;
      for (let a = 0; a < NA; a++) {
        const ang = (a / NA) * Math.PI * 2, x = r * Math.cos(ang), y = r * Math.sin(ang);
        for (const p of inPan) { if (Math.hypot(x - p.pos.x, y - p.pos.y) <= p.D / 2) { hit++; break; } }
      }
      cov[j] = hit / NA;
    }
    return cov;
  }

  /** Advance the whole world (stove, pan, patties) by dt seconds. */
  function step(s, dt) {
    const pan = s.pan, st = s.stove, Tamb = s.env.Tamb;
    if (!s._ms) s._ms = {};
    s.t += dt;
    // ---- burner
    const pTarget = (st.knob / 10) * st.pMax * st.eff;
    if (st.tau > 0) st.pDelivered += ((pTarget - st.pDelivered) * dt) / st.tau; else st.pDelivered = pTarget;
    // ---- the fire (charcoal grill)
    const grill = s.grill;
    if (grill) stepCoals(s, dt);

    // ---- lid air: over a pan the lid traps steam; the kettle lid makes a hot dome
    if (grill) {
      const domeTarget = s.lid ? Tamb + 0.33 * (grill.Tfire - Tamb) : Tamb + 0.18 * (grill.Tfire - Tamb);
      grill.Tdome += ((domeTarget - grill.Tdome) * dt) / (s.lid ? 60 : 20);
      s.lidAirT = grill.Tdome;
    } else {
      const lidTarget = s.lid ? Math.min(104, 0.75 * pan.T + 25) : Tamb + 0.25 * (pan.T - Tamb);
      s.lidAirT += ((lidTarget - s.lidAirT) * dt) / (s.lid ? 12 : 4);
    }

    // ---- pan rings: burner input, losses from the uncovered area, radial conduction
    const Np = pan.Np, Tr = pan.Tr, qRing = new Float64Array(Np);
    const cov = ringCoverage(s);
    if (grill) {
      // the grate: thin bars heated by the coal bed's radiation and the hot gas coming up through
      // it, losing heat upward to the sky (or the dome); the bars are only a fraction of the area
      const Tf = grill.Tfire + 273.15, Tgas = Tamb + 0.5 * (grill.Tfire - Tamb);
      const Tup = s.lid ? grill.Tdome : Tamb;
      for (let j = 0; j < Np; j++) {
        const A = pan.ringA[j] * pan.barFrac, Tk = Tr[j] + 273.15;
        qRing[j] += A * (pan.emiss * C.sigma * COAL.viewGrate * (Tf ** 4 - Tk ** 4) + 25 * (Tgas - Tr[j]));
        qRing[j] -= A * (1 - cov[j]) * ((s.lid ? 12 : 20) * (Tr[j] - Tup) + pan.emiss * C.sigma * 0.5 * (Tk ** 4 - (Tup + 273.15) ** 4));
      }
      st.pDelivered = grill.burnW;
    } else {
      const weights = new Float64Array(Np); let wsum = 0;
      for (let j = 0; j < Np; j++) { weights[j] = st.profile((j + 0.5) * pan.dr, st.knob / 10) * pan.ringA[j]; wsum += weights[j]; }
      for (let j = 0; j < Np; j++) {
        qRing[j] += wsum > 0 ? (st.pDelivered * weights[j]) / wsum : 0;
        const Tk = Tr[j] + 273.15, Tak = Tamb + 273.15;
        const hNat = 1.32 * Math.pow(Math.max(1, Tr[j] - Tamb) / pan.diam, 0.25) + 3;
        const freeA = pan.ringA[j] * (1 - cov[j]);
        qRing[j] -= hNat * freeA * (Tr[j] - Tamb) * (s.lid ? 0.4 : 1) + pan.emiss * C.sigma * (Tk ** 4 - Tak ** 4) * freeA * (s.lid ? 0.3 : 1) + 3 * pan.ringA[j] * (Tr[j] - Tamb);
      }
      const hNatE = 1.32 * Math.pow(Math.max(1, Tr[Np - 1] - Tamb) / pan.diam, 0.25) + 3;
      qRing[Np - 1] -= (0.25 * Math.PI * pan.diam * 0.05 * hNatE + 4 * Math.PI * pan.diam * pan.wall) * (Tr[Np - 1] - Tamb); // rim and wall
    }
    // water in the pan boils off (Leidenfrost slows it on a very hot pan)
    let evapPan = 0;
    if (pan.water > 0 && pan.T > 100) {
      const leiden = pan.T > 210 ? 0.15 : 1;
      const r = clamp((pan.T - 100) / 15, 0, 6) * leiden;
      let m = Math.min(pan.water, pan.water * r * dt);
      m = Math.min(m, Math.max(0, (pan.C * (pan.T - 100) * 0.5) / C.Lvap));
      pan.water -= m; evapPan = m / dt;
      for (let j = 0; j < Np; j++) qRing[j] -= ((m * C.Lvap) / dt) * (pan.ringA[j] / (Math.PI * pan.floorR ** 2));
      pan.fond += m * 0.05;
    }
    // oil level, overflow, flare
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
    if (pan.flare > 0) { pan.flare = Math.max(0, pan.flare - dt); for (let j = 0; j < Np; j++) qRing[j] += 1500 * (pan.ringA[j] / floorA); }
    // residue chemistry
    if (pan.fond > 0 && pan.T > 180) { const b = pan.fond * 0.01 * clamp((pan.T - 180) / 60, 0, 2) * dt; pan.fond -= b; pan.fondBurnt += b; }
    if (pan.T > 200) {
      const hot = clamp((pan.T - 200) / 80, 0, 2);
      const c1 = pan.fondBurnt * 0.004 * hot * dt; pan.fondBurnt -= c1;
      const c2 = pan.cheeseBits * 0.003 * hot * dt; pan.cheeseBits -= c2;
      const c3 = pan.meatBits * 0.003 * hot * dt; pan.meatBits -= c3;
      pan.carbon += 0.25 * (c1 + c2 + c3);
    }
    const smokeT = Math.min(pan.oilSmoke, pan.oilKind === 'none' || pan.oilKind === 'tallow' || pan.oilKind === 'mixed' ? TALLOW_SMOKE : Infinity);
    const overSmoke = pan.oil > 1e-5 ? Math.max(0, pan.Tcenter - Math.min(smokeT, TALLOW_SMOKE)) : 0;
    pan.smokeOil = pan.oil > 1e-5 ? clamp(overSmoke / 40, 0, 2) * clamp(pan.oil / 0.004, 0.2, 1) : 0;
    if (overSmoke > 0) { const gone = pan.oil * 0.0004 * (overSmoke / 40) * dt; pan.oil = Math.max(0, pan.oil - gone); pan.carbon += gone * 0.15; }
    pan.smokeFond = clamp(pan.fondBurnt / 0.002, 0, 1) * clamp((pan.T - 200) / 60, 0, 1.5) + clamp((pan.cheeseBits + pan.meatBits) / 0.01, 0, 1) * clamp((pan.T - 180) / 60, 0, 1) * 0.6;

    // ---- patties
    let boilBottomAll = 0, fatDripAll = 0, juiceSideAll = 0, evapTopAll = 0, steamAll = 0, panQ = 0, hcSel = 0, TsSel = 0, smokeChar = 0, fatSideAll = 0;
    let anyOnPan = false, anyResting = false;
    for (const p of s.patties) {
      if (p.where === 'pan') {
        anyOnPan = true;
        const d = Math.hypot(p.pos.x, p.pos.y);
        const Tat = (rc) => panTat(pan, Math.sqrt(d * d + rc * rc));
        const Tunder = Tat(p.D / 4), Tedge = Tat(p.D / 2);
        const submerged = pan.oilDepth > p.h * (1 + 0.28 * p.dome) + 0.0005;
        if (submerged && !s._ms.deepfry) { s._ms.deepfry = true; logEvent(s, `The patty is under ${(pan.oilDepth * 1000).toFixed(0)} mm of fat: this is deep frying now. Both faces will brown.`, 'info'); }
        const carbonF = clamp(pan.carbon / 0.004, 0, 1);
        let bc;
        if (grill) {
          // over the coals: bar contact on a fraction of the face, radiation and hot gas on the
          // rest, radiant heat on the edge, and a flare-up licking the underside adds soot
          const fl = clamp(grill.flare, 0, 1.5);
          const TfireEff = grill.Tfire + 350 * Math.min(1, fl);
          const Tgas = Tamb + 0.5 * (grill.Tfire - Tamb) + 200 * Math.min(1, fl);
          bc = {
            bottom: { type: 'grill', Tat, T: Tunder, Tedge, oil: 0, hcMul: 1, release: pan.release + 0.2 * carbonF, barFrac: pan.barFrac, Tbar: Tunder, Tfire: TfireEff, view: COAL.view, Tair: Tgas, Tsurf: 150 + 0.16 * (TfireEff - 150) },
            top: s.lid ? { h: 14, T: grill.Tdome, RH: 0.3, rad: true, radT: grill.Tdome, radView: 0.85 } : { h: C.hAirTop, T: Tamb + 0.2 * (grill.Tfire - Tamb), RH: 0.25 },
            side: { T: Tgas * 0.6 + Tamb * 0.4, oilDepth: 0, oilT: Tamb, rad: true, radT: TfireEff, radView: COAL.viewSide, h: 15 },
          };
          p.grilled = true;
          if (fl > 0.05) {
            // flames on the underside and the edge: pyrolysis without Maillard, i.e. soot
            const soot = 0.0025 * fl * dt;
            for (let j = 0; j < p.Nr; j++) p.faceDown.charR[j] = Math.min(C.Cmax, p.faceDown.charR[j] + soot * (0.6 + 0.8 * (j / p.Nr)));
            p.faceSide.char = Math.min(C.Cmax, p.faceSide.char + soot * 1.5);
            p.flareChar = (p.flareChar || 0) + soot;
            faceMean(p, p.faceDown);
          }
        } else {
          bc = {
            bottom: { type: 'pan', Tat, T: Tunder, Tedge, oil: pan.oil, hcMul: pan.hcMul * (1 - 0.3 * carbonF), release: pan.release + 0.2 * carbonF },
            top: submerged ? { h: C.hOil, T: Tunder, RH: 1, oil: true } : { h: s.lid ? C.hLid : C.hAirTop, T: s.lidAirT, RH: s.lid ? clamp((s.lidAirT - 60) / 40, s.env.RH, 1) : s.env.RH },
            side: { T: Tamb + 0.25 * (Tedge - Tamb), oilDepth: pan.oilDepth, oilT: Tunder },
          };
        }
        const pr = stepPattyGuarded(s, p, dt, bc);
        p.cookTime += dt; p.timeDown += dt;
        // heat drawn from the rings under each patty ring
        const dr = p.D / 2 / p.Nr;
        for (let j = 0; j < p.Nr; j++) {
          const rho = Math.sqrt(d * d + ((j + 0.5) * dr) ** 2);
          const x = clamp(rho / pan.dr - 0.5, 0, Np - 1); const j0 = Math.floor(x), t = x - j0;
          const share = grill ? 0.35 : 1; // on a grill most of the heat is radiant, not drawn from the bars
          if (j0 >= Np - 1) qRing[Np - 1] -= pr.qBotR[j] * share; else { qRing[j0] -= pr.qBotR[j] * (1 - t) * share; qRing[j0 + 1] -= pr.qBotR[j] * t * share; }
        }
        if (grill) {
          // juice and fat fall through the grate onto the coals: steam, sizzle, and a flare when
          // enough fat lands on a hot bed at once
          let drip = 0; for (let j = 0; j < p.Nr; j++) { drip += p.poolB[j]; p.poolB[j] = 0; } p.poolBottom = 0;
          p.lostWaterDrip += drip;
          grill.fatOnCoals += (pr.fatDrip + pr.fatSide) * dt;
          grill.juiceOnCoals = (grill.juiceOnCoals || 0) + drip + pr.juiceSide * dt;
          // cheese that sagged off the slice and fell through the bars: processed American is
          // ~31 % fat, ~44 % water, so it both spits on the coals and feeds the flames
          if (pr.cheeseDrip > 0) { const cd = pr.cheeseDrip * dt; grill.fatOnCoals += cd * 0.31; grill.juiceOnCoals += cd * 0.44; grill.cheeseOnCoals = (grill.cheeseOnCoals || 0) + cd; }
        } else {
          pan.water += pr.juiceSide * dt;
          pan.oil += (pr.fatDrip + pr.fatSide) * dt;
        }
        boilBottomAll += pr.boilBottom; fatDripAll += pr.fatDrip; fatSideAll += pr.fatSide; juiceSideAll += pr.juiceSide; evapTopAll += pr.evapTop; steamAll += p.steamRate; panQ += pr.qBot;
        if (p === s.patty) { hcSel = pr.hc; TsSel = pr.Ts; }
        let cheeseSmoke = 0; for (const ch of p.cheeses.concat(p.cheeseUnder)) if (ch.skirt) cheeseSmoke += ch.skirt.charRate * 40 * (0.3 + ch.skirt.char) * ch.skirt.mass / 0.01;
        smokeChar += (p.faceDown.charRate || 0) * 40 * (0.3 + p.faceDown.char) + cheeseSmoke;
      } else if (p.where === 'rest') {
        anyResting = true;
        const bc = { bottom: { type: 'air', h: 15, T: Tamb + 8 }, top: { h: C.hAirTop, T: Tamb, RH: s.env.RH }, side: { T: Tamb } };
        stepPattyGuarded(s, p, dt, bc);
        p.restT = (p.restT || 0) + dt;
      }
    }
    pan.smokeChar = clamp(smokeChar, 0, 2.5);
    if (s.baste > 0) s.baste -= dt;
    if (anyResting) s.rest.t += dt;

    // ---- spatter
    const boilTotal = boilBottomAll + evapPan;
    const oilFactor = clamp(pan.oil / 0.006, 0, 1.5);
    const hotFactor = clamp((pan.T - 120) / 120, 0, 1.5);
    const spatter = Math.min(80, boilTotal * 4e4 * oilFactor * hotFactor + (pan.water > 0 && pan.T > 150 ? 2 * oilFactor : 0));
    if (spatter > 0) { const loss = Math.min(pan.oil, spatter * 1.5e-7 * dt); pan.oil -= loss; pan.lostSpatter += loss; }

    // ---- integrate the pan rings (sub-cycled radial conduction)
    {
      // the same rollback the patties get: the metal is what everything else is measured against,
      // so a non-finite ring temperature would take the whole kitchen with it
      const panSnap = s._panSnap && s._panSnap.length === Np ? s._panSnap : (s._panSnap = new Float64Array(Np));
      const wasGood = finiteArray(Tr);
      if (wasGood) panSnap.set(Tr);
      const G = new Float64Array(Np - 1);
      for (let j = 0; j < Np - 1; j++) G[j] = (pan.k * pan.thick * 2 * Math.PI * (j + 1) * pan.dr) / pan.dr;
      const oilPer = (pan.oil * C.cpF) / floorA;
      const Cr = new Float64Array(Np); let dtMax = Infinity;
      for (let j = 0; j < Np; j++) { Cr[j] = pan.ringM[j] * pan.cp + oilPer * pan.ringA[j]; const g = (j > 0 ? G[j - 1] : 0) + (j < Np - 1 ? G[j] : 0); dtMax = Math.min(dtMax, (0.45 * Cr[j]) / Math.max(g, 1e-9)); }
      const nsub = Math.max(1, Math.min(40, Math.ceil(dt / dtMax))), h = dt / nsub;
      for (let it = 0; it < nsub; it++) {
        const dT = new Float64Array(Np);
        for (let j = 0; j < Np; j++) dT[j] = qRing[j];
        for (let j = 0; j < Np - 1; j++) { const q = G[j] * (Tr[j + 1] - Tr[j]); dT[j] += q; dT[j + 1] -= q; }
        for (let j = 0; j < Np; j++) Tr[j] += (dT[j] * h) / Cr[j];
      }
      if (!finiteArray(Tr)) {
        const g = s.guard || (s.guard = { restores: 0, retries: 0, sanitised: 0, lastLog: -1e9 });
        if (wasGood) Tr.set(panSnap); else for (let j = 0; j < Np; j++) if (!Number.isFinite(Tr[j])) Tr[j] = Tamb;
        g.restores++; g.panRestores = (g.panRestores || 0) + 1;
        if (s.t - g.lastLog > 5) { g.lastLog = s.t; logEvent(s, `Numerical instability in the ${grill ? 'grate' : 'pan'}: the ring temperatures went non-finite and were rolled back to the previous step.`, 'warn'); }
      }
      let mean = 0; for (let j = 0; j < Np; j++) mean += Tr[j] * pan.ringA[j]; pan.T = mean / floorA;
      pan.Tcenter = Tr[0]; pan.Tedge = Tr[Np - 1];
    }
    if (pan.T > pan.maxT && pan.id === 'nonstick' && !s._ptfeWarned) { s._ptfeWarned = true; logEvent(s, 'Nonstick coating above 260 °C: it is degrading and off-gassing. Not a good idea.', 'warn'); }

    const oilBubble = pan.oil > 1e-5 ? clamp((pan.T - 140) / 100, 0, 1) * clamp(pan.oil / 0.005, 0, 1) : 0;
    const sel = s.patty;
    s.diag = {
      sizzle: clamp(boilTotal * 300 + oilBubble * 0.15 + evapTopAll * 20 + (grill ? grill.sizzle : 0), 0, 1.5),
      spatter, steam: steamAll + evapPan,
      smoke: pan.smokeOil + pan.smokeChar + pan.smokeFond + (pan.flare > 0 ? 1.5 : 0) + (grill ? grill.smoke : 0),
      flare: grill ? grill.flare : pan.flare, oilDepth: pan.oilDepth, overflow: pan.overflow,
      fire: grill ? grill.Tfire : 0,
      evapBottom: boilBottomAll, evapPan, oilBubble,
      fatDrip: fatDripAll + fatSideAll, juiceTop: sel ? sel.poolTop : 0, juiceSide: juiceSideAll,
      panQ, Ts: TsSel, hc: hcSel,
    };
    pan.smoke = s.diag.smoke;
    syncSelected(s);

    if (s.t - s.lastTrace >= s.traceEvery) {
      s.lastTrace = s.t;
      const p = sel;
      s.trace.push({ t: s.t, pan: pan.T, panC: pan.Tcenter, panE: pan.Tedge, center: p ? centerT(p) : null, bottom: p ? layerMean(p, p.T, 0) : null, top: p ? layerMean(p, p.T, p.Nz - 1) : null, surf: p ? p.surfT : null, mass: p ? pattyMass(p) : null, where: s.where });
      if (s.trace.length > 20000) s.trace.shift();
    }
    checkMilestones(s);
  }

  function checkMilestones(s) {
    const p = s.patty; const pan = s.pan; const ms = s._ms || (s._ms = {});
    const once = (key, cond, text, kind) => { if (!ms[key] && cond) { ms[key] = true; logEvent(s, text, kind); } };
    if (s.grill) {
      once('coalglow', s.grill.Tfire >= 450, 'The bed is glowing orange under a skin of grey ash. Hold a hand over the grate: two seconds is all you get.', 'info');
      once('grateHot', pan.Tcenter >= 250, `Grate at ${pan.Tcenter.toFixed(0)} °C: hot enough to brand the meat with bars.`, 'info');
      once('coalfull', s.grill.Tfire >= 800, 'Vents wide open: the bed is white-hot, well past 800 °C. Radiant heat like that sears in a minute and chars in three.', 'warn');
    } else {
      once('preheat150', pan.Tcenter >= 150, 'Pan centre at 150 °C. A drop of water would sizzle and vanish in a second.', 'info');
      once('leiden', pan.Tcenter >= 200, 'Pan centre past ~200 °C: water drops would now bead and skate (Leidenfrost). Proper searing territory.', 'info');
      once('hotspot', pan.Tcenter - pan.Tedge > 60 && pan.Tcenter > 150, `Hot spot: the pan is ${(pan.Tcenter - pan.Tedge).toFixed(0)} °C hotter over the burner than at the edge.`, 'info');
      once('oilsmoke', pan.smokeOil > 0.3, 'The oil is smoking — it is past its smoke point and breaking down (acrolein). Slightly acrid.', 'warn');
    }
    if (!p) return;
    const key = (k) => `${k}#${p.id}`;
    if (p.where === 'pan') {
      const Nr = p.Nr;
      once(key('fatmelt'), p.T[0] > 45, 'Fat in the bottom layer has melted (≈42 °C). It will start to leak out as the cells rupture.', 'info');
      once(key('myosin'), p.dM[0] > 0.5, 'Myosin denaturing at the bottom face: the meat is firming and going opaque grey.', 'info');
      once(key('render'), p.lostFat > 0.001, 'Fat is rendering out and pooling around the patty. Listen to it.', 'info');
      once(key('dry'), p.w[0] < 0.25 * p.w0c[0], 'Bottom face has boiled dry. Its temperature is no longer pinned at 100 °C — Maillard browning can now proceed.', 'info');
      once(key('brown1'), p.faceDown.brown > 1, 'A pale tan crust is forming.', 'info');
      once(key('brown2'), p.faceDown.brown > 2.5, 'Deep brown crust: Maillard is well underway (pyrazines, furanones — that smell).', 'good');
      once(key('edgeahead'), p.dG[Nr - 1] > 0.7 && p.dG[0] < 0.3, 'The edge is cooking ahead of the middle: heat is coming in from the side as well as below.', 'info');
      once(key('char'), p.faceDown.char > 0.25, 'The crust is starting to burn (pyrolysis). Bitter, acrid, black.', 'warn');
      once(key('juice'), p.poolTop > 0.0008, 'Pink juice is beading on the top surface — the classic "time to flip" cue.', 'good');
      once(key('domed'), p.dome > 0.5 && !p.dimple, 'The patty is doming: the centre has lifted off the pan and is barely cooking underneath.', 'warn');
      once(key('c50'), p.peakCenter >= 50, 'Centre 50 °C — rare.', 'info');
      once(key('c55'), p.peakCenter >= 55, 'Centre 55 °C — medium-rare.', 'info');
      once(key('c60'), p.peakCenter >= 60, 'Centre 60 °C — medium.', 'info');
      once(key('c66'), p.peakCenter >= 66, 'Centre 66 °C — medium-well. Actin is denaturing; juice loss accelerates.', 'info');
      once(key('c71'), p.peakCenter >= 71, 'Centre 71 °C — well done. USDA-safe for ground beef.', 'info');
      once(key('c80'), p.peakCenter >= 80, 'Centre 80 °C. This is a hockey puck now.', 'warn');
      const c0 = p.cheeses[0];
      once(key('cheese'), c0 && c0.melt > 0.8, 'Cheese fully melted and draping over the edges.', 'good');
      const sk = p.cheeses.concat(p.cheeseUnder).map((c) => c.skirt).filter((x) => x && x.mass > 1e-5);
      once(key('cheeseUnderBurn'), p.cheeseUnder.some((c) => c.skirt && c.skirt.char > 0.3), 'The cheese under the patty has burnt onto the pan. It will not come off clean.', 'warn');
      once(key('cheeseTouch'), sk.length > 0 && !(p.cheeses[0] && p.cheeses[0].submerged), 'Cheese has drooped onto the pan. It will melt, boil dry into a lace, then brown.', 'info');
      once(key('cheeseFry'), p.cheeses.some((c) => c.submerged), 'The cheese is under the fat. It has melted instantly and is frying: it will crisp, brown, then burn.', 'info');
      once(key('cheeseFrico'), sk.some((x) => x.brown > 2), 'The cheese on the pan has gone golden and crisp: frico.', 'good');
      once(key('cheeseDrip'), s.grill && (s.grill.cheeseOnCoals || 0) > 0.001, 'Melted cheese is sagging through the bars and dropping on the coals: it spits, feeds the flames and smells of burnt milk. On a grate cheese goes on late, with the lid down.', 'warn');
      once(key('cheeseBurn'), sk.some((x) => x.char > 0.3), 'The cheese lace is burning: black, bitter, and smoking.', 'warn');
    }
  }

  function panDirt(pan) { return pan.fond + pan.fondBurnt + pan.cheeseBits + pan.meatBits + pan.carbon; }
  function washPan(s) {
    const pan = s.pan; if (s.patties.some((p) => p.where === 'pan')) return false;
    if (s.grill) {
      // a wire brush on the hot grate: carbon and stuck bits come off, the bars stay hot
      const dirt = panDirt(pan);
      pan.fond = 0; pan.fondBurnt = 0; pan.cheeseBits = 0; pan.meatBits = 0; pan.carbon *= 0.15; pan.washes++;
      logEvent(s, `Brushed the grate${dirt > 0.002 ? ' (it needed it)' : ''}. Bars at ${pan.T.toFixed(0)} °C, clean enough.`, 'action');
      return true;
    }
    const wasHot = pan.T > 90, dirt = panDirt(pan);
    pan.oil = 0; pan.oilKind = 'none'; pan.oilSmoke = Infinity; pan.oilDepth = 0; pan.fond = 0; pan.fondBurnt = 0; pan.cheeseBits = 0; pan.meatBits = 0; pan.flare = 0;
    pan.carbon *= pan.id === 'castiron' || pan.id === 'carbonsteel' ? 0.55 : 0.02;
    for (let j = 0; j < pan.Np; j++) pan.Tr[j] = 34 + (pan.Tr[j] - 34) * 0.12;
    pan.T = 34 + (pan.T - 34) * 0.12; pan.Tcenter = pan.Tr[0]; pan.Tedge = pan.Tr[pan.Np - 1]; pan.water = 0.003; pan.washes++;
    logEvent(s, `Washed the pan${dirt > 0.002 ? ' (it needed it)' : ''}. It is wet and at ${pan.T.toFixed(0)} °C now.` + (wasHot && pan.id === 'castiron' ? ' Cold water on hot cast iron: it survived, but that is how they crack.' : wasHot ? ' The steam off it was impressive.' : ''), wasHot ? 'warn' : 'action');
    return true;
  }
  function serve(s, patty) {
    const list = patty ? [patty] : s.patties.filter((p) => p.where !== 'pan');
    for (const p of list) {
      if (p.where === 'cut') continue;
      p.where = 'cut'; p.serveT = centerT(p);
      p.bunSoak = Math.max(0, p.lostWaterDrip - (p.dripAtRest == null ? p.lostWaterDrip : p.dripAtRest)) + p.poolTop + p.poolBottom;
      for (let j = 0; j < p.Nr; j++) { p.poolT[j] = 0; p.poolB[j] = 0; } p.poolTop = 0; p.poolBottom = 0;
      logEvent(s, `Patty ${p.id} on a bun.${p.bunSoak > 0.0015 ? ` ${(p.bunSoak * 1000).toFixed(1)} g of juice went straight into the bottom bun.` : ''}${p.cheeses.length ? ` ${p.cheeses.length} slice${p.cheeses.length > 1 ? 's' : ''} of cheese under the lid.` : ''}`, 'action');
    }
    s.served = true; syncSelected(s);
  }
  function wipeStove(s) { s.pan.overflow = 0; s._stoveWiped = (s._stoveWiped || 0) + 1; logEvent(s, 'Wiped the stovetop down.', 'action'); }

  // ---------------------------------------------------------------- results
  /**
   * How much paler the middle of a face is than its outer half: (outer − inner) / outer, area
   * weighted, zero when the centre is at least as brown as the edge. The very last ring always runs
   * darker (it dries from the side), which is normal and is not what this measures.
   */
  function faceUnevenness(p, f) {
    let inner = 0, ai = 0, outer = 0, ao = 0;
    for (let j = 0; j < p.Nr; j++) {
      const rmid = (j + 0.5) / p.Nr;
      if (rmid < 0.6) { inner += f.brownR[j] * p.aj[j]; ai += p.aj[j]; } else if (j < p.Nr - 1) { outer += f.brownR[j] * p.aj[j]; ao += p.aj[j]; }
    }
    inner /= Math.max(ai, 1e-9); outer /= Math.max(ao, 1e-9);
    return outer > 1e-6 ? clamp((outer - inner) / outer, 0, 1) : 0;
  }
  function evaluate(s, targetId, patty) {
    const p = patty || s.patty; if (!p) return null;
    const target = DONENESS.find((d) => d.id === (targetId || p.target)) || DONENESS[2];
    const peak = p.peakCenter;
    const got = donenessOf(peak);
    const dist = peak < target.lo ? target.lo - peak : peak > target.hi ? peak - target.hi : 0;
    const doneScore = 50 * clamp(1 - dist / 9, 0, 1);
    const faceScore = (f) => {
      // on a grill the bars brand their own, darker crust into a fraction of the face
      const b = p.grilled ? f.brown * (1 - GRATE.barFrac) + (f.marks || 0) * GRATE.barFrac : f.brown;
      let sc = b < 1 ? b * 0.3 : b < 2.5 ? 0.3 + ((b - 1) / 1.5) * 0.7 : b < 4.5 ? 1 : b < 6 ? 1 - (b - 4.5) * 0.4 : 0.4;
      sc *= 1 - clamp((f.char - 0.15) / 0.6, 0, 0.9);
      sc *= 1 - f.torn * 2;
      sc *= 0.85 + 0.15 * (f.crispAtRest == null ? f.crisp : f.crispAtRest);
      // an uneven crust (a pale lifted centre against a dark rim) costs a little
      const u = faceUnevenness(p, f);
      if (f.brown > 1.5) sc *= 1 - 0.25 * clamp(u - 0.5, 0, 0.5);
      return clamp(sc, 0, 1);
    };
    const dirtPen = clamp((p.dirtAtStart || 0) / 0.006, 0, 0.35);
    const crustScore = 20 * 0.5 * (faceScore(p.faceDown) + faceScore(p.faceUp)) * (1 - dirtPen);
    let wNow = 0, w0 = 0; for (let c = 0; c < p.T.length; c++) { wNow += p.w[c]; w0 += p.w0c[c]; }
    const wRet = wNow / w0;
    // a grilled patty loses more: juice falls through the grate and radiant heat dries the edge
    const expected = ({ rare: 0.72, 'medium-rare': 0.69, medium: 0.63, 'medium-well': 0.56, 'well-done': 0.50 }[target.id] || 0.6) - (p.grilled ? 0.10 : 0);
    const juiceScore = 15 * clamp((wRet - (expected - 0.15)) / 0.15, 0, 1);
    // grey band: volume fraction that has been cooked a whole doneness step past the order — for a
    // rare or medium-rare order that is the myoglobin line (~64 °C, where pink turns grey); for a
    // medium it is 68 °C (the top of medium-well, past any hint of pink). The rim counts too. Judged
    // on each cell's peak temperature, so a slab that flipping has evened out to 63–66 °C is not a
    // grey band; a single-flip cook with one side fried to 90 °C is.
    const greyLine = { rare: 64, 'medium-rare': 64, medium: 68, 'medium-well': 72 }[target.id] || 999;
    let over = 0; for (let k = 0; k < p.Nz; k++) for (let j = 0; j < p.Nr; j++) if (p.Tpk[k * p.Nr + j] > greyLine) over += p.aj[j] / p.Nz;
    const overFrac = over;
    const allowedGrey = ({ rare: 0.42, 'medium-rare': 0.48, medium: 0.6, 'medium-well': 0.8 }[target.id] || 1) + (p.grilled ? 0.3 : 0); // the edge cooks from the side over coals, so a grilled patty is greyer by nature
    const evenScore = 10 * clamp(1 - Math.max(0, overFrac - allowedGrey) / 0.3, 0, 1);
    let structure = 1;
    if (p.work > 0.8) structure -= 0.4;
    if (p.salt === 'mixed') structure -= 0.3;
    if (p.dome > 0.5) structure -= 0.3;
    if (p.lostStuck > 0) structure -= 0.3;
    const structScore = 5 * clamp(structure, 0, 1);
    // the total is the sum of the parts as they are shown, so 50 + 20 + 15 + 10 + 5 always reads 100
    const parts = { doneness: Math.round(doneScore), crust: Math.round(crustScore), juiciness: Math.round(juiceScore), evenness: Math.round(evenScore), structure: Math.round(structScore) };
    const total = parts.doneness + parts.crust + parts.juiciness + parts.evenness + parts.structure;
    const massNow = pattyMass(p);
    const notes = [];
    if (dist === 0) notes.push(`Centre peaked at ${peak.toFixed(1)} °C — squarely ${target.label.toLowerCase()}. Nailed it.`);
    else notes.push(`Centre peaked at ${peak.toFixed(1)} °C. That is ${got.label.toLowerCase()}; the order was ${target.label.toLowerCase()} (${target.lo}–${target.hi} °C). Off by ${dist.toFixed(1)} °C.`);
    if (target.id !== 'well-done') notes.push('Note: ground beef is only USDA-safe at 71 °C. Anything pinker is a calculated risk you took on the customer\'s behalf.');
    if (p.faceDown.char > 0.3 || p.faceUp.char > 0.3) notes.push('At least one face is charred — pyrolysed, bitter, and carrying a haze of smoke.');
    else if (Math.max(p.faceDown.brown, p.faceUp.brown) < 1) notes.push('Barely any crust. The surface never got hot and dry enough for Maillard: the pan was too cool, or the meat too wet.');
    else if (Math.min(p.faceDown.brown, p.faceUp.brown) < 1) notes.push('One face browned, the other did not — uneven timing between sides.');
    else if (Math.min(p.faceDown.brown, p.faceUp.brown) > 2.2) notes.push('Proper crust on both faces.');
    for (const f of [p.faceDown, p.faceUp]) { if (f.brown > 1.5 && faceUnevenness(p, f) > 0.5) { notes.push(`Face ${f.id} browned unevenly: dark at the rim, pale in the middle${p.dome > 0.3 ? ' where it lifted off the pan' : ''}.`); break; } }
    if (p.faceDown.marks > 1 || p.faceUp.marks > 1) notes.push('Grill marks: dark bars where the grate pressed hotter lines into the crust.');
    if (p.faceDown.torn + p.faceUp.torn > 0) notes.push('Some crust tore off and stayed on the pan when it was moved before releasing.');
    if ((p.dirtAtStart || 0) > 0.002) notes.push('The pan was dirty going in: old burnt bits stuck to the crust and tasted of the last ticket. Wash it.');
    if (p.cheeses.concat(p.cheeseUnder).some((c) => c.fried)) notes.push('It went into the pan cheese-side down at some point: fried cheese where a crust should be, and some of it left behind on the metal.');
    else if (p.cheeses.some((c) => c.skirt && c.skirt.char > 0.3)) notes.push('Burnt cheese lace welded to the edges: acrid.');
    else if (p.cheeses.some((c) => c.skirt && c.skirt.brown > 2)) notes.push('A crisp golden cheese skirt around the edge. Good.');
    if (s._ms && s._ms.deepfry) notes.push('It was deep-fried: cooked in enough fat to cover it, so heat came in from every side at once.');
    if (p.grilled) notes.push(p.flareChar > 0.15 ? 'Flare-ups from dripping fat licked the underside: sooty, acrid patches.' : 'Grilled over charcoal: smoke and radiant heat, the edges browned too.');
    if ((p.bunSoak || 0) > 0.004) notes.push(`${(p.bunSoak * 1000).toFixed(0)} g of juice soaked into the bottom bun. It will not survive the walk to the table.`);
    if (p.lostWaterDrip > 0.006) notes.push(`${(p.lostWaterDrip * 1000).toFixed(0)} g of juice ran out ${p.grilled ? 'through the grate onto the coals' : 'onto the pan'} instead of staying in the meat.`);
    if (p.lostFat > 0.004) notes.push(`${(p.lostFat * 1000).toFixed(0)} g of fat rendered out and ${p.grilled ? 'fell on the coals' : 'pooled in the pan'}.`);
    if (overFrac > 0.5 && target.hi < 68) notes.push('A wide grey band: the outside went well past target before the centre got there. Thicker patty, lower heat, or flip more often.');
    if (p.dome > 0.5) notes.push('The patty domed into a meatball: the centre lifted off the pan and browned unevenly. A thumb dimple prevents that.');
    if (p.salt === 'mixed') notes.push('Salt was mixed through the meat early: dissolved myosin cross-linked into a springy, sausage-like bite.');
    if (p.work > 0.8) notes.push('The meat was overworked: dense and tight instead of loose and tender.');
    const profile = [], dG = []; for (let k = 0; k < p.Nz; k++) { profile.push(p.T[k * p.Nr]); dG.push(p.dG[k * p.Nr]); }
    return {
      id: p.id, total, target, got, peak, dist,
      parts,
      massStart: p.massKg0, massEnd: massNow, waterRetained: wRet, waterEvap: p.lostWaterEvap, waterDrip: p.lostWaterDrip, fatLost: p.lostFat, stuck: p.lostStuck,
      overFrac, notes, cookTime: p.cookTime, restTime: p.restT || 0, flips: p.flips, bunSoak: p.bunSoak || 0, cheeseSlices: p.cheeses.length,
      faces: { down: { ...p.faceDown }, up: { ...p.faceUp } },
      profile, dG,
    };
  }
  /** Score every served patty on a ticket; the ticket total is the mean. */
  /**
   * Score a whole ticket: the mean of its burgers, less a service penalty for any burger that went
   * out lukewarm because it sat on the plate while the others were still cooking. A rested patty
   * loses heat to the air; a centre that has fallen more than ~8 °C from its peak is noticeably
   * cooler on the tongue, and 20 °C down it is a cold burger.
   */
  function evaluateTicket(s) {
    const list = s.patties.filter((p) => p.where === 'cut' || p.where === 'rest').sort((a, b) => a.id - b.id);
    const results = list.map((p) => Object.assign(evaluate(s, p.target, p), { patty: p }));
    const notes = [];
    let cold = 0;
    for (const p of list) {
      const drop = Math.max(0, p.peakCenter - (p.serveT == null ? centerT(p) : p.serveT));
      const pen = 10 * clamp((drop - 8) / 12, 0, 1);
      cold += pen;
      if (pen > 0.5) notes.push(`Patty ${p.id} went out ${drop > 16 ? 'cold' : 'lukewarm'}: it sat ${fmtTime(p.restT || 0)} on the plate and its centre fell ${drop.toFixed(0)} °C from its peak.`);
    }
    const coldPenalty = list.length ? cold / list.length : 0;
    const rests = list.map((p) => p.restT || 0);
    const spread = rests.length > 1 ? Math.max(...rests) - Math.min(...rests) : 0;
    if (list.length > 1 && spread < 90 && coldPenalty < 0.5) notes.push('All the burgers landed together, still hot. That is the hard part of a multi-burger ticket.');
    else if (spread >= 240) notes.push(`The burgers came off the pan ${fmtTime(spread)} apart. Start the well-done one first and the rare one last so they finish together.`);
    const mean = results.length ? results.reduce((a, r) => a + r.total, 0) / results.length : 0;
    const total = Math.round(clamp(mean - coldPenalty, 0, 100));
    return { total, mean: Math.round(mean), coldPenalty: Math.round(coldPenalty), spread, results, notes };
  }

  return {
    C, BLENDS, PANS, FATS, STOVES, GRATE, DONENESS,
    makePatty, createState, step, stepPatty, pattySpots, panTat, selectPatty,
    setKnob, addFat, placePatty, flipPatty, pressPatty, removePatty, addCheese, toggleLid, basteButter, washPan, wipeStove, panDirt, serve,
    evaluate, evaluateTicket, donenessOf, centerT, cellT, layerMean, gridMean, pattyMass, layerMass, waterHolding, fmtTime, clamp, lerp, rhoVapSat, logEvent, pattyFinite,
  };
});
