/*
 * Scenario 3 — the charcoal kettle: swap the stove mid-ticket, light the coals, brand a patty over
 * the fire, close the lid, and make it flare up.
 *
 * Everything here is a path that only the kettle has: the stove select swapping the pan away for a
 * grate while the patty is still on the board, the knob meaning vents, the lid meaning an oven, and
 * fat dripping onto the coals catching fire.
 *
 * The burger is deliberately abused at the end — vents wide open and the spatula leaned on it twice
 * after it had already reached its pull temperature — because that is what makes a 70/30 flare. It
 * is scored accordingly: this scenario is not looking for a 100.
 */
'use strict';

module.exports = {
  name: 'charcoal',
  description: 'a kettle cook with the lid and a flare-up',
  async run(k) {
    await k.order(['medium-rare'], 'Table 9', '“Medium-rare, off the charcoal, and I want to taste the fire.”');
    await k.click('#btn-accept');
    await k.choose('#f-blend', '70/30');   // a fatty blend: this is what flares
    await k.range('#f-thick', 18);
    await k.range('#f-mass', 160);
    await k.click('#btn-to-stove');

    // ---- swap the pan for the kettle with the patty still on the board
    k.ok(!(await k.read((g) => !!g.state.grill)), 'we start on the gas');
    await k.range('#knob', 6); // and with the burner lit, to prove the swap really is a cold start
    await k.fast(30);
    await k.choose('#e-stove', 'charcoal');
    const swapped = await k.read((g) => ({
      grill: !!g.state.grill, pan: g.state.pan.id, knob: g.state.stove.knob, T: g.state.pan.T,
      fire: g.state.grill ? g.state.grill.Tfire : null, lit: g.state.grill ? g.state.grill.lit : null,
      label: document.getElementById('knob-label').textContent,
      wash: document.getElementById('btn-wash').textContent,
      panPickerHidden: document.getElementById('e-pan-wrap').hidden,
      fatDisabled: document.getElementById('btn-fat').disabled,
      where: g.patties.length ? g.patties[0].where : 'not formed yet',
    }));
    k.ok(swapped.grill && swapped.pan === 'grate', 'the pan is gone and there is a grate over coals');
    k.ok(swapped.knob === 0 && swapped.T < 25 && !swapped.lit, `a cold kettle: knob ${swapped.knob}, grate ${swapped.T.toFixed(0)} °C, coals unlit`);
    k.ok(swapped.label === 'Vents' && /brush/i.test(swapped.wash), `the knob is now the ${swapped.label} and the wash button says “${swapped.wash}”`);
    k.ok(swapped.panPickerHidden && swapped.fatDisabled, 'no pan picker and no oil to pour: there is no pan');
    k.ok(swapped.where === 'board', 'the patty is untouched on the board');

    // ---- light it: vents wide, wait for the bed to glow and the bars to pass 250 °C
    await k.range('#knob', 8);
    await k.until('the coals to catch and the grate to pass 250 °C',
      (g) => ({ fire: Math.round(g.state.grill.Tfire), grate: Math.round(g.state.pan.T) }),
      (v) => v.fire >= 600 && v.grate >= 250, { chunk: 10, max: 1800 });
    const bed = await k.read((g) => ({ fire: g.state.grill.Tfire, grate: g.state.pan.T, coal: g.state.grill.coal, ash: g.state.grill.ash }));
    k.log(`bed ${bed.fire.toFixed(0)} °C, grate ${bed.grate.toFixed(0)} °C, ${(bed.coal * 1000).toFixed(0)} g of charcoal left`);
    k.ok(bed.ash > 0, 'the coals have started to burn down to ash');
    await k.shot('coals-lit');

    // ---- the wash button is a wire brush over here: it does not cool the bars
    const beforeBrush = await k.read((g) => g.state.pan.T);
    await k.click('#btn-wash');
    const brushed = await k.read((g) => ({ T: g.state.pan.T, water: g.state.pan.water, last: g.state.events[g.state.events.length - 1].text }));
    k.ok(/Brushed the grate/.test(brushed.last), `brushing says “${brushed.last}”`);
    k.ok(brushed.T > beforeBrush - 5 && brushed.water === 0, `the bars stayed at ${brushed.T.toFixed(0)} °C and nothing got wet`);

    // ---- vents to 7 and lay it on
    await k.range('#knob', 7);
    await k.click('#btn-place');
    await k.click('#btn-probe');
    let lastFlip = 0, lidOn = false, sawFlare = 0, shotSear = false;
    for (let guard = 0; guard < 1500; guard++) {
      const st = await k.read((g, P) => {
        const p = g.state.patty;
        return { c: P.centerT(p), cook: p.cookTime, stuck: p.faceDown.stuck, flips: p.flips, marks: p.faceDown.marks || 0, side: p.faceSide.brown, flare: g.state.grill.flare, lid: g.state.lid, top: P.layerMean(p, p.T, p.Nz - 1) };
      });
      sawFlare = Math.max(sawFlare, st.flare);
      if (st.c >= 47) { k.log(`pulled at ${st.c.toFixed(1)} °C after ${st.cook.toFixed(0)} s, ${st.flips} flips`); break; }
      if (!shotSear && st.flips === 1) { await k.shot('bars'); shotSear = true; }
      // lid on for the middle of the cook: the kettle becomes an oven and the top face cooks
      if (!lidOn && st.cook > 90) { await k.click('#btn-lid'); lidOn = true; k.log('lid on'); await k.fast(30); await k.shot('lid-on'); }
      if (lidOn && st.cook > 180 && st.lid) { await k.click('#btn-lid'); k.log('lid off'); }
      if (st.cook - lastFlip >= 45 && !st.stuck) { await k.click('#btn-flip'); lastFlip = st.cook; }
      await k.fast(3); // three simulated seconds per round trip: software WebGL is the slow part
    }
    const grilled = await k.read((g, P) => {
      const p = g.state.patty;
      return { marks: p.faceDown.marks || 0, marksUp: p.faceUp.marks || 0, brown: p.faceDown.brown, side: p.faceSide.brown, grilled: !!p.grilled, dome: p.dome, fat: g.state.grill.fatOnCoals, finite: P.pattyFinite(p) };
    });
    k.ok(grilled.grilled && grilled.marks > 1 && grilled.marksUp > 1, `bars branded into both faces (${grilled.marks.toFixed(1)} / ${grilled.marksUp.toFixed(1)})`);
    k.ok(grilled.marks > grilled.brown, 'the bars are darker than the open face between them');
    k.ok(grilled.side > 0.5, `radiant heat browned the edge too (${grilled.side.toFixed(1)})`);
    k.ok(grilled.finite, 'the patty is finite');

    // ---- press it: a rush of fat onto a hot bed is a flare-up
    await k.range('#knob', 10);
    await k.fast(60);
    await k.click('#btn-press');
    await k.fast(3);
    await k.click('#btn-press');
    for (let i = 0; i < 8; i++) {
      const f = await k.read((g) => g.state.grill.flare);
      sawFlare = Math.max(sawFlare, f);
      if (f > 0.6) break;
      await k.fast(1);
    }
    await k.shot('flare-up');
    const fire = await k.read((g) => ({
      flare: g.state.grill.flare, total: g.state.grill.flareTotal, smoke: g.state.diag.smoke,
      soot: g.state.patty.flareChar || 0,
      logged: g.state.events.some((e) => /FLARE-UP/.test(e.text)),
      hudSmoke: !document.getElementById('h-smoke').hidden,
    }));
    k.ok(sawFlare > 0.6, `pressing a 70/30 over open vents flared: peak ${sawFlare.toFixed(2)}`);
    k.ok(fire.logged, 'the log warned about the flare-up');
    k.ok(fire.soot > 0, `flames sooted the underside (${fire.soot.toFixed(3)})`);
    k.ok(fire.hudSmoke, 'the HUD is showing smoke');

    // ---- off the heat, rest, serve
    await k.click('#btn-remove');
    k.ok(await k.phase() === 'rest', 'off the heat and resting');
    await k.fast(150);
    await k.click('#btn-cut');
    const r = await k.read((g) => ({ total: g.ticketResult.total, peak: g.ticketResult.results[0].peak, notes: g.ticketResult.results[0].notes }));
    k.log(`scored ${r.total}/100, peak ${r.peak.toFixed(1)} °C`);
    await k.shot('result-charcoal');
    k.ok(r.notes.some((n) => /charcoal|Flare/.test(n)), 'the notes talk about the fire');
    k.ok(r.notes.some((n) => /Grill marks/.test(n)), 'the notes mention the bars');
    // this burger was deliberately abused after it hit its pull temperature — vents wide open for
    // another minute and pressed twice — so it should come out cooked past the order and marked
    // down for it, but still be food
    k.ok(r.total >= 35, `a flared, pressed, over-run charcoal cook scored ${r.total}`);
    k.ok(r.total < 95 && r.peak > 47, `and the abuse cost it: ${r.total}/100, centre peaked at ${r.peak.toFixed(1)} °C against an order of 54–57`);
  },
};
