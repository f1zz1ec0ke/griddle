/* Versioned cooking snapshots. Preserve typed grids and shared face/item references. */
(function (root) {
  'use strict';
  const types = { Float64Array, Float32Array, Int32Array, Int8Array, Uint8Array, Uint16Array, Uint32Array, Int16Array };
  function encode(value) {
    const seen = new Map(), nodes = [];
    function visit(v) {
      if (typeof v === 'number' && !Number.isFinite(v)) {
        if (Number.isNaN(v)) throw new Error('Cannot save an invalid simulation.');
        return { number: v > 0 ? 'Infinity' : '-Infinity' };
      }
      if (v == null || typeof v !== 'object') return v;
      if (seen.has(v)) return { ref: seen.get(v) };
      const id = nodes.length; seen.set(v, id); nodes.push(null);
      if (ArrayBuffer.isView(v)) {
        if (!types[v.constructor.name]) throw new Error('Unknown simulation array.');
        nodes[id] = { type: v.constructor.name, values: Array.from(v, visit) };
      } else if (Array.isArray(v)) nodes[id] = { type: 'Array', values: v.map(visit) };
      else nodes[id] = { type: 'Object', values: Object.entries(v).filter(([, x]) => typeof x !== 'function' && x !== undefined).map(([k, x]) => [k, visit(x)]) };
      return { ref: id };
    }
    const ref = visit(value);
    return JSON.stringify({ version: 1, root: ref, nodes });
  }
  function decode(text) {
    if (typeof text !== 'string' || text.length > 15000000) throw new Error('Save is too large.');
    const data = JSON.parse(text);
    if (data.version !== 1 || !Array.isArray(data.nodes) || data.nodes.length > 50000) throw new Error('Unsupported save version.');
    const nodes = data.nodes.map(n => {
      if (!n || !Array.isArray(n.values) || n.values.length > 1000000) throw new Error('Invalid save data.');
      if (n.type === 'Array') return [];
      if (n.type === 'Object') return {};
      if (!Object.hasOwn(types, n.type)) throw new Error('Unknown saved array.');
      return new types[n.type](n.values.length);
    });
    function visit(v) {
      if (v == null || typeof v !== 'object') return v;
      if (Object.hasOwn(v, 'number')) {
        if (v.number !== 'Infinity' && v.number !== '-Infinity') throw new Error('Invalid saved number.');
        return v.number === 'Infinity' ? Infinity : -Infinity;
      }
      if (!Number.isInteger(v.ref) || v.ref < 0 || v.ref >= nodes.length) throw new Error('Invalid saved reference.');
      return nodes[v.ref];
    }
    data.nodes.forEach((n, i) => {
      const o = nodes[i];
      if (n.type === 'Object') {
        for (const pair of n.values) {
          if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(pair[0])) throw new Error('Invalid saved property.');
          o[pair[0]] = visit(pair[1]);
        }
      } else n.values.forEach((v, j) => { o[j] = visit(v); });
    });
    return visit(data.root);
  }
  function validate(g, P) {
    if (!g || !['service', 'practice'].includes(g.mode) || !['order', 'form', 'cook', 'rest', 'result'].includes(g.phase)) throw new Error('Invalid session.');
    const s = g.state;
    if (!s || !s.stove || !P.STOVES[s.stove.id] || !s.pan || !Array.isArray(s.patties) || !Array.isArray(s.items) || !Array.isArray(g.patties) || !Array.isArray(g.forms)) throw new Error('Invalid kitchen.');
    if (!Number.isFinite(s.t) || !Number.isFinite(s.pan.T) || !(s.pan.Tr instanceof Float64Array)) throw new Error('Invalid pan.');
    if (!g.equip || !Object.hasOwn(P.STOVES, g.equip.stove) || !Object.hasOwn(P.PANS, g.equip.pan) || !g.probe || !Number.isInteger(g.sel) || g.sel < 0 || g.sel >= Math.max(1, g.forms.length)) throw new Error('Invalid equipment or selection.');
    const targetOK = id => P.DONENESS.some(d => d.id === id);
    if (g.forms.some(f => !f || !targetOK(f.target) || !Number.isFinite(f.massG) || !Number.isFinite(f.thicknessMm))) throw new Error('Invalid saved forms.');
    for (const p of g.patties) {
      if (!(p.T instanceof Float64Array) || p.T.length !== p.Nz * p.Nr || !p.faceDown || !p.faceUp || !Array.isArray(p.cheeses) || !['board', 'pan', 'oven', 'rest', 'cut'].includes(p.where) || !P.DONENESS.some(d => d.id === p.target)) throw new Error('Invalid patty.');
      if (!Array.from(p.T).every(Number.isFinite)) throw new Error('Invalid temperature grid.');
    }
    if (s.patties.some(p => !g.patties.includes(p)) || !g.ticket || !Array.isArray(g.ticket.items) || !g.shift || !Array.isArray(g.shift.tickets) || !Array.isArray(g.shift.plan)) throw new Error('Invalid ticket.');
    const A = typeof module !== 'undefined' && module.exports ? require('./assembly') : root.BurgerAssembly;
    const used = new Set(), usedMeat=new Set();
    for (const p of g.patties) {
      if (p.assembly == null) continue;
      if (!Array.isArray(p.assembly) || p.assembly.length > 40 || (p.assembly.length && !['rest','cut'].includes(p.where))) throw new Error('Invalid assembly.');
      let meat = false, heel = null, closed = false;
      const coldCounts = {};
      for (const [i,l] of p.assembly.entries()) {
        if (!l || closed || [!!l.patty, !!l.item, !!l.cold].filter(Boolean).length !== 1) throw new Error('Invalid assembly layer.');
        if (l.patty) {
          if(l.meat) {
            const q=l.meat;
            if(!meat || !g.patties.includes(q) || q===p || usedMeat.has(q) || q.assembledTo!==p.id || q.assembly?.length || !['rest','cut'].includes(q.where) || p.assembly.filter(l=>l.meat).length>1) throw new Error('Invalid second patty.');
            usedMeat.add(q);
          } else {if(meat)throw new Error('Duplicate patty.');meat=true;}
        }
        if (l.item) {
          const it = l.item;
          if (!s.items.includes(it) || used.has(it) || it.assembledTo !== p.id || it.burger !== p.id || !['rest','cut'].includes(it.where)) throw new Error('Invalid assembled food.');
          if (it.kind === 'bun') {
            if (it.half === 'bottom') { if (i !== 0) throw new Error('Invalid bottom bun.'); heel = it.pair; }
            else { if (!meat || heel !== it.pair) throw new Error('Invalid top bun.'); closed = true; }
          } else if (i === 0) throw new Error('Missing base layer.');
          used.add(it);
        }
        if (l.cold) {
          if (!A.cold[l.cold] || i === 0 || (coldCounts[l.cold]=(coldCounts[l.cold]||0)+1) > (A.cold[l.cold].sauce?1:4)) throw new Error('Invalid cold topping.');
          if(l.T!=null && (!Number.isFinite(l.T)||l.T < -30||l.T > 300)) throw new Error('Invalid topping temperature.');
          if(l.age!=null && (!Number.isFinite(l.age)||l.age<0)) throw new Error('Invalid topping age.');
          if(l.wilt!=null && (!Number.isFinite(l.wilt)||l.wilt<0||l.wilt>1)) throw new Error('Invalid topping condition.');
        }
      }
    }
    if(g.patties.some(p=>p.assembledTo!=null&&!usedMeat.has(p))) throw new Error('Detached second patty.');
    if (s.items.some(it => it.assembledTo != null && !used.has(it))) throw new Error('Detached assembly reference.');
    if (!g.ticket.items.every(targetOK) || (g.selItem && !s.items.includes(g.selItem)) || !Number.isInteger(g.shift.n) || g.shift.n < 0 || g.shift.n > 6) throw new Error('Invalid ticket progress.');
    if (![1, 2, 4, 8].includes(g.speed) || !Number.isFinite(g.ticketClock) || !Number.isFinite(g.probe.depth) || g.probe.depth < 0.1 || g.probe.depth > 0.9) throw new Error('Invalid controls.');
    if (s.oven && (!Number.isFinite(s.oven.T) || s.oven.T < -30 || s.oven.T > 300 || !Number.isFinite(s.oven.target) || (s.oven.target !== 0 && (s.oven.target < 80 || s.oven.target > 250)))) throw new Error('Invalid oven.');
    if(s.room && (typeof s.room.windowOpen!=='boolean' || !['opening','upper','lower'].every(k=>Number.isFinite(s.room[k])&&s.room[k]>=0) || s.room.opening>1)) throw new Error('Invalid room air.');
    if(s.pan.film) {
      const f=s.pan.film;
      if(f.n!==33 || f.r!==s.pan.floorR || f.cell!==2*f.r/32 || f.area!==f.cell*f.cell || !Number.isFinite(f.total) || f.total<0) throw new Error('Invalid oil film.');
      for(const key of ['mass','floor','obstacle','head','mask']) if(!ArrayBuffer.isView(f[key]) || f[key].length!==1089 || !Array.from(f[key]).every(Number.isFinite)) throw new Error('Invalid oil grid.');
      if(Array.from(f.mass).some((m,i)=>m<0 || (!f.mask[i]&&m>0)) || Math.abs(f.mass.reduce((a,b)=>a+b,0)-f.total)>1e-8) throw new Error('Invalid oil mass.');
    }
    // Stove profiles are code, not save data. Restore them only from the installed model.
    s.stove.profile = P.STOVES[s.stove.id].profile;
    return g;
  }
  const api = { encode, decode, validate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GriddleSession = api;
})(typeof window !== 'undefined' ? window : globalThis);
