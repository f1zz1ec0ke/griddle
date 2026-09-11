/* Explicit stack order. References to cooked food survive the shared-reference save format. */
(function(root) {
  'use strict';
  const cold = {
    lettuce: {label:'Lettuce', color:0x629546, height:.006},
    tomato: {label:'Tomato', color:0xc74732, height:.006},
    pickles: {label:'Pickles', color:0x759044, height:.004},
    mustard: {label:'Mustard', color:0xd6a523, height:.002, sauce:true},
    mayo: {label:'Mayo', color:0xf3e7c4, height:.002, sauce:true},
    ketchup: {label:'Ketchup', color:0xa93421, height:.002, sauce:true}
  };
  const layers = p => p.assembly || [];
  const closed = p => layers(p).at(-1)?.item?.half === 'top';
  const hasPatty = p => layers(p).some(l => l.patty);
  function add(s,p,key) {
    if (!p || p.assembledTo != null || p.where !== 'rest' || closed(p)) return false;
    const stack = layers(p), item = typeof key === 'number' ? s.items.find(it => it.id === key) : null;
    let layer;
    if (key === 'patty') { if (stack.some(l=>l.patty&&!l.meat)) return false; layer = {patty:true}; }
    else if (typeof key==='string' && key.startsWith('patty:')) {
      const meat=s.patties.find(q=>q.id===Number(key.slice(6)));
      if(!meat || meat===p || meat.requiredBuild?.length || meat.where!=='rest' || meat.assembledTo!=null || layers(meat).length || !hasPatty(p) || stack.filter(l=>l.patty).length>=2 || (meat.extraFor!=null&&meat.extraFor!==p.id)) return false;
      layer={patty:true,meat}; meat.assembledTo=p.id;
    }
    else if (cold[key]) {
      if (!stack.length || stack.filter(l => l.cold === key).length >= (cold[key].sauce ? 1 : 4)) return false;
      layer = {cold:key,T:6,age:0};
    } else if (item) {
      if (item.where !== 'rest' || item.assembledTo != null) return false;
      if (item.kind === 'bun') {
        if (item.half === 'bottom' && stack.length) return false;
        if (item.half === 'top' && (!hasPatty(p) || !stack.some(l => l.item?.pair === item.pair && l.item.half === 'bottom'))) return false;
      } else if (!stack.length) return false;
      layer = {item};
    } else return false;
    p.manualAssembly = true; p.assembly ||= []; p.assembly.push(layer);
    if (item) { item.assembledTo = p.id; item.burger = p.id; }
    return true;
  }
  function pop(p) {
    if (!p || p.where === 'cut') return false;
    const layer = p.assembly?.pop();
    if (layer?.meat) layer.meat.assembledTo=null;
    if (layer?.item) { layer.item.assembledTo = null; layer.item.burger = null; }
    return !!layer;
  }
  function unpack(p) { while (pop(p)) {} }
  function label(layer) { return layer.patty ? (layer.meat ? 'Second patty' : 'Patty') : layer.item ? layer.item.label : cold[layer.cold].label; }
  // Conservative contact exchange between the actual stack surfaces. The existing
  // food solvers still handle conduction within each ingredient and exposed faces.
  function surface(p,l,upper) {
    if(l.cold) {
      if(!Number.isFinite(l.T)) l.T=6;
      const mass={lettuce:.010,tomato:.025,pickles:.015}[l.cold] || .008;
      return {T:l.T,C:mass*(cold[l.cold].sauce?3000:3900),add:q=>{l.T+=q/(mass*(cold[l.cold].sauce?3000:3900));}};
    }
    if(l.patty) {
      p=l.meat || p;
      const cheese=upper?p.cheeses.at(-1):p.cheeseUnder[0];
      if(cheese) {const cap=cheese.mass*(upper?2500:1500+4180*(cheese.skirt?.water??.44));return {T:cheese.T,C:cap,add:q=>{cheese.T+=q/cap;}};}
      const start=upper?(p.Nz-1)*p.Nr:0; let cap=0,energy=0;
      const capacity=k=>p.w[k]*4180+(p.fs[k]+p.fl[k]+p.fr[k])*2000+p.p[k]*1600+(p.T[k]>-1.5&&p.T[k]<=0?p.w[k]*334000/1.5:0);
      for(let j=0;j<p.Nr;j++) { const k=start+j,c=capacity(k); cap+=c; energy+=c*p.T[k]; }
      return {T:energy/cap,C:cap,add:q=>{for(let j=0;j<p.Nr;j++) p.T[start+j]+=q/cap;}};
    }
    const it=l.item,sp=it.spec; let node,cp=sp.cpDry || sp.cpWhite || 2000;
    if(it.kind==='bun') {
      const cut=it.faceIsCut?it.face:it.up,crust=it.faceIsCut?it.up:it.face;
      node=(upper===(it.half==='bottom'))?cut:crust;
    } else if(it.kind==='egg') node=upper?it.wTop:it.wBot;
    else if(it.kind==='onions') node=upper?it.top:it.bot;
    else node=it.body;
    const cap=Math.max(.01,node.m*cp+node.w*4180);
    return {T:node.T,C:cap,add:q=>{node.T+=q/cap;}};
  }
  function exchange(a,b,G,dt) {
    const q=(a.T-b.T)/(1/a.C+1/b.C)*(-Math.expm1(-G*(1/a.C+1/b.C)*dt));
    a.add(-q); b.add(q); return q;
  }
  function cover(p,bc,item,meat) {
    const stack=layers(p),i=stack.findIndex(l=>item?l.item===item:meat?l.meat===meat:l.patty&&!l.meat);
    if(i<0) return;
    let below=i>0,above=i<stack.length-1;
    if(item?.kind==='bun' && (item.faceIsCut===(item.half==='bottom'))) [below,above]=[above,below];
    if(below) {bc.bottom.h=0;bc.bottom.rad=false;}
    if(above) {bc.top.h=0;bc.top.rad=false;bc.top.RH=1;bc.top.insulated=true;} // no air or evaporation at an internal interface
  }
  function stepHeat(s,p,dt) {
    if(p.where!=='rest' || !layers(p).length) return;
    const stack=layers(p),area=Math.min(p.A || .01,.01);
    for(let i=0;i<stack.length;i++) {
      const l=stack[i];
      if(l.cold) {
        l.age=(l.age || 0)+dt;
        const a=surface(p,l,true), exposed=(i===0?1:0)+(i===stack.length-1?1:0)+.15;
        a.add((s.env.Tamb-a.T)*a.C*(-Math.expm1(-8*area*exposed*dt/a.C)));
        if(l.cold==='lettuce') l.wilt=Math.min(1,(l.wilt||0)+Math.max(0,l.T-35)*dt/15000);
      }
      if(i) exchange(surface(p,stack[i-1],true),surface(p,l,false),area*(l.cold && cold[l.cold].sauce?100:45),dt);
    }
  }
  const api = {cold,layers,closed,hasPatty,add,pop,unpack,label,surface,exchange,cover,stepHeat};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BurgerAssembly = api;
})(typeof window !== 'undefined' ? window : globalThis);
