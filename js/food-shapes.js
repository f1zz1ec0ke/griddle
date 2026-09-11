/* Shared geometry measurements: rendered food fits the simulation's footprint. */
(function(root) {
  'use strict';
  function baconPoint(u,v,shrink,curl,id) {
    const length=.108*(1-shrink), width=.027*(1-.35*shrink);
    const edge=1+.12*Math.sin(u*23+id)+.045*Math.sin(u*57+id*2);
    // A loose S fold, with uneven fat seams and curled edges instead of a flat horseshoe.
    const x=(u-.5)*length, z=.009*Math.sin(u*6.28+id*.4)+(v-.5)*width*edge;
    const limit=.056*(1-shrink), scale=Math.min(1,limit/Math.hypot(x,z));
    const ripple=.5+.5*Math.sin(u*20+id);
    return {x:x*scale,z:z*scale,y:.001+.0007*ripple+Math.abs(curl)*(.007*(2*u-1)**4+.003*ripple*(.3+.7*v)),
      lean:Math.max(0,Math.min(1,.65+3*Math.sin(v*14+Math.sin(u*10+id)*.65+id)))};
  }
  function puddleRadius(a,seed=0) {
    return .77+.12*Math.sin(a*3+seed)+.07*Math.sin(a*7+seed*2)+.035*Math.cos(a*13-seed);
  }
  // Pack the pass on the island, avoiding the hob and props. Large pieces go first.
  function passLayout(entries) {
    const placed=[], result=new Map();
    for(const e of [...entries].sort((a,b)=>b.r-a.r)) {
      const r=e.r+.004;
      let best=null;
      for(let tier=0;!best;tier++) for(const region of (tier?[[.255,.855,-.48,.48]]:[[.255,.855,-.48,.48],[-.64,-.255,-.46,.22]])) {
        if(best)break;
        for(let z=region[2]+r;z<=region[3]-r+.00001&&!best;z+=.012)
          for(let x=region[0]+r;x<=region[1]-r+.00001;x+=.012)
            if(placed.every(p=>p.tier!==tier||Math.hypot(p.x-x,p.z-z)>=p.r+r)) {best={x,z,r,tier,y:.001+tier*.18};break;}
      }

      placed.push(best);result.set(e.key,best);
    }
    return result;
  }
  const api={baconPoint,puddleRadius,passLayout};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FoodShapes=api;
})(typeof window!=='undefined'?window:globalThis);
