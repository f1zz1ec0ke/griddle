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
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./assembly'), require('./oil-film'));
  else root.BurgerPhysics = factory(root.BurgerAssembly, root.BurgerOilFilm);
})(typeof self !== 'undefined' ? self : this, function (Assembly, Oil) {
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
  const COAL = {
    H: 30e6, view: 0.5, viewGrate: 0.4, viewSide: 0.2, tauUp: 150, tauDown: 300,
    cp: 840,          // J/(kg K) for charcoal, hot or cold
    leak: 0.06,       // the flow past a kettle lid with everything shut: no lid ever seats perfectly
    ashYield: 0.06,   // lump charcoal is ~6 % non-combustible mineral ash by mass
    ashStay: 0.5,     // half of that falls through the fire into the bowl; the rest blankets the lumps
    ashChoke: 0.10,   // ash at a tenth of the bed's mass is a properly choked fire: half the draught gone
    hUnlit: 8.0,      // W/(kg K) between the bed and the cold lumps sitting in it: a kilo of lump is
                      //   ~0.24 m² of surface, taking ~15 kW/m² of radiation off a 600 °C bed plus
                      //   convection off its gas — call it 8 W per kelvin per kilo of cold charcoal
    Tignite: 350,     // °C — lump charcoal catches when its surface gets there
    tauCatch: 90,     // s — and then the pile lights through over a minute or two
    stirTau: 90,      // s — a raked bed draws harder for about a minute and a half, then settles back
  };
  /**
   * Wood on the coals. A chunk (not chips, not a log) is ~60 g of split hardwood: 700 kg/m³ air-dried
   * to about 12 % moisture, so roughly a 4 cm cube with 0.012 m² of surface. It does nothing at all
   * for the first three minutes — the bed has to boil the water out of it and take it to pyrolysis
   * temperature, around 300 °C, where the hemicellulose and cellulose start cracking — and then it
   * smoulders for fifteen to seventeen minutes. Measured on this bed: it catches at 3:11 over
   * 610 °C coals (2:32 over 680 °C), peaks a minute later, and is spent at 20:10. The smoke rate peaks once the whole chunk is up to
   * temperature and decays as the chunk is eaten away, because a smouldering front lives on the
   * surface and the surface goes as m^⅔.
   *
   * Whether that smoke is worth eating is entirely a question of air. With the vents open the
   * volatiles ignite as they leave the wood and what escapes is thin and blue: a few per cent of the
   * mass as phenols, guaiacols and syringols, which is the flavour. Smothered — lid on, vents shut —
   * they never ignite, come off cool and condense on everything above them as thick white smoke.
   * That is creosote, and it is bitter.
   *
   * Kind is intensity: mesquite is oily and resinous and smokes half again as hard as hickory,
   * apple is mild enough that it is difficult to overdo.
   */
  const WOOD = {
    hickory:  { id: 'hickory',  name: 'Hickory',  chunk: 0.060, intensity: 1.00, note: 'sweet and bacony — the classic barbecue smoke' },
    apple:    { id: 'apple',    name: 'Apple',    chunk: 0.060, intensity: 0.62, note: 'mild and fruity; hard to overdo' },
    mesquite: { id: 'mesquite', name: 'Mesquite', chunk: 0.060, intensity: 1.45, note: 'oily and aggressive; it turns bitter if you let it' },
  };
  const SMOKE_KINDS = ['hickory', 'apple', 'mesquite', 'bed'];
  const SMOKE = {
    rho: 700,        // kg/m³ — air-dried hardwood
    water: 0.12,     // and 12 % of that mass is water that has to boil off before anything pyrolyses
    cp: 1600,        // J/(kg K) for wood at cooking temperatures
    Tpyro: 300,      // °C — where the chunk starts cracking into volatiles in earnest
    Hpyro: 4.0e5,    // J/kg — pyrolysis is endothermic, which is what holds a smouldering chunk near 400 °C
    hGas: 30,        // W/(m²K) convection off the fire's gas onto a lump sitting in it
    view: 0.55,      // half buried in the bed: it sees the fire over a bit more than half its surface
    burn: 2.0e-4,    // kg/s at full smoulder for a fresh 60 g chunk: most of the smoke inside a quarter of an hour, with a tail
    yield: 0.05,     // ~5 % of the mass leaves as smoke solids and condensables; the rest is CO₂, CO and water
    dirty: 1.5,      // and a smothered chunk yields two and a half times that, because nothing burns it off
    char: 0.20,      // what is left behind is charcoal, and it joins the bed as fuel
    bed: 2.0e-7,     // kg/s of smoke off the charcoal itself, nearly all of it only when it is starved
    flavBed: 0.35,   // how much of the bed's own deposit reads as smoke flavour at all: charcoal smoke tastes of charcoal, and there is a little of that in every kettle, but it is not the aromatic condensate a wood chunk lays down and a smothered kettle over plain lump is not a smoked burger.
    creoBed: 0.25,   // and a quarter of what it deposits reads as creosote. Lump charcoal has already been through pyrolysis in the kiln: starved of air it makes carbon monoxide and a little soot, not the tar load a smothered *wood* chunk gives up. Shutting a kettle down over plain charcoal is a dirty fire, but it is not a creosote bath.
    V: 0.030,        // m³ under the dome of a 57 cm kettle, above the grate
    Qopen: 0.060,    // m³/s carried away by the plume off an open kettle
    Qlid: 0.022,     // m³/s drawn through a closed kettle with both vents wide (~20× what the bed needs)
    Qleak: 0.0010,   // m³/s past the lid with everything shut: the smoke has nowhere to go but onto the meat
    vDep: 2.0e-3,    // m/s deposition velocity of smoke particles onto meat (impaction plus thermophoresis onto a cool, wet surface)
    ref: 4.0e-5,     // kg/m² of deposit that reads as a smokiness of 1.0: one clean chunk over a five-minute cook
    dense: 1.5e-4,   // kg/m³ of smoke that reads as a full plume to the eye
  };
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
   * how hard it was packed), and cold solid fat adds a little to that — beef fat is waxy out of the
   * fridge and already soft by the time the meat has sat out to 25 °C, so that term fades between
   * 15 and 35 °C, which is why a fridge-cold patty feels firmer than one that has been on the
   * board. Then, in order:
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
      Nz, Nr, massKg0: massKg, rho0: rho, voids, work,
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
      // smoke deposited on it over a fire: kg/m² in total, how much of that is creosote off smoke
      // that never had enough air, and which wood it came from
      smokeDep: 0, creoDep: 0, smokeBy: { hickory: 0, apple: 0, mesquite: 0, bed: 0 },
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
    const qBotR = new Float64Array(Nr), qPanR = new Float64Array(Nr);
    return {
      Cn: new Float64Array(n), Kn: new Float64Array(n), Q: new Float64Array(n),
      X: new Float64Array(n), flux: new Float64Array(n), fmv: new Float64Array(n), dir: new Int8Array(n),
      Aj: new Float64Array(Nr), qBotR, qPanR, TpanR: new Float64Array(Nr), hcR: new Float64Array(Nr), TsLim: new Float64Array(Nr),
      TatR: new Float64Array(Nr),
      cheeseFlux: new Float64Array(26), cheeseFluxTop: new Float64Array(26), // at most 24 slices, plus the air above
      // qBotR is what went into the *meat's* rings; qPanR is what the metal under them gave up.
      // They are the same number unless there is something between the two — a slice of cheese
      // fried under the patty — and then the difference is what that something absorbed.
      res: { qBot: 0, qBotR, qPanR, hc: 0, boilBottom: 0, evapTop: 0, fatDrip: 0, fatSide: 0, juiceSide: 0, cheeseDrip: 0, Ts: 0, qSide: 0 },
      acc: { qBot: 0, qBotR: new Float64Array(Nr), qPanR: new Float64Array(Nr), hc: 0, boilBottom: 0, evapTop: 0, fatDrip: 0, fatSide: 0, juiceSide: 0, cheeseDrip: 0, Ts: 0, qSide: 0 },
      bcPan: null, bcGrill: null, bcAir: null,
    };
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
        smoke: 0, smokeOil: 0, smokeChar: 0, smokeFond: 0, smokeItems: 0,
        lostSpatter: 0,
        // the bars' two-zone field (a grate only): the absolute temperature of each strip across the
        // bank axis, the zero-mean departure from the ring solution it implies, and how much of the
        // bed's area each strip carries. `zoned` is false while the fire is spread evenly, and then
        // every lookup is exactly the ring lookup it always was.
        zoneT: grill ? new Float64Array(BANK.N).fill(Tamb) : null, zoneDT: grill ? new Float64Array(BANK.N) : null, zoneW: grill ? zoneWeights() : null, zoned: false,
      },
      lid: false, lidAirT: Tamb,
      // The fire, when the stove is a grill: coal left (lit and not), bed temperature, the ash in the
      // bed and the ash that has fallen into the bowl, flare-ups, dome air, how the bed is raked
      // (0 = spread under the whole grate, 1 = banked into one half), the top vent in the lid, the
      // wood chunks on the coals, and the smoke they make — one stirred tank of concentration under
      // the dome per kind of wood, plus the charcoal's own.
      grill: grill ? {
        coal: 1.5, coal0: 1.5, Tfire: Tamb, ash: 0, ashBowl: 0, unlit: 0, unlitT: Tamb, lit: false,
        flare: 0, flareTotal: 0, Tdome: Tamb, fatOnCoals: 0, burnW: 0, bank: 0,
        topVent: 1, air: 0, comb: 1, stir: 0, woods: [], smokeConc: 0,
        conc: { hickory: 0, apple: 0, mesquite: 0, bed: 0 },
        mView: COAL.viewGrate, mViewTs4: 0, mTgas: Tamb,
      } : null,
      patties: [], patty: null, where: 'board', // s.patty / s.where mirror the selected patty
      items: [], item: null, // toppings sharing the pan: bun halves, bacon, an egg, onions
      baste: 0,
      events: [], trace: [], traceEvery: 0.5, lastTrace: -1,
      // sizzle is the level; boilNoise/hiss/roar/contact are its character, which is what a cook
      // listening to the pan is actually reading (see the sizzle block at the end of step())
      diag: { sizzle: 0, spatter: 0, steam: 0, smoke: 0, evapBottom: 0, evapPan: 0, oilBubble: 0, fatDrip: 0, juiceTop: 0, juiceSide: 0, panQ: 0, boilNoise: 0, hiss: 0, roar: 0, contact: 0, lid: false },
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
  /** Share of the round bed's area in each strip across the bank axis (a chord is ∝ √(1−u²) long). */
  function zoneWeights() {
    const w = new Float64Array(BANK.N); let sum = 0;
    for (let i = 0; i < BANK.N; i++) { const u = -1 + (2 * i + 1) / BANK.N; w[i] = Math.sqrt(Math.max(0, 1 - u * u)); sum += w[i]; }
    for (let i = 0; i < BANK.N; i++) w[i] /= sum;
    return w;
  }
  /** How much of the bed under `u` (x as a fraction of the bed radius) is glowing coal, 0..1. */
  function coalAt(g, u) { return g.bank > 0 ? 1 - g.bank * (1 - smooth(BANK.edge0, BANK.edge1, u)) : 1; }
  /** Fat that falls from x lands on coals or on bare ash: only the share over the pile can light. The rest soaks into the ash. */
  function coalUnder(s, x) { return s.grill && s.grill.bank > 0 ? coalAt(s.grill, clamp(x / s.pan.floorR, -1, 1)) : 1; }
  function dripOnBed(s, x, fat) { const f = coalUnder(s, x); s.grill.fatOnCoals += fat * f; s.grill.fatOnAsh = (s.grill.fatOnAsh || 0) + fat * (1 - f); }
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
    else logEvent(s, `Banked the coals ${b > 0.75 ? 'hard' : 'partly'} to one side with the tongs (${(b * 100).toFixed(0)} %). The bed is deeper over there and bare ash on the other side: sear over the coals, then slide it across to finish. The bars are half of the way to two zones in a couple of minutes and take eight to ten to settle — sear over the pile while they do.`, 'action');
  }

  /**
   * The vent in the lid. With the lid on it is half of the kettle's airflow (see ventFlow) and it is
   * also the only way the smoke under the dome gets out: shut it and the smoke stops moving over the
   * meat and starts sitting on it. With the lid off it does nothing at all.
   */
  function setTopVent(s, v) {
    if (!s.grill) return;
    const t = clamp(v, 0, 1), was = s.grill.topVent;
    s.grill.topVent = t;
    if (Math.abs(t - was) < 0.05) return;
    if (!s.lid) { logEvent(s, `Set the lid vent to ${(t * 100).toFixed(0)} %. With the lid off the kettle it does nothing — the fire is breathing straight up through the grate.`, 'info'); return; }
    logEvent(s, t < 0.05
      ? 'Top vent shut. Nothing is drawing through the kettle now: the fire will fade, and the smoke under the dome has nowhere to go but onto the meat.'
      : `Top vent ${(t * 100).toFixed(0)} % open. That and the bottom vent are in series — the smaller one sets the draught${t < 0.35 ? ', and the smoke is going to hang under the dome' : '.'}`, t < 0.05 ? 'warn' : 'action');
  }
  /**
   * A chunk of wood on the coals. It sits there heating for about three minutes, then smoulders for
   * a quarter of an hour; what a chunk is worth is in WOOD/SMOKE above.
   */
  function addWood(s, kind) {
    if (!s.grill) { logEvent(s, 'Wood goes on a fire, and there is no fire under a pan.', 'info'); return null; }
    const spec = WOOD[kind] || WOOD.hickory;
    const m0 = spec.chunk;
    const V = m0 / SMOKE.rho, side = Math.cbrt(V);
    const wd = {
      kind: spec.id, spec, m0, m: m0, water: m0 * SMOKE.water, T: s.env.Tamb,
      A0: 6 * side * side,      // a ~4.4 cm cube: 0.0116 m² of surface for the fire to work on
      lit: 0, smoke: 0, caught: false, spent: false, t0: s.t,
    };
    s.grill.woods.push(wd);
    if (s.grill.woods.length > 6) s.grill.woods.shift(); // a kettle only holds so many; the oldest is ash by now anyway
    logEvent(s, `A ${(m0 * 1000).toFixed(0)} g chunk of ${spec.name.toLowerCase()} on the coals — ${spec.note}. It has to dry and reach ~300 °C before it gives you anything — about three minutes on a hot bed — and then it smoulders for a quarter of an hour.`
      + (s.grill.Tfire < 250 ? ' On a bed this cool it will just sit there.' : ''), 'action');
    return wd;
  }
  /**
   * More charcoal. Straight out of the bag it is cold and unlit: it takes heat out of the fire until
   * its surface reaches ignition (~350 °C), so the bed dips first and only then comes back up
   * hotter — which is why you add coals well before you need them, not when the fire is already low.
   */
  function addCoals(s, kg) {
    if (!s.grill) return;
    const m = clamp(kg || 0, 0, 3); if (m <= 0) return;
    const g = s.grill;
    g.unlitT = (g.unlit * g.unlitT + m * s.env.Tamb) / (g.unlit + m); // mixing cold lumps with lumps already warming
    g.unlit += m;
    logEvent(s, `${(m * 1000).toFixed(0)} g of unlit lump charcoal onto the bed. It is a heat sink until it catches: expect the fire to drop for a few minutes before it comes back up.`, 'action');
  }
  /**
   * Raking the bed with the tongs. Ash falls off the lumps and through into the bowl, fresh
   * incandescent surface comes up, and the fire draws harder for a minute or two before settling.
   */
  function stirCoals(s) {
    if (!s.grill) return false;
    const g = s.grill, knocked = g.ash * 0.7; // most of the ash sitting on the lumps comes off
    g.ash -= knocked; g.ashBowl += knocked;
    g.stir = 1;
    logEvent(s, g.lit
      ? `Raked the bed through with the tongs. ${(knocked * 1000).toFixed(0)} g of ash knocked off the lumps and down into the bowl; the fire is drawing harder and it will glow up for a minute or so.`
      : 'Raked the cold bed through. Nothing to glow up yet.', 'action');
    return true;
  }
  /** Empty the ash out of the bowl. Only when it is cold — this is a bucket of fine grey dust. */
  function emptyAsh(s) {
    if (!s.grill) return false;
    const g = s.grill;
    if (g.Tfire > 60 || s.pan.T > 60) {
      logEvent(s, `Not with the bed at ${g.Tfire.toFixed(0)} °C and the bars at ${s.pan.T.toFixed(0)} °C. Ash goes in a bin, and live ash in a bin is how sheds burn down. Wait for it to go out.`, 'warn');
      return false;
    }
    const had = g.ash + g.ashBowl;
    g.ash = 0; g.ashBowl = 0;
    logEvent(s, `Emptied ${(had * 1000).toFixed(0)} g of cold ash out of the bowl. The vents are clear again.`, 'action');
    return true;
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
    Oil.sync(s.pan);
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
    if (patty.where === 'pan' || patty.where === 'cut' || (patty.assembly?.length || patty.assembledTo!=null)) return;
    const reheating = patty.where === 'rest' || patty.where === 'oven';
    if (reheating) { patty.restT = 0; patty.serveT = null; }
    if (!s.patties.includes(patty)) s.patties.push(patty);
    patty.where = 'pan'; patty.pos = pos || patty.pos || { x: 0, y: 0 };
    selectPatty(s, patty);
    patty.faceDown.stuck = true;
    patty.timeDown = 0;
    patty.dirtAtStart = panDirt(s.pan);
    if (patty.dirtAtStart > 0.002) logEvent(s, 'The pan is dirty: burnt bits from earlier tickets will stick to this crust and smoke.', 'warn');
    const Tunder = panTatXY(s, patty.pos.x, patty.pos.y);
    if (reheating) { logEvent(s, `Patty ${patty.id} back on the heat at ${centerT(patty).toFixed(1)} °C. The crust, juices and cooking history stay with it.`, 'action'); return; }
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
    const m0 = layerMass(p, 0);
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
    if(!s.grill) Oil.sweep(s.pan,p.pos,to.pos,p.D*.38);
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
    if(!s.grill) Oil.sweep(s.pan,it.pos,to.pos,it.D*.38);
    it.pos = { x: to.pos.x, y: to.pos.y };
    it.rings = footprintRings(s.pan, it.pos, it.D / 2); // the metal it draws from is the metal under it now
    it.Tat = ringsT(s.pan, it.rings) + (s.grill && s.pan.zoned ? zoneAt(s.pan, it.pos.x) : 0);
    // `overlap` is placement state, not a permanent property of the topping. A crowded item may
    // begin partly on the meat, but after it is dragged the heat-transfer area must describe the new
    // footprint. (slideTo normally finds clear metal; recalculating keeps this correct if that policy
    // changes later.)
    it.overlap = footprintOverlap(occupants(s, it), it.pos, it.Dcov / 2);
    it.contactF = clamp(1 - it.overlap, 0.1, 1);
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
    p.scrapeT = SCRAPE_TIME; p.scrapedFree = true; // ...and if the face is still raw when it goes back down, it welds again (see stepPatty)
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
    for (const k of ['T', 'w', 'w0c', 'fs', 'fl', 'fr', 'fat0c', 'p', 'dM', 'dC', 'dA', 'dG', 'Tpk']) { // Tpk too: the peak record belongs to the meat, not to 'the bottom'
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
      const fatOut = p.fr[c] * 0.7; p.fr[c] -= fatOut; p.lostFat += fatOut; if (s.grill) dripOnBed(s, p.pos.x, fatOut); else s.pan.oil += fatOut;
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
    } else if (s.grill) {
      // over bars the juice does not boil off in a pan: it falls through onto the coals, which is
      // where it goes in the model too (grill.juiceOnCoals / fatOnCoals, above)
      logEvent(s, `Pressed patty ${p.id} with the spatula. ${(expelled * 1000).toFixed(1)} g of juice went straight through the bars onto the coals — steam, a flare if there is fat with it, and that was flavour.`, expelled > 0.002 ? 'warn' : 'action');
    } else {
      logEvent(s, `Pressed patty ${p.id} with the spatula. ${(expelled * 1000).toFixed(1)} g of juice squeezed out and boiled off. That was flavour.`, expelled > 0.002 ? 'warn' : 'action');
    }
  }

  function removePatty(s, patty) {
    const p = patty || s.patty; if (!p || p.where !== 'pan') return;
    if (tearStuck(s, p, 1) > 0) logEvent(s, `Prised patty ${p.id} off the pan; the bottom crust stayed behind.`, 'warn');
    // over coals there is no pan to catch the fat wicked to the surface: it falls on the fire
    if (s.grill) s.grill.fatOnCoals += p.fatTop; else s.pan.oil += p.fatTop;
    p.fatTop = 0;
    p.where = 'rest'; p.restT = 0; if (s.patty === p) s.where = 'rest';
    for (let j = 0; j < p.Nr; j++) p.poolB[j] = 0; p.poolBottom = 0; p.dripAtRest = p.lostWaterDrip;
    p.faceDown.crispAtRest = p.faceDown.crisp; p.faceUp.crispAtRest = p.faceUp.crisp;
    p.peakCenter = Math.max(p.peakCenter, centerT(p));
    if (!s.patties.some((q) => q.where === 'pan')) s.rest.t = 0;
    logEvent(s, `Patty ${p.id} off the heat after ${fmtTime(p.cookTime)}. Centre ${centerT(p).toFixed(1)} °C. Resting — carry-over cooking begins.`, 'action');
  }

  // The oven uses the same meat grid, with convection and radiation on a rack.
  function setOven(s, target) {
    if (!Number.isFinite(target)) return false;
    s.oven ||= { T: s.env.Tamb, target: 0 };
    s.oven.target = target === 0 ? 0 : clamp(target, 80, 250);
    return true;
  }
  function putInOven(s, p = s.patty) {
    if (!p || p.assembly?.length || p.assembledTo!=null || !['pan', 'rest'].includes(p.where)) return false;
    if (p.where === 'pan') removePatty(s, p);
    s.oven ||= { T: s.env.Tamb, target: 0 };
    p.where = 'oven'; p.restT = 0; p.ovenTime ||= 0;
    if (s.patty === p) s.where = 'oven';
    logEvent(s, `Patty ${p.id} on the oven rack.`, 'action');
    return true;
  }
  function takeFromOven(s, p = s.patty) {
    if (!p || p.where !== 'oven') return false;
    p.where = 'rest'; p.restT = 0; p.dripAtRest = p.lostWaterDrip;
    p.faceDown.crispAtRest = p.faceDown.crisp; p.faceUp.crispAtRest = p.faceUp.crisp;
    if (s.patty === p) s.where = 'rest';
    logEvent(s, `Patty ${p.id} out of the oven. Resting.`, 'action');
    return true;
  }

  function addCheese(s, patty) {
    const p = patty || s.patty; if (!p || p.where !== 'pan' || p.cheeses.length + p.cheeseUnder.length >= 4) return false;
    const k = p.cheeses.length;
    p.cheeses.push({ T: s.env.Tamb, melt: 0, mass: 0.02, rot: k * 0.42 + (Math.random() - 0.5) * 0.2, overhang: 0, contact: 0, skirt: null });
    logEvent(s, k === 0 ? `Slice of American cheese on patty ${p.id} (20 g). Processed cheese softens around 45 °C and flows by 60 °C; a lid speeds it up.` : `Another slice on patty ${p.id} (${k + 1} on the stack, ${(20 * (k + 1))} g). The top of the pile heats through the slices under it.`, 'action');
    return true;
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
    const wr = p.w0c[c] > 0 ? p.w[c] / p.w0c[c] : 1, dry = wr >= 1 ? 0 : 1 - wr;
    // Fat that has not melted yet is waxy and stiff — but "not melted" is not a step at 42 °C. Beef
    // fat is a mixture of triglycerides with a melting range: it is hard out of the fridge, already
    // soft and greasy at room temperature, and only fully liquid in the fifties. The solid fraction
    // in the grid (p.fs) does not move until ~42 °C, so the waxiness is faded out over 15–35 °C
    // here instead — otherwise a 4 °C patty and a 25 °C one that has sat out come back with exactly
    // the same modulus, which is not what a hand feels.
    const wax = 1 - smooth(15, 35, p.T[c]);
    const solid = p.fs[c] / (p.w[c] + p.fs[c] + p.fl[c] + p.fr[c] + p.p[c] + 1e-12);
    return TOUCH.E0 * (1 + TOUCH.aF * wax * solid + TOUCH.aM * p.dM[c] + TOUCH.aC * p.dC[c] + TOUCH.aA * p.dA[c] + TOUCH.aW * dry);
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
    // a hand over a patty sees the patty: its top face, at 60–100 °C, fills the middle of the view and hides the metal and most of the coals under it
    const over = s.patties.find((q) => q.where === 'pan' && (q.pos.x - x) ** 2 + (q.pos.y - y) ** 2 < (q.D / 2) ** 2) || null;
    const Tmeat = over ? layerMean(over, over.T, over.Nz - 1) : null;
    if (s.grill) {
      const bed = bedAt(s, x), Rbed = pan.floorR * 0.88; // the bed is a little smaller than the grate it sits under
      const Fbars = vf(pan.floorR, HAND.z) * pan.barFrac;
      const Fbed = vf(Rbed, HAND.z + HAND.bedDrop) * (1 - pan.barFrac) * bed.view * (over ? 0.35 : 1);
      // the coals radiate from their grey ash skin, not from their glowing interior
      const Tash = Tamb + HAND.ash * (bed.Tfire - Tamb);
      const Tbar = over ? 0.4 * panTatXY(s, x, y) + 0.6 * Tmeat : panTatXY(s, x, y);
      rad = k * (Fbed * (p4(Tash + 273.15) - Tsk4) + Fbars * (p4(Tbar + 273.15) - Tsk4));
      conv = HAND.hFire * Math.max(0, bed.Tgas - HAND.Tskin);
      source = { Tbar, Tfire: bed.Tfire };
    } else {
      // at 8 cm most of the view is the metal within a hand's width of the spot; the rest of the
      // floor fills in the edges
      const Tlocal = over ? 0.35 * panTatXY(s, x, y) + 0.65 * Tmeat : panTatXY(s, x, y), Tsurf = 0.65 * Tlocal + 0.35 * pan.T;
      rad = k * pan.emiss * vf(pan.floorR, HAND.z) * (p4(Tsurf + 273.15) - Tsk4);
      conv = HAND.h * Math.max(0, Tamb + HAND.plume * (Tsurf - Tamb) - HAND.Tskin);
      source = { Tbar: Tlocal, Tfire: 0 };
    }
    const q = Math.max(1, rad + conv); // W/m²
    const seconds = clamp(HAND.stoll * Math.pow(q / 1000, -HAND.exp), 0.4, 60);
    const word = handWord(seconds, !!s.grill);
    return { seconds, word, flux: q, radiant: rad, convective: conv, ...source };
  }
  /**
   * What the count means, and it means different things over different heat. Over coals it is
   * the grill chart everybody learns — 2 s searing, 4 very hot, 6 hot, 8 medium — because a bed of
   * coals radiates at 600–700 °C and the flux at the hand tracks the fire. A pan is a warm plate,
   * not a fire: at 8 cm the flux off 200 °C metal is a fifth of a fire's, so the same count means a
   * far hotter surface. Measured on cast iron preheated on gas (a hot centre, a cooler rim): 20.6 s
   * at a 200 °C mean, 12.7 s at 250, 8.6 s at 300, 5.8 s at 360 (27 s over a pan that is 200 °C
   * edge to edge). So on a pan twenty seconds is the README's recipe temperature and eight seconds
   * is a pan past every oil's smoke point — which is why the words are on a pan scale here, and
   * not the grill's.
   */
  const HAND_WORDS = {
    grill: [[2.5, 'searing'], [4.5, 'very hot'], [6.5, 'hot'], [9, 'medium'], [16, 'moderate'], [Infinity, 'low']],
    pan: [[9, 'searing'], [13, 'very hot'], [17, 'hot'], [30, 'medium'], [42, 'moderate'], [Infinity, 'low']],
  };
  function handWord(seconds, grill) {
    for (const [lim, word] of HAND_WORDS[grill ? 'grill' : 'pan']) if (seconds < lim) return word;
    return 'low';
  }
  /** What a cook makes of the word, over a fire and over a pan. */
  const HAND_NOTES = {
    grill: {
      searing: 'you cannot keep it there at all. Anything laid on that is being branded, not cooked.',
      'very hot': 'a crust in a minute a side, and char in three if you forget it.',
      hot: 'about right under a patty.',
      medium: 'it will cook and it will brown, but slowly.',
      moderate: 'enough to cook something through; not enough to sear it.',
      low: 'meat laid on that would sweat and go grey before anything browned.',
    },
    pan: {
      searing: 'the metal is past 300 °C and past any oil\'s smoke point. A black crust in a minute, before the middle has moved.',
      'very hot': 'a fast, dark crust, and char in three minutes if you forget it. Turn it down for anything thick.',
      hot: 'a hard, fast sear — fine for a thin patty, a lot of heat for a thick one.',
      medium: 'about right under a patty: a proper crust in two or three minutes a side.',
      moderate: 'it will cook and it will brown, but slowly.',
      low: 'meat laid on that would sweat and go grey before anything browned.',
    },
  };
  /** Hold a hand over it and count, out loud, in the log. */
  function handTestAt(s, pos) {
    const h = handTest(s, pos);
    const where = s.grill ? 'the grate' : 'the pan';
    const note = HAND_NOTES[s.grill ? 'grill' : 'pan'][h.word];
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
    const on = s.patties.some((p) => p.where === 'pan') || s.items.some((it) => it.where === 'pan'); // a pan with only toppings on it still makes a noise
    // hysteresis, or a patty that is half dry would flip the description back and forth
    const mode = !on ? 'off'
      : d.boilNoise > (sc.mode === 'crackle' ? 0.12 : 0.28) ? 'crackle'
      : d.hiss > (sc.mode === 'hiss' ? 0.06 : 0.16) ? 'hiss' : 'quiet';
    if (mode === sc.mode || s.t - sc.t < SOUND_GAP) return;
    const was = sc.mode; sc.mode = mode; sc.t = s.t;
    if (mode === 'off' || !was || was === 'off') return; // something just laid on the metal has not "gone quiet": it has not started yet
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
    const flux = p.sc.cheeseFlux; // meat → slice → slice → air
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
    p.cheeseDrip = 0; // cheese that leaves the slice this step (only happens over a grate)
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
      const wr = w0c[c] > 0 ? wc / w0c[c] : 1, dryness = wr >= 1 ? 0 : 1 - wr; // a zero reference would make every dryness NaN and take the grid with it
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
    const qBotR = sc.qBotR, qPanR = sc.qPanR, TpanR = sc.TpanR, hcR = sc.hcR;
    let qBot = 0, qPan = 0, hc = 0;
    let TbotMean = 0; for (let j = 0; j < Nr; j++) TbotMean += T[j] * aj[j];
    const bb = bc.bottom, btype = bb.type;
    if (p.cheeseUnder.length) {
      const r = stepCheeseUnder(p, dt, bc, TbotMean);
      // the meat gets what came up through the slice stack; the metal is out the flux it put into
      // the *bottom* slice, which is a great deal more — warming 20–40 g of cheese and boiling the
      // water out of it has to come from somewhere, and it comes out of the pan
      for (let j = 0; j < Nr; j++) { qBotR[j] = r.qMeat * aj[j]; qPanR[j] = r.qPan * aj[j]; Q[j] += qBotR[j]; TpanR[j] = bb.T; }
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
        qBotR[j] = q; qPanR[j] = q; Q[j] += q; qBot += q; hc += hcR[j] * aj[j];
      }
      qPan = qBot;
    } else {
      for (let j = 0; j < Nr; j++) { const q = Aj[j] * (bb.h * (bb.T - T[j]) + (bb.rad ? 0.9 * C.sigma * bb.radView * (p4(bb.radT + 273.15) - p4(T[j] + 273.15)) : 0)); qBotR[j] = q; qPanR[j] = q; Q[j] += q; qBot += q; TpanR[j] = bb.T; }
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
      // under a lid the dome radiates onto the top slice as well as blowing hot air over it —
      // that is why a kettle lid melts cheese in seconds where open air takes a minute
      flux[m] = hTop * A * (TairTop - cs[m - 1].T)
        + (bc.top.rad ? A * 0.9 * C.sigma * bc.top.radView * ((bc.top.radT + 273.15) ** 4 - (cs[m - 1].T + 273.15) ** 4) : 0);
      qTop += flux[m];
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
    const setEnough = fd.brown >= 0.5 * (bb.release || 1) + 0.15 || dryMean > 0.6;
    if (fd.stuck && setEnough) fd.stuck = false;
    // a scraped face goes back onto the metal when the blade comes out; raw protein welds to hot
    // steel within seconds, so unless the crust has set in the meantime it is stuck again
    if (!fd.stuck && p.scrapedFree && p.scrapeT <= 0) { p.scrapedFree = false; if (!setEnough && (bb.release || 0) > 0) fd.stuck = true; }
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
    res.qTop = qTop; res.qBot = qPan; res.hc = hc; res.boilBottom = boilBottom / dt; res.evapTop = evapTop;
    res.fatDrip = fatDrip / dt; res.fatSide = fatSide / dt; res.juiceSide = juiceSide / dt; res.Ts = surfT; res.qSide = qSide;
    res.cheeseDrip = p.cheeseDrip / dt;
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
   *
   * `subMin` forces at least that many sub-steps: the instability guard's retry takes a step that
   * blew up again in eight pieces (see stepPattyGuarded).
   */
  function stepPattyStable(s, p, dt, bc, subMin) {
    const dz = p.h / p.Nz;
    const alphaMax = p.Tmin < 0 ? 1.3e-6 : 2.5e-7;
    const dtMax = (0.4 * dz * dz) / alphaMax;
    if (!subMin && dt <= dtMax) { p.subSteps = 1; return stepPatty(s, p, dt, bc); }
    const n = Math.max(1, subMin || 1, Math.min(64, Math.ceil(dt / dtMax)));
    p.subSteps = n;
    if (n === 1) return stepPatty(s, p, dt, bc);
    const h = dt / n, Nr = p.Nr, acc = p.sc.acc, accR = acc.qBotR, accP = acc.qPanR;
    acc.qTop = 0; acc.qBot = 0; acc.hc = 0; acc.boilBottom = 0; acc.evapTop = 0; acc.fatDrip = 0; acc.fatSide = 0; acc.juiceSide = 0; acc.cheeseDrip = 0; acc.Ts = 0; acc.qSide = 0;
    accR.fill(0); accP.fill(0);
    for (let k = 0; k < n; k++) {
      const r = stepPatty(s, p, h, bc);
      acc.qTop += r.qTop; acc.qBot += r.qBot; acc.hc += r.hc; acc.boilBottom += r.boilBottom; acc.evapTop += r.evapTop;
      acc.fatDrip += r.fatDrip; acc.fatSide += r.fatSide; acc.juiceSide += r.juiceSide; acc.cheeseDrip += r.cheeseDrip; acc.Ts += r.Ts; acc.qSide += r.qSide;
      for (let j = 0; j < Nr; j++) { accR[j] += r.qBotR[j]; accP[j] += r.qPanR[j]; }
    }
    // the caller wants rates and temperatures, so the sub-steps are averaged, not summed
    acc.qTop /= n; acc.qBot /= n; acc.hc /= n; acc.boilBottom /= n; acc.evapTop /= n;
    acc.fatDrip /= n; acc.fatSide /= n; acc.juiceSide /= n; acc.cheeseDrip /= n; acc.Ts /= n; acc.qSide /= n;
    for (let j = 0; j < Nr; j++) { accR[j] /= n; accP[j] /= n; }
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
    return cheeseFinite(p); // the slices are stepped with the patty and feed its boundaries
  }
  /** The step's returned fluxes feed the pan, so they have to be finite too. */
  function stepResultFinite(r) {
    for (const k in r) { const v = r[k]; if (k === 'qBotR' || k === 'qPanR') { if (!finiteArray(v)) return false; } else if (!Number.isFinite(v)) return false; }
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
    // the stability bound reads p.Tmin (set at the end of the step that just blew up, so it may be
    // NaN or nonsense): recompute it from the restored grid so a frozen patty keeps its ice bound
    let Tmin = Infinity; for (let c = 0; c < p.T.length; c++) if (p.T[c] < Tmin) Tmin = p.T[c]; p.Tmin = Tmin;
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
    // w0c and fat0c are the *reference* masses the cell was formed with — every dryness in the
    // model is a ratio against them — so a zero there is not a safe value, it is a division by
    // zero that would freeze the patty for the rest of the cook. Put the formed value back: the
    // cell's share of the raw mass at the mix it was made at.
    const fatF = clamp(p.fatFrac, 0.03, 0.5), waterF = (1 - fatF) * 0.745, mCell = p.massKg0 / p.Nz;
    for (let c = 0; c < p.T.length; c++) {
      const aj = p.aj[c % p.Nr];
      if (!(p.w0c[c] > 0)) p.w0c[c] = mCell * aj * waterF;
      if (!(p.fat0c[c] > 0)) p.fat0c[c] = mCell * aj * fatF;
    }
    for (const k of ['w', 'fs', 'fl', 'fr', 'p', 'poolB', 'poolT']) { const a = p[k]; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) a[i] = 0; }
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
    // a slice of cheese is stepped alongside the grid and its temperature feeds straight back into
    // the meat's bottom boundary: a non-finite one poisons every step and there is nothing in the
    // snapshot to roll it back to. Put it back on the meat it is lying against.
    sanitiseCheese(p, Tfill);
    let Tmin = Infinity; for (let c = 0; c < p.T.length; c++) if (p.T[c] < Tmin) Tmin = p.T[c]; p.Tmin = Tmin;
  }
  /** Every number a slice carries, re-seated on the meat's own temperature when it goes bad. */
  function sanitiseCheese(p, Tfill) {
    const topRow = (p.Nz - 1) * p.Nr;
    let Tbot = 0, Ttop = 0; for (let j = 0; j < p.Nr; j++) { Tbot += p.T[j] * p.aj[j]; Ttop += p.T[topRow + j] * p.aj[j]; }
    if (!Number.isFinite(Tbot)) Tbot = Tfill; if (!Number.isFinite(Ttop)) Ttop = Tfill;
    for (const [list, Tmeat] of [[p.cheeses, Ttop], [p.cheeseUnder, Tbot]]) {
      for (const ch of list) {
        if (!Number.isFinite(ch.T)) ch.T = Tmeat;
        for (const k of ['melt', 'mass', 'overhang', 'contact']) if (ch[k] != null && !Number.isFinite(ch[k])) ch[k] = k === 'mass' ? 0.02 : 0; // 20 g: one slice
        const sk = ch.skirt; if (!sk) continue;
        if (!Number.isFinite(sk.T)) sk.T = ch.T;
        if (!Number.isFinite(sk.water)) sk.water = CHEESE_WATER;
        for (const k of ['melt', 'brown', 'char', 'dry', 'charRate', 'mass']) if (!Number.isFinite(sk[k])) sk[k] = 0;
      }
    }
  }
  /** True when every slice on (or under) the patty is still made of numbers. */
  function cheeseFinite(p) {
    for (const list of [p.cheeses, p.cheeseUnder]) for (const ch of list) {
      if (!Number.isFinite(ch.T) || !Number.isFinite(ch.mass)) return false;
      const sk = ch.skirt;
      if (sk && (!Number.isFinite(sk.T) || !Number.isFinite(sk.water) || !Number.isFinite(sk.mass))) return false;
    }
    return true;
  }
  const ZERO_STEP = (p) => ({ qTop: 0, qBot: 0, qBotR: new Float64Array(p.Nr), qPanR: new Float64Array(p.Nr), hc: 0, boilBottom: 0, evapTop: 0, fatDrip: 0, fatSide: 0, juiceSide: 0, cheeseDrip: 0, Ts: p.surfT || 0, qSide: 0 });
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
    else if (!cheeseFinite(p)) { sanitiseCheese(p, centerT(p)); g.sanitised++; } // the snapshot does not carry the slices; put them back on the meat
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
   * How much air the fire is getting, 0..1, as an opening. With the lid off it is the bottom vent
   * (the knob) and nothing else. With the lid on the bottom and top vents are two orifices in
   * series, so the flows add as 1/A² = 1/A₁² + 1/A₂², i.e. A = A₁A₂/√(A₁²+A₂²): a smooth minimum.
   * Shutting either one shuts the fire down; opening one wide does not rescue the other. Both wide
   * gives 0.77 of an open kettle: 0.71 for the two orifices in series, plus the 6 % that goes past
   * the lid whatever the vents are doing. That is about what a lid costs. COAL.leak is that leak past a lid
   * that never quite seats, and it is the reason a smothered kettle takes minutes to go out and not
   * seconds.
   */
  function ventFlow(s) {
    const vb = clamp(s.stove.knob / 10, 0, 1), vt = clamp(s.grill.topVent, 0, 1);
    return s.lid ? COAL.leak + (vb * vt) / Math.sqrt(vb * vb + vt * vt + 1e-6) : vb;
  }

  /**
   * The coal bed. Airflow (the vents, in series when the lid is on) sets the temperature the bed
   * heads for and how fast it eats the charcoal. Ash chokes it from below: it falls through the fire
   * and blankets the lumps, and what matters is how much of it there is relative to the coal left,
   * not its absolute mass — so a fresh deep bed swallows its own ash for a long time and a
   * half-spent one is strangled by it. Raking knocks the ash off and the fire glows up for a minute.
   * Cold coals dumped on it are a heat sink until they catch. Fat that falls on a hot bed flares:
   * a few grams within seconds is a foot of yellow flame that licks the meat, dies back in seconds,
   * and leaves soot.
   */
  function stepCoals(s, dt) {
    const g = s.grill, Tamb = s.env.Tamb;
    if (!g.lit && s.stove.knob > 0) { g.lit = true; g.litAt = s.t; logEvent(s, 'A chimney of lit lump charcoal dumped in and raked out under the grate. Open the vents and wait for the bed to glow.', 'action'); }
    // ash in the bed, as a fraction of what is in there: a tenth by mass is a properly choked fire
    const choke = clamp((g.ash / (g.ash + g.coal + g.unlit + 1e-9)) / COAL.ashChoke, 0, 1);
    g.stir = Math.max(0, g.stir - dt / COAL.stirTau);
    const vEff = ventFlow(s);
    const air = clamp((0.12 + 0.88 * vEff) * (1 - 0.45 * choke) * (1 + 0.35 * g.stir), 0, 1);
    g.air = air;
    // How completely the volatiles burn. An open fire lights them as they come off the fuel and what
    // leaves is thin and blue; a starved one lets them out cold and white, and they condense as tar
    // on whatever is above them. 0.16 is the bottom of the range (a lid with everything shut).
    g.comb = smooth(0.16, 0.5, air);
    if (!g.lit) { g.burnW = 0; g.flare = Math.max(0, g.flare - dt); g.smoke = 0; g.sizzle = 0; stepWood(s, dt); stepSmokeTank(s, dt); return; }
    const alive = clamp(g.coal / 0.25, 0, 1);
    // and how deep the bed is: a deeper one runs hotter at the same draught, because there is more
    // incandescent surface for the same air and less of that air slips through it cold. A chimney of
    // lump settles to its working depth in the first few minutes as the loose lumps on top burn off,
    // so the reference is ~80 % of what went in: a bed burnt down to a third of a chimney has lost
    // about 7 % of its rise over ambient, and a fresh top-up buys that straight back.
    const size = 0.90 + 0.10 * clamp(g.coal / (0.8 * g.coal0), 0, 1.5);
    const target = Tamb + (300 + 430 * air) * alive * size; // ~350 °C banked, ~750 °C wide open
    const tau = target > g.Tfire ? COAL.tauUp * (s.t - g.litAt < 90 ? 0.4 : 1) : COAL.tauDown;
    g.Tfire += ((target - g.Tfire) * dt) / tau;
    // cold coals: a lumped pile heated by the bed, taking that heat straight out of it. 0.5 kg from
    // 20 °C to ignition is 0.5 × 840 × 330 ≈ 140 kJ, which a bed finds in three or four minutes.
    if (g.unlit > 1e-6) {
      const qIn = COAL.hUnlit * g.unlit * Math.max(0, g.Tfire - g.unlitT);
      g.unlitT += (qIn * dt) / (g.unlit * COAL.cp);
      g.Tfire -= (qIn * dt) / (Math.max(g.coal, 0.05) * COAL.cp);
      if (g.unlitT > COAL.Tignite) {
        const caught = Math.min(g.unlit, (g.unlit * dt) / COAL.tauCatch);
        g.unlit -= caught; g.coal += caught;
        if (!g._caughtLog) { g._caughtLog = true; logEvent(s, 'The new coals have caught: grey at the edges, glowing underneath. The bed is coming back up.', 'good'); }
      }
    } else g._caughtLog = false;
    const burn = ((0.35 + 1.4 * air) / 3600) * alive; // kg/s: a chimney lasts 45 min flat out, two hours banked
    const used = Math.min(g.coal, burn * dt); g.coal -= used; g.burnW = (used / dt) * COAL.H * 0.3;
    // the mineral ash it leaves: half of it falls through into the bowl, half stays up in the fire
    const madeAsh = used * COAL.ashYield;
    g.ash += madeAsh * COAL.ashStay; g.ashBowl += madeAsh * (1 - COAL.ashStay);
    // fat on the coals: ignites above ~450 °C; the flare grows with the amount and dies in seconds
    const hot = clamp((g.Tfire - 450) / 250, 0, 1);
    const ignite = Math.min(g.fatOnCoals, g.fatOnCoals * Math.min(1, dt * (0.1 + 2 * hot)));
    g.fatOnCoals -= ignite; g.fatOnCoals *= Math.exp(-dt / 30); // what does not burn soaks into the ash
    const flareTarget = (ignite / dt) * 2000 * hot; // 0.5 g/s of burning fat is a foot of flame
    g.flare += ((flareTarget - g.flare) * dt) / (flareTarget > g.flare ? 0.5 : 1.5);
    g.flareTotal += ignite * hot;
    const juice = g.juiceOnCoals || 0; g.juiceOnCoals = 0;
    g.sizzle = clamp(juice * 400 / dt, 0, 1) * 0.6;
    stepWood(s, dt);
    stepSmokeTank(s, dt, alive);
    g.smoke = 0.12 * alive + clamp(g.flare, 0, 2) * 0.7 + clamp(juice / dt * 30, 0, 0.3) + (g.fatOnCoals > 0.001 && hot < 0.3 ? 0.4 : 0)
      + clamp(g.smokeConc / SMOKE.dense, 0, 2.5);
    if (g.flare > 0.6 && (!g._flareLogT || s.t - g._flareLogT > 20)) { g._flareLogT = s.t; logEvent(s, `FLARE-UP: fat hit the coals and lit. Flames up through the grate, licking the meat${s.lid ? ' under the lid' : ''}. Move it or close the vents.`, 'warn'); }
    if (g.coal < 0.2 && !g._lowLogged) { g._lowLogged = true; logEvent(s, 'The coals are burning down to ash. The bed is cooling; whatever is not cooked yet had better be close.', 'warn'); }
    // the cue that matters and costs nothing to see: white smoke means the fire is starved
    if (g.comb < 0.3 && g.smokeConc > 2e-4 && (!g._acridLogT || s.t - g._acridLogT > 90)) {
      g._acridLogT = s.t;
      logEvent(s, `Thick white smoke${s.lid ? ' seeping out from under the lid' : ''}. That is unburnt tar, not flavour — it will settle on the meat as creosote and taste of a bonfire. Open a vent.`, 'warn');
    }
    if (g.ash / (g.ash + g.coal + 1e-9) > 0.09 && !g._ashLogged) { g._ashLogged = true; logEvent(s, `The bed is choking on its own ash (${(g.ash * 1000).toFixed(0)} g of it in among ${(g.coal * 1000).toFixed(0)} g of coal). It is running cool and burning slowly at the same vent setting: rake it through.`, 'warn'); }
    if (g.ash / (g.ash + g.coal + 1e-9) < 0.05) g._ashLogged = false;
    if (g.coal > 0.3) g._lowLogged = false; // a top-up means the warning can be earned again
  }
  /**
   * Every chunk of wood on the bed, one lumped node each. It takes heat from the fire by radiation
   * over the part of its surface that faces the coals plus convection from the gas around it; that
   * heat first boils the wood's own water off (pinned at 100 °C, full latent heat, like everything
   * else in here), then takes it up to pyrolysis. Past ~300 °C it smoulders: the rate follows the
   * remaining surface (m^⅔, because a smouldering front lives on the surface), so the smoke peaks
   * once the chunk is fully alight and decays as it is consumed. Pyrolysis is endothermic, which is
   * what holds a smouldering chunk in the 350–450 °C band instead of running away to the bed's
   * temperature. What is left when it is done is charcoal, and that joins the bed as fuel.
   */
  function stepWood(s, dt) {
    const g = s.grill, list = g.woods; if (!list.length) return;
    const Tamb = s.env.Tamb, Tgas = Tamb + 0.5 * (g.Tfire - Tamb), Tf4 = p4(g.Tfire + 273.15);
    for (let i = 0; i < list.length; i++) {
      const wd = list[i];
      if (wd.m <= 1e-6) { wd.smoke = 0; continue; }
      const f = clamp(wd.m / wd.m0, 0, 1), A = wd.A0 * Math.cbrt(f * f); // surface ∝ m^⅔
      let q = A * (0.85 * C.sigma * SMOKE.view * (Tf4 - p4(wd.T + 273.15)) + SMOKE.hGas * (Tgas - wd.T));
      const Cw = wd.m * SMOKE.cp + wd.water * C.cpW;
      if (wd.water > 1e-7 && wd.T >= C.Tboil - 0.5 && q > 0) {
        // pinned at the boiling point until the chunk is dry: 7 g of water in a chunk is 16 kJ
        const boil = Math.min(wd.water, (q * dt) / C.Lvap);
        wd.water -= boil; q -= (boil * C.Lvap) / dt;
        wd.T = Math.min(wd.T, C.Tboil);
      }
      // smoulder: nothing below ~260 °C, everything by ~400 °C. A starved fire smoulders more slowly
      // and dirtier; an open one burns the volatiles as they leave and eats the chunk faster.
      const lit = smooth(SMOKE.Tpyro - 40, SMOKE.Tpyro + 100, wd.T);
      const rate = SMOKE.burn * Math.cbrt(f * f) * lit * (0.55 + 0.45 * g.air);
      const used = Math.min(wd.m, rate * dt);
      wd.m -= used; wd.lit = lit;
      q -= (used / dt) * SMOKE.Hpyro;
      wd.T += (q * dt) / Math.max(Cw, 1);
      g.coal += used * SMOKE.char;
      // smoke solids and condensables off it: a few per cent of the mass burnt, two and a half times
      // that when there is not enough air to burn the volatiles as they come off
      wd.smoke = (used / dt) * SMOKE.yield * (1 + SMOKE.dirty * (1 - g.comb)) * wd.spec.intensity;
      if (!wd.caught && lit > 0.5) {
        wd.caught = true;
        logEvent(s, `The ${wd.spec.name.toLowerCase()} has caught — it took ${fmtTime(s.t - wd.t0)} to dry out and reach pyrolysis. `
          + (g.comb > 0.6 ? 'Thin blue smoke off it: the volatiles are burning on the way out, and that is the smoke you want.' : 'White smoke off it — there is not enough air to burn what is coming off the wood, and that is the smoke you do not want.'), g.comb > 0.6 ? 'good' : 'warn');
      }
      if (wd.m <= 1e-6 && !wd.spent) {
        wd.spent = true; wd.m = 0;
        logEvent(s, `The ${wd.spec.name.toLowerCase()} chunk is spent after ${fmtTime(s.t - wd.t0)} — a handful of charcoal where it was. Another one if you want more smoke.`, 'info');
      }
    }
  }
  /**
   * The smoke under the dome, as a stirred tank: dC/dt = (S − C·Q)/V, one tank per kind of wood so
   * the flavour can be attributed to the wood that made it. V is the ~30 litres over the grate. Q is
   * what carries the smoke away: with the lid off, the plume off the bed (fast — most of the smoke
   * never touches the meat); with the lid on, what the vents draw through, which is what puts smoke
   * over the food in the first place. Shut the top vent and Q collapses to the leak past the lid,
   * the concentration goes up by a factor of twenty, and the meat is sitting in it.
   */
  function stepSmokeTank(s, dt, alive) {
    const g = s.grill, conc = g.conc;
    const Q = s.lid ? SMOKE.Qleak + SMOKE.Qlid * ventFlow(s) : SMOKE.Qopen;
    const k = dt / SMOKE.V;
    for (let i = 0; i < g.woods.length; i++) { const wd = g.woods[i]; if (wd.smoke > 0) conc[wd.kind] += wd.smoke * k; }
    // the charcoal's own smoke: almost nothing while it is drawing properly, a haze when it is not
    conc.bed += SMOKE.bed * (alive || 0) * (0.12 + 0.88 * (1 - g.comb)) * k;
    let tot = 0;
    for (let i = 0; i < SMOKE_KINDS.length; i++) {
      const kd = SMOKE_KINDS[i];
      conc[kd] = Math.max(0, conc[kd] - conc[kd] * Q * k);
      tot += conc[kd];
    }
    g.smokeConc = tot;
  }
  /**
   * What lands on a patty over the fire. Smoke deposits on meat at a velocity of a couple of
   * millimetres a second — impaction of the particles plus thermophoresis of the condensables onto a
   * surface that is cooler than the gas — and far better while the surface is still cool and wet,
   * which is why smoke goes into meat early and stops mattering once the crust has dried. And it
   * saturates: past a few tenths of a gram per square metre the smoke is landing on tar, not meat.
   */
  function depositSmoke(s, p, dt) {
    const g = s.grill, conc = g.conc, by = p.smokeBy;
    const wet = 0.3 + 0.7 * clamp(layerMean(p, p.w, p.Nz - 1) / layerMean(p, p.w0c, p.Nz - 1), 0, 1);
    const sat = 1 / (1 + p.smokeDep / (6 * SMOKE.ref));
    const k = SMOKE.vDep * wet * sat * dt;
    let tot = 0, creo = 0;
    for (let i = 0; i < SMOKE_KINDS.length; i++) {
      const kd = SMOKE_KINDS[i], d = k * conc[kd];
      by[kd] += d; tot += d;
      // volatiles that never found any air condense on the meat as tar — but only the wood's do:
      // the bed's own starved smoke is soot off charcoal that gave up its volatiles in the kiln
      creo += d * (1 - g.comb) * (kd === 'bed' ? SMOKE.creoBed : 1);
    }
    p.smokeDep += tot; p.creoDep += creo;
  }
  /**
   * What is coming off the kettle, in words — the same two numbers the renderer colours the plume
   * with. Volatiles that burn on their way out leave thin blue smoke; volatiles that never find
   * any oxygen leave thick white smoke that smells of a bonfire and tastes worse.
   */
  function smokeName(s) {
    const g = s.grill; if (!g || g.smokeConc < 8e-6) return '';
    const thick = g.smokeConc > 3e-4;
    return g.comb > 0.7 ? (thick ? 'heavy blue smoke' : 'thin blue smoke')
      : g.comb > 0.35 ? (thick ? 'thick grey smoke' : 'grey smoke')
        : (thick ? 'thick white acrid smoke' : 'white acrid smoke');
  }
  /** Smokiness and creosote as indices: 1.0 is one clean chunk's worth over a five-minute cook. */
  function smokeRead(p) {
    // the flavour index is what the *wood* laid down, plus the smaller charcoal taste of the bed's
    // own smoke: the deposit is real either way, but it is not the same seasoning
    const by = p.smokeBy;
    const sm = (by.hickory + by.apple + by.mesquite + SMOKE.flavBed * by.bed) / SMOKE.ref, cre = p.creoDep / SMOKE.ref;
    let kind = null, best = 0;
    for (let i = 0; i < 3; i++) { const kd = SMOKE_KINDS[i]; if (p.smokeBy[kd] > best) { best = p.smokeBy[kd]; kind = kd; } }
    return { smokiness: sm, creosote: cre, wood: kind, clean: sm - cre };
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
   * of bed is ~13 kJ/(m²K), so a strip on its own would settle in a couple of minutes. It is not on
   * its own: conduction along the bars (50 W/mK through 4 mm of steel over a 6 cm strip,
   * ~60 W/(m²K)) pulls neighbours together on a ~100 s time constant, so the zones blur at the
   * boundary but survive — and the split takes far longer to arrive than one bar would. Measured
   * after banking at vents 7: 53, 92, 121, 142 K apart at one-minute marks, 188 K settled at eight
   * to ten minutes (228 K at vents 9), which is about how long a real kettle takes to set two zones
   * up once the bars over the bare half have had time to give their heat back.
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
      // What a rasher keeps. Cooked streaky bacon is still about 40 % fat and 12–15 % water by
      // weight: frying it crisp renders 50–65 % of the fat and drives off 60–70 % of the water, and
      // what is left — 25 g in, a little under half of that out — is the strip you eat. The rest of
      // the fat is intramuscular and stays in the shrunken lean however long it sits there, and the
      // rest of the water is bound in the protein, which is why bacon does not simply keep going
      // until there is nothing left of it.
      fatBound: 0.40,                                // of fat0: never leaves the strip
      waterBound: 0.30,                              // of the water: bound in the lean, not free to boil
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
      // What stops a fried egg boiling itself dry. Liquid white wets the metal completely — that is
      // the 320 above, and the first sizzle. The moment it gels it stops behaving like a liquid:
      // the gel blisters, steam collects under it and it curls off the metal, so the contact
      // collapses to under a third of what the raw white had (≈96 W/(m²K), well under meat's 380 and
      // a bun crumb's 170), and a dried, browned film under it insulates further. That is what
      // holds the boil-off near a gram a minute instead of five: a large egg goes 55 g in, 47–49 g
      // out (USDA has 50 g raw → 46 g fried), i.e. 10–15 % of its mass. What is left is bound in
      // the protein network and does not simply keep leaving.
      setLift: 0.70, skinLift: 0.35,                 // how much of the contact the set gel and then the dry skin take away
      whiteBound: 0.45,                              // of a set white's water: held in the gel, never free to boil
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
   * It is a ceiling on *overshoot*, not a thermostat: a node may never be pushed past the thing
   * heating it, but nothing that is merely sitting next to something cooler is dragged down to it
   * in one step — off the heat an item cools by its own losses, over minutes, like everything else.
   *
   * `wFree` is how much of the node's water is actually free to leave it this step. A protein gel
   * (set egg white, the lean of a rasher) holds most of its water in the network and only gives up
   * what has reached the frying surface; the rest is not available to boil however hot the metal
   * is, so the heat that would have gone into latent load goes into temperature instead — which is
   * exactly why a drying face runs away from 100 °C. Defaults to all of it (free liquid water).
   * Returns the water boiled off, in kg.
   */
  function heatNode(n, q, dt, cpDry, Tcap, wFree) {
    const Ccap = n.m * cpDry + n.w * C.cpW + 1e-9;
    const T0 = n.T;
    let Tn = n.T + (q * dt) / Ccap;
    let boiled = 0;
    const avail = wFree == null ? n.w : Math.min(n.w, Math.max(0, wFree));
    if (Tn > C.Tboil && avail > 1e-9) {
      const excess = Ccap * (Tn - C.Tboil);
      boiled = Math.min(avail, excess / C.Lvap);
      n.w -= boiled;
      Tn = C.Tboil + (excess - boiled * C.Lvap) / Ccap;
    }
    if (Tcap != null && Tn > Math.max(Tcap, T0)) Tn = Math.max(Tcap, T0);
    n.T = Tn;
    return boiled;
  }
  function nodeDry(n, w0) { return w0 > 1e-12 ? clamp(1 - n.w / w0, 0, 1) : 1; }
  /** The same, over the water that was ever free to leave: how dry the frying face itself is. */
  function nodeDryFree(n, w0, bound) { const f = w0 - bound; return f > 1e-12 ? clamp(1 - (n.w - bound) / f, 0, 1) : 1; }

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
      flips: 0, cookTime: 0, timeDown: 0, restT: 0, overlap: 0, contactF: 1,
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
  /**
   * How dry the face an item has against the metal is, 0..1 — the same thing `dryDownAll` reads off
   * a patty's bottom layer, and the thing that decides whether what you can hear is water boiling
   * or fat frying.
   */
  function itemDryness(it) {
    const sp = it.spec;
    if (it.kind === 'bun') return nodeDry(it.face, it.w0f);
    if (it.kind === 'bacon') return nodeDryFree(it.body, it.w0, sp.waterBound * it.w0);
    if (it.kind === 'egg') return nodeDryFree(it.wBot, it.w0b, sp.whiteBound * it.w0b * it.setBot);
    if (it.kind === 'onions') return nodeDry(it.bot, it.w0bot);
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
  function occupants(s, exclude) {
    const out = [];
    for (const p of s.patties) if (p !== exclude && p.where === 'pan') out.push({ pos: p.pos, r: p.D / 2 });
    for (const it of s.items) if (it !== exclude && it.where === 'pan') out.push({ pos: it.pos, r: it.Dcov / 2 });
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
    return { pos: best, gap: bestGap, overlap: footprintOverlap(taken, best, rad) };
  }
  /**
   * How much of a footprint of radius `rad` at `pos` is lying on top of something else, as a
   * fraction of its area, sampled on the same equal-area polar grid footprintRings uses. On a
   * crowded pan there is nowhere clear to put a bun, and what a cook then does is lay it half on
   * the meat — where it is against 70 °C beef, not 200 °C metal, and cooks accordingly.
   */
  function footprintOverlap(taken, pos, rad) {
    if (!taken.length) return 0;
    const nr = 4, na = 8; let on = 0;
    for (let i = 0; i < nr; i++) {
      const rr = rad * Math.sqrt((i + 0.5) / nr);
      for (let a = 0; a < na; a++) {
        const ang = (a / na) * Math.PI * 2, x = pos.x + rr * Math.cos(ang), y = pos.y + rr * Math.sin(ang);
        for (const q of taken) if (hyp(x - q.pos.x, y - q.pos.y) < q.r) { on++; break; }
      }
    }
    return on / (nr * na);
  }

  /** Put a topping in the pan. Buns go in as a pair of halves, cut side down. */
  function addItem(s, kind, opts) {
    if (!ITEMS[kind]) return null;
    const loose = s.items.filter(it => it.kind === kind && (kind !== 'bun' || it.assembledTo == null));
    if (kind === 'bun' ? new Set(loose.map(it=>it.pair)).size >= 2 : loose.length >= 4) return [];
    const made = [];
    // a bun goes in as two halves of one bun and it has to come out as two halves of one bun: they
    // carry a shared pair id so the build never sends the heel to one burger and the crown to another
    const pair = kind === 'bun' ? (s._pairSeq = (s._pairSeq || 0) + 1) : null;
    for (const extra of kind === 'bun' ? [{ half: 'bottom' }, { half: 'top' }] : [{}]) {
      const it = makeItem(kind, { ...(opts || {}), ...extra, id: (s._itemSeq = Math.max(s._itemSeq || 0, ...s.items.map(o => o.id), 0) + 1) });
      const { pos, gap, overlap } = freeSpot(s, it.Dcov / 2);
      it.pos = pos; it.rings = footprintRings(s.pan, pos, it.D / 2);
      it.Tat = ringsT(s.pan, it.rings);
      // the part of it that is lying on the meat (or on another topping) is not touching the metal
      // at all: it draws no pan heat and takes none out of the rings. A tenth of the footprint is
      // left as contact whatever happens — something is always in touch with the pan at the edge.
      it.overlap = overlap; it.contactF = clamp(1 - overlap, 0.1, 1);
      it.pair = pair;
      s.items.push(it); made.push(it);
      // The cover circles are drawn generously (a bun's Dcov is wider than the face that touches the
      // metal), so a few millimetres of gap is a rasher resting against a bun, not a topping
      // stranded on the meat: warning about 3 % and calling it "half on top" was crying wolf. A
      // tenth of the footprint off the metal is where the ring heat it draws starts to lag enough
      // to see, so that is where the line goes — and the word matches the number.
      if (overlap > 0.1) logEvent(s, `No room: the ${it.label.toLowerCase()} is lying ${overlap > 0.35 ? 'half' : 'partly'} on top of something else — ${(overlap * 100).toFixed(0)} % of it is off the metal and will not cook. Crowd a pan and nothing browns.`, 'warn');
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
  /** Return a topping from the pass without replacing its cooked state. */
  function reheatItem(s, it) {
    if (!it || it.where !== 'rest' || it.assembledTo != null || !s.items.includes(it)) return false;
    const { pos, overlap } = freeSpot(s, it.Dcov / 2);
    it.pos = pos; it.rings = footprintRings(s.pan, pos, it.D / 2);
    it.overlap = overlap; it.contactF = clamp(1 - overlap, 0.1, 1);
    it.where = 'pan'; it.restT = 0; it.timeDown = 0; it.serveT = null;
    logEvent(s, `${it.label} back on the heat.`, 'action');
    return true;
  }
  /** Discard the selected topping; paired buns leave together. Residue stays on the pan. */
  function discardItem(s, it) {
    if (!it || it.where === 'cut' || !s.items.includes(it)) return false;
    for (const p of s.patties) if (p.assembly?.some(l => l.item === it || (it.pair != null && l.item?.pair === it.pair))) Assembly.unpack(p);
    const discarded = s.items.filter(o => o === it || (it.pair != null && o.pair === it.pair));
    let mass = 0;
    for (const o of discarded) { mass += itemMass(o); if (o.where === 'pan') removeItem(s, o); }
    s.items = s.items.filter(o => !discarded.includes(o));
    if (discarded.includes(s.item)) s.item = null;
    s.wasteG = (s.wasteG || 0) + mass * 1000;
    logEvent(s, `Discarded ${it.pair != null ? 'both bun halves' : it.label.toLowerCase()} (${(mass * 1000).toFixed(0)} g). Add a fresh replacement from Extras.`, 'action');
    return true;
  }
  /** The build step: this topping belongs on that burger. */
  function assignTopping(s, it, patty) { if (!it || !patty) return false; for (const o of s.items) if (o === it || (it.pair != null && o.pair === it.pair)) o.burger = patty.id; return true; }
  /** Whichever burger it came off the pan next to, when the cook has not said otherwise. */
  function nearestBurger(s, it) {
    let best = null, bestD = Infinity;
    const pos = it.restPos || it.pos;
    for (const p of s.patties) { const d = hyp(p.pos.x - pos.x, p.pos.y - pos.y); if (d < bestD) { bestD = d; best = p; } }
    return best;
  }
  /**
   * Which burger a topping is going to end up on if the cook never says otherwise. Nearest to where
   * it came off the pan, with one exception: the two halves of a bun stay together, and the pair
   * goes wherever the heel goes (or wherever either half has been assigned by hand). A burger with
   * a crown and no heel is not a burger — it goes out with nothing under it, takes the untoasted
   * soak factor, and the burger that got the heel goes out with no top.
   *
   * `serve` uses this, and the build row shows it, so the cook can see the default while there is
   * still time to change it.
   */
  function plannedBurger(s, it) {
    if (it.burger != null) return s.patties.find((p) => p.id === it.burger) || null;
    if (it.pair != null) {
      const mate = s.items.find((o) => o !== it && o.pair === it.pair);
      if (mate) {
        if (mate.burger != null) return s.patties.find((p) => p.id === mate.burger) || null;
        return nearestBurger(s, it.half === 'bottom' ? it : mate.half === 'bottom' ? mate : it);
      }
    }
    return nearestBurger(s, it);
  }
  /** The toppings built onto one burger, in the order they are stacked. */
  function toppingsOf(s, patty) {
    if (patty.manualAssembly) return Assembly.hasPatty(patty) ? Assembly.layers(patty).filter(l => l.item).map(l => l.item) : [];
    const order = { onions: 0, bacon: 1, egg: 2, bun: 3 };
    return s.items.filter((it) => it.burger === patty.id).sort((a, b) => order[a.kind] - order[b.kind]);
  }

  // ---- the four step functions; each gets the same boundary object a patty gets
  /** Heat into an item's underside from whatever it is sitting on, in W. */
  function itemQBottom(it, bc, hc, A0, Tf) {
    const bb = bc.bottom;
    const A = A0 * (it.contactF == null ? 1 : it.contactF); // only the part actually on the metal
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
  function topH(bt, T) { if(bt.insulated)return 0; return bt.h + (bt.RH > 0.9 && bt.T > T ? 200 : 0); }
  /** The hottest thing an item's contact node is touching — what it may not overshoot. */
  function bottomCap(bc) { const bb = bc.bottom; return bb.type === 'grill' ? Math.max(bb.Tbar, bb.Tsurf) : Math.max(bb.T,bb.internalCap||0); }
  /** A face's surface temperature: the node extrapolated out to the metal, capped by the metal. */
  function itemSurfT(Tnode, q, A, k, dzHalf, wet, cap) {
    let Ts = Tnode + (Math.max(0, q) / A) * (dzHalf / Math.max(k, 0.03));
    if (wet) Ts = Math.min(Ts, C.Tboil + 2);
    return Math.min(Ts, Math.max(cap, Tnode)); // the metal caps the surface; air under a resting item does not cool it instantly
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
      it.fatSoaked += Oil.take(s.pan,it,take);
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
    const wBound = sp.waterBound * it.w0; // bound in the lean: the free water is what can boil
    const q = itemQBottom(it, bc, hc, A, b.T);
    const bt = bc.top;
    const qTop = topH(bt, b.T) * Atop * (bt.T - b.T) + (bt.rad ? Atop * 0.9 * C.sigma * bt.radView * (p4(bt.radT + 273.15) - p4(b.T + 273.15)) : 0);
    const cap = Math.max(bottomCap(bc), bt.T);
    const boiled = heatNode(b, q + qTop, dt, sp.cpDry, cap, b.w - wBound);
    it.lostWater += boiled; it.steam = boiled / dt;
    const T = b.T;
    // melt → release → drain: the patty's own kinetics, with the bands of a rasher for cells
    const E3 = Math.exp((61 - T) / 3);
    if (it.fs > 0) { const r = (0.06 * dt) / (1 + E3 * K_FATMELT); const melt = it.fs * Math.min(1, r); it.fs -= melt; it.fl += melt; }
    // ...but only the fat in the bands between the muscle can ever leave: what is inside the lean
    // stays there, so the release stops once the renderable share is out of the tissue
    const relRoom = Math.max(0, it.fat0 * (1 - sp.fatBound) - (it.fr + it.lostFat));
    if (it.fl > 0 && relRoom > 0) { const kRel = (0.0035 * sp.relMul * dt * (1 + (T > 66 ? T - 66 : 0) / 40)) / (1 + Math.sqrt(E3 * K_FATREL)); const rel = Math.min(relRoom, it.fl * Math.min(1, kRel)); it.fl -= rel; it.fr += rel; }
    if (it.fr > 0) { const out = it.fr * Math.min(1, 0.35 * dt * clamp((T - 38) / 50, 0.05, 1.6)); it.fr -= out; it.lostFat += out; it.dFat += out; }
    // dryness and rendering are read against what was ever free to go: a rasher that has given up
    // all the water and all the fat it is going to give up is crisp, whatever is still locked in it
    const dry = nodeDryFree(b, it.w0, wBound), fatOut = clamp(it.lostFat / (it.fat0 * (1 - sp.fatBound)), 0, 1);
    const Ts = itemSurfT(T, q, Math.max(A, 1e-4), sp.kMeat, sp.thickMm / 4000, b.w - wBound > 0.25 * (it.w0 - wBound), bottomCap(bc));
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
    // a set gel touches the metal far less well than the liquid white did — it bubbles, lifts and
    // rides on its own steam — and once the film against the metal has dried and browned it is a
    // sheet of dry albumen between the pan and the wet gel above it
    const wbBound = sp.whiteBound * it.w0b * it.setBot;   // water locked into the gel as it sets: none of it while the white is still liquid
    const wtBound = sp.whiteBound * it.w0t * it.setTop;
    const skinDry = nodeDryFree(wb, it.w0b, wbBound);
    const hc = sp.hc * (1 + 0.4 * oilFilm) * (1 - sp.setLift * it.setBot) * (1 - sp.skinLift * skinDry);
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
    if (bt.RH < 0.99 && wt.w - wtBound > 1e-9) {
      const drive = Math.max(0, rhoVapSat(wt.T) - bt.RH * rhoVapSat(bt.T));
      // free water off the top face only, and not at a free surface's rate: once the top has gelled
      // the water has to come up through set protein to leave, so the effective mass transfer falls
      // to about a quarter of a puddle's. That is why a fried egg comes off the pan moist instead
      // of losing a gram a minute off the top of it for as long as it sits there.
      const aw = 0.25 + 0.75 * (1 - it.setTop);
      evap = Math.min(wt.w - wtBound, C.hMass * aw * Awhite * drive * dt);
      wt.w -= evap; it.lostWater += evap;
    }
    const cap = Math.max(bottomCap(bc), bt.T);
    const bBot = heatNode(wb, q - qwt - qy, dt, sp.cpWhite, cap, wb.w - wbBound);
    const bTop = heatNode(wt, qwt + qTopAir - qyTop - (evap * C.Lvap) / dt, dt, sp.cpWhite, cap, wt.w - wtBound);
    const bY = heatNode(y, qy + qyTop + qYolkAir, dt, sp.cpYolk, cap); // an over-hard yolk boils too, and that water leaves the egg like any other
    it.lostWater += bBot + bTop + bY; it.steam = (bBot + bTop + bY + evap) / dt;
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
    const Ts = itemSurfT(wb.T, q, A, sp.kWhite, sp.whiteMm / 4000, wb.w - wbBound > 0.4 * (it.w0b - wbBound), bottomCap(bc));
    it.Ts = Ts;
    // the underside browns where the white has dried onto the metal: the brown skirt under an egg.
    // That film is what dries, not the gel behind it, so this reads the free-water dryness.
    itemBrowning(it.faceDown, Ts, skinDry, dt, 1, MEAT_CHAR);
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
    // ...and only while that layer still has sugar left to caramelise. An onion is 5.6 % free
    // sugars; once the layer on the metal has spent them it cannot go darker, only pyrolyse. That
    // is why the colour of a layer that has been on the metal a long time stops moving, and why
    // stirring — bringing unspent onion down onto the metal — is what takes the whole lot to sweet.
    const sugarLeft = clamp(1 - it.carmBot / 4, 0.1, 1);
    const rate = 5.6e6 * Math.exp(-70e3 * invRT) * fDry * sugarLeft;
    const rChar = SUGAR_CHAR.A * Math.exp(-SUGAR_CHAR.Ea * invRT) * fDry * Math.max(0, 1 - it.charBot / C.Cmax);
    it.carmBot = Math.min(3, it.carmBot + rate * dt);
    it.charBot = Math.min(C.Cmax, it.charBot + rChar * dt);
    // only the layer against the metal is browning at any moment: the heap's own state is that
    // layer's, weighted by how much of the heap it is
    it.carm = Math.min(3, it.carm + rate * sp.botFrac * dt);
    it.char = Math.min(C.Cmax, it.char + rChar * sp.botFrac * dt);
    // Softening precedes drying and browning; retain the thermal history after cooling.
    it.soft = 1 - (1 - (it.soft || 0)) * Math.exp(-dt * smooth(55, 95, t.T) / 80);
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
      // Colour is not the only thing that happens to an onion. Once most of the 71 g of water is
      // out they are soft, translucent and mild — sweated, which is what half the onions on burgers
      // are — even though nothing has browned yet. Calling that "raw" was wrong, and the note
      // contradicted its own number.
      if ((it.soft || 0) > 0.65 || it.lostWater > 0.6 * it.w0) return { state: 'sweated', note: `Onions sweated soft and translucent — ${(it.lostWater * 1000).toFixed(0)} g of their ${(it.w0 * 1000).toFixed(0)} g of water is out and the sharpness went with it, but they never took any colour (caramel ${c.toFixed(2)}).`, score: 0 };
      if ((it.soft || 0) > 0.08 || it.top.T > 50) return { state: 'sweating', note: 'The onions are softening and releasing water. Keep cooking and stir to bring fresh slices onto the pan.', score: -1 };
      return { state: 'raw', note: `The onions are still sharp — only ${(it.lostWater * 1000).toFixed(0)} g of their ${(it.w0 * 1000).toFixed(0)} g of water is out. Raw onion on a burger is a choice; this one was an accident.`, score: -2 };
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

  // Two well-mixed smoke layers. Optical burden, not a calibrated pollutant
  // concentration: smoke rises, mixes down, and leaves through room ventilation.
  function roomAir(s) { return s.room || (s.room={windowOpen:false,opening:0,upper:0,lower:0}); }
  function toggleWindow(s) { const r=roomAir(s);r.windowOpen=!r.windowOpen;return r.windowOpen; }
  function stepRoom(s,dt) {
    const r=roomAir(s); if(!(dt>0))return;
    r.opening+=(Number(r.windowOpen)-r.opening)*(-Math.expm1(-dt/1.2));
    const mix=(r.upper-r.lower)*.5*(-Math.expm1(-dt/90));
    r.upper-=mix;r.lower+=mix;
    const source=Math.max(0,s.diag.smoke||0)*.003;
    const upperLoss=1/480+r.opening/32, lowerLoss=1/720+r.opening/75;
    r.upper=r.upper*Math.exp(-upperLoss*dt)+source*(-Math.expm1(-upperLoss*dt))/upperLoss;
    r.lower*=Math.exp(-lowerLoss*dt);
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
    let ovenLoad = 0;
    // Lumped cavity/wall capacity and finite 3.5 kW thermostat. Retains the
    // empty-oven ramp; food's actual boundary heat now leaves the oven.
    if (s.oven) {
      const o=s.oven, loss=6*(o.T-Tamb);
      o.heaterW=o.target?clamp(15*(o.target-o.T)+loss,0,3500):0;
    }
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
    if (!grill) Oil.step(pan, onPan.concat(itemsOn), dt);
    // residue chemistry
    if (pan.fond > 0 && pan.T > 180) { const b = pan.fond * 0.01 * clamp((pan.T - 180) / 60, 0, 2) * dt; pan.fond -= b; pan.fondBurnt += b; }
    if (pan.T > 200) {
      const hot = clamp((pan.T - 200) / 80, 0, 2);
      const c1 = pan.fondBurnt * 0.004 * hot * dt; pan.fondBurnt -= c1;
      const c2 = pan.cheeseBits * 0.003 * hot * dt; pan.cheeseBits -= c2;
      const c3 = pan.meatBits * 0.003 * hot * dt; pan.meatBits -= c3;
      pan.carbon += 0.25 * (c1 + c2 + c3);
    }
    const smokeT = Number.isFinite(pan.oilSmoke) ? pan.oilSmoke : TALLOW_SMOKE;
    const overSmoke = pan.oil > 1e-5 ? Math.max(0, pan.Tcenter - smokeT) : 0;
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
          // and the smoke in the kettle lands on it: flavour while the fire has air, creosote when
          // it has not, and far more of both under a closed lid
          if (grill.smokeConc > 0) depositSmoke(s, p, dt);
        } else {
          bc = psc.bcPan || (psc.bcPan = {
            bottom: { type: 'pan', TatR, T: 0, Tedge: 0, oil: 0, hcMul: 1, release: 0 },
            top: { h: 0, T: 0, RH: 0, oil: false, rad: false, radT: 0, radView: 0 },
            side: { T: 0, oilDepth: 0, oilT: 0, rad: false, h: 0 },
          });
          const bb = bc.bottom, bt = bc.top, bs = bc.side;
          bb.T = Tunder; bb.Tedge = Tedge; bb.oil = Oil.contactMass(pan, p); bb.hcMul = pan.hcMul * (1 - 0.3 * carbonF); bb.release = pan.release + 0.2 * carbonF;
          if (submerged) { bt.h = C.hOil; bt.T = Tunder; bt.RH = 1; bt.oil = true; }
          else { bt.h = s.lid ? C.hLid : C.hAirTop; bt.T = s.lidAirT; bt.RH = s.lid ? clamp((s.lidAirT - 60) / 40, s.env.RH, 1) : s.env.RH; bt.oil = false; }
          bs.T = Tamb + 0.25 * (Tedge - Tamb); bs.oilDepth = pan.oilDepth; bs.oilT = Tunder;
        }
        const pr = stepPattyGuarded(s, p, dt, bc);
        p.cookTime += dt; p.timeDown += dt;
        if (p.scrapeT > 0) p.scrapeT = Math.max(0, p.scrapeT - dt); // the second of spatula work runs down in simulated time, like everything else
        // heat drawn from the rings under each patty ring, in the same proportions it was read from
        const share = grill ? 0.35 : 1; // on a grill most of the heat is radiant, not drawn from the bars
        for (let j = 0; j < p.Nr; j++) {
          const row = j * Np, l = pwLo[j], h = pwHi[j], q = pr.qPanR[j] * share; // what the metal gave, not what the meat took
          for (let k = l; k <= h; k++) qRing[k] -= q * pw[row + k];
        }
        if (grill) {
          // juice and fat fall through the grate onto the coals: steam, sizzle, and a flare when
          // enough fat lands on a hot bed at once
          let drip = 0; for (let j = 0; j < p.Nr; j++) { drip += p.poolB[j]; p.poolB[j] = 0; } p.poolBottom = 0;
          p.lostWaterDrip += drip;
          dripOnBed(s, p.pos.x, (pr.fatDrip + pr.fatSide) * dt); // on a banked bed only the fat over the pile can flare
          grill.juiceOnCoals = (grill.juiceOnCoals || 0) + drip + pr.juiceSide * dt;
          // cheese that sagged off the slice and fell through the bars: processed American is
          // ~31 % fat, ~44 % water, so it both spits on the coals and feeds the flames
          if (pr.cheeseDrip > 0) { const cd = pr.cheeseDrip * dt; dripOnBed(s, p.pos.x, cd * 0.31); grill.juiceOnCoals += cd * 0.44; grill.cheeseOnCoals = (grill.cheeseOnCoals || 0) + cd; }
        } else {
          pan.water += pr.juiceSide * dt;
          const rendered=(pr.fatDrip + pr.fatSide)*dt;
          pan.oil += rendered;
          if(rendered>0) { pan.oilSmoke=Math.min(pan.oilSmoke,TALLOW_SMOKE); Oil.deposit(pan,rendered,p.pos.x,p.pos.y,p.D*.55); }
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
      } else if (p.where === 'oven') {
        const temp = s.oven ? s.oven.T : Tamb;
        const psc = p.sc || (p.sc = pattyScratch(p.Nz, p.Nr));
        const bc = psc.bcOven || (psc.bcOven = {
          bottom: { type: 'air', h: 18, T: 0, rad: true, radView: 1, radT: 0 },
          top: { h: 18, T: 0, RH: 0, oil: false, rad: true, radView: 1, radT: 0 },
          side: { h: 18, T: 0, oilDepth: 0, oilT: 0, rad: true, radView: 1, radT: 0 }
        });
        for (const face of [bc.bottom, bc.top, bc.side]) { face.T = temp; face.radT = temp; }
        // Fixed absolute moisture content, diluted as the oven warms.
        bc.top.RH = s.env.RH * rhoVapSat(Tamb) / rhoVapSat(temp);
        const flux=stepPattyGuarded(s, p, dt, bc);
        ovenLoad+=flux.qBot+flux.qTop+flux.qSide;
        p.cookTime += dt; p.ovenTime = (p.ovenTime || 0) + dt;
      } else if (p.where === 'rest') {
        anyResting = true;
        const psc = p.sc || (p.sc = pattyScratch(p.Nz, p.Nr));
        const bc = psc.bcAir || (psc.bcAir = { bottom: { type: 'air', h: 15, T: 0 }, top: { h: C.hAirTop, T: 0, RH: 0, oil: false, rad: false }, side: { T: 0, oilDepth: 0, oilT: 0, rad: false, h: 0 } });
        bc.bottom.h=15; bc.top.h=C.hAirTop; bc.top.insulated=false;
        bc.bottom.T = Tamb + 8; bc.top.T = Tamb; bc.top.RH = s.env.RH; bc.side.T = Tamb;
        const owner=p.assembledTo!=null?s.patties.find(q=>q.id===p.assembledTo):null;
        Assembly.cover(owner||p,bc,null,owner?p:null);
        stepPattyGuarded(s, p, dt, bc);
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
          bb.T = it.Tat; bb.oil = Oil.contactMass(pan, it);
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
        if (grill) { dripOnBed(s, it.pos.x, it.dFat); grill.juiceOnCoals = (grill.juiceOnCoals || 0) + it.dJuice; }
        else { pan.oil += it.dFat; pan.water += it.dJuice;
          if(it.dFat>0) {pan.oilSmoke=Math.min(pan.oilSmoke,TALLOW_SMOKE); Oil.deposit(pan,it.dFat,it.pos.x,it.pos.y,it.D*.5);}
        }
        it.fatRate=it.dFat/dt;
        itemBoil += it.steam; itemSizzle += it.sizzle; itemSmoke += it.smoke;
        // a topping is something against the metal too: it counts in the sizzle's contact and
        // dryness exactly as a patty does, or a pan of bacon rendering in 15 g of its own fat is
        // silent because there happens to be no meat in it
        contactAll += it.contactF == null ? 1 : it.contactF;
        dryDownAll += itemDryness(it);
        nOnPan++;
      } else if (it.where === 'rest' || it.where === 'cut') {
        const bc = it._bcAir || (it._bcAir = { bottom: { type: 'air', h: 15, T: 0 }, top: { h: C.hAirTop, T: 0, RH: 0, rad: false } });
        bc.bottom.h=15; bc.top.h=C.hAirTop; bc.top.insulated=false;
        bc.bottom.T = Tamb + 8; bc.top.T = Tamb; bc.top.RH = s.env.RH;
        bc.bottom.internalCap=it.assembledTo!=null?Math.max(...['face','up','body','bot','top','wBot','wTop','yolk'].map(k=>it[k]?.T||0)):0;
        if(it.assembledTo!=null) {const owner=s.patties.find(p=>p.id===it.assembledTo); if(owner) Assembly.cover(owner,bc,it);}
        stepItem(s, it, dt, bc);
      }
    }
    for(const p of s.patties) Assembly.stepHeat(s,p,dt);
    if(s.oven) { const o=s.oven; o.loadW=ovenLoad; o.T+=(o.heaterW-6*(o.T-Tamb)-ovenLoad)*dt/1800; }
    if(!grill) Oil.sync(pan);
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
      // the same rollback the patties get: the metal is what everything else is measured against,
      // so a non-finite ring temperature would take the whole kitchen with it
      const panSnap = s._panSnap && s._panSnap.length === Np ? s._panSnap : (s._panSnap = new Float64Array(Np));
      const wasGood = finiteArray(Tr);
      if (wasGood) panSnap.set(Tr);
      const oilPer = (pan.oil * C.cpF) / floorA;
      let dtMax = Infinity;
      for (let j = 0; j < Np; j++) { Cr[j] = pan.ringM[j] * pan.cp + oilPer * pan.ringA[j]; const g = (j > 0 ? G[j - 1] : 0) + (j < Np - 1 ? G[j] : 0); dtMax = Math.min(dtMax, (0.45 * Cr[j]) / Math.max(g, 1e-9)); }
      const nsub = dt <= dtMax ? 1 : Math.min(40, Math.ceil(dt / dtMax)), h = dt / nsub;
      for (let it = 0; it < nsub; it++) {
        for (let j = 0; j < Np; j++) dTr[j] = qRing[j];
        for (let j = 0; j < Np - 1; j++) { const q = G[j] * (Tr[j + 1] - Tr[j]); dTr[j] += q; dTr[j + 1] -= q; }
        for (let j = 0; j < Np; j++) Tr[j] += (dTr[j] * h) / Cr[j];
      }
      if (!finiteArray(Tr)) {
        const g = s.guard || (s.guard = { restores: 0, retries: 0, sanitised: 0, lastLog: -1e9 });
        if (wasGood) Tr.set(panSnap); else for (let j = 0; j < Np; j++) if (!Number.isFinite(Tr[j])) Tr[j] = Tamb;
        g.restores++; g.panRestores = (g.panRestores || 0) + 1;
        if (s.t - g.lastLog > 5) { g.lastLog = s.t; logEvent(s, `Numerical instability in the ${grill ? 'grate' : 'pan'}: the ring temperatures went non-finite and were rolled back to the previous step.`, 'warn'); }
      }
      let mean = 0; for (let j = 0; j < Np; j++) mean += Tr[j] * pan.ringA[j]; pan.T = mean / floorA;
      pan.Tcenter = Tr[0]; pan.Tedge = Tr[Np - 1];
      // what an IR gun reads on each side of a banked grate: two thirds of the way out, both ways
      if (grill) { grill.Thot = panTatXY(s, 0.66 * pan.floorR, 0); grill.Tcool = panTatXY(s, -0.66 * pan.floorR, 0); }
    }
    if (pan.T > pan.maxT && pan.id === 'nonstick' && !s._ptfeWarned) { s._ptfeWarned = true; logEvent(s, 'Nonstick coating above 260 °C: it is degrading and off-gassing. Not a good idea.', 'warn'); }

    const oilBubble = pan.oil > 1e-5 ? clamp(boilTotal * 4000, 0, 1) * clamp(pan.oil / 0.005, 0, 1) : 0;
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
    const renderedRate=fatDripAll+fatSideAll+itemsOn.reduce((v,it)=>v+(it.fatRate||0),0);
    dg.hiss = clamp((oilBubble * 0.7 + renderedRate * 2.2e4) * dryDown * dryDown + itemSizzle, 0, 1.2) * (0.35 + 0.65 * dg.contact);
    // the roar of a kettle drawing air is the airflow it is actually getting — the two vents in
    // series, less whatever the ash is taking — not just where the bottom vent is set
    dg.roar = grill && grill.lit ? clamp(grill.air, 0, 1) * clamp(grill.Tfire / 500, 0, 1.4) * (s.lid ? 0.5 : 1) : 0;
    dg.sizzle = clamp(boilTotal * 300 + oilBubble * 0.15 + evapTopAll * 20 + itemSizzle * 0.5 + (grill ? grill.sizzle : 0), 0, 1.5);
    dg.spatter = spatter; dg.steam = steamAll + evapPan + itemBoil;
    dg.smoke = pan.smokeOil + pan.smokeChar + pan.smokeFond + pan.smokeItems + (pan.flare > 0 ? 1.5 : 0) + (grill ? grill.smoke : 0);
    dg.flare = grill ? grill.flare : pan.flare; dg.oilDepth = pan.oilDepth; dg.overflow = pan.overflow; dg.lid = s.lid;
    dg.fire = grill ? grill.Tfire : 0;
    // what the smoke looks like: 0 is the thin blue smoke of volatiles burning as they leave the
    // wood, 1 is the thick white smoke of volatiles that never found any air. `smokeDens` is how
    // much of it there is under the dome, which is what the renderer scales the plume by.
    dg.smokeKind = grill ? 1 - grill.comb : 0;
    dg.smokeDens = grill ? clamp(grill.smokeConc / SMOKE.dense, 0, 3) : 0;
    dg.ventOut = grill && s.lid ? clamp(0.15 + 0.85 * grill.topVent, 0, 1) : 0; // how much of it leaves by the lid vent
    dg.evapBottom = boilBottomAll + itemBoil * .5; dg.evapPan = evapPan; dg.oilBubble = oilBubble;
    dg.fatDrip = renderedRate; dg.juiceTop = sel ? sel.poolTop : 0; dg.juiceSide = juiceSideAll;
    dg.panQ = panQ; dg.Ts = TsSel; dg.hc = hcSel;
    pan.smoke = dg.smoke;
    stepRoom(s,dt);
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
      // a lump bed with both vents wide sits around 740–780 °C — the model's own ceiling is
      // Tamb + (300 + 430·air)·alive·size, i.e. 787 °C with everything in its favour — so this is
      // the wide-open regime, not a number that could never be reached
      once(s, ms, 'coalfull', s.grill.Tfire >= 700, 'Vents wide open: the bed is white-hot, up around 750 °C. Radiant heat like that sears in a minute and chars in three.', 'warn');
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
        once(s, pm, 'cheeseDrip', s.grill && (s.grill.cheeseOnCoals || 0) > 0.001, 'Melted cheese is sagging through the bars and dropping on the coals: it spits, feeds the flames and smells of burnt milk. On a grate cheese goes on late, with the lid down.', 'warn');
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
    Oil.sync(pan);
    pan.carbon *= pan.id === 'castiron' || pan.id === 'carbonsteel' ? 0.55 : 0.02;
    for (let j = 0; j < pan.Np; j++) pan.Tr[j] = 34 + (pan.Tr[j] - 34) * 0.12;
    pan.T = 34 + (pan.T - 34) * 0.12; pan.Tcenter = pan.Tr[0]; pan.Tedge = pan.Tr[pan.Np - 1]; pan.water = 0.003; pan.washes++;
    logEvent(s, `Washed the pan${dirt > 0.002 ? ' (it needed it)' : ''}. It is wet and at ${pan.T.toFixed(0)} °C now.` + (wasHot && pan.id === 'castiron' ? ' Cold water on hot cast iron: it survived, but that is how they crack.' : wasHot ? ' The steam off it was impressive.' : ''), wasHot ? 'warn' : 'action');
    return true;
  }
  /**
   * Between tickets on the same equipment. The patties and the toppings go, the lid comes off and
   * the log starts again — but the stove does not reset: a pan keeps its heat, its fat, its fond and
   * its carbon, and a kettle keeps its fire. The coals go on burning down while the next order is
   * being formed, the ash goes on building in the bed and the bowl, the bars keep the heat they have
   * and whatever is welded to them, and a chunk of wood that is still smouldering is still
   * smouldering. The milestones that are about the equipment rather than this ticket's meat are
   * kept, so the log does not announce the same 150 °C pan or the same glowing bed twice.
   */
  const KEEP_MS = ['preheat150', 'leiden', 'oilsmoke', 'ptfe', 'coalglow', 'grateHot', 'coalfull'];
  function nextTicket(s) {
    s.patties = []; s.patty = null; s.items = []; s.item = null; s.where = 'board';
    s.rest.t = 0; s.lid = false; s.baste = 0; s.served = false;
    s.trace = []; s.lastTrace = -1; s.events = [];
    const keep = {}; for (const k of KEEP_MS) if (s._ms && s._ms[k]) keep[k] = true; s._ms = keep;
    return s;
  }
  function serve(s, patty) {
    const host=patty?.assembledTo!=null?s.patties.find(p=>p.id===patty.assembledTo):patty;
    const list = (host ? [host,...Assembly.layers(host).filter(l=>l.meat).map(l=>l.meat)] : s.patties).filter(p => p.where === 'rest' || p.where === 'cut');
    // the build step: anything off the heat that the cook has not already put on a burger goes to
    // whichever burger it came off the pan next to
    for (const it of s.items) if (it.where !== 'pan' && it.burger == null) { const b = plannedBurger(s, it); if (b && !b.manualAssembly) it.burger = b.id; }
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
      logEvent(s, `Patty ${p.id} ${heel && crown ? 'on a bun' : heel || crown ? 'served with a partial bun' : 'served without a bun'}.${heel && p.bunSoak > 0.0015 ? ` ${(p.bunSoak * 1000).toFixed(1)} g of juice went straight into the bottom bun${heel && soakF < 0.8 ? ' — far less than it would have taken untoasted' : ''}.` : ''}${p.cheeses.length ? ` ${p.cheeses.length} slice${p.cheeses.length > 1 ? 's' : ''} of cheese under the lid.` : ''}${built}`, 'action');
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
    if (Assembly.hasPatty(patty)) for (const layer of Assembly.layers(patty)) if (layer.cold) items.push({kind:layer.cold,label:Assembly.cold[layer.cold].label,state:'added',note:'Added during assembly',score:0});
    if (patty.manualAssembly) {
      const order = Assembly.layers(patty).filter(l=>!l.patty).map(l=>l.item?l.item.label:Assembly.cold[l.cold].label);
      items.sort((a,b)=>order.indexOf(a.label)-order.indexOf(b.label));
    }
    let pen = 0, bon = 0;
    for (const b of items) { if (b.score < 0) pen -= b.score; else bon += b.score; }
    const tops = toppingsOf(s, patty);
    const missing = (patty.requiredBuild || []).filter(kind => kind === 'double' ? Assembly.layers(patty).filter(l=>l.patty).length<2 : kind === 'cheese' ? !patty.cheeses.length && !Assembly.layers(patty).some(l=>l.meat?.cheeses.length)
      : kind === 'bun' ? !['bottom', 'top'].every(half => tops.some(it => it.kind === 'bun' && it.half === half))
      : !items.some(it => it.kind === kind));
    return { items, missing, penalty: clamp(pen + missing.length * 5, 0, 10), bonus: clamp(bon, 0, 5) };
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
    // Smoke is part of the crust the way the crust is part of the flavour: a moderate deposit of
    // clean wood smoke is worth up to three of the twenty (0.15 of the mark), and it can only make
    // up for a crust that is not already perfect — a patty that has earned the full twenty on
    // browning alone still scores twenty. Past a couple of chunks' worth it stops helping, and
    // creosote off smoke that never had air is a straight penalty of up to six.
    const sr = smokeRead(p);
    const smokeBonus = 0.15 * smooth(0.15, 0.7, sr.clean) * (1 - smooth(2.5, 6, sr.clean));
    const smokePen = 0.30 * smooth(0.15, 1.2, sr.creosote);
    const crustScore = 20 * clamp(0.5 * (faceScore(p.faceDown) + faceScore(p.faceUp)) * (1 - dirtPen) + smokeBonus - smokePen, 0, 1);
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
    // The order's band (54–57 for a medium-rare) is narrower than the band the eye calls
    // medium-rare (donenessOf: up to 58), so a centre can miss the ticket by a fraction of a degree
    // and still be the doneness that was asked for. Saying "that is medium-rare; the order was
    // medium-rare, off by 0.0 °C" is nonsense — name the edge of the band instead.
    const offBy = dist < 0.05 ? 'a fraction of a degree' : `${dist.toFixed(1)} °C`;
    if (dist === 0) notes.push(`Centre peaked at ${peak.toFixed(1)} °C — squarely ${target.label.toLowerCase()}. Nailed it.`);
    else if (got.id === target.id) notes.push(`Centre peaked at ${peak.toFixed(1)} °C — ${got.label.toLowerCase()} to look at, but ${offBy} ${peak > target.hi ? 'past the top' : 'short'} of the ${target.lo}–${target.hi} °C the kitchen calls ${target.label.toLowerCase()}.`);
    else notes.push(`Centre peaked at ${peak.toFixed(1)} °C. That is ${got.label.toLowerCase()}; the order was ${target.label.toLowerCase()} (${target.lo}–${target.hi} °C). Off by ${offBy}.`);
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
    // and say what actually made it: with no wood in the kettle there is nothing to blame the tar on
    if (sr.creosote > 0.35) notes.push(sr.wood
      ? `Smothered smoke: ${sr.creosote.toFixed(1)} of creosote on it. Wood that smoulders without air gives up its volatiles cold, they condense on the meat as tar, and it tastes of a bonfire the morning after. Open a vent.`
      : `Smothered smoke: ${sr.creosote.toFixed(1)} of creosote on it — and no wood in the kettle, so that is the fire itself. Choked of air the charcoal smoulders and smokes sooty instead of burning clean, and the meat sat in it. Open a vent.`);
    else if (sr.clean > 2.5) notes.push(`Over-smoked${sr.wood ? ` on ${sr.wood}` : ''}: ${sr.clean.toFixed(1)} times what a burger wants. Smoke is a seasoning, and this one has been seasoned like a brisket.`);
    else if (sr.clean > 0.5) notes.push(`A proper line of ${sr.wood ? `${sr.wood} ` : ''}smoke through it (${sr.clean.toFixed(1)}) — ${sr.wood ? WOOD[sr.wood].note : 'clean and thin'}. That is worth ${(20 * smokeBonus).toFixed(1)} of the crust mark.`);
    else if (sr.clean > 0.15) notes.push(`A trace of ${sr.wood ? `${sr.wood} ` : ''}smoke on it — there, but you would have to be looking for it. A chunk wants ten minutes with the meat over it.`);
    if ((p.bunSoak || 0) > 0.004) notes.push(`${(p.bunSoak * 1000).toFixed(0)} g of juice soaked into the bottom bun. It will not survive the walk to the table.`);
    if ((p.bunToast || 0) > 1.2 && (p.bunSoakRaw || 0) > 0.003) notes.push(`The toasted heel held: ${((p.bunSoakRaw - p.bunSoak) * 1000).toFixed(1)} g of juice that a raw bun would have drunk stayed in the burger instead.`);
    if (p.lostWaterDrip > 0.006) notes.push(`${(p.lostWaterDrip * 1000).toFixed(0)} g of juice ran out ${p.grilled ? 'through the grate onto the coals' : 'onto the pan'} instead of staying in the meat.`);
    if (p.lostFat > 0.004) notes.push(`${(p.lostFat * 1000).toFixed(0)} g of fat rendered out and ${p.grilled ? 'fell on the coals' : 'pooled in the pan'}.`);
    // the same line the evenness mark is drawn at: a band inside the allowance is not "wide", and the
    // note used to say so on a patty that had just scored 10/10 for it
    if (parts.evenness < 10 && target.hi < 68) notes.push('A wide grey band: the outside went well past target before the centre got there. Thicker patty, lower heat, or flip more often.');
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
      smokiness: sr.smokiness, creosote: sr.creosote, smokeWood: sr.wood, smokeBonus: 20 * smokeBonus, smokePenalty: 20 * smokePen,
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
    const plates=results.filter(r=>r.patty.assembledTo==null);
    for(const r of plates) {
      const second=results.find(q=>q.patty.assembledTo===r.patty.id);
      if(!second) continue;
      // The worse cooked patty determines whether this burger should go back.
      r.plateScore=Math.min(r.total,second.total);
      r.notes.push('Double burger: both patties were evaluated; the lower score counts.');
      const coldSecond=(second.patty.serveT??centerT(second.patty))<45, burntSecond=second.faces.down.char>.3||second.faces.up.char>.3;
      r.build.items.push({kind:'patty',label:'Second patty',state:coldSecond?'cold':burntSecond?'burnt':second.got.label,note:'Second patty: '+second.got.label,score:second.total<45||coldSecond||burntSecond?-4:0});
      r.build.penalty=Math.max(r.build.penalty,second.total<45||coldSecond||burntSecond?4:0);
      r.plateVerdict={...(second.total<r.total?second:r),id:r.id,patty:r.patty,build:r.build,cheeseSlices:r.cheeseSlices+second.cheeseSlices,total:r.plateScore};
    }
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
    for (const r of plates) { bPen += r.build.penalty; bBon += r.build.bonus; }
    const buildPenalty = plates.length ? bPen / plates.length : 0, buildBonus = plates.length ? bBon / plates.length : 0;
    for (const r of results) for (const b of r.build.items) if (b.score <= -3) notes.push(`Burger ${r.id}: ${b.label.toLowerCase()} went out ${b.state}. That is a send-back.`);
    for (const r of results) for (const kind of r.build.missing) notes.push(`Burger ${r.id}: missing the requested ${kind === 'bun' ? 'bun halves' : kind}. That is a send-back.`);
    const rests = list.map((p) => p.restT || 0);
    const spread = rests.length > 1 ? Math.max(...rests) - Math.min(...rests) : 0;
    if (list.length > 1 && spread < 90 && coldPenalty < 0.5 && list.every(p => (p.serveT == null ? centerT(p) : p.serveT) >= 45)) notes.push('All the burgers landed together, still hot. That is the hard part of a multi-burger ticket.');
    else if (spread >= 240) notes.push(`The burgers came off the pan ${fmtTime(spread)} apart. Start the well-done one first and the rare one last so they finish together.`);
    const mean = plates.length ? plates.reduce((a, r) => a + (r.plateScore??r.total), 0) / plates.length : 0;
    const total = Math.round(clamp(mean - coldPenalty - buildPenalty + buildBonus, 0, 100));
    return { total, mean: Math.round(mean), coldPenalty: Math.round(coldPenalty), buildPenalty: Math.round(buildPenalty * 10) / 10, buildBonus: Math.round(buildBonus * 10) / 10, spread, results, notes };
  }

  // ---------------------------------------------------------------- the customer's verdict
  /*
   * The rubric above (doneness 50 / crust 20 / juiciness 15 / evenness 10 / structure 5) is what
   * the kitchen thinks. This section is what the person eating it says out loud. It invents no new
   * physics: every line is read off the numbers `evaluate` already returns, and turned into the
   * sentence a real customer would use — "it's dry", "there's no crust", "it's cold in the middle".
   */

  // A mid-range sit-down burger, US prices: $14 for the burger, $1.50 a slice for cheese. Those are
  // the only two things this kitchen sells, so a plate's bill is the burger plus what went on it.
  const MENU = { burger: 14, cheese: 1.5 };
  // Time on the pan for the README recipe, measured by running it (the same cook as the "README
  // recipe scores 100" test): rare 286 s, medium-rare 343 s, medium 303 s, medium-well 364 s, well
  // done 458 s. Medium is quicker than medium-rare because the recipe drops to a 14 mm patty from
  // medium up. Rounded to 5 s.
  const COOK_S = { rare: 285, 'medium-rare': 345, medium: 305, 'medium-well': 365, 'well-done': 460 };
  const REST_S = 150;         // the rest the recipe asks for before it is cut: 2–2.5 minutes
  const SERVICE_MAX = 10;     // ticket points a plate that goes out late can cost
  const SERVICE_SLACK = 1.6;  // the quoted time is 1.6× the recipe: preheating, forming and fumbling
  // What a patty of each doneness should still be holding when it lands, as a fraction of the water
  // it started with. Mirrors the expectation `evaluate` scores juiciness against, so "dry" here and
  // a low juiciness bar there are the same fact said twice.
  const RET_EXPECT = { rare: 0.72, 'medium-rare': 0.69, medium: 0.63, 'medium-well': 0.56, 'well-done': 0.50 };

  /**
   * How long the room will wait for this ticket, in kitchen seconds from the moment it is accepted.
   * The burgers share one pan, so they overlap: the longest one sets the pace and each extra burger
   * adds about 40 % of its own cook time — it is formed and laid in by hand on its own, and a
   * crowded pan sags 30–50 °C and takes a minute to come back. The rest is shared (they all rest
   * together). The whole thing is multiplied by 1.6 to pay for lighting the stove, preheating and
   * forming, which is why one medium-rare is quoted at about thirteen minutes and not six.
   */
  function ticketTargetTime(items) {
    const cooks = (items || []).map((id) => COOK_S[id] || COOK_S.medium).sort((a, b) => b - a);
    if (!cooks.length) return 0;
    let cook = cooks[0];
    for (let i = 1; i < cooks.length; i++) cook += 0.4 * cooks[i];
    return Math.round((SERVICE_SLACK * (cook + REST_S)) / 10) * 10;
  }
  /**
   * The service penalty, in ticket points: nothing while the ticket is inside the time it was
   * quoted, then linear to the full 10 points at twice that. A table told fifteen minutes is
   * irritated at twenty-two (−5) and is talking about you at thirty (−10).
   */
  function latePenalty(elapsed, target) {
    if (!(target > 0)) return 0;
    return SERVICE_MAX * clamp((elapsed - target) / target, 0, 1);
  }
  /** The bill for a set of plates: one burger each, plus the extras that went on them. */
  function billFor(plates) {
    const lines = []; let total = 0;
    for (const pl of plates || []) {
      const cheese = (pl && pl.cheeseSlices) || 0;
      const price = MENU.burger + cheese * MENU.cheese;
      const what = (pl && pl.target && pl.target.label ? pl.target.label : 'Beef') + ' burger' + (cheese ? ` + ${cheese} cheese` : '');
      lines.push({ what, price: Math.round(price * 100) / 100 }); total += price;
    }
    return { lines, total: Math.round(total * 100) / 100 };
  }
  /**
   * What they leave on top of the bill. Nothing at all on a plate that went back; from there it
   * climbs through the grudging ~10 % of a mediocre burger and the 20 % of a good one to the 25 %
   * people leave when it was genuinely worth it. `score` is the plate's score *after* the service
   * penalty, so a cold, late burger tips like a bad one however well it was cooked.
   */
  function tipFraction(score, outcome) {
    if (outcome === 'sent back' || (outcome == null && score < 45)) return 0;
    return 0.25 * Math.pow(clamp((score - 40) / 60, 0, 1), 1.25);
  }

  const WORD_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const WORD_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];
  /** "we waited twenty minutes" — people say waits in words, not in digits. */
  function spellMinutes(sec) {
    const m = Math.max(0, Math.round((sec || 0) / 60));
    if (m < 20) return WORD_ONES[m];
    if (m < 60) return WORD_TENS[Math.floor(m / 10)] + (m % 10 ? '-' + WORD_ONES[m % 10] : '');
    return String(m);
  }
  /**
   * A deterministic pick out of a list of phrasings: the same patty with the same score always says
   * the same thing (so the results screen does not shuffle under you), but the next burger, or the
   * same burger a point better, says it differently. Integer hash, no Math.random anywhere.
   */
  function phrasePick(list, seed, slot) {
    let x = (Math.imul(seed | 0, 2654435761) ^ Math.imul((slot | 0) + 1, 40503)) >>> 0;
    x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13;
    return list[(x >>> 0) % list.length];
  }

  /**
   * Turn one scored patty into the customer's own words.
   *
   * `result` is what `evaluate` returns (optionally with `.patty` attached, as `evaluateTicket`
   * does — anything missing from the result is read off the patty). `ticketResult` is the
   * `evaluateTicket` output for the ticket it belongs to; if it carries `.service`
   * ({ elapsed, target, penalty } — see `latePenalty`) the wait becomes part of the verdict and of
   * the tip. The build is read too: `result.build` as `evaluate` returns it — `{ items: [{ kind,
   * label, state, score }], penalty, bonus }` from `buildOf`, where the state is the kitchen's own
   * word for it ("jammy yolk", "limp", "burnt", "caramelised") and the score is what the ticket
   * charges or credits for it — or, for a hand-built result, a plain array of `{ name, state }`
   * entries. Anything the kitchen itself would call a send-back (score ≤ −3: a raw egg white, limp
   * bacon, a black bun, burnt onions) sends the plate back however well the patty scored.
   *
   * Returns the quote, the outcome (sent back / accepted / delighted), every complaint and every
   * bit of praise behind it, and the bill and tip for this plate.
   */
  function verdict(result, ticketResult) {
    if (!result) return null;
    const pt = result.patty || null;
    const from = (k, d) => (result[k] != null ? result[k] : pt && pt[k] != null ? pt[k] : d);
    const target = result.target || DONENESS[2];
    const peak = result.peak != null ? result.peak : 0;
    const got = result.got || donenessOf(peak);
    const score = clamp(Math.round(result.total || 0), 0, 100);
    const id = result.id != null ? result.id : pt && pt.id != null ? pt.id : 1;
    const seed = id * 101 + score;                       // the pick varies with the patty and its score
    const faces = result.faces || {}; const fd = faces.down || {}, fu = faces.up || {};
    const bad = [], good = [];
    const gripe = (kind, sev, texts, slot) => bad.push({ kind, sev, text: phrasePick(texts, seed, slot) });
    const nice = (kind, texts, slot) => good.push({ kind, text: phrasePick(texts, seed, slot) });
    const tl = target.label.toLowerCase(), gl = got.label.toLowerCase();

    // — doneness: how far off, in their language rather than in degrees
    const dist = result.dist != null ? result.dist : peak < target.lo ? target.lo - peak : peak > target.hi ? peak - target.hi : 0;
    const under = dist > 0 && peak < target.lo;
    const doneState = dist === 0 ? 'right' : under ? 'under' : 'over';
    if (dist === 0) nice('doneness', [`It's ${tl} right through.`, `Cooked exactly how I asked.`, `That is properly ${tl}.`], 1);
    else if (dist < 3) gripe('doneness', 0.25, under
      ? [`A shade rarer than I asked, but I'll live.`, `Nearly — it's a touch under.`, `I asked for ${tl}; it's just short of it.`]
      : [`A shade past what I asked for.`, `A little more done than I wanted.`, `It's just over ${tl}. Only just.`], 1);
    else if (dist < 8) gripe('doneness', 0.55, under
      ? [`I ordered ${tl} and this is ${gl}.`, `That's ${gl}. I asked for ${tl}.`, `It's under — the middle's still ${gl}.`]
      : [`I ordered ${tl} and this is ${gl}.`, `That's ${gl}, not ${tl}.`, `It's overdone — that's ${gl} in there.`], 1);
    else gripe('doneness', 0.95, under
      ? [`This is raw. Cold and red in the middle.`, `I can't eat that, it's practically raw.`, `That isn't ${tl}, that's uncooked.`]
      : [`It's grey all the way through.`, `This is a hockey puck.`, `You've cooked every bit of ${tl} out of it.`], 1);

    // — juiciness: what it kept, against what that doneness should keep
    const wRet = from('waterRetained', 0.6);
    const expect = (RET_EXPECT[target.id] || 0.6) - (from('grilled', false) ? 0.10 : 0); // the grate takes its cut
    const short = expect - wRet;   // fractions of the water it started with, below par
    const juiceState = short <= 0.01 ? 'juicy' : short < 0.05 ? 'tight' : short < 0.10 ? 'dry' : 'parched';
    if (juiceState === 'juicy') nice('juicy', [`It's juicy — it ran down my wrist.`, `Look at the juice in that.`, `Properly juicy.`], 2);
    else if (juiceState === 'tight') gripe('dry', 0.35, [`It's a bit tight. Could be juicier.`, `Drier than I'd like.`, `It wants a bit more juice in it.`], 2);
    else if (juiceState === 'dry') gripe('dry', 0.7, [`It's dry.`, `It's dry — I'm reaching for the water.`, `There's no juice in it at all.`], 2);
    else gripe('dry', 0.95, [`It's like sawdust.`, `This is chalk. Where did all the juice go?`, `Bone dry. I can't chew it.`], 2);
    if (from('waterDrip', 0) > 0.010 && short > 0.02) gripe('dry', 0.4, [`You squeezed it, didn't you. All the juice is on the stove.`, `Whatever was in it went into the pan.`], 3);

    // — crust: browning index and char, with the grill's bars counted the way the rubric counts them
    const barFrac = from('grilled', false) ? GRATE.barFrac : 0;
    const eff = (f) => (f.brown || 0) * (1 - barFrac) + (f.marks || 0) * barFrac;
    const bMean = 0.5 * (eff(fd) + eff(fu)), bMin = Math.min(eff(fd), eff(fu)), bMax = Math.max(eff(fd), eff(fu));
    const char = Math.max(fd.char || 0, fu.char || 0);
    // char > ~0.35 is pyrolysed black, not brown; a browning index under 1 has no Maillard colour at
    // all, 2–4.5 is the crust a cook is aiming for, and past 5.5 it is bitter even without char.
    const crustState = char > 0.35 || bMean > 5.5 ? 'burnt' : bMean < 1 ? 'none' : bMean < 2 ? 'pale' : bMean <= 4.5 ? 'proper' : 'dark';
    if (crustState === 'burnt') gripe('crust', 0.9, [`The outside's burnt. It tastes of ash.`, `That's burnt — it's bitter.`, `You've cremated it. All I taste is carbon.`], 4);
    else if (crustState === 'none') gripe('crust', 0.75, [`There's no crust on it at all. It's grey.`, `It's boiled, not seared. No crust anywhere.`, `Where's the crust? It looks steamed.`], 4);
    else if (crustState === 'pale') gripe('crust', 0.4, [`Barely any crust on it.`, `It's pale. Needed longer, or a hotter pan.`, `Hardly any colour on the outside.`], 4);
    else if (crustState === 'dark') gripe('crust', 0.45, [`The crust is very dark. Almost too much.`, `That's about as far as you can take a crust.`], 4);
    else nice('crust', [`Lovely crust on it.`, `That's a proper crust — it crackles.`, `Good dark crust, all the way across.`], 4);
    if (crustState !== 'burnt' && bMax > 2 && bMin < 1) gripe('crust', 0.35, [`It's only browned on one side.`, `One side's seared and the other's grey.`], 5);

    // — temperature at service: how far the middle fell from its peak while it waited on the plate.
    // Judged as a fall, not an absolute — a rare burger is *meant* to be 50 °C in the middle. A drop
    // of more than ~8 °C is noticeably cooler on the tongue; 20 °C down and it is a cold burger.
    const serveT = result.serveT != null ? result.serveT : pt && pt.serveT != null ? pt.serveT : null;
    const drop = serveT == null ? 0 : Math.max(0, peak - serveT);
    const tempState = drop > 16 ? 'cold' : drop > 8 ? 'lukewarm' : 'hot';
    const coldPen = SERVICE_MAX * clamp((drop - 8) / 12, 0, 1); // the same penalty evaluateTicket charges the ticket for a lukewarm plate
    if (tempState === 'cold') gripe('cold', 0.85, [`It's cold in the middle.`, `This is stone cold. How long was it sitting there?`, `Cold. It's been on the pass for ages.`], 6);
    else if (tempState === 'lukewarm') gripe('cold', 0.5, [`It's not hot. Warm at best.`, `It's gone lukewarm.`, `It could have come out hotter.`], 6);
    else if (drop < 4 && score >= 60) nice('hot', [`It's hot, at least — properly hot.`, `Came out hot. That counts for a lot.`], 6);

    // — structure: what a cook did to it before it reached the plate
    const faults = [];
    const torn = (fd.torn || 0) + (fu.torn || 0);
    if (torn > 0.05 || from('stuck', 0) > 0.001) { faults.push('torn'); gripe('structure', 0.4, [`Half the crust stayed in the pan by the look of it.`, `It's torn up. Bits of it are missing.`], 7); }
    if (from('pressed', false) && short > 0.03) { faults.push('pressed'); gripe('structure', 0.45, [`You pressed it flat. That's my dinner on the stove.`, `It's been squashed — it's flat and tight.`], 8); }
    if (from('dome', 0) > 0.5) { faults.push('domed'); gripe('structure', 0.3, [`It's a meatball, not a burger. It rolls off the bun.`, `It's domed up in the middle. Nothing stays on it.`], 9); }
    if (from('work', 0) > 0.8 || from('salt', '') === 'mixed') { faults.push('springy'); gripe('structure', 0.4, [`It's springy. Like a sausage patty.`, `It's bouncy — that's not a burger texture.`], 10); }
    if ((result.parts && result.parts.structure != null ? result.parts.structure : 5) <= 1 && !faults.length) faults.push('loose');
    const structState = faults.length ? 'flawed' : 'intact';

    // — the grill: bars, charcoal smoke, and soot off a flare-up
    const marks = Math.max(fd.marks || 0, fu.marks || 0);
    const soot = from('flareChar', 0);
    // wood smoke: `evaluate` scores a moderate clean deposit as up to +3 of the crust mark and
    // creosote (volatiles that never had the air to burn) as a straight penalty of up to −6. The
    // customer tastes the same two things: a creosote index past ~0.35 is the bonfire-the-morning-
    // after taste, and a clean deposit past ~0.5 is the flavour people light a fire for.
    const creosote = from('creosote', 0), smokiness = from('smokiness', 0), wood = from('smokeWood', null);
    if (soot > 0.15) gripe('smoke', 0.6, [`It tastes of soot. Something flared up under it.`, `Acrid. Like it caught fire for a second.`], 11);
    else if (creosote > 0.35) gripe('smoke', 0.55, [`It tastes of tar. Like a bonfire the morning after.`, `There's a bitter, sooty taste all over it — that smoke never had any air.`], 11);
    else if (from('grilled', false)) nice('grill', smokiness - creosote > 0.5
      ? [`${wood ? wood[0].toUpperCase() + wood.slice(1) + ' smoke' : 'Wood smoke'} on it, and it's gone right in.`, `That's real smoke, not just charcoal.`]
      : marks > 1 ? [`Proper bars branded into it, and you can taste the charcoal.`, `Charcoal, and the marks to prove it.`] : [`You can taste the charcoal on it.`], 11);
    // a peek leaves a slit through the burger that goes out on the bun; the customer sees it
    if (from('peeks', 0) > 0) gripe('structure', 0.3, [`Somebody's already had a knife in this.`, `It's been cut into. There's a slit right through it.`], 14);

    // — the build, if this checkout has toppings on it: anything raw or burnt sends the plate back
    // `buildOf` returns { items, penalty, bonus }; a hand-built result may pass the items directly
    const buildRaw = result.build || (pt && pt.build) || null;
    const build = Array.isArray(buildRaw) ? buildRaw : buildRaw && Array.isArray(buildRaw.items) ? buildRaw.items : [];
    const buildItems = []; let badBuild = !!(buildRaw && buildRaw.missing && buildRaw.missing.length);
    for (const kind of (buildRaw && buildRaw.missing) || []) gripe('build', 0.95, [`I asked for ${kind === 'bun' ? 'a bun' : kind}. It's missing.`], 20);
    for (const it of build) {
      if (!it) continue;
      // what the table calls it: "the egg", "the bacon", "the onions" — but a bun is its half
      const name = String(it.name || (it.kind === 'bun' ? it.label : it.kind) || it.label || it.id || 'topping').toLowerCase();
      const st = String(it.state || '').toLowerCase();
      const score = typeof it.score === 'number' ? it.score : null;
      // the kitchen's own send-back line is score ≤ −3 (itemState); without a score, go by the word
      const raw = /raw/.test(st) || it.raw === true, burnt = /burnt|charred|black/.test(st) || it.burnt === true;
      const sendBack = score != null ? score <= -3 : raw || burnt;
      buildItems.push({ name, state: st || (raw ? 'raw' : burnt ? 'burnt' : 'ok'), score });
      // "the onions are burnt", "the egg is raw": the only plural on the menu is the onions
      const pl = /s$/.test(name), is = pl ? 'are' : 'is', has = pl ? 'have' : 'has', hasnt = pl ? "haven't" : "hasn't", its = pl ? "They're" : "It's";
      if (sendBack && raw) { badBuild = true; gripe('build', 0.9, [`The ${name} ${is} raw.`, `That ${name} ${hasnt} been cooked at all.`], 12); }
      else if (sendBack && burnt) { badBuild = true; gripe('build', 0.9, [`The ${name} ${is} burnt.`, `That ${name} ${is} black.`], 12); }
      else if (sendBack) { badBuild = true; gripe('build', 0.9, [`The ${name} ${is} ${st || 'wrong'}. I'm not eating that.`, `Look at the ${name}. ${its} ${st || 'not right'}.`], 12); }
      else if (raw) gripe('build', 0.5, [`The ${name} ${is} raw.`, `The ${name} could have done with longer.`], 12);
      else if (burnt) gripe('build', 0.5, [`The ${name} ${is} burnt.`, `The ${name} ${has} caught.`], 12);
      else if (st === 'cold') gripe('build', 0.4, [`The ${name} ${is} stone cold on top of it.`, `Cold ${name}. On a hot burger.`], 12);
      else if (st === 'soggy') gripe('build', 0.35, [`The ${name} ${has} gone to mush.`, `The ${name} ${is} soggy.`], 12);
      else if (score != null && score < 0) gripe('build', 0.3, [`The ${name} ${is} ${st}.`, `Not sure about the ${name} — ${pl ? "they're" : "it's"} ${st}.`], 12);
      else if ((score != null && score >= 1.5) || st === 'melted' || st === 'toasted') nice('build', [`The ${name} ${is} exactly right.`, `Good ${name} on it too.`, st ? `${name[0].toUpperCase() + name.slice(1)} — ${st}. Perfect.` : `Good ${name}.`], 12);
    }

    // — the wait, if the game is timing this ticket
    const svc = (ticketResult && ticketResult.service) || null;
    const late = svc ? { elapsed: svc.elapsed, target: svc.target, penalty: svc.penalty } : null;
    if (svc && svc.penalty > 0.5) gripe('service', 0.3 + 0.6 * clamp(svc.penalty / SERVICE_MAX, 0, 1),
      [`We waited ${spellMinutes(svc.elapsed)} minutes for this.`, `${spellMinutes(svc.elapsed)[0].toUpperCase() + spellMinutes(svc.elapsed).slice(1)} minutes we sat here.`, `It took ${spellMinutes(svc.elapsed)} minutes to come out.`], 13);

    // — outcome, bill and tip. The plate goes back on its own score (the rubric), but the tip is
    // paid on the score after the wait and the cooling, so a late or lukewarm plate is tipped like
    // a worse one however well it was cooked.
    const outcome = score < 45 || badBuild ? 'sent back' : score >= 90 ? 'delighted' : 'accepted';
    const served = clamp(score - (svc ? svc.penalty : 0) - coldPen, 0, 100);
    const bill = billFor([{ cheeseSlices: result.cheeseSlices || 0, target }]);
    const tip = tipFraction(served, outcome);
    const tipAmount = Math.round(bill.total * tip * 100) / 100;

    bad.sort((a, b) => b.sev - a.sev);
    const OPEN = {
      'sent back': [`I'm sorry, I can't eat this.`, `No. This has to go back.`, `Take it back, please.`],
      accepted: [`It's alright.`, `It's fine, I suppose.`, `Yeah, it's okay.`],
      // kept, but they are not happy about it: a mild opener under a real complaint reads sarcastic
      grudging: [`I'll eat it, but honestly?`, `Right, well.`, `I won't send it back. But.`],
      delighted: [`Now that's a burger.`, `That's the best one I've had in ages.`, `Oh, that's good.`],
    };
    let said;
    if (outcome === 'delighted' || !bad.length) said = good.slice(0, 2).map((g) => g.text);
    else said = [bad[0].text].concat(bad[1] && bad[1].sev >= 0.35 ? [bad[1].text] : []);
    const tone = outcome === 'accepted' && bad.length && bad[0].sev >= 0.7 ? 'grudging' : outcome;
    const quote = '“' + [phrasePick(OPEN[tone], seed, 0)].concat(said).join(' ') + '”';

    return {
      id, score, served: Math.round(served * 10) / 10, outcome, quote,
      complaints: bad, praise: good,
      doneness: { state: doneState, off: Math.round(dist * 10) / 10, got: got.label, want: target.label },
      juiciness: { state: juiceState, retained: wRet, expected: expect, short: Math.round(short * 1000) / 1000 },
      crust: { state: crustState, brown: Math.round(bMean * 100) / 100, char: Math.round(char * 1000) / 1000, marks: Math.round(marks * 100) / 100 },
      temperature: { state: tempState, drop: Math.round(drop * 10) / 10, serveT, penalty: Math.round(coldPen * 10) / 10 },
      structure: { state: structState, faults },
      grill: { grilled: !!from('grilled', false), marks: Math.round(marks * 100) / 100, soot: Math.round(soot * 100) / 100 },
      build: { ok: !badBuild, items: buildItems },
      bill: bill.total, billLines: bill.lines, tip, tipAmount, late,
    };
  }

  return {
    C, BLENDS, PANS, FATS, STOVES, GRATE, COAL, BANK, WOOD, SMOKE, DONENESS, ITEMS, TOUCH, PEEK, HAND,
    roomAir, toggleWindow, stepRoom, makePatty, createState, step, stepPatty, pattySpots, panTat, panTatXY, selectPatty, nextTicket,
    setOven, putInOven, takeFromOven, setKnob, setBank, setTopVent, addWood, addCoals, stirCoals, emptyAsh, ventFlow, smokeRead, smokeName, addFat, placePatty, movePatty, moveItem, scrape, slideTo, coalAt, bedAt, zoneAt, flipPatty, pressPatty, removePatty, addCheese, toggleLid, basteButter, washPan, wipeStove, panDirt, serve,
    makeItem, addItem, selectItem, flipItem, removeItem, reheatItem, discardItem, stepItem, assignTopping, nearestBurger, plannedBurger, toppingsOf, itemState, itemMass, itemT, itemDryness, freeSpot, footprintRings, ringCoverage,
    firmness, firmnessWord, cellStiffness, pressTest, peek, sliceRead, handTest, handTestAt, handWord, HAND_WORDS,
    evaluate, evaluateTicket, buildOf, donenessOf, centerT, cellT, layerMean, gridMean, pattyMass, layerMass, waterHolding, fmtTime, clamp, lerp, rhoVapSat, logEvent, pattyFinite,
    verdict, ticketTargetTime, latePenalty, billFor, tipFraction, spellMinutes, MENU, COOK_S, SERVICE_MAX,
  };
});
