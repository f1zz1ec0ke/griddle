/* Energy is in joules, water in kg. Escaping vapour carries sensible and latent heat. */
(function(root){
  'use strict';
  const cpW=4180, latent=2260000;
  const capacity=(n,cp)=>Math.max(1e-9,n.m*cp+n.w*cpW);
  function heat(n,q,cp,free=n.w) {
    const c=capacity(n,cp),available=Math.max(0,Math.min(n.w,free));
    const excess=c*(n.T-100)+q;
    let boiled=0;
    if(excess>0&&available>1e-12) {
      boiled=Math.min(available,excess/latent);n.w-=boiled;
      n.T=100+(excess-boiled*latent)/capacity(n,cp);
    } else n.T+=q/c;
    return boiled;
  }
  function transfer(from,to,m,cpFrom,cpTo) {
    m=Math.max(0,Math.min(m,from.w));
    const energy=capacity(to,cpTo)*to.T+m*cpW*from.T;
    from.w-=m;to.w+=m;to.T=energy/capacity(to,cpTo);
    return m;
  }
  function evaporate(n,m,cp,floor=0,free=n.w) {
    const c=capacity(n,cp),drop=Math.max(0,n.T-floor);
    m=Math.max(0,Math.min(m,free,n.w,c*drop/(latent+cpW*drop)));
    n.w-=m;n.T-=m*latent/capacity(n,cp);return m;
  }
  const totals=['m0','w0','w0bot','prot','fat0','fs','fl','fr','lostFat','lostWater','lostDrip','fatSoaked','dFat','dJuice','fond','qBot','steam','sizzle','smoke'];
  const means=['Ts','soft','carm','carmBot','char','charBot','crisp','curl','shrink'];
  function syncRegions(it) {
    const rs=it.regions;if(!rs)return;
    for(const key of totals)if(typeof rs[0][key]==='number')it[key]=rs.reduce((v,r)=>v+r[key],0);
    for(const key of means)if(typeof rs[0][key]==='number')it[key]=rs.reduce((v,r)=>v+r[key],0)/rs.length;
    for(const key of ['body','bot','top'])if(rs[0][key]) {
      const n=it[key],cp=it.spec.cpDry;n.m=0;n.w=0;let e=0;
      for(const r of rs){const a=r[key];n.m+=a.m;n.w+=a.w;e+=capacity(a,cp)*a.T;}
      n.T=e/capacity(n,cp);
    }
    for(const key of ['faceDown','faceUp'])for(const field of Object.keys(rs[0][key]))
      if(typeof rs[0][key][field]==='number')it[key][field]=rs.reduce((v,r)=>v+r[key][field],0)/rs.length;
  }
  const api={cpW,latent,capacity,heat,transfer,evaporate,totals,syncRegions};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BurgerMoisture=api;
})(typeof window!=='undefined'?window:globalThis);
