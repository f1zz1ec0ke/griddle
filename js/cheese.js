/* Shared cheese mass/energy ledger for frying, melting and assembly. */
(function(root){
  'use strict';
  const M=typeof module!=='undefined'&&module.exports?require('./moisture'):root.BurgerMoisture,cp=1500;
  function ensure(ch){
    if(!ch.core){
      const w=Math.min(ch.mass,ch.assemblyWater??ch.mass*(ch.skirt?.water??.38));
      ch.core={m:ch.mass-w,w,T:ch.T};ch.rim={m:0,w:0,T:ch.T};ch.evaporated=ch.assemblyEvap||0;
    }
    return ch;
  }
  function sync(ch){ch.mass=ch.core.m+ch.core.w+ch.rim.m+ch.rim.w;ch.T=ch.core.T;ch.water=ch.core.w+ch.rim.w;}
  function partition(ch,f){
    ensure(ch);const a=ch.core,b=ch.rim,total=a.m+a.w+b.m+b.w;
    const delta=total*f-b.m-b.w,from=delta>0?a:b,to=delta>0?b:a;
    const ratio=Math.min(1,Math.abs(delta)/Math.max(1e-12,from.m+from.w));
    const m=from.m*ratio,w=from.w*ratio,E=M.capacity(to,cp)*to.T+(m*cp+w*M.cpW)*from.T;
    from.m-=m;from.w-=w;to.m+=m;to.w+=w;to.T=E/M.capacity(to,cp);sync(ch);
  }
  function heat(ch,q,rim=false){
    ensure(ch);const n=rim?ch.rim:ch.core;
    const lost=M.heat(n,q,cp);ch.evaporated+=lost;sync(ch);return lost;
  }
  function remove(ch,m){ensure(ch);const f=Math.min(1,m/ch.mass);for(const n of [ch.core,ch.rim]){n.m*=1-f;n.w*=1-f;}sync(ch);}
  function surface(ch){ensure(ch);const nodes=[ch.core,ch.rim],C=nodes.reduce((v,n)=>v+M.capacity(n,cp),0);
    return {T:nodes.reduce((v,n)=>v+M.capacity(n,cp)*n.T,0)/C,C,add:q=>{let evap=0;const shares=nodes.map(n=>M.capacity(n,cp)/C);for(let i=0;i<2;i++)evap+=heat(ch,q*shares[i],i===1);return evap;}};
  }
  const api={ensure,sync,partition,heat,remove,surface,capacity:ch=>M.capacity(ensure(ch).core,cp)};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BurgerCheese=api;
})(typeof window!=='undefined'?window:globalThis);
