/* Conservative shallow oil film. Metres, kilograms, seconds. A small grid is shared
 * by contact physics and rendering; this is a viscous approximation, not CFD. */
(function(root) {
  'use strict';
  const N = 33, RHO = 920;
  function ensure(pan) {
    if (pan.film?.n === N && pan.film.r === pan.floorR) return pan.film;
    const r = pan.floorR, cell = 2*r/(N-1), count = N*N;
    const f = pan.film = {n:N,r,cell,area:cell*cell,total:0,
      mass:new Float64Array(count), floor:new Float64Array(count), mask:new Uint8Array(count),
      obstacle:new Float64Array(count), head:new Float64Array(count)};
    for (let j=0;j<N;j++) for(let i=0;i<N;i++) {
      const k=j*N+i,x=i*cell-r,z=j*cell-r;
      f.mask[k] = Math.hypot(x,z) < r-cell*.4 ? 1:0;
      // Sub-millimetre imperfections create stable, irregular wet and dry patches.
      f.floor[k] = .000012*(Math.sin(x*81+z*39)+Math.cos(z*97-x*28))+.000015*Math.hypot(x,z)/r;
    }
    return f;
  }
  function deposit(pan, amount, x=0, z=0, radius=.04) {
    if (!(amount>0)) return;
    const f=ensure(pan); let sum=0;
    for(let j=0;j<N;j++) for(let i=0;i<N;i++) {
      const k=j*N+i; if(!f.mask[k]) continue;
      const d2=((i*f.cell-f.r-x)**2+(j*f.cell-f.r-z)**2)/(radius*radius);
      if(d2<9) sum+=Math.exp(-d2*2);
    }
    if(!sum) return deposit(pan,amount,0,0,.04);
    for(let j=0;j<N;j++) for(let i=0;i<N;i++) {
      const k=j*N+i; if(!f.mask[k]) continue;
      const d2=((i*f.cell-f.r-x)**2+(j*f.cell-f.r-z)**2)/(radius*radius);
      if(d2<9) f.mass[k]+=amount*Math.exp(-d2*2)/sum;
    }
    f.total+=amount;
  }
  function sync(pan) {
    const f=ensure(pan), delta=pan.oil-f.total;
    if(delta>1e-12) deposit(pan,delta);
    else if(delta<0 && f.total>0) {
      const ratio=Math.max(0,pan.oil/f.total);
      for(let k=0;k<f.mass.length;k++) f.mass[k]*=ratio;
      f.total=Math.max(0,pan.oil);
    }
    return f;
  }
  function step(pan, food, dt) {
    const f=sync(pan); if(!f.total) return;
    f.obstacle.fill(0);
    for(const q of food) {
      const rad=(q.Dcov || q.D)*.5;
      for(let j=0;j<N;j++) for(let i=0;i<N;i++) {
        const k=j*N+i, d=Math.hypot(i*f.cell-f.r-q.pos.x,j*f.cell-f.r-q.pos.y)/rad;
        if(d<1) f.obstacle[k]=Math.max(f.obstacle[k],.00065*Math.min(1,(1-d)*5));
      }
    }
    // Pair transfers cannot remove more than a quarter of a cell per sweep.
    // Recompute heads each sweep; wet trails close naturally after food moves.
    const mobility=.25+1.75*Math.min(1,Math.max(0,(pan.T-20)/160));
    const sweeps=Math.max(1,Math.ceil(dt/.05)), h=dt/sweeps, scale=RHO*f.area;
    for(let pass=0;pass<sweeps;pass++) {
      for(let k=0;k<f.mass.length;k++) f.head[k]=f.mass[k]/scale+f.floor[k]+f.obstacle[k]+(k%N*f.cell-f.r)*(pan.slopeX||0)+(Math.floor(k/N)*f.cell-f.r)*(pan.slopeZ||0);
      for(let j=0;j<N;j++) for(let i=0;i<N;i++) {
        const a=j*N+i; if(!f.mask[a]) continue;
        for(let direction=0;direction<2;direction++) {
          const b=direction===0?(i<N-1?a+1:-1):(j<N-1?a+N:-1);
          if(b<0 || !f.mask[b]) continue;
          const delta=f.head[a]-f.head[b], from=delta>0?a:b,to=delta>0?b:a;
          // A wetted contact retains a capillary film beneath the food.
          const retained=f.obstacle[from]>0?.000085*scale:0;
          const move=Math.min(Math.max(0,f.mass[from]-retained)*.24,Math.abs(delta)*scale*mobility*h);
          f.mass[from]-=move; f.mass[to]+=move;
        }
      }
    }
  }
  function depth(pan,x,z) {
    const f=ensure(pan), i=Math.round((x+f.r)/f.cell),j=Math.round((z+f.r)/f.cell);
    if(i<0||j<0||i>=N||j>=N) return 0;
    return f.mass[j*N+i]/(RHO*f.area);
  }
  function contactMass(pan,q) {
    let d=depth(pan,q.pos.x,q.pos.y);
    const radius=(q.Dcov||q.D)*.32;
    for(let k=0;k<8;k++) d+=depth(pan,q.pos.x+radius*Math.cos(k*Math.PI/4),q.pos.y+radius*Math.sin(k*Math.PI/4));
    return d/9*RHO*Math.PI*pan.floorR**2;
  }
  function take(pan,q,amount) {
    const f=sync(pan),r=(q.Dcov||q.D)*.5;let available=0;
    for(let j=0;j<N;j++)for(let i=0;i<N;i++)if(Math.hypot(i*f.cell-f.r-q.pos.x,j*f.cell-f.r-q.pos.y)<r)available+=f.mass[j*N+i];
    const used=Math.min(amount,available),fraction=available?used/available:0;
    for(let j=0;j<N;j++)for(let i=0;i<N;i++)if(Math.hypot(i*f.cell-f.r-q.pos.x,j*f.cell-f.r-q.pos.y)<r)f.mass[j*N+i]*=1-fraction;
    f.total-=used;pan.oil-=used;return used;
  }
  function sweep(pan,from,to,width) {
    const f=sync(pan),dx=to.x-from.x,dz=to.y-from.y,length=Math.hypot(dx,dz);if(length<.002)return;
    const ux=dx/length,uz=dz/length,changes=new Float64Array(N*N);
    for(let j=0;j<N;j++)for(let i=0;i<N;i++) {
      const k=j*N+i;if(!f.mask[k])continue;
      const x=i*f.cell-f.r-from.x,z=j*f.cell-f.r-from.y,t=x*ux+z*uz,side=-x*uz+z*ux;
      if(t<0||t>length||Math.abs(side)>width)continue;
      const sign=side<0?-1:1,px=from.x+t*ux-uz*width*1.15*sign,pz=from.y+t*uz+ux*width*1.15*sign;
      const ti=Math.round((px+f.r)/f.cell),tj=Math.round((pz+f.r)/f.cell),dest=tj*N+ti;
      if(ti<0||tj<0||ti>=N||tj>=N||!f.mask[dest])continue;
      const moved=f.mass[k]*.65;changes[k]-=moved;changes[dest]+=moved;
    }
    for(let k=0;k<changes.length;k++)f.mass[k]+=changes[k];
  }
  const api={ensure,deposit,sync,step,depth,contactMass,take,sweep};
  if(typeof module!=='undefined'&&module.exports) module.exports=api; else root.BurgerOilFilm=api;
})(typeof window!=='undefined'?window:globalThis);
