/*
 * Scenario 5 — the interface around the pan: hard mode, the keys, what a finished ticket leaves
 * behind, and whether the cook can still see the panel on a small screen.
 *
 * Hard mode is a promise ("no thermometers"), so it is tested the way a promise is: by walking the
 * page's own text in every phase and failing on any number followed by a degree sign. The rest is
 * the things the help and the README say the interface does — C cuts the burger open wherever the
 * button does, "Next ticket" starts the next table with a clean pass, and the HUD does not eat the
 * cook panel on a 1100×700 window.
 */
'use strict';

/** Every temperature still on screen: walk the visible text and look for “… °C”. */
const leaks = () => {
  const out = [];
  const walk = (el) => {
    if (el.nodeType === 3) { if (/[\d]\s*°C/.test(el.textContent)) out.push(el.textContent.trim().slice(0, 100)); return; }
    if (el.nodeType !== 1 || el.hidden || getComputedStyle(el).display === 'none') return;
    for (const c of el.childNodes) walk(c);
  };
  walk(document.body);
  return out;
};

module.exports = {
  name: 'interface',
  description: 'hard mode keeps its promise, the keys work, and the panel survives a small window',
  async run(k) {
    // ---- hard mode, from the order card through to the customer's verdict
    await k.order(['medium'], 'Table 7', '“Medium, and no cheating with a probe.”');
    await k.check('#hard', true);
    await k.click('#btn-accept');
    k.ok(await k.read(() => document.getElementById('btn-inspector').hidden), 'the Inspector button is gone');
    await k.click('#btn-to-stove');
    await k.range('#knob', 8);
    await k.fast(200);
    await k.click('#btn-place');
    await k.fast(150);
    await k.clickLive('#btn-flip');
    await k.fast(150);
    await k.clickLive('#btn-presstest');
    await k.clickLive('#btn-hand');
    const cook = await k.read(leaks);
    k.ok(cook.length === 0, `nothing on the pass quotes a thermometer while cooking (${cook.length ? cook.join(' | ') : 'clean'})`);
    k.ok(await k.read(() => document.getElementById('btn-probe').disabled), 'and the probe cannot be inserted');
    await k.shot('hard-cooking');
    await k.clickLive('#btn-remove');
    k.ok(await k.phase() === 'rest', 'off the heat and resting');
    await k.fast(60);
    const rest = await k.read(leaks);
    k.ok(rest.length === 0, `nor while it rests (${rest.length ? rest.join(' | ') : 'clean'})`);

    // C works while it rests — the help, the button title and the README all say it is a general key
    const cut0 = await k.read((g) => g.vp.cutaway);
    await k.page.keyboard.press('c');
    const cut1 = await k.read((g) => g.vp.cutaway);
    k.ok(cut0 === false && cut1 === true, 'C cuts the resting patty open');
    await k.page.keyboard.press('c');

    // ---- the results card: the doneness in words, no number and no temperature traces
    await k.clickLive('#btn-cut');
    const result = await k.read(leaks);
    k.ok(result.length === 0, `nor on the results card (${result.length ? result.join(' | ') : 'clean'})`);
    const card = await k.read(() => ({
      peak: document.getElementById('r-stats').textContent.slice(0, 80),
      charts: getComputedStyle(document.querySelector('.charts')).display,
      notes: document.getElementById('r-notes').textContent.slice(0, 120),
    }));
    k.ok(/came out/.test(card.peak), `the card says what it came out as: “${card.peak.split('Ordered')[0].trim()}”`);
    k.ok(card.charts === 'none', 'and the two temperature traces are not drawn');
    k.ok(/·· °C/.test(card.notes), `and the notes read “${card.notes.split('.')[0]}.”`);
    await k.shot('hard-result');

    // and C works on the plate too (the results card turns the cutaway on, so this turns it off)
    await k.page.keyboard.press('c');
    k.ok(await k.read((g) => g.vp.cutaway) === false, 'C works on the plate as well');

    // ---- normal mode gets its numbers back
    await k.clickLive('#btn-again');
    await k.check('#hard', false);
    k.ok(!(await k.read(() => document.getElementById('btn-inspector').hidden)), 'turning hard mode off brings the Inspector back');

    // ---- a finished ticket leaves nothing of itself behind
    await k.order(['medium'], 'Review', '“Medium, with a bun and a rasher.”');
    await k.click('#btn-accept');
    await k.click('#btn-to-stove');
    await k.range('#knob', 8);
    await k.fast(200);
    await k.click('#btn-place');
    await k.click('#btn-bun'); await k.click('#btn-bacon');
    await k.fast(200);
    await k.chip(0); await k.clickLive('#btn-remove');
    await k.read((g) => { for (const it of g.items.slice()) { g.selectItem(it); document.getElementById('btn-remove').click(); } });
    await k.fast(30);
    await k.clickLive('#btn-cut');
    k.ok(await k.read((g) => g.state.items.length) === 3, 'the burger went out with three toppings on it');
    await k.clickLive('#btn-again');
    const next = await k.read((g) => ({ phase: g.phase, items: g.state.items.length, item: !!g.state.item, sel: !!g.selItem, chips: document.getElementById('chips').hidden }));
    k.ok(next.items === 0 && !next.item && !next.sel, `“Next ticket” clears the last table's toppings: ${JSON.stringify(next)}`);
    await k.click('#btn-accept');
    const form = await k.read(() => ({ hidden: document.getElementById('chips').hidden, text: document.getElementById('chips').innerText.trim() }));
    k.ok(form.hidden, `and the next single-burger form phase shows no chip row (“${form.text}”)`);
    await k.shot('next-ticket-form');

    // ---- a busy ticket on a small window: the HUD wraps, but the panel keeps its height
    await k.click('#btn-to-stove');
    await k.choose('#e-stove', 'charcoal');
    await k.range('#knob', 10);
    await k.fast(400);
    await k.click('#btn-bun'); await k.click('#btn-bacon'); await k.click('#btn-egg'); await k.click('#btn-onion');
    await k.fast(60);
    for (const [w, h] of [[1400, 860], [1100, 700]]) {
      await k.page.setViewportSize({ width: w, height: h });
      await k.page.waitForTimeout(300);
      const box = await k.read(() => {
        const hud = document.getElementById('hud'), panel = document.getElementById('panel');
        const hr = hud.getBoundingClientRect(), pr = panel.getBoundingClientRect();
        return { hud: Math.round(hr.height), hudRight: Math.round(hr.right), panelTop: Math.round(pr.top), panelLeft: Math.round(pr.left), panelH: panel.clientHeight, scrollH: panel.scrollHeight };
      });
      k.log(`${w}×${h}: HUD ${box.hud} px, panel ${box.panelH} px of ${box.scrollH} px of controls`);
      k.ok(box.panelTop <= 190, `the panel does not follow the HUD past its cap (top ${box.panelTop} px)`);
      k.ok(box.panelH > h * 0.55, `the cook keeps ${box.panelH} px of panel on a ${h} px window`);
      k.ok(box.hudRight <= box.panelLeft, 'and the HUD still stops short of the panel rather than running under it');
      await k.shot(`hud-${w}x${h}`);
    }
    await k.page.setViewportSize({ width: 1400, height: 860 });
  },
};
