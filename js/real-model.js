/* Real mode owns its stations, inventory and saves; Legacy keeps its original state. */
(function(root){
  'use strict';
  const P=typeof module==='object'?require('./physics'):root.BurgerPhysics;
  const S=typeof module==='object'?require('./session'):root.GriddleSession;
  const A=typeof module==='object'?require('./assembly'):root.BurgerAssembly;
  const fixtures={sink:{from:[2.6,2.7],to:[2.6,3.57],yaw:0},fridge:{from:[-3.3,1.7],to:[-3.3,3.52],yaw:0},oven:{from:[-2.6,-1.3],to:[-3.48,-1.3],yaw:-Math.PI/2},rack:{from:[-2.45,3.15],to:[-2.45,3.65],yaw:0}};
  function fixturePoint(name,point){const f=fixtures[name],c=Math.cos(f.yaw),s=Math.sin(f.yaw);return [f.to[0]+point[0]*c+point[2]*s,point[1],f.to[1]-point[0]*s+point[2]*c];}
  const stationDefs=[['gas',-1.5,.95,'castiron'],['electric',0,.95,'carbonsteel'],['induction',1.5,.95,'stainless'],['charcoal',3.45,-1.5,'castiron'],['oven',...fixtures.oven.to,'castiron']];
  function clearPlacement(point,footprint,surface,obstacles){
    const free=(x,z)=>obstacles.every(b=>x+footprint.maxX+.006<=b.minX||x+footprint.minX-.006>=b.maxX||z+footprint.maxZ+.006<=b.minZ||z+footprint.minZ-.006>=b.maxZ);
    if(free(point[0],point[2]))return point.slice();
    for(let ring=1;ring<=12;ring++)for(let i=0;i<24;i++){
      const a=i*Math.PI/12,x=point[0]+Math.cos(a)*ring*.025,z=point[2]+Math.sin(a)*ring*.025;
      if(x+footprint.minX<surface.x-surface.w/2||x+footprint.maxX>surface.x+surface.w/2||z+footprint.minZ<surface.z-surface.d/2||z+footprint.maxZ>surface.z+surface.d/2)continue;
      if(free(x,z))return [x,point[1],z];
    }return null;
  }
  class Kitchen {
    constructor(){
      this.version=1;this.nextId=1;this.entities=[];this.time=0;this.bowl={mass:0,salt:0,work:0};this.portion={mass:0,salt:0,work:0};this.settings={thicknessMm:20,sliceMm:6};
      this.player={x:0,z:-2.3,y:0,yaw:Math.PI,pitch:-.2};this.doors={fridge:false,oven:false,window:false,tap:false};
      this.stations=stationDefs.map(([id,x,z,pan])=>({id,x,z,state:P.createState({stove:id==='oven'?'electric':id,pan}),panId:null}));
      this.loose=P.createState({stove:'gas'});
      P.setOven(this.station('oven').state,0);this.station('charcoal').state.grill.lit=false;
      for(const st of this.stations.filter(s=>!['charcoal','oven'].includes(s.id))){const e=this.entity('pan',st.id+' pan',[st.x,.93,st.z]);e.pan=st.state.pan;e.station=st.id;e.food=[];e.panType=st.state.pan.spec?.id||stationDefs.find(d=>d[0]===st.id)[3];st.panId=e.id;}
      const spare=this.entity('pan','non-stick pan',[-2.45,1.06,3.15]);spare.panType='nonstick';spare.parked=P.createState({stove:'gas',pan:'nonstick'});spare.pan=spare.parked.pan;spare.food=[];
      this.entities.filter(e=>e.kind==='pan').forEach((e,i)=>e.home=fixturePoint('rack',[0,1.06+i*.20,0]));
      spare.pos=spare.home.slice();
      for(const [i,kind] of ['spatula','tongs','spoon','press','knife','salt','oil','water','glove','probe','cloth','lighter','coal','wood','ketchup','mayo','mustard','lid','tray'].entries()){
        const e=this.entity(kind,kind==='press'?'smash plate':kind,[kind==='probe'?1.80:[-1.62,-1.28,.96,1.30,1.64][i%5],.936,-1.23+Math.floor(i/5)*.25]);e.home=e.pos.slice();
      }
      const plate=this.entity('plate','tasting plate',[.50,.936,-.85]);plate.home=plate.pos.slice();
    }
    entity(kind,label,pos){const e={id:this.nextId++,kind,label,pos:pos.slice(),station:null,food:null,held:false,fall:0,discarded:false};this.entities.push(e);return e;}
    get(id){return this.entities.find(e=>e.id===id&&!e.discarded);}
    station(id){return this.stations.find(s=>s.id===id);}
    owner(e){return e.panCarrier?this.get(e.panCarrier).parked:e.station?this.station(e.station).state:this.loose;}
    addIngredient(kind,pos){
      const e=this.entity(kind,kind,pos);if(kind==='bacon'||kind==='bun')this.makeFood(e,kind);return e;
    }
    makeFood(e,kind,opts={}){if(e.food)return;e.food=P.makeItem(kind,{...opts,id:e.id});e.food.where='rest';e.food.stuck=false;this.loose.items.push(e.food);}
    slice(e){
      if(e.discarded||!['tomato','pickles','onion','bunWhole','cheeseBlock'].includes(e.kind))return [];
      const kinds={tomato:'tomatoSlice',pickles:'pickleSlice',onion:'onions',bunWhole:'bun',cheeseBlock:'cheese'};
      const out=[],count=e.kind==='bunWhole'?2:e.kind==='onion'?1:4;
      const positions=[];
      if(e.kind==='bunWhole'){
        const radius=P.makeItem('bun').D/2,footprint={minX:-radius,maxX:radius,minZ:-radius,maxZ:radius};
        const obstacles=this.entities.filter(q=>q!==e&&!q.discarded&&!q.held&&!q.station&&!q.stackRoot&&!q.panCarrier&&!q.trayCarrier&&Math.abs(q.pos[1]-e.pos[1])<.05).map(q=>{const r=(q.food?.Dcov||q.food?.D||.1)/2;return {minX:q.pos[0]-r,maxX:q.pos[0]+r,minZ:q.pos[2]-r,maxZ:q.pos[2]+r};});
        for(let i=0;i<2;i++){const pos=clearPlacement([e.pos[0]+(i-.5)*(radius*2+.01),e.pos[1],e.pos[2]],footprint,{x:e.pos[0],z:e.pos[2],w:.7,d:.7},obstacles);if(!pos)return [];positions.push(pos);obstacles.push({minX:pos[0]-radius,maxX:pos[0]+radius,minZ:pos[2]-radius,maxZ:pos[2]+radius});}
      }
      for(let i=0;i<count;i++){const q=this.entity(kinds[e.kind],kinds[e.kind],positions[i]||[e.pos[0]+(i-(count-1)/2)*.065,e.pos[1],e.pos[2]]);if(q.kind==='bun'||q.kind==='onions'){this.makeFood(q,q.kind,{half:i?'top':'bottom'});if(q.kind==='bun')q.food.pair=e.id;}out.push(q);}
      e.discarded=true;return out;
    }
    cut(e,mm=6){
      if(e.discarded||e.held||e.station||e.stackRoot)return [];
      if(e.kind==='bunWhole')return this.slice(e);
      const widths={tomato:80,pickles:110,onion:80,cheeseBlock:28.646},width=widths[e.kind];if(!width)return [];
      const left=e.remainingMm??width,thickness=Math.min(left,P.clamp(mm,2,12));if(thickness<=0)return [];
      const kind={tomato:'tomatoSlice',pickles:'pickleSlice',onion:'onions',cheeseBlock:'cheese'}[e.kind];
      const footprint={minX:-.042,maxX:.042,minZ:-.042,maxZ:.042};
      const obstacles=this.entities.filter(q=>!q.discarded&&!q.held&&!q.station&&!q.stackRoot&&Math.abs(q.pos[1]-e.pos[1])<.05).map(q=>({minX:q.pos[0]-.044,maxX:q.pos[0]+.044,minZ:q.pos[2]-.044,maxZ:q.pos[2]+.044}));
      const pos=clearPlacement([e.pos[0]+.10,e.pos[1],e.pos[2]],footprint,{x:e.pos[0],z:e.pos[2],w:.7,d:.7},obstacles);if(!pos)return [];
      const q=this.entity(kind,kind,pos);q.sliceMm=thickness;
      q.massG=({tomato:150,pickles:80,onion:80,cheeseBlock:400}[e.kind])*thickness/width;
      if(kind==='onions'){this.makeFood(q,kind,{massG:q.massG});const f=thickness/width;q.food.D*=Math.sqrt(f);q.food.Dcov*=Math.sqrt(f);q.food.A*=f;}
      e.remainingMm=left-thickness;e.cutFraction=e.remainingMm/width;e.cuts=(e.cuts||0)+1;if(e.remainingMm<.001)e.discarded=true;return [q];
    }
    addMince(e){
      if(!['meat','meatLean','meatRich'].includes(e.kind)||e.discarded)return false;
      const b=this.bowl,fat={meat:.2,meatLean:.1,meatRich:.3}[e.kind];
      b.fatFrac=((b.fatFrac??.2)*b.mass+fat*500)/(b.mass+500);b.work=b.work*b.mass/(b.mass+500);b.mass+=500;e.discarded=true;return true;
    }
    scoop(dt,returning=false){
      const from=returning?this.portion:this.bowl,to=returning?this.bowl:this.portion;
      const take=Math.min(from.mass,dt*90,returning?Infinity:340-this.portion.mass);if(take<=0)return;
      const salt=from.salt*take/from.mass;to.work=(to.work*to.mass+from.work*take)/(to.mass+take);to.fatFrac=((to.fatFrac??.2)*to.mass+(from.fatFrac??.2)*take)/(to.mass+take);from.mass-=take;from.salt-=salt;to.mass+=take;to.salt+=salt;
    }
    form(pos){
      const q=this.portion;if(q.mass<25)return null;
      const e=this.entity('patty','patty',pos);e.food=P.makePatty({id:e.id,massG:q.mass,thicknessMm:this.settings?.thicknessMm||20,fatFrac:q.fatFrac??.2,tempC:6,work:q.work,salt:q.salt>0?'mixed':'none'});
      e.food.where='rest';e.food.saltGrams={mixed:q.salt,surface:0};e.salt=q.salt;this.applySeasoning(e);this.loose.patties.push(e.food);this.portion={mass:0,salt:0,work:0};return e;
    }
    applySeasoning(e,grams=0){
      const p=e.food;if(e.kind!=='patty'||!p)return;
      p.saltGrams ||= {mixed:p.salt==='mixed'?(e.salt||0):0,surface:p.salt==='surface'?(e.salt||0):0};
      p.saltGrams.surface+=Math.max(0,grams);e.salt=p.saltGrams.mixed+p.saltGrams.surface;
      p.salt=p.saltGrams.mixed>0?'mixed':p.saltGrams.surface>0?'surface':'none';
      // Gameplay dose response interpolates the existing unsalted/mixed endpoints.
      // Benefits saturate; excessive salt is assessed separately at tasting.
      const mass=p.massKg0*1000,mixed=P.clamp(p.saltGrams.mixed/(mass*.01),0,1),surface=P.clamp(p.saltGrams.surface/(mass*.008),0,1);
      p.whc0=.98-.05*p.work+.08*mixed+.02*surface;p.saltStructure=.3*mixed;
    }
    addCheese(held,patty){
      if(held.kind!=='cheese'||held.discarded||!P.addCheese(this.owner(patty),patty.food))return false;
      const ch=patty.food.cheeses.at(-1);ch.mass=(held.massG||20)/1000;ch.T=held.coldState?.T||6;held.discarded=true;return true;
    }
    probe(e,radius,depth){
      const p=e?.food;if(!p)return null;
      if(e.kind!=='patty'){if(e.kind==='egg')return radius<.018&&depth>.003?p.yolk.T:(depth>.004?p.wBot.T:p.wTop.T);return P.itemT(p);}
      const j=P.clamp(radius/(p.D/2)*p.Nr-.5,0,p.Nr-1),k=P.clamp((1-depth/p.h)*p.Nz-.5,0,p.Nz-1),j0=Math.floor(j),k0=Math.floor(k);
      const at=(z,r)=>p.T[Math.min(p.Nz-1,z)*p.Nr+Math.min(p.Nr-1,r)];
      return P.lerp(P.lerp(at(k0,j0),at(k0,j0+1),j-j0),P.lerp(at(k0+1,j0),at(k0+1,j0+1),j-j0),k-k0);
    }
    topPart(base){
      if(base?.stackRoot)base=this.get(base.stackRoot);const stack=base?.food?.assembly;if(!stack?.length)return null;
      const layer=stack.at(-1),part=layer.patty?(layer.meat?this.entities.find(e=>e.food===layer.meat):base):layer.item?this.entities.find(e=>e.food===layer.item):this.entities.find(e=>e.stackRoot===base.id&&e.layer===stack.length-1);
      return part;
    }
    peel(base){
      if(base?.stackRoot)base=this.get(base.stackRoot);const stack=base?.food?.assembly;if(!stack?.length||base.held||base.station||base.trayCarrier)return null;
      const layer=stack.at(-1),part=this.topPart(base);
      if(!part)return null;
      if(part===base){A.unpack(base.food);for(const e of this.entities.filter(e=>e.stackRoot===base.id)){e.stackRoot=null;e.layer=null;e.pos[1]=base.pos[1];}base.food.manualAssembly=false;}
      else {A.pop(base.food);part.stackRoot=null;part.layer=null;if(layer.cold)part.coldState=layer;}
      return part;
    }
    taste(e){
      const p=e?.food;if(e?.kind!=='patty'||!p)return null;
      const report=P.evaluate(this.owner(e),P.donenessOf(p.peakCenter).id,p),meats=[p,...(p.assembly||[]).filter(l=>l.meat).map(l=>l.meat)];
      const mass=meats.reduce((n,p)=>n+p.massKg0*1000,0),salt=meats.reduce((n,p)=>n+(p.saltGrams?.mixed||0)+(p.saltGrams?.surface||0),0),pct=salt/mass*100;
      const water=meats.reduce((out,p)=>{for(let i=0;i<p.w.length;i++){out.now+=p.w[i];out.start+=p.w0c[i];}return out;},{now:0,start:0}),retained=water.now/water.start;
      const temperature=Math.min(...meats.map(P.centerT));
      const notes=[temperature<35?'Cold at the centre.':temperature<48?'The centre is still raw.':P.donenessOf(temperature).label+' at the centre.',
        meats.some(p=>Math.max(p.faceDown.char,p.faceUp.char)>.3)?'Bitter, burnt crust.':meats.some(p=>Math.min(p.faceDown.brown,p.faceUp.brown)<1)?'Needs more sear.':'A good sear on both sides.',
        pct<.35?'Underseasoned.':pct>1.8?'Far too salty.':pct>1.25?'A little heavy on the salt.':'Nicely seasoned.',
        retained<.55?'Dry inside.':retained>.72?'Plenty of juice.':'Some juice left.',
        meats.some(p=>p.work>.8)?'Overworked and dense.':meats.some(p=>p.saltStructure>.2)?'Springy from salt mixed into the mince.':'A loose, tender texture.'];
      const layers=p.assembly||[];if(!layers.length)notes.push('Just the patty.');else if(!A.closed(p))notes.push('An open burger.');
      if(layers.some(l=>(l.wilt||0)>.4))notes.push('The fresh toppings have wilted.');
      if(report.bunSoak>.004)notes.push('The bottom bun is getting soggy.');
      this.lastTasting={time:this.time,notes,saltPercent:pct};return this.lastTasting;
    }
    detach(e){
      if(!e.food||e.kind==='pan')return;
      const s=this.owner(e),p=e.food;
      if(e.trayCarrier){const tray=this.get(e.trayCarrier);if(tray)tray.cargo=tray.cargo.filter(id=>id!==e.id);e.trayCarrier=null;}
      if(e.kind==='patty'){if(p.where==='pan')P.removePatty(s,p);if(p.where==='oven')P.takeFromOven(s,p);s.patties=s.patties.filter(q=>q!==p);if(s.patty===p)s.patty=null;}
      else {if(p.where==='pan')P.removeItem(s,p);s.items=s.items.filter(q=>q!==p);if(s.item===p)s.item=null;}
      if(e.panCarrier){const pan=this.get(e.panCarrier);pan.food=pan.food.filter(id=>id!==e.id);e.panCarrier=null;}
      p.where='rest';e.station=null;const list=e.kind==='patty'?this.loose.patties:this.loose.items;if(!list.includes(p))list.push(p);
    }
    placement(e,stationId,point){
      const st=this.station(stationId);if(!st||!e.food||e.kind==='pan')return {ok:false};
      const radius=(e.food.Dcov||e.food.D)/2;
      if(radius>st.state.pan.floorR)return {ok:false};
      return P.slideTo(st.state,e.food,radius,point||P.freeSpot(st.state,radius).pos);
    }
    crackEgg(e,stationId,point,preview=false){
      const st=this.station(stationId);
      if(e.kind!=='egg'||e.food||e.discarded)return 'Use a whole egg.';
      if(!st||stationId==='oven')return 'Crack eggs into a pan or over the grill.';
      if(st.state.lid||(!st.panId&&stationId!=='charcoal'))return 'Open a cooking surface first.';
      const food=P.makeItem('egg',{id:e.id}),candidate={kind:'egg',food};
      if(!this.placement(candidate,stationId,point).ok)return 'Make space before cracking the egg.';
      if(preview)return null;
      this.makeFood(e,'egg');return this.placeFood(e,stationId,point);
    }
    placeFood(e,stationId,point){
      if(e.stackRoot||e.food?.assembly?.length)return 'Keep assembled burgers on the pass.';
      const st=this.station(stationId);if(!st||(!st.panId&&!['charcoal','oven'].includes(st.id)))return 'Put a pan on this hob first.';
      if(st.state.lid)return 'Lift the lid first.';
      if(st.id==='oven'&&(!this.doors.oven||e.kind!=='patty'))return 'Open the oven; its rack takes patties.';
      if(!e.food)return 'Prepare this ingredient at the board first.';
      let ovenSlot;
      if(st.id==='oven'){
        if(this.entities.some(q=>q.kind==='tray'&&q.station==='oven'&&q.id!==e.trayCarrier))return 'Take the tray out before using the bare rack.';
        const occupied=this.entities.filter(q=>q!==e&&q.kind==='patty'&&q.station==='oven');
        ovenSlot=[0,1,2,3].find(n=>!occupied.some((q,i)=>(q.ovenSlot??i)===n));
        if(ovenSlot==null||e.food.D>.24)return 'Make space on the oven rack first.';
      }
      const spot=st.id==='oven'?{ok:true,pos:{x:0,y:0}}:this.placement(e,stationId,point);if(!spot.ok)return 'Make a little space on the cooking surface first.';
      this.detach(e);const p=e.food,s=st.state;
      this.loose.patties=this.loose.patties.filter(q=>q!==p);this.loose.items=this.loose.items.filter(q=>q!==p);
      p.pos=spot.pos;
      if(e.kind==='patty'){s.patties.push(p);P.placePatty(s,p,p.pos);if(st.id==='oven')P.putInOven(s,p);}
      else{s.items.push(p);p.where='pan';p.rings=P.footprintRings(s.pan,p.pos,p.D/2);p.stuck=true;}
      e.station=st.id;e.ovenSlot=ovenSlot;e.held=false;return null;
    }
    discard(e){
      const root=e.stackRoot?this.get(e.stackRoot):e;
      const all=this.entities.filter(q=>q===root||q.stackRoot===root.id);
      if(root.food?.assembly)A.unpack(root.food);
      for(const q of all){this.detach(q);q.discarded=true;this.loose.patties=this.loose.patties.filter(p=>p!==q.food);this.loose.items=this.loose.items.filter(p=>p!==q.food);}
    }
    liftPan(e){
      const st=this.station(e.station);if(!st)return;
      e.food=this.entities.filter(q=>q.station===st.id&&q!==e&&q.food).map(q=>q.id);
      e.pan=st.state.pan;e.parked=P.createState({stove:'gas'});e.parked.pan=e.pan;
      e.parked.lid=st.state.lid;st.state.lid=false;e.lidId=null;const lid=this.entities.find(q=>q.kind==='lid'&&q.station===st.id);if(lid){e.lidId=lid.id;lid.station=null;lid.panCarrier=e.id;}
      for(const id of e.food){const q=this.get(id);if(!q)continue;const p=q.food;(q.kind==='patty'?e.parked.patties:e.parked.items).push(p);q.station=null;q.panCarrier=e.id;}
      st.state.patties=[];st.state.items=[];st.state.patty=null;st.state.item=null;st.state.pan=P.createState({stove:st.id,pan:e.panType}).pan;st.panId=null;e.station=null;
    }
    dockPan(e,id){
      const st=this.station(id);if(!st||st.panId||['charcoal','oven'].includes(id))return 'That station cannot take this pan.';
      if(e.station)this.liftPan(e);st.panId=e.id;st.state.pan=e.pan;e.station=id;e.held=false;e.pos=[st.x,.93,st.z];
      if(e.parked){st.state.lid=e.parked.lid;st.state.patties=e.parked.patties;st.state.items=e.parked.items;for(const n of e.food){const q=this.get(n);if(q){q.station=id;q.panCarrier=null;}}if(e.lidId){const lid=this.get(e.lidId);lid.station=id;lid.panCarrier=null;}e.parked=null;}return null;
    }
    putOnTray(e,tray){
      if(!['tray','plate'].includes(tray.kind)||!e.food||e.kind==='pan'||e.stackRoot||tray.station||(e.food.assembly?.length&&tray.kind!=='plate'))return false;
      tray.cargo ||= [];if(tray.cargo.length>=(tray.kind==='plate'?1:4))return false;
      const radius=(e.food.Dcov||e.food.D)/2,positions=tray.kind==='plate'?[{x:0,y:0}]:[{x:-.06,y:-.075},{x:.06,y:-.075},{x:-.06,y:.075},{x:.06,y:.075},{x:0,y:0}];
      const pos=positions.find(p=>Math.abs(p.x)+radius<=(tray.kind==='plate'?.11:.125)&&Math.abs(p.y)+radius<=(tray.kind==='plate'?.11:.16)&&(tray.cargo||[]).every((id,i)=>{const q=this.get(id),at=q.carrierPos||positions[i];return Math.hypot(at.x-p.x,at.y-p.y)>=radius+(q.food.Dcov||q.food.D)/2+.004;}));
      if(!pos)return false;
      this.detach(e);tray.cargo.push(e.id);e.trayCarrier=tray.id;e.carrierPos={...pos};e.held=false;return true;
    }
    liftTray(tray){
      const cargo=(tray.cargo||[]).slice();for(const id of cargo){const e=this.get(id);this.detach(e);e.trayCarrier=tray.id;}tray.cargo=cargo;tray.station=null;
    }
    ovenTray(tray){
      if(!this.doors.oven)return 'Open the oven first.';
      if(tray.kind!=='tray')return 'Use the oven tray.';
      if((tray.cargo||[]).some(id=>this.get(id)?.kind!=='patty'||this.get(id).food.assembly?.length||this.get(id).food.D>.24))return 'Finish loose patties in the oven; keep burgers on the pass.';
      if(this.entities.some(e=>e!==tray&&e.station==='oven'&&e.trayCarrier!==tray.id))return 'Clear the oven rack before adding the tray.';
      const cargo=(tray.cargo||[]).slice();for(const id of cargo){const e=this.get(id);this.placeFood(e,'oven');e.trayCarrier=tray.id;}tray.cargo=cargo;tray.station='oven';tray.held=false;tray.pos=fixturePoint('oven',[0,.54,-.02]);return null;
    }
    assemble(held,target){
      const base=target.stackRoot?this.get(target.stackRoot):target;
      if(!base||held.discarded||target.discarded||held.stackRoot||held.station||held.panCarrier||base.station||base.panCarrier)return false;
      if(held.kind==='patty'&&target.kind==='bun'&&target.food.half==='bottom'&&!target.stackRoot){
        if(held.food.assembly?.length||target.station||target.panCarrier)return false;
        if(!A.add(this.loose,held.food,target.id))return false;A.add(this.loose,held.food,'patty');this.detach(held);this.detach(target);target.stackRoot=held.id;held.pos=target.pos.slice();held.held=false;return true;
      }
      if(base.kind!=='patty'||!base.food.assembly?.length||held===base||A.closed(base.food))return false;
      const cold={tomatoSlice:'tomato',pickleSlice:'pickles',lettuce:'lettuce',ketchup:'ketchup',mayo:'mayo',mustard:'mustard'}[held.kind];
      const key=cold||(held.kind==='patty'?'patty:'+held.id:held.id);
      if(!A.add(this.loose,base.food,key))return false;
      if(held.food)this.detach(held);
      if(cold&&held.coldState)Object.assign(base.food.assembly.at(-1),held.coldState);
      else if(cold&&held.massG)base.food.assembly.at(-1).mass=held.massG/1000;
      if(cold&&held.sliceMm)base.food.assembly.at(-1).height=held.sliceMm/1000;
      if(cold&&A.cold[cold].sauce){const sauce=this.entity(cold,cold,base.pos);sauce.stackRoot=base.id;sauce.layer=base.food.assembly.length-1;}
      else{held.stackRoot=base.id;held.layer=base.food.assembly.length-1;held.held=false;}return true;
    }
    step(dt){
      this.time+=dt;
      for(const st of this.stations){P.roomAir(st.state).windowOpen=this.doors.window;P.step(st.state,dt);}
      // The grill solver owns fallen egg debris; retire its empty inventory shell.
      for(const e of this.entities)if(e.kind==='egg'&&e.food?.where==='coals'){e.discarded=true;e.station=null;}
      P.step(this.loose,dt);
      for(const e of this.entities)if(e.kind==='pan'&&e.parked)P.step(e.parked,dt);
      for(const e of this.entities)if(e.kind==='tray')e.trayT=(e.trayT||21)+((e.station==='oven'?this.station('oven').state.oven.T:21)-(e.trayT||21))*(-Math.expm1(-dt/45));
      for(const e of this.entities)if(e.coldState&&!e.stackRoot){e.coldState.T+=(21-e.coldState.T)*(-Math.expm1(-dt/120));e.coldState.age=(e.coldState.age||0)+dt;}
      // Keep endless practice bounded in history, while retaining every live ingredient.
      for(const s of [...this.stations.map(s=>s.state),this.loose,...this.entities.filter(e=>e.parked).map(e=>e.parked)]){if(s.events.length>80)s.events.splice(0,s.events.length-80);if(s.trace.length>180)s.trace.splice(0,s.trace.length-180);}
    }
    snapshot(){return S.encode({version:1,layoutVersion:2,nextId:this.nextId,heldId:this.heldId,entities:this.entities.filter(e=>!e.discarded),time:this.time,bowl:this.bowl,portion:this.portion,player:this.player,doors:this.doors,stations:this.stations,loose:this.loose,settings:this.settings,lastTasting:this.lastTasting});}
    static restore(data){
      const d=S.decode(data);if(d.version!==1||!Array.isArray(d.stations)||d.stations.length!==5||!Array.isArray(d.entities)||d.entities.length>3000)throw Error('Invalid Real kitchen save');
      // Older kitchens kept empty inventory eggs after the grill took ownership.
      d.entities=d.entities.filter(e=>!(e.kind==='egg'&&e.station==='charcoal'&&e.food?.where==='coals'&&!d.stations.find(s=>s.id==='charcoal')?.state?.items?.includes(e.food)));
      if(!Number.isFinite(d.time)||!d.player||![d.player.x,d.player.y,d.player.z,d.player.yaw,d.player.pitch].every(Number.isFinite))throw Error('Invalid chef position or time');
      for(let i=0;i<5;i++)if(d.stations[i].id!==stationDefs[i][0]||!d.stations[i].state?.pan)throw Error('Invalid station');
      const states=[...d.stations.map(s=>s.state),d.loose,...d.entities.filter(e=>e.parked).map(e=>e.parked)];
      for(const s of states){if(!P.STOVES[s.stove?.id]||!(P.PANS[s.pan?.id]||s.stove.id==='charcoal'&&s.pan?.id==='grate')||!Array.isArray(s.patties)||!Array.isArray(s.items)||!(s.pan.Tr instanceof Float64Array)||s.pan.Tr.length!==s.pan.Np||![...s.pan.Tr].every(Number.isFinite))throw Error('Invalid cooking state');s.stove.profile=P.STOVES[s.stove.id].profile;}
      const ids=new Set();for(const e of d.entities){if(!Number.isInteger(e.id)||ids.has(e.id)||!Array.isArray(e.pos)||e.pos.length!==3||!e.pos.every(Number.isFinite))throw Error('Invalid inventory');ids.add(e.id);if(e.kind==='patty'&&(!(e.food?.T instanceof Float64Array)||!P.pattyFinite(e.food)))throw Error('Invalid meat');}
      const byId=new Map(d.entities.map(e=>[e.id,e]));
      if(!Number.isInteger(d.nextId)||d.nextId<=Math.max(0,...ids)||(d.heldId!=null&&!byId.has(d.heldId)))throw Error('Invalid inventory references');
      const foodEntities=d.entities.filter(e=>e.food&&e.kind!=='pan'),knownFood=new Set(foodEntities.map(e=>e.food));
      for(const e of d.entities){
        if(e.station&&!d.stations.some(s=>s.id===e.station))throw Error('Invalid station reference');
        if(e.payload!=null&&(!byId.has(e.payload)||e.payload===e.id))throw Error('Invalid tool payload');
        if(e.panCarrier!=null){const pan=byId.get(e.panCarrier);if(pan?.kind!=='pan'||!pan.parked||e.station||(e.kind!=='lid'&&!pan.food.includes(e.id)))throw Error('Invalid carried pan');}
        if(e.trayCarrier!=null){const tray=byId.get(e.trayCarrier);if(!['tray','plate'].includes(tray?.kind)||!tray.cargo?.includes(e.id))throw Error('Invalid tray reference');}
        if(e.cargo&&(!['tray','plate'].includes(e.kind)||!Array.isArray(e.cargo)||e.cargo.length>(e.kind==='plate'?1:4)||new Set(e.cargo).size!==e.cargo.length||e.cargo.some(id=>{const q=byId.get(id);return q?.trayCarrier!==e.id||!q.food||q.kind==='pan'||q===e;})))throw Error('Invalid tray contents');
        if(e.stackRoot!=null){const base=byId.get(e.stackRoot);if(base?.kind!=='patty'||base===e||!base.food.assembly?.some((l,i)=>l.item===e.food||l.meat===e.food||l.cold&&i===e.layer))throw Error('Invalid burger layer');}
        if(e.food&&e.kind!=='pan'){
          const owners=states.filter(s=>(e.kind==='patty'?s.patties:s.items).includes(e.food));
          const owner=e.panCarrier?byId.get(e.panCarrier).parked:e.station?d.stations.find(s=>s.id===e.station).state:d.loose;
          if(owners.length!==1||owners[0]!==owner)throw Error('Invalid food ownership');
          if(e.kind==='patty'&&e.food.assembly?.length){
            if(e.station||e.panCarrier||e.stackRoot||e.food.assembly.length>40)throw Error('Invalid burger');
            for(const [i,l] of e.food.assembly.entries()){
              if(!l||[!!l.patty,!!l.item,!!l.cold].filter(Boolean).length!==1)throw Error('Invalid burger layer');
              if(l.meat||l.item){const q=foodEntities.find(q=>q.food===(l.meat||l.item));if(!q||q.stackRoot!==e.id)throw Error('Invalid assembled reference');}
              if(l.cold&&(!A.cold[l.cold]||!d.entities.some(q=>q.stackRoot===e.id&&q.layer===i)))throw Error('Invalid topping reference');
            }
          }
          if(e.kind!=='patty')for(const item of [e.food,...(e.food.regions||[])])for(const key of ['face','up','body','wBot','wTop','yolk','lace','bot','top']){const n=item[key];if(n&&(!Number.isFinite(n.T)||!['m','w'].every(k=>Number.isFinite(n[k])&&n[k]>=0)))throw Error('Invalid ingredient');}
        }
      }
      for(const s of states)if([...s.patties,...s.items].some(p=>!knownFood.has(p))||new Set(s.patties).size!==s.patties.length||new Set(s.items).size!==s.items.length)throw Error('Invalid food references');
      for(const st of d.stations)if(st.panId!=null){const pan=byId.get(st.panId);if(pan?.kind!=='pan'||pan.station!==st.id||pan.pan!==st.state.pan)throw Error('Invalid cookware reference');}
      for(const q of [d.bowl,d.portion])if(!q||!['mass','salt','work'].every(k=>Number.isFinite(q[k])&&q[k]>=0)||(q.fatFrac!=null&&(!Number.isFinite(q.fatFrac)||q.fatFrac<0||q.fatFrac>1)))throw Error('Invalid mince');
      for(const e of d.entities)if(e.home&&e.kind!=='pan'){const atHome=e.pos.every((v,i)=>Math.abs(v-e.home[i])<.001);e.home[1]=.936;if(e.kind==='probe')e.home[0]=1.80;if(atHome)e.pos=e.home.slice();}
      const k=Object.create(Kitchen.prototype);Object.assign(k,d);k.settings={thicknessMm:P.clamp(d.settings?.thicknessMm||20,8,35),sliceMm:P.clamp(d.settings?.sliceMm||6,2,12)};
      if((d.layoutVersion||1)<2){
        for(const st of k.stations){const def=stationDefs.find(q=>q[0]===st.id);st.x=def[1];st.z=def[2];}
        for(const e of k.entities){
          if(e.kind==='pan'&&e.home){const atHome=e.pos.every((v,i)=>Math.abs(v-e.home[i])<.001);e.home=fixturePoint('rack',[0,e.home[1],0]);if(atHome)e.pos=e.home.slice();}
          if(e.kind==='tray'&&e.station==='oven')e.pos=fixturePoint('oven',[0,.54,-.02]);
          if(e.station||e.held||e.stackRoot||e.panCarrier||e.trayCarrier)continue;
          for(const name of ['oven','sink']){const f=fixtures[name],x=e.pos[0]-f.from[0],z=e.pos[2]-f.from[1];if(Math.abs(x)<(name==='oven'?.36:.65)&&Math.abs(z)<.44&&Math.abs(e.pos[1]-(name==='oven'?1.06:.93))<.08){e.pos=fixturePoint(name,[x,e.pos[1],z]);e.yaw=(e.yaw||0)+f.yaw;break;}}
        }
      }
      if(!k.entities.some(e=>e.kind==='plate')){const plate=k.entity('plate','tasting plate',[.50,.936,-.85]);plate.home=plate.pos.slice();}return k;
    }
  }
  const api={Kitchen,stationDefs,clearPlacement,fixtures,fixturePoint};if(typeof module==='object')module.exports=api;else root.RealKitchen=api;
})(typeof window!=='undefined'?window:globalThis);
