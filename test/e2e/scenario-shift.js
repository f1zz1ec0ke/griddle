/*
 * Scenario 4 — a whole shift: six tickets, the running total, and the card at the end.
 *
 * The shift lives entirely in js/game.js (planShift, recordTicket, the running total on #r-shift,
 * the "Finish the shift →" routing on #btn-again, showShiftEnd, the best-shift record and
 * newShift) and none of it can be reached from physics.test.js, so this is the only thing that
 * would notice if a ticket stopped counting, counted twice, or the card stopped adding up.
 *
 * Six short tickets: five cooked properly on the same pan (which keeps its heat from one ticket to
 * the next, exactly as a real one does), and one deliberately sent out raw — that plate is comped,
 * scores nothing for the shift and tips nothing, and the card has to say so. Then the end-of-shift
 * card, and a new shift on a stove that is still hot.
 */
'use strict';

const TICKETS = [
  { who: 'Table 3', line: '“Medium-rare, and quickly.”', target: 'medium-rare', raw: false },
  { who: 'Table 4', line: '“Medium-rare. She is in a hurry.”', target: 'medium-rare', raw: true }, // sent out raw on purpose
  { who: 'Table 5', line: '“Medium-rare, please.”', target: 'medium-rare', raw: false },
  { who: 'Table 6', line: '“Medium-rare, thanks.”', target: 'medium-rare', raw: false },
  { who: 'Table 7', line: '“Medium-rare for me.”', target: 'medium-rare', raw: false },
  { who: 'Table 8', line: '“Last one — medium-rare.”', target: 'medium-rare', raw: false },
];

