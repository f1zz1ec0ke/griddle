/* Real mode owns its stations, inventory and saves; Legacy keeps its original state. */
(function(root){
  'use strict';
  const P=typeof module==='object'?require('./physics'):root.BurgerPhysics;
  const S=typeof module==='object'?require('./session'):root.GriddleSession;
  const A=typeof module==='object'?require('./assembly'):root.BurgerAssembly;
  const stationDefs=[['gas',-1.5,.95,'castiron'],['electric',0,.95,'carbonsteel'],['induction',1.5,.95,'stainless'],['charcoal',2.5,-1.5,'castiron'],['oven',-2.4,-1.4,'castiron']];
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
      this.version=1;this.nextId=1;this.entities=[];this.time=0;this.bowl={mass:0,salt:0,work:0};this.portion={mass:0,salt:0,work:0};
      this.player={x:0,z:-2.3,y:0,yaw:Math.PI,pitch:-.2};this.doors={fridge:false,oven:false,window:false,tap:false};
      this.stations=stationDefs.map(([id,x,z,pan])=>({id,x,z,state:P.createState({stove:id==='oven'?'electric':id,pan}),panId:null}));
      this.loose=P.createState({stove:'gas'});
      P.setOven(this.station('oven').state,0);this.station('charcoal').state.grill.lit=false;
      for(const st of this.stations.filter(s=>!['charcoal','oven'].includes(s.id))){const e=this.entity('pan',st.id+' pan',[st.x,.93,st.z]);e.pan=st.state.pan;e.station=st.id;e.food=[];e.panType=st.state.pan.spec?.id||stationDefs.find(d=>d[0]===st.id)[3];st.panId=e.id;}
      const spare=this.entity('pan','non-stick pan',[-2.45,1.06,3.15]);spare.panType='nonstick';spare.parked=P.createState({stove:'gas',pan:'nonstick'});spare.pan=spare.parked.pan;spare.food=[];
      this.entities.filter(e=>e.kind==='pan').forEach((e,i)=>e.home=[-2.45,1.06+i*.20,3.15]);
      spare.pos=spare.home.slice();
      for(const [i,kind] of ['spatula','tongs','spoon','press','knife','salt','oil','water','glove','probe','cloth','lighter','coal','wood','ketchup','mayo','mustard','lid','tray'].entries()){
        const e=this.entity(kind,kind==='press'?'smash plate':kind,[kind==='probe'?1.80:[-1.62,-1.28,.96,1.30,1.64][i%5],.936,-1.23+Math.floor(i/5)*.25]);e.home=e.pos.slice();
      }
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
      if(!['tomato','pickles','onion','bunWhole','cheeseBlock'].includes(e.kind))return [];
      const kinds={tomato:'tomatoSlice',pickles:'pickleSlice',onion:'onions',bunWhole:'bun',cheeseBlock:'cheese'};
      const out=[],count=e.kind==='bunWhole'?2:e.kind==='onion'?1:4;
      for(let i=0;i<count;i++){const q=this.entity(kinds[e.kind],kinds[e.kind],[e.pos[0]+(i-(count-1)/2)*.065,e.pos[1],e.pos[2]]);if(q.kind==='bun'||q.kind==='onions'){this.makeFood(q,q.kind,{half:i?'top':'bottom'});if(q.kind==='bun')q.food.pair=e.id;}out.push(q);}
      e.discarded=true;return out;
    }
    scoop(dt,returning=false){
      const from=returning?this.portion:this.bowl,to=returning?this.bowl:this.portion;
      const take=Math.min(from.mass,dt*90,returning?Infinity:340-this.portion.mass);if(take<=0)return;
      const salt=from.salt*take/from.mass;to.work=(to.work*to.mass+from.work*take)/(to.mass+take);from.mass-=take;from.salt-=salt;to.mass+=take;to.salt+=salt;
    }
    form(pos){
      const q=this.portion;if(q.mass<25)return null;
      const e=this.entity('patty','patty',pos);e.food=P.makePatty({id:e.id,massG:q.mass,thicknessMm:20,fatFrac:.2,tempC:6,work:q.work,salt:q.salt>0?'mixed':'none'});
      e.food.where='rest';e.salt=q.salt;this.loose.patties.push(e.food);this.portion={mass:0,salt:0,work:0};return e;
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
    placeFood(e,stationId){
      if(e.stackRoot||e.food?.assembly?.length)return 'Keep assembled burgers on the pass.';
      const st=this.station(stationId);if(!st||(!st.panId&&!['charcoal','oven'].includes(st.id)))return 'Put a pan on this hob first.';
      if(st.state.lid)return 'Lift the lid first.';
      if(st.id==='oven'&&(!this.doors.oven||e.kind!=='patty'))return 'Open the oven; its rack takes patties.';
      if(!e.food)return 'Prepare this ingredient at the board first.';
      this.detach(e);const p=e.food,s=st.state;
      this.loose.patties=this.loose.patties.filter(q=>q!==p);this.loose.items=this.loose.items.filter(q=>q!==p);
      const spot=P.freeSpot(s,(p.Dcov||p.D)/2);p.pos=spot.pos;
      if(e.kind==='patty'){s.patties.push(p);P.placePatty(s,p,p.pos);if(st.id==='oven')P.putInOven(s,p);}
      else{s.items.push(p);p.where='pan';p.rings=P.footprintRings(s.pan,p.pos,p.D/2);p.stuck=true;}
      e.station=st.id;e.held=false;return null;
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
      if(!e.food||e.kind==='pan'||tray.station||e.food.assembly?.length)return false;
      tray.cargo ||= [];if(tray.cargo.length>=4)return false;
      this.detach(e);tray.cargo.push(e.id);e.trayCarrier=tray.id;e.held=false;return true;
    }
    liftTray(tray){
      const cargo=(tray.cargo||[]).slice();for(const id of cargo){const e=this.get(id);this.detach(e);e.trayCarrier=tray.id;}tray.cargo=cargo;tray.station=null;
    }
    ovenTray(tray){
      if(!this.doors.oven)return 'Open the oven first.';
      if((tray.cargo||[]).some(id=>this.get(id).kind!=='patty'))return 'Finish patties in the oven; cook toppings on the hobs.';
      const cargo=(tray.cargo||[]).slice();for(const id of cargo){const e=this.get(id);this.placeFood(e,'oven');e.trayCarrier=tray.id;}tray.cargo=cargo;tray.station='oven';tray.held=false;tray.pos=[-2.6,.54,-1.32];return null;
    }
    assemble(held,target){
      const base=target.stackRoot?this.get(target.stackRoot):target;
      if(held.kind==='patty'&&target.kind==='bun'&&target.food.half==='bottom'&&!target.stackRoot){
        this.detach(held);this.detach(target);if(!A.add(this.loose,held.food,target.id))return false;A.add(this.loose,held.food,'patty');target.stackRoot=held.id;held.pos=target.pos.slice();held.held=false;return true;
      }
      if(base.kind!=='patty'||!base.food.assembly?.length||held===base)return false;
      if(held.food)this.detach(held);
      const cold={tomatoSlice:'tomato',pickleSlice:'pickles',lettuce:'lettuce',ketchup:'ketchup',mayo:'mayo',mustard:'mustard'}[held.kind];
      const key=cold||(held.kind==='patty'?'patty:'+held.id:held.id);
      if(!A.add(this.loose,base.food,key))return false;
      if(cold&&A.cold[cold].sauce){const sauce=this.entity(cold,cold,base.pos);sauce.stackRoot=base.id;sauce.layer=base.food.assembly.length-1;}
      else{held.stackRoot=base.id;held.layer=base.food.assembly.length-1;held.held=false;}return true;
    }
    step(dt){
      this.time+=dt;
      for(const st of this.stations){P.roomAir(st.state).windowOpen=this.doors.window;P.step(st.state,dt);}
      P.step(this.loose,dt);
      for(const e of this.entities)if(e.kind==='pan'&&e.parked)P.step(e.parked,dt);
      for(const e of this.entities)if(e.kind==='tray')e.trayT=(e.trayT||21)+((e.station==='oven'?this.station('oven').state.oven.T:21)-(e.trayT||21))*(-Math.expm1(-dt/45));
      // Keep endless practice bounded in history, while retaining every live ingredient.
      for(const s of [...this.stations.map(s=>s.state),this.loose]){if(s.events.length>80)s.events.splice(0,s.events.length-80);if(s.trace.length>180)s.trace.splice(0,s.trace.length-180);}
    }
    snapshot(){return S.encode({version:1,nextId:this.nextId,heldId:this.heldId,entities:this.entities.filter(e=>!e.discarded),time:this.time,bowl:this.bowl,portion:this.portion,player:this.player,doors:this.doors,stations:this.stations,loose:this.loose});}
    static restore(data){
      const d=S.decode(data);if(d.version!==1||!Array.isArray(d.stations)||d.stations.length!==5||!Array.isArray(d.entities)||d.entities.length>3000)throw Error('Invalid Real kitchen save');
      if(!d.player||![d.player.x,d.player.z,d.player.yaw,d.player.pitch].every(Number.isFinite))throw Error('Invalid chef position');
      for(let i=0;i<5;i++)if(d.stations[i].id!==stationDefs[i][0]||!d.stations[i].state?.pan)throw Error('Invalid station');
      const states=[...d.stations.map(s=>s.state),d.loose,...d.entities.filter(e=>e.parked).map(e=>e.parked)];
      for(const s of states){if(!P.STOVES[s.stove?.id]||!Array.isArray(s.patties)||!Array.isArray(s.items)||!(s.pan.Tr instanceof Float64Array)||![...s.pan.Tr].every(Number.isFinite))throw Error('Invalid cooking state');s.stove.profile=P.STOVES[s.stove.id].profile;}
      const ids=new Set();for(const e of d.entities){if(!Number.isInteger(e.id)||ids.has(e.id)||!Array.isArray(e.pos)||e.pos.length!==3||!e.pos.every(Number.isFinite))throw Error('Invalid inventory');ids.add(e.id);if(e.kind==='patty'&&(!(e.food?.T instanceof Float64Array)||!P.pattyFinite(e.food)))throw Error('Invalid meat');}
      for(const q of [d.bowl,d.portion])if(!q||!['mass','salt','work'].every(k=>Number.isFinite(q[k])&&q[k]>=0))throw Error('Invalid mince');
      for(const e of d.entities)if(e.home&&e.kind!=='pan'){const atHome=e.pos.every((v,i)=>Math.abs(v-e.home[i])<.001);e.home[1]=.936;if(e.kind==='probe')e.home[0]=1.80;if(atHome)e.pos=e.home.slice();}
      const k=Object.create(Kitchen.prototype);Object.assign(k,d);return k;
    }
  }
  const api={Kitchen,stationDefs,clearPlacement};if(typeof module==='object')module.exports=api;else root.RealKitchen=api;
})(typeof window!=='undefined'?window:globalThis);
