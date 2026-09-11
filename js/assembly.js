/* Explicit stack order. References to cooked food survive the shared-reference save format. */
(function(root) {
  'use strict';
  const M=typeof module!=='undefined'&&module.exports?require('./moisture'):root.BurgerMoisture;
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
  function coldNode(l) {
    if(!Number.isFinite(l.T))l.T=6;
    const mass={lettuce:.010,tomato:.025,pickles:.015}[l.cold]||.008;
    const fraction={lettuce:.95,tomato:.94,pickles:.94,mustard:.70,mayo:.22,ketchup:.70}[l.cold];
    if(l.w==null){l.w=mass*fraction;l.m=mass-l.w;l.w0=l.w;l.lostWater=0;}
    return l;
  }
  function nodeSurface(n,cp,free,onSteam) {
    return {T:n.T,C:M.capacity(n,cp),add:q=>{const m=M.heat(n,q,cp,free);if(m)onSteam(m);return m;}};
  }
  function surface(p,l,upper) {
    if(l.cold) {
      const n=coldNode(l);
      return nodeSurface(n,1500,n.w,m=>{l.lostWater+=m;});
    }
    if(l.patty) {
      p=l.meat || p;
      const cheese=upper?p.cheeses.at(-1):p.cheeseUnder[0];
      if(cheese) {
        if(cheese.assemblyWater==null)cheese.assemblyWater=cheese.mass*(cheese.skirt?.water??.38);
        else if(cheese.assemblyMass>0)cheese.assemblyWater*=cheese.mass/cheese.assemblyMass;
        cheese.assemblyWater=Math.min(cheese.mass,cheese.assemblyWater);cheese.assemblyMass=cheese.mass;
        const n={T:cheese.T,w:cheese.assemblyWater,m:cheese.mass-cheese.assemblyWater};
        const out=nodeSurface(n,1500,n.w,m=>{cheese.mass-=m;cheese.assemblyEvap=(cheese.assemblyEvap||0)+m;});
        return {...out,add:q=>{const m=out.add(q);cheese.T=n.T;cheese.assemblyWater=n.w;cheese.assemblyMass=cheese.mass;return m;}};
      }
      const start=upper?(p.Nz-1)*p.Nr:0;let cap=0,energy=0;
      const capacity=k=>p.w[k]*4180+(p.fs[k]+p.fl[k]+p.fr[k])*2000+p.p[k]*1600+(p.T[k]>-1.5&&p.T[k]<=0?p.w[k]*334000/1.5:0);
      for(let j=0;j<p.Nr;j++){const k=start+j,c=capacity(k);cap+=c;energy+=c*p.T[k];}
      return {T:energy/cap,C:cap,add:q=>{
        let steam=0;
        for(let j=0;j<p.Nr;j++){
          const k=start+j,c=capacity(k),n={T:p.T[k],w:p.w[k],m:c-p.w[k]*4180};
          steam+=M.heat(n,q*c/cap,1);p.T[k]=n.T;p.w[k]=n.w;
        }
        p.lostWaterEvap+=steam;return steam;
      }};
    }
    const it=l.item;
    if(it.regions) {
      const parts=it.regions.map(r=>surface(p,{item:r},upper)),cap=parts.reduce((v,r)=>v+r.C,0);
      return {T:parts.reduce((v,r)=>v+r.T*r.C,0)/cap,C:cap,add:q=>{let steam=0;for(const r of parts)steam+=r.add(q*r.C/cap)||0;M.syncRegions(it);return steam;}};
    }
    const sp=it.spec;let node,cp=sp.cpDry||sp.cpWhite||2000,bound=0;
    if(it.kind==='bun') {
      const cut=it.faceIsCut?it.face:it.up,crust=it.faceIsCut?it.up:it.face;
      node=(upper===(it.half==='bottom'))?cut:crust;
    } else if(it.kind==='egg') {node=upper?it.wTop:it.wBot;bound=sp.whiteBound*(upper?it.w0t:it.w0b)*(upper?it.setTop:it.setBot);}
    else if(it.kind==='onions')node=upper?it.top:it.bot;
    else {node=it.body;bound=sp.waterBound*it.w0;}
    return nodeSurface(node,cp,Math.max(0,node.w-bound),m=>{it.lostWater+=m;});
  }
  function exchange(a,b,G,dt) {
    const q=(a.T-b.T)/(1/a.C+1/b.C)*(-Math.expm1(-G*(1/a.C+1/b.C)*dt));
    const steam=(a.add(-q)||0)+(b.add(q)||0);if(a.onSteam)a.onSteam(steam);return q;
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
    if(!(dt>0)||p.where!=='rest' || !layers(p).length)return 0;
    let steam=0;
    const stack=layers(p),area=Math.min(p.A || .01,.01);
    for(let i=0;i<stack.length;i++) {
      const l=stack[i];
      if(l.cold) {
        l.age=(l.age || 0)+dt;
        const a=surface(p,l,true), exposed=(i===0?1:0)+(i===stack.length-1?1:0)+.15;
        steam+=a.add((s.env.Tamb-a.T)*a.C*(-Math.expm1(-8*area*exposed*dt/a.C)))||0;
        const rho=t=>{t=Math.max(-20,Math.min(100,t));return 216.7*(6.112*Math.exp(17.62*t/(243.12+t)))/(t+273.15)/1000;};
        const wanted=.002*area*exposed*Math.max(0,rho(l.T)-(s.env.RH??.5)*rho(s.env.Tamb))*dt;
        const evaporated=M.evaporate(l,wanted,1500,Math.min(l.T,s.env.Tamb));l.lostWater+=evaporated;steam+=evaporated;
        if(l.cold==='lettuce') l.wilt=Math.min(1,(l.wilt||0)+Math.max(0,l.T-35)*dt/15000);
      }
      if(i){const a=surface(p,stack[i-1],true),b=surface(p,l,false);a.onSteam=m=>{steam+=m;};exchange(a,b,area*(l.cold&&cold[l.cold].sauce?100:45),dt);}
    }
    return steam/dt;
  }
  // Visual compliance, not a change to the thermal mesh or the food's mass.
  // Pressure from everything above collapses loose folds before dense food.
  function stackLayout(p,P,heights) {
    let load=0;
    const stack=layers(p),out=new Array(stack.length);
    for(let i=stack.length-1;i>=0;i--) {
      const l=stack[i],food=l.meat||p,kind=l.patty?'patty':l.item?.kind||l.cold;
      const mass=l.patty?P.pattyMass(food)+[...food.cheeses,...food.cheeseUnder].reduce((v,c)=>v+c.mass,0):l.item?P.itemMass(l.item):coldNode(l).m+l.w;
      const radius=(l.item?.D||food.D)/2,pressure=load*9.81/Math.max(.002,Math.PI*radius*radius);
      const [limit,stiffness]=({bun:[.28,260],patty:[.08,650],onions:[.68,85],bacon:[.65,110],egg:[.25,230],lettuce:[.72,45],tomato:[.12,350],pickles:[.10,400]})[kind]||[.60,65];
      const compression=limit*(-Math.expm1(-pressure/stiffness));
      const loose=['onions','bacon','lettuce'].includes(kind);
      out[i]={height:heights[i],scale:1-compression,overlap:loose?compression*.22:0,load,pressure};
      load+=mass;
    }
    return out;
  }
  const api = {cold,layers,closed,hasPatty,add,pop,unpack,label,coldNode,surface,exchange,cover,stepHeat,stackLayout};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BurgerAssembly = api;
})(typeof window !== 'undefined' ? window : globalThis);
