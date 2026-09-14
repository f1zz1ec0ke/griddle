/*
 * Scenario 4 — the viewport itself: what it hands back to the GPU, and whether it draws what the
 * physics says is there.
 *
 * Nothing here is about the meat. It is about the renderer's own bookkeeping — every geometry,
 * material and texture a patty, a topping, a burner or a pan builds has to be given back when the
 * thing goes away, or a six-ticket shift (and a form slider, which builds a new preview patty on
 * every input event) walks the GPU out of memory — and about four things the model computes that
 * the picture used to drop on the floor: bar marks on a face that has not browned as a whole, a
 * topping stack with air between the layers, juice beads left behind when the patty is slid across
 * the pan, and the residue on a kettle's bars that the wire brush is for.
 *
 * `renderer.info.memory` is three.js's own count of live GPU objects, so these are the real numbers
 * rather than a proxy for them.
 */
'use strict';

const mem = (g) => ({ geometries: g.vp.renderer.info.memory.geometries, textures: g.vp.renderer.info.memory.textures });
/** Take everything off the metal: the patties first, then the toppings. */
const clearMetal = async (k, n) => {
  for (let i = 0; i < n; i++) { await k.chip(i); await k.clickLive('#btn-remove'); }
  await k.read((g) => { for (const it of g.items.slice()) { g.selectItem(it); document.getElementById('btn-remove').click(); } });
};

