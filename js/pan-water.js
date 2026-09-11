/* A finite water puddle exchanging heat with the pan/oil reservoir. SI units.
 * Effective contact and wetting approximate a shallow film, not individual droplets. */
(function(root){
  'use strict';
  const M=typeof module!=='undefined'&&module.exports?require('./moisture'):root.BurgerMoisture;
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  function ensure(pan,ambient=20) {
    if(!Number.isFinite(pan.waterT))pan.waterT=ambient;
    if(!Number.isFinite(pan.waterTracked))pan.waterTracked=0;
    const added=pan.water-pan.waterTracked;
    if(added>0)pan.waterT=(pan.waterTracked*pan.waterT+added*ambient)/pan.water;
    pan.waterTracked=pan.water;
  }
  function add(pan,m,T=20) {
    if(!(m>0))return;ensure(pan,T);
    pan.waterT=(pan.water*pan.waterT+m*T)/(pan.water+m);
    pan.water+=m;pan.waterTracked=pan.water;
  }
  const rho=t=>{t=clamp(t,-20,100);return 216.7*6.112*Math.exp(17.62*t/(243.12+t))/(t+273.15)/1000;};
  function step(pan,env,lid,dt) {
    ensure(pan,env.Tamb);if(!(dt>0)||!(pan.water>0))return {heat:0,evap:0,boiled:0,vapourEnergy:0};
    const floor=Math.PI*pan.floorR**2;
    const area=Math.min(floor,.003*Math.pow(pan.water/.005,2/3));
    const coverage=1-Math.exp(-pan.oil/.003),depth=pan.oil/920/floor;
    const x=clamp((pan.T-190)/100,0,1),film=x*x*(3-2*x);
    const h=1/(1/(3000*(1-.9*film*(1-coverage)))+.15*depth/.17);
    const cw=pan.water*M.cpW,cp=pan.C+pan.oil*2000,G=h*area;
    let heat=(pan.T-pan.waterT)/(1/cw+1/cp)*(-Math.expm1(-G*(1/cw+1/cp)*dt));
    // Stop drawing energy as soon as the last water leaves as 100 C vapour.
    if(heat>0)heat=Math.min(heat,Math.max(0,cw*(100-pan.waterT)+pan.water*M.latent));
    const n={T:pan.waterT,w:pan.water,m:0};
    const boiled=M.heat(n,heat,0);
    let evap=boiled,vapourEnergy=evap*(M.latent+100*M.cpW);
    if(n.w>1e-12){
      const humidity=lid?Math.max(env.RH,.95):env.RH;
      const wanted=.012*area*Math.max(0,rho(n.T)-humidity*rho(env.Tamb))*dt*(lid?.15:1);
      const T=n.T,escaped=M.evaporate(n,wanted,0,Math.min(n.T,Math.max(0,env.Tamb-20)));
      evap+=escaped;vapourEnergy+=escaped*(M.latent+T*M.cpW);
    }
    pan.water=n.w;pan.waterT=n.w>1e-12?n.T:env.Tamb;pan.waterTracked=n.w;
    pan.waterEvaporated=(pan.waterEvaporated||0)+evap;
    return {heat,evap,boiled,vapourEnergy};
  }
  const api={ensure,add,step};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BurgerPanWater=api;
})(typeof window!=='undefined'?window:globalThis);
