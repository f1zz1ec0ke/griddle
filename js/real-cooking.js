/* Physical cookware, practice tools and tasting. Temperatures are Celsius; liquids are kg. */
(function(root){
  'use strict';
  const node=typeof module==='object',P=node?require('./physics'):root.BurgerPhysics;
  const Oil=node?require('./oil-film'):root.BurgerOilFilm,Water=node?require('./pan-water'):root.BurgerPanWater;
  const equipment={butter:[1.16,.936,-.56],brush:[3.58,.936,.53],rake:[3.58,.936,.90],timer:[-.26,.936,-1.25],ashpan:[3.45,.133,-1.5]};
  const methods={
    ensureEquipment(){
      for(const [kind,pos] of Object.entries(equipment))if(!this.entities.some(e=>e.kind===kind&&!e.discarded)){const e=this.entity(kind,kind,pos);e.home=pos.slice();}
      this.timer ||= {duration:180,remaining:180,running:false,rang:false};this.spills ||= [];
    },
    ovenPanProblem(pan){
      if(!this.doors.oven)return 'Open the oven first.';
      if(pan.kind!=='pan'||pan.panType==='nonstick')return 'Use a metal-handled pan in the oven.';
      if(this.entities.some(e=>e!==pan&&(e.inOven||e.station==='oven')))return 'Clear the oven rack first.';
      if(pan.lidId||this.owner(pan).lid)return 'Remove this lid before putting the pan in the oven.';
      if(this.entities.some(e=>(e.panCarrier===pan.id||pan.station&&e.station===pan.station)&&this.attachedProbe(e)))return 'Remove the probe before closing it in the oven.';
      return null;
    },
    ovenPanPosition(){const st=this.station('oven');return [st.x-.12,.54,st.z];},
    ovenPan(pan){
      const error=this.ovenPanProblem(pan);if(error)return error;
      this.liftPan(pan);pan.inOven=true;pan.held=false;pan.pos=this.ovenPanPosition();pan.yaw=Math.PI;return null;
    },
    liftAsh(e){
      if(e.kind!=='ashpan'||e.pos.some((v,i)=>Math.abs(v-e.home[i])>.01))return null;
      const s=this.station('charcoal').state;if(s.grill.Tfire>60||s.pan.T>60)return 'Let the coals and grate cool before removing the ash.';
      e.ash=(e.ash||0)+s.grill.ash+s.grill.ashBowl;P.emptyAsh(s);return null;
    },
    stepCookware(dt){
      const oven=this.station('oven').state.oven;
      for(const e of this.entities)if(!e.discarded&&e.kind==='pan'&&e.parked){
        const s=e.parked;P.roomAir(s).windowOpen=this.doors.window;
        s.externalOven=e.inOven?(s.externalOven||{T:oven.T,loadW:0}):null;
        if(s.externalOven)s.externalOven.T=oven.T;
        this.stepButter(s,dt);P.step(s,dt);
        if(s.externalOven){oven.T-=s.externalOven.loadW*dt/1800;oven.loadW+=s.externalOven.loadW;}
      }
      for(const spill of this.spills||[]){spill.age+=dt;spill.T+=(21-spill.T)*(-Math.expm1(-dt/50));spill.water*=Math.exp(-dt/300);}
      this.spills=(this.spills||[]).filter(s=>s.oil+s.water>1e-5);
    },
    pourInto(target,kind,grams,point){
      const st=this.cooking(target);if(!st?.state||st.state.grill||!st.panId||st.state.lid||st.pan?.inOven&&!this.doors.oven||!Number.isFinite(grams)||grams<=0)return false;
      if(kind==='butter'){
        const pan=st.state.pan,plan=P.slideTo(st.state,null,.018,point||P.freeSpot(st.state,.018).pos);if(!plan.ok)return false;
        const pieces=pan.butter||(pan.butter=[]),spot=plan.pos;
        const mass=grams/1000;
        if(pieces.length>=16){const b=pieces[0];b.T=(b.T*b.mass+21*mass)/(b.mass+mass);b.mass+=mass;b.initial+=mass;}
        else pieces.push({id:this.nextId++,mass,initial:mass,T:21,x:spot.x,z:spot.y});
      }else if(kind==='water')Water.add(st.state.pan,grams/1000,21);else P.addFat(st.state,kind,grams);
      return true;
    },
    stepButter(s,dt){
      const p=s.pan;if(!p.butter?.length)return;
      // A knob must warm and melt before it becomes cooking fat. Heat comes from the pan.
      for(const b of p.butter){
        const area=.0009*Math.pow(b.mass/.015,2/3),capacity=b.mass*2100;
        let energy=800*area*(p.T-b.T)*dt,used=energy,melt=0;
        if(energy>0){const warm=Math.min(energy,Math.max(0,30-b.T)*capacity);b.T+=warm/capacity;energy-=warm;melt=Math.min(b.mass,energy/80000);used=warm+melt*80000;}
        else{used=Math.max(energy,(p.T-b.T)*capacity);b.T+=used/capacity;}
        const fall=used/(p.C+p.oil*2000);for(let j=0;j<p.Np;j++)p.Tr[j]-=fall;p.T-=fall;p.Tcenter=p.Tr[0];p.Tedge=p.Tr[p.Np-1];
        if(melt>0){b.mass-=melt;P.addFat(s,'butter',melt*1000,b.T,true);}
      }
      p.butter=p.butter.filter(b=>b.mass>0);
    },
    basteProblem(target){
      const st=this.cooking(target);if(!st?.state||st.state.grill||st.state.lid)return 'Use an uncovered pan.';
      if(st.pan?.inOven&&!this.doors.oven)return 'Open the oven first.';
      if(st.state.pan.oil<.003)return 'Add a little butter or oil first.';
      if(!st.state.patties.some(p=>p.where==='pan'))return 'Put a patty in the pan first.';
      return null;
    },
    baste(target){
      const error=this.basteProblem(target);if(error)return error;const st=this.cooking(target);
      // The fat is already in the pan. The Legacy shortcut also adds a fresh portion.
      st.state.baste=3;st.state.bastePatty=typeof target==='object'&&target.kind==='patty'?target.id:st.state.patties.find(p=>p.where==='pan').id;return null;
    },
    drain(pan,dt,destination,point){
      if(pan?.kind!=='pan'||!pan.parked||pan.parked.lid||pan.inOven)return {error:'Lift an uncovered pan first.'};
      const p=pan.pan,angle=Math.abs(pan.tilt||0),fraction=P.clamp((angle-.25)/.7,0,1)*(-Math.expm1(-dt*1.6));
      if(!fraction)return {water:0,oil:0};
      const water=p.water*fraction,oil=p.oil*fraction;Water.ensure(p);p.water-=water;p.waterTracked=p.water;p.oil-=oil;Oil.sync(p);
      if(water+oil<1e-8)return {water,oil};
      const to=this.cooking(destination);
      if(to?.state.grill&&!to.state.lid){to.state.grill.fatOnCoals+=oil;to.state.grill.juiceOnCoals=(to.state.grill.juiceOnCoals||0)+water;}
      else if(to?.panId&&to.state!==pan.parked&&!to.state.lid){
        const dest=to.state.pan;Water.add(dest,water,p.waterT);
        const cap=dest.C+dest.oil*2000,heat=oil*2000*(p.T-dest.T)/(cap+oil*2000);
        for(let i=0;i<dest.Tr.length;i++)dest.Tr[i]+=heat;dest.T+=heat;dest.Tcenter=dest.Tr[0];dest.Tedge=dest.Tr[dest.Np-1];dest.oil+=oil;dest.oilSmoke=Math.min(dest.oilSmoke,p.oilSmoke);dest.oilKind=dest.oilKind==='none'?p.oilKind:dest.oilKind===p.oilKind?p.oilKind:'mixed';Oil.deposit(dest,oil,0,0,dest.floorR*.3);
      }else if(destination!=='sink')this.spill(point||pan.pos,water,oil,p.waterT*water/(water+oil)+p.T*oil/(water+oil));
      return {water,oil};
    },
    spill(point,water,oil,T){
      this.spills ||= [];const p=Array.isArray(point)?point:[point.x,point.y,point.z];
      let s=this.spills.find(s=>Math.abs(s.pos[1]-p[1])<.03&&Math.hypot(s.pos[0]-p[0],s.pos[2]-p[2])<.18);
      if(!s){if(this.spills.length>=32)this.spills.shift();s={id:this.nextId++,pos:p.slice(),water:0,oil:0,T,age:0};this.spills.push(s);}
      const old=s.water+s.oil,added=water+oil;s.T=(s.T*old+T*added)/(old+added);s.water+=water;s.oil+=oil;return s;
    },
    wipeSpill(point){const before=this.spills.length;this.spills=this.spills.filter(s=>Math.hypot(s.pos[0]-point.x,s.pos[2]-point.z)>.3||Math.abs(s.pos[1]-point.y)>.08);return before!==this.spills.length;},
    stepTimer(dt){this.ensureEquipment();const t=this.timer;if(t.running){t.remaining=Math.max(0,t.remaining-dt);if(t.remaining===0){t.running=false;t.rang=true;t.finishedAt=this.time;}}},
    setTimer(seconds){const t=this.timer;t.duration=P.clamp(Math.round(seconds/15)*15,15,3600);t.remaining=t.duration;t.rang=false;},
    toggleTimer(){const t=this.timer;if(t.rang||t.remaining<=0){t.remaining=t.duration;t.rang=false;}t.running=!t.running;},
    taste(e){
      e=this.rootOf(e);if(!e||!e.food&& !e.coldState&&!e.sliceState)return null;
      const layers=this.layers(e),meats=e.kind==='patty'?[e.food,...layers.filter(l=>l.meat).map(l=>l.meat)]:[];
      const notes=[],parts=[],water={now:0,start:0};let saltPercent=0,temperature=e.food?e.kind==='patty'?P.centerT(e.food):P.itemT(e.food):e.coldState?.T??e.sliceState?.T;
      if(meats.length){
        const mass=meats.reduce((n,p)=>n+p.massKg0*1000,0),salt=meats.reduce((n,p)=>n+(p.saltGrams?.mixed||0)+(p.saltGrams?.surface||0),0);saltPercent=salt/mass*100;
        for(const p of meats)for(let i=0;i<p.w.length;i++){water.now+=p.w[i];water.start+=p.w0c[i];}
        temperature=Math.min(...meats.map(P.centerT));const retained=water.now/water.start;
        notes.push(temperature<35?'Cold at the centre.':temperature<48?'The centre is still raw.':P.donenessOf(temperature).label+' at the centre.',
          meats.some(p=>Math.max(p.faceDown.char,p.faceUp.char)>.3)?'Bitter, burnt crust.':meats.some(p=>Math.min(p.faceDown.brown,p.faceUp.brown)<1)?'Needs more sear.':'A good sear on both sides.',
          saltPercent<.35?'Underseasoned.':saltPercent>1.8?'Far too salty.':saltPercent>1.25?'A little heavy on the salt.':'Nicely seasoned.',
          retained<.55?'Dry inside.':retained>.72?'Plenty of juice.':'Some juice left.',
          meats.some(p=>p.work>.8)?'Overworked and dense.':meats.some(p=>p.saltStructure>.2)?'Springy from salt mixed into the mince.':'A loose, tender texture.');
      }
      const items=layers.length?layers.filter(l=>l.item).map(l=>l.item):e.food&&e.kind!=='patty'?[e.food]:[];
      for(const item of items){const state=P.itemState(item),label=item.kind==='bun'?(item.half==='top'?'Top bun':'Bottom bun'):item.label;parts.push({kind:item.kind,state:state.state,score:state.score});const burnt=(item.faceDown?.char||0)+(item.faceUp?.char||0)>.35;const note=label+': '+state.state+(burnt&&state.state!=='burnt'?', burnt underneath':'')+'.';if(state.score<=-3)notes.unshift(note);else notes.push(note);}
      const cheeses=[...meats.flatMap(p=>[...p.cheeses,...p.cheeseUnder]),...layers.filter(l=>l.cheese).map(l=>l.cheese),...(!layers.length&&e.sliceState?[e.sliceState]:[])];
      if(cheeses.length)notes.push(cheeses.some(c=>(c.skirt?.char||0)>.3)?'Cheese: burnt at the edges.':cheeses.some(c=>c.melt<.35)?'Cheese: still firm.':'Cheese: soft and melted.');
      const fresh=layers.filter(l=>l.cold);if(e.coldState&&!layers.length)fresh.push(e.coldState);
      if(fresh.some(l=>(l.wilt||0)>.4))notes.push('The fresh toppings have wilted.');else if(fresh.some(l=>['lettuce','tomato','pickles'].includes(l.cold)))notes.push('Fresh toppings still have some bite.');
      if(layers.length&&!layers.some(l=>l.item?.half==='top'))notes.push('Served open.');
      this.lastTasting={time:this.time,name:this.name(e),notes,parts,saltPercent,temperature,retained:water.start?water.now/water.start:null};return this.lastTasting;
    }
  };
  if(node)module.exports=methods;else root.RealCookingMethods=methods;
})(typeof window!=='undefined'?window:globalThis);
