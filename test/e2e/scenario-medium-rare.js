/*
 * Scenario 1 — one medium-rare, cooked through the README recipe, in the real UI.
 *
 * 150 g of 80/20 at 18 mm from the fridge, cast iron on gas held at 200 °C, 8 g of canola, flipped
 * every 45 s, pulled when the centre reaches 47 °C, rested two and a half minutes. That is the
 * recipe the physics tests score 100, so the same recipe driven through the buttons has to score
 * 100 as well: if the UI and the model ever disagree about what the player asked for, this fails.
 */
'use strict';

module.exports = {
  name: 'medium-rare',
  description: 'the README recipe, through the buttons, must score 100',
  async run(k) {
    await k.order(['medium-rare'], 'Table 7', '“Medium-rare, please, and a good crust on it.”');
    await k.click('#btn-accept');
    k.ok(await k.phase() === 'form', 'the ticket was accepted and we are forming');

    // ---- 1. form the patty: 150 g, 18 mm, 80/20, fridge cold, dimpled, salted on the surface
    await k.choose('#f-blend', '80/20');
    await k.range('#f-mass', 150);
    await k.range('#f-thick', 18);
    await k.range('#f-work', 35);
    await k.choose('#f-temp', 'fridge');
    await k.choose('#f-salt', 'surface');
    await k.check('#f-dimple', true);
    const form = await k.read((g) => ({ D: g.preview.D, h: g.preview.h0, T: g.preview.T0, fat: g.preview.fatFrac, dimple: g.preview.dimple }));
    k.near(form.h * 1000, 18, 0.01, 'the preview patty is 18 mm thick');
    k.near(form.T, 4, 0.01, 'straight from the fridge');
    k.near(form.fat, 0.2, 1e-9, '80/20');
    k.ok(form.dimple && form.D > 0.09 && form.D < 0.115, `dimpled, ${(form.D * 100).toFixed(1)} cm across`);
    await k.shot('form');

    // ---- 2. to the stove: cast iron on gas, knob to 8 until the IR gun reads 200 °C
    await k.click('#btn-to-stove');
    k.ok(await k.phase() === 'cook', 'we are at the stove');
    await k.choose('#e-stove', 'gas');
    await k.choose('#e-pan', 'castiron');
    await k.range('#knob', 8);
    await k.until('the pan to reach 200 °C', (g) => g.state.pan.T, (T) => T >= 200, { chunk: 5, max: 900 });
    const hot = await k.read((g) => ({ T: g.state.pan.T, c: g.state.pan.Tcenter, e: g.state.pan.Tedge, hud: document.getElementById('h-pan').textContent }));
    k.ok(hot.c > hot.e + 20, `the burner has made a hot spot: centre ${hot.c.toFixed(0)} °C, rim ${hot.e.toFixed(0)} °C`);
    k.ok(/\d+ °C/.test(hot.hud), `the IR gun reads ${hot.hud}`);
    await k.shot('preheated');

    // ---- 3. 8 g of canola, lay it in, probe at 50 % depth
    await k.choose('#e-fat', 'canola');
    await k.range('#e-fatg', 8);
    await k.click('#btn-fat');
    k.near((await k.read((g) => g.state.pan.oil)) * 1000, 8, 0.5, '8 g of oil in the pan');
    await k.click('#btn-place');
    await k.range('#probe-depth', 50);
    await k.click('#btn-probe');
    k.ok((await k.read((g) => g.state.patty.where)) === 'pan', 'the patty is in the pan');

    // ---- 4. hold 200 °C, flip every 45 s once it releases, pull at 47 °C in the centre
    let lastFlip = 0, shot = false;
    for (let guard = 0; guard < 1200; guard++) {
      const st = await k.read((g, P) => {
        const p = g.state.patty;
        return { pan: g.state.pan.T, knob: g.state.stove.knob, c: P.centerT(p), stuck: p.faceDown.stuck, cook: p.cookTime, flips: p.flips, brown: p.faceDown.brown, probe: g.probe.reading };
      });
      if (st.c >= 47) { k.log(`pulled at ${st.c.toFixed(1)} °C centre after ${st.cook.toFixed(0)} s and ${st.flips} flips`); break; }
      const knob = Math.max(0, Math.min(10, Math.round((st.knob + (200 - st.pan) * 0.02) * 2) / 2));
      if (knob !== st.knob) await k.range('#knob', knob);          // watch the IR gun and nudge it
      if (st.cook - lastFlip >= 45 && !st.stuck) { await k.click('#btn-flip'); lastFlip = st.cook; }
      if (!shot && st.flips >= 1) { await k.shot('searing'); shot = true; }
      await k.fast(3); // three simulated seconds per round trip: software WebGL is the slow part here
    }
    const cooked = await k.read((g, P) => {
      const p = g.state.patty;
      return { c: P.centerT(p), flips: p.flips, cook: p.cookTime, down: p.faceDown.brown, up: p.faceUp.brown, char: Math.max(p.faceDown.char, p.faceUp.char), torn: p.faceDown.torn + p.faceUp.torn };
    });
    k.ok(cooked.flips >= 6, `flipped ${cooked.flips} times`);
    k.ok(Math.min(cooked.down, cooked.up) > 1.5, `crust on both faces (${cooked.down.toFixed(1)} / ${cooked.up.toFixed(1)})`);
    k.ok(cooked.char < 0.15 && cooked.torn === 0, 'nothing burnt, nothing torn');

    // ---- 5. off the heat, check the probe follows the meat, rest 2.5 min, then serve
    await k.click('#btn-remove');
    k.ok(await k.phase() === 'rest', 'the burner went off with the patty and we are resting');
    await k.page.waitForTimeout(2500); // the thermometer settles in real time, not in fast-forward
    const probe = await k.read((g, P) => ({ reading: g.probe.reading, centre: P.centerT(g.state.patty), hud: document.getElementById('h-probe').textContent }));
    k.ok(Math.abs(probe.reading - probe.centre) < 5, `the probe reads ${probe.hud} against a true centre of ${probe.centre.toFixed(1)} °C`);
    await k.fast(150);
    await k.shot('resting');
    await k.click('#btn-cut');
    k.ok(await k.phase() === 'result', 'served');

    // ---- 6. the score
    const score = Number(await k.text('#r-score'));
    const parts = await k.read((g) => g.ticketResult.results[0].parts);
    const peak = await k.read((g) => g.ticketResult.results[0].peak);
    k.log(`peak centre ${peak.toFixed(1)} °C, parts ${JSON.stringify(parts)}`);
    await k.shot('result');
    k.ok(score === 100, `the README recipe scored ${score}/100 through the UI ${JSON.stringify(parts)}`);
    k.ok(/Exactly what they asked for/.test(await k.text('#r-verdict')), 'the verdict says it is exactly what they asked for');
  },
};
