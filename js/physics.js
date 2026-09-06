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
  /**
   * Raking the coals to one side. `bank` 0 spreads the same charcoal under the whole grate, 1 piles
   * it into the +x half: twice as deep over half the bed, bare ash under the rest. It moves the
   * mass, it does not change it — the bed still burns at `Tfire` — but what a point over the grate
   * *sees* changes completely. Over the pile a face sees glowing coal filling its view and the
   * fire's own gas coming up past it. Over the bare half it sees ash and the enamel of the bowl,
   * warmed by the pile but radiating at a fraction of its temperature, through about a third of the
   * view factor, with gas that has crossed the kettle and mixed with room air on the way. That is
   * worth 150–250 K at the bars, which is the entire point of a two-zone fire: sear on one side,
   * finish on the other.
   */
  const BANK = {
    edge0: -0.2, edge1: 0.2, // where the pile ends, as a fraction of the bed radius: a ~10 cm slope on a 22" kettle
    view: 0.36,              // the bare side's view factor as a fraction of the pile's (0.5 → 0.18 for meat, 0.4 → 0.14 for the bars)
    src: 0.75,               // and the temperature of what it does see, as a fraction of the bed's rise over ambient
    gas: 0.55,               // hot gas that has crossed from the coals, about half diluted with room air
    flare: 0.15,             // a flare burns where the fat lands, so bare ash only smokes at the meat above it
    N: 9,                    // strips across the bank axis that the bars' own two-zone temperature is solved on
  };

  /**
   * The cook's own instruments — a finger on the meat, a knife through it, a hand over the fire.
   *
   * TOUCH is the finger test. What a finger feels is stiffness, and everything that stiffens meat
   * is already in the grid. Raw ground beef is a wet paste held together by friction: its
   * compression modulus is about 8 kPa (published values for raw mince run 5–12 kPa depending on
   * how hard it was packed), and cold solid fat adds a little to that, which is why a fridge-cold
   * patty feels firmer than one that has sat out. Then, in order:
   *   • myosin (52–58 °C) gels and the paste becomes a solid — the single biggest step there is;
   *   • collagen (60–67 °C) shrinks to a fraction of its length and squeezes the fibres. Over
   *     hours it would dissolve to gelatin and soften the meat again, but a burger is on the pan
   *     for five minutes, so within this model collagen only ever toughens;
   *   • actin (66–73 °C) contracts and the meat goes hard — the well-done step;
   *   • and drying stiffens all of it: a boiled-dry crust is leather.
   *      E = E0 · (1 + aF·solid fat + aM·dM + aC·dC + aA·dA + aW·dryness)
   * per cell: 8 kPa for raw meat, about 60 kPa for dry well-done crust.
   */
  const TOUCH = {
    E0: 8e3, aF: 1.2, aM: 0.8, aC: 1.5, aA: 2.5, aW: 4.0,  // Pa, and the dimensionless multipliers above
    fingerR: 0.009,   // m — the pad of a finger is about 18 mm across
    juice: 0.55,      // a fingertip at a few kPa does locally about what a spatula does — the meat right under it gives up half its free juice — but only the meat right under it. Over the footprint (below) that is a tenth of a full press, which is what a cook would say the test costs.
    dwell: 1.2,       // s — how long the finger is on it: long enough to feel, short enough not to burn
    span: 8.0,        // E/E0 at which the firmness index reads 1.0: a dry, well-done patty at ~64 kPa. 0 is raw mince.
  };
  /**
   * PEEK: cutting into it to look. A cut across the middle opens 2·D·h of new surface (both cheeks
   * of the blade) against the 2πR² + πDh the patty already had — for a 10 cm × 18 mm patty that is
   * about a sixth of its surface, and it is a sixth that is all open fibre ends at the exact plane
   * the free juice is migrating through. The cheeks do fall back together, so call it a sixth of
   * the juice the matrix lets go of from then on running out of the cut instead of pooling on a
   * face and going back into the burger: a couple of percent of the water over a rest.
   */
  const PEEK = { drain: 0.15, structure: 0.25 }; // and a quarter of the structure mark: it is not a whole burger any more
  /**
   * HAND: the oldest thermometer there is. The palm is held about 8 cm over the metal (just inside
   * the rim of a pan; at the bars of a grate) and takes radiation from whatever fills its view plus
   * the convection of the plume rising off it. Time to "move your hand now" is the Stoll second-
   * degree-burn correlation, t ≈ 121·q^−1.35 with q in kW/m² — the point where one more second
   * would do damage, which is exactly when a hand comes away. Over a wide-open bed that is under
   * two seconds; over a 200 °C pan it is nearly half a minute, because a pan is not a fire.
   */
  const HAND = {
    z: 0.08,        // m above the metal
    bedDrop: 0.08,  // m the bed sits below the bars
    Tskin: 34,      // °C — skin surface in a warm kitchen
    emiss: 0.95,    // skin is very nearly a black body in the infrared
    ash: 0.82,      // the bed radiates from its ash skin, ~0.82 of its own rise over ambient in absolute terms
    plume: 0.6,     // the plume over a pan reaches the hand at 60 % of the metal's rise over ambient (it has only entrained a third of a pan-width of room air by then)
    h: 15, hFire: 18, // W/(m²K) onto a hand in a buoyant plume (~1 m/s) and in the faster draught of a fire
    stoll: 121, exp: 1.35, // t (s) = stoll · (q kW/m²)^−exp
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
  // The logistic rates below share widths, so three of the six exponentials the reaction block
  // needs are constant multiples of the other three: exp((64−T)/1.5) = exp((68−T)/1.5)·e^(−8/3)
  // (myoglobin off actin) and exp((42−T)/3) = exp((61−T)/3)·e^(−19/3) (fat melting off collagen).
  // Same numbers to the last bit or two, half the exponentials.
  // The fat-release sigmoid is twice as wide as the collagen one, so its exponential is the
  // square root of a constant multiple of it: exp((66−T)/6) = √(exp((61−T)/3)·e^(5/3)).
  const K_MYOGLOBIN = Math.exp(-8 / 3), K_FATMELT = Math.exp(-19 / 3), K_FATREL = Math.exp(5 / 3);
  const IRHO_W = 1 / 1000, IRHO_F = 1 / 920, IRHO_P = 1 / 1320; // reciprocals of C.rhoW/rhoF/rhoP: the composition sweep divides by them for every cell
  const p4 = (x) => { const y = x * x; return y * y; };   // T⁴ for radiation, as two multiplies instead of a pow() call
  const hyp = (x, y) => Math.sqrt(x * x + y * y);         // Math.hypot guards against overflow at 1e154; nothing here is anywhere near it
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
      N: Nz, Nz, Nr, massKg0: massKg, rho0: rho, voids, work,
      h0: h, D0: D, A0: A, h, D, A,
      dimple: !!o.dimple, salt: o.salt || 'surface', fatFrac: fat, T0,
      T: new Float64Array(n).fill(T0),
      w: new Float64Array(n), w0c: new Float64Array(n), fs: new Float64Array(n), fl: new Float64Array(n), fr: new Float64Array(n), fat0c: new Float64Array(n),
      p: new Float64Array(n), dM: new Float64Array(n), dC: new Float64Array(n), dA: new Float64Array(n), dG: new Float64Array(n),
      Tpk: new Float64Array(n).fill(T0), // hottest each cell has ever been: the record that decides what is 'past target'
      Tmin: T0, // coldest cell as of the last step: the stability bound needs to know about ice
      subSteps: 1, // how many conduction sub-steps the last call needed (1 unless the layers are thin)
      aj: new Float64Array(Nr), // ring area fractions
      faceDown: makeFace('A', Nr), faceUp: makeFace('B', Nr), faceSide: { brown: 0, char: 0 },
      poolB: new Float64Array(Nr), poolT: new Float64Array(Nr), poolBottom: 0, poolTop: 0, fatTop: 0,
      dome: 0, pressT: 0, pressed: false, scrapeT: 0, moved: 0,
      // what the cook's own senses have cost this patty: presses of a finger, cuts of a knife
      slits: 0, slitAngle: 0, pressTests: 0, pressTestT: 0, pressTestJuice: 0, lostWaterCut: 0,
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
    // Water-holding capacity has a fixed part (the salt, and how hard the meat was worked) and a
    // part that follows denaturation. The fixed part cannot change after forming, so it is folded
    // once here: waterHolding() is then three multiplies and a clamp, and it is evaluated for
    // every cell of the grid every step.
    p.whc0 = 1 - 0.05 * work + (p.salt === 'mixed' ? 0.06 : p.salt === 'none' ? -0.02 : 0);
    p.sc = pattyScratch(Nz, Nr);
    return p;
  }
  function makeFace(id, Nr) { return { id, brown: 0, char: 0, torn: 0, crisp: 0, stuck: true, maxT: 0, brownR: new Float64Array(Nr), charR: new Float64Array(Nr) }; }

  /**
   * Per-patty scratch. stepPatty runs 40 times a second for every patty and every temporary it
   * needs is the size of the grid; allocating them per call threw away a megabyte a second per
   * patty and cost more than the arithmetic did. They are allocated once with the grid (Nz and Nr
   * never change afterwards — a smash changes the patty's thickness, not its cell count) and every
   * step overwrites them. Nothing here is read across steps.
   */
  function pattyScratch(Nz, Nr) {
    const n = Nz * Nr;
    const qBotR = new Float64Array(Nr);
    return {
      Cn: new Float64Array(n), Kn: new Float64Array(n), Q: new Float64Array(n),
      X: new Float64Array(n), flux: new Float64Array(n), fmv: new Float64Array(n), dir: new Int8Array(n),
      Aj: new Float64Array(Nr), qBotR, TpanR: new Float64Array(Nr), hcR: new Float64Array(Nr), TsLim: new Float64Array(Nr),
      TatR: new Float64Array(Nr),
      cheeseFlux: new Float64Array(26), cheeseFluxTop: new Float64Array(26), // at most 24 slices, plus the air above
      res: { qBot: 0, qBotR, hc: 0, boilBottom: 0, evapTop: 0, fatDrip: 0, fatSide: 0, juiceSide: 0, Ts: 0, qSide: 0 },
      acc: { qBot: 0, qBotR: new Float64Array(Nr), hc: 0, boilBottom: 0, evapTop: 0, fatDrip: 0, fatSide: 0, juiceSide: 0, Ts: 0, qSide: 0 },
      bcPan: null, bcGrill: null, bcAir: null,
    };
  }

  function cellMass(p, c) { return p.w[c] + p.fs[c] + p.fl[c] + p.fr[c] + p.p[c]; }
  function nodeMass(p, k) { let m = 0; for (let j = 0; j < p.Nr; j++) m += cellMass(p, k * p.Nr + j); return m; }
  function pattyMass(p) { let m = 0; for (let c = 0; c < p.T.length; c++) m += cellMass(p, c); return m + p.poolBottom + p.poolTop + p.fatTop; }
  function centerT(p) { const N = p.Nz, Nr = p.Nr; return N % 2 ? p.T[((N - 1) / 2) * Nr] : 0.5 * (p.T[(N / 2 - 1) * Nr] + p.T[(N / 2) * Nr]); }
  function cellT(p, k, j) { return p.T[k * p.Nr + j]; }
  function layerMean(p, arr, k) { let s = 0; for (let j = 0; j < p.Nr; j++) s += arr[k * p.Nr + j] * p.aj[j]; return s; }
  function gridMean(p, arr) { let s = 0; for (let k = 0; k < p.Nz; k++) s += layerMean(p, arr, k); return s / p.Nz; }
  function avg(arr) { let s = 0; for (const v of arr) s += v; return s / arr.length; }
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
        smoke: 0, smokeOil: 0, smokeChar: 0, smokeFond: 0, smokeItems: 0,
        lostSpatter: 0, area: Math.PI * (pan.diam / 2) ** 2,
        // the bars' two-zone field (a grate only): the absolute temperature of each strip across the
        // bank axis, the zero-mean departure from the ring solution it implies, and how much of the
        // bed's area each strip carries. `zoned` is false while the fire is spread evenly, and then
        // every lookup is exactly the ring lookup it always was.
        zoneT: grill ? new Float64Array(BANK.N).fill(Tamb) : null, zoneDT: grill ? new Float64Array(BANK.N) : null, zoneW: grill ? zoneWeights() : null, zoned: false,
      },
      lid: false, lidAirT: Tamb,
      // the fire, when the stove is a grill: coal left, bed temperature, ash, flare-ups, dome air,
      // and how the bed is raked (0 = spread under the whole grate, 1 = banked into one half)
      grill: grill ? { coal: 1.5, coal0: 1.5, Tfire: Tamb, ash: 0, lit: false, flare: 0, flareTotal: 0, Tdome: Tamb, fatOnCoals: 0, burnW: 0, bank: 0, mView: COAL.viewGrate, mViewTs4: 0, mTgas: Tamb } : null,
      patties: [], patty: null, where: 'board', // s.patty / s.where mirror the selected patty
      items: [], item: null, // toppings sharing the pan: bun halves, bacon, an egg, onions
      baste: 0,
      events: [], log: [], trace: [], traceEvery: 0.5, lastTrace: -1,
      // sizzle is the level; boilNoise/hiss/roar/contact are its character, which is what a cook
      // listening to the pan is actually reading (see the sizzle block at the end of step())
      diag: { sizzle: 0, spatter: 0, steam: 0, smoke: 0, evapBottom: 0, evapPan: 0, oilBubble: 0, fatDrip: 0, juiceTop: 0, juiceSide: 0, panQ: 0, boilNoise: 0, hiss: 0, roar: 0, contact: 0, lid: false },
      rest: { t: 0 }, result: null,
    };
    return s;
  }
  function panTat(pan, r) {
    // pan temperature at radius r (m), linear between ring centres
    const x = clamp(r / pan.dr - 0.5, 0, pan.Np - 1); const j = Math.floor(x), t = x - j;
    return j >= pan.Np - 1 ? pan.Tr[pan.Np - 1] : lerp(pan.Tr[j], pan.Tr[j + 1], t);
  }
  /** Share of the round bed's area in each strip across the bank axis (a chord is ∝ √(1−u²) long). */
  function zoneWeights() {
    const w = new Float64Array(BANK.N); let sum = 0;
    for (let i = 0; i < BANK.N; i++) { const u = -1 + (2 * i + 1) / BANK.N; w[i] = Math.sqrt(Math.max(0, 1 - u * u)); sum += w[i]; }
    for (let i = 0; i < BANK.N; i++) w[i] /= sum;
    return w;
  }
  /** How much of the bed under `u` (x as a fraction of the bed radius) is glowing coal, 0..1. */
  function coalAt(g, u) { return g.bank > 0 ? 1 - g.bank * (1 - smooth(BANK.edge0, BANK.edge1, u)) : 1; }
  /**
   * The fire as seen from a point on the bank axis: the coal fraction under it, its view factor of
   * the fire as a fraction of the pile's, the temperature of what it sees, and the gas coming up
   * past it. Filled into one reused object — it is read once per patty and once per topping every
   * step, and nothing in here allocates. With the coals spread it is the bed itself, unchanged.
   */
  const BED = { f: 1, view: 1, Tfire: 0, Tgas: 0 };
  function bedAt(s, x) {
    const g = s.grill, Tamb = s.env.Tamb, Tgas0 = Tamb + 0.5 * (g.Tfire - Tamb);
    if (!g.bank) { BED.f = 1; BED.view = 1; BED.Tfire = g.Tfire; BED.Tgas = Tgas0; return BED; }
    const f = coalAt(g, clamp(x / s.pan.floorR, -1, 1));
    BED.f = f; BED.view = f + BANK.view * (1 - f);
    BED.Tfire = Tamb + (g.Tfire - Tamb) * (f + BANK.src * (1 - f));
    BED.Tgas = Tamb + (Tgas0 - Tamb) * (f + BANK.gas * (1 - f));
    return BED;
  }
  /** The bars' departure from the ring solution at x. Zero unless the fire has been banked. */
  function zoneAt(pan, x) {
    if (!pan.zoned) return 0;
    const q = clamp((x / pan.floorR + 1) * 0.5 * BANK.N - 0.5, 0, BANK.N - 1), i = Math.floor(q);
    return i >= BANK.N - 1 ? pan.zoneDT[BANK.N - 1] : lerp(pan.zoneDT[i], pan.zoneDT[i + 1], q - i);
  }
  /**
   * Metal temperature under a *point* on the pan: the rings, plus the two-zone offset when the coals
   * have been raked to one side. This is panTat() with the axis the rings cannot see added back.
   */
  function panTatXY(s, x, y) {
    const T = panTat(s.pan, hyp(x, y));
    if (!s.grill || !s.pan.zoned) return T;
    return Math.max(s.env.Tamb, T + zoneAt(s.pan, x));
  }
  function selectPatty(s, p) { s.patty = p || null; s.where = p ? p.where : 'board'; s.item = null; }
  function syncSelected(s) { if (s.patty) s.where = s.patty.where; }

  function logEvent(s, text, kind) {
    s.events.push({ t: s.t, text, kind: kind || 'info' });
    if (s.events.length > 400) s.events.shift();
  }

  // ---------------------------------------------------------------- actions
  function setKnob(s, v) { s.stove.knob = clamp(v, 0, 10); }
  /** Rake the coals: 0 spreads them under the whole grate, 1 piles them into one half. */
  function setBank(s, v) {
    if (!s.grill) return;
    const b = clamp(v, 0, 1), was = s.grill.bank;
    s.grill.bank = b;
    if (Math.abs(b - was) < 0.05) return;
    if (b < 0.05) logEvent(s, 'Raked the coals back out flat under the grate. One temperature everywhere again.', 'action');
    else logEvent(s, `Banked the coals ${b > 0.75 ? 'hard' : 'partly'} to one side with the tongs (${(b * 100).toFixed(0)} %). The bed is deeper over there and bare ash on the other side: sear over the coals, then slide it across to finish. The bars take a minute or two to settle into two zones.`, 'action');
  }

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
    const Tunder = panTatXY(s, patty.pos.x, patty.pos.y);
    const others = s.patties.filter((q) => q !== patty && q.where === 'pan').length;
    logEvent(s, `Patty ${patty.id} (${(patty.massKg0 * 1000).toFixed(0)} g, ${(patty.h0 * 1000).toFixed(0)} mm, ${(patty.fatFrac * 100).toFixed(0)} % fat, ${patty.T0.toFixed(0)} °C) hits the ${s.grill ? 'grate' : 'pan'} at ${Tunder.toFixed(0)} °C under it` + (others ? ` — ${others + 1} ${s.grill ? 'on the grate' : 'in the pan'} now, and every cold patty drags the metal down.` : '.'), 'action');
    if (s.grill && (!s.grill.lit || s.grill.Tfire < 350)) logEvent(s, 'The coals are not ready. Meat over a cool fire steams and sticks; wait for the bed to glow.', 'warn');
    else if (!s.grill && Tunder < 120) logEvent(s, 'The pan is not hot enough there. The meat will steam in its own juice and go grey.', 'warn');
  }

  /**
   * Breaking the weld under a face that has not released yet. Raw protein bonds to hot metal and
   * lets go again only once the crust has set and dried; before that, whatever you do to the patty
   * — lift it, slide it, drag it across the pan — takes the bottom layer off in strips, and the
   * strips stay on the metal as fond and burnt bits. `mul` is the tool: 1 for a spatula under the
   * whole face at once (a flip, a lift), less for a thin edge worked under it. Every action that
   * moves a stuck patty comes through here, so a drag costs exactly what an early flip costs.
   */
  function tearStuck(s, p, mul) {
    const fd = p.faceDown, relThr = s.pan.release * (s.pan.oil > 0.002 ? 0.7 : 1.0);
    if (!fd.stuck || fd.brown >= relThr || s.pan.release <= 0) return 0;
    const torn = clamp(0.25 * (1 - fd.brown / relThr), 0.03, 0.25) * (mul == null ? 1 : mul);
    const m0 = nodeMass(p, 0);
    for (const k of ['w', 'fs', 'fl', 'fr', 'p']) for (let j = 0; j < p.Nr; j++) { p.lostStuck += p[k][j] * torn; p[k][j] *= (1 - torn); }
    s.pan.fond += m0 * torn * 0.3; s.pan.meatBits += m0 * torn;
    fd.torn += torn;
    return torn;
  }

  // ---- the spatula: sliding things around the pan, and working the blade under a stuck one
  const MOVE_GAP = 0.002;    // 2 mm of daylight a cook leaves between two patties when shuffling them
  const SCRAPE_TEAR = 0.4;   // a thin edge worked under a half-set crust takes ~40 % of what lifting the whole face does
  const SCRAPE_TIME = 1.0;   // and it takes about a second, with the face up on the blade and off the metal
  const SCRAPE_LIFT = 0.35;  // how much of the face still touches while the blade is under it

  /**
   * Where something of radius `rad` can actually go when the cook aims it at `want`. Two rules: the
   * floor is the limit (nothing hangs over the wall or off the grate), and two things cannot occupy
   * the same metal — the target is pushed off whatever it lands on, then back inside the floor, a
   * few times over, and if there is still no room it is refused rather than stacked.
   */
  function slideTo(s, moving, rad, want) {
    const R = s.pan.floorR, lim = Math.max(0, R - rad);
    let x = want.x, y = want.y;
    const d0 = hyp(x, y); if (d0 > lim) { const k = d0 > 1e-9 ? lim / d0 : 0; x *= k; y *= k; }
    const others = [];
    for (const q of s.patties) if (q !== moving && q.where === 'pan') others.push({ x: q.pos.x, y: q.pos.y, r: q.D / 2 });
    for (const it of s.items) if (it !== moving && it.where === 'pan') others.push({ x: it.pos.x, y: it.pos.y, r: it.Dcov / 2 });
    for (let pass = 0; pass < 6; pass++) {
      let worst = 0;
      for (const q of others) {
        const dx = x - q.x, dy = y - q.y, d = hyp(dx, dy), need = q.r + rad + MOVE_GAP;
        if (d >= need) continue;
        const push = need - d; if (push > worst) worst = push;
        const ux = d > 1e-6 ? dx / d : 1, uy = d > 1e-6 ? dy / d : 0;
        x += ux * push; y += uy * push;
      }
      const d = hyp(x, y); if (d > lim) { const k = lim / d; x *= k; y *= k; }
      if (worst < 1e-5) break;
    }
    const clear = (px, py) => { for (const q of others) if (hyp(px - q.x, py - q.y) < q.r + rad - 0.001) return false; return true; }; // a millimetre of touching is a touch, not a stack
    if (clear(x, y)) return { pos: { x, y }, ok: true };
    // pushed out and clamped back and still on top of something — usually because the way out is
    // along the wall, not away from it. Take the nearest spot that does fit, the way a cook shuffles
    // things round the edge of a crowded pan.
    let best = null, bestD = Infinity;
    for (let ri = 0; ri <= 4; ri++) {
      const rr = lim * (1 - ri * 0.25);
      for (let a = 0; a < 24; a++) {
        const ang = (a / 24) * Math.PI * 2, px = rr * Math.cos(ang), py = rr * Math.sin(ang);
        if (!clear(px, py)) continue;
        const dd = hyp(px - want.x, py - want.y); if (dd < bestD) { bestD = dd; best = { x: px, y: py }; }
      }
      if (best) break; // the outermost ring of candidates that has room is where it goes
    }
    return best ? { pos: best, ok: true } : { pos: { x, y }, ok: false };
  }

  /**
   * Slide a patty across the pan. Position is everything the pan does to it — which rings it draws
   * from, which part of the burner's hot spot it sits over, which side of a banked fire it is on —
   * and all of that follows the new position on the next step, because the boundary conditions are
   * rebuilt from `p.pos` every time. What moving costs is the weld: a face that has not released
   * yet tears exactly as it would if you had flipped it early.
   */
  function movePatty(s, patty, pos) {
    const p = patty || s.patty; if (!p || p.where !== 'pan' || !pos) return { ok: false, reason: 'not on the heat' };
    const to = slideTo(s, p, p.D / 2, pos);
    if (!to.ok) { logEvent(s, `No room there: patty ${p.id} would end up on top of something else. Move what is in the way first.`, 'warn'); return { ok: false, reason: 'no room', pos: p.pos }; }
    const moved = hyp(to.pos.x - p.pos.x, to.pos.y - p.pos.y);
    if (moved < 0.002) return { ok: true, torn: 0, moved: 0, pos: p.pos }; // 2 mm is not a move
    const before = panTatXY(s, p.pos.x, p.pos.y);
    const torn = tearStuck(s, p, 1);
    p.pos = { x: to.pos.x, y: to.pos.y };
    p.moved = (p.moved || 0) + 1;
    const after = panTatXY(s, p.pos.x, p.pos.y);
    const where = s.grill ? 'grate' : 'pan';
    let zone = '';
    if (s.grill && s.grill.bank > 0.05) { const f = coalAt(s.grill, clamp(p.pos.x / s.pan.floorR, -1, 1)); zone = f > 0.6 ? ' — over the coals now, full radiant heat.' : f < 0.25 ? ' — off the coals now: radiant heat all but gone, so it will coast to temperature instead of searing.' : ' — half on, half off the coals.'; }
    logEvent(s, `Slid patty ${p.id} ${(moved * 100).toFixed(1)} cm across the ${where}: ${before.toFixed(0)} °C under it before, ${after.toFixed(0)} °C where it is now.${zone}`
      + (torn > 0 ? ` It had not released: ${(torn * 100).toFixed(0)} % of the bottom face tore off and stayed on the metal. Work a spatula under it first, or wait for the crust to set.` : ''), torn > 0 ? 'warn' : 'action');
    return { ok: true, torn, moved, pos: p.pos };
  }

  /** The same for a topping: it drags its footprint — and the rings it draws heat from — with it. */
  function moveItem(s, item, pos) {
    const it = item || s.item; if (!it || it.where !== 'pan' || !pos) return { ok: false, reason: 'not on the heat' };
    const to = slideTo(s, it, it.Dcov / 2, pos);
    if (!to.ok) { logEvent(s, `No room there: the ${it.label.toLowerCase()} would be lying on top of something.`, 'warn'); return { ok: false, reason: 'no room', pos: it.pos }; }
    const moved = hyp(to.pos.x - it.pos.x, to.pos.y - it.pos.y);
    if (moved < 0.002) return { ok: true, moved: 0, pos: it.pos };
    const before = it.Tat;
    it.pos = { x: to.pos.x, y: to.pos.y };
    it.rings = footprintRings(s.pan, it.pos, it.D / 2); // the metal it draws from is the metal under it now
    it.Tat = ringsT(s.pan, it.rings) + (s.grill && s.pan.zoned ? zoneAt(s.pan, it.pos.x) : 0);
    logEvent(s, `Moved the ${it.label.toLowerCase()} ${(moved * 100).toFixed(1)} cm: ${before.toFixed(0)} °C under it before, ${it.Tat.toFixed(0)} °C now.`, 'action');
    return { ok: true, moved, pos: it.pos };
  }

  /**
   * Work the spatula under a patty. A thin steel edge slid under a crust that is half set breaks the
   * weld a strip at a time instead of ripping the whole face off at once, so it costs about 40 % of
   * what lifting it would (SCRAPE_TEAR) — that is the difference between a cook who knows the tool
   * and one who does not. It costs a second, and for that second most of the face is up on the blade
   * rather than on the metal, so it is a second of searing thrown away. On a patty that has already
   * released there is nothing to break: it just slides.
   */
  function scrape(s, patty) {
    const p = patty || s.patty; if (!p || p.where !== 'pan') return { ok: false };
    const fd = p.faceDown, wasStuck = fd.stuck;
    const torn = tearStuck(s, p, SCRAPE_TEAR);
    fd.stuck = false; // the blade is under it: whatever was welded is off the metal now
    p.scrapeT = SCRAPE_TIME;
    if (torn > 0) logEvent(s, `Worked the spatula under patty ${p.id}. It was welded on: ${(torn * 100).toFixed(0)} % of the face came away — a fraction of what lifting it would have cost — and it is free now.`, 'warn');
    else logEvent(s, `Worked the spatula under patty ${p.id}: it moves freely.${wasStuck ? ' The crust had set and let go on its own; the blade only confirmed it.' : ''}`, 'action');
    return { ok: true, torn, free: true };
  }

  function flipPatty(s, patty) {
    const p = patty || s.patty; if (!p || p.where !== 'pan') return { ok: false };
    const fd = p.faceDown;
    const torn = tearStuck(s, p, 1);
    if (torn > 0) logEvent(s, `Patty ${p.id} stuck. ${(torn * 100).toFixed(0)} % of the bottom face tore off and stayed welded to the pan. Meat releases on its own once the crust sets.`, 'warn');
    // Orientation reversal: reverse every column.
    for (const k of ['T', 'w', 'w0c', 'fs', 'fl', 'fr', 'fat0c', 'p', 'dM', 'dC', 'dA', 'dG']) {
      const a = p[k];
      for (let j = 0; j < p.Nr; j++) for (let lo = 0, hi = p.Nz - 1; lo < hi; lo++, hi--) { const t = a[lo * p.Nr + j]; a[lo * p.Nr + j] = a[hi * p.Nr + j]; a[hi * p.Nr + j] = t; }
    }
    p.w0 = p.w0c[0]; p.fat0 = p.fat0c[0];
    const tmp = p.faceDown; p.faceDown = p.faceUp; p.faceUp = tmp;
    let juiceHit = 0; for (let j = 0; j < p.Nr; j++) { juiceHit += p.poolT[j]; p.poolT[j] = 0; p.poolB[j] = 0; }
    s.pan.water += juiceHit; p.poolTop = 0; p.poolBottom = 0;
    s.pan.oil += p.fatTop; p.fatTop = 0;
    p.faceDown.stuck = true;
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
    logEvent(s, `Patty ${p.id}: flip #${p.flips}. Face ${p.faceDown.id} down.` + (juiceHit > 0.0005 ? ` ${(juiceHit * 1000).toFixed(1)} g of pooled juice hit the pan and flashed to steam.` : ''), 'action');
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
    if (cooked < 0.25 && hard) {
      let hNew = Math.max(0.004, p.h * 0.55);
      const Dmax = 2 * s.pan.floorR * 0.94;
      const V = p.A * p.h;
      let Anew = V / hNew, Dnew = Math.sqrt((4 * Anew) / Math.PI);
      let hitWall = false;
      if (Dnew > Dmax) { Dnew = Dmax; Anew = (Math.PI * Dnew * Dnew) / 4; hNew = V / Anew; hitWall = true; }
      if (hNew >= p.h * 0.98) { logEvent(s, 'Pressed hard, but it already fills the pan: nowhere left to go.', 'action'); return; }
      p.h = hNew; p.A = Anew; p.D = Dnew;
      p.h0 = p.h; p.A0 = p.A; p.D0 = p.D;
      p.faceDown.stuck = true;
      logEvent(s, `SMASHED. Patty ${p.id} flattened to ${(p.h * 1000).toFixed(0)} mm, ${(p.D * 100).toFixed(1)} cm across.` + (hitWall ? ' It has hit the pan wall.' : ' Huge contact area, huge crust, no pink centre.'), 'action');
    } else {
      logEvent(s, `Pressed patty ${p.id} with the spatula. ${(expelled * 1000).toFixed(1)} g of juice squeezed out and boiled off. That was flavour.`, expelled > 0.002 ? 'warn' : 'action');
    }
  }

  function removePatty(s, patty) {
    const p = patty || s.patty; if (!p || p.where !== 'pan') return;
    if (tearStuck(s, p, 1) > 0) logEvent(s, `Prised patty ${p.id} off the pan; the bottom crust stayed behind.`, 'warn');
    s.pan.oil += p.fatTop; p.fatTop = 0;
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

  // ---------------------------------------------------------------- the cook's senses
  /** Compression modulus (Pa) of one cell, from what has denatured in it and how dry it is. */
  function cellStiffness(p, c) {
    const wr = p.w[c] / p.w0c[c], dry = wr >= 1 ? 0 : 1 - wr;
    const solid = p.fs[c] / (p.w[c] + p.fs[c] + p.fl[c] + p.fr[c] + p.p[c] + 1e-12); // fat that has not melted yet is waxy and stiff
    return TOUCH.E0 * (1 + TOUCH.aF * solid + TOUCH.aM * p.dM[c] + TOUCH.aC * p.dC[c] + TOUCH.aA * p.dA[c] + TOUCH.aW * dry);
  }
  /**
   * What a finger on the middle of the patty feels.
   *
   * Through the thickness the layers are springs in series — a finger squashes all of them at once
   * and each takes the same load — so it is the *compliances* that add, and one soft raw layer in
   * the middle dominates the feel however hard the crust is. That is the whole reason the press
   * test works at all: it reports the softest thing in the stack, which is the centre, which is the
   * thing you actually want to know. Across the patty the columns are springs in parallel and add
   * as stiffnesses, weighted by the strain field under the fingertip: a Boussinesq-ish Gaussian of
   * radius (finger + half the thickness), because the load spreads out at roughly 45° as it goes
   * down. The index that comes back is that modulus on the cook's ladder: 0 raw, 1 well done.
   */
  function firmness(p) {
    const Nr = p.Nr, Nz = p.Nz, dr = p.D / 2 / Nr, spread = TOUCH.fingerR + 0.5 * p.h;
    let E = 0, wsum = 0;
    for (let j = 0; j < Nr; j++) {
      const rc = (j + 0.5) * dr, u = rc / spread, wj = p.aj[j] * Math.exp(-u * u);
      if (wj < 1e-6) continue;
      let comp = 0;
      for (let k = 0; k < Nz; k++) comp += 1 / cellStiffness(p, k * Nr + j);
      E += (wj * Nz) / comp; wsum += wj;
    }
    E /= Math.max(wsum, 1e-12);
    // the index is that modulus on the cook's own scale: 0 is raw mince, 1 is a well-done patty
    return { E, index: clamp((E - TOUCH.E0) / (TOUCH.E0 * (TOUCH.span - 1)), 0, 1.3) };
  }
  /**
   * The words a cook puts to that, in the order a hand learns them: raw is the soft heel of your
   * open palm, well done is the same spot with your fist clenched, and everything else is between.
   * The thresholds are where a 150 g patty's index actually lands when its centre peaks at the top
   * of each band.
   */
  function firmnessWord(i) {
    if (i < 0.20) return { word: 'raw', text: 'soft and slack — it takes the print of your finger and keeps it. Raw in the middle.' };
    if (i < 0.46) return { word: 'soft', text: 'soft, with the beginnings of a spring under it. Rare, if that.' };
    if (i < 0.63) return { word: 'springy', text: 'springy — it pushes back and comes most of the way home. Medium-rare.' };
    if (i < 0.82) return { word: 'firm-springy', text: 'firm, but there is still some give in the middle. Medium.' };
    if (i < 0.925) return { word: 'firm', text: 'firm, barely any give left. Medium-well.' };
    return { word: 'hard', text: 'hard. It hardly moves under a finger. Well done, and then some.' };
  }
  /**
   * Press it with a finger. Reads the firmness (which is the denaturation profile, felt rather than
   * measured) and costs what a real press costs: a little juice, and a second and a bit of your
   * attention with your hand over a hot pan. A fingertip at a few kPa over a couple of square
   * centimetres does locally about what a spatula does — the meat right under it gives up half its
   * free juice — but only over the fingertip's own footprint, which is the same weighting the
   * firmness is read on, and which works out at a tenth of a full press. (It also takes heat out of
   * the crust the other way — 2.5 cm² of 35 °C skin against 150 °C meat is about 6 W for a second,
   * worth 0.02 °C to a 150 g patty. Real, and far too small to bother modelling.)
   */
  function pressTest(s, patty) {
    const p = patty || s.patty; if (!p || p.where === 'board' || p.where === 'cut') return null;
    const f = firmness(p), read = firmnessWord(f.index);
    const Nr = p.Nr, dr = p.D / 2 / Nr, spread = TOUCH.fingerR + 0.5 * p.h;
    let out = 0;
    for (let j = 0; j < Nr; j++) {
      const rc = (j + 0.5) * dr, u = rc / spread, under = Math.exp(-u * u); // only the meat under the finger is squeezed
      if (under < 1e-3) continue;
      for (let k = 0; k < p.Nz; k++) {
        const c = k * Nr + j;
        const free = Math.max(0, p.w[c] - waterHolding(p, c) * p.w0c[c]);
        let m = free + (p.dM[c] > 0.3 ? p.w[c] * 0.10 * p.dM[c] * (0.5 + 0.5 * p.dA[c] + 0.5 * p.dC[c]) : 0);
        m = Math.min(p.w[c], m * TOUCH.juice * under);
        p.w[c] -= m; out += m;
      }
    }
    p.lostWaterDrip += out; p.pressTestJuice += out; p.pressTests++;
    p.pressTestT = TOUCH.dwell;
    p.dome *= 0.85; // you are pushing down on it: the dome flattens a little and springs most of the way back
    if (p.where === 'pan') { if (s.grill) s.grill.juiceOnCoals = (s.grill.juiceOnCoals || 0) + out; else s.pan.water += out; }
    logEvent(s, `Press test on patty ${p.id}: ${read.text}` + (out > 2e-5 ? ` (${(out * 1000).toFixed(2)} g of juice out of it — the price of knowing.)` : ''), 'note');
    return { index: f.index, E: f.E, word: read.word, reading: read.text, juice: out, seconds: TOUCH.dwell };
  }
  /**
   * What the cut face looks like, off the same numbers the renderer paints it from: myoglobin (dG)
   * is the pink-to-grey line and myosin (dM) is how opaque and set the meat looks. Read down the
   * axis, which is where a cook looks — the rim is always further along.
   */
  function sliceRead(p) {
    const Nr = p.Nr, Nz = p.Nz, dz = p.h / Nz;
    const kc = Math.floor((Nz - 1) / 2), cc = kc * Nr;
    const g = p.dG[cc], m = p.dM[cc], T = p.T[cc];
    let colour;
    if (g < 0.12) colour = m < 0.3 ? 'deep red and translucent, cold in the middle' : 'deep red, and still slack';
    else if (g < 0.35) colour = 'bright red, wet and glossy';
    else if (g < 0.6) colour = 'pink right through the middle';
    else if (g < 0.8) colour = 'rosy — pink going to grey';
    else if (g < 0.93) colour = 'a thin blush of pink at the very centre';
    else colour = 'grey-brown from face to face; no pink left anywhere';
    // the grey band: layers from each face whose myoglobin is more than 70 % gone, i.e. the meat
    // that has visibly turned. 0.7 is where the pink stops reading as pink on the cut face.
    let gb = 0; while (gb < Nz && p.dG[gb * Nr] > 0.7) gb++;
    let gt = 0; while (gt < Nz && p.dG[(Nz - 1 - gt) * Nr] > 0.7) gt++;
    return { centreG: g, centreM: m, centreT: T, colour, greyBottomMm: gb * dz * 1000, greyTopMm: gt * dz * 1000, layerMm: dz * 1000 };
  }
  /**
   * Cut into it and look. The most honest instrument in the kitchen and the most expensive one:
   * from here on it is a patty with a slit in it, the cut face bleeds through the rest (see PEEK),
   * and it goes out on the bun cut. Returns what the cook sees.
   */
  function peek(s, patty) {
    const p = patty || s.patty; if (!p || p.where === 'board' || p.where === 'cut') return null;
    const v = sliceRead(p);
    p.slits++;
    if (p.slits === 1) p.slitAngle = Math.random() * Math.PI * 2;
    const band = v.greyBottomMm + v.greyTopMm < 0.5 * v.layerMm
      ? 'no grey band at all yet'
      : `a grey band ${v.greyBottomMm.toFixed(1)} mm deep on the face that is down and ${v.greyTopMm.toFixed(1)} mm on the other`;
    logEvent(s, `Cut into patty ${p.id} to look: ${v.colour}, ${band}.` + (p.slits > 1 ? ` That is ${p.slits} cuts in it now.` : ' It will weep out of that cut for the rest of the cook, and it goes out with a slit in it.'), 'note');
    return { ...v, slits: p.slits, band };
  }
  /**
   * How many seconds you can hold a hand a few centimetres over the metal. Radiation from whatever
   * fills the hand's view (the pan floor; over a kettle, the bars plus the ash-skinned bed seen
   * through the gaps between them) plus convection from the plume, and then the Stoll curve for how
   * long skin takes that. `pos` is where the hand is held — over a banked fire that is the whole
   * point of the test.
   */
  function handTest(s, pos) {
    const pan = s.pan, Tamb = s.env.Tamb, x = pos ? pos.x : 0, y = pos ? pos.y : 0;
    const Tsk4 = p4(HAND.Tskin + 273.15), k = HAND.emiss * C.sigma;
    // view factor from a point to a coaxial disc of radius R at height z: R²/(R²+z²)
    const vf = (R, z) => (R * R) / (R * R + z * z);
    let rad = 0, conv = 0, source;
    if (s.grill) {
      const bed = bedAt(s, x), Rbed = pan.floorR * 0.88; // the bed is a little smaller than the grate it sits under
      const Fbars = vf(pan.floorR, HAND.z) * pan.barFrac;
      const Fbed = vf(Rbed, HAND.z + HAND.bedDrop) * (1 - pan.barFrac) * bed.view;
      // the coals radiate from their grey ash skin, not from their glowing interior
      const Tash = Tamb + HAND.ash * (bed.Tfire - Tamb);
      const Tbar = panTatXY(s, x, y);
      rad = k * (Fbed * (p4(Tash + 273.15) - Tsk4) + Fbars * (p4(Tbar + 273.15) - Tsk4));
      conv = HAND.hFire * Math.max(0, bed.Tgas - HAND.Tskin);
      source = { Tbar, Tfire: bed.Tfire };
    } else {
      // at 8 cm most of the view is the metal within a hand's width of the spot; the rest of the
      // floor fills in the edges
      const Tlocal = panTatXY(s, x, y), Tsurf = 0.65 * Tlocal + 0.35 * pan.T;
      rad = k * pan.emiss * vf(pan.floorR, HAND.z) * (p4(Tsurf + 273.15) - Tsk4);
      conv = HAND.h * Math.max(0, Tamb + HAND.plume * (Tsurf - Tamb) - HAND.Tskin);
      source = { Tbar: Tlocal, Tfire: 0 };
    }
    const q = Math.max(1, rad + conv); // W/m²
    const seconds = clamp(HAND.stoll * Math.pow(q / 1000, -HAND.exp), 0.4, 60);
    const word = seconds < 2.5 ? 'searing' : seconds < 4.5 ? 'very hot' : seconds < 6.5 ? 'hot' : seconds < 9 ? 'medium' : seconds < 16 ? 'moderate' : 'low';
    return { seconds, word, flux: q, radiant: rad, convective: conv, ...source };
  }
  /** Hold a hand over it and count, out loud, in the log. */
  function handTestAt(s, pos) {
    const h = handTest(s, pos);
    const where = s.grill ? 'the grate' : 'the pan';
    const note = h.seconds < 2.5 ? 'you cannot keep it there at all. Anything laid on that is being branded, not cooked.'
      : h.seconds < 4.5 ? 'a crust in a minute a side, and char in three if you forget it.'
      : h.seconds < 6.5 ? 'about right under a patty.'
      : h.seconds < 9 ? 'it will cook and it will brown, but slowly.'
      : h.seconds < 16 ? 'enough to cook something through; not enough to sear it.'
      : 'meat laid on that would sweat and go grey before anything browned.';
    const count = h.seconds >= 59 ? 'You could leave it there' : `${h.seconds < 10 ? h.seconds.toFixed(0) : Math.round(h.seconds)} second${Math.round(h.seconds) === 1 ? '' : 's'} before you have to pull it away`;
    logEvent(s, `Held a hand over ${where}. ${count}: ${h.word} — ${note}`
      + (s.grill ? ` (${(h.radiant / 1000).toFixed(1)} kW/m² of that is radiant off the bed.)` : ''), 'note');
    return h;
  }
  /**
   * The sizzle, in words, for a cook who is listening. Boiling water under the meat is a coarse,
   * loud, low crackle — millimetre bubbles collapsing by the hundred; once the underside has boiled
   * dry that stops dead and what is left is fat at 180 °C on hot metal, a quiet, much higher hiss
   * with the odd pop. Same pan, completely different sound, and it is the single most reliable cue
   * that the crust has started. Logged on transitions only, with a floor on how often it can speak.
   */
  const SOUND_GAP = 25; // s — the ear notices the change at once, but nobody narrates it every ten seconds
  function soundCue(s) {
    const d = s.diag, sc = s._snd || (s._snd = { mode: '', t: -99 });
    const on = s.patties.some((p) => p.where === 'pan');
    // hysteresis, or a patty that is half dry would flip the description back and forth
    const mode = !on ? 'off'
      : d.boilNoise > (sc.mode === 'crackle' ? 0.12 : 0.28) ? 'crackle'
      : d.hiss > (sc.mode === 'hiss' ? 0.06 : 0.16) ? 'hiss' : 'quiet';
    if (mode === sc.mode || s.t - sc.t < SOUND_GAP) return;
    const was = sc.mode; sc.mode = mode; sc.t = s.t;
    if (mode === 'off' || !was) return;
    if (mode === 'crackle') logEvent(s, 'The sizzle is loud and rough — water boiling out of the face against the metal. Nothing browns until that stops.', 'note');
    else if (mode === 'hiss') logEvent(s, 'The sizzle has dropped to a hiss — the underside is dry. It is frying in fat now instead of boiling in juice, and that is where the crust comes from.', 'note');
    else if (s.pan.Tcenter < 140) logEvent(s, 'Almost no sound off it at all. The metal is not hot enough to boil anything out of the meat, which means it is stewing, not searing.', 'note');
    else logEvent(s, 'It has gone quiet under there — nothing boiling, nothing frying.', 'note');
  }

  // ---------------------------------------------------------------- physics
  function waterHolding(p, c) {
    // p.whc0 carries the salt and working terms, which are fixed when the patty is formed
    return clamp(p.whc0 - 0.06 * p.dM[c] - 0.06 * p.dC[c] - 0.28 * p.dA[c], 0.3, 1.02);
  }

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
    const inOil = !!bc.top.oil;
    if (inOil) { ch.overhang = 1; ch.contact = 1; ch.melt = clamp(ch.melt + 0.5 * dt, 0, 1); }
    ch.submerged = inOil;
    const sk = ch.skirt || (ch.skirt = { T: ch.T, water: CHEESE_WATER, melt: 0, brown: 0, char: 0, dry: 0, charRate: 0, mass: 0 });
    const massS = ch.mass * ch.overhang * ch.contact; sk.mass = massS;
    if (massS < 1e-5) { sk.T += (ch.T - sk.T) * Math.min(1, dt / 2); sk.charRate = 0; return; }
    const areaS = CHEESE_SIDE * CHEESE_SIDE * ch.overhang * ch.contact;
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
    const hPan = (onPan ? 250 : bc.bottom.h) * A, gc = 300 * A;
    const flux = p.sc.cheeseFlux; // meat → slice → slice → air
    flux[0] = hPan * (bc.bottom.T - cu[0].T);
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
   * Advance the patty by dt (s). bc.bottom: {type:'pan', Tat(r) or TatR[] per ring, T, Tedge, oil,
   * hcMul, release} | {type:'air', h, T} | {type:'grill', ...}; bc.top: {h, T, RH, oil?};
   * bc.side: {T, oilDepth, oilT, rad?}.
   *
   * Hot path: this runs 40 times a second for every patty in the pan, over Nz·Nr cells. Every
   * temporary it needs lives in p.sc (see pattyScratch) instead of being allocated per call, the
   * passes that only need one cell's new temperature are fused into a single sweep, and anything
   * that is constant across a sweep is computed before it.
   */
  function stepPatty(s, p, dt, bc) {
    const Nz = p.Nz, Nr = p.Nr, A = p.A, R = p.D / 2, dz = p.h / Nz, dr = R / Nr;
    const T = p.T, n = Nz * Nr, aj = p.aj, sc = p.sc || (p.sc = pattyScratch(Nz, Nr));
    const w = p.w, w0c = p.w0c, fs = p.fs, fl = p.fl, fr = p.fr, prot = p.p, dM = p.dM, dC = p.dC, dA = p.dA, dG = p.dG;
    const Cn = sc.Cn, Kn = sc.Kn, Q = sc.Q, Aj = sc.Aj, X = sc.X, fmv = sc.fmv;
    const Tpk = p.Tpk, poolB = p.poolB, poolT = p.poolT;
    const topRow = (Nz - 1) * Nr;
    for (let j = 0; j < Nr; j++) Aj[j] = A * aj[j]; // ring areas — recomputed because the patty shrinks
    Q.fill(0);

    // ---- heat capacity and conductivity of every cell from its composition (one pass; this is
    // what cellHeatCap/cellK used to do per cell, with the per-call overhead removed)
    const kWork = 1 - 0.10 * (1 - p.work); // a loosely packed grind conducts a little worse
    for (let c = 0; c < n; c++) {
      const wc = w[c], fc = fs[c] + fl[c] + fr[c], pc = prot[c], Tc = T[c];
      let cp = wc * C.cpW + fc * C.cpF + pc * C.cpP;
      if (Tc > -C.fusionSpread && Tc <= 0) cp += (wc * C.Lfus) / C.fusionSpread; // apparent cp through fusion
      Cn[c] = cp;
      const ice = Tc >= 0 ? 0 : Tc <= -C.fusionSpread ? 1 : -Tc / C.fusionSpread;
      const vw = wc * IRHO_W, vf = fc * IRHO_F, vp = pc * IRHO_P, vt = vw + vf + vp + 1e-12;
      const wr = wc / w0c[c], dryness = wr >= 1 ? 0 : 1 - wr;
      // volume-weighted mixture conductivity; a dried-out cell (i.e. the crust) insulates
      Kn[c] = ((vw * (C.kW + (C.kIce - C.kW) * ice) + vf * C.kF + vp * C.kP) / vt) * kWork * (1 - 0.40 * dryness);
    }
    for (let j = 0; j < Nr; j++) { Cn[j] += poolB[j] * C.cpW; Cn[topRow + j] += poolT[j] * C.cpW + p.fatTop * aj[j] * C.cpF; }

    // ---- conduction: vertical within each ring, radial within each layer
    const radA = 2 * Math.PI * dz, invDz = 1 / dz; // a radial face is 2π·r·dz wide and the ring centres are dr apart
    for (let k = 0; k < Nz; k++) {
      const row = k * Nr, up = k < Nz - 1;
      for (let j = 0; j < Nr; j++) {
        const c = row + j, Kc = Kn[c], Tc = T[c];
        if (up) {
          const d = c + Nr, Kd = Kn[d], kI = (2 * Kc * Kd) / (Kc + Kd + 1e-9);
          const q = kI * Aj[j] * invDz * (T[d] - Tc); Q[c] += q; Q[d] -= q;
        }
        if (j < Nr - 1) {
          const d = c + 1, Kd = Kn[d], kI = (2 * Kc * Kd) / (Kc + Kd + 1e-9);
          const q = kI * radA * (j + 1) * (T[d] - Tc); Q[c] += q; Q[d] -= q;
        }
      }
    }

    // ---- bottom boundary, per ring
    const qBotR = sc.qBotR, TpanR = sc.TpanR, hcR = sc.hcR;
    let qBot = 0, qPan = 0, hc = 0;
    let TbotMean = 0; for (let j = 0; j < Nr; j++) TbotMean += T[j] * aj[j];
    const bb = bc.bottom, btype = bb.type;
    if (p.cheeseUnder.length) {
      const r = stepCheeseUnder(p, dt, bc, TbotMean);
      for (let j = 0; j < Nr; j++) { qBotR[j] = r.qMeat * aj[j]; Q[j] += qBotR[j]; TpanR[j] = bb.T; }
      qBot = r.qMeat; qPan = r.qPan; hc = r.hc;
    } else if (btype === 'pan' || btype === 'grill') {
      const oilFilm = clamp((bb.oil || 0) / 0.003, 0, 1);
      const fd = p.faceDown, grill = btype === 'grill';
      // the metal under each of our rings: step() has usually worked it out already (the rings sit
      // at different radii on the pan), otherwise ask the boundary for it
      const TatR = bb.TatR;
      if (TatR) { for (let j = 0; j < Nr; j++) TpanR[j] = TatR[j]; }
      else if (bb.Tat) { for (let j = 0; j < Nr; j++) TpanR[j] = bb.Tat((j + 0.5) * dr); }
      else { for (let j = 0; j < Nr; j++) TpanR[j] = bb.T; }
      const press = p.pressT > 0 ? 1.4 : 1, liftR = 0.65 * R;
      // a spatula worked under the face holds most of it off the metal for the second that takes
      const blade = p.scrapeT > 0 ? SCRAPE_LIFT : 1;
      const hcWet = C.hContactBase * bb.hcMul * (1 + 0.5 * oilFilm); // metal-to-meat conductance before the crust dries
      const barFrac = grill ? bb.barFrac : 0, openFrac = 1 - barFrac;
      const radBar = grill ? 0.9 * C.sigma * bb.view : 0, Tfire4 = grill ? p4(bb.Tfire + 273.15) : 0;
      for (let j = 0; j < Nr; j++) {
        const Tj = T[j], rc = (j + 0.5) * dr;
        // doming lifts the centre off the metal; pressing flattens it back on
        const lift = p.dome * clamp(1 - rc / liftR, 0, 1);
        const contact = clamp(1 - lift, 0.05, 1) * press * blade;
        const boiling = poolB[j] > 1e-7 || (Tj > 98 && w[j] > 0.2 * w0c[j]);
        const dry0 = 1 - clamp(w[j] / w0c[j], 0, 1);
        const crust = 1 - 0.35 * smooth(0.5, 1, dry0) - 0.15 * clamp(fd.brownR[j] / 4, 0, 1) - 0.3 * clamp(fd.charR[j], 0, 1);
        let q;
        if (grill) {
          // grate bars: line contact over a fraction of the area; the rest sees the fire
          const hcBar = 200 * crust * contact;
          const qBar = barFrac * hcBar * (bb.Tbar - Tj);
          const qRad = openFrac * (radBar * (Tfire4 - p4(Tj + 273.15)) + 25 * (bb.Tair - Tj));
          hcR[j] = barFrac * hcBar + openFrac * 25; q = (qBar + qRad) * Aj[j];
        } else {
          hcR[j] = hcWet * (boiling ? 1.25 : 1) * crust * contact;
          q = hcR[j] * Aj[j] * (TpanR[j] - Tj);
        }
        qBotR[j] = q; Q[j] += q; qBot += q; hc += hcR[j] * aj[j];
      }
      qPan = qBot;
    } else {
      for (let j = 0; j < Nr; j++) { const q = bb.h * Aj[j] * (bb.T - T[j]); qBotR[j] = q; Q[j] += q; qBot += q; TpanR[j] = bb.T; }
      qPan = qBot;
    }

    // ---- top boundary
    const bt = bc.top;
    let hTop = bt.h, TairTop = bt.T, qTop = 0;
    let TtopMean = 0; for (let j = 0; j < Nr; j++) TtopMean += T[topRow + j] * aj[j];
    if (p.cheeses.length) {
      const cs = p.cheeses, m = cs.length, gc = 300 * A;
      const flux = sc.cheeseFluxTop;
      flux[0] = gc * (1 + cs[0].melt) * (TtopMean - cs[0].T);
      for (let k = 1; k < m; k++) flux[k] = gc * (1 + Math.min(cs[k - 1].melt, cs[k].melt)) * (cs[k - 1].T - cs[k].T);
      flux[m] = hTop * A * (TairTop - cs[m - 1].T);
      for (let k = 0; k < m; k++) {
        const ch = cs[k], Cc = ch.mass * 2500;
        ch.T += ((flux[k] - (k < m - 1 ? flux[k + 1] : -flux[m])) * dt) / Cc;
        ch.melt = clamp(ch.melt + 0.08 * sig(ch.T, 52, 5) * dt, 0, 1);
        stepCheeseSkirt(p, ch, k, dt, bc);
      }
      for (let j = 0; j < Nr; j++) Q[topRow + j] -= flux[0] * aj[j];
    } else if (bt.rad) {
      const radK = 0.9 * C.sigma * bt.radView, radT4 = p4(bt.radT + 273.15);
      for (let j = 0; j < Nr; j++) {
        const c = topRow + j;
        const q = hTop * Aj[j] * (TairTop - T[c]) + Aj[j] * radK * (radT4 - p4(T[c] + 273.15));
        Q[c] += q; qTop += q;
      }
    } else {
      for (let j = 0; j < Nr; j++) {
        const c = topRow + j, q = hTop * Aj[j] * (TairTop - T[c]);
        Q[c] += q; qTop += q;
      }
    }
    if (s.baste > 0) { const q = 150 * A * ((bb.T || 150) - 40 - TtopMean); for (let j = 0; j < Nr; j++) Q[topRow + j] += Math.max(0, q) * aj[j]; }

    // ---- edge boundary (outer ring of every layer)
    const bs = bc.side, per = 2 * Math.PI * R, perDz = per * dz;
    const sideH = bs.h || C.hAirSide, sideRadK = bs.rad ? perDz * 0.9 * C.sigma * bs.radView : 0, sideRadT4 = bs.rad ? p4(bs.radT + 273.15) : 0;
    let qSide = 0;
    for (let k = 0; k < Nz; k++) {
      const c = k * Nr + Nr - 1, z = (k + 0.5) * dz;
      const inOil = bs.oilDepth > z;
      let q;
      if (inOil) q = C.hOil * perDz * (bs.oilT - T[c]);
      else {
        q = sideH * perDz * (bs.T - T[c]);
        if (bs.rad) q += sideRadK * (sideRadT4 - p4(T[c] + 273.15));
      }
      Q[c] += q; qSide += q;
    }

    // ---- top evaporation (Magnus): from pooled juice first, then tissue, per ring
    let evapTop = 0, lostEvap = 0;
    if (!p.cheeses.length && bt.RH < 0.99) {
      const rhoAir = bt.RH * rhoVapSat(bt.T), Tfloor = bt.T - 8, hMdt = C.hMass * dt;
      for (let j = 0; j < Nr; j++) {
        const c = topRow + j, Ts = T[c];
        const aw = poolT[j] > 1e-8 ? 1 : 1 - Math.exp(-8 * (w[c] / (prot[c] + 1e-9)));
        const drive = Math.max(0, aw * rhoVapSat(Ts) - rhoAir);
        let m = hMdt * Aj[j] * drive;
        const maxByEnergy = Math.max(0, (Cn[c] * (Ts - Tfloor)) / C.Lvap);
        m = Math.min(m, maxByEnergy, poolT[j] + w[c]);
        const fromPool = Math.min(m, poolT[j]); poolT[j] -= fromPool; w[c] -= (m - fromPool);
        Q[c] -= (m * C.Lvap) / dt; evapTop += m / dt; lostEvap += m;
      }
    }

    // ---- one sweep over the grid: integrate the temperature with the boiling clamp, then
    // everything that only needs that cell's new temperature — denaturation, the moisture ratio
    // the capillary diffusion below works from, and fat melting/release/drainage speed. (These
    // were five separate passes; fusing them keeps the cell's data in cache and reads T once.)
    let boil = 0, boilBottom = 0, Tmin = Infinity;
    const fatDz = (C.vFat * dt) / dz;
    for (let k = 0; k < Nz; k++) {
      const row = k * Nr, atBot = k === 0, atTop = k === Nz - 1;
      for (let j = 0; j < Nr; j++) {
        const c = row + j;
        let Tn = T[c] + (Q[c] * dt) / Cn[c];
        const water = w[c] + (atBot ? poolB[j] : 0) + (atTop ? poolT[j] : 0);
        if (Tn > C.Tboil && water > 1e-10) {
          const excess = Cn[c] * (Tn - C.Tboil);
          const m = Math.min(water, excess / C.Lvap);
          let rem = m;
          if (atBot) { const a = Math.min(rem, poolB[j]); poolB[j] -= a; rem -= a; }
          if (atTop) { const a = Math.min(rem, poolT[j]); poolT[j] -= a; rem -= a; }
          w[c] -= rem;
          Tn = C.Tboil + (excess - m * C.Lvap) / Cn[c];
          boil += m; if (k <= 1) boilBottom += m; lostEvap += m;
        }
        T[c] = Tn;
        if (Tn < Tmin) Tmin = Tn;
        X[c] = w[c] / (prot[c] + 1e-9);
        // Denaturation kinetics (irreversible): myosin ~52, collagen ~61, actin ~68, myoglobin
        // ~64 °C. This is sig(T, T0, width) written out — the exponentials here are the single
        // biggest cost in the whole model, so neither the call nor sig's second division is paid
        // for, and the myoglobin and fat-melting sigmoids ride on the two above them (K_*).
        const E25 = Math.exp((52 - Tn) / 2.5), E3 = Math.exp((61 - Tn) / 3), E15 = Math.exp((68 - Tn) / 1.5);
        dM[c] += (0.25 * dt * (1 - dM[c])) / (1 + E25);
        dC[c] += (0.12 * dt * (1 - dC[c])) / (1 + E3);
        dA[c] += (0.10 * dt * (1 - dA[c])) / (1 + E15);
        dG[c] += (0.06 * dt * (1 - dG[c])) / (1 + E15 * K_MYOGLOBIN);
        if (Tn > Tpk[c]) Tpk[c] = Tn;
        // fat: melts around 42 °C, then leaks out of ruptured cells; both terms are exactly zero
        // when there is nothing left to melt or nothing melted yet, so the rate is not evaluated
        if (fs[c] > 0) { const r = (0.06 * dt) / (1 + E3 * K_FATMELT); const melt = fs[c] * (r < 1 ? r : 1); fs[c] -= melt; fl[c] += melt; }
        if (fl[c] > 0) { const kRel = (0.0035 * dt * (1 + (Tn > 66 ? Tn - 66 : 0) / 40)) / (1 + Math.sqrt(E3 * K_FATREL)); const rel = fl[c] * (kRel < 1 ? kRel : 1); fl[c] -= rel; fr[c] += rel; }
        const visc = clamp((Tn - 38) / 50, 0.05, 1.6); // free fat runs faster the hotter (thinner) it is
        fmv[c] = Math.min(1, fatDz * visc);
      }
    }
    p.lostWaterEvap += lostEvap;
    p.steamRate = boil / dt + evapTop; p.boilBottom = boilBottom / dt; p.evapTop = evapTop;
    p.Tmin = Tmin; // the stability bound below needs to know whether there is still ice in here

    // ---- capillary moisture diffusion (vertical and radial), on the X computed above
    {
      const rhoDry = 420;
      const capZ = (C.Dw * rhoDry * dt) / dz, capR = C.Dw * rhoDry * radA * dt;
      for (let k = 0; k < Nz; k++) {
        const row = k * Nr, up = k < Nz - 1;
        for (let j = 0; j < Nr; j++) {
          const c = row + j;
          // frozen tissue barely wicks at all, hence the 0.05 factor below 0 °C
          if (up) {
            const d = c + Nr, dry = T[c] > 0 && T[d] > 0 ? 1 : 0.05;
            let f = capZ * dry * Aj[j] * (X[d] - X[c]);
            const lo = -w[c] * 0.5, hi = w[d] * 0.5; f = f < lo ? lo : f > hi ? hi : f;
            w[c] += f; w[d] -= f;
          }
          if (j < Nr - 1) {
            const d = c + 1, dry = T[c] > 0 && T[d] > 0 ? 1 : 0.05;
            let f = capR * dry * (j + 1) * (X[d] - X[c]);
            const lo = -w[c] * 0.5, hi = w[d] * 0.5; f = f < lo ? lo : f > hi ? hi : f;
            w[c] += f; w[d] -= f;
          }
        }
      }
    }
    // ---- juice expulsion: free water moves toward the nearest face
    const fz = Math.min(1, (C.vJuice * dt) / dz), frr = Math.min(1, (C.vJuice * dt) / dr);
    let toSide = 0;
    const flux = sc.flux, dir = sc.dir; // 0 down, 1 up, 2 out
    const whc0 = p.whc0;
    for (let k = 0; k < Nz; k++) {
      const row = k * Nr, dB = (k + 0.5) * dz, dT = (Nz - k - 0.5) * dz, dMin = 0.6 * Math.min(dB, dT), down = dB <= dT;
      for (let j = 0; j < Nr; j++) {
        const c = row + j;
        // water-holding capacity collapses as the proteins denature; whatever the matrix can no
        // longer hold is free juice (see waterHolding, inlined here for the whole grid)
        const whcRaw = whc0 - 0.06 * dM[c] - 0.06 * dC[c] - 0.28 * dA[c];
        const free = w[c] - (whcRaw < 0.3 ? 0.3 : whcRaw > 1.02 ? 1.02 : whcRaw) * w0c[c];
        if (free <= 0) { flux[c] = 0; continue; }
        // juice mostly follows the fibre grain toward a flat face; only the last couple of
        // millimetres at the rim weep out of the side
        if (R - (j + 0.5) * dr < dMin) { dir[c] = 2; flux[c] = free * frr; } else if (down) { dir[c] = 0; flux[c] = free * fz; } else { dir[c] = 1; flux[c] = free * fz; }
      }
    }
    // a knife cut is a drain: PEEK.drain of everything the matrix lets go of from now on runs out
    // of the open fibre ends at the cut plane instead of pooling on a face and going back in
    const cutF = p.slits ? Math.min(0.5, PEEK.drain * p.slits) : 0; // a second cut opens a second drain
    let cutOut = 0;
    for (let k = 0; k < Nz; k++) for (let j = 0; j < Nr; j++) {
      const c = k * Nr + j, f0 = flux[c]; if (f0 <= 0) continue;
      w[c] -= f0;
      let f = f0;
      if (cutF) { const g = f0 * cutF; cutOut += g; f -= g; }
      if (dir[c] === 2) { if (j === Nr - 1) toSide += f; else w[c + 1] += f; }
      else if (dir[c] === 0) { if (k === 0) poolB[j] += f; else w[c - Nr] += f; }
      else { if (k === Nz - 1) poolT[j] += f; else w[c + Nr] += f; }
    }
    if (cutOut > 0) { toSide += cutOut; p.lostWaterCut += cutOut; }
    // top pool: beads run off the edge (faster when domed)
    let poolTop = 0, poolBottom = 0;
    const runF = (0.04 + 0.2 * p.dome) * dt;
    for (let j = 0; j < Nr; j++) { const run = poolT[j] * runF; poolT[j] -= run; toSide += run; poolTop += poolT[j]; poolBottom += poolB[j]; }
    p.poolTop = poolTop; p.poolBottom = poolBottom;
    const juiceSide = toSide; p.lostWaterDrip += juiceSide;

    // ---- fat drains down each column; the outer ring also leaks out the side
    let fatDrip = 0, fatSide = 0;
    for (let k = Nz - 1; k >= 0; k--) for (let j = 0; j < Nr; j++) {
      const c = k * Nr + j, f = fr[c] * fmv[c]; if (f <= 0) continue;
      fr[c] -= f;
      const side = j === Nr - 1 ? f * 0.35 : 0; fatSide += side;
      if (k === 0) fatDrip += f - side; else fr[c - Nr] += f - side;
    }
    { let wick = 0; for (let j = 0; j < Nr; j++) { const c = topRow + j; const wf = fr[c] * 0.02 * dt; fr[c] -= wf; wick += wf; } p.fatTop += wick; }
    const fatTopRun = p.fatTop * 0.05 * dt; p.fatTop -= fatTopRun; fatSide += fatTopRun;
    p.lostFat += fatDrip + fatSide;

    // ---- surface chemistry per ring on the face in contact with the heat
    const fd = p.faceDown, TsLim = sc.TsLim;
    const grillBot = btype === 'grill', panBot = btype === 'pan';
    const cheeseCap = p.cheeseUnder.length ? p.cheeseUnder[p.cheeseUnder.length - 1].T : Infinity;
    let surfT = 0, dryMean = 0, fdBrown = 0, fdChar = 0, charRate = 0, maxTs = fd.maxT;
    for (let j = 0; j < Nr; j++) {
      const c = j;
      const Traw = T[c] + (Math.max(0, qBotR[j]) / Aj[j]) * (dz / 2) / Math.max(Kn[c], 0.05); // extrapolated true surface temperature
      let Ts = Traw;
      if (w[c] > 0.25 * w0c[c] || poolB[j] > 1e-8) Ts = Math.min(Ts, C.Tboil + 2);
      // a pan surface cannot exceed the pan; over coals the crust settles where the radiant input
      // balances re-radiation and conduction inward — well below the bed, but hotter than a pan
      const Tlim = panBot ? TpanR[j] : grillBot ? bb.Tsurf : Infinity;
      Ts = Math.min(Ts, Tlim); TsLim[j] = Tlim;
      if (cheeseCap < Ts) Ts = cheeseCap;
      surfT += Ts * aj[j];
      if (Ts > maxTs) maxTs = Ts;
      const dryness = 1 - clamp(w[c] / w0c[c], 0, 1); dryMean += dryness * aj[j];
      const fAw = 0.12 + 0.88 * smooth(0.25, 0.85, dryness);
      const invRT = 1 / (C.R * (Ts + 273.15)); // both rates are read at the same surface temperature
      fd.brownR[j] += C.Am * Math.exp(-C.EaM * invRT) * fAw * Math.max(0, 1 - fd.brownR[j] / C.Bmax) * dt;
      const charAw = 0.3 + 0.7 * smooth(0.6, 1, dryness);
      const rC = C.Ac * Math.exp(-C.EaC * invRT) * charAw * Math.max(0, 1 - fd.charR[j] / C.Cmax);
      fd.charR[j] += rC * dt;
      if (grillBot) {
        // the bars press hotter lines into the face: a separate, faster browning track
        const Tb = Math.min(bb.Tbar, bb.Tsurf + 60, Traw + 40);
        const invRTb = 1 / (C.R * (Tb + 273.15));
        fd.marks = (fd.marks || 0) + (C.Am * Math.exp(-C.EaM * invRTb) * fAw * Math.max(0, 1 - (fd.marks || 0) / C.Bmax) * dt) * aj[j];
        fd.marksChar = (fd.marksChar || 0) + C.Ac * Math.exp(-C.EaC * invRTb) * charAw * Math.max(0, 1 - (fd.marksChar || 0) / C.Cmax) * dt * aj[j];
      }
      // how fast the crust is burning right now, for the smoke: nothing burns where nothing is
      // charred yet, and then the rate is read at the metal's temperature
      const cf = clamp(fd.charR[j] / 0.3, 0, 1);
      if (cf > 0) charRate += arrh(C.Ac, C.EaC, Math.min(TpanR[j], TsLim[j])) * aj[j] * cf;
      fdBrown += fd.brownR[j] * aj[j]; fdChar += fd.charR[j] * aj[j];
    }
    fd.brown = fdBrown; fd.char = fdChar; fd.maxT = maxTs;
    p.surfT = surfT;
    fd.charRate = charRate;
    fd.crisp = clamp(fd.crisp + (dryMean > 0.6 ? 0.02 : -0.01) * dt, 0, 1);
    if (fd.stuck && (fd.brown >= 0.5 * (bb.release || 1) + 0.15 || dryMean > 0.6)) fd.stuck = false;
    // top face: submerged in hot fat or under a broiling lid it browns like the bottom
    const fu = p.faceUp;
    if ((bt.oil || bt.rad) && !p.cheeses.length) {
      const TsCap = bt.oil ? bt.T : bt.radT;
      for (let j = 0; j < Nr; j++) {
        const c = topRow + j;
        let TsT = T[c] + (Math.max(0, qTop * aj[j]) / Aj[j]) * (dz / 2) / Math.max(Kn[c], 0.05);
        if (w[c] > 0.25 * w0c[c] || poolT[j] > 1e-8) TsT = Math.min(TsT, C.Tboil + 2);
        TsT = Math.min(TsT, TsCap);
        if (TsT > fu.maxT) fu.maxT = TsT;
        const dryT = 1 - clamp(w[c] / w0c[c], 0, 1);
        const fAwT = 0.12 + 0.88 * smooth(0.25, 0.85, dryT);
        const invRT = 1 / (C.R * (TsT + 273.15));
        fu.brownR[j] += C.Am * Math.exp(-C.EaM * invRT) * fAwT * Math.max(0, 1 - fu.brownR[j] / C.Bmax) * dt;
        fu.charR[j] += C.Ac * Math.exp(-C.EaC * invRT) * (0.3 + 0.7 * smooth(0.6, 1, dryT)) * Math.max(0, 1 - fu.charR[j] / C.Cmax) * dt;
      }
      faceMean(p, fu);
      fu.crisp = clamp(fu.crisp + 0.01 * dt, 0, 1);
    }
    if (bt.RH > 0.9) fu.crisp = clamp(fu.crisp - 0.03 * dt, 0, 1);
    if (s.baste > 0) { for (let j = 0; j < Nr; j++) fu.brownR[j] += 0.004 * dt; faceMean(p, fu); }
    // the edge: browns from radiant heat on a grill, barely at all in a pan
    if (bs.rad) {
      let Te = 0; for (let k = 0; k < Nz; k++) Te += T[k * Nr + Nr - 1] / Nz;
      const Tse = Math.min(bs.radT, Te + 30);
      p.faceSide.brown += arrh(C.Am, C.EaM, Tse) * 0.5 * Math.max(0, 1 - p.faceSide.brown / C.Bmax) * dt;
      p.faceSide.char += arrh(C.Ac, C.EaC, Tse) * 0.3 * Math.max(0, 1 - p.faceSide.char / C.Cmax) * dt;
    }

    // ---- geometry: shrinkage & doming. One sweep collects the two denaturation means, the mass,
    // and the inner/outer collagen contrast that drives the dome.
    const half = Math.max(1, Math.floor(Nz / 2));
    let sC = 0, sM = 0, massNow = 0, outer = 0, inner = 0, no = 0, ni = 0;
    for (let k = 0; k < Nz; k++) {
      const row = k * Nr, lower = k < half;
      for (let j = 0; j < Nr; j++) {
        const c = row + j, a = aj[j], dCc = dC[c];
        sC += dCc * a; sM += dM[c] * a;
        massNow += w[c] + fs[c] + fl[c] + fr[c] + prot[c];
        if (lower) { const rc = (j + 0.5) / Nr; if (rc > 0.7) { outer += dCc; no++; } else if (rc < 0.35) { inner += dCc; ni++; } }
      }
    }
    sC /= Nz; sM /= Nz; massNow += p.poolBottom + p.poolTop + p.fatTop;
    const lossFrac = 1 - massNow / p.massKg0;
    const shrink = 1 - 0.15 * sC - 0.04 * sM - 0.06 * lossFrac;
    p.D = p.D0 * clamp(shrink, 0.6, 1);
    p.A = (Math.PI * p.D * p.D) / 4;
    const Vnow = massNow / p.rho0 / (1 - 0.15 * lossFrac);
    p.h = Vnow / p.A;
    // doming: the outer ring's collagen (edge + bottom heated) contracts before the centre's and
    // pulls the rim down, lifting the middle; a dimple pre-empts it, pressing flattens it
    {
      outer /= Math.max(1, no); inner /= Math.max(1, ni);
      const thick = clamp(p.h0 / 0.016, 0.3, 1.4);
      const domeTarget = (p.dimple ? 0.15 : 1) * clamp(0.8 * outer + 1.2 * (outer - inner), 0, 1) * thick * (p.pressed ? 0.35 : 1);
      p.dome += (domeTarget - p.dome) * Math.min(1, dt / 6);
    }
    if (p.pressT > 0) p.pressT -= dt;
    if (p.pressTestT > 0) p.pressTestT = Math.max(0, p.pressTestT - dt); // the finger comes off again; the renderer draws it while it is on

    p.peakCenter = Math.max(p.peakCenter, centerT(p));
    const res = sc.res;
    res.qBot = qPan; res.hc = hc; res.boilBottom = boilBottom / dt; res.evapTop = evapTop;
    res.fatDrip = fatDrip / dt; res.fatSide = fatSide / dt; res.juiceSide = juiceSide / dt; res.Ts = surfT; res.qSide = qSide;
    return res;
  }

  /**
   * Explicit conduction is only stable for dt < dz²/(2α): sub-cycle when the layers get thin
   * (a smashed patty), and only then — for an ordinary 18–20 mm patty the bound is about half a
   * second, twenty times the timestep, so the sub-cycle is skipped outright.
   *
   * p.Tmin is the coldest cell as of the end of the last step. Only ice has the high diffusivity
   * (~1.3e-6 m²/s against 2.5e-7 for wet meat), and nothing in this model ever refreezes, so a
   * value one step old can only ever make the bound stricter than it needs to be — safe, and it
   * saves scanning the whole grid for sub-zero cells every step.
   */
  function stepPattyStable(s, p, dt, bc) {
    const dz = p.h / p.Nz;
    const alphaMax = p.Tmin < 0 ? 1.3e-6 : 2.5e-7;
    const dtMax = (0.4 * dz * dz) / alphaMax;
    if (dt <= dtMax) { p.subSteps = 1; return stepPatty(s, p, dt, bc); }
    const n = Math.max(1, Math.min(64, Math.ceil(dt / dtMax)));
    p.subSteps = n;
    if (n === 1) return stepPatty(s, p, dt, bc);
    const h = dt / n, Nr = p.Nr, acc = p.sc.acc, accR = acc.qBotR;
    acc.qBot = 0; acc.hc = 0; acc.boilBottom = 0; acc.evapTop = 0; acc.fatDrip = 0; acc.fatSide = 0; acc.juiceSide = 0; acc.Ts = 0; acc.qSide = 0;
    accR.fill(0);
    for (let k = 0; k < n; k++) {
      const r = stepPatty(s, p, h, bc);
      acc.qBot += r.qBot; acc.hc += r.hc; acc.boilBottom += r.boilBottom; acc.evapTop += r.evapTop;
      acc.fatDrip += r.fatDrip; acc.fatSide += r.fatSide; acc.juiceSide += r.juiceSide; acc.Ts += r.Ts; acc.qSide += r.qSide;
      for (let j = 0; j < Nr; j++) accR[j] += r.qBotR[j];
    }
    // the caller wants rates and temperatures, so the sub-steps are averaged, not summed
    acc.qBot /= n; acc.hc /= n; acc.boilBottom /= n; acc.evapTop /= n;
    acc.fatDrip /= n; acc.fatSide /= n; acc.juiceSide /= n; acc.Ts /= n; acc.qSide /= n;
    for (let j = 0; j < Nr; j++) accR[j] /= n;
    return acc;
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
  /**
   * The bars' two-zone temperature, and what the bed looks like averaged over the whole grate.
   *
   * The grate is solved as rings — that is where its heat capacity, its radial profile and
   * everything the meat draws out of it live — and rings cannot represent a fire that is hotter on
   * one side. So the missing axis is carried as a *departure* field with zero mean over the bed:
   * the rings still see the bed's average, the departure adds the asymmetry, and nothing is counted
   * twice. Each strip is a thin bar in balance with the fire under it, radiation in and out, hot gas
   * up through it and room air (or the dome) above; 4 mm of steel at the grate's 1.6 kg over 0.21 m²
   * of bed is ~13 kJ/(m²K), so a strip settles in a couple of minutes — which is how long a real
   * kettle takes to set two zones up. Conduction along the bars (50 W/mK through 4 mm of steel over
   * a 6 cm strip, ~60 W/(m²K)) pulls neighbours together on a ~100 s time constant, so the zones
   * blur at the boundary but survive.
   */
  function stepBed(s, dt) {
    const g = s.grill, pan = s.pan, Tamb = s.env.Tamb, N = BANK.N;
    const Tgas0 = Tamb + 0.5 * (g.Tfire - Tamb), src0 = p4(g.Tfire + 273.15);
    const zT = pan.zoneT, dT = pan.zoneDT, w = pan.zoneW;
    const Tup = s.lid ? g.Tdome : Tamb, Tup4 = p4(Tup + 273.15), hUp = s.lid ? 12 : 20;
    const emis = pan.emiss * C.sigma, radOut = emis * 0.5;
    const dx = (2 * pan.floorR) / N, kLat = (pan.k * pan.thick) / (dx * dx); // W/(m²K) of bar between neighbouring strips
    const Cbar = (pan.mass * pan.cp) / (Math.PI * pan.floorR * pan.floorR * pan.barFrac); // J/(m²K) of bar
    let mV = 0, mVT = 0, mG = 0, mT = 0, lo = Infinity, hi = -Infinity;
    for (let i = 0; i < N; i++) {
      const u = -1 + (2 * i + 1) / N, f = coalAt(g, u);
      const view = COAL.viewGrate * (f + BANK.view * (1 - f));
      const src4 = p4(Tamb + (g.Tfire - Tamb) * (f + BANK.src * (1 - f)) + 273.15);
      const Tgas = Tamb + (Tgas0 - Tamb) * (f + BANK.gas * (1 - f));
      const T = zT[i], Tk4 = p4(T + 273.15);
      const q = emis * view * (src4 - Tk4) + 25 * (Tgas - T) - hUp * (T - Tup) - radOut * (Tk4 - Tup4);
      const lat = kLat * ((i > 0 ? zT[i - 1] : T) + (i < N - 1 ? zT[i + 1] : T) - 2 * T); // insulated at the rim
      dT[i] = T + ((q + lat) * dt) / Cbar; // the new strip temperature, turned into a departure below
      mV += w[i] * view; mVT += w[i] * view * src4; mG += w[i] * Tgas;
    }
    for (let i = 0; i < N; i++) { const T = dT[i]; zT[i] = T; mT += w[i] * T; if (T < lo) lo = T; if (T > hi) hi = T; }
    for (let i = 0; i < N; i++) dT[i] = zT[i] - mT;
    pan.zoned = hi - lo > 0.5; // half a degree across the bed is not a two-zone fire
    g.mView = mV; g.mViewTs4 = mVT; g.mTgas = mG;
  }

  // ---------------------------------------------------------------- pan items (the toppings)
  /**
   * Everything that shares the pan (or the grate) with the patties: bun halves toasting cut side
   * down, a rasher of streaky bacon, a fried egg, a heap of sliced onions. They see exactly the
   * boundary conditions a patty sees — the metal under their own footprint, the fire and hot gas
   * over coals, the lid's air — but each is lumped into two or three nodes instead of a grid,
   * because none of them is thick enough for a profile through it to be worth solving: 2.5 mm of
   * bacon evens out in about ten seconds (√(αt) with α ≈ 1.5e-7 m²/s), an egg is a 3 mm film of
   * white with a yolk sitting in it, and a bun half only ever cooks in the few millimetres nearest
   * the metal. Every node carries its own water and boils at 100 °C with full latent heat, which is
   * what makes all four of them take the time they take.
   */
  const ITEMS = {
    bun: {
      kind: 'bun', label: 'Bun half', short: 'bun',
      massG: 30, D: 0.095, Dcov: 0.095,             // half of a 60 g, 9.5 cm soft burger bun
      water: 0.34, fat: 0.04,                        // soft white bun: ~34 % moisture, ~4 % fat, the rest starch and protein
      cpDry: 1700,                                   // J/(kg K) for the starch/protein solids; the water is carried separately
      rho: 250,                                      // kg/m³ — a soft crumb is mostly air
      hc: 170,                                       // W/(m²K) crumb on metal: only the cut tips touch (150–200 is the usual figure for bread on a griddle)
      faceMm: 1.5, bodyMm: 6,                        // the crust node, and how deep the heat gets in a couple of minutes (√(αt) with α ≈ 2.5e-7 m²/s)
      kWet: 0.15, kDry: 0.055,                       // W/(m K) crumb, wet and toasted dry
      wick: 0.04,                                    // 1/s: the crumb behind the crust keeps feeding the drying front, which is why toast takes a minute and not ten seconds
      maillard: 2.2,                                 // bread browns faster than meat at the same temperature: maltose and free amino acids are already in the dough
      soakMax: 0.004,                                // it will drink about 4 g of fat off the pan before it is saturated
    },
    bacon: {
      kind: 'bacon', label: 'Rasher of bacon', short: 'bacon',
      massG: 25, D: 0.115, Dcov: 0.115,              // a 20 cm × 3 cm strip goes into a pan as a horseshoe: it covers an 11 cm circle, and 45 cm² of it is against the metal
      water: 0.42, fat: 0.40,                        // streaky bacon: ~40 % fat, ~42 % water, the rest protein and cure
      cpDry: 2000, thickMm: 2.5, A: 0.0045,          // a 60 cm² strip, three quarters of which is ever really against the metal
      hc: 260,                                       // below the patty's 380: a rasher is corrugated and rides on its own rendered fat
      kMeat: 0.35,
      relMul: 2.5,                                   // the fat is in continuous bands, not locked in muscle cells: it runs out far faster than a patty's does
      shrinkMax: 0.25,                               // a rasher loses about a quarter of its length, most of it as the fat goes
    },
    egg: {
      kind: 'egg', label: 'Fried egg', short: 'egg',
      massG: 55, D: 0.115, Dcov: 0.115,              // a large egg out of the shell spreads to about 11 cm
      whiteFrac: 0.63, yolkFrac: 0.37,               // 35 g of white, 20 g of yolk
      whiteWater: 0.88, yolkWater: 0.50,
      cpWhite: 3700, cpYolk: 2700,
      A: 0.0095, yolkA: 0.00126,                     // contact area, and the yolk's own footprint (a 4 cm dome)
      hc: 320,                                       // a liquid wets the metal completely: better contact than meat
      botFrac: 0.60,                                 // of the white: the layer under and around the yolk that lies on the pan
      Uyolk: 160, UyolkFlipped: 300,                 // W/(m²K) pan-side white → yolk, through 3 mm of white and half a yolk; turned over, the yolk is a millimetre off the metal
      kWhite: 0.55, whiteMm: 3,
      laceFrac: 0.06, laceA: 0.18, hcLace: 600,      // the thin rim that runs out into the fat: 6 % of the white over 18 % of the footprint, and all but welded to the metal
    },
    onions: {
      kind: 'onions', label: 'Sliced onions', short: 'onions',
      massG: 80, D: 0.16, Dcov: 0.16,                // 80 g of sliced onion spread over about 16 cm
      water: 0.89, sugar: 0.056,                     // onion: 89 % water, ~5.6 % free sugars (glucose, fructose, sucrose)
      cpDry: 1500, A: 0.0100,                        // a heap only touches the metal in patches
      hc: 250,
      botFrac: 0.35,                                 // of a heap 4–5 mm deep, about a third is in the layer touching the metal; the rest sits on top of it
      kPile: 0.5, gSteam: 1.5,                       // W/(m K) through a pile of slices that is 89 % water, plus the W/K the steam carries up while the bottom boils
      wickMax: 8e-5,                                 // kg/s: juice only drains down through a heap of slices so fast. That flux, not how much water is left, is what decides whether the layer on the metal stays wet — and so whether the onions sweat for a quarter of an hour or scorch in three minutes.
    },
  };
  // Sugars pyrolyse at a lower temperature than a protein crust does: bread and onions go black
  // where meat would still only be dark. Fitted so a bun face on a 200 °C pan is golden in a minute
  // and black in three, and the layer of onion against a 260 °C pan burns a minute after it dries.
  const SUGAR_CHAR = { A: 5e6, Ea: 85e3 };
  const MEAT_CHAR = { A: C.Ac, Ea: C.EaC }; // bacon and egg are meat and protein: the patty's own pyrolysis pair


  /** One lumped node: dry mass `m` (solids and fat), water `w`, temperature `T`. */
  function node(m, w, T) { return { m, w, T }; }
  /**
   * Integrate a node by dt with `q` watts into it, clamped at the boiling point with full latent
   * heat — the same clamp every cell of a patty gets. `Tcap` is the hottest thing touching it: an
   * explicit lumped node whose dry mass is a gram or two (a bun's crust, the onion layer on the
   * metal once it has dried) would otherwise overshoot its own heat source on a long step and ring.
   * Returns the water boiled off, in kg.
   */
  function heatNode(n, q, dt, cpDry, Tcap) {
    const Ccap = n.m * cpDry + n.w * C.cpW + 1e-9;
    let Tn = n.T + (q * dt) / Ccap;
    let boiled = 0;
    if (Tn > C.Tboil && n.w > 1e-9) {
      const excess = Ccap * (Tn - C.Tboil);
      boiled = Math.min(n.w, excess / C.Lvap);
      n.w -= boiled;
      Tn = C.Tboil + (excess - boiled * C.Lvap) / Ccap;
    }
    if (Tcap != null && Tn > Tcap) Tn = Tcap;
    n.T = Tn;
    return boiled;
  }
  function nodeDry(n, w0) { return w0 > 1e-12 ? clamp(1 - n.w / w0, 0, 1) : 1; }

  /** Maillard and pyrolysis on one face of an item, read at its surface temperature. */
  function itemBrowning(face, Ts, dryness, dt, mul, char) {
    const fAw = 0.12 + 0.88 * smooth(0.25, 0.85, dryness);
    const invRT = 1 / (C.R * (Ts + 273.15));
    face.brown += C.Am * mul * Math.exp(-C.EaM * invRT) * fAw * Math.max(0, 1 - face.brown / C.Bmax) * dt;
    const rC = char.A * Math.exp(-char.Ea * invRT) * (0.3 + 0.7 * smooth(0.6, 1, dryness)) * Math.max(0, 1 - face.char / C.Cmax);
    face.char += rC * dt; face.charRate = rC;
  }
  function makeItemFace() { return { brown: 0, char: 0, charRate: 0, crisp: 0 }; }

  /** Build one item. Everything downstream reads `it.spec`, so a kind is an ITEMS entry plus a step. */
  function makeItem(kind, o) {
    o = o || {};
    const sp = ITEMS[kind]; if (!sp) return null;
    const m = (o.massG == null ? sp.massG : o.massG) / 1000;
    const T0 = o.tempC == null ? 6 : o.tempC; // out of the same fridge as the meat
    const it = {
      kind, spec: sp, id: o.id || 1, label: sp.label, where: 'pan', pos: { x: 0, y: 0 },
      D: sp.D, Dcov: sp.Dcov, A: sp.A || (Math.PI * sp.D * sp.D) / 4,
      m0: m, T0, rings: null, burger: null,
      faceDown: makeItemFace(), faceUp: makeItemFace(),
      flips: 0, cookTime: 0, timeDown: 0, restT: 0,
      lostWater: 0, lostFat: 0, lostDrip: 0, fatSoaked: 0, dFat: 0, dJuice: 0,
      steam: 0, sizzle: 0, smoke: 0, qBot: 0, Ts: T0, Tat: T0, stuck: true, torn: 0,
    };
    if (kind === 'bun') {
      const A = it.A;
      const mFace = A * (sp.faceMm / 1000) * sp.rho, mBody = A * (sp.bodyMm / 1000) * sp.rho;
      it.half = o.half || 'bottom';
      it.label = it.half === 'top' ? 'Top bun' : 'Bottom bun';
      // one node for each face and one for the crumb between them; the rest of the half is a foam
      // the pan never reaches, carried along only so the mass on the plate is right
      it.face = node(mFace * (1 - sp.water), mFace * sp.water, T0);
      it.up = node(mFace * (1 - sp.water), mFace * sp.water, T0);
      it.body = node(mBody * (1 - sp.water), mBody * sp.water, T0);
      it.w0f = it.face.w; it.w0u = it.up.w; it.w0b = it.body.w;
      it.mCold = Math.max(0, m - 2 * mFace - mBody);
      it.faceIsCut = true; // the cut face goes down first; the crown is already a baked crust
      it.cutFace = it.faceDown; // faceDown/faceUp swap on a flip; this keeps pointing at the cut side, which is the one that matters on the plate
    } else if (kind === 'bacon') {
      const fat = m * sp.fat, water = m * sp.water, prot = m - fat - water;
      it.A = sp.A;
      it.body = node(prot + fat, water, T0);
      it.w0 = water; it.fat0 = fat; it.prot = prot;
      it.fs = fat; it.fl = 0; it.fr = 0;      // solid → melted → released from the tissue, as in the patty
      it.curl = 0; it.shrink = 0; it.crisp = 0;
    } else if (kind === 'egg') {
      const mw = m * sp.whiteFrac, my = m * sp.yolkFrac;
      const mLace = mw * sp.laceFrac, mCore = mw - mLace;
      const mb = mCore * sp.botFrac, mt = mCore - mb;
      it.A = sp.A;
      it.wBot = node(mb * (1 - sp.whiteWater), mb * sp.whiteWater, T0);
      it.wTop = node(mt * (1 - sp.whiteWater), mt * sp.whiteWater, T0);
      it.yolk = node(my * (1 - sp.yolkWater), my * sp.yolkWater, T0);
      it.w0b = it.wBot.w; it.w0t = it.wTop.w;
      it.setBot = 0; it.setTop = 0; it.yolkSet = 0; it.flipped = false; it.secondSide = 0;
      it.lace = { m: mLace * (1 - sp.whiteWater), w: mLace * sp.whiteWater, w0: mLace * sp.whiteWater, T: T0, brown: 0, char: 0, charRate: 0, dry: 0, on: false };
      it.spread = 0.45;
    } else if (kind === 'onions') {
      const mb = m * sp.botFrac, mt = m - mb;
      it.A = sp.A;
      it.bot = node(mb * (1 - sp.water), mb * sp.water, T0);
      it.top = node(mt * (1 - sp.water), mt * sp.water, T0);
      it.w0 = m * sp.water; it.w0bot = it.bot.w;
      it.carm = 0; it.carmBot = 0; it.char = 0; it.charBot = 0; it.fond = 0; it.stirs = 0;
    }
    return it;
  }
  function itemMass(it) {
    if (it.kind === 'bun') return it.face.m + it.face.w + it.up.m + it.up.w + it.body.m + it.body.w + it.mCold + it.fatSoaked;
    if (it.kind === 'bacon') return it.body.m + it.body.w; // body.m is protein plus whatever fat has not drained out yet
    if (it.kind === 'egg') return it.wBot.m + it.wBot.w + it.wTop.m + it.wTop.w + it.yolk.m + it.yolk.w + it.lace.m + it.lace.w;
    if (it.kind === 'onions') return it.bot.m + it.bot.w + it.top.m + it.top.w;
    return 0;
  }
  /** The temperature the cook would feel first — the HUD's one number for an item. */
  function itemT(it) {
    if (it.kind === 'bun') return it.face.T;
    if (it.kind === 'bacon') return it.body.T;
    if (it.kind === 'egg') return it.yolk.T;
    if (it.kind === 'onions') return it.bot.T;
    return 0;
  }

  /**
   * Which pan rings something of radius `rad` at `pos` sits on, as interpolation weights summing to
   * one, sampled on an equal-area polar grid over its footprint. This is what panTat() does for a
   * single point, done once for a whole footprint: the metal an item draws its heat from — and
   * drags down, being cold and wet — is the metal actually underneath it. Nothing moves once it is
   * put down, so the weights are worked out once.
   */
  function footprintRings(pan, pos, rad) {
    const nr = 4, na = 8, out = [], w = 1 / (nr * na);
    for (let i = 0; i < nr; i++) {
      const rr = rad * Math.sqrt((i + 0.5) / nr);
      for (let a = 0; a < na; a++) {
        const ang = (a / na) * Math.PI * 2;
        const x = pos.x + rr * Math.cos(ang), y = pos.y + rr * Math.sin(ang);
        const q = clamp(hyp(x, y) / pan.dr - 0.5, 0, pan.Np - 1);
        const j0 = Math.floor(q);
        out.push({ j0: Math.min(j0, pan.Np - 1), t: j0 >= pan.Np - 1 ? 0 : q - j0, w });
      }
    }
    return out;
  }
  /**
   * Which pan rings each of a *patty's* own rings sits on, as weights over the pan's rings.
   *
   * A patty ring is a circle of radius rc around the patty's centre, so on a patty sitting d from
   * the middle of the pan the metal under that one ring runs all the way from |d−rc| to d+rc: half
   * of it can be over the burner's hot ring and half over the cold rim. Reading the pan at the
   * ring's mean radius misses that entirely, which is why this samples the circle and averages —
   * and why the heat the meat pulls out goes back into the rings it actually came from. At the
   * middle of the pan every sample lands on the same pan radius, so that case is one lookup and is
   * exactly the number it always was.
   *
   * Rebuilt when the patty moves or shrinks past a fifth of a millimetre (a tenth of a pan ring:
   * closer than the sampling itself resolves), not every step.
   */
  const PW_NA = 12; // samples around each of the patty's rings
  function pattyRingWeights(pan, p) {
    const Np = pan.Np, Nr = p.Nr, d = hyp(p.pos.x, p.pos.y), centred = d < 1e-6;
    if (p.panW && p.panWN === Np && (centred ? p.panWd === 0 && p.panWD === p.D : Math.abs(p.panWd - d) < 2e-4 && Math.abs(p.panWD - p.D) < 2e-4)) return p.panW;
    const W = p.panW && p.panW.length === Nr * Np ? p.panW.fill(0) : new Float64Array(Nr * Np);
    const lo = p.panWlo || (p.panWlo = new Int32Array(Nr)), hi = p.panWhi || (p.panWhi = new Int32Array(Nr));
    const dr = p.D / 2 / Nr;
    let row = 0;
    const add = (r, w) => {
      const x = clamp(r / pan.dr - 0.5, 0, Np - 1), j0 = Math.floor(x), t = x - j0;
      if (j0 >= Np - 1) W[row + Np - 1] += w; else { W[row + j0] += w * (1 - t); W[row + j0 + 1] += w * t; }
    };
    for (let j = 0; j < Nr; j++) {
      const rc = (j + 0.5) * dr; row = j * Np;
      if (centred) add(rc, 1);
      else for (let a = 0; a < PW_NA; a++) { const ang = (a / PW_NA) * Math.PI * 2; add(hyp(d + rc * Math.cos(ang), rc * Math.sin(ang)), 1 / PW_NA); }
      let l = 0; while (l < Np - 1 && W[row + l] === 0) l++;
      let h = Np - 1; while (h > l && W[row + h] === 0) h--;
      lo[j] = l; hi[j] = h;
    }
    p.panW = W; p.panWd = centred ? 0 : d; p.panWD = p.D; p.panWN = Np;
    return W;
  }
  function ringsT(pan, rings) {
    let T = 0;
    for (let i = 0; i < rings.length; i++) { const o = rings[i]; T += o.w * (o.t ? lerp(pan.Tr[o.j0], pan.Tr[o.j0 + 1], o.t) : pan.Tr[o.j0]); }
    return T;
  }
  /** Everything already on the pan or the grate, with the radius it covers. */
  function occupants(s) {
    const out = [];
    for (const p of s.patties) if (p.where === 'pan') out.push({ pos: p.pos, r: p.D / 2 });
    for (const it of s.items) if (it.where === 'pan') out.push({ pos: it.pos, r: it.Dcov / 2 });
    return out;
  }
  /**
   * Somewhere to put something of radius `rad` on a pan that already has things on it. The standard
   * patty layouts come first — so two patties still land in the classic pair and a bun goes beside
   * them rather than between them — then a polar search takes whatever has the most clearance left.
   */
  function freeSpot(s, rad) {
    const R = s.pan.floorR, taken = occupants(s), cand = [];
    for (let n = 1; n <= 4; n++) for (const c of pattySpots(n, R, rad)) cand.push(c);
    for (const f of [0.55, 1]) for (let a = 0; a < 8; a++) { const ang = (a / 8) * Math.PI * 2 + 0.4; const rr = f * Math.max(0, R - rad * 1.05); cand.push({ x: rr * Math.cos(ang), y: rr * Math.sin(ang) }); }
    let best = cand[0], bestGap = -Infinity;
    for (const c of cand) {
      if (hyp(c.x, c.y) + rad > R * 1.02) continue;
      let gap = Infinity;
      for (const q of taken) gap = Math.min(gap, hyp(c.x - q.pos.x, c.y - q.pos.y) - rad - q.r);
      if (gap > bestGap) { bestGap = gap; best = c; }
      if (bestGap > 0.004) break; // 4 mm of daylight around it is good enough
    }
    return { pos: best, gap: bestGap };
  }

  /** Put a topping in the pan. Buns go in as a pair of halves, cut side down. */
  function addItem(s, kind, opts) {
    if (!ITEMS[kind]) return null;
    const made = [];
    for (const extra of kind === 'bun' ? [{ half: 'bottom' }, { half: 'top' }] : [{}]) {
      const it = makeItem(kind, { ...(opts || {}), ...extra, id: s.items.length + 1 });
      const { pos, gap } = freeSpot(s, it.Dcov / 2);
      it.pos = pos; it.rings = footprintRings(s.pan, pos, it.D / 2);
      it.Tat = ringsT(s.pan, it.rings);
      s.items.push(it); made.push(it);
      if (gap < -0.005) logEvent(s, `No room: the ${it.label.toLowerCase()} is lying half on top of something else. Crowd a pan and nothing browns.`, 'warn');
    }
    selectItem(s, made[0]);
    const it = made[0], Tat = it.Tat.toFixed(0);
    if (kind === 'bun') logEvent(s, `Two bun halves in, cut side down (${(it.m0 * 2000).toFixed(0)} g). A bun face is dry starch on ${Tat} °C metal: it drinks the fat, goes golden in a minute and black in three.`, 'action');
    else if (kind === 'bacon') logEvent(s, `A rasher of streaky bacon (${(it.m0 * 1000).toFixed(0)} g, ${(ITEMS.bacon.fat * 100).toFixed(0)} % fat) on ${Tat} °C metal. The water has to go before the fat can render and the lean can crisp.`, 'action');
    else if (kind === 'egg') logEvent(s, `An egg cracked into the pan at ${Tat} °C. White sets at 62–65 °C, yolk thickens at 65 and sets at 70 — and sunny side up it only cooks from below.`, 'action');
    else if (kind === 'onions') logEvent(s, `${(it.m0 * 1000).toFixed(0)} g of sliced onion in. ${(it.m0 * ITEMS.onions.water * 1000).toFixed(0)} g of that is water; all of it has to boil off before one sugar caramelises, and boiling it off is what drags the pan down.`, 'action');
    if (s.grill && (kind === 'egg' || kind === 'onions')) logEvent(s, `${kind === 'egg' ? 'An egg' : 'Sliced onion'} on bare bars: most of it is going to run straight through onto the coals. That wants a pan.`, 'warn');
    return made;
  }
  // s.patty stays where it is: the HUD, the probe and the cutaway all follow the selected patty,
  // and s.item is only which topping the flip/remove buttons are pointed at.
  function selectItem(s, it) { s.item = it || null; }

  /** Flip a bun half or a rasher, turn an egg over, or stir the onions: one action, four meanings. */
  function flipItem(s, it) {
    it = it || s.item; if (!it || it.where !== 'pan') return { ok: false };
    const sp = it.spec;
    if (it.kind === 'onions') {
      // stirring is what a flip means for a heap: the layer scorching against the metal goes back
      // into the pile and cold, wet onion comes down to take its place
      const b = it.bot, t = it.top;
      const Cb = b.m * sp.cpDry + b.w * C.cpW, Ct = t.m * sp.cpDry + t.w * C.cpW;
      const Tmix = (b.T * Cb + t.T * Ct) / Math.max(Cb + Ct, 1e-9);
      const wAll = b.w + t.w, fb = b.m / Math.max(b.m + t.m, 1e-9);
      b.w = wAll * fb; t.w = wAll * (1 - fb);
      b.T = Tmix; t.T = Tmix;
      const wasBurnt = it.charBot;
      it.carmBot = it.carm; it.charBot = it.char; // the layer on the metal is fresh onion again
      it.stirs++; it.timeDown = 0; it.flips++;
      logEvent(s, `Stirred the onions (${it.stirs}). Fresh onion is against the metal now; ` + (wasBurnt > 0.15 ? 'the scorched layer is through the whole lot.' : 'nothing had scorched yet.'), wasBurnt > 0.15 ? 'warn' : 'action');
      return { ok: true, stir: true };
    }
    let torn = 0;
    if (it.kind === 'egg' && it.stuck) {
      // bare metal and no fat: the setting white welds itself down and tears
      const rel = s.pan.release * (s.pan.oil > 0.002 ? 0.25 : 1);
      if (it.setBot < 0.6 && rel > 0.3) {
        torn = clamp(0.2 * rel * (1 - it.setBot), 0.02, 0.25);
        const lost = (it.wBot.m + it.wBot.w) * torn;
        it.wBot.m *= 1 - torn; it.wBot.w *= 1 - torn;
        it.torn += torn; s.pan.fond += lost * 0.4; s.pan.meatBits += lost * 0.6;
        logEvent(s, `The egg is welded to the pan. ${(torn * 100).toFixed(0)} % of the white tore off and stayed there. Egg wants fat under it, or a pan that lets go.`, 'warn');
      }
    }
    const fd = it.faceDown; it.faceDown = it.faceUp; it.faceUp = fd;
    if (it.kind === 'bun') { const f = it.face; it.face = it.up; it.up = f; const w = it.w0f; it.w0f = it.w0u; it.w0u = w; it.faceIsCut = !it.faceIsCut; }
    if (it.kind === 'egg') { const b = it.wBot; it.wBot = it.wTop; it.wTop = b; const w = it.w0b; it.w0b = it.w0t; it.w0t = w; const st = it.setBot; it.setBot = it.setTop; it.setTop = st; it.flipped = !it.flipped; it.secondSide = 0; }
    it.flips++; it.timeDown = 0; it.stuck = true;
    const msg = {
      bun: `Turned the ${it.label.toLowerCase()} over: the ${it.faceIsCut ? 'cut face' : 'crown'} is on the metal now.` + (it.faceIsCut ? '' : ' The crown is already a baked crust — it has no sugars left to brown, it will just dry and scorch.'),
      bacon: `Turned the rasher (flip ${it.flips}). It will flatten and curl back the other way as this side dries.`,
      egg: it.flipped ? 'Egg over. The yolk is a millimetre of white off the metal now: seconds to over-easy, a minute to over-hard.' : 'Egg turned back the right way up.',
    }[it.kind];
    if (msg) logEvent(s, msg, 'action');
    return { ok: true, torn };
  }
  function removeItem(s, it) {
    it = it || s.item; if (!it || it.where !== 'pan') return false;
    if (it.kind === 'egg' && it.stuck && it.setBot < 0.5 && s.pan.release > 0.3 && s.pan.oil < 0.002) {
      const torn = 0.15; it.wBot.m *= 1 - torn; it.wBot.w *= 1 - torn; it.torn += torn; s.pan.fond += 0.001;
      logEvent(s, 'Scraped the egg up; a good part of the white stayed welded to the pan.', 'warn');
    }
    it.where = 'rest'; it.restT = 0; it.restPos = { x: it.pos.x, y: it.pos.y };
    logEvent(s, `${it.label} off the heat after ${fmtTime(it.cookTime)} — ${itemState(it).state}.`, 'action');
    return true;
  }
  /** The build step: this topping belongs on that burger. */
  function assignTopping(s, it, patty) { if (!it || !patty) return false; it.burger = patty.id; return true; }
  /** Whichever burger it came off the pan next to, when the cook has not said otherwise. */
  function nearestBurger(s, it) {
    let best = null, bestD = Infinity;
    const pos = it.restPos || it.pos;
    for (const p of s.patties) { const d = hyp(p.pos.x - pos.x, p.pos.y - pos.y); if (d < bestD) { bestD = d; best = p; } }
    return best;
  }
  /** The toppings built onto one burger, in the order they are stacked. */
  function toppingsOf(s, patty) {
    const order = { onions: 0, bacon: 1, egg: 2, bun: 3 };
    return s.items.filter((it) => it.burger === patty.id).sort((a, b) => order[a.kind] - order[b.kind]);
  }

  // ---- the four step functions; each gets the same boundary object a patty gets
  /** Heat into an item's underside from whatever it is sitting on, in W. */
  function itemQBottom(it, bc, hc, A, Tf) {
    const bb = bc.bottom;
    if (bb.type === 'grill') {
      const bar = bb.barFrac * hc * (bb.Tbar - Tf);
      const open = (1 - bb.barFrac) * (0.9 * C.sigma * bb.view * (p4(bb.Tfire + 273.15) - p4(Tf + 273.15)) + 25 * (bb.Tair - Tf));
      return (bar + open) * A;
    }
    if (bb.type === 'air') return bb.h * A * (bb.T - Tf);
    return hc * A * (bb.T - Tf);
  }
  /**
   * Heat-transfer coefficient onto an item's top face. Under a lid the air is saturated and every
   * surface below its temperature is a condenser: a milligram of steam a second gives back 2.3 kW
   * per kg/s of latent heat, which swamps the 30 W/(m²K) of the convection. That is why a lid over
   * a fried egg sets the top of it in a minute and nothing else will.
   */
  function topH(bt, T) { return bt.h + (bt.RH > 0.9 && bt.T > T ? 200 : 0); }
  /** The hottest thing an item's contact node is touching — what it may not overshoot. */
  function bottomCap(bc) { const bb = bc.bottom; return bb.type === 'grill' ? Math.max(bb.Tbar, bb.Tsurf) : bb.T; }
  /** A face's surface temperature: the node extrapolated out to the metal, capped by the metal. */
  function itemSurfT(Tnode, q, A, k, dzHalf, wet, cap) {
    let Ts = Tnode + (Math.max(0, q) / A) * (dzHalf / Math.max(k, 0.03));
    if (wet) Ts = Math.min(Ts, C.Tboil + 2);
    return Math.min(Ts, cap);
  }

  function stepBun(s, it, dt, bc) {
    const sp = it.spec, A = it.A, face = it.face, body = it.body, up = it.up;
    const onPan = bc.bottom.type === 'pan';
    const oilFilm = onPan ? clamp((bc.bottom.oil || 0) / 0.003, 0, 1) : 0;
    const dryF = nodeDry(face, it.w0f);
    // a wet crumb face makes better contact than a toasted one — the dry crust is a foam that only
    // touches at its tips — and the fat it has soaked up is what keeps the contact honest
    const hc = sp.hc * (1 + 0.6 * oilFilm) * (1 - 0.25 * dryF);
    const q = itemQBottom(it, bc, hc, A, face.T);
    const kf = lerp(sp.kWet, sp.kDry, dryF), ku = lerp(sp.kWet, sp.kDry, nodeDry(up, it.w0u));
    const Gd = A / ((sp.faceMm / 2000) / kf + (sp.bodyMm / 2000) / sp.kWet);   // down face → crumb
    const Gu = A / ((sp.faceMm / 2000) / ku + (sp.bodyMm / 2000) / sp.kWet);   // crumb → up face
    const qFB = Gd * (face.T - body.T), qBU = Gu * (body.T - up.T);
    const bt = bc.top;
    const qTop = topH(bt, up.T) * A * (bt.T - up.T) + (bt.rad ? A * 0.9 * C.sigma * bt.radView * (p4(bt.radT + 273.15) - p4(up.T + 273.15)) : 0);
    const cap = bottomCap(bc);
    const bF = heatNode(face, q - qFB, dt, sp.cpDry, cap);
    const bB = heatNode(body, qFB - qBU, dt, sp.cpDry, Math.max(cap, bt.T));
    const bU = heatNode(up, qBU + qTop, dt, sp.cpDry, Math.max(cap, bt.T));
    it.lostWater += bF + bB + bU; it.steam = (bF + bB + bU) / dt;
    // the crumb behind the crust keeps wicking water forward into the drying front. It is a small
    // flow — a few hundredths of a gram a second — but it is worth 80 W of latent load, which is
    // what holds a toasting face near 100 °C for the first half-minute instead of letting it run
    // straight up to the metal's temperature.
    {
      const ff = face.w / Math.max(face.m + face.w, 1e-9), fbdy = body.w / Math.max(body.m + body.w, 1e-9);
      if (fbdy > ff) { const wick = Math.min(body.w, sp.wick * (fbdy - ff) * (face.m + face.w) * dt); body.w -= wick; face.w += wick; }
    }
    // fat off the pan wicks straight into the crumb: that is what a griddled bun is
    if (onPan && s.pan.oil > 1e-5 && it.fatSoaked < sp.soakMax) {
      const take = Math.min(s.pan.oil, (sp.soakMax - it.fatSoaked) * 0.06 * dt * (0.3 + 0.7 * oilFilm));
      s.pan.oil -= take; it.fatSoaked += take;
    }
    const Ts = itemSurfT(face.T, q, A, kf, sp.faceMm / 2000, face.w > 0.25 * it.w0f, cap);
    it.Ts = Ts;
    // the crown is a baked crust already: its free sugars went in the oven, so it only scorches
    itemBrowning(it.faceDown, Ts, dryF, dt, it.faceIsCut ? sp.maillard : 0.5, SUGAR_CHAR);
    it.faceDown.crisp = clamp(it.faceDown.crisp + (dryF > 0.7 ? 0.03 : -0.01) * dt, 0, 1);
    it.qBot = q;
    it.sizzle = clamp((bF / dt) * 300, 0, 0.5);
    it.smoke = clamp(it.faceDown.charRate * 300 * (0.3 + it.faceDown.char), 0, 1.2);
  }

  function stepBacon(s, it, dt, bc) {
    const sp = it.spec, b = it.body;
    const oilFilm = bc.bottom.type === 'pan' ? clamp((bc.bottom.oil || 0) / 0.003, 0, 1) : 0;
    // a curling rasher lifts its ends off the metal, and that is most of why bacon cooks unevenly
    const contact = clamp(1 - 0.65 * Math.abs(it.curl), 0.30, 1);
    const A = it.A * (1 - 0.5 * it.shrink) * contact, Atop = it.A * (1 - 0.5 * it.shrink);
    const hc = sp.hc * (1 + 0.5 * oilFilm) * (1 - 0.25 * it.crisp);
    // the fat still in the strip is part of its heat capacity; what has drained is not
    b.m = it.prot + it.fs + it.fl + it.fr;
    const q = itemQBottom(it, bc, hc, A, b.T);
    const bt = bc.top;
    const qTop = topH(bt, b.T) * Atop * (bt.T - b.T) + (bt.rad ? Atop * 0.9 * C.sigma * bt.radView * (p4(bt.radT + 273.15) - p4(b.T + 273.15)) : 0);
    const cap = Math.max(bottomCap(bc), bt.T);
    const boiled = heatNode(b, q + qTop, dt, sp.cpDry, cap);
    it.lostWater += boiled; it.steam = boiled / dt;
    const T = b.T;
    // melt → release → drain: the patty's own kinetics, with the bands of a rasher for cells
    const E3 = Math.exp((61 - T) / 3);
    if (it.fs > 0) { const r = (0.06 * dt) / (1 + E3 * K_FATMELT); const melt = it.fs * Math.min(1, r); it.fs -= melt; it.fl += melt; }
    if (it.fl > 0) { const kRel = (0.0035 * sp.relMul * dt * (1 + (T > 66 ? T - 66 : 0) / 40)) / (1 + Math.sqrt(E3 * K_FATREL)); const rel = it.fl * Math.min(1, kRel); it.fl -= rel; it.fr += rel; }
    if (it.fr > 0) { const out = it.fr * Math.min(1, 0.35 * dt * clamp((T - 38) / 50, 0.05, 1.6)); it.fr -= out; it.lostFat += out; it.dFat += out; }
    const dry = nodeDry(b, it.w0), fatOut = clamp(it.lostFat / it.fat0, 0, 1);
    const Ts = itemSurfT(T, q, Math.max(A, 1e-4), sp.kMeat, sp.thickMm / 4000, b.w > 0.25 * it.w0, bottomCap(bc));
    it.Ts = Ts;
    itemBrowning(it.faceDown, Ts, dry, dt, 1, MEAT_CHAR);
    // crisp is the lean gone dry with the fat out of it: neither on its own will do it
    const crispTarget = smooth(0.55, 0.95, dry) * smooth(0.5, 0.9, fatOut);
    it.crisp += (crispTarget - it.crisp) * Math.min(1, dt / 60); // the lean does not go brittle the instant it dries; it takes another minute of setting
    // it curls away from whichever face has dried and contracted more, and flattens after a flip
    const curlTarget = clamp(0.75 * (it.faceDown.brown - it.faceUp.brown) + 0.45 * fatOut, -1, 1);
    it.curl += (curlTarget - it.curl) * Math.min(1, dt / 20);
    it.shrink = sp.shrinkMax * clamp(0.7 * fatOut + 0.3 * dry, 0, 1);
    it.qBot = q;
    it.sizzle = clamp((boiled / dt) * 400 + (it.fr + it.fl) * 8, 0, 1);
    it.smoke = clamp(it.faceDown.charRate * 60 * (0.3 + it.faceDown.char), 0, 1.5);
  }

  function stepEgg(s, it, dt, bc) {
    const sp = it.spec, A = it.A, wb = it.wBot, wt = it.wTop, y = it.yolk;
    const oilFilm = bc.bottom.type === 'pan' ? clamp((bc.bottom.oil || 0) / 0.003, 0, 1) : 0;
    const hc = sp.hc * (1 + 0.4 * oilFilm) * (1 - 0.25 * it.setBot); // a set gel touches the metal less well than raw white did
    const q = itemQBottom(it, bc, hc, A, wb.T);
    const Awhite = A - sp.yolkA;
    const Gw = (sp.kWhite / (sp.whiteMm / 1000)) * Awhite;                  // pan-side white → the white above it
    const Gy = (it.flipped ? sp.UyolkFlipped : sp.Uyolk) * sp.yolkA;        // pan-side white → yolk
    const GyTop = (sp.kWhite / (sp.whiteMm / 1000)) * sp.yolkA * 0.5;       // yolk → whatever white is over it
    const bt = bc.top, radTop = bt.rad ? 0.9 * C.sigma * bt.radView : 0;
    const qwt = Gw * (wb.T - wt.T), qy = Gy * (wb.T - y.T), qyTop = GyTop * (wt.T - y.T);
    const qTopAir = topH(bt, wt.T) * Awhite * (bt.T - wt.T) + (radTop ? Awhite * radTop * (p4(bt.radT + 273.15) - p4(wt.T + 273.15)) : 0);
    const qYolkAir = topH(bt, y.T) * sp.yolkA * 2 * (bt.T - y.T) + (radTop ? sp.yolkA * 2 * radTop * (p4(bt.radT + 273.15) - p4(y.T + 273.15)) : 0);
    // the top of a frying egg steams: Magnus again, and it is worth 20–30 W of cooling
    let evap = 0;
    if (bt.RH < 0.99 && wt.w > 1e-9) {
      const drive = Math.max(0, rhoVapSat(wt.T) - bt.RH * rhoVapSat(bt.T));
      evap = Math.min(wt.w, C.hMass * Awhite * drive * dt);
      wt.w -= evap; it.lostWater += evap;
    }
    const cap = Math.max(bottomCap(bc), bt.T);
    const bBot = heatNode(wb, q - qwt - qy, dt, sp.cpWhite, cap);
    const bTop = heatNode(wt, qwt + qTopAir - qyTop - (evap * C.Lvap) / dt, dt, sp.cpWhite, cap);
    heatNode(y, qy + qyTop + qYolkAir, dt, sp.cpYolk, cap);
    it.lostWater += bBot + bTop; it.steam = (bBot + bTop + evap) / dt;
    // setting: ovotransferrin goes at 62, ovalbumin follows, and it is visibly set by 65
    it.setBot = clamp(it.setBot + (0.6 * dt) / (1 + Math.exp((63.5 - wb.T) / 1.2)), 0, 1);
    it.setTop = clamp(it.setTop + (0.6 * dt) / (1 + Math.exp((63.5 - wt.T) / 1.2)), 0, 1);
    // the yolk thickens from 65 and is solid by 70 — but it sets from the outside in, and what the
    // cook sees is the skin against the hot white, not the core. Turned over, the yolk is a
    // millimetre of white off the metal and that skin runs a long way ahead of the middle.
    const yolkSkin = y.T + (Math.max(wb.T, wt.T) - y.T) * (it.flipped ? 0.45 : 0.18);
    it.yolkSkin = yolkSkin;
    it.yolkSet = clamp(it.yolkSet + (0.35 * dt) / (1 + Math.exp((68 - yolkSkin) / 1.8)), 0, 1);
    it.spread = clamp(it.spread + (1 - it.spread) * (1 - it.setBot) * 0.5 * dt, 0.45, 1);
    if (it.stuck && (it.setBot > 0.7 || oilFilm > 0.5)) it.stuck = false;
    // the lace: the rim that ran out into the fat, drying and browning at the pan's own temperature
    const lace = it.lace;
    lace.on = bc.bottom.type === 'pan' && oilFilm > 0.2;
    if (lace.on) {
      const Tp = bc.bottom.T, Cl = lace.m * sp.cpWhite + lace.w * C.cpW + 1e-9;
      let Tn = lace.T + (sp.hcLace * (sp.laceA * A) * (Tp - lace.T) * dt) / Cl; // a film of egg in oil is all but welded to the metal: it sits at the pan's temperature
      if (Tn > C.Tboil && lace.w > 1e-9) { const ex = Cl * (Tn - C.Tboil); const m = Math.min(lace.w, ex / C.Lvap); lace.w -= m; Tn = C.Tboil + (ex - m * C.Lvap) / Cl; it.lostWater += m; }
      lace.T = Math.min(Tn, Tp);
      lace.dry = nodeDry(lace, lace.w0);
      itemBrowning(lace, lace.T, lace.dry, dt, 1, MEAT_CHAR);
    }
    if (it.flipped) it.secondSide += dt;
    const Ts = itemSurfT(wb.T, q, A, sp.kWhite, sp.whiteMm / 4000, wb.w > 0.4 * it.w0b, bottomCap(bc));
    it.Ts = Ts;
    // the underside browns where the white has dried onto the metal: the brown skirt under an egg
    itemBrowning(it.faceDown, Ts, nodeDry(wb, it.w0b), dt, 1, MEAT_CHAR);
    // on bare bars the raw white pours straight through until it sets
    if (bc.bottom.type === 'grill') {
      const f = 0.05 * (1 - it.setBot) * dt;
      const through = (wb.m + wb.w) * Math.min(1, f);
      wb.m *= 1 - Math.min(1, f); wb.w *= 1 - Math.min(1, f);
      it.lostDrip += through; it.dJuice += through;
    }
    it.qBot = q;
    it.sizzle = clamp(((bBot + bTop) / dt) * 400 + oilFilm * 0.2, 0, 1);
    it.smoke = clamp((lace.charRate || 0) * 60 * (0.3 + lace.char) + (it.faceDown.charRate || 0) * 40, 0, 1.5);
  }

  function stepOnions(s, it, dt, bc) {
    const sp = it.spec, A = it.A, b = it.bot, t = it.top;
    const onPan = bc.bottom.type === 'pan';
    const oilFilm = onPan ? clamp((bc.bottom.oil || 0) / 0.003, 0, 1) : 0;
    const dryB = nodeDry(b, it.w0bot);
    const hc = sp.hc * (1 + 0.5 * oilFilm) * (1 - 0.3 * dryB); // a dried, shrunken slice touches the metal in fewer places
    const q = itemQBottom(it, bc, hc, A, b.T);
    // through a loose pile of slices, plus what the steam coming off the bottom carries up and
    // condenses higher in the heap — which is how the top of a pile of onions cooks at all
    // ...but only while the layer on the metal is still wet and soft against the pile. Once it has
    // dried and shrivelled it touches the wet onion above it at a few points, decouples from that
    // enormous heat sink, and runs straight up to the pan's temperature. That is scorching, and it
    // is why a heap that has been sweating happily at 100 °C for ten minutes can catch in one.
    const boiling = b.T > 99 && b.w > 1e-9;
    const G = (sp.kPile / 0.01) * A * (1 - 0.8 * dryB) + (boiling ? sp.gSteam : 0);
    const qBT = G * (b.T - t.T);
    const bt = bc.top, Atop = A * 1.4; // a heap's exposed surface is bigger than its footprint
    const qTop = topH(bt, t.T) * Atop * (bt.T - t.T) + (bt.rad ? Atop * 0.9 * C.sigma * bt.radView * (p4(bt.radT + 273.15) - p4(t.T + 273.15)) : 0);
    let evap = 0;
    if (bt.RH < 0.99 && t.w > 1e-9 && t.T > 25) {
      const drive = Math.max(0, rhoVapSat(t.T) - bt.RH * rhoVapSat(bt.T));
      evap = Math.min(t.w, C.hMass * Atop * drive * dt);
      t.w -= evap; it.lostWater += evap;
    }
    const cap = Math.max(bottomCap(bc), bt.T);
    const bB = heatNode(b, q - qBT, dt, sp.cpDry, cap);
    const bT = heatNode(t, qBT + qTop - (evap * C.Lvap) / dt, dt, sp.cpDry, cap);
    it.lostWater += bB + bT; it.steam = (bB + bT + evap) / dt;
    // the wet pile keeps re-wetting the layer trying to dry out. This is the whole reason
    // caramelising onions takes a quarter of an hour — and why they burn the moment it runs dry.
    const fb = b.w / Math.max(b.m + b.w, 1e-9), ft = t.w / Math.max(t.m + t.w, 1e-9);
    // and once the contact layer has shrivelled it stops soaking anything up: the juice from above
    // runs past it onto the metal and flashes off there. That is the runaway — a layer that starts
    // to dry gets drier — and it is the difference between sweating onions and scorching them.
    if (ft > fb) { const wick = Math.min(t.w, sp.wickMax * (1 - 0.6 * dryB) * clamp((ft - fb) / 0.4, 0, 1) * dt); t.w -= wick; b.w += wick; }
    // deglazing: onion water lifts the fond off the metal and takes its flavour with it
    if (onPan && s.pan.fond > 1e-6 && b.w > 1e-6) {
      const take = Math.min(s.pan.fond, s.pan.fond * 0.03 * dt * clamp(fb / 0.5, 0, 1));
      s.pan.fond -= take; it.fond += take;
    }
    // caramelisation: only once the layer on the metal is dry, and then steeply with temperature.
    // 5.6e6·exp(−70 kJ/RT) takes the layer on the metal to golden in six minutes at 120 °C, in 80
    // seconds at 150 and in ten over 200 — which is the whole difference between sweet onions and a
    // bitter pan. Only that layer is browning at any moment, so the heap as a whole goes at a third
    // of this: stirring is not fussiness, it is the only way to caramelise all of them.
    const fDry = smooth(0.55, 0.9, nodeDry(b, it.w0bot));
    const invRT = 1 / (C.R * (b.T + 273.15));
    const rate = 5.6e6 * Math.exp(-70e3 * invRT) * fDry;
    const rChar = SUGAR_CHAR.A * Math.exp(-SUGAR_CHAR.Ea * invRT) * fDry * Math.max(0, 1 - it.charBot / C.Cmax);
    it.carmBot = Math.min(3, it.carmBot + rate * dt);
    it.charBot = Math.min(C.Cmax, it.charBot + rChar * dt);
    // only the layer against the metal is browning at any moment: the heap's own state is that
    // layer's, weighted by how much of the heap it is
    it.carm = Math.min(3, it.carm + rate * sp.botFrac * dt);
    it.char = Math.min(C.Cmax, it.char + rChar * sp.botFrac * dt);
    it.Ts = b.T;
    it.faceDown.brown = it.carmBot; it.faceDown.char = it.charBot; it.faceDown.charRate = rChar;
    // on a grate they fall through the bars until they have wilted
    if (bc.bottom.type === 'grill') {
      const f = Math.min(1, 0.012 * clamp(fb / 0.5, 0, 1) * dt);
      const through = (b.m + b.w) * f;
      b.m *= 1 - f; b.w *= 1 - f; it.lostDrip += through; it.dJuice += through;
    }
    it.qBot = q;
    it.sizzle = clamp(((bB + bT) / dt) * 250, 0, 1);
    it.smoke = clamp(rChar * 200 * (0.3 + it.char), 0, 1.5);
  }

  const ITEM_STEP = { bun: stepBun, bacon: stepBacon, egg: stepEgg, onions: stepOnions };
  /** Advance one item by dt against the same kind of boundary object a patty gets. */
  function stepItem(s, it, dt, bc) {
    const fn = ITEM_STEP[it.kind]; if (!fn) return;
    it.dFat = 0; it.dJuice = 0;
    fn(s, it, dt, bc);
    if (it.where === 'pan') { it.cookTime += dt; it.timeDown += dt; } else it.restT += dt;
  }

  /**
   * What a cook would call it, and what the ticket makes of it. `score` is worth a few points of
   * the ticket's service penalty (or a small bonus for something done properly); the patty's own
   * 100 is never touched by it.
   */
  function itemState(it) {
    if (it.kind === 'bun') {
      const b = it.cutFace.brown, ch = it.cutFace.char;
      if (ch > 0.35) return { state: 'burnt', note: `${it.label} burnt black on the cut face (char ${ch.toFixed(2)}): bitter, and it scrapes the roof of your mouth.`, score: -4, toast: b, burnt: true };
      if (b > 4.5) return { state: 'over-toasted', note: `${it.label} toasted too far — dark and dusty (browning ${b.toFixed(1)}).`, score: -1, toast: b };
      if (b > 1.2) return { state: 'toasted', note: `${it.label} toasted golden (browning ${b.toFixed(1)}${it.fatSoaked > 0.0005 ? `, ${(it.fatSoaked * 1000).toFixed(1)} g of pan fat soaked into it` : ''}). Sealed: it will hold up under the juice.`, score: 1.5, toast: b };
      if (b > 0.4) return { state: 'barely toasted', note: `${it.label} only just caught colour. A pale bun goes soggy.`, score: 0, toast: b };
      return { state: 'untoasted', note: `${it.label} never really toasted.`, score: -0.5, toast: b };
    }
    if (it.kind === 'bacon') {
      const rendered = it.lostFat / it.fat0, ch = it.faceDown.char + it.faceUp.char;
      if (ch > 0.35) return { state: 'burnt', note: `Bacon burnt (char ${ch.toFixed(2)}): acrid, and nothing else on the plate will taste of anything.`, score: -4 };
      if (it.crisp > 0.6) return { state: 'crisp', note: `Bacon crisp and snapping — ${(rendered * 100).toFixed(0)} % of its fat rendered into the pan and it came out ${(it.shrink * 100).toFixed(0)} % shorter than it went in.`, score: 2 };
      if (it.crisp > 0.3) return { state: 'chewy', note: `Bacon browned but still bending: ${(rendered * 100).toFixed(0)} % of the fat is out. It wanted longer.`, score: 0 };
      return { state: 'limp', note: `Bacon limp and pale — only ${(rendered * 100).toFixed(0)} % of the fat rendered. Unrendered bacon fat on a burger is a texture nobody wants.`, score: -3 };
    }
    if (it.kind === 'egg') {
      const white = it.setTop, y = it.yolkSet;
      if (white < 0.5) return { state: 'raw white', note: `The egg white is still raw and clear on top (set ${white.toFixed(2)}). That comes straight back to the kitchen.`, score: -5 };
      if (it.faceDown.char > 0.35 || it.lace.char > 0.4) return { state: 'burnt', note: 'The egg is burnt black underneath and at the rim.', score: -3 };
      const lace = it.lace.brown > 1.2 ? ' with a crisp brown lace at the rim' : '';
      if (y < 0.3) return { state: 'runny yolk', note: `Set white, liquid yolk${lace}. It will run down your wrist, which some people order on purpose.`, score: 0.5 };
      if (y < 0.75) return { state: 'jammy yolk', note: `Set white and a jammy yolk${lace} — the state everybody wants and almost nobody hits.`, score: 2.5 };
      return { state: 'hard yolk', note: `Yolk cooked through and crumbly${lace}: safe, dry, and a waste of an egg.`, score: -0.5 };
    }
    if (it.kind === 'onions') {
      const c = it.carm, ch = it.char;
      // an eighth of the heap gone to carbon is a burnt batch: those black shreds are through all of it
      if (ch > 0.12) return { state: 'burnt', note: `The onions caught and burnt (char ${ch.toFixed(2)} through the heap, ${it.charBot.toFixed(2)} in the layer that was on the metal). Bitter all through, and stirring only spread it.`, score: -4 };
      if (c > 2.4) return { state: 'over-caramelised', note: `Onions taken past sweet and into bitter (caramel ${c.toFixed(2)}).`, score: -1 };
      if (c > 1.0) return { state: 'caramelised', note: `Onions soft, brown and sweet (caramel ${c.toFixed(2)}; ${(it.lostWater * 1000).toFixed(0)} g of water boiled out of them${it.fond > 1e-5 ? `, and they lifted ${(it.fond * 1000).toFixed(1)} g of fond off the pan with it` : ''}).`, score: 2 };
      if (c > 0.35) return { state: 'golden', note: `Onions softened and just turning golden (caramel ${c.toFixed(2)}). Another ten minutes would have made them sweet.`, score: 0.5 };
      return { state: 'raw', note: `The onions are still sharp — only ${(it.lostWater * 1000).toFixed(0)} g of their water is out. Raw onion on a burger is a choice; this one was an accident.`, score: -2 };
    }
    return { state: '', note: '', score: 0 };
  }

  /**
   * Per-state scratch: the small arrays the pan integration and the coverage sampling need every
   * step, plus the ring-to-ring conductance, which never changes once the pan is chosen.
   */
  function stateScratch(s) {
    const pan = s.pan, Np = pan.Np;
    const sc = {
      qRing: new Float64Array(Np), cov: new Float64Array(Np), weights: new Float64Array(Np),
      G: new Float64Array(Np - 1), Cr: new Float64Array(Np), dTr: new Float64Array(Np),
      knob: -1, wsum: 0,
    };
    for (let j = 0; j < Np - 1; j++) sc.G[j] = (pan.k * pan.thick * 2 * Math.PI * (j + 1) * pan.dr) / pan.dr; // W/K through the metal between ring centres
    return sc;
  }

  // Sample points around a pan ring for the coverage test; the ring radius scales them, so the
  // sines and cosines are the same every step and are worked out once.
  const COV_N = 24, COV_COS = new Float64Array(COV_N), COV_SIN = new Float64Array(COV_N);
  for (let a = 0; a < COV_N; a++) { const ang = (a / COV_N) * Math.PI * 2; COV_COS[a] = Math.cos(ang); COV_SIN[a] = Math.sin(ang); }
  /**
   * Fraction of each pan ring's area covered by whatever is on it (sampled around the ring). A bun
   * or a heap of onions shades the metal from the room exactly as a patty does — the ring under it
   * stops radiating and convecting to the air — so items count here as well as patties.
   */
  function ringCoverage(s, out) {
    const pan = s.pan, cov = out || new Float64Array(pan.Np), inPan = s._onPan || [], items = s._itemsOn || [];
    cov.fill(0);
    if (!inPan.length && !items.length) return cov;
    for (let j = 0; j < pan.Np; j++) {
      const r = (j + 0.5) * pan.dr; let hit = 0;
      for (let a = 0; a < COV_N; a++) {
        const x = r * COV_COS[a], y = r * COV_SIN[a];
        let on = false;
        for (let i = 0; i < inPan.length; i++) {
          const q = inPan[i], dx = x - q.pos.x, dy = y - q.pos.y, rq = q.D / 2;
          if (dx * dx + dy * dy <= rq * rq) { on = true; break; }
        }
        if (!on) for (let i = 0; i < items.length; i++) {
          const q = items[i], dx = x - q.pos.x, dy = y - q.pos.y, rq = q.Dcov / 2;
          if (dx * dx + dy * dy <= rq * rq) { on = true; break; }
        }
        if (on) hit++;
      }
      cov[j] = hit / COV_N;
    }
    return cov;
  }

  /** Advance the whole world (stove, pan, patties) by dt seconds. */
  function step(s, dt) {
    const pan = s.pan, st = s.stove, Tamb = s.env.Tamb;
    if (!s._ms) s._ms = {};
    const sc = s.sc || (s.sc = stateScratch(s));
    // who is on the pan, once — the coverage sampling and the patty loop both want to know, and
    // filter()ing s.patties three times a step was pure garbage
    const onPan = s._onPan || (s._onPan = []);
    onPan.length = 0;
    for (let i = 0; i < s.patties.length; i++) if (s.patties[i].where === 'pan') onPan.push(s.patties[i]);
    const itemsOn = s._itemsOn || (s._itemsOn = []);
    itemsOn.length = 0;
    for (let i = 0; i < s.items.length; i++) if (s.items[i].where === 'pan') itemsOn.push(s.items[i]);
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
    const Np = pan.Np, Tr = pan.Tr, qRing = sc.qRing;
    qRing.fill(0);
    const cov = ringCoverage(s, sc.cov);
    if (grill) {
      // the grate: thin bars heated by the coal bed's radiation and the hot gas coming up through
      // it, losing heat upward to the sky (or the dome); the bars are only a fraction of the area.
      // The rings see the bed averaged over the whole grate — with the coals spread that is simply
      // the bed; banked, it is the mean of a hot half and a bare one, and stepBed carries the
      // difference between the two sides.
      stepBed(s, dt);
      const even = !grill.bank;
      const Tf4 = p4(grill.Tfire + 273.15), Tgas = even ? Tamb + 0.5 * (grill.Tfire - Tamb) : grill.mTgas;
      const Tup = s.lid ? grill.Tdome : Tamb, Tup4 = p4(Tup + 273.15);
      const hUp = s.lid ? 12 : 20, emisSig = pan.emiss * C.sigma, radIn = emisSig * COAL.viewGrate, radOut = emisSig * 0.5;
      const radInT = emisSig * grill.mViewTs4, radInK = emisSig * grill.mView;
      for (let j = 0; j < Np; j++) {
        const A = pan.ringA[j] * pan.barFrac, Tk = Tr[j] + 273.15;
        qRing[j] += A * ((even ? radIn * (Tf4 - p4(Tk)) : radInT - radInK * p4(Tk)) + 25 * (Tgas - Tr[j]));
        qRing[j] -= A * (1 - cov[j]) * (hUp * (Tr[j] - Tup) + radOut * (p4(Tk) - Tup4));
      }
      st.pDelivered = grill.burnW;
    } else {
      // the burner's radial profile only changes when the knob does, so it is cached
      const weights = sc.weights;
      if (sc.knob !== st.knob) {
        sc.knob = st.knob; let wsum = 0;
        for (let j = 0; j < Np; j++) { weights[j] = st.profile((j + 0.5) * pan.dr, st.knob / 10) * pan.ringA[j]; wsum += weights[j]; }
        sc.wsum = wsum;
      }
      const wsum = sc.wsum, Tak4 = p4(Tamb + 273.15), lidConv = s.lid ? 0.4 : 1, lidRad = s.lid ? 0.3 : 1, emissSig = pan.emiss * C.sigma;
      for (let j = 0; j < Np; j++) {
        qRing[j] += wsum > 0 ? (st.pDelivered * weights[j]) / wsum : 0;
        const Tk = Tr[j] + 273.15;
        const hNat = 1.32 * Math.sqrt(Math.sqrt(Math.max(1, Tr[j] - Tamb) / pan.diam)) + 3; // x^¼, two square roots being far cheaper than a pow()
        const freeA = pan.ringA[j] * (1 - cov[j]);
        qRing[j] -= hNat * freeA * (Tr[j] - Tamb) * lidConv + emissSig * (p4(Tk) - Tak4) * freeA * lidRad + 3 * pan.ringA[j] * (Tr[j] - Tamb);
      }
      const hNatE = 1.32 * Math.sqrt(Math.sqrt(Math.max(1, Tr[Np - 1] - Tamb) / pan.diam)) + 3;
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
    let contactAll = 0, dryDownAll = 0, nOnPan = 0; // how much of the meat is against the metal (a patty up on the blade stops sizzling) and how dry the face against it is
    let anyResting = false;
    for (let pi = 0; pi < s.patties.length; pi++) {
      const p = s.patties[pi];
      if (p.where === 'pan') {
        const psc = p.sc || (p.sc = pattyScratch(p.Nz, p.Nr));
        const d = hyp(p.pos.x, p.pos.y);
        // Where each of the patty's rings sits on the pan. These are exactly the numbers panTat()
        // works out (ring index j0 and the weight t between ring centres); the heat drawn back out
        // of the metal at the bottom of this loop reuses them instead of redoing the geometry.
        const TatR = psc.TatR, pw = pattyRingWeights(pan, p), pwLo = p.panWlo, pwHi = p.panWhi;
        for (let j = 0; j < p.Nr; j++) {
          const row = j * Np, l = pwLo[j], h = pwHi[j];
          let T = 0; for (let k = l; k <= h; k++) T += pw[row + k] * Tr[k];
          TatR[j] = T;
        }
        // On a banked grate the rings are only half the story. Each of the patty's rings is a full
        // circle around the patty's own centre, so its mean position along the bank axis is exactly
        // the patty's x: one offset for the whole patty, and the rings keep the radial part.
        const zOff = pan.zoned ? zoneAt(pan, p.pos.x) : 0;
        if (zOff) for (let j = 0; j < p.Nr; j++) TatR[j] = Math.max(Tamb, TatR[j] + zOff);
        const Tu0 = panTat(pan, Math.sqrt(d * d + (p.D / 4) * (p.D / 4))), Te0 = panTat(pan, Math.sqrt(d * d + (p.D / 2) * (p.D / 2)));
        const Tunder = zOff ? Math.max(Tamb, Tu0 + zOff) : Tu0, Tedge = zOff ? Math.max(Tamb, Te0 + zOff) : Te0;
        const submerged = pan.oilDepth > p.h * (1 + 0.28 * p.dome) + 0.0005;
        if (submerged && !s._ms.deepfry) { s._ms.deepfry = true; logEvent(s, `The patty is under ${(pan.oilDepth * 1000).toFixed(0)} mm of fat: this is deep frying now. Both faces will brown.`, 'info'); }
        const carbonF = clamp(pan.carbon / 0.004, 0, 1);
        // the boundary condition is the same object every step (mutated, never rebuilt): three
        // fresh nested literals per patty per step was one of the bigger allocations in here
        let bc;
        if (grill) {
          // over the coals: bar contact on a fraction of the face, radiation and hot gas on the
          // rest, radiant heat on the edge, and a flare-up licking the underside adds soot. All of
          // it is read at *this patty's* place on the bed: over a banked-off side the fire is ash
          // and the gas has crossed the kettle, and a flare burns where the fat lands, not here.
          const bed = bedAt(s, p.pos.x);
          const fl = clamp(grill.flare, 0, 1.5) * (bed.f + BANK.flare * (1 - bed.f));
          const TfireEff = bed.Tfire + 350 * Math.min(1, fl);
          const Tgas = bed.Tgas + 200 * Math.min(1, fl);
          bc = psc.bcGrill || (psc.bcGrill = {
            bottom: { type: 'grill', TatR, T: 0, Tedge: 0, oil: 0, hcMul: 1, release: 0, barFrac: 0, Tbar: 0, Tfire: 0, view: COAL.view, Tair: 0, Tsurf: 0 },
            top: { h: 0, T: 0, RH: 0, oil: false, rad: false, radT: 0, radView: 0 },
            side: { T: 0, oilDepth: 0, oilT: 0, rad: true, radT: 0, radView: COAL.viewSide, h: 15 },
          });
          const bb = bc.bottom, bt = bc.top, bs = bc.side;
          bb.T = Tunder; bb.Tedge = Tedge; bb.release = pan.release + 0.2 * carbonF; bb.barFrac = pan.barFrac;
          bb.Tbar = Tunder; bb.Tfire = TfireEff; bb.Tair = Tgas; bb.Tsurf = 150 + 0.16 * (TfireEff - 150);
          bb.view = COAL.view * bed.view;
          if (s.lid) { bt.h = 14; bt.T = grill.Tdome; bt.RH = 0.3; bt.rad = true; bt.radT = grill.Tdome; bt.radView = 0.85; }
          else { bt.h = C.hAirTop; bt.T = Tamb + 0.2 * (bed.Tfire - Tamb); bt.RH = 0.25; bt.rad = false; }
          bs.T = Tgas * 0.6 + Tamb * 0.4; bs.radT = TfireEff; bs.radView = COAL.viewSide * bed.view;
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
          bc = psc.bcPan || (psc.bcPan = {
            bottom: { type: 'pan', TatR, T: 0, Tedge: 0, oil: 0, hcMul: 1, release: 0 },
            top: { h: 0, T: 0, RH: 0, oil: false, rad: false, radT: 0, radView: 0 },
            side: { T: 0, oilDepth: 0, oilT: 0, rad: false, h: 0 },
          });
          const bb = bc.bottom, bt = bc.top, bs = bc.side;
          bb.T = Tunder; bb.Tedge = Tedge; bb.oil = pan.oil; bb.hcMul = pan.hcMul * (1 - 0.3 * carbonF); bb.release = pan.release + 0.2 * carbonF;
          if (submerged) { bt.h = C.hOil; bt.T = Tunder; bt.RH = 1; bt.oil = true; }
          else { bt.h = s.lid ? C.hLid : C.hAirTop; bt.T = s.lidAirT; bt.RH = s.lid ? clamp((s.lidAirT - 60) / 40, s.env.RH, 1) : s.env.RH; bt.oil = false; }
          bs.T = Tamb + 0.25 * (Tedge - Tamb); bs.oilDepth = pan.oilDepth; bs.oilT = Tunder;
        }
        const pr = stepPattyStable(s, p, dt, bc);
        p.cookTime += dt; p.timeDown += dt;
        if (p.scrapeT > 0) p.scrapeT = Math.max(0, p.scrapeT - dt); // the second of spatula work runs down in simulated time, like everything else
        // heat drawn from the rings under each patty ring, in the same proportions it was read from
        const share = grill ? 0.35 : 1; // on a grill most of the heat is radiant, not drawn from the bars
        for (let j = 0; j < p.Nr; j++) {
          const row = j * Np, l = pwLo[j], h = pwHi[j], q = pr.qBotR[j] * share;
          for (let k = l; k <= h; k++) qRing[k] -= q * pw[row + k];
        }
        if (grill) {
          // juice and fat fall through the grate onto the coals: steam, sizzle, and a flare when
          // enough fat lands on a hot bed at once
          let drip = 0; for (let j = 0; j < p.Nr; j++) { drip += p.poolB[j]; p.poolB[j] = 0; } p.poolBottom = 0;
          p.lostWaterDrip += drip;
          grill.fatOnCoals += (pr.fatDrip + pr.fatSide) * dt;
          grill.juiceOnCoals = (grill.juiceOnCoals || 0) + drip + pr.juiceSide * dt;
        } else {
          pan.water += pr.juiceSide * dt;
          pan.oil += (pr.fatDrip + pr.fatSide) * dt;
        }
        boilBottomAll += pr.boilBottom; fatDripAll += pr.fatDrip; fatSideAll += pr.fatSide; juiceSideAll += pr.juiceSide; evapTopAll += pr.evapTop; steamAll += p.steamRate; panQ += pr.qBot;
        contactAll += (p.scrapeT > 0 ? SCRAPE_LIFT : 1) * (1 - 0.5 * clamp(p.dome, 0, 1));
        dryDownAll += 1 - clamp(layerMean(p, p.w, 0) / layerMean(p, p.w0c, 0), 0, 1);
        nOnPan++;
        if (p === s.patty) { hcSel = pr.hc; TsSel = pr.Ts; }
        let cheeseSmoke = 0;
        if (p.cheeses.length || p.cheeseUnder.length) {
          for (const ch of p.cheeses) if (ch.skirt) cheeseSmoke += ch.skirt.charRate * 40 * (0.3 + ch.skirt.char) * ch.skirt.mass / 0.01;
          for (const ch of p.cheeseUnder) if (ch.skirt) cheeseSmoke += ch.skirt.charRate * 40 * (0.3 + ch.skirt.char) * ch.skirt.mass / 0.01;
        }
        smokeChar += (p.faceDown.charRate || 0) * 40 * (0.3 + p.faceDown.char) + cheeseSmoke;
      } else if (p.where === 'rest') {
        anyResting = true;
        const psc = p.sc || (p.sc = pattyScratch(p.Nz, p.Nr));
        const bc = psc.bcAir || (psc.bcAir = { bottom: { type: 'air', h: 15, T: 0 }, top: { h: C.hAirTop, T: 0, RH: 0, oil: false, rad: false }, side: { T: 0, oilDepth: 0, oilT: 0, rad: false, h: 0 } });
        bc.bottom.T = Tamb + 8; bc.top.T = Tamb; bc.top.RH = s.env.RH; bc.side.T = Tamb;
        stepPattyStable(s, p, dt, bc);
        p.restT = (p.restT || 0) + dt;
      }
    }
    // ---- the toppings. Same boundary conditions as a patty, one lumped object each, and the same
    // bookkeeping afterwards: heat comes back out of the rings under them, rendered fat goes into
    // the pan (or onto the coals), and what boils off them is steam in the room.
    let itemBoil = 0, itemSizzle = 0, itemSmoke = 0;
    for (let ii = 0; ii < s.items.length; ii++) {
      const it = s.items[ii];
      if (it.where === 'pan') {
        const zOffI = grill && pan.zoned ? zoneAt(pan, it.pos.x) : 0;
        it.Tat = zOffI ? Math.max(Tamb, ringsT(pan, it.rings) + zOffI) : ringsT(pan, it.rings);
        let bc;
        if (grill) {
          const bed = bedAt(s, it.pos.x);
          const fl = clamp(grill.flare, 0, 1.5) * (bed.f + BANK.flare * (1 - bed.f));
          const TfireEff = bed.Tfire + 350 * Math.min(1, fl), Tgas = bed.Tgas + 200 * Math.min(1, fl);
          bc = it._bcGrill || (it._bcGrill = { bottom: { type: 'grill', T: 0, oil: 0, barFrac: 0, Tbar: 0, Tfire: 0, view: COAL.view, Tair: 0, Tsurf: 0 }, top: { h: 0, T: 0, RH: 0, rad: false, radT: 0, radView: 0 } });
          const bb = bc.bottom, bt = bc.top;
          bb.T = it.Tat; bb.Tbar = it.Tat; bb.barFrac = pan.barFrac; bb.Tfire = TfireEff; bb.Tair = Tgas; bb.Tsurf = 150 + 0.16 * (TfireEff - 150);
          bb.view = COAL.view * bed.view;
          if (s.lid) { bt.h = 14; bt.T = grill.Tdome; bt.RH = 0.3; bt.rad = true; bt.radT = grill.Tdome; bt.radView = 0.85; }
          else { bt.h = C.hAirTop; bt.T = Tamb + 0.2 * (bed.Tfire - Tamb); bt.RH = 0.25; bt.rad = false; }
        } else {
          bc = it._bcPan || (it._bcPan = { bottom: { type: 'pan', T: 0, oil: 0 }, top: { h: 0, T: 0, RH: 0, rad: false, radT: 0, radView: 0 } });
          const bb = bc.bottom, bt = bc.top;
          bb.T = it.Tat; bb.oil = pan.oil;
          bt.h = s.lid ? C.hLid : C.hAirTop; bt.T = s.lidAirT; bt.RH = s.lid ? clamp((s.lidAirT - 60) / 40, s.env.RH, 1) : s.env.RH; bt.rad = false;
        }
        stepItem(s, it, dt, bc);
        // the metal under it gives up that heat; over coals only the bar contact comes out of the
        // bars, the rest was radiation from the fire (the same 0.35 share the patties use)
        const share = grill ? 0.35 : 1;
        for (let k = 0; k < it.rings.length; k++) {
          const o = it.rings[k], q = it.qBot * o.w * share;
          if (o.t) { qRing[o.j0] -= q * (1 - o.t); qRing[o.j0 + 1] -= q * o.t; } else qRing[o.j0] -= q;
        }
        if (grill) { grill.fatOnCoals += it.dFat; grill.juiceOnCoals = (grill.juiceOnCoals || 0) + it.dJuice; }
        else { pan.oil += it.dFat; pan.water += it.dJuice; }
        itemBoil += it.steam; itemSizzle += it.sizzle; itemSmoke += it.smoke;
      } else if (it.where === 'rest' || it.where === 'cut') {
        const bc = it._bcAir || (it._bcAir = { bottom: { type: 'air', h: 15, T: 0 }, top: { h: C.hAirTop, T: 0, RH: 0, rad: false } });
        bc.bottom.T = Tamb + 8; bc.top.T = Tamb; bc.top.RH = s.env.RH;
        stepItem(s, it, dt, bc);
      }
    }
    pan.smokeItems = clamp(itemSmoke, 0, 2);
    pan.smokeChar = clamp(smokeChar, 0, 2.5);
    if (s.baste > 0) s.baste -= dt;
    if (anyResting) s.rest.t += dt;

    // ---- spatter
    const boilTotal = boilBottomAll + evapPan + itemBoil * 0.5; // half of what comes off a topping is boiling at the metal
    const oilFactor = clamp(pan.oil / 0.006, 0, 1.5);
    const hotFactor = clamp((pan.T - 120) / 120, 0, 1.5);
    const spatter = Math.min(80, boilTotal * 4e4 * oilFactor * hotFactor + (pan.water > 0 && pan.T > 150 ? 2 * oilFactor : 0));
    if (spatter > 0) { const loss = Math.min(pan.oil, spatter * 1.5e-7 * dt); pan.oil -= loss; pan.lostSpatter += loss; }

    // ---- integrate the pan rings (radial conduction, sub-cycled only if the metal is thin and
    // light enough that one step of dt would be unstable — cast iron never needs it)
    {
      const G = sc.G, Cr = sc.Cr, dTr = sc.dTr;
      const oilPer = (pan.oil * C.cpF) / floorA;
      let dtMax = Infinity;
      for (let j = 0; j < Np; j++) { Cr[j] = pan.ringM[j] * pan.cp + oilPer * pan.ringA[j]; const g = (j > 0 ? G[j - 1] : 0) + (j < Np - 1 ? G[j] : 0); dtMax = Math.min(dtMax, (0.45 * Cr[j]) / Math.max(g, 1e-9)); }
      const nsub = dt <= dtMax ? 1 : Math.min(40, Math.ceil(dt / dtMax)), h = dt / nsub;
      for (let it = 0; it < nsub; it++) {
        for (let j = 0; j < Np; j++) dTr[j] = qRing[j];
        for (let j = 0; j < Np - 1; j++) { const q = G[j] * (Tr[j + 1] - Tr[j]); dTr[j] += q; dTr[j + 1] -= q; }
        for (let j = 0; j < Np; j++) Tr[j] += (dTr[j] * h) / Cr[j];
      }
      let mean = 0; for (let j = 0; j < Np; j++) mean += Tr[j] * pan.ringA[j]; pan.T = mean / floorA;
      pan.Tcenter = Tr[0]; pan.Tedge = Tr[Np - 1];
      // what an IR gun reads on each side of a banked grate: two thirds of the way out, both ways
      if (grill) { grill.Thot = panTatXY(s, 0.66 * pan.floorR, 0); grill.Tcool = panTatXY(s, -0.66 * pan.floorR, 0); }
    }
    if (pan.T > pan.maxT && pan.id === 'nonstick' && !s._ptfeWarned) { s._ptfeWarned = true; logEvent(s, 'Nonstick coating above 260 °C: it is degrading and off-gassing. Not a good idea.', 'warn'); }

    const oilBubble = pan.oil > 1e-5 ? clamp((pan.T - 140) / 100, 0, 1) * clamp(pan.oil / 0.005, 0, 1) : 0;
    const sel = s.patty;
    // the diagnostics block is read by the renderer and the HUD every frame; it is filled in
    // place rather than rebuilt, so nothing downstream can hold a stale object
    const dg = s.diag;
    // The sizzle, split into the two voices it actually has, so the ear can tell them apart the way
    // a cook does. `boilNoise` is water flashing under the meat: coarse, low, loud, and it stops
    // dead when the underside dries. `hiss` is what is left — fat frying on hot metal, quiet and
    // much higher, with pops where a droplet of water in it flashes. `contact` drops when a patty
    // comes up on the blade, and the sound goes with it. `roar` is the fire drawing air through a
    // kettle, which a pan does not have at all.
    dg.contact = nOnPan ? contactAll / nOnPan : 0;
    const dryDown = nOnPan ? dryDownAll / nOnPan : 0;
    // 0.25 g/s of steam coming off the contact — a fresh patty on a 200 °C pan — is a full-throated
    // crackle; the hiss is the fat, and only counts once the face on the metal has boiled dry,
    // which is exactly the moment the sound changes
    dg.boilNoise = clamp(boilTotal * 4000, 0, 1.5) * (0.35 + 0.65 * dg.contact);
    dg.hiss = clamp((oilBubble * 0.7 + (fatDripAll + fatSideAll) * 2.2e4) * dryDown + itemSizzle * 0.3, 0, 1.2) * (0.35 + 0.65 * dg.contact);
    dg.roar = grill && grill.lit ? clamp(0.12 + 0.88 * (st.knob / 10), 0, 1) * clamp(grill.Tfire / 500, 0, 1.4) * (s.lid ? 0.5 : 1) : 0;
    dg.sizzle = clamp(boilTotal * 300 + oilBubble * 0.15 + evapTopAll * 20 + itemSizzle * 0.5 + (grill ? grill.sizzle : 0), 0, 1.5);
    dg.spatter = spatter; dg.steam = steamAll + evapPan + itemBoil;
    dg.smoke = pan.smokeOil + pan.smokeChar + pan.smokeFond + pan.smokeItems + (pan.flare > 0 ? 1.5 : 0) + (grill ? grill.smoke : 0);
    dg.flare = grill ? grill.flare : pan.flare; dg.oilDepth = pan.oilDepth; dg.overflow = pan.overflow; dg.lid = s.lid;
    dg.fire = grill ? grill.Tfire : 0;
    dg.evapBottom = boilBottomAll; dg.evapPan = evapPan; dg.oilBubble = oilBubble;
    dg.fatDrip = fatDripAll + fatSideAll; dg.juiceTop = sel ? sel.poolTop : 0; dg.juiceSide = juiceSideAll;
    dg.panQ = panQ; dg.Ts = TsSel; dg.hc = hcSel;
    pan.smoke = dg.smoke;
    syncSelected(s);

    if (s.t - s.lastTrace >= s.traceEvery) {
      s.lastTrace = s.t;
      const p = sel;
      s.trace.push({ t: s.t, pan: pan.T, panC: pan.Tcenter, panE: pan.Tedge, center: p ? centerT(p) : null, bottom: p ? layerMean(p, p.T, 0) : null, top: p ? layerMean(p, p.T, p.Nz - 1) : null, surf: p ? p.surfT : null, mass: p ? pattyMass(p) : null, where: s.where });
      if (s.trace.length > 20000) s.trace.shift();
    }
    soundCue(s);
    checkMilestones(s);
  }

  /** Log `text` the first time `cond` holds. Called about 25 times a step, so it stays cheap. */
  function once(s, ms, key, cond, text, kind) { if (!ms[key] && cond) { ms[key] = true; logEvent(s, text, kind); } }

  function checkMilestones(s) {
    const p = s.patty; const pan = s.pan; const ms = s._ms || (s._ms = {});
    if (s.grill) {
      once(s, ms, 'coalglow', s.grill.Tfire >= 450, 'The bed is glowing orange under a skin of grey ash. Hold a hand over the grate: two seconds is all you get.', 'info');
      // the two milestones with a number in them are spelled out, so the message is only built
      // when it actually fires rather than 40 times a second for the rest of the cook
      if (!ms.grateHot && pan.Tcenter >= 250) { ms.grateHot = true; logEvent(s, `Grate at ${pan.Tcenter.toFixed(0)} °C: hot enough to brand the meat with bars.`, 'info'); }
      once(s, ms, 'coalfull', s.grill.Tfire >= 800, 'Vents wide open: the bed is white-hot, well past 800 °C. Radiant heat like that sears in a minute and chars in three.', 'warn');
    } else {
      once(s, ms, 'preheat150', pan.Tcenter >= 150, 'Pan centre at 150 °C. A drop of water would sizzle and vanish in a second.', 'info');
      once(s, ms, 'leiden', pan.Tcenter >= 200, 'Pan centre past ~200 °C: water drops would now bead and skate (Leidenfrost). Proper searing territory.', 'info');
      if (!ms.hotspot && pan.Tcenter - pan.Tedge > 60 && pan.Tcenter > 150) { ms.hotspot = true; logEvent(s, `Hot spot: the pan is ${(pan.Tcenter - pan.Tedge).toFixed(0)} °C hotter over the burner than at the edge.`, 'info'); }
      once(s, ms, 'oilsmoke', pan.smokeOil > 0.3, 'The oil is smoking — it is past its smoke point and breaking down (acrolein). Slightly acrid.', 'warn');
    }
    if (!p) return;
    // every patty keeps its own milestones, so nothing has to build a "key#id" string per patty
    // per milestone per step
    const pm = p._ms || (p._ms = {});
    if (p.where === 'pan') {
      const Nr = p.Nr;
      once(s, pm, 'fatmelt', p.T[0] > 45, 'Fat in the bottom layer has melted (≈42 °C). It will start to leak out as the cells rupture.', 'info');
      once(s, pm, 'myosin', p.dM[0] > 0.5, 'Myosin denaturing at the bottom face: the meat is firming and going opaque grey.', 'info');
      once(s, pm, 'render', p.lostFat > 0.001, 'Fat is rendering out and pooling around the patty. Listen to it.', 'info');
      once(s, pm, 'dry', p.w[0] < 0.25 * p.w0c[0], 'Bottom face has boiled dry. Its temperature is no longer pinned at 100 °C — Maillard browning can now proceed.', 'info');
      once(s, pm, 'brown1', p.faceDown.brown > 1, 'A pale tan crust is forming.', 'info');
      once(s, pm, 'brown2', p.faceDown.brown > 2.5, 'Deep brown crust: Maillard is well underway (pyrazines, furanones — that smell).', 'good');
      once(s, pm, 'edgeahead', p.dG[Nr - 1] > 0.7 && p.dG[0] < 0.3, 'The edge is cooking ahead of the middle: heat is coming in from the side as well as below.', 'info');
      once(s, pm, 'char', p.faceDown.char > 0.25, 'The crust is starting to burn (pyrolysis). Bitter, acrid, black.', 'warn');
      once(s, pm, 'juice', p.poolTop > 0.0008, 'Pink juice is beading on the top surface — the classic "time to flip" cue.', 'good');
      once(s, pm, 'domed', p.dome > 0.5 && !p.dimple, 'The patty is doming: the centre has lifted off the pan and is barely cooking underneath.', 'warn');
      once(s, pm, 'c50', p.peakCenter >= 50, 'Centre 50 °C — rare.', 'info');
      once(s, pm, 'c55', p.peakCenter >= 55, 'Centre 55 °C — medium-rare.', 'info');
      once(s, pm, 'c60', p.peakCenter >= 60, 'Centre 60 °C — medium.', 'info');
      once(s, pm, 'c66', p.peakCenter >= 66, 'Centre 66 °C — medium-well. Actin is denaturing; juice loss accelerates.', 'info');
      once(s, pm, 'c71', p.peakCenter >= 71, 'Centre 71 °C — well done. USDA-safe for ground beef.', 'info');
      once(s, pm, 'c80', p.peakCenter >= 80, 'Centre 80 °C. This is a hockey puck now.', 'warn');
      // the cheese milestones each walk the slice stack, so they are skipped when there is none
      if (p.cheeses.length || p.cheeseUnder.length) {
        const c0 = p.cheeses[0];
        once(s, pm, 'cheese', c0 && c0.melt > 0.8, 'Cheese fully melted and draping over the edges.', 'good');
        const sk = p.cheeses.concat(p.cheeseUnder).map((c) => c.skirt).filter((x) => x && x.mass > 1e-5);
        once(s, pm, 'cheeseUnderBurn', p.cheeseUnder.some((c) => c.skirt && c.skirt.char > 0.3), 'The cheese under the patty has burnt onto the pan. It will not come off clean.', 'warn');
        once(s, pm, 'cheeseTouch', sk.length > 0 && !(p.cheeses[0] && p.cheeses[0].submerged), 'Cheese has drooped onto the pan. It will melt, boil dry into a lace, then brown.', 'info');
        once(s, pm, 'cheeseFry', p.cheeses.some((c) => c.submerged), 'The cheese is under the fat. It has melted instantly and is frying: it will crisp, brown, then burn.', 'info');
        once(s, pm, 'cheeseFrico', sk.some((x) => x.brown > 2), 'The cheese on the pan has gone golden and crisp: frico.', 'good');
        once(s, pm, 'cheeseBurn', sk.some((x) => x.char > 0.3), 'The cheese lace is burning: black, bitter, and smoking.', 'warn');
      }
    }
  }

  function panDirt(pan) { return pan.fond + pan.fondBurnt + pan.cheeseBits + pan.meatBits + pan.carbon; }
  function washPan(s) {
    const pan = s.pan; if (s.patties.some((p) => p.where === 'pan') || s.items.some((it) => it.where === 'pan')) return false;
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
    // the build step: anything off the heat that the cook has not already put on a burger goes to
    // whichever burger it came off the pan next to
    for (const it of s.items) if (it.where !== 'pan' && it.burger == null) { const b = nearestBurger(s, it); if (b) it.burger = b.id; }
    for (const p of list) {
      if (p.where === 'cut') continue;
      p.where = 'cut'; p.serveT = centerT(p);
      const soak = Math.max(0, p.lostWaterDrip - (p.dripAtRest == null ? p.lostWaterDrip : p.dripAtRest)) + p.poolTop + p.poolBottom;
      const tops = toppingsOf(s, p);
      const heel = tops.find((it) => it.kind === 'bun' && it.half === 'bottom');
      // a toasted cut face is a sealed, part-dextrinised crust with the pan's fat in it: it drinks
      // roughly 60 % less of the juice than raw crumb does. That is why the heel goes on the griddle.
      const soakF = heel ? lerp(1, 0.4, clamp(heel.cutFace.brown / 2, 0, 1)) : 1;
      p.bunSoakRaw = soak; p.bunSoak = soak * soakF; p.bunToast = heel ? heel.cutFace.brown : 0;
      const crown = tops.find((it) => it.kind === 'bun' && it.half === 'top');
      // what the renderer draws on the cut faces of the bun it goes out on
      p.bunFaces = { bottom: heel ? { brown: heel.cutFace.brown, char: heel.cutFace.char } : null, top: crown ? { brown: crown.cutFace.brown, char: crown.cutFace.char } : null };
      for (const it of tops) if (it.where !== 'cut') { it.where = 'cut'; it.serveT = itemT(it); }
      for (let j = 0; j < p.Nr; j++) { p.poolT[j] = 0; p.poolB[j] = 0; } p.poolTop = 0; p.poolBottom = 0;
      const built = tops.length ? ` Built with ${tops.map((it) => it.label.toLowerCase()).join(', ')}.` : '';
      logEvent(s, `Patty ${p.id} on a bun.${p.bunSoak > 0.0015 ? ` ${(p.bunSoak * 1000).toFixed(1)} g of juice went straight into the bottom bun${heel && soakF < 0.8 ? ' — far less than it would have taken untoasted' : ''}.` : ''}${p.cheeses.length ? ` ${p.cheeses.length} slice${p.cheeses.length > 1 ? 's' : ''} of cheese under the lid.` : ''}${built}`, 'action');
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
  /**
   * The build: what was stacked on this burger, the state each topping came out in, and what
   * service makes of it. The patty's own 100 never moves — a raw egg white or a black bun is a
   * penalty on the ticket, and a jammy yolk or crisp bacon buys a little of it back.
   */
  function buildOf(s, patty) {
    const items = toppingsOf(s, patty).map((it) => {
      const st = itemState(it);
      return { kind: it.kind, label: it.label, state: st.state, note: st.note, score: st.score };
    });
    let pen = 0, bon = 0;
    for (const b of items) { if (b.score < 0) pen -= b.score; else bon += b.score; }
    return { items, penalty: clamp(pen, 0, 10), bonus: clamp(bon, 0, 5) };
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
    // a burger that has been cut into is not a whole burger: it goes out with a slit in it and it
    // has been weeping out of that slit ever since
    if (p.slits) structure -= PEEK.structure * Math.min(3, p.slits);
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
    if ((p.bunToast || 0) > 1.2 && (p.bunSoakRaw || 0) > 0.003) notes.push(`The toasted heel held: ${((p.bunSoakRaw - p.bunSoak) * 1000).toFixed(1)} g of juice that a raw bun would have drunk stayed in the burger instead.`);
    if (p.lostWaterDrip > 0.006) notes.push(`${(p.lostWaterDrip * 1000).toFixed(0)} g of juice ran out ${p.grilled ? 'through the grate onto the coals' : 'onto the pan'} instead of staying in the meat.`);
    if (p.lostFat > 0.004) notes.push(`${(p.lostFat * 1000).toFixed(0)} g of fat rendered out and ${p.grilled ? 'fell on the coals' : 'pooled in the pan'}.`);
    if (overFrac > 0.5 && target.hi < 68) notes.push('A wide grey band: the outside went well past target before the centre got there. Thicker patty, lower heat, or flip more often.');
    if (p.dome > 0.5) notes.push('The patty domed into a meatball: the centre lifted off the pan and browned unevenly. A thumb dimple prevents that.');
    if (p.salt === 'mixed') notes.push('Salt was mixed through the meat early: dissolved myosin cross-linked into a springy, sausage-like bite.');
    if (p.work > 0.8) notes.push('The meat was overworked: dense and tight instead of loose and tender.');
    // what the cook's own senses cost this patty — the point of them is that they are not free
    if (p.slits) notes.push(`You cut into it ${p.slits === 1 ? 'once' : p.slits === 2 ? 'twice' : `${p.slits} times`} to look: ${(p.lostWaterCut * 1000).toFixed(1)} g of juice ran out of the cut instead of back into the meat, and it goes out on the bun with a slit through it.`);
    if (p.pressTests) notes.push(`You pressed it with a finger ${p.pressTests === 1 ? 'once' : p.pressTests === 2 ? 'twice' : `${p.pressTests} times`} to feel how far it had gone — ${(p.pressTestJuice * 1000).toFixed(2)} g of juice. That is what a press test costs, and it is a tenth of what leaning on it with a spatula would have.`);
    const build = buildOf(s, p);
    for (const b of build.items) notes.push(b.note);
    const profile = [], dG = []; for (let k = 0; k < p.Nz; k++) { profile.push(p.T[k * p.Nr]); dG.push(p.dG[k * p.Nr]); }
    return {
      id: p.id, total, target, got, peak, dist,
      parts, build,
      massStart: p.massKg0, massEnd: massNow, waterRetained: wRet, waterEvap: p.lostWaterEvap, waterDrip: p.lostWaterDrip, fatLost: p.lostFat, stuck: p.lostStuck,
      overFrac, notes, cookTime: p.cookTime, restTime: p.restT || 0, flips: p.flips, bunSoak: p.bunSoak || 0, cheeseSlices: p.cheeses.length,
      peeks: p.slits, cutJuice: p.lostWaterCut, pressTests: p.pressTests, pressJuice: p.pressTestJuice, firmness: firmness(p).index,
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
    // the build: up to ten points off the ticket for anything sent out raw or burnt, and a few
    // back for toppings that were actually cooked properly
    let bPen = 0, bBon = 0;
    for (const r of results) { bPen += r.build.penalty; bBon += r.build.bonus; }
    const buildPenalty = list.length ? bPen / list.length : 0, buildBonus = list.length ? bBon / list.length : 0;
    for (const r of results) for (const b of r.build.items) if (b.score <= -3) notes.push(`Burger ${r.id}: ${b.label.toLowerCase()} went out ${b.state}. That is a send-back.`);
    const rests = list.map((p) => p.restT || 0);
    const spread = rests.length > 1 ? Math.max(...rests) - Math.min(...rests) : 0;
    if (list.length > 1 && spread < 90 && coldPenalty < 0.5) notes.push('All the burgers landed together, still hot. That is the hard part of a multi-burger ticket.');
    else if (spread >= 240) notes.push(`The burgers came off the pan ${fmtTime(spread)} apart. Start the well-done one first and the rare one last so they finish together.`);
    const mean = results.length ? results.reduce((a, r) => a + r.total, 0) / results.length : 0;
    const total = Math.round(clamp(mean - coldPenalty - buildPenalty + buildBonus, 0, 100));
    return { total, mean: Math.round(mean), coldPenalty: Math.round(coldPenalty), buildPenalty: Math.round(buildPenalty * 10) / 10, buildBonus: Math.round(buildBonus * 10) / 10, spread, results, notes };
  }

  return {
    C, BLENDS, PANS, FATS, STOVES, GRATE, COAL, BANK, DONENESS, ITEMS, TOUCH, PEEK, HAND,
    makePatty, createState, step, stepPatty, pattySpots, panTat, panTatXY, selectPatty,
    setKnob, setBank, addFat, placePatty, movePatty, moveItem, scrape, slideTo, coalAt, bedAt, zoneAt, flipPatty, pressPatty, removePatty, addCheese, toggleLid, basteButter, washPan, wipeStove, panDirt, serve,
    makeItem, addItem, selectItem, flipItem, removeItem, stepItem, assignTopping, nearestBurger, toppingsOf, itemState, itemMass, itemT, freeSpot, footprintRings, ringCoverage,
    firmness, firmnessWord, cellStiffness, pressTest, peek, sliceRead, handTest, handTestAt,
    evaluate, evaluateTicket, buildOf, donenessOf, centerT, cellT, layerMean, gridMean, pattyMass, nodeMass, waterHolding, fmtTime, clamp, lerp, rhoVapSat, logEvent,
  };
});