module.exports = {
  name: 'shift',
  description: 'six tickets, a plate sent back, and the end-of-shift card that has to add up',
  async run(k) {
    const seen = [];                                   // what the results screen said about each ticket
    for (let i = 0; i < TICKETS.length; i++) {
      const t = TICKETS[i];
      await k.order([t.target], t.who, t.line);
      k.ok(await k.read((g) => g.shift.n) === i, `the shift is on ticket ${i + 1} of 6 before it is accepted`);
      if (i === 0) k.ok(!(await k.read((g) => g.hasUnfinishedShift())), 'an untouched first order has no shift progress to lose');
      await k.click('#btn-accept');
      if (i === 0) k.ok(await k.read((g) => g.hasUnfinishedShift()), 'accepting the first ticket immediately enables reload protection');

      // ---- form: 14 mm so the whole service fits in a test
      await k.range('#f-thick', 14);
      await k.range('#f-mass', 150);
      await k.click('#btn-to-stove');
      if (i === 0) {                                   // the fire is lit once; after that the pan is where the last ticket left it
        await k.choose('#e-stove', 'gas');
        await k.choose('#e-pan', 'castiron');
        await k.range('#knob', 8);
        await k.until('the pan to reach 200 °C', (g) => g.state.pan.T, (T) => T >= 200, { chunk: 20, max: 900 });
        await k.choose('#e-fat', 'canola');
        await k.range('#e-fatg', 8);
        await k.click('#btn-fat');
      } else {
        // the pan is a thing you keep: it cools while the next patty is formed, but it never goes
        // back to room temperature between tickets (measured 149–163 °C at the start of a ticket)
        const pan = await k.read((g) => g.state.pan.T);
        k.ok(pan > 100, `ticket ${i + 1} starts on a pan that is still ${pan.toFixed(0)} °C from the last one`);
      }
      await k.click('#btn-place');

      if (t.raw) {
        // straight out of the pan and onto the plate: a raw burger is a send-back, and a send-back
        // is comped — no points on the shift, no tip
        await k.fast(20);
        await k.click('#btn-remove');
        await k.click('#btn-cut');
      } else {
        let lastFlip = 0;
        for (let guard = 0; guard < 400; guard++) {
          const st = await k.read((g, P) => ({ pan: g.state.pan.T, knob: g.state.stove.knob, c: P.centerT(g.state.patty), cook: g.state.patty.cookTime, stuck: g.state.patty.faceDown.stuck }));
          if (st.c >= 47) break;
          const knob = Math.max(0, Math.min(10, Math.round((st.knob + (200 - st.pan) * 0.02) * 2) / 2));
          if (knob !== st.knob) await k.range('#knob', knob);
          if (st.cook - lastFlip >= 45 && !st.stuck) { await k.click('#btn-flip'); lastFlip = st.cook; }
          await k.fast(8);
        }
        await k.click('#btn-remove');
        k.ok(await k.phase() === 'rest', `ticket ${i + 1} is resting`);
        await k.fast(120);
        await k.click('#btn-cut');
      }
      k.ok(await k.phase() === 'result', `ticket ${i + 1} is on the pass`);

      // ---- what this ticket did to the shift
      const sh = await k.read((g) => ({ n: g.shift.n, points: g.shift.points, tips: g.shift.tips, covers: g.shift.covers, last: g.shift.tickets[g.shift.tickets.length - 1], again: document.getElementById('btn-again').textContent, run: document.getElementById('r-shift').textContent }));
      k.ok(sh.n === i + 1, `the shift counted ticket ${i + 1} exactly once (n=${sh.n})`);
      k.ok(sh.last.n === i + 1 && sh.last.who === t.who, `the card remembers it as #${sh.last.n} ${sh.last.who}`);
      k.ok(/Shift\s+ticket\s+\d+\s+of\s+6/.test(sh.run.replace(/\s+/g, ' ')), `the results screen shows the running total: ${sh.run.replace(/\s+/g, ' ').slice(0, 120)}`);
      if (t.raw) {
        k.ok(sh.last.sentBack && sh.last.points === 0 && sh.last.tips === 0, `the raw one went back: ${sh.last.points} points, ${sh.last.tips.toFixed(2)} in tips`);
        k.ok(/sent back/.test(sh.run), 'and the running total says so');
      } else {
        k.ok(!sh.last.sentBack && sh.last.points > 0, `ticket ${i + 1} scored ${sh.last.points}`);
      }
      const want = i === TICKETS.length - 1 ? 'Finish the shift →' : 'Next ticket';
      k.ok(sh.again === want, `the button on ticket ${i + 1} reads “${sh.again}”`);
      seen.push(sh.last);
      if (i === 0 || t.raw) await k.shot(`ticket-${i + 1}-result`);
      await k.click('#btn-again');
    }

    // ---- the card: six rows, and the totals are the sum of the six tickets
    const end = await k.read((g) => ({
      hidden: document.getElementById('shiftend').hidden,
      rows: [...document.querySelectorAll('#se-tickets .t')].map((el) => el.textContent),
      sent: document.querySelectorAll('#se-tickets .t.sent').length,
      score: document.getElementById('se-score').textContent,
      stats: document.getElementById('se-stats').textContent,
      best: document.getElementById('se-best').textContent,
      shift: { n: g.shift.n, points: g.shift.points, tips: g.shift.tips, covers: g.shift.covers },
      stored: localStorage.getItem('griddle.bestShift'),
      unfinished: g.hasUnfinishedShift(),
    }));
    k.ok(!end.hidden, 'the end-of-shift card is up');
    k.ok(end.rows.length === 6, `six tickets on the card, one row each (${end.rows.length})`);
    k.ok(end.sent === 1, `the plate that went back is marked as such (${end.sent} row)`);
    const points = seen.reduce((a, t) => a + t.points, 0);
    const tips = seen.reduce((a, t) => a + t.tips, 0);
    k.ok(end.shift.points === points, `the shift total is the sum of the tickets (${end.shift.points} vs ${points})`);
    k.near(end.shift.tips, tips, 1e-9, 'and so are the tips');
    k.ok(end.shift.covers === 6, `six covers over six single-burger tickets (${end.shift.covers})`);
    k.ok(!end.unfinished, 'a completed six-ticket shift no longer needs reload protection');
    k.ok(end.score === `${Math.round(points / 6)}/100`, `the headline is the average ticket: ${end.score} of ${points} over 6`);
    k.ok(end.stats.includes('1 sent back'), 'the stats own up to the send-back');
    k.ok(end.stats.includes(`${points} points on the night`), `the stats agree with the running total (${points})`);
    k.log(`card: ${end.score}, ${points} points, $${tips.toFixed(2)} in tips, best line “${end.best}”`);
    k.ok(/\{"points":/.test(end.stored || ''), `the best shift is kept in the browser: ${end.stored}`);
    await k.shot('shift-end');

    // ---- and a new shift starts on the stove you left, not on a cold one
    await k.click('#btn-new-shift');
    const fresh = await k.read((g) => ({ phase: g.phase, n: g.shift.n, points: g.shift.points, tickets: g.shift.tickets.length, pan: g.state.pan.T, hidden: document.getElementById('shiftend').hidden, patties: g.state.patties.length }));
    k.ok(fresh.phase === 'order' && fresh.hidden, 'the card is away and the next ticket is up');
    k.ok(fresh.n === 0 && fresh.points === 0 && fresh.tickets === 0, `the till is back to zero (n=${fresh.n}, ${fresh.points} points)`);
    k.ok(fresh.patties === 0, 'and there is no meat left over from the last shift');
    k.ok(fresh.pan > 100, `but the pan is still hot: ${fresh.pan.toFixed(0)} °C`);
    await k.shot('new-shift');
  },
};
