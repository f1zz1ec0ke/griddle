/*
 * Scenario 2 — a three-burger ticket in one pan: medium-rare, medium-well and well done, all off
 * the heat together.
 *
 * This is the part of the game that only exists in the UI: three patties, each formed on its own
 * chip, each laid in at its own spot, each flipped and pulled on its own, and one score at the end
 * that punishes any burger that sat on the plate going cold. Start the well done first, the
 * medium-rare last.
 */
'use strict';

const ORDER = [
  { target: 'medium-well', thick: 14, pull: 61 },
  { target: 'well-done', thick: 14, pull: 68 },
  { target: 'medium-rare', thick: 18, pull: 47 },
];

module.exports = {
  name: 'ticket-of-three',
  description: 'three burgers, one pan, all off the heat together',
  async run(k) {
    await k.order(ORDER.map((o) => o.target), 'Family of three', '“Medium-well, a well-done for the kid, and a medium-rare. Hot, please.”');
    await k.click('#btn-accept');

    // ---- form all three: the well-done and the medium-well want a thinner patty than the rare
    for (let i = 0; i < ORDER.length; i++) {
      await k.chip(i);
      await k.range('#f-thick', ORDER[i].thick);
      await k.range('#f-mass', 150);
      await k.check('#f-dimple', true);
    }
    const forms = await k.read((g) => g.forms.map((f) => ({ t: f.target, mm: f.thicknessMm })));
    k.ok(forms.length === 3 && forms.every((f, i) => f.mm === [14, 14, 18][i]), `three patties formed: ${JSON.stringify(forms)}`);
    await k.shot('form-three');

    // ---- one pan, preheated, oiled
    await k.click('#btn-to-stove');
    await k.range('#knob', 8);
    await k.until('the pan to reach 200 °C', (g) => g.state.pan.T, (T) => T >= 200, { chunk: 5, max: 900 });
    await k.range('#e-fatg', 12);
    await k.click('#btn-fat');

    // ---- lay them in longest-first: well done (index 1), medium-well (0), then medium-rare (2)
    const ringsBefore = await k.read((g) => Array.from(g.state.pan.Tr));
    const order = [1, 0, 2];
    for (const i of order) {
      await k.chip(i);
      await k.click('#btn-place');
      k.log(`patty ${i + 1} (${ORDER[i].target}) laid in`);
      await k.fast(45); // stagger them: the long one gets a head start
    }
    const spots = await k.read((g) => g.patties.map((p) => [Math.round(p.pos.x * 1000), Math.round(p.pos.y * 1000)]));
    k.ok(new Set(spots.map(String)).size === 3, `three separate spots in the pan: ${JSON.stringify(spots)}`);
    // the three spots sit about 6.7 cm out, which is rings 4 to 6 of the twelve: that is the metal
    // the meat is drinking from, and it sags while the uncovered rim carries on heating
    const ringsAfter = await k.read((g) => Array.from(g.state.pan.Tr));
    const band = (a) => (a[4] + a[5] + a[6]) / 3;
    k.ok(band(ringsAfter) < band(ringsBefore) - 20, `the metal under the meat sagged from ${band(ringsBefore).toFixed(0)} to ${band(ringsAfter).toFixed(0)} °C`);
    await k.shot('three-in-the-pan');

    // ---- cook: hold the pan, flip each one every 45 s, pull each at its own temperature
    const lastFlip = [0, 0, 0];
    for (let guard = 0; guard < 2000; guard++) {
      // g.patties is in ticket order, one per chip; g.state.patties is in the order they were
      // laid in, which is not the same thing
      const st = await k.read((g, P) => ({
        pan: g.state.pan.T, knob: g.state.stove.knob,
        p: g.patties.map((p) => ({ id: p.id, where: p.where, c: P.centerT(p), cook: p.cookTime, stuck: p.faceDown.stuck, flips: p.flips })),
      }));
      if (st.p.every((p) => p.where !== 'pan')) break;
      const knob = Math.max(0, Math.min(10, Math.round((st.knob + (210 - st.pan) * 0.02) * 2) / 2));
      if (knob !== st.knob) await k.range('#knob', knob);
      for (let i = 0; i < st.p.length; i++) {
        const p = st.p[i];
        if (p.where !== 'pan') continue;
        if (p.c >= ORDER[i].pull) { await k.chip(i); await k.click('#btn-remove'); k.log(`patty ${i + 1} (${ORDER[i].target}) off at ${p.c.toFixed(1)} °C after ${p.cook.toFixed(0)} s`); continue; }
        if (p.cook - lastFlip[i] >= 45 && !p.stuck) { await k.chip(i); await k.click('#btn-flip'); lastFlip[i] = p.cook; }
      }
      await k.fast(3);
    }
    k.ok(await k.phase() === 'rest', 'all three are off the heat and resting');
    const rests = await k.read((g) => g.patties.map((p) => p.restT || 0));
    k.log(`rest times ${rests.map((r) => r.toFixed(0)).join(' / ')} s — spread ${(Math.max(...rests) - Math.min(...rests)).toFixed(0)} s`);
    await k.fast(120);
    await k.shot('resting-three');

    // ---- serve: three scores, one ticket
    await k.click('#btn-cut');
    const tk = await k.read((g) => ({
      total: g.ticketResult.total, mean: g.ticketResult.mean, cold: g.ticketResult.coldPenalty,
      each: g.ticketResult.results.map((r) => ({ id: r.id, t: r.target.id, score: r.total, peak: Number(r.peak.toFixed(1)), dist: Number(r.dist.toFixed(1)) })),
    }));
    k.log(`ticket ${tk.total} = mean ${tk.mean} − ${tk.cold} cold: ${tk.each.map((r) => `${r.t} ${r.score}/100 @ ${r.peak} °C`).join(', ')}`);
    await k.shot('result-three');
    k.ok(tk.each.length === 3, 'three burgers scored');
    k.ok(tk.each.every((r) => r.dist <= 2), `every burger landed in (or within 2 °C of) its band: ${JSON.stringify(tk.each)}`);
    k.ok(tk.total >= 80, `ticket scored ${tk.total}/100`);
    // the chips on the results screen let you flip between the three burgers
    await k.clickLive('#r-chips [data-chip="2"]');
    k.ok(/Patty 3/.test(await k.text('#r-verdict')), 'the result chips select each burger');
  },
};