module.exports = {
  name: 'viewport',
  description: 'the renderer gives its memory back, and draws what the model says is there',
  async run(k) {
    // ---- the form slider: every input event makes a new patty object and a new PattyView
    await k.order(['medium'], 'Review', '“Medium, and take your time forming it.”');
    await k.click('#btn-accept');
    await k.frames(2); // include the preview's first GPU upload in the baseline
    const m0 = await k.read(mem);
    for (let i = 0; i < 20; i++) await k.range('#f-thick', 12 + (i % 18));
    for (let i = 0; i < 20; i++) await k.range('#f-mass', 120 + (i % 18) * 5);
    await k.frames(2);
    const m1 = await k.read(mem);
    k.ok(m1.textures === m0.textures && m1.geometries === m0.geometries,
      `40 slider ticks leak nothing: ${JSON.stringify(m0)} → ${JSON.stringify(m1)}`);

    // ---- swapping the stove throws a whole burner away and builds another one
    await k.click('#btn-to-stove');
    const swaps = {};
    for (const id of ['gas', 'charcoal', 'induction', 'gas', 'charcoal', 'electric', 'gas']) {
      await k.choose('#e-stove', id);
      await k.frames(2);
      const m = await k.read(mem);
      if (swaps[id] === undefined) swaps[id] = m.geometries;
      else k.ok(m.geometries === swaps[id], `the ${id} stove is still ${m.geometries} geometries the second time it is built`);
    }
    k.log(`geometries per stove: ${Object.entries(swaps).map(([n, v]) => `${n} ${v}`).join(', ')}`);

    // ---- three tickets of two burgers with toppings, counted in the order phase between tickets,
    // when the scene holds no patties and no toppings at all
    const between = [];
    for (let t = 0; t < 3; t++) {
      await k.order(['medium', 'medium'], 'Review', '“Two mediums, with everything.”');
      await k.click('#btn-accept');
      await k.click('#btn-to-stove');
      await k.range('#knob', 8);
      await k.fast(200);
      for (let i = 0; i < 2; i++) { await k.chip(i); await k.clickLive('#btn-place'); }
      await k.click('#btn-bun'); await k.click('#btn-bacon'); await k.click('#btn-egg');
      await k.chip(0); await k.clickLive('#btn-cheese');
      await k.fast(120);
      for (let i = 0; i < 2; i++) { await k.chip(i); await k.clickLive('#btn-flip'); }
      await k.fast(120);
      await clearMetal(k, 2);
      await k.fast(60);
      await k.clickLive('#btn-cut');
      if (t === 0) await k.shot('served-with-toppings');
      await k.clickLive('#btn-again');
      await k.frames(2);
      between.push(await k.read((g) => ({ geometries: g.vp.renderer.info.memory.geometries, textures: g.vp.renderer.info.memory.textures, views: g.vp.views.size, items: g.vp.itemViews.size })));
    }
    k.log(`between tickets: ${between.map((b) => `${b.geometries} geo / ${b.textures} tex`).join('  →  ')}`);
    k.ok(between.every((b) => b.views === 0 && b.items === 0), 'no patty or topping view survives into the next order');
    k.ok(between[2].textures <= between[1].textures && between[2].geometries <= between[1].geometries,
      `a ticket costs nothing it does not give back: ${JSON.stringify(between[1])} → ${JSON.stringify(between[2])}`);

    // ---- a peek on one patty must not leave another one lying open on the pan
    await k.order(['medium-rare', 'medium'], 'Review', '“One medium-rare, one medium.”');
    await k.click('#btn-accept');
    await k.click('#btn-to-stove');
    await k.range('#knob', 7);
    await k.fast(200);
    for (let i = 0; i < 2; i++) { await k.chip(i); await k.clickLive('#btn-place'); }
    await k.fast(120);
    await k.chip(0); await k.clickLive('#btn-peek');
    await k.chip(1); await k.clickLive('#btn-peek');
    const peeked = await k.read((g) => ({ n: g.vp.peeks.size, cut: g.patties.map((p) => g.vp.views.get(p).cutaway) }));
    k.ok(peeked.n === 2 && peeked.cut[0] && peeked.cut[1], `both cuts are open at once: ${JSON.stringify(peeked)}`);
    await k.page.waitForTimeout(5200); // a peek closes on wall clock, not on the simulation's
    await k.frames(2);
    const closed = await k.read((g) => ({ n: g.vp.peeks.size, cut: g.patties.map((p) => g.vp.views.get(p).cutaway), btn: g.vp.cutaway }));
    k.ok(!closed.btn && closed.n === 0 && !closed.cut[0] && !closed.cut[1], `and both close again: ${JSON.stringify(closed)}`);

    // ---- juice beads ride on the meat, not on the metal. The juice on the top face is the
    // physics's own — squeezed out of the contracting proteins — so wait for it rather than fake it
    await k.chip(0);
    await k.until('juice to pool on the up face', (g) => g.patties[0].poolTop, (v) => v > 4e-5, { chunk: 10, max: 600 });
    await k.frames(2);
    const beads0 = await k.read((g) => { const p = g.patties[0]; return { pool: p.poolTop, n: g.vp.beads.parts.filter((b) => b.q === p).length }; });
    k.ok(beads0.n > 0, `${(beads0.pool * 1000).toFixed(2)} g of juice on the top face, drawn as ${beads0.n} beads`);
    await k.clickLive('#btn-move-out');
    await k.frames(2);
    const beads1 = await k.read((g) => { const p = g.patties[0]; const mine = g.vp.beads.parts.filter((b) => b.q === p); return { moved: Math.hypot(p.pos.x, p.pos.y), n: mine.length, off: mine.filter((b) => Math.hypot(b.x - p.pos.x, b.z - p.pos.y) > p.D / 2).length }; });
    k.ok(beads1.moved > 0.02, `the patty slid ${(beads1.moved * 100).toFixed(1)} cm across the pan`);
    k.ok(beads1.n > 0 && beads1.off === 0, `all ${beads1.n} beads went with it (${beads1.off} left hanging over bare metal)`);

    // ---- build through the current controls, then check contact and compression on the plate.
    await k.click('#btn-bacon');
    await k.click('#btn-egg');
    const yolk = await k.until('the egg to set', (g) => g.items.find((i) => i.kind === 'egg').yolkSet, (v) => v > 0.8, { chunk: 15, max: 900 });
    k.log(`the egg went out with its yolk at ${yolk.toFixed(2)}`);
    await clearMetal(k, 2);
    await k.click('#btn-bun');
    await k.fast(20);
    await clearMetal(k, 2);
    const build = await k.read(g => ['bottom','bacon','egg','top'].map(key =>
      g.items.find(it => key === 'bottom' || key === 'top' ? it.kind === 'bun' && it.half === key : it.kind === key).id));
    await k.chip(0);
    await k.clickLive('#open-build');
    await k.clickLive(`[data-build="item:${build[0]}"]`);
    await k.clickLive('[data-build="patty"]');
    for (const id of build.slice(1)) await k.clickLive(`[data-build="item:${id}"]`);
    await k.clickLive('#close-build');
    await k.clickLive('#btn-cut');
    await k.frames(3);
    const stack = await k.read((g) => {
      const p = g.patties[0], v = g.vp.views.get(p);
      const of = (kind,half) => { for (const [it, iv] of g.vp.itemViews) if (it.kind === kind && it.burger === p.id && (!half || it.half === half)) return iv; return null; };
      const bacon = of('bacon'), egg = of('egg'), top = of('bun','top');
      const meatH = p.h * (1 + 0.28 * p.dome) + p.cheeses.length * 0.0015;
      return {
        base: v.group.position.y + meatH * v.group.scale.y,
        bacon: { y: bacon.group.position.y, h: bacon.layerH() * bacon.group.scale.y },
        egg: { y: egg.group.position.y, h: egg.layerH() * egg.group.scale.y },
        yolkTop: egg.group.position.y + (egg.yolkMesh.position.y + 0.021 * egg.yolkMesh.scale.y) * egg.group.scale.y,
        crown: top.group.position.y,
        height: g.vp.assemblyViews.get(p).userData.height,
        uncompressed: meatH + [...g.vp.itemViews].filter(([it]) => it.burger === p.id).reduce((h,[,iv]) => h + iv.layerH(),0),
      };
    });
    k.near(stack.bacon.y, stack.base, 1e-4, 'the bacon lies on the patty, not above it');
    k.ok(stack.egg.y > stack.bacon.y && stack.egg.y <= stack.bacon.y + stack.bacon.h + 1e-4, 'the egg settles into the bacon without an air gap');
    k.near(stack.crown, stack.egg.y + stack.egg.h, 1e-4, 'the top bun rests on the compressed egg');
    k.ok(stack.height < stack.uncompressed, 'the assembled burger is shorter than the sum of its loose layers');
    k.ok(stack.crown > stack.yolkTop, `the crown clears the yolk — ${(stack.crown * 1000).toFixed(1)} mm over a yolk reaching ${(stack.yolkTop * 1000).toFixed(1)} mm — so the yolk is visible`);
    await k.shot('served-stack');

    // ---- the cutaway's clipping plane is not rebuilt (and every material re-initialised) per frame
    const versions = () => k.read((g) => { const out = []; for (const [, iv] of g.vp.itemViews) iv.group.traverse((o) => { if (o.isMesh && o.material) out.push(o.material.version); }); return out.join(','); });
    const vA = await versions();
    await k.frames(4);
    const vB = await versions();
    k.ok(vA.length > 0 && vA === vB, 'the toppings\' materials are not invalidated on every frame of the cutaway');

    // ---- bar marks on a face that has not browned as a whole yet, and residue on the bars
    await k.clickLive('#btn-again');
    await k.order(['medium', 'medium'], 'Review', '“Two mediums, off the charcoal.”');
    await k.click('#btn-accept');
    await k.click('#btn-to-stove');
    await k.choose('#e-stove', 'charcoal');
    await k.range('#knob', 10);
    await k.until('the bed to light and the bars to pass 400 °C', (g) => Math.round(g.state.pan.T), (T) => T >= 400, { chunk: 10, max: 1800 });
    await k.chip(0);
    await k.clickLive('#btn-place');
    await k.fast(45);                 // the README's grill cadence: flip every 45 s
    await k.clickLive('#btn-flip');
    await k.frames(3);                // let the atlas repaint
    const face = await k.read((g) => ({ marks: g.patties[0].faceUp.marks, brown: g.patties[0].faceUp.brown }));
    k.ok(face.marks > 0.2 && face.brown < 0.3, `after one 45 s side the face turned up carries marks ${face.marks.toFixed(2)} on a mean browning of only ${face.brown.toFixed(2)}`);
    // the atlas's top cap, sampled round a ring the bars cross: the bars are a band every 28 % of
    // the radius, so they are a spread of luminance that plain meat and fat specks do not have
    const spread = await k.read((g) => {
      const v = g.vp.views.get(g.patties[0]), W = v.atlas.width, R = 0.235 * W;
      const d = v.atlas.getContext('2d').getImageData(0, 0, W / 2, W / 2).data;
      let lo = 255, hi = 0;
      for (let i = 0; i < 720; i++) {
        const a = (i / 720) * Math.PI * 2, x = Math.round(W * 0.25 + Math.cos(a) * R * 0.6), y = Math.round(W * 0.25 + Math.sin(a) * R * 0.6);
        const c = (y * (W / 2) + x) * 4, l = 0.299 * d[c] + 0.587 * d[c + 1] + 0.114 * d[c + 2];
        if (l < lo) lo = l; if (l > hi) hi = l;
      }
      return { lo: Math.round(lo), hi: Math.round(hi) };
    });
    k.ok(spread.hi - spread.lo > 25, `the bars are on the atlas: luminance runs ${spread.lo}–${spread.hi} round the cap`);
    await k.read((g) => { const c = g.vp.controls; c.preset('close'); c.goal.polar = 0.5; c.goal.dist = 0.22; });
    await k.frames(12);               // the camera eases in over a second or so
    await k.shot('grill-marks-on-a-raw-face');

    // sliding it while it is still welded down tears crust off onto the bars; the second patty stays
    // on the board so the ticket is still being cooked and the brush is available
    await k.fast(20);                   // long enough on the new face for the crust to weld to the bars
    await k.clickLive('#btn-move-out');
    await k.fast(40);
    await k.clickLive('#btn-remove');
    await k.frames(6); // let the throttled dirt texture catch up with fast-forwarded physics
    const dirty = await k.read((g) => ({ parent: g.vp.fond.parent === g.vp.stove ? 'stove' : 'panGroup', visible: g.vp.fond.visible, y: g.vp.fond.position.y, panY: g.vp.PAN_Y, panGroup: g.vp.panGroup.visible, bits: g.state.pan.meatBits + g.state.pan.fond, phase: g.phase }));
    k.ok(dirty.parent === 'stove' && dirty.panGroup === false, 'the residue hangs off the stove, so hiding the pan for a kettle does not hide it too');
    k.ok(dirty.bits > 1e-5 && dirty.visible, `${(dirty.bits * 1000).toFixed(2)} g of torn crust and fond on the bars, and it is drawn`);
    k.near(dirty.y, dirty.panY + 0.0004, 1e-5, 'and it is drawn on the crowns of the bars');
    const painted = await k.read((g) => { const d = g.vp.dirtCv.getContext('2d').getImageData(0, 0, 512, 512).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 12) n++; return n / (512 * 512); });
    k.ok(painted > 0.02 && painted < 0.45, `visible flecks stay on the bars (${(painted * 100).toFixed(2)} % of the disc carries dirt)`);
    await k.read((g) => { const c = g.vp.controls; c.goal.target.set(0, g.vp.PAN_Y - 0.01, 0); c.goal.polar = 0.28; c.goal.dist = 0.42; });
    await k.frames(12);
    await k.shot('grate-residue');
    await k.clickLive('#btn-wash');
    await k.frames(2);
    const brushed = await k.read((g) => ({ visible: g.vp.fond.visible, bits: g.state.pan.meatBits + g.state.pan.fond, T: g.state.pan.T }));
    k.ok(brushed.bits === 0 && !brushed.visible, `the wire brush takes it all off and the bars stay at ${brushed.T.toFixed(0)} °C`);
    await k.frames(6);
    await k.shot('grate-brushed');
  },
};
